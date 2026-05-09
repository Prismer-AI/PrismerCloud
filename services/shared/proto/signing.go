package proto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrPayloadHashMismatch = errors.New("payload_hash verification failed")
	ErrEnvelopeTimeSkew    = errors.New("envelope timestamp outside allowed skew")
	ErrEnvelopeSignature   = errors.New("envelope signature verification failed")
)

type signingEnvelope struct {
	V              uint8           `json:"v"`
	ID             string          `json:"id"`
	ExecutionID    string          `json:"execution_id"`
	Type           string          `json:"type"`
	MessageClass   MessageClass    `json:"message_class"`
	TimestampMs    any             `json:"timestamp_ms"`
	TraceID        string          `json:"trace_id,omitempty"`
	StateVersion   any             `json:"state_version,omitempty"`
	PayloadHash    string          `json:"payload_hash,omitempty"`
	StateCRC       string          `json:"state_crc,omitempty"`
	StreamID       string          `json:"stream_id,omitempty"`
	StreamSeq      any             `json:"stream_seq,omitempty"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	AckType        AckType         `json:"ack_type"`
	KeyID          string          `json:"key_id,omitempty"`
	Payload        json.RawMessage `json:"payload"`
}

func CanonicalizeJSON(raw json.RawMessage) ([]byte, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return []byte("null"), nil
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, err
	}
	return json.Marshal(generic)
}

func ComputePayloadHash(payload json.RawMessage) (string, error) {
	canonical, err := CanonicalizeJSON(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

func SigningInput(envelope Envelope) ([]byte, error) {
	canonicalPayload, err := CanonicalizeJSON(envelope.Payload)
	if err != nil {
		return nil, err
	}

	wire := signingEnvelope{
		V:              envelope.V,
		ID:             envelope.ID,
		ExecutionID:    envelope.ExecutionID,
		Type:           envelope.Type,
		MessageClass:   envelope.MessageClass,
		TimestampMs:    encodeWireInt64(envelope.TimestampMs),
		TraceID:        envelope.TraceID,
		StateVersion:   encodeWireInt64(envelope.StateVersion),
		PayloadHash:    envelope.PayloadHash,
		StateCRC:       envelope.StateCRC,
		StreamID:       envelope.StreamID,
		StreamSeq:      encodeWireInt64(envelope.StreamSeq),
		IdempotencyKey: envelope.IdempotencyKey,
		AckType:        envelope.AckType,
		KeyID:          envelope.KeyID,
		Payload:        canonicalPayload,
	}
	return json.Marshal(wire)
}

func VerifyPayloadHash(envelope Envelope) error {
	expected, err := ComputePayloadHash(envelope.Payload)
	if err != nil {
		return err
	}
	if expected != envelope.PayloadHash {
		return fmt.Errorf("%w: expected=%s actual=%s", ErrPayloadHashMismatch, expected, envelope.PayloadHash)
	}
	return nil
}

func VerifyEnvelopeSignature(envelope Envelope, publicKey ed25519.PublicKey, now time.Time, maxSkew time.Duration) error {
	if err := VerifyPayloadHash(envelope); err != nil {
		return err
	}
	if maxSkew > 0 {
		ts := time.UnixMilli(envelope.TimestampMs)
		diff := now.Sub(ts)
		if diff < 0 {
			diff = -diff
		}
		if diff > maxSkew {
			return fmt.Errorf("%w: timestamp_ms=%d", ErrEnvelopeTimeSkew, envelope.TimestampMs)
		}
	}
	sigInput, err := SigningInput(envelope)
	if err != nil {
		return err
	}
	sigBytes, err := DecodeBase64Any(envelope.Signature)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrEnvelopeSignature, err)
	}
	digest := sha256.Sum256(sigInput)
	if !ed25519.Verify(publicKey, digest[:], sigBytes) {
		return ErrEnvelopeSignature
	}
	return nil
}

func SignEnvelope(envelope *Envelope, privateKey ed25519.PrivateKey) error {
	if envelope == nil {
		return fmt.Errorf("envelope required")
	}
	sigInput, err := SigningInput(*envelope)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(sigInput)
	envelope.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:]))
	return nil
}

func DecodeBase64Any(raw string) ([]byte, error) {
	if raw == "" {
		return nil, fmt.Errorf("empty base64 value")
	}
	codecs := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}
	var lastErr error
	for _, codec := range codecs {
		decoded, err := codec.DecodeString(raw)
		if err == nil {
			return decoded, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func encodeWireInt64(value int64) any {
	if value == 0 {
		return nil
	}
	if value > MaxSafeJSInt {
		return fmt.Sprintf("%d", value)
	}
	return value
}
