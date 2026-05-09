package server

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type ProtocolEnforceMode string

const (
	ProtocolEnforceStrict ProtocolEnforceMode = "strict"
	ProtocolEnforceMixed  ProtocolEnforceMode = "mixed"
	ProtocolEnforceOff    ProtocolEnforceMode = "off"
)

type SignatureFallbackMode string

const (
	SignatureFallbackNone     SignatureFallbackMode = "none"
	SignatureFallbackHMACOnly SignatureFallbackMode = "hmac_only"
)

type Config struct {
	ProtocolEnforce          ProtocolEnforceMode
	SignatureFallback        SignatureFallbackMode
	RuntimeJoinToken         string
	AllowedRuntimeDIDs       []string
	RuntimeSignatureRequired bool
	RuntimeMaxTimeSkew       time.Duration
}

func LoadConfigFromEnv() (Config, error) {
	protocolMode, err := parseProtocolEnforceMode(os.Getenv("PRISMER_PROTOCOL_ENFORCE"))
	if err != nil {
		return Config{}, err
	}
	signatureFallback, err := parseSignatureFallback(
		os.Getenv("SIGNATURE_ENFORCE"),
		os.Getenv("SIGNATURE_FALLBACK"),
		os.Getenv("APP_ENV"),
	)
	if err != nil {
		return Config{}, err
	}
	maxSkew, err := parseRuntimeMaxTimeSkew(os.Getenv("PRISMER_RUNTIME_MAX_SKEW_MS"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		ProtocolEnforce:          protocolMode,
		SignatureFallback:        signatureFallback,
		RuntimeJoinToken:         strings.TrimSpace(os.Getenv("PRISMER_RUNTIME_JOIN_TOKEN")),
		AllowedRuntimeDIDs:       parseCommaSeparatedEnv(os.Getenv("PRISMER_RUNTIME_ALLOWED_DIDS")),
		RuntimeSignatureRequired: parseBoolEnv(os.Getenv("PRISMER_RUNTIME_SIGNATURE_REQUIRED")),
		RuntimeMaxTimeSkew:       maxSkew,
	}, nil
}

func parseProtocolEnforceMode(raw string) (ProtocolEnforceMode, error) {
	switch raw {
	case "", string(ProtocolEnforceStrict):
		return ProtocolEnforceStrict, nil
	case string(ProtocolEnforceMixed):
		return ProtocolEnforceMixed, nil
	case string(ProtocolEnforceOff):
		return ProtocolEnforceOff, nil
	default:
		return "", fmt.Errorf("unknown PRISMER_PROTOCOL_ENFORCE value: %s", raw)
	}
}

func parseSignatureFallback(signatureEnforce, signatureFallback, appEnv string) (SignatureFallbackMode, error) {
	if signatureEnforce == "false" {
		return "", fmt.Errorf(
			"SIGNATURE_ENFORCE=false is disallowed in V3; use SIGNATURE_FALLBACK=hmac_only to degrade safely",
		)
	}

	switch signatureFallback {
	case "", "none":
		return SignatureFallbackNone, nil
	case string(SignatureFallbackHMACOnly):
		if appEnv == "production" {
			return "", fmt.Errorf("SIGNATURE_FALLBACK=hmac_only is not allowed in production")
		}
		return SignatureFallbackHMACOnly, nil
	default:
		return "", fmt.Errorf("unknown SIGNATURE_FALLBACK value: %s", signatureFallback)
	}
}

func parseCommaSeparatedEnv(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseBoolEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func parseRuntimeMaxTimeSkew(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 5 * time.Minute, nil
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		return 0, fmt.Errorf("invalid PRISMER_RUNTIME_MAX_SKEW_MS: %s", raw)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
