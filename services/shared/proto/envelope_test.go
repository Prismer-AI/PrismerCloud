package proto

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEnvelopeValidate_StatefulSuccess(t *testing.T) {
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "task.finished",
		MessageClass: MessageClassStateful,
		TimestampMs:  1735603200000,
		StateVersion: 7,
		PayloadHash:  "hash_123",
		AckType:      AckTypeRequired,
		Payload:      json.RawMessage(`{"ok":true}`),
	}

	if err := env.Validate(); err != nil {
		t.Fatalf("Validate() returned error: %v", err)
	}
}

func TestEnvelopeValidate_RejectsUnknownType(t *testing.T) {
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "task.unknown",
		MessageClass: MessageClassStateful,
		TimestampMs:  1735603200000,
		StateVersion: 1,
		PayloadHash:  "hash_123",
		AckType:      AckTypeRequired,
		Payload:      json.RawMessage(`{}`),
	}

	err := env.Validate()
	if err == nil || !strings.Contains(err.Error(), "unknown message type") {
		t.Fatalf("expected unknown message type error, got %v", err)
	}
}

func TestEnvelopeValidate_RejectsClassMismatch(t *testing.T) {
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "task.log_chunk",
		MessageClass: MessageClassStateful,
		TimestampMs:  1735603200000,
		StateVersion: 1,
		PayloadHash:  "hash_123",
		AckType:      AckTypeRequired,
		Payload:      json.RawMessage(`{}`),
	}

	err := env.Validate()
	if err == nil || !strings.Contains(err.Error(), "must use message_class=stream") {
		t.Fatalf("expected class mismatch error, got %v", err)
	}
}

func TestEnvelopeValidate_RequiresKeyIDWhenSigned(t *testing.T) {
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "task.finished",
		MessageClass: MessageClassStateful,
		TimestampMs:  1735603200000,
		StateVersion: 7,
		PayloadHash:  "hash_123",
		AckType:      AckTypeRequired,
		Signature:    "sig_123",
		Payload:      json.RawMessage(`{"ok":true}`),
	}

	err := env.Validate()
	if err == nil || !strings.Contains(err.Error(), "key_id") {
		t.Fatalf("expected key_id error, got %v", err)
	}
}

func TestEnvelopeValidate_LegacyBlankClassNormalizes(t *testing.T) {
	env := Envelope{
		ID:          "legacy_01",
		ExecutionID: "exe_01HKTEST0000000000000001",
		Type:        "task.finished",
		TimestampMs: 1735603200000,
		Payload:     json.RawMessage(`{"ok":true}`),
	}

	if err := env.Validate(); err != nil {
		t.Fatalf("Validate() returned error: %v", err)
	}
	if env.MessageClass != MessageClassLegacy {
		t.Fatalf("expected MessageClassLegacy, got %q", env.MessageClass)
	}
}

func TestEnvelopeMarshalJSON_StringifiesLargeInts(t *testing.T) {
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "task.finished",
		MessageClass: MessageClassStateful,
		TimestampMs:  MaxSafeJSInt + 1,
		StateVersion: MaxSafeJSInt + 2,
		AckType:      AckTypeRequired,
		PayloadHash:  "hash_123",
		Payload:      json.RawMessage(`{"ok":true}`),
	}

	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("Marshal() returned error: %v", err)
	}

	var generic map[string]any
	if err := json.Unmarshal(data, &generic); err != nil {
		t.Fatalf("Unmarshal() returned error: %v", err)
	}
	if _, ok := generic["timestamp_ms"].(string); !ok {
		t.Fatalf("expected timestamp_ms to be string, got %T", generic["timestamp_ms"])
	}
	if _, ok := generic["state_version"].(string); !ok {
		t.Fatalf("expected state_version to be string, got %T", generic["state_version"])
	}
}

func TestEnvelopeUnmarshalJSON_AcceptsStringAndNumberInts(t *testing.T) {
	var env Envelope
	data := []byte(`{
		"v": 2,
		"id": "msg_01HKTEST0000000000000001",
		"execution_id": "exe_01HKTEST0000000000000001",
		"type": "task.finished",
		"message_class": "stateful",
		"timestamp_ms": "1735603200001",
		"state_version": 9,
		"payload_hash": "hash_123",
		"ack_type": "required",
		"payload": {"ok": true}
	}`)

	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("Unmarshal() returned error: %v", err)
	}
	if env.TimestampMs != 1735603200001 {
		t.Fatalf("unexpected timestamp_ms: %d", env.TimestampMs)
	}
	if env.StateVersion != 9 {
		t.Fatalf("unexpected state_version: %d", env.StateVersion)
	}
}
