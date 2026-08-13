package protocol

import (
	"encoding/json"
	"testing"
)

func TestMessageRoundTrip(t *testing.T) {
	payload := map[string]string{"kind": "offer", "sdp": "v=0"}
	raw, err := json.Marshal(New(TypeSignal, "abc123", "", payload))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Message
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != TypeSignal {
		t.Fatalf("type = %q, want %q", got.Type, TypeSignal)
	}
	var gotPayload map[string]string
	if err := json.Unmarshal(got.Payload, &gotPayload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if gotPayload["kind"] != "offer" || gotPayload["sdp"] != "v=0" {
		t.Fatalf("payload = %+v", gotPayload)
	}
}

func TestErrorMessageFields(t *testing.T) {
	m := New(TypeError, "", ErrRoomNotFound, nil)
	if m.Code != ErrRoomNotFound {
		t.Fatalf("code = %q", m.Code)
	}
	raw, _ := json.Marshal(m)
	var decoded Message
	_ = json.Unmarshal(raw, &decoded)
	if decoded.Code != ErrRoomNotFound {
		t.Fatalf("decoded code = %q", decoded.Code)
	}
}
