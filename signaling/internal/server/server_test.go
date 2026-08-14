package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/LibreHaven/confid/signaling/internal/hub"
	"github.com/LibreHaven/confid/signaling/internal/protocol"
	"github.com/gorilla/websocket"
)

// recv decodes the next websocket message as protocol.Message.
func recv(t *testing.T, ws *websocket.Conn) protocol.Message {
	t.Helper()
	_, raw, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m protocol.Message
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return m
}

// TestPeerLeftOnDisconnect: creator and joiner connect; when the joiner
// disconnects, the creator must receive peer_left.
func TestPeerLeftOnDisconnect(t *testing.T) {
	srv := httptest.NewServer(New(hub.New()).Handler())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	creator, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("creator dial: %v", err)
	}
	defer creator.Close()
	if err := creator.WriteJSON(protocol.New(protocol.TypeCreate, "", "", nil)); err != nil {
		t.Fatalf("create: %v", err)
	}
	created := recv(t, creator)
	if created.Type != protocol.TypeCreated {
		t.Fatalf("want created, got %+v", created)
	}

	joiner, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("joiner dial: %v", err)
	}
	if err := joiner.WriteJSON(protocol.New(protocol.TypeJoin, created.RoomID, "", nil)); err != nil {
		t.Fatalf("join: %v", err)
	}
	joined := recv(t, joiner)
	if joined.Type != protocol.TypeJoined {
		t.Fatalf("want joined, got %+v", joined)
	}
	notified := recv(t, creator)
	if notified.Type != protocol.TypePeerJoined {
		t.Fatalf("want peer_joined, got %+v", notified)
	}

	// Joiner disconnects (abruptly, like a browser tab dying).
	joiner.Close()

	got := recv(t, creator)
	if got.Type != protocol.TypePeerLeft {
		t.Fatalf("want peer_left, got %+v", got)
	}
}

// TestPeerLeftWhenCreatorDisconnects: the CREATOR (slot 0) leaving must
// still notify the joiner. Regression for the Remove() slot-swap bug where
// the surviving peer moved into the removed peer's slot and was excluded.
func TestPeerLeftWhenCreatorDisconnects(t *testing.T) {
	srv := httptest.NewServer(New(hub.New()).Handler())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	creator, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("creator dial: %v", err)
	}
	creator.WriteJSON(protocol.New(protocol.TypeCreate, "", "", nil))
	created := recv(t, creator)

	joiner, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("joiner dial: %v", err)
	}
	defer joiner.Close()
	joiner.WriteJSON(protocol.New(protocol.TypeJoin, created.RoomID, "", nil))
	recv(t, joiner) // joined
	recv(t, creator) // peer_joined

	// Creator (slot 0) disconnects; the joiner must be notified.
	creator.Close()

	got := recv(t, joiner)
	if got.Type != protocol.TypePeerLeft {
		t.Fatalf("want peer_left for joiner, got %+v", got)
	}
}

// TestPeerLeftAfterSessionReuse covers repeated session usage:
// session 1 ends, then a fresh create/join pair must still notify correctly.
func TestPeerLeftAfterSessionReuse(t *testing.T) {
	srv := httptest.NewServer(New(hub.New()).Handler())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	// Session 1: creator + joiner, both leave.
	c1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c1 dial: %v", err)
	}
	c1.WriteJSON(protocol.New(protocol.TypeCreate, "", "", nil))
	created1 := recv(t, c1)

	c2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c2 dial: %v", err)
	}
	c2.WriteJSON(protocol.New(protocol.TypeJoin, created1.RoomID, "", nil))
	recv(t, c2) // joined
	recv(t, c1) // peer_joined
	c2.Close()
	recv(t, c1) // peer_left
	c1.Close()
	// Room must be reclaimed after both leave.
	time.Sleep(100 * time.Millisecond)

	// Session 2: fresh creator + joiner.
	c3, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c3 dial: %v", err)
	}
	defer c3.Close()
	c3.WriteJSON(protocol.New(protocol.TypeCreate, "", "", nil))
	created2 := recv(t, c3)
	if created2.RoomID == created1.RoomID {
		t.Fatal("room id reused")
	}

	c4, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c4 dial: %v", err)
	}
	defer c4.Close()
	c4.WriteJSON(protocol.New(protocol.TypeJoin, created2.RoomID, "", nil))
	recv(t, c4) // joined
	recv(t, c3) // peer_joined

	c4.Close()
	got := recv(t, c3)
	if got.Type != protocol.TypePeerLeft {
		t.Fatalf("session 2: want peer_left, got %+v", got)
	}
}

// TestStaticHostingServesFrontend: with StaticDir set, the same process
// serves the built frontend alongside /ws and /healthz.
func TestStaticHostingServesFrontend(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>confid</html>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	srv := httptest.NewServer(NewWithOptions(hub.New(), Options{StaticDir: dir}).Handler())
	defer srv.Close()

	index := getBody(t, srv.URL+"/")
	if index != "<html>confid</html>" {
		t.Fatalf("index body = %q", index)
	}
	if got := getBody(t, srv.URL+"/app.js"); got != "console.log(1)" {
		t.Fatalf("asset body = %q", got)
	}
	if got := getBody(t, srv.URL+"/healthz"); got != "ok" {
		t.Fatalf("healthz body = %q", got)
	}

	// The websocket endpoint must still upgrade alongside static hosting.
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial with static hosting: %v", err)
	}
	ws.Close()
}

// TestSecurityHeadersOnAllResponses: every response carries the hardening
// headers (frame-ancestors cannot travel via the index.html meta CSP).
func TestSecurityHeadersOnAllResponses(t *testing.T) {
	srv := httptest.NewServer(New(hub.New()).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	for _, header := range []string{"X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Content-Security-Policy"} {
		if got := resp.Header.Get(header); got == "" {
			t.Fatalf("missing security header %q", header)
		}
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("CSP missing frame-ancestors: %q", csp)
	}
}

// TestConnLimitPerIP: the flood guard rejects connections beyond the per-IP
// cap with 429, and admits new ones once an old connection closes.
func TestConnLimitPerIP(t *testing.T) {
	srv := httptest.NewServer(NewWithOptions(hub.New(), Options{MaxConnsPerIP: 2}).Handler())
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	c1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c1 dial: %v", err)
	}
	defer c1.Close()
	c2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c2 dial: %v", err)
	}
	defer c2.Close()

	// Third concurrent connection from the same IP must be rejected.
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("third connection must be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("rejection status = %v, want 429", resp)
	}

	// Closing one connection frees the slot.
	c2.Close()
	time.Sleep(50 * time.Millisecond) // let the read loop release the slot
	c3, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("c3 dial after release: %v", err)
	}
	c3.Close()
}

// getBody fetches a URL and returns the response body.
func getBody(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s: %v", url, err)
	}
	return string(body)
}
