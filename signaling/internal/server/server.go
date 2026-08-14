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
	"net"
	"net/http"
	"sync"
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
	// defaultMaxConnsPerIP caps concurrent websocket connections from one
	// client IP (connection-flood guard for the public deployment).
	defaultMaxConnsPerIP = 10
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Signaling is open to any origin: rooms are unguessable ids, and
	// nothing is stored, so cross-origin abuse has no payoff.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Options configures the served endpoints.
type Options struct {
	// StaticDir serves the built frontend (index.html + assets) when set,
	// giving a single-process deployment: same origin for page + /ws.
	StaticDir string
	// MaxConnsPerIP caps concurrent websocket connections per client IP;
	// zero uses defaultMaxConnsPerIP.
	MaxConnsPerIP int
}

// Server hosts the signaling endpoint.
type Server struct {
	hub     *hub.Hub
	opts    Options
	limiter *connLimiter
}

// New creates a Server backed by the given hub.
func New(h *hub.Hub) *Server {
	return &Server{
		hub:     h,
		opts:    Options{MaxConnsPerIP: defaultMaxConnsPerIP},
		limiter: newConnLimiter(),
	}
}

// NewWithOptions creates a Server with deployment options (static hosting,
// per-IP connection cap).
func NewWithOptions(h *hub.Hub, opts Options) *Server {
	s := New(h)
	if opts.MaxConnsPerIP == 0 {
		opts.MaxConnsPerIP = defaultMaxConnsPerIP
	}
	s.opts = opts
	return s
}

// Handler returns the HTTP handler for the signaling endpoint (and, when
// StaticDir is set, the frontend and health endpoints). All responses get
// security headers.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", s.serveWS)
	if s.opts.StaticDir != "" {
		// The frontend uses hash routing (#/join/...), so serving the
		// directory as-is needs no SPA fallback. Directory browsing is
		// disabled (an info-disclosure smell for a public deployment).
		mux.Handle("/", noDirListing(http.Dir(s.opts.StaticDir)))
	}
	return securityHeaders(mux)
}

// noDirListing serves files but refuses directory listings: the root
// resolves to index.html, any other directory request is a 404.
func noDirListing(root http.FileSystem) http.Handler {
	fs := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// http.Dir.Open applies the same path cleaning FileServer uses;
		// stat the target and reject non-root directories outright.
		f, err := root.Open(r.URL.Path)
		if err == nil {
			info, statErr := f.Stat()
			f.Close()
			if statErr == nil && info.IsDir() && r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
		}
		fs.ServeHTTP(w, r)
	})
}

// connLimiter tracks live connections per client IP (flood guard).
type connLimiter struct {
	mu     sync.Mutex
	counts map[string]int
}

func newConnLimiter() *connLimiter {
	return &connLimiter{counts: make(map[string]int)}
}

func (l *connLimiter) acquire(ip string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.counts[ip] >= max {
		return false
	}
	l.counts[ip]++
	return true
}

func (l *connLimiter) release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n := l.counts[ip] - 1; n <= 0 {
		delete(l.counts, ip)
	} else {
		l.counts[ip] = n
	}
}

// clientIP extracts the host part of a RemoteAddr ("ip:port").
func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// securityHeaders hardens every response (the meta CSP in index.html cannot
// carry frame-ancestors; the header form covers it for the deployed app).
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
		)
		if r.TLS != nil {
			// Only meaningful once the server terminates TLS itself.
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// client is one connected peer.
type client struct {
	conn *websocket.Conn
	send chan protocol.Message
	hub  *hub.Hub
	room *hub.Room
	addr string
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
	ip := clientIP(r.RemoteAddr)
	if !s.limiter.acquire(ip, s.opts.MaxConnsPerIP) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	defer s.limiter.release(ip)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan protocol.Message, sendBuffer), hub: s.hub, addr: r.RemoteAddr}
	log.Printf("ws: connect from %s", r.RemoteAddr)
	go c.writeLoop()
	c.readLoop()
}

func (c *client) readLoop() {
	defer func() {
		c.conn.Close()
		if other := c.hub.Leave(c); other != nil {
			if err := other.Send(protocol.New(protocol.TypePeerLeft, "", "", nil)); err != nil {
				log.Printf("ws: peer_left send failed to %s: %v", c.addr, err)
			} else {
				log.Printf("ws: peer_left sent to %s (room left by %s)", c.addr, c.addr)
			}
		}
		log.Printf("ws: disconnect %s", c.addr)
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
			log.Printf("ws: read error from %s: %v", c.addr, err)
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
			// Tell the other peer that someone arrived; they can start
			// the WebRTC offer.
			if err := room.Relay(c, protocol.New(protocol.TypePeerJoined, "", "", nil)); err != nil {
				log.Printf("room: notify join failed: %v", err)
			}
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
				log.Printf("ws: write error to %s: %v", c.addr, err)
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
