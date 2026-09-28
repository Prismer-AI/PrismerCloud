// supervisor.rs — Daemon process management + heartbeat monitoring
//
// B5: The manager runs as sandbox-mgr. All daemon-path writes use sudo -u user.
// Daemon spawn uses `sudo -u user -H env VAR=val ...`. Signal forwarding
// targets the sudo process group so the daemon receives the forwarded signal.

use std::fs;
use std::io::Write;
use std::path::Path;
#[cfg(test)]
use std::process::Command;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread;
use std::time::Duration;

/// Spawn the daemon as user via sudo.
/// R1 fix: `sudo -u user -H --preserve-env program arg1 arg2 ...`
/// -H sets HOME to the target user's home (/home/user).
/// --preserve-env passes ALL env vars (PRISMER_*, CLOUD_*, DISPATCH_*,
/// NODE_PATH, PATH, etc.) through so pod-injected vars are not lost.
/// Requires SETENV in sudoers.
pub fn spawn_daemon_as_user(run_as: &str, program: &str, args: &[String]) -> Child {
    let mut cmd = crate::util::command_as_user(run_as, program, true);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| {
            eprintln!("[sandbox-manager] failed to spawn daemon via sudo: {}", e);
            std::process::exit(1);
        })
}

/// Original spawn (for unit tests where sudo is not required).
/// Used only by tests.
#[cfg(test)]
pub fn spawn_daemon(args: &[String]) -> Child {
    let program = &args[0];
    let rest = &args[1..];
    Command::new(program)
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| {
            eprintln!("[sandbox-manager] failed to spawn '{}': {}", program, e);
            std::process::exit(1);
        })
}

/// Install signal handlers that forward SIGTERM/SIGINT to the daemon child.
/// B5: The stored PID is the sudo process. When a signal arrives, we forward
/// to the sudo process group (-pid), which propagates to the daemon (child of sudo).
pub fn install_signal_handlers(daemon_pid: u32) {
    unsafe {
        libc::signal(
            libc::SIGTERM,
            forward_signal_handler as *const () as usize as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            forward_signal_handler as *const () as usize as libc::sighandler_t,
        );
    }

    DAEMON_PID.store(daemon_pid as i32, Ordering::SeqCst);

    eprintln!(
        "[sandbox-manager] signal handlers installed (SIGTERM/SIGINT -> daemon pg {})",
        daemon_pid
    );
}

static DAEMON_PID: AtomicI32 = AtomicI32::new(0);

/// Signal handler: forwards SIGTERM/SIGINT to the daemon wrapper process
/// (sudo), then exits. tini (PID 1) handles zombie reaping for grandchild
/// processes (gateway, etc.).
///
/// R3: The sudo process does NOT create a new process group (no setpgrp),
/// so kill(-pid) is a no-op (ESRCH). We forward only to the sudo PID;
/// the sudo process propagates the signal to its child (the daemon) by
/// default. The manager exits immediately via _exit — tini cleans up.
extern "C" fn forward_signal_handler(sig: i32) {
    let daemon_pid = DAEMON_PID.load(Ordering::SeqCst);
    if daemon_pid > 0 {
        unsafe { libc::kill(daemon_pid, sig) };
    }
    unsafe { libc::_exit(128 + sig) };
}

/// Write initial heartbeat file using sudo tee (B5: manager is sandbox-mgr,
/// heartbeat file at /home/user/.prismer/ is owned by user).
pub fn write_initial_heartbeat(heartbeat_file: &Path) {
    let content = format!(
        "{{\"timestamp\":{},\"configVersion\":\"\",\"pid\":0}}",
        epoch_secs()
    );

    let path_str = heartbeat_file
        .to_str()
        .unwrap_or("/home/user/.prismer/daemon-heartbeat");

    // Create parent dir via sudo (best-effort, may already exist)
    if let Some(parent) = heartbeat_file.parent() {
        if let Some(parent_str) = parent.to_str() {
            let _ = crate::util::command_as_user("user", "mkdir", false)
                .args(["-p", parent_str])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    let mut child = match crate::util::command_as_user("user", "tee", false)
        .arg(path_str)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(content.as_bytes());
    }
    let _ = child.wait();
}

/// Check if the daemon heartbeat file is fresh.
/// B5: The heartbeat file at /home/user/.prismer/daemon-heartbeat is
/// group-readable (sandbox-mgr is in user's group via usermod -a -G).
pub fn is_heartbeat_fresh(heartbeat_file: &Path, timeout_secs: u64) -> bool {
    match fs::read_to_string(heartbeat_file) {
        Ok(content) => {
            if let Some(ts_start) = content.find("\"timestamp\":") {
                let after_key = &content[ts_start + "\"timestamp\":".len()..];
                let ts_str: String = after_key
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(ts) = ts_str.parse::<u64>() {
                    let now = epoch_secs();
                    return now.saturating_sub(ts) <= timeout_secs;
                }
            }
            false
        }
        Err(_) => false,
    }
}

/// Read the heartbeat file and return (timestamp, configVersion, pid).
pub fn read_heartbeat(heartbeat_file: &Path) -> Option<(u64, String, u32)> {
    let content = fs::read_to_string(heartbeat_file).ok()?;
    let timestamp = extract_json_u64(&content, "timestamp")?;
    let config_version = extract_json_string(&content, "configVersion").unwrap_or_default();
    let pid = extract_json_u64(&content, "pid")
        .map(|v| v as u32)
        .unwrap_or(0);
    Some((timestamp, config_version, pid))
}

/// Extract a u64 value from a JSON-like string by key.
/// B10: Simplified scanner for the controlled heartbeat file format.
/// Input is ALWAYS produced by DaemonHeartbeat (TS JSON.stringify) which
/// emits compact single-line JSON. NOT a general JSON parser.
fn extract_json_u64(content: &str, key: &str) -> Option<u64> {
    let search = format!("\"{}\":", key);
    let pos = content.find(&search)?;
    let after = &content[pos + search.len()..];
    let digits: String = after
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u64>().ok()
}

/// Extract a double-quoted string value from a JSON-like string by key.
/// Same controlled-format constraints as extract_json_u64.
fn extract_json_string(content: &str, key: &str) -> Option<String> {
    let search = format!("\"{}\":", key);
    let pos = content.find(&search)?;
    let after = &content[pos + search.len()..];
    let after_ws = after.trim_start();
    if !after_ws.starts_with('"') {
        return None;
    }
    let after_quote = &after_ws[1..];
    let end = after_quote.find('"')?;
    Some(after_quote[..end].to_string())
}

/// Monitor loop: wait for daemon exit, periodically check heartbeat.
pub fn monitor_loop(child: &mut Child, heartbeat_file: &Path, timeout_secs: u64) -> Option<i32> {
    let check_interval = Duration::from_secs(5);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                eprintln!("[sandbox-manager] daemon exited (code={:?})", code);
                return code;
            }
            Ok(None) => {
                let fresh = is_heartbeat_fresh(heartbeat_file, timeout_secs);
                if !fresh {
                    if let Some((ts, config_ver, pid)) = read_heartbeat(heartbeat_file) {
                        let age = epoch_secs().saturating_sub(ts);
                        eprintln!(
                            "[sandbox-manager] daemon heartbeat STALE (age={}s, pid={}, configVersion={}, timeout={}s)",
                            age, pid, config_ver, timeout_secs
                        );
                    } else {
                        eprintln!("[sandbox-manager] daemon heartbeat MISSING");
                    }
                }
            }
            Err(e) => {
                eprintln!("[sandbox-manager] error checking daemon: {}", e);
                return None;
            }
        }

        thread::sleep(check_interval);
    }
}

/// Send a signal to a process by PID (best-effort).
pub fn signal_process(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, signal) == 0 }
}

/// Check if a process is alive by sending signal 0.
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Get current epoch seconds
pub fn epoch_secs() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ── Diagnostics collection (09 §3.6 diag_bundle) ──────────────────────

use std::path::PathBuf;

/// Collect a diagnostic bundle: config files, heartbeat, resource snapshot.
/// Writes a tar.gz to /var/run/sandbox/diag-bundle.tar.gz.
/// Returns the path on success, None on failure.
///
/// v1: collects config files + heartbeat + /proc/meminfo.
/// Full tar.gz requires external `tar` command.
pub fn collect_diag_bundle(daemon_home: &Path) -> Option<PathBuf> {
    let output_path = PathBuf::from("/var/run/sandbox/diag-bundle.tar.gz");
    let work_dir = PathBuf::from("/var/run/sandbox/diag-tmp");

    // Clean up any previous attempt
    let _ = fs::remove_dir_all(&work_dir);
    let _ = fs::remove_file(&output_path);

    if fs::create_dir_all(&work_dir).is_err() {
        return None;
    }

    // Collect files into the temp dir
    let mut collected = Vec::new();

    // config.toml
    let config_toml = daemon_home.join(".prismer").join("config.toml");
    if config_toml.exists() {
        let dest = work_dir.join("config.toml");
        if fs::copy(&config_toml, &dest).is_ok() {
            collected.push("config.toml");
        }
    }

    // Hermes config.yaml
    let hermes_yaml = daemon_home.join(".hermes").join("config.yaml");
    if hermes_yaml.exists() {
        let dest = work_dir.join("config.yaml");
        if fs::copy(&hermes_yaml, &dest).is_ok() {
            collected.push("config.yaml");
        }
    }

    // Hermes .env
    let hermes_env = daemon_home.join(".hermes").join(".env");
    if hermes_env.exists() {
        let dest = work_dir.join("hermes.env");
        if fs::copy(&hermes_env, &dest).is_ok() {
            collected.push("hermes.env");
        }
    }

    // Heartbeat
    let hb_file = daemon_home.join(".prismer").join("daemon-heartbeat");
    if hb_file.exists() {
        let dest = work_dir.join("daemon-heartbeat");
        if fs::copy(&hb_file, &dest).is_ok() {
            collected.push("daemon-heartbeat");
        }
    }

    // Session health
    let session_health = daemon_home
        .join(".prismer")
        .join("hermes-session-health.json");
    if session_health.exists() {
        let dest = work_dir.join("hermes-session-health.json");
        if fs::copy(&session_health, &dest).is_ok() {
            collected.push("hermes-session-health.json");
        }
    }

    // /proc/meminfo
    if let Ok(content) = fs::read_to_string("/proc/meminfo") {
        let dest = work_dir.join("meminfo");
        if fs::write(&dest, &content).is_ok() {
            collected.push("meminfo");
        }
    }

    // /proc/diskstats
    if let Ok(content) = fs::read_to_string("/proc/diskstats") {
        let dest = work_dir.join("diskstats");
        if fs::write(&dest, &content).is_ok() {
            collected.push("diskstats");
        }
    }

    // Write manifest
    let manifest = format!(
        "{{\"collectedAt\":{},\"files\":{:?}}}",
        epoch_secs(),
        collected
    );
    let _ = fs::write(work_dir.join("manifest.json"), &manifest);

    eprintln!(
        "[sandbox-manager] diag_bundle: collected {} files",
        collected.len()
    );

    if collected.is_empty() {
        let _ = fs::remove_dir_all(&work_dir);
        return None;
    }

    // Create tar.gz using system tar
    let tar_result = std::process::Command::new("tar")
        .args(["-czf"])
        .arg(&output_path)
        .arg("-C")
        .arg(&work_dir)
        .arg(".")
        .output();

    // Clean up temp dir
    let _ = fs::remove_dir_all(&work_dir);

    match tar_result {
        Ok(out) if out.status.success() => {
            eprintln!(
                "[sandbox-manager] diag_bundle: written to {}",
                output_path.display()
            );
            Some(output_path)
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            eprintln!(
                "[sandbox-manager] diag_bundle: tar failed: {}",
                stderr.trim()
            );
            None
        }
        Err(e) => {
            eprintln!("[sandbox-manager] diag_bundle: tar command failed: {}", e);
            None
        }
    }
}

/// Disk cleanup — clean whitelisted temporary/cache paths.
/// Returns list of paths that were cleaned.
///
/// v1 whitelist:
///   - /tmp/*.tmp files older than 1 day
///   - /workspace/_outbox/ files (best-effort)
pub fn disk_cleanup() -> Vec<String> {
    let mut cleaned = Vec::new();

    // Clean /tmp/*.tmp files
    if let Ok(entries) = fs::read_dir("/tmp") {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "tmp").unwrap_or(false)
                && fs::remove_file(&path).is_ok()
            {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    cleaned.push(format!("/tmp/{}", name));
                }
            }
        }
    }

    // Clean /workspace/_outbox/ (best-effort — list only, don't delete content
    // that may still be uploading)
    let outbox = PathBuf::from("/workspace/_outbox");
    if outbox.exists() {
        if let Ok(entries) = fs::read_dir(&outbox) {
            for entry in entries.flatten() {
                let path = entry.path();
                // Only clean files, not dirs
                if path.is_file() && fs::remove_file(&path).is_ok() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        cleaned.push(format!("/workspace/_outbox/{}", name));
                    }
                }
            }
        }
    }

    eprintln!(
        "[sandbox-manager] disk_cleanup: cleaned {} paths",
        cleaned.len()
    );
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_heartbeat_fresh ──────────────────────────────────────────

    #[test]
    fn test_heartbeat_fresh_when_recent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        let now = epoch_secs();
        let content = format!(
            "{{\"timestamp\":{},\"configVersion\":\"v1\",\"pid\":42}}",
            now
        );
        fs::write(&hb_file, &content).unwrap();
        assert!(is_heartbeat_fresh(&hb_file, 15));
        assert!(is_heartbeat_fresh(&hb_file, 45));
    }

    #[test]
    fn test_heartbeat_stale_when_old() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        let old_ts = epoch_secs() - 60;
        let content = format!(
            "{{\"timestamp\":{},\"configVersion\":\"v1\",\"pid\":42}}",
            old_ts
        );
        fs::write(&hb_file, &content).unwrap();
        assert!(!is_heartbeat_fresh(&hb_file, 45));
    }

    #[test]
    fn test_heartbeat_stale_when_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert!(!is_heartbeat_fresh(
            &tmp.path().join("nonexistent.json"),
            45
        ));
    }

    #[test]
    fn test_heartbeat_stale_when_no_timestamp_field() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        fs::write(&hb_file, "{\"other\":\"data\"}").unwrap();
        assert!(!is_heartbeat_fresh(&hb_file, 45));
    }

    #[test]
    fn test_read_heartbeat_valid() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        fs::write(
            &hb_file,
            "{\"timestamp\":1234567890,\"configVersion\":\"abc123\",\"pid\":42}",
        )
        .unwrap();
        let (ts, cv, pid) = read_heartbeat(&hb_file).unwrap();
        assert_eq!(ts, 1234567890);
        assert_eq!(cv, "abc123");
        assert_eq!(pid, 42);
    }

    #[test]
    fn test_read_heartbeat_missing_file() {
        assert!(read_heartbeat(Path::new("/nonexistent/hb.json")).is_none());
    }

    #[test]
    fn test_read_heartbeat_partial_fields() {
        let tmp = tempfile::TempDir::new().unwrap();
        let hb_file = tmp.path().join("daemon-heartbeat");
        fs::write(&hb_file, "{\"timestamp\":9999}").unwrap();
        let (ts, cv, pid) = read_heartbeat(&hb_file).unwrap();
        assert_eq!(ts, 9999);
        assert_eq!(cv, "");
        assert_eq!(pid, 0);
    }

    #[test]
    fn test_spawn_daemon_runs_child() {
        let mut child = spawn_daemon(&["true".to_string()]);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn test_spawn_daemon_with_args() {
        let mut child = spawn_daemon(&["sh".to_string(), "-c".to_string(), "exit 42".to_string()]);
        assert_eq!(child.wait().unwrap().code(), Some(42));
    }

    #[test]
    fn test_daemon_pid_global_is_initialized() {
        let mut child = spawn_daemon(&["true".to_string()]);
        let pid = child.id();
        install_signal_handlers(pid);
        assert_eq!(DAEMON_PID.load(Ordering::SeqCst), pid as i32);
        child.wait().unwrap();
    }
}
