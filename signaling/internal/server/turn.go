package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// turnCredentials mints short-lived Metered TURN credentials for the
// frontend (relay candidates for CGNAT/symmetric-NAT peers). The Metered
// API key is held server-side — it can create/remove credentials, so it
// must never reach the browser. Credentials are cached briefly so a burst
// of sessions hits the upstream API once. The endpoint is rate-limited
// per IP: it is public by design (the browser must fetch credentials
// without auth), so an unthrottled endpoint would let anyone burn the
// Metered quota (free tier = service outage via quota exhaustion).
type turnCredentials struct {
	apiKey  string
	apiBase string // e.g. https://confid.metered.live

	mu      sync.Mutex
	cached  []byte
	expires time.Time

	// Per-IP sliding window of recent mint requests.
	requests map[string][]time.Time
}

// turnCredentialCacheTTL bounds upstream calls while staying well under
// the credential lifetime.
const turnCredentialCacheTTL = time.Minute

// turnRateLimit is the max credential fetches per IP per window. Session
// setup fetches once, so this is far above legitimate use.
const turnRateLimit = 10

// turnRateWindow is the sliding window for the rate limit.
const turnRateWindow = time.Minute

// newTurnCredentials validates the configuration and returns nil when the
// operator did not enable TURN.
func newTurnCredentials(apiKey, apiBase string) *turnCredentials {
	if apiKey == "" || apiBase == "" {
		return nil
	}
	return &turnCredentials{
		apiKey:   apiKey,
		apiBase:  strings.TrimSuffix(apiBase, "/"),
		requests: make(map[string][]time.Time),
	}
}

// rateLimited reports whether the client IP is over the per-window limit.
func (t *turnCredentials) rateLimited(ip string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	window := now.Add(-turnRateWindow)
	recent := t.requests[ip][:0]
	for _, ts := range t.requests[ip] {
		if ts.After(window) {
			recent = append(recent, ts)
		}
	}
	if len(recent) >= turnRateLimit {
		t.requests[ip] = recent
		return true
	}
	t.requests[ip] = append(recent, now)
	return false
}

// serveTurnCredentials handles GET /turn-credentials.
// 503 when TURN is not configured or the upstream call fails (the
// frontend degrades to STUN-only); 429 when the client IP exceeds the
// per-window rate limit (quota-abuse guard).
func (s *Server) serveTurnCredentials(w http.ResponseWriter, r *http.Request) {
	if s.turn == nil {
		http.Error(w, `{"error":"turn not configured"}`, http.StatusServiceUnavailable)
		return
	}
	if s.turn.rateLimited(clientIP(r.RemoteAddr), time.Now()) {
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
		return
	}
	body, err := s.turn.get(r.Context())
	if err != nil {
		log.Printf("turn: credential fetch failed: %v", err)
		http.Error(w, `{"error":"turn unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// get returns cached credentials, minting fresh ones when stale.
func (t *turnCredentials) get(ctx context.Context) ([]byte, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cached != nil && time.Now().Before(t.expires) {
		return t.cached, nil
	}
	body, err := t.mint(ctx)
	if err != nil {
		return nil, err
	}
	t.cached = body
	t.expires = time.Now().Add(turnCredentialCacheTTL)
	return body, nil
}

// mint calls the Metered REST API (documented at metered.ca/stun-turn:
// GET <apiBase>/api/v1/turn/credentials?apiKey=<key>).
func (t *turnCredentials) mint(ctx context.Context) ([]byte, error) {
	url := t.apiBase + "/api/v1/turn/credentials?apiKey=" + t.apiKey
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("metered api %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}
	// The API returns the iceServers array itself; wrap it in the same
	// envelope the frontend already expects.
	var servers []json.RawMessage
	if err := json.Unmarshal(raw, &servers); err != nil {
		return nil, fmt.Errorf("metered api: unexpected payload: %v", err)
	}
	out, err := json.Marshal(map[string]any{"iceServers": servers})
	if err != nil {
		return nil, err
	}
	return out, nil
}
