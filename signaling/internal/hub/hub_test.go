package hub

import (
	"strings"
	"testing"
	"time"

	"github.com/LibreHaven/confid/signaling/internal/protocol"
)

// fakePeer records sent messages for assertions.
type fakePeer struct {
	sent []protocol.Message
}

func (f *fakePeer) Send(msg protocol.Message) error {
	f.sent = append(f.sent, msg)
	return nil
}

func TestCreateGeneratesValidRoomID(t *testing.T) {
	h := New()
	p := &fakePeer{}
	room := h.Create(p)
	if len(room.ID()) != RoomIDLength {
		t.Fatalf("room id length = %d, want %d", len(room.ID()), RoomIDLength)
	}
	for _, c := range room.ID() {
		if !strings.ContainsRune(roomIDAlphabet, c) {
			t.Fatalf("room id contains invalid char %q", c)
		}
	}
}

func TestJoinNotFound(t *testing.T) {
	h := New()
	_, errMsg := h.Join("zzzzzz", &fakePeer{})
	if errMsg.Type != protocol.TypeError || errMsg.Code != protocol.ErrRoomNotFound {
		t.Fatalf("expected room_not_found error, got %+v", errMsg)
	}
}

func TestRoomCapacityEnforced(t *testing.T) {
	h := New()
	a, b, c := &fakePeer{}, &fakePeer{}, &fakePeer{}
	room := h.Create(a)
	if !room.Add(b) {
		t.Fatal("second peer should be admitted")
	}
	if room.Add(c) {
		t.Fatal("third peer must be rejected")
	}
	// A third peer joining via hub also fails.
	if _, errMsg := h.Join(room.ID(), c); errMsg.Code != protocol.ErrRoomFull {
		t.Fatalf("expected room_full, got %+v", errMsg)
	}
}

func TestRelayDeliversToOtherPeerOnly(t *testing.T) {
	h := New()
	a, b := &fakePeer{}, &fakePeer{}
	room := h.Create(a)
	room.Add(b)
	msg := protocol.New(protocol.TypeSignal, "", "", map[string]string{"kind": "offer"})
	if err := room.Relay(a, msg); err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	if len(b.sent) != 1 {
		t.Fatalf("b received %d messages, want 1", len(b.sent))
	}
	if len(a.sent) != 0 {
		t.Fatal("sender must not receive its own relay")
	}
}

func TestRelayWithoutPeerFails(t *testing.T) {
	h := New()
	a := &fakePeer{}
	room := h.Create(a)
	if err := room.Relay(a, protocol.New(protocol.TypeSignal, "", "", nil)); err == nil {
		t.Fatal("expected error relaying with no other peer")
	}
}

func TestLeaveNotifiesAndReclaimsRoom(t *testing.T) {
	h := New()
	a, b := &fakePeer{}, &fakePeer{}
	room := h.Create(a)
	room.Add(b)
	if other := h.Leave(b); other != a {
		t.Fatalf("leave returned %+v, want peer a", other)
	}
	if h.RoomCount() != 1 {
		t.Fatalf("room count = %d, want 1", h.RoomCount())
	}
	if other := h.Leave(a); other != nil {
		t.Fatalf("leave returned %+v, want nil", other)
	}
	if h.RoomCount() != 0 {
		t.Fatalf("empty room must be reclaimed, count = %d", h.RoomCount())
	}
}

func TestRoomIDsUnique(t *testing.T) {
	h := New()
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := h.Create(&fakePeer{}).ID()
		if seen[id] {
			t.Fatalf("duplicate room id %q", id)
		}
		seen[id] = true
	}
}

func TestRoomIDCharactersUniform(t *testing.T) {
	// Rejection sampling must keep the alphabet distribution flat: with
	// 6200 draws each char should appear ~200 times; a biased mapping
	// would push the first chars to ~225. Allow generous slack for noise.
	const draws = 6200
	const expected = draws / len(roomIDAlphabet)
	counts := make(map[byte]int)
	for i := 0; i < draws; i++ {
		counts[randomAlphabetChar()]++
	}
	for _, c := range []byte(roomIDAlphabet) {
		if n := counts[c]; n < expected-40 || n > expected+40 {
			t.Fatalf("char %q drawn %d times, want ~%d", c, n, expected)
		}
	}
}

func TestInviteExpiresAfterTTL(t *testing.T) {
	h := New()
	a := &fakePeer{}
	room := h.Create(a)

	// Simulate a lapsed invite: join must be rejected and room reclaimed.
	room.expiresAt = time.Now().Add(-time.Second)
	if _, errMsg := h.Join(room.ID(), &fakePeer{}); errMsg.Code != protocol.ErrRoomNotFound {
		t.Fatalf("expired invite must yield room_not_found, got %+v", errMsg)
	}
	if h.RoomCount() != 0 {
		t.Fatalf("expired room not reclaimed, count = %d", h.RoomCount())
	}
}

func TestActiveSessionNeverExpires(t *testing.T) {
	h := New()
	a, b := &fakePeer{}, &fakePeer{}
	room := h.Create(a)

	// Second peer joins: the session starts and the invite stops expiring
	// (Add clears expiresAt; even a far-future check must not expire).
	room.Add(b)
	if room.Expired(time.Now().Add(time.Hour)) {
		t.Fatal("started session must not expire")
	}
	if other := h.Leave(b); other != a {
		t.Fatalf("leave returned %+v, want peer a", other)
	}
}

func TestCleanerReclaimsOnlyExpiredRooms(t *testing.T) {
	h := New()
	h.Create(&fakePeer{})
	// Backdate a second room's invite.
	r2 := h.Create(&fakePeer{})
	r2.expiresAt = time.Now().Add(-time.Second)

	h.cleanExpired(time.Now())

	if h.RoomCount() != 1 {
		t.Fatalf("cleaner removed %d rooms, want 1 (only the expired one)", 2-h.RoomCount())
	}
}
