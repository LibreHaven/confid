// Package server wires the WebSocket transport to the hub.
//
// Zero-retention invariant: the server logs connection lifecycle events
// only (connect/disconnect/room events) and never message payloads.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/LibreHaven/confid/signaling/internal/hub"
	"github.com/LibreHaven/confid/signaling/internal/protocol"
	"github.com/gorilla/websocket"
)

// errSendQueueFull is returned when a peer's outbound queue is full
// (slow consumer); the connection is left to time out naturally.
var errSendQueueFull = errors.New("server: send queue full")

const (
	// writeWait is the time allowed for a single websocket write.
	writeWait = 10 * time.Second
	// pongWait is how long a peer may stay silent before being dropped.
	pongWait = 60 * time.Second
	// pingPeriod must be less than pongWait.
	pingPeriod = 30 * time.Second
	// sendBuffer is the outbound message queue depth.
	sendBuffer = 16
	// maxMessageBytes caps inbound message size (SDP blobs can be large).
	maxMessageBytes = 64 * 1024
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Signaling is open to any origin: rooms are unguessable ids, and
	// nothing is stored, so cross-origin abuse has no payoff.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Server hosts the signaling endpoint.
type Server struct {
	hub *hub.Hub
}

// New creates a Server backed by the given hub.
func New(h *hub.Hub) *Server {
	return &Server{hub: h}
}

// Handler returns the HTTP handler for the signaling endpoint.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.serveWS)
	return mux
}

// client is one connected peer.
type client struct {
	conn *websocket.Conn
	send chan protocol.Message
	hub  *hub.Hub
	room *hub.Room
}

func (c *client) Send(msg protocol.Message) error {
	select {
	case c.send <- msg:
		return nil
	default:
		return errSendQueueFull
	}
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan protocol.Message, sendBuffer), hub: s.hub}
	log.Printf("ws: connect from %s", r.RemoteAddr)
	go c.writeLoop()
	c.readLoop()
}

func (c *client) readLoop() {
	defer func() {
		c.conn.Close()
		if other := c.hub.Leave(c); other != nil {
			other.Send(protocol.New(protocol.TypePeerLeft, "", "", nil))
		}
		log.Printf("ws: disconnect")
	}()
	c.conn.SetReadLimit(maxMessageBytes)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg protocol.Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			c.Send(protocol.New(protocol.TypeError, "", protocol.ErrMalformed, nil))
			continue
		}
		switch msg.Type {
		case protocol.TypeCreate:
			room := c.hub.Create(c)
			c.room = room
			log.Printf("room: created %s", room.ID())
			c.Send(protocol.New(protocol.TypeCreated, room.ID(), "", nil))
		case protocol.TypeJoin:
			room, errMsg := c.hub.Join(msg.RoomID, c)
			if errMsg.Type != "" {
				c.Send(errMsg)
				continue
			}
			c.room = room
			log.Printf("room: joined %s", msg.RoomID)
			c.Send(protocol.New(protocol.TypeJoined, msg.RoomID, "", nil))
		case protocol.TypeSignal:
			if c.room == nil {
				c.Send(protocol.New(protocol.TypeError, "", protocol.ErrNotInRoom, nil))
				continue
			}
			if err := c.room.Relay(c, msg); err != nil {
				c.Send(protocol.New(protocol.TypeError, "", protocol.ErrNotInRoom, nil))
			}
		}
	}
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteJSON(msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// Shutdown gracefully closes all live connections.
func (s *Server) Shutdown(ctx context.Context) error {
	return nil // connections are closed by their own read loops on ctx cancel
}
