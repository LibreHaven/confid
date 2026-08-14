// Package hub implements the in-memory room registry.
//
// Zero-retention invariant: all state is ephemeral. Rooms die with the
// process; nothing is persisted, nothing is logged beyond connection
// lifecycle events.
package hub

import (
	"crypto/rand"
	"errors"
	"sync"

	"github.com/LibreHaven/confid/signaling/internal/protocol"
)

// errNoOtherPeer is returned by Relay when the sender has no peer to relay to.
var errNoOtherPeer = errors.New("hub: no other peer in room")

// RoomCapacity is the maximum number of peers in a room (1v1 only).
const RoomCapacity = 2

// RoomIDLength is the number of characters in a generated room id.
const RoomIDLength = 6

// roomIDAlphabet excludes easily confused characters (0/O, 1/I/l).
const roomIDAlphabet = "23456789abcdefghjkmnpqrstuvwxyz"

// Peer is anything that can receive signaling messages.
type Peer interface {
	Send(msg protocol.Message) error
}

// Room holds up to RoomCapacity peers.
type Room struct {
	id    string
	mu    sync.Mutex
	peers [RoomCapacity]Peer
	count int
}

// ID returns the room identifier.
func (r *Room) ID() string { return r.id }

// Add joins a peer; returns false when the room is full.
func (r *Room) Add(p Peer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.count >= RoomCapacity {
		return false
	}
	r.peers[r.count] = p
	r.count++
	return true
}

// Remove drops a peer; returns the other peer (nil if none left).
func (r *Room) Remove(p Peer) Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < r.count; i++ {
		if r.peers[i] == p {
			r.peers[i] = r.peers[r.count-1]
			r.count--
			// The remaining peer (if any) sits in peers[:count]. Find the
			// first entry that is NOT the removed peer. (Can't use
			// otherLocked(i): after the swap, the surviving peer may have
			// been moved INTO slot i and would be excluded by it.)
			for j := 0; j < r.count; j++ {
				if r.peers[j] != p {
					return r.peers[j]
				}
			}
			return nil
		}
	}
	return nil
}

// Relay forwards a message from sender to the other peer.
func (r *Room) Relay(sender Peer, msg protocol.Message) error {
	r.mu.Lock()
	other := r.otherLocked(indexOf(r.peers[:r.count], sender))
	r.mu.Unlock()
	if other == nil {
		return errNoOtherPeer
	}
	return other.Send(msg)
}

func (r *Room) otherLocked(except int) Peer {
	for i := 0; i < r.count; i++ {
		if i != except {
			return r.peers[i]
		}
	}
	return nil
}

func indexOf(peers []Peer, target Peer) int {
	for i, p := range peers {
		if p == target {
			return i
		}
	}
	return -1
}

// Hub is the room registry.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

// New returns an empty Hub.
func New() *Hub {
	return &Hub{rooms: make(map[string]*Room)}
}

// Create registers a new room with a random id and joins the creator.
func (h *Hub) Create(creator Peer) *Room {
	for {
		id := randomID(RoomIDLength)
		h.mu.Lock()
		if _, exists := h.rooms[id]; !exists {
			r := &Room{id: id}
			r.Add(creator)
			h.rooms[id] = r
			h.mu.Unlock()
			return r
		}
		h.mu.Unlock()
	}
}

// Join looks up a room and adds the peer.
func (h *Hub) Join(roomID string, p Peer) (*Room, protocol.Message) {
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	h.mu.Unlock()
	if !ok {
		return nil, protocol.New(protocol.TypeError, "", protocol.ErrRoomNotFound, nil)
	}
	if !r.Add(p) {
		return nil, protocol.New(protocol.TypeError, "", protocol.ErrRoomFull, nil)
	}
	return r, protocol.Message{}
}

// Leave removes the peer from its room and deletes empty rooms.
// Returns the remaining peer (nil if the room is now empty).
func (h *Hub) Leave(p Peer) Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, r := range h.rooms {
		other := r.Remove(p)
		if other != nil || r.count == 0 {
			if r.count == 0 {
				delete(h.rooms, id)
			}
			return other
		}
	}
	return nil
}

// RoomCount returns the number of live rooms (used by tests and health checks).
func (h *Hub) RoomCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

func randomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	out := make([]byte, n)
	for i, v := range b {
		out[i] = roomIDAlphabet[int(v)%len(roomIDAlphabet)]
	}
	return string(out)
}
