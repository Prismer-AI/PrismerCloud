package app

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadConfigFromEnvDefaults(t *testing.T) {
	t.Setenv("PRISMER_DAEMON_DID", "did:key:test")
	t.Setenv("PRISMER_ORCH_WS_URL", "ws://localhost:8080/ws/runtime")
	t.Setenv("PRISMER_DAEMON_SESSION_ID", "")
	t.Setenv("PRISMER_DAEMON_VERSION", "")
	t.Setenv("PRISMER_DAEMON_CAPABILITIES", "claude-code@1.2.3=/usr/local/bin/claude,codex@0.5.0=/usr/local/bin/codex")
	t.Setenv("PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS", "")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() error = %v", err)
	}
	if cfg.WS.RuntimeDID != "did:key:test" || cfg.WS.URL != "ws://localhost:8080/ws/runtime" {
		t.Fatalf("unexpected ws config: %+v", cfg.WS)
	}
	if cfg.WS.SessionID == "" || cfg.WS.Version != "0.1.0" || cfg.WS.HeartbeatInterval != 20*time.Second {
		t.Fatalf("unexpected defaulted ws config: %+v", cfg.WS)
	}
	if len(cfg.WS.Capabilities) != 2 || cfg.WS.Capabilities[0].Key != "claude-code" || cfg.WS.Capabilities[1].Path != "/usr/local/bin/codex" {
		t.Fatalf("unexpected capabilities: %+v", cfg.WS.Capabilities)
	}
	if cfg.ApprovalPolicy.Enforce {
		t.Fatalf("expected approval policy disabled by default, got %+v", cfg.ApprovalPolicy)
	}
}

func TestLoadConfigFromEnvSupportsCapabilitiesJSON(t *testing.T) {
	t.Setenv("PRISMER_DAEMON_DID", "did:key:test")
	t.Setenv("PRISMER_ORCH_WS_URL", "ws://localhost:8080/ws/runtime")
	t.Setenv("PRISMER_DAEMON_CAPABILITIES_JSON", `[{"key":"claude-code","version":"1.2.3","path":"/usr/local/bin/claude"}]`)
	t.Setenv("PRISMER_DAEMON_CAPABILITIES", "")
	t.Setenv("PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS", "5000")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() error = %v", err)
	}
	if len(cfg.WS.Capabilities) != 1 || cfg.WS.Capabilities[0].Key != "claude-code" {
		t.Fatalf("unexpected capabilities: %+v", cfg.WS.Capabilities)
	}
	if cfg.WS.HeartbeatInterval != 5*time.Second {
		t.Fatalf("unexpected heartbeat interval: %s", cfg.WS.HeartbeatInterval)
	}
}

func TestLoadConfigFromEnvRequiresFields(t *testing.T) {
	t.Setenv("PRISMER_DAEMON_DID", "")
	t.Setenv("PRISMER_ORCH_WS_URL", "")

	if _, err := LoadConfigFromEnv(); err == nil {
		t.Fatal("expected config error")
	}
}

func TestLoadConfigFromEnvParsesSigningConfig(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	t.Setenv("PRISMER_DAEMON_DID", "did:key:test")
	t.Setenv("PRISMER_ORCH_WS_URL", "ws://localhost:8080/ws/runtime")
	t.Setenv("PRISMER_DAEMON_KEY_ID", "did:key:test#k1")
	t.Setenv("PRISMER_DAEMON_SIGNING_PRIVATE_KEY", base64.RawURLEncoding.EncodeToString(privateKey))

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() error = %v", err)
	}
	if cfg.WS.SigningKeyID != "did:key:test#k1" || len(cfg.WS.SigningPrivateKey) != ed25519.PrivateKeySize {
		t.Fatalf("unexpected signing config: %+v", cfg.WS)
	}
}

func TestLoadConfigFromEnvParsesApprovalPolicy(t *testing.T) {
	t.Setenv("PRISMER_DAEMON_DID", "did:key:test")
	t.Setenv("PRISMER_ORCH_WS_URL", "ws://localhost:8080/ws/runtime")
	t.Setenv("PRISMER_DAEMON_APPROVAL_ENFORCE", "true")
	t.Setenv("PRISMER_DAEMON_APPROVAL_DANGEROUS_ACTIONS", "git_push_force,terraform_apply")
	t.Setenv("PRISMER_DAEMON_APPROVAL_BUDGET_THRESHOLD", "2500")

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		t.Fatalf("LoadConfigFromEnv() error = %v", err)
	}
	if !cfg.ApprovalPolicy.Enforce {
		t.Fatalf("expected approval policy enabled, got %+v", cfg.ApprovalPolicy)
	}
	if _, ok := cfg.ApprovalPolicy.DangerousActions["terraform_apply"]; !ok {
		t.Fatalf("expected terraform_apply in dangerous actions, got %+v", cfg.ApprovalPolicy.DangerousActions)
	}
	if cfg.ApprovalPolicy.TaskCreateBudgetOver != 2500 {
		t.Fatalf("unexpected approval budget threshold: %+v", cfg.ApprovalPolicy)
	}
}
