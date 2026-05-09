package transport

import (
	"strings"
	"time"
)

type AuthConfig struct {
	RuntimeJoinToken         string
	AllowedDIDs              map[string]struct{}
	RuntimeSignatureRequired bool
	RuntimeMaxTimeSkew       time.Duration
}

func NewAuthConfig(joinToken string, allowedDIDs []string, runtimeSignatureRequired bool, runtimeMaxTimeSkew time.Duration) AuthConfig {
	cfg := AuthConfig{
		RuntimeJoinToken:         strings.TrimSpace(joinToken),
		RuntimeSignatureRequired: runtimeSignatureRequired,
		RuntimeMaxTimeSkew:       runtimeMaxTimeSkew,
	}
	if len(allowedDIDs) == 0 {
		return cfg
	}
	cfg.AllowedDIDs = make(map[string]struct{}, len(allowedDIDs))
	for _, did := range allowedDIDs {
		did = strings.TrimSpace(did)
		if did == "" {
			continue
		}
		cfg.AllowedDIDs[did] = struct{}{}
	}
	if len(cfg.AllowedDIDs) == 0 {
		cfg.AllowedDIDs = nil
	}
	return cfg
}

func (c AuthConfig) AllowsDID(did string) bool {
	if len(c.AllowedDIDs) == 0 {
		return true
	}
	_, ok := c.AllowedDIDs[did]
	return ok
}

func (c AuthConfig) RequiresJoinToken() bool {
	return c.RuntimeJoinToken != ""
}

func (c AuthConfig) RequiresRuntimeSignature() bool {
	return c.RuntimeSignatureRequired
}
