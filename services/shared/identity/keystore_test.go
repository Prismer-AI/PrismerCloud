package identity

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestStoreKeyResolverActiveEd25519PublicKey(t *testing.T) {
	ctx := context.Background()
	store := shareddb.NewMemoryStore()
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	_, err = store.CreateSigningKey(ctx, shareddb.CreateSigningKeyParams{
		ID:        "key_1",
		DID:       "did:key:runtime1",
		KeyID:     "did:key:runtime1#k1",
		PublicKey: base64.RawURLEncoding.EncodeToString(publicKey),
	})
	if err != nil {
		t.Fatalf("CreateSigningKey() error = %v", err)
	}

	resolved, err := (StoreKeyResolver{Store: store}).ActiveEd25519PublicKey(ctx, "did:key:runtime1#k1", time.Now())
	if err != nil {
		t.Fatalf("ActiveEd25519PublicKey() error = %v", err)
	}
	if !resolved.Equal(publicKey) {
		t.Fatalf("resolved public key mismatch")
	}
}

func TestActiveEd25519PublicKeyRejectsInactiveKeys(t *testing.T) {
	now := time.Unix(1000, 0)
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	encodedPublicKey := base64.RawURLEncoding.EncodeToString(publicKey)
	revokedAt := now.Add(-time.Second)
	expiredAt := now

	tests := []struct {
		name string
		key  shareddb.SigningKey
		want error
	}{
		{
			name: "unsupported algorithm",
			key: shareddb.SigningKey{
				Algorithm: "rsa",
				PublicKey: encodedPublicKey,
			},
			want: ErrSigningKeyUnsupportedAlgorithm,
		},
		{
			name: "revoked",
			key: shareddb.SigningKey{
				Algorithm: "ed25519",
				PublicKey: encodedPublicKey,
				RevokedAt: &revokedAt,
			},
			want: ErrSigningKeyRevoked,
		},
		{
			name: "expired",
			key: shareddb.SigningKey{
				Algorithm: "ed25519",
				PublicKey: encodedPublicKey,
				ExpiresAt: &expiredAt,
			},
			want: ErrSigningKeyExpired,
		},
		{
			name: "bad public key",
			key: shareddb.SigningKey{
				Algorithm: "ed25519",
				PublicKey: base64.RawURLEncoding.EncodeToString([]byte("too-short")),
			},
			want: ErrSigningKeyInvalidPublicKey,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ActiveEd25519PublicKey(tt.key, now)
			if !errors.Is(err, tt.want) {
				t.Fatalf("ActiveEd25519PublicKey() error = %v, want %v", err, tt.want)
			}
		})
	}
}
