//! Prismer Daemon — background process for persistent evolution sync.
//!
//! Provides:
//!   start_daemon()           — fork a detached daemon process, write PID/port files
//!   stop_daemon()            — read daemon.pid, send SIGTERM
//!   daemon_status()          — check if daemon is running, print health info
//!   append_to_outbox()       — append an outcome entry to the local outbox file (cap 500)
//!   install_daemon_service() — install launchd/systemd service
//!   uninstall_daemon_service() — remove service
//!   daemon_main()            — entry point when spawned with PRISMER_DAEMON=1

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

// ============================================================================
// Constants
// ============================================================================

const MAX_OUTBOX_SIZE: usize = 500;
const SYNC_INTERVAL: Duration = Duration::from_secs(60);
const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const API_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EVENTS: usize = 1000;

// ============================================================================
// Paths
// ============================================================================

fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prismer")
}

fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

fn pid_path() -> PathBuf {
    config_dir().join("daemon.pid")
}

fn port_path() -> PathBuf {
    config_dir().join("daemon.port")
}

fn cache_dir() -> PathBuf {
    config_dir().join("cache")
}

fn evolution_cache_path() -> PathBuf {
    cache_dir().join("evolution.json")
}

fn outbox_path() -> PathBuf {
    cache_dir().join("outbox.json")
}

fn events_path() -> PathBuf {
    cache_dir().join("events.json")
}

fn ensure_cache_dir() {
    let dir = cache_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).ok();
    }
}

fn ensure_config_dir() {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).ok();
    }
}

// ============================================================================
// Config
// ============================================================================

struct DaemonConfig {
    api_key: String,
    base_url: String,
}

fn load_config() -> Option<DaemonConfig> {
    let path = config_path();
    let raw = fs::read_to_string(&path).ok()?;
    let table: toml::Table = raw.parse().ok()?;
    let default = table.get("default")?.as_table()?;
    let api_key = default.get("api_key")?.as_str()?.to_string();
    if api_key.is_empty() {
        return None;
    }
    let base_url = default
        .get("base_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://prismer.cloud")
        .to_string();

    // Env overrides
    let api_key = std::env::var("PRISMER_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(api_key);
    let base_url = std::env::var("PRISMER_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(base_url);

    Some(DaemonConfig { api_key, base_url })
}

// ============================================================================
// File helpers
// ============================================================================

fn write_file_0600(path: &PathBuf, content: &str) {
    fs::write(path, content).ok();
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok();
    }
}

fn read_pid() -> Option<u32> {
    let raw = fs::read_to_string(pid_path()).ok()?;
    raw.trim().parse().ok()
}

fn read_port() -> Option<u16> {
    let raw = fs::read_to_string(port_path()).ok()?;
    raw.trim().parse().ok()
}

fn write_pid(pid: u32) {
    ensure_config_dir();
    write_file_0600(&pid_path(), &pid.to_string());
}

fn write_port(port: u16) {
    ensure_config_dir();
    write_file_0600(&port_path(), &port.to_string());
}

fn cleanup_pid_files() {
    let _ = fs::remove_file(pid_path());
    let _ = fs::remove_file(port_path());
}

#[cfg(unix)]
fn is_process_running(pid: u32) -> bool {
    unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn is_process_running(_pid: u32) -> bool {
    false
}

// Minimal libc bindings to avoid adding the `libc` crate
#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    unsafe { kill(pid, sig) }
}

// ============================================================================
// Outbox (public, usable without daemon running)
// ============================================================================

/// Append an evolution outcome entry to the local outbox file.
/// External callers (hooks, plugins) use this to queue outcomes for the daemon.
/// Capped at MAX_OUTBOX_SIZE entries; oldest entries are dropped when full.
pub fn append_to_outbox(entry: Value) {
    ensure_cache_dir();
    let path = outbox_path();
    let mut entries: Vec<Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let mut obj = match entry {
        Value::Object(m) => m,
        other => {
            let mut m = serde_json::Map::new();
            m.insert("value".to_string(), other);
            m
        }
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    obj.insert("_queuedAt".to_string(), Value::Number(now.into()));
    entries.push(Value::Object(obj));

    if entries.len() > MAX_OUTBOX_SIZE {
        entries = entries.split_off(entries.len() - MAX_OUTBOX_SIZE);
    }
    let json = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string());
    write_file_0600(&path, &json);
}

// ============================================================================
// Event routing
// ============================================================================

fn load_events() -> Vec<Value> {
    fs::read_to_string(events_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn append_event(event: Value) {
    let mut events = load_events();
    events.push(event);
    if events.len() > MAX_EVENTS {
        events = events.split_off(events.len() - MAX_EVENTS);
    }
    let json = serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string());
    write_file_0600(&events_path(), &json);
}

fn emit_sync_event(genes_count: u64) {
    if genes_count > 0 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        append_event(serde_json::json!({
            "type": "evolution.sync",
            "source": "evolution",
            "priority": "low",
            "title": "Evolution sync complete",
            "body": format!("{} genes updated", genes_count),
            "timestamp": now,
        }));
    }
}

// ============================================================================
// Raw HTTP helpers (no reqwest blocking — avoid adding features)
// ============================================================================

/// Simple blocking HTTP GET via TcpStream (HTTP/1.1, no TLS).
/// Only used for 127.0.0.1 health checks. Returns response body on success.
fn http_get_local(port: u16, path: &str) -> Option<String> {
    let mut stream =
        TcpStream::connect_timeout(&format!("127.0.0.1:{}", port).parse().ok()?, Duration::from_secs(3))
            .ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", path, port);
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    // Extract body after \r\n\r\n
    buf.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}

/// Blocking HTTP POST to a remote server using reqwest (async via a temporary runtime).
/// We use this for evolution sync because the server uses HTTPS.
fn http_post_blocking(url: &str, body: &str, api_key: &str) -> Option<String> {
    // Build a minimal tokio runtime just for this call
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(API_TIMEOUT)
            .build()
            .ok()?;
        let resp = client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .body(body.to_string())
            .send()
            .await
            .ok()?;
        if resp.status().is_success() {
            resp.text().await.ok()
        } else {
            None
        }
    })
}

// ============================================================================
// Daemon process
// ============================================================================

fn run_daemon_process() {
    let cfg = match load_config() {
        Some(c) => c,
        None => {
            eprintln!("[prismer-daemon] No config found. Run \"prismer setup\" first.");
            std::process::exit(1);
        }
    };

    ensure_cache_dir();

    // Shared state
    let shutdown = Arc::new(AtomicBool::new(false));
    let start_time = Instant::now();

    // Load persisted cursor
    let mut evolution_cursor: u64 = 0;
    if let Ok(raw) = fs::read_to_string(evolution_cache_path()) {
        if let Ok(cached) = serde_json::from_str::<Value>(&raw) {
            if let Some(c) = cached.get("cursor").and_then(|v| v.as_u64()) {
                evolution_cursor = c;
            }
        }
    }

    // Mutable sync state protected by simple atomics/mutex for the health endpoint
    let last_sync = Arc::new(std::sync::Mutex::new(0u64));
    let sync_count = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // ── Health HTTP server ──
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind health server");
    let local_port = listener.local_addr().expect("No local addr").port();

    let pid = std::process::id();
    write_pid(pid);
    write_port(local_port);
    eprintln!("[prismer-daemon] Started. PID={} port={}", pid, local_port);

    // Register shutdown on SIGINT/SIGTERM
    let shutdown_flag = shutdown.clone();
    #[cfg(unix)]
    {
        // Set up a self-pipe trick: write to a static flag on signal
        static SIGNAL_RECEIVED: AtomicBool = AtomicBool::new(false);

        extern "C" fn signal_handler(_sig: i32) {
            SIGNAL_RECEIVED.store(true, Ordering::SeqCst);
        }

        unsafe {
            signal(2, signal_handler as usize);  // SIGINT
            signal(15, signal_handler as usize); // SIGTERM
        }

        // Thread that watches the static flag
        let sf = shutdown_flag.clone();
        thread::spawn(move || {
            loop {
                if SIGNAL_RECEIVED.load(Ordering::SeqCst) {
                    sf.store(true, Ordering::SeqCst);
                    // Connect to our own listener to unblock accept()
                    TcpStream::connect(format!("127.0.0.1:{}", local_port)).ok();
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
    }

    // ── Evolution sync thread ──
    let shutdown_sync = shutdown.clone();
    let last_sync_sync = last_sync.clone();
    let sync_count_sync = sync_count.clone();
    let api_key = cfg.api_key.clone();
    let base_url = cfg.base_url.clone();
    let sync_handle = thread::spawn(move || {
        let mut cursor = evolution_cursor;
        // Initial sync
        if let Some(new_cursor) = do_evolution_sync(&base_url, &api_key, cursor, &last_sync_sync, &sync_count_sync) {
            cursor = new_cursor;
        }

        while !shutdown_sync.load(Ordering::SeqCst) {
            thread::sleep(SYNC_INTERVAL);
            if shutdown_sync.load(Ordering::SeqCst) {
                break;
            }
            if let Some(new_cursor) = do_evolution_sync(&base_url, &api_key, cursor, &last_sync_sync, &sync_count_sync) {
                cursor = new_cursor;
            }
        }
    });

    // ── Outbox flush thread ──
    let shutdown_flush = shutdown.clone();
    let api_key_flush = cfg.api_key.clone();
    let base_url_flush = cfg.base_url.clone();
    let flush_handle = thread::spawn(move || {
        // Initial flush
        do_outbox_flush(&base_url_flush, &api_key_flush);

        while !shutdown_flush.load(Ordering::SeqCst) {
            thread::sleep(FLUSH_INTERVAL);
            if shutdown_flush.load(Ordering::SeqCst) {
                break;
            }
            do_outbox_flush(&base_url_flush, &api_key_flush);
        }
    });

    // ── HTTP server loop (main thread) ──
    listener.set_nonblocking(false).ok();
    // Set a timeout so we can check shutdown periodically
    // On most platforms, accept() doesn't support timeout directly,
    // so we use a short non-blocking check pattern.
    listener.set_nonblocking(true).ok();

    let last_sync_http = last_sync.clone();
    let sync_count_http = sync_count.clone();

    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                handle_http_request(
                    stream,
                    pid,
                    start_time,
                    &last_sync_http,
                    &sync_count_http,
                );
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    // Shutdown
    eprintln!("[prismer-daemon] Shutting down.");
    cleanup_pid_files();
    sync_handle.join().ok();
    flush_handle.join().ok();
}

fn handle_http_request(
    mut stream: TcpStream,
    pid: u32,
    start_time: Instant,
    last_sync: &std::sync::Mutex<u64>,
    sync_count: &std::sync::atomic::AtomicU64,
) {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();

    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let path = parts[1];

    // Drain remaining headers
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    if method == "GET" && path == "/health" {
        let uptime = start_time.elapsed().as_secs();
        let ls = *last_sync.lock().unwrap_or_else(|e| e.into_inner());
        let sc = sync_count.load(Ordering::SeqCst);
        let outbox_size = fs::read_to_string(outbox_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
            .map(|v| v.len())
            .unwrap_or(0);

        let body = serde_json::json!({
            "pid": pid,
            "uptime": uptime,
            "lastSync": ls,
            "syncCount": sc,
            "outboxSize": outbox_size,
        });
        let body_str = body.to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body_str.len(),
            body_str
        );
        stream.write_all(resp.as_bytes()).ok();
    } else if method == "GET" && path == "/events" {
        let events = load_events();
        let last_50: Vec<&Value> = events.iter().rev().take(50).collect::<Vec<_>>().into_iter().rev().collect();
        let body_str = serde_json::to_string(&last_50).unwrap_or_else(|_| "[]".to_string());
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body_str.len(),
            body_str
        );
        stream.write_all(resp.as_bytes()).ok();
    } else {
        let body = "Not found";
        let resp = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(resp.as_bytes()).ok();
    }
}

fn do_evolution_sync(
    base_url: &str,
    api_key: &str,
    cursor: u64,
    last_sync: &std::sync::Mutex<u64>,
    sync_count: &std::sync::atomic::AtomicU64,
) -> Option<u64> {
    let url = format!("{}/api/im/evolution/sync", base_url);
    let body = serde_json::json!({
        "pull": { "since": cursor, "scope": "global" }
    });
    let resp_text = http_post_blocking(&url, &body.to_string(), api_key)?;
    let data: Value = serde_json::from_str(&resp_text).ok()?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    *last_sync.lock().ok()? = now;
    sync_count.fetch_add(1, Ordering::SeqCst);

    let new_cursor = data
        .get("data")
        .and_then(|d| d.get("cursor"))
        .or_else(|| data.get("cursor"))
        .and_then(|v| v.as_u64())
        .unwrap_or(cursor);

    ensure_cache_dir();
    let pulled = data.get("data").unwrap_or(&data);
    let cache = serde_json::json!({
        "cursor": new_cursor,
        "lastSync": now,
        "data": pulled,
    });
    write_file_0600(
        &evolution_cache_path(),
        &serde_json::to_string_pretty(&cache).unwrap_or_default(),
    );

    let genes_count = pulled
        .get("genes")
        .and_then(|g| g.as_array())
        .map(|a| a.len() as u64)
        .unwrap_or(0);
    emit_sync_event(genes_count);

    Some(new_cursor)
}

fn do_outbox_flush(base_url: &str, api_key: &str) {
    let path = outbox_path();
    let entries: Vec<Value> = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => return,
    };
    if entries.is_empty() {
        return;
    }

    let url = format!("{}/api/im/evolution/sync", base_url);
    let body = serde_json::json!({
        "push": { "outcomes": entries },
        "pull": { "since": 0 },
    });
    if http_post_blocking(&url, &body.to_string(), api_key).is_some() {
        write_file_0600(&path, "[]");
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Start the daemon as a detached background process.
pub fn start_daemon() {
    // Check if PRISMER_DAEMON=1 — we are the child, run inline
    if std::env::var("PRISMER_DAEMON").as_deref() == Ok("1") {
        run_daemon_process();
        return;
    }

    if let Some(pid) = read_pid() {
        if is_process_running(pid) {
            let port = read_port();
            println!(
                "Daemon already running. PID={}{}",
                pid,
                port.map(|p| format!(" port={}", p)).unwrap_or_default()
            );
            return;
        }
    }

    // Stale PID file
    cleanup_pid_files();

    if load_config().is_none() {
        eprintln!("No API key found. Run \"prismer init <key>\" first.");
        std::process::exit(1);
    }

    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("prismer"));
    let child = Command::new(&exe)
        .args(["daemon", "start"])
        .env("PRISMER_DAEMON", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match child {
        Ok(_) => {
            // Wait for PID/port files
            for _ in 0..30 {
                thread::sleep(Duration::from_millis(100));
                if let (Some(pid), Some(port)) = (read_pid(), read_port()) {
                    println!("Daemon started. PID={} port={}", pid, port);
                    return;
                }
            }
            println!("Daemon spawned (PID file not yet written — may take a moment).");
        }
        Err(e) => {
            eprintln!("Failed to spawn daemon: {}", e);
            std::process::exit(1);
        }
    }
}

/// Stop the running daemon by sending SIGTERM.
pub fn stop_daemon() {
    let pid = match read_pid() {
        Some(p) if is_process_running(p) => p,
        _ => {
            println!("Daemon: not running");
            cleanup_pid_files();
            return;
        }
    };

    #[cfg(unix)]
    {
        let result = unsafe { libc_kill(pid as i32, 15) }; // SIGTERM = 15
        if result == 0 {
            println!("Daemon stopped (PID={})", pid);
        } else {
            eprintln!("Failed to stop daemon (PID={})", pid);
        }
    }

    #[cfg(not(unix))]
    {
        eprintln!("Stopping daemon not supported on this platform");
    }

    cleanup_pid_files();
}

/// Print daemon status. If running, query the health endpoint.
pub fn daemon_status() {
    let pid = match read_pid() {
        Some(p) if is_process_running(p) => p,
        _ => {
            println!("Daemon: not running");
            cleanup_pid_files();
            return;
        }
    };

    let port = match read_port() {
        Some(p) => p,
        None => {
            println!("Daemon: running (PID={}, port unknown)", pid);
            return;
        }
    };

    match http_get_local(port, "/health") {
        Some(body) => {
            if let Ok(health) = serde_json::from_str::<Value>(&body) {
                println!("Daemon: running");
                println!("  PID:        {}", health.get("pid").and_then(|v| v.as_u64()).unwrap_or(0));
                println!("  Uptime:     {}s", health.get("uptime").and_then(|v| v.as_u64()).unwrap_or(0));
                let ls = health.get("lastSync").and_then(|v| v.as_u64()).unwrap_or(0);
                if ls > 0 {
                    // Format as ISO-ish (just print millis for simplicity, matching TS output)
                    println!("  Last sync:  {}", ls);
                } else {
                    println!("  Last sync:  never");
                }
                println!("  Sync count: {}", health.get("syncCount").and_then(|v| v.as_u64()).unwrap_or(0));
                println!("  Outbox:     {} entries", health.get("outboxSize").and_then(|v| v.as_u64()).unwrap_or(0));
                println!("  Port:       {}", port);
            } else {
                println!("Daemon: running (PID={} port={})", pid, port);
            }
        }
        None => {
            println!("Daemon: running (PID={} port={}, health check failed)", pid, port);
        }
    }
}

// ============================================================================
// Service registration
// ============================================================================

/// Install the daemon as a persistent system service (launchd on macOS, systemd on Linux).
pub fn install_daemon_service() {
    #[cfg(target_os = "macos")]
    install_launchd();

    #[cfg(target_os = "linux")]
    install_systemd();

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        println!("Daemon auto-start not supported on this platform. Use: prismer daemon start");
    }
}

/// Uninstall the daemon system service.
pub fn uninstall_daemon_service() {
    #[cfg(target_os = "macos")]
    uninstall_launchd();

    #[cfg(target_os = "linux")]
    uninstall_systemd();

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        println!("No daemon service to uninstall on this platform.");
    }
}

#[cfg(target_os = "macos")]
fn install_launchd() {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let plist_dir = home.join("Library").join("LaunchAgents");
    let plist_path = plist_dir.join("cloud.prismer.daemon.plist");
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("prismer"))
        .display()
        .to_string();
    let log_dir = home.join(".prismer");

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.prismer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
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
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>"#,
        exe = exe,
        stdout = log_dir.join("daemon.stdout.log").display(),
        stderr = log_dir.join("daemon.stderr.log").display(),
    );

    fs::create_dir_all(&plist_dir).ok();
    write_file_0600(&plist_path, &plist);

    match Command::new("launchctl")
        .args(["load", &plist_path.display().to_string()])
        .output()
    {
        Ok(output) if output.status.success() => {
            println!("[prismer] Daemon service installed and started (launchd)");
            println!("  Plist: {}", plist_path.display());
        }
        _ => {
            println!(
                "[prismer] Plist written. Load manually: launchctl load {}",
                plist_path.display()
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn uninstall_launchd() {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let plist_path = home
        .join("Library")
        .join("LaunchAgents")
        .join("cloud.prismer.daemon.plist");
    Command::new("launchctl")
        .args(["unload", &plist_path.display().to_string()])
        .output()
        .ok();
    fs::remove_file(&plist_path).ok();
    println!("[prismer] Daemon service uninstalled (launchd)");
}

#[cfg(target_os = "linux")]
fn install_systemd() {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let service_dir = home.join(".config").join("systemd").join("user");
    let service_path = service_dir.join("prismer-daemon.service");
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("prismer"))
        .display()
        .to_string();

    let unit = format!(
        r#"[Unit]
Description=Prismer Daemon — background evolution sync
After=network-online.target

[Service]
Type=simple
Environment=PRISMER_DAEMON=1
ExecStart={exe} daemon start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"#,
        exe = exe,
    );

    fs::create_dir_all(&service_dir).ok();
    fs::write(&service_path, &unit).ok();
    #[cfg(unix)]
    fs::set_permissions(&service_path, fs::Permissions::from_mode(0o644)).ok();

    let cmds = [
        &["systemctl", "--user", "daemon-reload"],
        &["systemctl", "--user", "enable", "prismer-daemon"],
        &["systemctl", "--user", "start", "prismer-daemon"],
    ];
    let mut success = true;
    for args in &cmds {
        match Command::new(args[0]).args(&args[1..]).output() {
            Ok(o) if o.status.success() => {}
            _ => {
                success = false;
                break;
            }
        }
    }
    if success {
        println!("[prismer] Daemon service installed and started (systemd)");
        println!("  Service: {}", service_path.display());
    } else {
        println!("[prismer] Service file written. Enable manually:");
        println!("  systemctl --user enable --now prismer-daemon");
    }
}

#[cfg(target_os = "linux")]
fn uninstall_systemd() {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let service_path = home
        .join(".config")
        .join("systemd")
        .join("user")
        .join("prismer-daemon.service");
    Command::new("systemctl")
        .args(["--user", "stop", "prismer-daemon"])
        .output()
        .ok();
    Command::new("systemctl")
        .args(["--user", "disable", "prismer-daemon"])
        .output()
        .ok();
    fs::remove_file(&service_path).ok();
    Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()
        .ok();
    println!("[prismer] Daemon service uninstalled (systemd)");
}

// ============================================================================
// Entry point
// ============================================================================

/// Called at program start to check if this is a daemon child process.
/// If PRISMER_DAEMON=1, runs the daemon loop and never returns.
pub fn daemon_main() {
    if std::env::var("PRISMER_DAEMON").as_deref() == Ok("1") {
        run_daemon_process();
        std::process::exit(0);
    }
}
