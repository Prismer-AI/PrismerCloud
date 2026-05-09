package identity

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

var (
	ErrSigningKeyUnknown              = errors.New("signing key unknown")
	ErrSigningKeyUnsupportedAlgorithm = errors.New("signing key uses unsupported algorithm")
	ErrSigningKeyRevoked              = errors.New("signing key revoked")
	ErrSigningKeyExpired              = errors.New("signing key expired")
	ErrSigningKeyInvalidPublicKey     = errors.New("signing key has invalid public key")
)

type StoreKeyResolver struct {
	Store shareddb.Store
}

func (r StoreKeyResolver) ActiveEd25519PublicKey(ctx context.Context, keyID string, now time.Time) (ed25519.PublicKey, error) {
	if r.Store == nil {
		return nil, fmt.Errorf("%w: store not configured", ErrSigningKeyUnknown)
	}
	key, err := r.Store.GetSigningKeyByKeyID(ctx, keyID)
	if err != nil {
		if errors.Is(err, shareddb.ErrSigningKeyNotFound) {
			return nil, fmt.Errorf("%w: %s", ErrSigningKeyUnknown, keyID)
		}
		return nil, err
	}
	return ActiveEd25519PublicKey(key, now)
}

func ActiveEd25519PublicKey(key shareddb.SigningKey, now time.Time) (ed25519.PublicKey, error) {
	if key.Algorithm != "" && key.Algorithm != "ed25519" {
		return nil, fmt.Errorf("%w: %s", ErrSigningKeyUnsupportedAlgorithm, key.Algorithm)
	}
	if key.RevokedAt != nil {
		return nil, ErrSigningKeyRevoked
	}
	if key.ExpiresAt != nil && !key.ExpiresAt.After(now) {
		return nil, ErrSigningKeyExpired
	}
	publicKeyBytes, err := proto.DecodeBase64Any(key.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSigningKeyInvalidPublicKey, err)
	}
	if len(publicKeyBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: got %d bytes", ErrSigningKeyInvalidPublicKey, len(publicKeyBytes))
	}
	return ed25519.PublicKey(publicKeyBytes), nil
}
