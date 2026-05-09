package proto

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// ProtocolVersionV2 is the current envelope protocol version. v=1 is legacy.
const ProtocolVersionV2 uint8 = 2

// MaxSafeJSInt is JavaScript's Number.MAX_SAFE_INTEGER (2^53 - 1). int64 values
// strictly greater than this MUST be string-encoded on the wire to survive
// JCS bit-exact equality across TS / Go / Rust serializers (contract §1.2).
const MaxSafeJSInt int64 = 9007199254740991

// Envelope is the top-level WebSocket message wrapper for Phase A v2.
//
// Wire format and field semantics are defined in
// docs/phase_a_protocol_contract.md §1. This struct is the Go binding;
// schema_contract_guard.sh enforces parity with the spec, the TS binding
// (server/src/lib/contracts/wsMessage.ts), and the Prisma dedup tables.
//
// Field order in this struct is intentionally aligned with §1.1 of the
// contract to make diff review across the spec / Go / TS bindings trivial.
type Envelope struct {
	// V is the protocol version. MUST be ProtocolVersionV2 for v2 traffic.
	// Server returns 426 Upgrade Required for v > 2; pre-v2 envelopes are
	// tagged MessageClassLegacy in Validate().
	V uint8 `json:"v"`

	// ID is a client-generated ULID (26 chars, Crockford base32).
	// Server does NOT rewrite. For legacy envelopes lacking an id, the
	// orchestrator synthesises "legacy_<sha256(payload)[:16]>" (contract §2.4.1).
	ID string `json:"id"`

	// ExecutionID references IMExecution.id. Required for all messages so
	// the dedup router can partition state. Empty → 400 reject.
	ExecutionID string `json:"execution_id"`

	// Type is one of the 13 wire types listed in contract §3. Unknown types
	// are rejected with code=400 (see IsKnownMessageType).
	Type string `json:"type"`

	// MessageClass routes this envelope to the correct idempotency handler.
	// Empty string is interpreted as Legacy in Validate() during the rolling
	// upgrade window.
	MessageClass MessageClass `json:"message_class"`

	// TimestampMs is Unix milliseconds. Nanoseconds are NOT permitted (would
	// exceed Number.MAX_SAFE_INTEGER and lose precision in TS).
	TimestampMs int64 `json:"timestamp_ms"`

	// TraceID is an optional OpenTelemetry trace id, propagated end-to-end.
	TraceID string `json:"trace_id,omitempty"`

	// --- stateful required ---

	// StateVersion is the CAS token. Stream messages set this to 0.
	// May arrive as JSON number or string; see UnmarshalJSON for the
	// large-int-safety dance (contract §1.2).
	StateVersion int64 `json:"state_version,omitempty"`

	// PayloadHash is base64url(sha256(JCS(payload))). Required on stateful
	// messages; verifier recomputes and compares before signature check
	// (contract §5.2.1 step 1).
	PayloadHash string `json:"payload_hash,omitempty"`

	// StateCRC is an optional client-computed CRC of the expected
	// post-transition state. Server compares for early divergence detection.
	StateCRC string `json:"state_crc,omitempty"`

	// --- stream required ---

	// StreamID identifies a logical append-only stream within an execution
	// (e.g., "stdout", "stderr", "progress"). MUST be deterministic across
	// daemon restarts (contract §2.3.1).
	StreamID string `json:"stream_id,omitempty"`

	// StreamSeq is the per-(execution_id, stream_id) monotonic sequence
	// number, strictly +1 per envelope.
	StreamSeq int64 `json:"stream_seq,omitempty"`

	// IdempotencyKey is an optional application-layer dedup token.
	IdempotencyKey string `json:"idempotency_key,omitempty"`

	// --- common ---

	// AckType drives server ack obligation and client retry policy.
	AckType AckType `json:"ack_type"`

	// Signature is base64url(ed25519.sign(sha256(JCS(envelope_without_signature)))).
	// Optional per signature-tier table (contract §5.1).
	Signature string `json:"signature,omitempty"`

	// KeyID identifies the signing key (DID + key fragment, e.g.
	// "did:key:z6Mk...#k1"). Required when Signature is non-empty.
	KeyID string `json:"key_id,omitempty"`

	// Payload is the type-specific body. Schema lives in
	// services/shared/proto/schemas/<type>.json (W3 deliverable).
	Payload json.RawMessage `json:"payload"`
}

// envelopeWire is an internal struct used only for unmarshalling so that
// large-int fields can be either JSON number or string without polluting the
// public Envelope shape (contract §1.2).
type envelopeWire struct {
	V              uint8           `json:"v"`
	ID             string          `json:"id"`
	ExecutionID    string          `json:"execution_id"`
	Type           string          `json:"type"`
	MessageClass   MessageClass    `json:"message_class"`
	TimestampMs    json.RawMessage `json:"timestamp_ms"`
	TraceID        string          `json:"trace_id,omitempty"`
	StateVersion   json.RawMessage `json:"state_version,omitempty"`
	PayloadHash    string          `json:"payload_hash,omitempty"`
	StateCRC       string          `json:"state_crc,omitempty"`
	StreamID       string          `json:"stream_id,omitempty"`
	StreamSeq      json.RawMessage `json:"stream_seq,omitempty"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	AckType        AckType         `json:"ack_type"`
	Signature      string          `json:"signature,omitempty"`
	KeyID          string          `json:"key_id,omitempty"`
	Payload        json.RawMessage `json:"payload"`
}

// UnmarshalJSON accepts state_version / stream_seq / timestamp_ms either as
// JSON number or as JSON string, then normalises into int64. This is required
// because TypeScript senders MUST encode int64 > MaxSafeJSInt as strings to
// avoid precision loss (contract §1.2).
func (e *Envelope) UnmarshalJSON(data []byte) error {
	var w envelopeWire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	ts, err := decodeFlexibleInt64(w.TimestampMs, "timestamp_ms")
	if err != nil {
		return err
	}
	sv, err := decodeFlexibleInt64(w.StateVersion, "state_version")
	if err != nil {
		return err
	}
	ss, err := decodeFlexibleInt64(w.StreamSeq, "stream_seq")
	if err != nil {
		return err
	}
	*e = Envelope{
		V:              w.V,
		ID:             w.ID,
		ExecutionID:    w.ExecutionID,
		Type:           w.Type,
		MessageClass:   w.MessageClass,
		TimestampMs:    ts,
		TraceID:        w.TraceID,
		StateVersion:   sv,
		PayloadHash:    w.PayloadHash,
		StateCRC:       w.StateCRC,
		StreamID:       w.StreamID,
		StreamSeq:      ss,
		IdempotencyKey: w.IdempotencyKey,
		AckType:        w.AckType,
		Signature:      w.Signature,
		KeyID:          w.KeyID,
		Payload:        w.Payload,
	}
	return nil
}

// decodeFlexibleInt64 parses an int64 from either a JSON number or a JSON
// string. Empty input returns 0 with no error (omitempty fields).
func decodeFlexibleInt64(raw json.RawMessage, fieldName string) (int64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0, fmt.Errorf("%s: invalid string: %w", fieldName, err)
		}
		if s == "" {
			return 0, nil
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s: invalid int64 string: %w", fieldName, err)
		}
		return n, nil
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, fmt.Errorf("%s: invalid int64: %w", fieldName, err)
	}
	return n, nil
}

// MarshalJSON re-encodes int64 fields as strings when they exceed MaxSafeJSInt
// to maintain cross-language byte-exact equality (contract §1.2).
func (e Envelope) MarshalJSON() ([]byte, error) {
	type alias Envelope
	if e.TimestampMs <= MaxSafeJSInt && e.StateVersion <= MaxSafeJSInt && e.StreamSeq <= MaxSafeJSInt {
		return json.Marshal(alias(e))
	}
	// Fallback: build map with string-encoded large ints.
	buf, err := json.Marshal(alias(e))
	if err != nil {
		return nil, err
	}
	var generic map[string]any
	if err := json.Unmarshal(buf, &generic); err != nil {
		return nil, err
	}
	if e.TimestampMs > MaxSafeJSInt {
		generic["timestamp_ms"] = strconv.FormatInt(e.TimestampMs, 10)
	}
	if e.StateVersion > MaxSafeJSInt {
		generic["state_version"] = strconv.FormatInt(e.StateVersion, 10)
	}
	if e.StreamSeq > MaxSafeJSInt {
		generic["stream_seq"] = strconv.FormatInt(e.StreamSeq, 10)
	}
	return json.Marshal(generic)
}

// Validate enforces class-specific field requirements as specified in
// contract §1.1, §2.2, §2.3, §2.4.1.
//
// Pre-v2 envelopes (no message_class) are tagged MessageClassLegacy and
// ALWAYS pass validation; downstream routes them to a non-deduping handler.
// This is the rolling-upgrade compat path.
func (e *Envelope) Validate() error {
	if e.ExecutionID == "" {
		return errors.New("execution_id required")
	}
	if e.ID == "" && e.MessageClass != MessageClassLegacy && e.MessageClass != "" {
		return errors.New("id required")
	}
	if e.Type == "" {
		return errors.New("type required")
	}
	if e.MessageClass != MessageClassLegacy && e.MessageClass != "" && !IsKnownMessageType(e.Type) {
		return fmt.Errorf("unknown message type: %s", e.Type)
	}
	if e.AckType == "" && e.MessageClass != MessageClassLegacy && e.MessageClass != "" {
		return errors.New("ack_type required")
	}

	switch e.MessageClass {
	case MessageClassStateful:
		if ClassifyMessage(e.Type) != MessageClassStateful {
			return fmt.Errorf("message type %s must use message_class=%s", e.Type, ClassifyMessage(e.Type))
		}
		if e.V != ProtocolVersionV2 {
			return fmt.Errorf("stateful message requires v=%d", ProtocolVersionV2)
		}
		if e.StateVersion <= 0 {
			return errors.New("stateful message requires state_version > 0")
		}
		if e.PayloadHash == "" {
			return errors.New("stateful message requires payload_hash")
		}
		if e.Signature != "" && e.KeyID == "" {
			return errors.New("signature present requires key_id")
		}
		if !validAckType(e.AckType) {
			return fmt.Errorf("invalid ack_type: %s", e.AckType)
		}
		return nil

	case MessageClassStream:
		if ClassifyMessage(e.Type) != MessageClassStream {
			return fmt.Errorf("message type %s must use message_class=%s", e.Type, ClassifyMessage(e.Type))
		}
		if e.V != ProtocolVersionV2 {
			return fmt.Errorf("stream message requires v=%d", ProtocolVersionV2)
		}
		if e.StreamID == "" {
			return errors.New("stream message requires stream_id")
		}
		if e.StreamSeq < 0 {
			return errors.New("stream_seq must be >= 0")
		}
		if e.Signature != "" && e.KeyID == "" {
			return errors.New("signature present requires key_id")
		}
		if !validAckType(e.AckType) {
			return fmt.Errorf("invalid ack_type: %s", e.AckType)
		}
		return nil

	case MessageClassLegacy, "":
		// pre-v2 envelopes: tag as legacy, skip strict validation, route to
		// best-effort handler. See contract §2.4.1.
		e.MessageClass = MessageClassLegacy
		return nil

	default:
		return fmt.Errorf("unknown message_class: %s", e.MessageClass)
	}
}

// validAckType reports whether the AckType is one of the three legal values.
func validAckType(a AckType) bool {
	switch a {
	case AckTypeRequired, AckTypeBestEffort, AckTypeNone:
		return true
	}
	return false
}
