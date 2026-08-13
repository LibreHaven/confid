// Package protocol defines the signaling message contract between
// Confid clients and the signaling server.
//
// Zero-retention invariant: the server forwards message *types* only —
// payloads (SDP/ICE) are relayed verbatim between peers and never logged.
package protocol

import "encoding/json"

// Message is the single wire format for client<->server signaling.
// Payload is opaque JSON relayed between the two peers of a room.
type Message struct {
	Type    string          `json:"type"`
	RoomID  string          `json:"roomId,omitempty"`
	Code    string          `json:"code,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Client -> server
const (
	TypeCreate = "create" // create a room, server replies "created"
	TypeJoin   = "join"   // join a room by id
	TypeSignal = "signal" // relay payload to the other peer
)

// Server -> client
const (
	TypeCreated  = "created"   // room created, carries roomId
	TypeJoined   = "joined"    // join accepted
	TypePeerLeft = "peer_left" // the other peer disconnected
	TypeError    = "error"     // carries error code
)
const (
	ErrRoomNotFound = "room_not_found" // join: no such room
	ErrRoomFull     = "room_full"      // join: room already has 2 peers
	ErrNotInRoom    = "not_in_room"    // signal: sender is not in a room
	ErrMalformed    = "malformed"      // message could not be decoded
)

// New builds a Message with an optional payload.
func New(msgType, roomID, code string, payload any) Message {
	m := Message{Type: msgType, RoomID: roomID, Code: code}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err == nil {
			m.Payload = raw
		}
	}
	return m
}
