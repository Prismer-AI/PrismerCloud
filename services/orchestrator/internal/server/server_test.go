package server

import (
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() returned error: %v", err)
	}
	if cfg.ProtocolEnforce != ProtocolEnforceStrict {
		t.Fatalf("expected strict mode, got %q", cfg.ProtocolEnforce)
	}
	if cfg.SignatureFallback != SignatureFallbackNone {
		t.Fatalf("expected no signature fallback, got %q", cfg.SignatureFallback)
	}
	if cfg.RuntimeJoinToken != "" || len(cfg.AllowedRuntimeDIDs) != 0 || cfg.RuntimeSignatureRequired || cfg.RuntimeMaxTimeSkew != 5*time.Minute {
		t.Fatalf("expected empty runtime auth config, got %+v", cfg)
	}
}

func TestLoadConfigAllowsMixedProtocolMode(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "mixed")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "none")
	t.Setenv("APP_ENV", "")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() returned error: %v", err)
	}
	if cfg.ProtocolEnforce != ProtocolEnforceMixed {
		t.Fatalf("expected mixed mode, got %q", cfg.ProtocolEnforce)
	}
}

func TestLoadConfigRejectsSignatureDisable(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "strict")
	t.Setenv("SIGNATURE_ENFORCE", "false")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "staging")

	_, err := LoadConfigFromEnv()
	if err == nil || !strings.Contains(err.Error(), "SIGNATURE_ENFORCE=false is disallowed") {
		t.Fatalf("expected SIGNATURE_ENFORCE rejection, got %v", err)
	}
}

func TestLoadConfigRejectsProductionHMACFallback(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "strict")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "hmac_only")
	t.Setenv("APP_ENV", "production")

	_, err := LoadConfigFromEnv()
	if err == nil || !strings.Contains(err.Error(), "not allowed in production") {
		t.Fatalf("expected production fallback rejection, got %v", err)
	}
}

func TestLoadConfigParsesRuntimeAuth(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("PRISMER_RUNTIME_JOIN_TOKEN", "join-secret")
	t.Setenv("PRISMER_RUNTIME_ALLOWED_DIDS", "did:key:rt1, did:key:rt2, did:key:rt1")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() returned error: %v", err)
	}
	if cfg.RuntimeJoinToken != "join-secret" {
		t.Fatalf("unexpected join token: %q", cfg.RuntimeJoinToken)
	}
	if len(cfg.AllowedRuntimeDIDs) != 2 || cfg.AllowedRuntimeDIDs[0] != "did:key:rt1" || cfg.AllowedRuntimeDIDs[1] != "did:key:rt2" {
		t.Fatalf("unexpected allowed dids: %+v", cfg.AllowedRuntimeDIDs)
	}
}

func TestLoadConfigParsesRuntimeSignatureSettings(t *testing.T) {
	t.Setenv("PRISMER_PROTOCOL_ENFORCE", "")
	t.Setenv("SIGNATURE_ENFORCE", "")
	t.Setenv("SIGNATURE_FALLBACK", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("PRISMER_RUNTIME_SIGNATURE_REQUIRED", "true")
	t.Setenv("PRISMER_RUNTIME_MAX_SKEW_MS", "120000")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() returned error: %v", err)
	}
	if !cfg.RuntimeSignatureRequired || cfg.RuntimeMaxTimeSkew != 2*time.Minute {
		t.Fatalf("unexpected runtime signature config: %+v", cfg)
	}
}
