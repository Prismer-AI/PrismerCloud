package prismer

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	e2ePBKDF2Salt       = "prismer-e2e-salt"
	e2ePBKDF2Iterations = 100_000
	e2eKeyLength        = 32 // AES-256
	e2eIVLength         = 12 // GCM nonce
)

// E2EEncryption provides end-to-end encryption for IM messages.
//
// Uses AES-256-GCM for symmetric encryption with ECDH P-256 key exchange.
// Interoperable with TypeScript, Python, and Rust SDKs:
//   - Master key: PBKDF2-SHA256 (100k iterations), salt = "prismer-e2e-salt"
//   - Session keys: AES-256-GCM per conversation
//   - Key exchange: ECDH P-256
//   - Ciphertext format: base64(12-byte-IV + ciphertext)
//
// Usage:
//
//	enc := prismer.NewE2EEncryption()
//	enc.Init("user-passphrase")
//	enc.GenerateSessionKey("conv-123")
//	ciphertext, _ := enc.Encrypt("conv-123", "Hello!")
//	plaintext, _ := enc.Decrypt("conv-123", ciphertext)
type E2EEncryption struct {
	mu             sync.RWMutex
	masterKey      []byte
	sessionKeys    map[string][]byte
	privateKey     *ecdh.PrivateKey
	publicKeyBytes []byte
}

// NewE2EEncryption creates a new encryption manager.
func NewE2EEncryption() *E2EEncryption {
	return &E2EEncryption{
		sessionKeys: make(map[string][]byte),
	}
}

// Init derives the master key from a passphrase via PBKDF2-SHA256
// and generates an ECDH P-256 keypair for key exchange.
func (e *E2EEncryption) Init(passphrase string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	salt := []byte(e2ePBKDF2Salt)
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, e2ePBKDF2Iterations, e2eKeyLength)
	if err != nil {
		return fmt.Errorf("pbkdf2 key derivation: %w", err)
	}
	e.masterKey = key

	// Generate ECDH P-256 keypair
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate ECDH key: %w", err)
	}
	e.privateKey = priv
	e.publicKeyBytes = priv.PublicKey().Bytes()
	return nil
}

// IsInitialized returns true if Init has been called successfully.
func (e *E2EEncryption) IsInitialized() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.masterKey != nil
}

// ExportPublicKey returns the ECDH public key as a base64 string
// for sharing with conversation peers.
func (e *E2EEncryption) ExportPublicKey() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.publicKeyBytes == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(e.publicKeyBytes)
}

// DeriveSessionKey performs ECDH key exchange with a peer's public key
// and stores the derived session key for the given conversation.
// The peer public key must be base64-encoded (uncompressed point format).
// The session key is SHA-256(ECDH_shared_secret).
func (e *E2EEncryption) DeriveSessionKey(conversationID, peerPublicKeyB64 string) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.privateKey == nil {
		return nil, errors.New("encryption not initialized: call Init() first")
	}

	peerBytes, err := base64.StdEncoding.DecodeString(peerPublicKeyB64)
	if err != nil {
		return nil, fmt.Errorf("decode peer public key: %w", err)
	}

	peerKey, err := ecdh.P256().NewPublicKey(peerBytes)
	if err != nil {
		return nil, fmt.Errorf("parse peer public key: %w", err)
	}

	shared, err := e.privateKey.ECDH(peerKey)
	if err != nil {
		return nil, fmt.Errorf("ECDH exchange: %w", err)
	}

	// SHA-256(shared_secret) as session key
	hash := sha256.Sum256(shared)
	sessionKey := hash[:]
	e.sessionKeys[conversationID] = sessionKey
	return sessionKey, nil
}

// SetSessionKey stores a pre-shared session key for a conversation.
// The key must be exactly 32 bytes (AES-256).
func (e *E2EEncryption) SetSessionKey(conversationID string, key []byte) error {
	if len(key) != e2eKeyLength {
		return fmt.Errorf("session key must be %d bytes, got %d", e2eKeyLength, len(key))
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sessionKeys[conversationID] = make([]byte, e2eKeyLength)
	copy(e.sessionKeys[conversationID], key)
	return nil
}

// GenerateSessionKey generates a random 32-byte session key for a conversation
// and returns it. The caller can share this key with peers out-of-band.
func (e *E2EEncryption) GenerateSessionKey(conversationID string) ([]byte, error) {
	key := make([]byte, e2eKeyLength)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate random key: %w", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sessionKeys[conversationID] = key
	return key, nil
}

// HasSessionKey returns true if a session key exists for the given conversation.
func (e *E2EEncryption) HasSessionKey(conversationID string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	_, ok := e.sessionKeys[conversationID]
	return ok
}

// Encrypt encrypts plaintext for a conversation using AES-256-GCM.
// Returns base64(12-byte-IV + ciphertext).
// A session key must exist for the conversation (via GenerateSessionKey,
// SetSessionKey, or DeriveSessionKey).
func (e *E2EEncryption) Encrypt(conversationID, plaintext string) (string, error) {
	e.mu.RLock()
	key, ok := e.sessionKeys[conversationID]
	e.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("no session key for conversation: %s", conversationID)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	iv := make([]byte, e2eIVLength)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", fmt.Errorf("generate IV: %w", err)
	}

	ciphertext := gcm.Seal(nil, iv, []byte(plaintext), nil)

	// Prepend IV to ciphertext: [12-byte IV][ciphertext+tag]
	combined := make([]byte, e2eIVLength+len(ciphertext))
	copy(combined[:e2eIVLength], iv)
	copy(combined[e2eIVLength:], ciphertext)

	return base64.StdEncoding.EncodeToString(combined), nil
}

// Decrypt decrypts base64(12-byte-IV + ciphertext) for a conversation.
// A session key must exist for the conversation.
func (e *E2EEncryption) Decrypt(conversationID, encrypted string) (string, error) {
	e.mu.RLock()
	key, ok := e.sessionKeys[conversationID]
	e.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("no session key for conversation: %s", conversationID)
	}

	combined, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}

	if len(combined) < e2eIVLength+1 {
		return "", errors.New("ciphertext too short")
	}

	iv := combined[:e2eIVLength]
	ciphertext := combined[e2eIVLength:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create AES cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	plainBytes, err := gcm.Open(nil, iv, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plainBytes), nil
}

// RemoveSessionKey deletes the session key for a conversation.
func (e *E2EEncryption) RemoveSessionKey(conversationID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.sessionKeys, conversationID)
}

// Destroy clears all keys and resets state.
func (e *E2EEncryption) Destroy() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.masterKey = nil
	e.privateKey = nil
	e.publicKeyBytes = nil
	e.sessionKeys = make(map[string][]byte)
}
