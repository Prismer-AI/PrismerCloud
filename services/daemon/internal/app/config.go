package app

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/approval"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/ws"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func LoadConfigFromEnv() (Config, error) {
	localDaemonConfig := loadLocalDaemonConfig()

	runtimeDID := envOrConfig("PRISMER_DAEMON_DID", localDaemonConfig, "runtime_did")
	if runtimeDID == "" {
		return Config{}, fmt.Errorf("PRISMER_DAEMON_DID required")
	}

	wsURL := envOrConfig("PRISMER_ORCH_WS_URL", localDaemonConfig, "orchestrator_ws_url")
	if wsURL == "" {
		return Config{}, fmt.Errorf("PRISMER_ORCH_WS_URL required")
	}

	sessionID := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_SESSION_ID"))
	if sessionID == "" {
		sessionID = fmt.Sprintf("sess_%d", time.Now().UnixNano())
	}

	version := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_VERSION"))
	if version == "" {
		version = "0.1.0"
	}

	heartbeatInterval, err := loadHeartbeatInterval()
	if err != nil {
		return Config{}, err
	}
	capabilities, err := loadCapabilities()
	if err != nil {
		return Config{}, err
	}
	approvalPolicy, err := loadApprovalPolicy()
	if err != nil {
		return Config{}, err
	}
	signingPrivateKey, signingKeyID, err := loadSigningConfig(localDaemonConfig)
	if err != nil {
		return Config{}, err
	}

	hostname := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_HOSTNAME"))
	if hostname == "" {
		systemHostname, err := os.Hostname()
		if err == nil {
			hostname = systemHostname
		}
	}

	userAgent := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_USER_AGENT"))
	if userAgent == "" {
		userAgent = "prismer-daemon/" + version
	}

	return Config{
		ApprovalPolicy: approvalPolicy,
		WS: ws.Config{
			URL:               wsURL,
			RuntimeDID:        runtimeDID,
			SessionID:         sessionID,
			Version:           version,
			AgentJoinToken:    strings.TrimSpace(os.Getenv("PRISMER_DAEMON_AGENT_JOIN_TOKEN")),
			SigningKeyID:      signingKeyID,
			SigningPrivateKey: signingPrivateKey,
			Host: proto.RuntimeHelloHost{
				Hostname:        hostname,
				OS:              envOrDefault("PRISMER_DAEMON_OS", runtime.GOOS),
				Arch:            envOrDefault("PRISMER_DAEMON_ARCH", runtime.GOARCH),
				PlatformVersion: strings.TrimSpace(os.Getenv("PRISMER_DAEMON_PLATFORM_VERSION")),
			},
			Capabilities:      capabilities,
			HeartbeatInterval: heartbeatInterval,
			UserAgent:         userAgent,
		},
	}, nil
}

func loadApprovalPolicy() (approval.Policy, error) {
	enabled := strings.EqualFold(strings.TrimSpace(os.Getenv("PRISMER_DAEMON_APPROVAL_ENFORCE")), "true")
	threshold, err := loadApprovalBudgetThreshold()
	if err != nil {
		return approval.Policy{}, err
	}
	return approval.Policy{
		Enforce:              enabled,
		DangerousActions:     loadDangerousActions(),
		TaskCreateBudgetOver: threshold,
	}, nil
}

func loadHeartbeatInterval() (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS"))
	if raw == "" {
		return 20 * time.Second, nil
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		return 0, fmt.Errorf("invalid PRISMER_DAEMON_HEARTBEAT_INTERVAL_MS: %s", raw)
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func loadCapabilities() ([]proto.RuntimeCapability, error) {
	rawJSON := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_CAPABILITIES_JSON"))
	if rawJSON != "" {
		var capabilities []proto.RuntimeCapability
		if err := json.Unmarshal([]byte(rawJSON), &capabilities); err != nil {
			return nil, fmt.Errorf("parse PRISMER_DAEMON_CAPABILITIES_JSON: %w", err)
		}
		return capabilities, nil
	}

	raw := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_CAPABILITIES"))
	if raw == "" {
		return nil, nil
	}

	entries := strings.Split(raw, ",")
	capabilities := make([]proto.RuntimeCapability, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		capability, err := parseCapabilityEntry(entry)
		if err != nil {
			return nil, err
		}
		capabilities = append(capabilities, capability)
	}
	return capabilities, nil
}

func loadApprovalBudgetThreshold() (float64, error) {
	raw := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_APPROVAL_BUDGET_THRESHOLD"))
	if raw == "" {
		return 1000, nil
	}
	threshold, err := strconv.ParseFloat(raw, 64)
	if err != nil || threshold < 0 {
		return 0, fmt.Errorf("invalid PRISMER_DAEMON_APPROVAL_BUDGET_THRESHOLD: %s", raw)
	}
	return threshold, nil
}

func loadDangerousActions() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv("PRISMER_DAEMON_APPROVAL_DANGEROUS_ACTIONS"))
	if raw == "" {
		raw = "git_push_force,rm_rf"
	}
	entries := strings.Split(raw, ",")
	actions := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(strings.ToLower(entry))
		if entry == "" {
			continue
		}
		actions[entry] = struct{}{}
	}
	return actions
}

func loadSigningConfig(localDaemonConfig map[string]string) (ed25519.PrivateKey, string, error) {
	rawPrivateKey := envOrConfig("PRISMER_DAEMON_SIGNING_PRIVATE_KEY", localDaemonConfig, "signing_private_key")
	keyID := envOrConfig("PRISMER_DAEMON_KEY_ID", localDaemonConfig, "key_id")
	if rawPrivateKey == "" && keyID == "" {
		return nil, "", nil
	}
	if rawPrivateKey == "" || keyID == "" {
		return nil, "", fmt.Errorf("PRISMER_DAEMON_SIGNING_PRIVATE_KEY and PRISMER_DAEMON_KEY_ID must be set together")
	}
	decoded, err := proto.DecodeBase64Any(rawPrivateKey)
	if err != nil {
		return nil, "", fmt.Errorf("decode PRISMER_DAEMON_SIGNING_PRIVATE_KEY: %w", err)
	}
	if len(decoded) != ed25519.PrivateKeySize {
		return nil, "", fmt.Errorf("invalid PRISMER_DAEMON_SIGNING_PRIVATE_KEY length: got %d", len(decoded))
	}
	return ed25519.PrivateKey(decoded), keyID, nil
}

func parseCapabilityEntry(entry string) (proto.RuntimeCapability, error) {
	var capability proto.RuntimeCapability

	pathSplit := strings.SplitN(entry, "=", 2)
	left := strings.TrimSpace(pathSplit[0])
	if len(pathSplit) == 2 {
		capability.Path = strings.TrimSpace(pathSplit[1])
	}

	versionSplit := strings.SplitN(left, "@", 2)
	capability.Key = strings.TrimSpace(versionSplit[0])
	if capability.Key == "" {
		return proto.RuntimeCapability{}, fmt.Errorf("invalid capability entry: %q", entry)
	}
	if len(versionSplit) == 2 {
		capability.Version = strings.TrimSpace(versionSplit[1])
	}

	return capability, nil
}

func envOrDefault(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envOrConfig(envKey string, localConfig map[string]string, configKey string) string {
	if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
		return value
	}
	return strings.TrimSpace(localConfig[configKey])
}

func loadLocalDaemonConfig() map[string]string {
	path := strings.TrimSpace(os.Getenv("PRISMER_CONFIG_PATH"))
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return nil
		}
		path = home + "/.prismer/config.toml"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return parseTOMLSection(string(data), "daemon")
}

func parseTOMLSection(raw string, section string) map[string]string {
	values := make(map[string]string)
	current := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			current = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			continue
		}
		if current != section {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		if unquoted, err := strconv.Unquote(value); err == nil {
			value = unquoted
		}
		values[key] = value
	}
	return values
}
