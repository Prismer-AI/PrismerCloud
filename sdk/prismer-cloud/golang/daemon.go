package prismer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	toml "github.com/pelletier/go-toml/v2"
)

const (
	MaxOutboxSize = 500
	SyncInterval  = 60 * time.Second
	FlushInterval = 30 * time.Second
	APITimeout    = 10 * time.Second
	MaxEvents     = 1000
)

// daemonConfig holds API key and base URL for the daemon process.
type daemonConfig struct {
	APIKey  string
	BaseURL string
}

func prismerDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".prismer")
}

func daemonConfigPath() string  { return filepath.Join(prismerDir(), "config.toml") }
func daemonPIDPath() string     { return filepath.Join(prismerDir(), "daemon.pid") }
func daemonPortPath() string    { return filepath.Join(prismerDir(), "daemon.port") }
func daemonCacheDir() string    { return filepath.Join(prismerDir(), "cache") }
func evolutionCachePath() string { return filepath.Join(daemonCacheDir(), "evolution.json") }
func outboxPath() string        { return filepath.Join(daemonCacheDir(), "outbox.json") }
func eventsPath() string        { return filepath.Join(daemonCacheDir(), "events.json") }

func ensureDaemonCacheDir() {
	_ = os.MkdirAll(daemonCacheDir(), 0o700)
}

// loadDaemonConfig reads config.toml and returns the daemon config.
// Env vars PRISMER_API_KEY and PRISMER_BASE_URL override file values.
func loadDaemonConfig() *daemonConfig {
	type tomlFile struct {
		Default struct {
			APIKey  string `toml:"api_key"`
			BaseURL string `toml:"base_url"`
		} `toml:"default"`
	}

	var cfg tomlFile
	data, err := os.ReadFile(daemonConfigPath())
	if err == nil {
		_ = toml.Unmarshal(data, &cfg)
	}

	apiKey := cfg.Default.APIKey
	baseURL := cfg.Default.BaseURL
	if baseURL == "" {
		baseURL = "https://prismer.cloud"
	}

	if env := os.Getenv("PRISMER_API_KEY"); env != "" {
		apiKey = env
	}
	if env := os.Getenv("PRISMER_BASE_URL"); env != "" {
		baseURL = env
	}

	if apiKey == "" {
		return nil
	}
	return &daemonConfig{APIKey: apiKey, BaseURL: baseURL}
}

// AppendToOutbox appends an evolution outcome entry to the local outbox file.
// External callers (hooks, plugins) use this to queue outcomes for the daemon.
// Capped at MaxOutboxSize entries; oldest entries are dropped when full.
func AppendToOutbox(entry map[string]interface{}) {
	ensureDaemonCacheDir()

	var entries []map[string]interface{}
	data, err := os.ReadFile(outboxPath())
	if err == nil {
		_ = json.Unmarshal(data, &entries)
	}

	entry["_queuedAt"] = time.Now().UnixMilli()
	entries = append(entries, entry)

	if len(entries) > MaxOutboxSize {
		entries = entries[len(entries)-MaxOutboxSize:]
	}

	out, _ := json.MarshalIndent(entries, "", "  ")
	_ = os.WriteFile(outboxPath(), out, 0o600)
}

// DaemonEvent represents a daemon event for the event log.
type DaemonEvent struct {
	Type      string `json:"type"`
	Source    string `json:"source"`
	Priority  string `json:"priority"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Timestamp int64  `json:"timestamp"`
	ActionURL string `json:"actionUrl,omitempty"`
}

func loadEvents() []DaemonEvent {
	data, err := os.ReadFile(eventsPath())
	if err != nil {
		return nil
	}
	var events []DaemonEvent
	_ = json.Unmarshal(data, &events)
	return events
}

func appendEvent(event DaemonEvent) {
	events := loadEvents()
	events = append(events, event)
	if len(events) > MaxEvents {
		events = events[len(events)-MaxEvents:]
	}
	out, _ := json.Marshal(events)
	_ = os.WriteFile(eventsPath(), out, 0o600)
}

func emitSyncEvent(genesCount int) {
	if genesCount > 0 {
		appendEvent(DaemonEvent{
			Type:      "evolution.sync",
			Source:    "evolution",
			Priority:  "low",
			Title:     "Evolution sync complete",
			Body:      fmt.Sprintf("%d genes updated", genesCount),
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func readDaemonPID() int {
	data, err := os.ReadFile(daemonPIDPath())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return pid
}

func readDaemonPort() int {
	data, err := os.ReadFile(daemonPortPath())
	if err != nil {
		return 0
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return port
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func writeDaemonPID(pid int) {
	_ = os.MkdirAll(prismerDir(), 0o700)
	_ = os.WriteFile(daemonPIDPath(), []byte(strconv.Itoa(pid)), 0o600)
}

func writeDaemonPort(port int) {
	_ = os.MkdirAll(prismerDir(), 0o700)
	_ = os.WriteFile(daemonPortPath(), []byte(strconv.Itoa(port)), 0o600)
}

func cleanupDaemonPIDFiles() {
	_ = os.Remove(daemonPIDPath())
	_ = os.Remove(daemonPortPath())
}

func httpPostJSON(url, authToken string, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), APITimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+authToken)
	return http.DefaultClient.Do(req)
}

// RunDaemonProcess runs the daemon in the current process. Exported so the CLI
// can call it when PRISMER_DAEMON=1.
func RunDaemonProcess() {
	cfg := loadDaemonConfig()
	if cfg == nil {
		fmt.Fprintf(os.Stderr, "[prismer-daemon] No config found. Run \"prismer setup\" first.\n")
		os.Exit(1)
	}

	ensureDaemonCacheDir()

	var mu sync.Mutex
	startTime := time.Now()
	lastSync := int64(0)
	syncCount := 0
	evolutionCursor := int64(0)

	// Load persisted cursor
	if data, err := os.ReadFile(evolutionCachePath()); err == nil {
		var cached map[string]interface{}
		if json.Unmarshal(data, &cached) == nil {
			if c, ok := cached["cursor"]; ok {
				evolutionCursor = toInt64(c)
			}
		}
	}

	// Health HTTP server on random port
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		outboxSize := 0
		if data, err := os.ReadFile(outboxPath()); err == nil {
			var entries []interface{}
			if json.Unmarshal(data, &entries) == nil {
				outboxSize = len(entries)
			}
		}
		resp := map[string]interface{}{
			"pid":        os.Getpid(),
			"uptime":     int(time.Since(startTime).Seconds()),
			"lastSync":   lastSync,
			"syncCount":  syncCount,
			"outboxSize": outboxSize,
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.NotFound(w, r)
			return
		}
		events := loadEvents()
		if len(events) > 50 {
			events = events[len(events)-50:]
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(events)
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[prismer-daemon] Failed to listen: %v\n", err)
		os.Exit(1)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: mux}

	writeDaemonPID(os.Getpid())
	writeDaemonPort(port)
	fmt.Printf("[prismer-daemon] Started. PID=%d port=%d\n", os.Getpid(), port)

	go server.Serve(listener)

	// Cancellation context for goroutines
	ctx, cancel := context.WithCancel(context.Background())

	// Evolution sync
	doEvolutionSync := func() {
		body := map[string]interface{}{
			"pull": map[string]interface{}{
				"since": evolutionCursor,
				"scope": "global",
			},
		}
		resp, err := httpPostJSON(cfg.BaseURL+"/api/im/evolution/sync", cfg.APIKey, body)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return
		}
		respData, err := io.ReadAll(resp.Body)
		if err != nil {
			return
		}
		var parsed map[string]interface{}
		if json.Unmarshal(respData, &parsed) != nil {
			return
		}

		mu.Lock()
		lastSync = time.Now().UnixMilli()
		syncCount++
		mu.Unlock()

		// Advance cursor
		if data, ok := parsed["data"].(map[string]interface{}); ok {
			if c, ok := data["cursor"]; ok {
				evolutionCursor = toInt64(c)
			}
		} else if c, ok := parsed["cursor"]; ok {
			evolutionCursor = toInt64(c)
		}

		pulled := parsed["data"]
		if pulled == nil {
			pulled = parsed
		}

		ensureDaemonCacheDir()
		cacheData := map[string]interface{}{
			"cursor":   evolutionCursor,
			"lastSync": lastSync,
			"data":     pulled,
		}
		out, _ := json.MarshalIndent(cacheData, "", "  ")
		_ = os.WriteFile(evolutionCachePath(), out, 0o600)

		if pulledMap, ok := pulled.(map[string]interface{}); ok {
			if genes, ok := pulledMap["genes"].([]interface{}); ok {
				emitSyncEvent(len(genes))
			}
		}
	}

	// Outbox flush
	doOutboxFlush := func() {
		data, err := os.ReadFile(outboxPath())
		if err != nil {
			return
		}
		var entries []interface{}
		if json.Unmarshal(data, &entries) != nil || len(entries) == 0 {
			return
		}

		body := map[string]interface{}{
			"push": map[string]interface{}{"outcomes": entries},
			"pull": map[string]interface{}{"since": 0},
		}
		resp, err := httpPostJSON(cfg.BaseURL+"/api/im/evolution/sync", cfg.APIKey, body)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			_ = os.WriteFile(outboxPath(), []byte("[]"), 0o600)
		}
	}

	// Initial syncs
	doEvolutionSync()
	doOutboxFlush()

	// Recurring sync goroutine
	go func() {
		ticker := time.NewTicker(SyncInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				doEvolutionSync()
			}
		}
	}()

	// Recurring flush goroutine
	go func() {
		ticker := time.NewTicker(FlushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				doOutboxFlush()
			}
		}
	}()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("[prismer-daemon] Shutting down.")
	cancel()
	cleanupDaemonPIDFiles()
	server.Close()
}

// StartDaemon starts the daemon as a detached background process.
// If already running, prints the existing PID.
func StartDaemon() {
	pid := readDaemonPID()
	if pid > 0 && isProcessAlive(pid) {
		port := readDaemonPort()
		msg := fmt.Sprintf("Daemon already running. PID=%d", pid)
		if port > 0 {
			msg += fmt.Sprintf(" port=%d", port)
		}
		fmt.Println(msg)
		return
	}

	cleanupDaemonPIDFiles()

	cfg := loadDaemonConfig()
	if cfg == nil {
		fmt.Fprintln(os.Stderr, "No API key found. Run \"prismer setup\" first.")
		os.Exit(1)
	}

	if os.Getenv("PRISMER_DAEMON") == "1" {
		RunDaemonProcess()
		return
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot determine executable path: %v\n", err)
		os.Exit(1)
	}

	cmd := exec.Command(exe, "daemon", "start")
	cmd.Env = append(os.Environ(), "PRISMER_DAEMON=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start daemon: %v\n", err)
		os.Exit(1)
	}
	cmd.Process.Release()

	// Wait for PID and port files
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		pid := readDaemonPID()
		port := readDaemonPort()
		if pid > 0 && port > 0 {
			fmt.Printf("Daemon started. PID=%d port=%d\n", pid, port)
			return
		}
	}

	fmt.Println("Daemon spawned (PID file not yet written — may take a moment).")
}

// StopDaemon stops the running daemon by sending SIGTERM.
func StopDaemon() {
	pid := readDaemonPID()
	if pid <= 0 || !isProcessAlive(pid) {
		fmt.Println("Daemon: not running")
		cleanupDaemonPIDFiles()
		return
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to stop daemon: %v\n", err)
		return
	}
	fmt.Printf("Daemon stopped (PID=%d)\n", pid)
	cleanupDaemonPIDFiles()
}

// DaemonStatus prints the current daemon status. If running, queries the health endpoint.
func DaemonStatus() {
	pid := readDaemonPID()
	if pid <= 0 || !isProcessAlive(pid) {
		fmt.Println("Daemon: not running")
		cleanupDaemonPIDFiles()
		return
	}

	port := readDaemonPort()
	if port <= 0 {
		fmt.Printf("Daemon: running (PID=%d, port unknown)\n", pid)
		return
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		fmt.Printf("Daemon: running (PID=%d port=%d, health check failed)\n", pid, port)
		return
	}
	defer resp.Body.Close()

	var health struct {
		PID        int   `json:"pid"`
		Uptime     int   `json:"uptime"`
		LastSync   int64 `json:"lastSync"`
		SyncCount  int   `json:"syncCount"`
		OutboxSize int   `json:"outboxSize"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		fmt.Printf("Daemon: running (PID=%d port=%d)\n", pid, port)
		return
	}

	lastSyncStr := "never"
	if health.LastSync > 0 {
		lastSyncStr = time.UnixMilli(health.LastSync).UTC().Format(time.RFC3339)
	}

	fmt.Println("Daemon: running")
	fmt.Printf("  PID:        %d\n", health.PID)
	fmt.Printf("  Uptime:     %ds\n", health.Uptime)
	fmt.Printf("  Last sync:  %s\n", lastSyncStr)
	fmt.Printf("  Sync count: %d\n", health.SyncCount)
	fmt.Printf("  Outbox:     %d entries\n", health.OutboxSize)
	fmt.Printf("  Port:       %d\n", port)
}

// InstallDaemonService installs the daemon as a persistent system service.
// macOS: launchd plist. Linux: systemd user unit.
func InstallDaemonService() {
	switch runtime.GOOS {
	case "darwin":
		installLaunchd()
	case "linux":
		installSystemd()
	default:
		fmt.Printf("Daemon auto-start not supported on %s. Use: prismer daemon start\n", runtime.GOOS)
	}
}

// UninstallDaemonService removes the daemon system service.
func UninstallDaemonService() {
	switch runtime.GOOS {
	case "darwin":
		uninstallLaunchd()
	case "linux":
		uninstallSystemd()
	default:
		fmt.Printf("No daemon service to uninstall on %s.\n", runtime.GOOS)
	}
}

func installLaunchd() {
	home, _ := os.UserHomeDir()
	plistDir := filepath.Join(home, "Library", "LaunchAgents")
	plistPath := filepath.Join(plistDir, "cloud.prismer.daemon.plist")

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot determine executable path: %v\n", err)
		return
	}

	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.prismer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRISMER_DAEMON</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>`, exe,
		filepath.Join(home, ".prismer", "daemon.stdout.log"),
		filepath.Join(home, ".prismer", "daemon.stderr.log"))

	_ = os.MkdirAll(plistDir, 0o755)
	if err := os.WriteFile(plistPath, []byte(plist), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write plist: %v\n", err)
		return
	}

	cmd := exec.Command("launchctl", "load", plistPath)
	if err := cmd.Run(); err != nil {
		fmt.Printf("[prismer] Plist written. Load manually: launchctl load %s\n", plistPath)
		return
	}
	fmt.Println("[prismer] Daemon service installed and started (launchd)")
	fmt.Printf("  Plist: %s\n", plistPath)
}

func uninstallLaunchd() {
	home, _ := os.UserHomeDir()
	plistPath := filepath.Join(home, "Library", "LaunchAgents", "cloud.prismer.daemon.plist")
	cmd := exec.Command("launchctl", "unload", plistPath)
	_ = cmd.Run()
	_ = os.Remove(plistPath)
	fmt.Println("[prismer] Daemon service uninstalled (launchd)")
}

func installSystemd() {
	home, _ := os.UserHomeDir()
	serviceDir := filepath.Join(home, ".config", "systemd", "user")
	servicePath := filepath.Join(serviceDir, "prismer-daemon.service")

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot determine executable path: %v\n", err)
		return
	}

	unit := fmt.Sprintf(`[Unit]
Description=Prismer Daemon — background evolution sync
After=network-online.target

[Service]
Type=simple
Environment=PRISMER_DAEMON=1
ExecStart=%s daemon start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`, exe)

	_ = os.MkdirAll(serviceDir, 0o755)
	if err := os.WriteFile(servicePath, []byte(unit), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write service file: %v\n", err)
		return
	}

	reload := exec.Command("systemctl", "--user", "daemon-reload")
	_ = reload.Run()
	enable := exec.Command("systemctl", "--user", "enable", "prismer-daemon")
	_ = enable.Run()
	start := exec.Command("systemctl", "--user", "start", "prismer-daemon")
	if err := start.Run(); err != nil {
		fmt.Println("[prismer] Service file written. Enable manually:")
		fmt.Println("  systemctl --user enable --now prismer-daemon")
		return
	}
	fmt.Println("[prismer] Daemon service installed and started (systemd)")
	fmt.Printf("  Service: %s\n", servicePath)
}

func uninstallSystemd() {
	home, _ := os.UserHomeDir()
	servicePath := filepath.Join(home, ".config", "systemd", "user", "prismer-daemon.service")

	stop := exec.Command("systemctl", "--user", "stop", "prismer-daemon")
	_ = stop.Run()
	disable := exec.Command("systemctl", "--user", "disable", "prismer-daemon")
	_ = disable.Run()
	_ = os.Remove(servicePath)
	reload := exec.Command("systemctl", "--user", "daemon-reload")
	_ = reload.Run()
	fmt.Println("[prismer] Daemon service uninstalled (systemd)")
}
