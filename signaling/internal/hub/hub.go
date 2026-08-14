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
	"time"

	"github.com/LibreHaven/confid/signaling/internal/protocol"
)

// errNoOtherPeer is returned by Relay when the sender has no peer to relay to.
var errNoOtherPeer = errors.New("hub: no other peer in room")

// RoomCapacity is the maximum number of peers in a room (1v1 only).
const RoomCapacity = 2

// RoomIDLength is the number of characters in a generated room id.
const RoomIDLength = 6

// InviteTTL is how long a created room stays joinable before the invite
// expires (mirrors the UI copy "会话码 30 分钟内有效"). Once a second peer
// joins, the expiry is cleared: an active session must not be torn down
// by the cleaner while both peers are connected.
const InviteTTL = 30 * time.Minute

// roomIDAlphabet excludes easily confused characters (0/O, 1/I/l).
const roomIDAlphabet = "23456789abcdefghjkmnpqrstuvwxyz"

// maxAlphabetIndex is the largest multiple of len(roomIDAlphabet) below 256;
// bytes >= this are rejected to keep the alphabet distribution uniform.
const maxAlphabetIndex = 256 - (256 % len(roomIDAlphabet)) // 248

// Peer is anything that can receive signaling messages.
type Peer interface {
	Send(msg protocol.Message) error
}

// Room holds up to RoomCapacity peers.
type Room struct {
	id        string
	mu        sync.Mutex
	peers     [RoomCapacity]Peer
	count     int
	expiresAt time.Time // zero means no expiry (session started)
}

// ID returns the room identifier.
func (r *Room) ID() string { return r.id }

// Add joins a peer; returns false when the room is full.
// When the second peer arrives, the invite stops expiring.
func (r *Room) Add(p Peer) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.count >= RoomCapacity {
		return false
	}
	r.peers[r.count] = p
	r.count++
	if r.count == RoomCapacity {
		r.expiresAt = time.Time{} // session started: no expiry
	}
	return true
}

// Remove drops a peer; returns the other peer (nil if none left).
func (r *Room) Remove(p Peer) Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < r.count; i++ {
		if r.peers[i] == p {
			r.peers[i] = r.peers[r.count-1]
			r.peers[r.count-1] = nil // drop the reference for GC
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

// Expired reports whether the invite has lapsed and nobody has joined yet.
func (r *Room) Expired(now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.expiresAt.IsZero() && now.After(r.expiresAt)
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
			r := &Room{id: id, expiresAt: time.Now().Add(InviteTTL)}
			r.Add(creator)
			h.rooms[id] = r
			h.mu.Unlock()
			return r
		}
		h.mu.Unlock()
	}
}

// Join looks up a room and adds the peer. Expired rooms are treated as
// missing (and reclaimed) so a stale invite cannot be used.
func (h *Hub) Join(roomID string, p Peer) (*Room, protocol.Message) {
	now := time.Now()
	h.mu.Lock()
	r, ok := h.rooms[roomID]
	if ok && r.Expired(now) {
		delete(h.rooms, roomID)
		ok = false
	}
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

// StartCleaner runs a background loop that reclaims rooms whose invite
// expired before anyone joined. cancel stops the loop.
func (h *Hub) StartCleaner(interval time.Duration, cancel <-chan struct{}) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-cancel:
				return
			case <-t.C:
				h.cleanExpired(time.Now())
			}
		}
	}()
}

// cleanExpired deletes rooms with an lapsed invite that never started.
func (h *Hub) cleanExpired(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, r := range h.rooms {
		if r.Expired(now) {
			delete(h.rooms, id)
		}
	}
}

func randomID(n int) string {
	out := make([]byte, n)
	for i := range out {
		out[i] = randomAlphabetChar()
	}
	return string(out)
}

// randomAlphabetChar draws one uniform alphabet byte via rejection sampling:
// crypto/rand bytes are uniform in [0,256), and mapping 256 values onto a
// 31-char alphabet with % would bias the first characters. Bytes >= the
// largest multiple of 31 (248) are rejected and redrawn (~3% retries).
func randomAlphabetChar() byte {
	var buf [1]byte
	for {
		if _, err := rand.Read(buf[:]); err != nil {
			panic(err) // crypto/rand failure is unrecoverable
		}
		if int(buf[0]) < maxAlphabetIndex {
			return roomIDAlphabet[int(buf[0])%len(roomIDAlphabet)]
		}
	}
}
