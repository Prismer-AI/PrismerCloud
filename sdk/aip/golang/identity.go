package aip

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
)

type AIPIdentity struct {
	DID        string
	PublicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

func NewAIPIdentity() (*AIPIdentity, error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil { return nil, fmt.Errorf("generate key: %w", err) }
	did, _ := PublicKeyToDIDKey(pub)
	return &AIPIdentity{DID: did, PublicKey: pub, privateKey: priv}, nil
}

func AIPIdentityFromAPIKey(apiKey string) (*AIPIdentity, error) {
	seed := sha256.Sum256([]byte(apiKey))
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	did, _ := PublicKeyToDIDKey(pub)
	return &AIPIdentity{DID: did, PublicKey: pub, privateKey: priv}, nil
}

func AIPIdentityFromPrivateKey(privB64 string) (*AIPIdentity, error) {
	seed, err := base64.StdEncoding.DecodeString(privB64)
	if err != nil { return nil, fmt.Errorf("decode: %w", err) }
	if len(seed) != ed25519.SeedSize { return nil, errors.New("invalid key length") }
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	did, _ := PublicKeyToDIDKey(pub)
	return &AIPIdentity{DID: did, PublicKey: pub, privateKey: priv}, nil
}

func (id *AIPIdentity) PublicKeyBase64() string { return base64.StdEncoding.EncodeToString(id.PublicKey) }
func (id *AIPIdentity) Sign(data []byte) string { return base64.StdEncoding.EncodeToString(ed25519.Sign(id.privateKey, data)) }
func (id *AIPIdentity) ExportPrivateKey() string { return base64.StdEncoding.EncodeToString(id.privateKey.Seed()) }

func AIPVerify(data []byte, sigB64 string, signerDID string) bool {
	pub, err := DIDKeyToPublicKey(signerDID)
	if err != nil { return false }
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil { return false }
	return ed25519.Verify(pub, data, sig)
}

func (id *AIPIdentity) GetDIDDocument() map[string]interface{} {
	keyID := id.DID + "#keys-1"
	now := time.Now().UTC().Format(time.RFC3339)
	return map[string]interface{}{
		"@context": []string{"https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"},
		"id": id.DID, "controller": id.DID,
		"verificationMethod": []map[string]string{{"id": keyID, "type": "Ed25519VerificationKey2020", "controller": id.DID, "publicKeyMultibase": id.DID[8:]}},
		"authentication": []string{keyID}, "assertionMethod": []string{keyID},
		"capabilityDelegation": []string{keyID}, "capabilityInvocation": []string{keyID},
		"created": now, "updated": now,
	}
}
