package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/LibreHaven/confid/signaling/internal/hub"
)

// meteredResponse mirrors the Metered REST API payload
// (GET <base>/api/v1/turn/credentials?apiKey=...): a bare iceServers array.
const meteredResponse = `[
  {
    "urls": [
      "stun:stun.relay.metered.ca:80"
    ]
  },
  {
    "urls": [
      "turn:global.relay.metered.ca:80?transport=tcp",
      "turns:global.relay.metered.ca:443?transport=tcp"
    ],
    "username": "user-abc",
    "credential": "cred-xyz"
  }
]`

// hostRewriter redirects requests for the Metered API host to the mock
// upstream (the real host is a live account endpoint — never hit it).
type hostRewriter struct {
	target string
	inner  http.RoundTripper
}

func (h *hostRewriter) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host != "confid.metered.live" {
		return h.inner.RoundTrip(req)
	}
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = h.target
	return h.inner.RoundTrip(clone)
}

func newTurnServer(t *testing.T, upstream http.Handler) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	if upstream == nil {
		upstream = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			if r.URL.Path != "/api/v1/turn/credentials" {
				t.Errorf("upstream path = %s", r.URL.Path)
			}
			if r.URL.Query().Get("apiKey") != "test-key" {
				t.Errorf("apiKey query = %q", r.URL.Query().Get("apiKey"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(meteredResponse))
		})
	}
	up := httptest.NewServer(upstream)

	old := http.DefaultTransport
	http.DefaultTransport = &hostRewriter{target: up.Listener.Addr().String(), inner: old}
	t.Cleanup(func() {
		http.DefaultTransport = old
		up.Close()
	})

	srv := httptest.NewServer(NewWithOptions(hub.New(), Options{
		TurnAPIKey:  "test-key",
		TurnAPIBase: "https://confid.metered.live",
	}).Handler())
	t.Cleanup(srv.Close)
	return srv, calls
}

func TestTurnCredentialsDisabledWithoutConfig(t *testing.T) {
	srv := httptest.NewServer(NewWithOptions(hub.New(), Options{}).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/turn-credentials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
}

func TestTurnCredentialsMintFromMeteredAndCache(t *testing.T) {
	srv, calls := newTurnServer(t, nil)

	resp, err := http.Get(srv.URL + "/turn-credentials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var payload struct {
		IceServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.IceServers) != 2 {
		t.Fatalf("iceServers len = %d, want 2", len(payload.IceServers))
	}
	if payload.IceServers[1].Username != "user-abc" || payload.IceServers[1].Credential != "cred-xyz" {
		t.Fatalf("credentials not passed through: %+v", payload.IceServers[1])
	}

	// Second call within the TTL must hit the cache, not upstream.
	if _, err := http.Get(srv.URL + "/turn-credentials"); err != nil {
		t.Fatalf("second get: %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1 (cached)", got)
	}
}

func TestTurnCredentialsRateLimited(t *testing.T) {
	srv, calls := newTurnServer(t, nil)

	// 10 fetches are allowed (rate limit), the 11th within the window is 429.
	for i := 0; i < turnRateLimit; i++ {
		resp, err := http.Get(srv.URL + "/turn-credentials")
		if err != nil {
			t.Fatalf("get %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("get %d: status = %d, want 200", i, resp.StatusCode)
		}
	}
	resp, err := http.Get(srv.URL + "/turn-credentials")
	if err != nil {
		t.Fatalf("get 11: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("get 11: status = %d, want 429", resp.StatusCode)
	}
	// Upstream saw only the first mint (cached thereafter).
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

func TestTurnCredentialsUpstreamFailure(t *testing.T) {
	srv, _ := newTurnServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))

	resp, err := http.Get(srv.URL + "/turn-credentials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 on upstream failure", resp.StatusCode)
	}
}

func TestTurnCredentialsMalformedUpstreamPayload(t *testing.T) {
	srv, _ := newTurnServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`not json at all`))
	}))

	resp, err := http.Get(srv.URL + "/turn-credentials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 on malformed payload", resp.StatusCode)
	}
}
