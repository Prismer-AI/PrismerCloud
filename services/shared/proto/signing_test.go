package proto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestComputePayloadHashCanonicalizesJSON(t *testing.T) {
	hashA, err := ComputePayloadHash(json.RawMessage(`{"b":2,"a":1}`))
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	hashB, err := ComputePayloadHash(json.RawMessage(`{"a":1,"b":2}`))
	if err != nil {
		t.Fatalf("ComputePayloadHash() second error = %v", err)
	}
	if hashA != hashB {
		t.Fatalf("expected canonical hash equality, got %q != %q", hashA, hashB)
	}
}

func TestVerifyEnvelopeSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	payload := json.RawMessage(`{"b":2,"a":1}`)
	payloadHash, err := ComputePayloadHash(payload)
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000001",
		ExecutionID:  "exe_01HKTEST0000000000000001",
		Type:         "runtime.hello",
		MessageClass: MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  payloadHash,
		AckType:      AckTypeRequired,
		KeyID:        "did:key:test#k1",
		Payload:      payload,
	}
	if err := SignEnvelope(&env, privateKey); err != nil {
		t.Fatalf("SignEnvelope() error = %v", err)
	}

	if err := VerifyEnvelopeSignature(env, publicKey, time.Now(), 5*time.Minute); err != nil {
		t.Fatalf("VerifyEnvelopeSignature() error = %v", err)
	}
}

func TestVerifyEnvelopeSignatureRejectsPayloadTamper(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	payloadHash, err := ComputePayloadHash(json.RawMessage(`{"ok":true}`))
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000002",
		ExecutionID:  "exe_01HKTEST0000000000000002",
		Type:         "runtime.hello",
		MessageClass: MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: 1,
		PayloadHash:  payloadHash,
		AckType:      AckTypeRequired,
		KeyID:        "did:key:test#k1",
		Payload:      json.RawMessage(`{"ok":true}`),
	}
	if err := SignEnvelope(&env, privateKey); err != nil {
		t.Fatalf("SignEnvelope() error = %v", err)
	}
	env.Payload = json.RawMessage(`{"ok":false}`)

	err = VerifyEnvelopeSignature(env, publicKey, time.Now(), 5*time.Minute)
	if err == nil || !errors.Is(err, ErrPayloadHashMismatch) {
		t.Fatalf("expected payload hash mismatch, got %v", err)
	}
}

func TestVerifyEnvelopeSignatureRejectsSkew(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	payloadHash, err := ComputePayloadHash(json.RawMessage(`{"ok":true}`))
	if err != nil {
		t.Fatalf("ComputePayloadHash() error = %v", err)
	}
	env := Envelope{
		V:            ProtocolVersionV2,
		ID:           "msg_01HKTEST0000000000000003",
		ExecutionID:  "exe_01HKTEST0000000000000003",
		Type:         "runtime.hello",
		MessageClass: MessageClassStateful,
		TimestampMs:  time.Now().Add(-10 * time.Minute).UnixMilli(),
		StateVersion: 1,
		PayloadHash:  payloadHash,
		AckType:      AckTypeRequired,
		KeyID:        "did:key:test#k1",
		Payload:      json.RawMessage(`{"ok":true}`),
	}
	if err := SignEnvelope(&env, privateKey); err != nil {
		t.Fatalf("SignEnvelope() error = %v", err)
	}

	err = VerifyEnvelopeSignature(env, publicKey, time.Now(), 5*time.Minute)
	if err == nil || !errors.Is(err, ErrEnvelopeTimeSkew) {
		t.Fatalf("expected time skew error, got %v", err)
	}
}
