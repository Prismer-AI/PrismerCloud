package identity

import (
	"crypto/ed25519"
	"encoding/json"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

// CanonicalizeJSON is the shared Phase A JSON canonicalization entrypoint.
// It intentionally delegates to proto until the protocol package is split into
// generated wire bindings and reusable crypto helpers.
func CanonicalizeJSON(raw json.RawMessage) ([]byte, error) {
	return proto.CanonicalizeJSON(raw)
}

func ComputePayloadHash(payload json.RawMessage) (string, error) {
	return proto.ComputePayloadHash(payload)
}

func EnvelopeSigningInput(envelope proto.Envelope) ([]byte, error) {
	return proto.SigningInput(envelope)
}

func SignEnvelope(envelope *proto.Envelope, privateKey ed25519.PrivateKey) error {
	return proto.SignEnvelope(envelope, privateKey)
}

func VerifyEnvelopeSignature(envelope proto.Envelope, publicKey ed25519.PublicKey, now time.Time, maxSkew time.Duration) error {
	return proto.VerifyEnvelopeSignature(envelope, publicKey, now, maxSkew)
}
