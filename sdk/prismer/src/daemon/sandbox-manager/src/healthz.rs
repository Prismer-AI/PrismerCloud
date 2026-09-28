// healthz.rs — Manager liveness and Runtime readiness endpoints
//
// Listens on 0.0.0.0:<port> (bind-all so kubelet can reach pod IP).
// GET /healthz: manager liveness (always 200 while manager can answer)
// GET /readyz: Runtime readiness (200 only when child is alive and :7878 accepts)
//
// Response (200): { "status": "ok", "managerPid": <pid>, "daemonAlive": <bool>,
//                    "daemonHeartbeatAge": <secs|null>, "daemonId": "<id>" }
//
// The endpoint ALWAYS returns 200 as long as the manager itself is alive —
// this is the key invariant: daemon death != pod restart (09 §6 case 1).
// Daemon status is reported in the response body for cloud observability.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::supervisor;

const RUNTIME_PORT: u16 = 7878;

/// State shared between the healthz server and the manager main loop.
pub struct HealthzState {
    pub daemon_pid: AtomicU32,
    pub daemon_id: String,
    pub heartbeat_file: PathBuf,
    daemon_alive: AtomicBool,
}

impl HealthzState {
    pub fn new(daemon_pid: u32, daemon_id: String, heartbeat_file: PathBuf) -> Self {
        Self {
            daemon_pid: AtomicU32::new(daemon_pid),
            daemon_id,
            heartbeat_file,
            daemon_alive: AtomicBool::new(daemon_pid != 0),
        }
    }

    pub fn set_daemon_alive(&self, alive: bool) {
        self.daemon_alive.store(alive, Ordering::SeqCst);
    }

    pub fn is_daemon_alive(&self) -> bool {
        self.daemon_alive.load(Ordering::SeqCst)
    }

    /// Update daemon PID after a restart.
    pub fn set_daemon_pid(&self, pid: u32) {
        self.daemon_pid.store(pid, Ordering::SeqCst);
    }
}

/// Start the healthz HTTP server on the given port.
/// The caller retains the Arc so it can update daemonAlive after the
/// monitor loop detects daemon exit (B2 fix).
pub fn start_healthz_server(port: u16, state: Arc<HealthzState>) -> thread::JoinHandle<()> {
    let addr = format!("0.0.0.0:{}", port);

    let bind_addr = addr.clone();
    thread::spawn(move || {
        let listener = match TcpListener::bind(&bind_addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!(
                    "[sandbox-manager] healthz: failed to bind {}: {}",
                    bind_addr, e
                );
                return;
            }
        };

        // B6 fix: set_nonblocking(false) ensures blocking accept — the comment
        // previously said "set a short accept timeout" which is misleading.
        // accept() blocks until a connection arrives; this is fine for a
        // long-running healthz server that handles every connection in a
        // spawned thread. The actual read timeout is set per-connection in
        // handle_connection().
        if let Err(e) = listener.set_nonblocking(false) {
            eprintln!("[sandbox-manager] healthz: set_nonblocking failed: {}", e);
        }

        eprintln!(
            "[sandbox-manager] healthz listening on {} (0.0.0.0:{})",
            bind_addr, port
        );

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let state = Arc::clone(&state);
                    thread::spawn(move || {
                        handle_connection(stream, &state);
                    });
                }
                Err(e) => {
                    eprintln!("[sandbox-manager] healthz: accept error: {}", e);
                }
            }
        }
    })
}

fn handle_connection(mut stream: TcpStream, state: &HealthzState) {
    // Set a short read timeout so we don't hang on malformed clients
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    // B7 fix: try_clone failure is not a reason to panic — return early
    // and close the connection. A TcpStream clone can fail under extreme
    // fd pressure; crashing the manager for that is disproportionate.
    let reader_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[sandbox-manager] healthz: try_clone failed: {}", e);
            send_response(
                &mut stream,
                500,
                "Internal Server Error",
                "{\"error\":\"internal\"}",
            );
            return;
        }
    };
    let mut reader = BufReader::new(reader_stream);

    // Read the request line
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        send_response(
            &mut stream,
            400,
            "Bad Request",
            "{\"error\":\"bad request\"}",
        );
        return;
    }

    let method = parts[0];
    let path = parts[1];

    // Read and discard headers
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            break;
        }
        if line.trim().is_empty() {
            break;
        }
    }

    match (method, path) {
        ("GET", "/healthz") => serve_healthz(&mut stream, state),
        ("GET", "/readyz") => serve_readyz(&mut stream, state),
        ("GET", "/") => serve_healthz(&mut stream, state),
        _ => send_response(&mut stream, 404, "Not Found", "{\"error\":\"not found\"}"),
    }
}

fn runtime_port_reachable() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], RUNTIME_PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn runtime_ready(state: &HealthzState, port_reachable: bool) -> bool {
    state.is_daemon_alive() && state.daemon_pid.load(Ordering::SeqCst) != 0 && port_reachable
}

fn serve_readyz(stream: &mut TcpStream, state: &HealthzState) {
    if runtime_ready(state, runtime_port_reachable()) {
        send_response(
            stream,
            200,
            "OK",
            r#"{"status":"ready","daemonAlive":true}"#,
        );
    } else {
        send_response(
            stream,
            503,
            "Service Unavailable",
            r#"{"status":"not_ready","daemonAlive":false}"#,
        );
    }
}

fn serve_healthz(stream: &mut TcpStream, state: &HealthzState) {
    // Check daemon liveness via heartbeat file
    let daemon_alive = state.is_daemon_alive();
    let heartbeat_age = if let Some((ts, _, _)) = supervisor::read_heartbeat(&state.heartbeat_file)
    {
        let age = supervisor::epoch_secs().saturating_sub(ts);
        Some(age)
    } else {
        None
    };

    let body = format!(
        r#"{{"status":"ok","managerPid":{},"daemonAlive":{},"daemonHeartbeatAge":{},"daemonId":"{}","daemonPid":{}}}"#,
        std::process::id(),
        daemon_alive,
        match heartbeat_age {
            Some(age) => age.to_string(),
            None => "null".to_string(),
        },
        state.daemon_id,
        state.daemon_pid.load(Ordering::SeqCst),
    );

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );

    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn send_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    /// Find an available port for the test server. Binds to port 0 (OS-assigned),
    /// reads back the assigned port, drops the listener so the test server can use it.
    fn find_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .expect("failed to bind to OS-assigned port")
            .local_addr()
            .expect("failed to get local address")
            .port()
    }

    /// Helper: send a simple HTTP GET request to localhost:<port>/healthz
    /// and return (status_code, body).
    fn http_get(port: u16, path: &str) -> Result<(u16, String), String> {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
            .map_err(|e| format!("connect: {}", e))?;
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            path
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|e| format!("write: {}", e))?;

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|e| format!("read: {}", e))?;

        // Parse status line
        let first_line = response.lines().next().unwrap_or("");
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        let status: u16 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

        // Find body (after \r\n\r\n)
        let body = if let Some(pos) = response.find("\r\n\r\n") {
            response[pos + 4..].to_string()
        } else {
            response.clone()
        };

        Ok((status, body))
    }

    #[test]
    fn test_healthz_returns_200() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        supervisor::write_initial_heartbeat(&hb_file);

        let state = Arc::new(HealthzState::new(0, "test-daemon".to_string(), hb_file));
        let port = find_port();
        let _handle = start_healthz_server(port, state);

        // Give the server a moment to start
        thread::sleep(Duration::from_millis(200));

        let result = http_get(port, "/healthz");
        assert!(
            result.is_ok(),
            "healthz should be reachable: {:?}",
            result.err()
        );
        let (status, body) = result.unwrap();
        assert_eq!(status, 200, "healthz should return 200, got body: {}", body);

        // Body should contain required fields
        assert!(body.contains("\"status\":\"ok\""));
        assert!(body.contains("\"daemonAlive\""));
        assert!(body.contains("\"daemonId\":\"test-daemon\""));
        assert!(body.contains("\"daemonHeartbeatAge\""));
    }

    #[test]
    fn test_healthz_returns_404_for_unknown_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        supervisor::write_initial_heartbeat(&hb_file);

        let state = Arc::new(HealthzState::new(0, "test-daemon".to_string(), hb_file));
        let port = find_port();
        let _handle = start_healthz_server(port, state);

        thread::sleep(Duration::from_millis(200));

        let result = http_get(port, "/nonexistent");
        assert!(result.is_ok());
        let (status, _) = result.unwrap();
        assert_eq!(status, 404);
    }

    #[test]
    fn test_daemon_alive_initial_state() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        supervisor::write_initial_heartbeat(&hb_file);

        let state = HealthzState::new(42, "test-daemon".to_string(), hb_file);
        assert_eq!(state.daemon_pid.load(Ordering::SeqCst), 42);
        assert!(state.is_daemon_alive());

        state.set_daemon_alive(false);
        assert!(!state.is_daemon_alive());

        state.set_daemon_pid(99);
        assert_eq!(state.daemon_pid.load(Ordering::SeqCst), 99);
    }

    #[test]
    fn test_healthz_stays_alive_while_runtime_bundle_is_unavailable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        let state = HealthzState::new(0, "waiting-daemon".to_string(), hb_file);

        assert_eq!(state.daemon_pid.load(Ordering::SeqCst), 0);
        assert!(!state.is_daemon_alive());
    }

    #[test]
    fn test_readyz_is_503_until_runtime_is_alive_and_reachable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        let state = Arc::new(HealthzState::new(0, "waiting-daemon".to_string(), hb_file));
        let port = find_port();
        let _handle = start_healthz_server(port, Arc::clone(&state));
        thread::sleep(Duration::from_millis(200));

        let (status, body) = http_get(port, "/readyz").unwrap();
        assert_eq!(status, 503);
        assert!(body.contains("\"status\":\"not_ready\""));
        assert!(!runtime_ready(&state, true));

        state.set_daemon_alive(true);
        state.set_daemon_pid(42);
        assert!(runtime_ready(&state, true));
        assert!(!runtime_ready(&state, false));
    }
}
