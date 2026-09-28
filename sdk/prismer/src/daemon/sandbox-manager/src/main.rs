// sandbox-manager: Resident Sandbox Manager (09 §3)
//
// Architecture:
//   tini (PID 1) → sandbox-manager (常驻, sandbox-mgr) → daemon (子进程, user)
//                                                          └→ gateway 孙进程
//
// B5: Manager runs as sandbox-mgr (low-privilege, 09 §3.2).
// Daemon spawns via `sudo -u user -H --preserve-env` — all env vars
// pass through. Requires SETENV in sudoers.
//
// 09 S2 additions (WP-E):
//   - OTA settle BEFORE OTA resolve
//   - SANDBOX_MANAGER_PRESENT env → TS-side settle disabled
//   - Command channel (cmd.json/res.json + inotify/polling)
//   - Failure classification (Fatal→Fail-slow, Transient→Fail-fast max 3)
//   - Rescue actions

use std::env;
use std::process;
use std::sync::{Arc, Mutex};
use std::thread;

const DEFAULT_HEARTBEAT_TIMEOUT_SECS: u64 = 45;
const DEFAULT_BOOTSTRAP_RETRY_SECS: u64 = 5;

mod classify;
mod cmd;
mod config;
mod healthz;
mod init;
mod ota;
mod supervisor;
mod util;

/// Shared daemon state — accessible from main loop and cmd handler thread.
struct DaemonState {
    /// Current daemon child PID (the sudo process).
    pid: Mutex<u32>,
    /// Whether daemon is alive (set by main loop and cmd handler).
    alive: std::sync::atomic::AtomicBool,
    /// Out-of-band restart request consumed only by the main monitor loop.
    restart_requested: std::sync::atomic::AtomicBool,
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() > 1 && args[1] == "--version" {
        println!("sandbox-manager {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let healthz_port: u16 = env::var("SANDBOX_MANAGER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7890);

    let heartbeat_timeout: u64 = env::var("MANAGER_HEARTBEAT_TIMEOUT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_HEARTBEAT_TIMEOUT_SECS);

    eprintln!(
        "[sandbox-manager] starting (pid={}, manager_user={}, healthz=0.0.0.0:{}, heartbeat_timeout={}s)",
        process::id(),
        env::var("USER").unwrap_or_else(|_| "?".to_string()),
        healthz_port,
        heartbeat_timeout
    );

    // ── Phase 0: Set manager-present flag ──────────────────────────────
    env::set_var("SANDBOX_MANAGER_PRESENT", "true");
    publish_manager_pid();

    // ── Phase 1: Entrypoint initialization ──────────────────────────
    let daemon_home = init::resolve_daemon_home_dir();
    let config_path = daemon_home.join(".prismer").join("config.toml");
    let template_mode = init::runtime_template_mode();
    let restoring_template = init::has_template_marker(&daemon_home) && !template_mode;
    let daemon_id = init::resolve_daemon_id_for_boot(&config_path, !restoring_template);
    let cloud_base = init::resolve_cloud_base();
    let api_key = init::resolve_api_key();

    init::validate_static_binding();
    env::set_var("PRISMER_API_KEY", &api_key);
    env::set_var("PRISMER_DAEMON_ID", &daemon_id);
    env::set_var("PRISMER_BASE_URL", &cloud_base);
    if env::var("PRISMER_DAEMON_BIND").is_err() {
        env::set_var("PRISMER_DAEMON_BIND", "0.0.0.0");
    }
    if env::var("PRISMER_MEMORY_PROVIDER").is_err() {
        env::set_var("PRISMER_MEMORY_PROVIDER", "1");
    }

    init::ensure_prismer_dir(&daemon_home);
    init::write_config_toml(&daemon_home, &api_key, &cloud_base, &daemon_id);
    if template_mode {
        init::write_template_marker(&daemon_home);
    } else if restoring_template {
        init::clear_template_marker(&daemon_home);
    }

    eprintln!(
        "[sandbox-manager] init complete (daemon_id={}, daemon_home={})",
        daemon_id,
        daemon_home.display()
    );

    // ── Phase 2a: OTA settle ──────────────────────────────────────────
    let prismer_home = daemon_home.join(".prismer");
    settle_previous_runtime_boot(&prismer_home);

    // ── Phase 2b: Manager health comes up before bundle resolution ────
    let heartbeat_file = daemon_home.join(".prismer").join("daemon-heartbeat");
    supervisor::write_initial_heartbeat(&heartbeat_file);
    let daemon_state = Arc::new(DaemonState {
        pid: Mutex::new(0),
        alive: std::sync::atomic::AtomicBool::new(false),
        restart_requested: std::sync::atomic::AtomicBool::new(false),
    });
    let healthz_state = Arc::new(healthz::HealthzState::new(
        0,
        daemon_id.clone(),
        heartbeat_file.clone(),
    ));
    let _healthz_handle = healthz::start_healthz_server(healthz_port, Arc::clone(&healthz_state));

    // ── Phase 3: Resolve daemon command ───────────────────────────────
    // Explicit commands are retained for container tests and rescue use. The
    // normal image path has no builtin Runtime: stay manager-healthy and retry
    // the signed bundle bootstrap until Cloud/current cache is available.
    let manager_resolves_runtime = args.len() == 1;
    let mut daemon_command = if args.len() > 1 {
        (args[1].clone(), args[2..].to_vec())
    } else {
        wait_for_runtime_bundle()
    };

    // ── Phase 4: Spawn daemon via sudo ────────────────────────────────
    let mut child = supervisor::spawn_daemon_as_user("user", &daemon_command.0, &daemon_command.1);

    {
        let mut pid = daemon_state.pid.lock().unwrap();
        *pid = child.id();
    }
    daemon_state
        .alive
        .store(true, std::sync::atomic::Ordering::SeqCst);
    healthz_state.set_daemon_pid(child.id());
    healthz_state.set_daemon_alive(true);

    eprintln!(
        "[sandbox-manager] daemon spawned via sudo --preserve-env (sudo_pid={})",
        child.id()
    );

    // ── Phase 5: Signal handlers ──────────────────────────────────────
    supervisor::install_signal_handlers(child.id());

    // ── Phase 6: Command channel watcher ──────────────────────────────
    let cmd_cache = Arc::new(cmd::ResultCache::new());
    let cmd_daemon_home = daemon_home.clone();
    let cmd_cache_clone = Arc::clone(&cmd_cache);
    let cmd_daemon_state = Arc::clone(&daemon_state);

    let _cmd_thread = thread::spawn(move || {
        cmd_watcher_loop(&cmd_cache_clone, &cmd_daemon_home, &cmd_daemon_state);
    });

    // ── Phase 7: Monitor loop with failure classification ─────────────
    let mut failure_tracker = classify::FailureTracker::new();

    loop {
        let exit_code = supervisor::monitor_loop(&mut child, &heartbeat_file, heartbeat_timeout);

        healthz_state.set_daemon_alive(false);
        daemon_state
            .alive
            .store(false, std::sync::atomic::Ordering::SeqCst);
        {
            let mut pid = daemon_state.pid.lock().unwrap();
            *pid = 0;
        }
        healthz_state.set_daemon_pid(0);
        eprintln!(
            "[sandbox-manager] daemon exited (code={:?}), manager alive for probes",
            exit_code
        );

        let command_restart_requested = daemon_state
            .restart_requested
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        let exit_decision = assess_daemon_exit(
            exit_code,
            command_restart_requested,
            &mut failure_tracker,
            || {
                // Classify the failure
                let stderr_tail = ""; // v1: stderr not captured (see E4 deferred)
                classify::classify_daemon_exit(exit_code, stderr_tail, &daemon_home)
            },
        );

        if exit_decision.enter_fail_slow {
            // Fail-slow: pack diagnostics, stay alive, wait for cloud commands.
            // Use a sleep loop (not park()) so cmd handler can restart daemon.
            eprintln!(
                "[sandbox-manager] FAIL-SLOW mode — diagnostics packed, waiting for cloud commands"
            );
            let diag_path = supervisor::collect_diag_bundle(&daemon_home);
            match &diag_path {
                Some(p) => eprintln!("[sandbox-manager] diagnostics saved to {}", p.display()),
                None => eprintln!("[sandbox-manager] diagnostics collection failed"),
            }
            // Sleep loop — cmd handler can call restart_daemon while we sleep
            while failure_tracker.is_fail_slow() {
                if daemon_state
                    .restart_requested
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    failure_tracker.reset();
                    eprintln!("[sandbox-manager] leaving FAIL-SLOW on explicit restart request");
                    break;
                }
                thread::sleep(std::time::Duration::from_secs(5));
            }
            // If we exit fail-slow (reset by successful restart), continue loop
            // to spawn new daemon
        }

        // Fail-fast / intentional OTA restart: re-run signed bundle resolution
        // before respawning. The daemon's runtime.update.apply path exits the
        // child while PID 1 + this manager stay alive; keeping the command that
        // was resolved only at manager boot would silently relaunch the old
        // bundle forever. Explicit rescue commands remain pinned.
        daemon_command = refresh_daemon_command_for_respawn(
            manager_resolves_runtime,
            exit_decision.kind,
            &daemon_command,
            || settle_previous_runtime_boot(&prismer_home),
            wait_for_runtime_bundle,
        );
        eprintln!("[sandbox-manager] restarting daemon (fail-fast mode)...");
        child = supervisor::spawn_daemon_as_user("user", &daemon_command.0, &daemon_command.1);
        {
            let mut pid = daemon_state.pid.lock().unwrap();
            *pid = child.id();
        }
        daemon_state
            .alive
            .store(true, std::sync::atomic::Ordering::SeqCst);
        supervisor::install_signal_handlers(child.id());
        healthz_state.set_daemon_pid(child.id());
        healthz_state.set_daemon_alive(true);
    }
}

fn publish_manager_pid() {
    env::set_var("SANDBOX_MANAGER_PID", process::id().to_string());
}

fn wait_for_runtime_bundle() -> (String, Vec<String>) {
    let retry_secs = env::var("PRISMER_RUNTIME_BOOTSTRAP_RETRY_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_BOOTSTRAP_RETRY_SECS);

    if env::var("PRISMER_BUNDLE_OTA").unwrap_or_else(|_| "1".to_string()) == "0" {
        eprintln!(
            "[sandbox-manager] PRISMER_BUNDLE_OTA=0 but the frozen image has no builtin Runtime; waiting"
        );
    }

    loop {
        if env::var("PRISMER_BUNDLE_OTA").unwrap_or_else(|_| "1".to_string()) != "0" {
            match init::resolve_runtime_bundle() {
                Ok(bundle_cli) => match init::prepend_bundle_bin_to_path(&bundle_cli) {
                    Ok(()) => {
                        return (
                            "node".to_string(),
                            vec![
                                bundle_cli.display().to_string(),
                                "daemon".to_string(),
                                "start".to_string(),
                                "--port=7878".to_string(),
                                "--foreground".to_string(),
                            ],
                        );
                    }
                    Err(error) => {
                        eprintln!("[sandbox-manager] runtime bundle rejected: {error}");
                    }
                },
                Err(error) => {
                    eprintln!("[sandbox-manager] runtime bundle unavailable: {error}");
                }
            }
        }

        eprintln!(
            "[sandbox-manager] daemon not ready; retrying signed bundle bootstrap in {}s",
            retry_secs
        );
        thread::sleep(std::time::Duration::from_secs(retry_secs));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonExitKind {
    Intentional,
    Unexpected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DaemonExitDecision {
    kind: DaemonExitKind,
    enter_fail_slow: bool,
}

/// Interpret the child status returned by `supervisor::monitor_loop` together
/// with the out-of-band command-channel restart flag.
///
/// Runtime-owned OTA apply and version-skew drain both exit with code 0 and do
/// not cross the manager command channel. They are healthy restart boundaries,
/// just like an explicit `restart_daemon` command, so they reset rather than
/// increment the consecutive-failure tracker.
fn assess_daemon_exit<F>(
    exit_code: Option<i32>,
    command_restart_requested: bool,
    failure_tracker: &mut classify::FailureTracker,
    classify_failure: F,
) -> DaemonExitDecision
where
    F: FnOnce() -> classify::ClassifyResult,
{
    if command_restart_requested || exit_code == Some(0) {
        failure_tracker.reset();
        eprintln!(
            "[sandbox-manager] daemon exit was intentional (code={:?}, command_requested={})",
            exit_code, command_restart_requested
        );
        return DaemonExitDecision {
            kind: DaemonExitKind::Intentional,
            enter_fail_slow: false,
        };
    }

    let class_result = classify_failure();
    eprintln!(
        "[sandbox-manager] failure classified as {:?}: {}",
        class_result.class, class_result.reason
    );
    let enter_fail_slow = failure_tracker.record(class_result.class, &class_result.reason);
    DaemonExitDecision {
        kind: DaemonExitKind::Unexpected,
        enter_fail_slow,
    }
}

/// Select the command for the next child spawn.
///
/// Frozen-floor images are manager-resolved: every respawn is a boot boundary
/// and must negotiate the signed OTA pointer again. Explicit commands are
/// rescue/test entrypoints and intentionally remain stable across restarts.
fn refresh_daemon_command_for_respawn<S, F>(
    manager_resolves_runtime: bool,
    exit_kind: DaemonExitKind,
    current: &(String, Vec<String>),
    settle_previous: S,
    resolve_runtime: F,
) -> (String, Vec<String>)
where
    S: FnOnce(),
    F: FnOnce() -> (String, Vec<String>),
{
    if manager_resolves_runtime {
        // A deliberate runtime.update.apply/restart exits a healthy child and
        // may race its 10-second boot confirmation. Do not turn that marker
        // into a crash strike. Unexpected child exits do settle before the
        // next signed resolve so a broken N+1 rolls back in this same manager
        // lifetime.
        if exit_kind == DaemonExitKind::Unexpected {
            settle_previous();
        }
        resolve_runtime()
    } else {
        current.clone()
    }
}

fn settle_previous_runtime_boot(prismer_home: &std::path::Path) {
    let settle_result = ota::settle_previous_boot(prismer_home, &mut |message| {
        eprintln!("{}", message);
    });
    if settle_result.marker_version.is_some() {
        eprintln!(
            "[sandbox-manager] OTA settle: strike={} blacklisted={} rolled_back={} target={}",
            settle_result.strike_count,
            settle_result.blacklisted,
            settle_result.rolled_back,
            settle_result.rolled_to_version.as_deref().unwrap_or("none")
        );
    }
}

// ── Command watcher loop ───────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn cmd_watcher_loop(
    cache: &cmd::ResultCache,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) {
    eprintln!("[sandbox-manager] cmd watcher: inotify on /var/run/sandbox/cmd.json");

    let mut inotify = match cmd::inotify_watcher::init() {
        Ok(i) => i,
        Err(e) => {
            eprintln!(
                "[sandbox-manager] cmd watcher: inotify init failed: {} — falling back to polling",
                e
            );
            cmd_watcher_loop_poll(cache, daemon_home, daemon_state);
            return;
        }
    };

    // A command may have been atomically written while the manager was blocked
    // resolving the first signed Runtime bundle. inotify only observes future
    // events, so recover the durable result before deciding whether the
    // existing command still needs execution.
    process_startup_command(cache, daemon_home, daemon_state);

    loop {
        let cmd = match cmd::inotify_watcher::check(&mut inotify, cache) {
            Some(c) => c,
            None => {
                thread::sleep(cmd::inotify_watcher::WATCH_SLEEP);
                continue;
            }
        };
        process_command(cmd, cache, daemon_home, daemon_state);
    }
}

#[cfg(not(target_os = "linux"))]
fn cmd_watcher_loop(
    cache: &cmd::ResultCache,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) {
    eprintln!("[sandbox-manager] cmd watcher: mtime polling /var/run/sandbox/cmd.json every 1s (non-Linux fallback)");
    cmd_watcher_loop_poll(cache, daemon_home, daemon_state);
}

fn cmd_watcher_loop_poll(
    cache: &cmd::ResultCache,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) {
    let mut last_mtime: Option<std::time::SystemTime> = None;

    process_startup_command(cache, daemon_home, daemon_state);

    loop {
        let cmd = match cmd::poll_command(&mut last_mtime, cache) {
            Some(c) => c,
            None => {
                thread::sleep(cmd::POLL_INTERVAL);
                continue;
            }
        };
        process_command(cmd, cache, daemon_home, daemon_state);
    }
}

fn process_startup_command(
    cache: &cmd::ResultCache,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) {
    // Read res.json first: an exact, well-formed result is the durable
    // idempotency record for a fresh manager process whose memory cache is
    // necessarily empty.
    let persisted_result = cmd::read_result();
    let pending_command = cmd::read_command();
    if let Some(command) = cmd::recover_startup_command(pending_command, persisted_result, cache) {
        process_command(command, cache, daemon_home, daemon_state);
    }
}

fn process_command(
    cmd: cmd::Command,
    cache: &cmd::ResultCache,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) {
    eprintln!(
        "[sandbox-manager] cmd received: id={} action={}",
        cmd.id, cmd.action
    );

    // Note: cache check is already done in poll_command / inotify_watcher::check.
    // This is the first-execution path only.
    // E7: action execution wrapped in timeout (30s) — prevents a hung action
    // from blocking the entire command channel.

    let cmd_id = cmd.id.clone();
    let cmd_action = cmd.action.clone();
    let cmd_for_thread = cmd.clone();
    let dh = daemon_home.to_path_buf();
    let ds = Arc::clone(daemon_state);

    let (tx, rx) = std::sync::mpsc::channel();
    // NOTE: detached thread — if the action hangs, this thread leaks until
    // the process exits. Rust has no safe thread kill. The timeout reports
    // the error to res.json but does not (and cannot safely) terminate the
    // hung thread. v1 accepts this: the hung action's side effects may
    // eventually complete (or not), but the error is reported within 30s.
    thread::spawn(move || {
        let r = execute_action(&cmd_for_thread, &dh, &ds);
        let _ = tx.send(r);
    });

    let result = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(r) => r,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            eprintln!(
                "[sandbox-manager] cmd id={} action={} TIMEOUT after 30s",
                cmd_id, cmd_action
            );
            cmd::CommandResult {
                id: cmd_id,
                status: "error".to_string(),
                result: serde_json::Value::Null,
                completed_at: util::epoch_to_iso8601(),
                error: Some("Action timed out after 30 seconds".to_string()),
            }
        }
        Err(e) => {
            eprintln!(
                "[sandbox-manager] cmd id={} action={} channel error: {}",
                cmd_id, cmd_action, e
            );
            cmd::CommandResult {
                id: cmd_id,
                status: "error".to_string(),
                result: serde_json::Value::Null,
                completed_at: util::epoch_to_iso8601(),
                error: Some(format!("Internal error: {}", e)),
            }
        }
    };

    cache.set(&cmd.id, result.clone());

    if let Err(e) = cmd::write_result(&result) {
        eprintln!("[sandbox-manager] cmd: failed to write res.json: {}", e);
    } else {
        eprintln!(
            "[sandbox-manager] cmd id={} action={} → status={}",
            cmd.id, cmd.action, result.status
        );
    }
}

// ── Action execution ───────────────────────────────────────────────────

fn execute_action(
    cmd: &cmd::Command,
    daemon_home: &std::path::Path,
    daemon_state: &Arc<DaemonState>,
) -> cmd::CommandResult {
    let completed_at = util::epoch_to_iso8601();

    match cmd.action.as_str() {
        "rollback_config" => execute_rollback_config(cmd, &completed_at),
        "ota_rollback" => execute_ota_rollback(cmd, daemon_home, &completed_at),
        "restart_daemon" => execute_restart_daemon(cmd, daemon_state, &completed_at),
        "diag_bundle" => execute_diag_bundle(cmd, daemon_home, &completed_at),
        "disk_cleanup" => {
            // Env read once at action dispatch (not inside testable function).
            // Container E2E tests inject SANDBOX_MANAGER_TEST_SLOW_MS to simulate
            // hung actions; unit tests pass slow_ms directly via parameter.
            let slow_ms = env::var("SANDBOX_MANAGER_TEST_SLOW_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            execute_disk_cleanup(cmd, &completed_at, slow_ms)
        }
        _ => cmd::CommandResult {
            id: cmd.id.clone(),
            status: "error".to_string(),
            result: serde_json::Value::Null,
            completed_at,
            error: Some(format!("Unknown action: {}", cmd.action)),
        },
    }
}

fn execute_rollback_config(cmd: &cmd::Command, completed_at: &str) -> cmd::CommandResult {
    let result = config::rollback_config();
    cmd::CommandResult {
        id: cmd.id.clone(),
        status: if result.success { "ok" } else { "error" }.to_string(),
        result: serde_json::json!({ "restored_files": result.restored_files }),
        completed_at: completed_at.to_string(),
        error: result.error,
    }
}

fn execute_ota_rollback(
    cmd: &cmd::Command,
    daemon_home: &std::path::Path,
    completed_at: &str,
) -> cmd::CommandResult {
    let prismer_home = daemon_home.join(".prismer");
    let root = ota::bundle_root(&prismer_home);
    let current = ota::read_pointer(&root, "current");
    let previous = ota::read_pointer(&root, "previous");

    if let Some(ref prev) = previous {
        match ota::promote_verified_bundle_to_current(&root, prev) {
            Ok(()) => {
                eprintln!(
                    "[sandbox-manager] ota_rollback: current ← verified v{} (was {:?})",
                    prev, current
                );
                return cmd::CommandResult {
                    id: cmd.id.clone(),
                    status: "ok".to_string(),
                    result: serde_json::json!({ "rolled_back_to": prev, "previous_version": current }),
                    completed_at: completed_at.to_string(),
                    error: None,
                };
            }
            Err(error) => {
                return cmd::CommandResult {
                    id: cmd.id.clone(),
                    status: "error".to_string(),
                    result: serde_json::Value::Null,
                    completed_at: completed_at.to_string(),
                    error: Some(format!("Previous OTA version is not verified: {}", error)),
                };
            }
        }
    }

    cmd::CommandResult {
        id: cmd.id.clone(),
        status: "error".to_string(),
        result: serde_json::Value::Null,
        completed_at: completed_at.to_string(),
        error: Some("No valid previous OTA version to roll back to".to_string()),
    }
}

/// Request a daemon restart. The main monitor owns the `Child` handle and is
/// therefore the only code allowed to respawn it; spawning here would detach
/// an unreapable child and race a second restart from the monitor loop.
fn execute_restart_daemon(
    cmd: &cmd::Command,
    daemon_state: &Arc<DaemonState>,
    completed_at: &str,
) -> cmd::CommandResult {
    let daemon_pid = { *daemon_state.pid.lock().unwrap() };
    daemon_state
        .restart_requested
        .store(true, std::sync::atomic::Ordering::SeqCst);

    if daemon_pid > 0 {
        // Step 1: SIGTERM
        eprintln!(
            "[sandbox-manager] restart_daemon: sending SIGTERM to daemon pid={}",
            daemon_pid
        );
        let _ = supervisor::signal_process(daemon_pid, libc::SIGTERM);

        // Step 2: wait up to 10s for graceful shutdown
        for _ in 0..10 {
            if !supervisor::is_process_alive(daemon_pid) {
                eprintln!("[sandbox-manager] restart_daemon: daemon exited after SIGTERM");
                break;
            }
            thread::sleep(std::time::Duration::from_secs(1));
        }

        // Step 3: SIGKILL if still alive
        if supervisor::is_process_alive(daemon_pid) {
            eprintln!(
                "[sandbox-manager] restart_daemon: daemon still alive after 10s — sending SIGKILL"
            );
            let _ = supervisor::signal_process(daemon_pid, libc::SIGKILL);
            thread::sleep(std::time::Duration::from_millis(500));
        }
    } else {
        eprintln!("[sandbox-manager] restart_daemon: waking supervisor without a live child");
    }

    cmd::CommandResult {
        id: cmd.id.clone(),
        status: "ok".to_string(),
        result: serde_json::json!({ "restart_requested": true, "old_pid": daemon_pid }),
        completed_at: completed_at.to_string(),
        error: None,
    }
}

fn execute_diag_bundle(
    cmd: &cmd::Command,
    daemon_home: &std::path::Path,
    completed_at: &str,
) -> cmd::CommandResult {
    let diag_path = supervisor::collect_diag_bundle(daemon_home);
    match diag_path {
        Some(path) => cmd::CommandResult {
            id: cmd.id.clone(),
            status: "ok".to_string(),
            result: serde_json::json!({ "diag_path": path.to_string_lossy(), "files_collected": true }),
            completed_at: completed_at.to_string(),
            error: None,
        },
        None => cmd::CommandResult {
            id: cmd.id.clone(),
            status: "error".to_string(),
            result: serde_json::Value::Null,
            completed_at: completed_at.to_string(),
            error: Some("Failed to collect diagnostics".to_string()),
        },
    }
}

/// Execute disk cleanup. `slow_ms` is a test injection hook: when > 0 the
/// function sleeps that many ms before proceeding. Production always passes 0.
/// Container E2E tests inject SANDBOX_MANAGER_TEST_SLOW_MS via env (read once
/// in execute_action); unit tests pass slow_ms directly — no env racing.
fn execute_disk_cleanup(
    cmd: &cmd::Command,
    completed_at: &str,
    slow_ms: u64,
) -> cmd::CommandResult {
    if slow_ms > 0 {
        eprintln!(
            "[sandbox-manager] disk_cleanup: TEST_SLOW_MS={}ms — sleeping",
            slow_ms
        );
        thread::sleep(std::time::Duration::from_millis(slow_ms));
    }

    let cleaned = supervisor::disk_cleanup();
    cmd::CommandResult {
        id: cmd.id.clone(),
        status: "ok".to_string(),
        result: serde_json::json!({ "cleaned_paths": cleaned }),
        completed_at: completed_at.to_string(),
        error: None,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn write_verified_rollback_fixture(root: &std::path::Path, version: &str) {
        let dir = ota::bundle_dir(root, version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("verified-runtime.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "version": version,
                "current": version,
                "previous": "0.9.0",
                "sha256": "a".repeat(64),
                "signatureSha256": "b".repeat(64),
                "verified": true
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn manager_pid_is_published_for_every_runtime_child() {
        publish_manager_pid();
        assert_eq!(
            env::var("SANDBOX_MANAGER_PID").ok(),
            Some(process::id().to_string())
        );
    }

    #[test]
    fn operator_ota_rollback_promotes_only_verified_previous_and_rewrites_pointer_view() {
        let tmp = tempfile::TempDir::new().unwrap();
        let daemon_home = tmp.path();
        let root = ota::bundle_root(&daemon_home.join(".prismer"));
        ota::write_pointer(&root, "current", "2.0.0");
        ota::write_pointer(&root, "previous", "1.0.0");
        write_verified_rollback_fixture(&root, "1.0.0");
        let command = cmd::Command {
            id: "verified-rollback".to_string(),
            action: "ota_rollback".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };

        let result = execute_ota_rollback(&command, daemon_home, "now");

        assert_eq!(result.status, "ok");
        assert_eq!(
            ota::read_pointer(&root, "current"),
            Some("1.0.0".to_string())
        );
        assert_eq!(ota::read_pointer(&root, "previous"), None);
        let metadata: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(ota::bundle_dir(&root, "1.0.0").join("verified-runtime.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["current"], "1.0.0");
        assert_eq!(metadata["previous"], serde_json::Value::Null);
    }

    #[test]
    fn operator_ota_rollback_refuses_directory_without_verification_proof() {
        let tmp = tempfile::TempDir::new().unwrap();
        let daemon_home = tmp.path();
        let root = ota::bundle_root(&daemon_home.join(".prismer"));
        ota::write_pointer(&root, "current", "2.0.0");
        ota::write_pointer(&root, "previous", "1.0.0");
        std::fs::create_dir_all(ota::bundle_dir(&root, "1.0.0")).unwrap();
        let command = cmd::Command {
            id: "unverified-rollback".to_string(),
            action: "ota_rollback".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };

        let result = execute_ota_rollback(&command, daemon_home, "now");

        assert_eq!(result.status, "error");
        assert!(result.error.unwrap().contains("verified"));
        assert_eq!(
            ota::read_pointer(&root, "current"),
            Some("2.0.0".to_string())
        );
        assert_eq!(
            ota::read_pointer(&root, "previous"),
            Some("1.0.0".to_string())
        );
    }

    #[test]
    fn clean_runtime_exit_without_command_flag_is_intentional_and_does_not_settle() {
        let mut tracker = classify::FailureTracker::new();
        tracker.record(classify::FailureClass::Transient, "earlier crash 1");
        tracker.record(classify::FailureClass::Transient, "earlier crash 2");
        let classified = std::cell::Cell::new(false);

        let decision = assess_daemon_exit(Some(0), false, &mut tracker, || {
            classified.set(true);
            classify::ClassifyResult {
                class: classify::FailureClass::Transient,
                reason: "must not classify a clean exit".to_string(),
            }
        });

        assert_eq!(decision.kind, DaemonExitKind::Intentional);
        assert!(!decision.enter_fail_slow);
        assert!(!classified.get());
        assert_eq!(tracker.consecutive_transient, 0);
        assert!(!tracker.is_fail_slow());

        let current = (
            "node".to_string(),
            vec!["/bundles/v1/dist/cli.js".to_string()],
        );
        let settled = std::cell::Cell::new(false);
        let refreshed = refresh_daemon_command_for_respawn(
            true,
            decision.kind,
            &current,
            || settled.set(true),
            || {
                (
                    "node".to_string(),
                    vec!["/bundles/v2/dist/cli.js".to_string()],
                )
            },
        );

        assert_eq!(refreshed.1, vec!["/bundles/v2/dist/cli.js"]);
        assert!(!settled.get());
    }

    #[test]
    fn nonzero_and_signal_exits_remain_unexpected_and_settle() {
        for exit_code in [Some(1), None] {
            let mut tracker = classify::FailureTracker::new();
            let decision = assess_daemon_exit(exit_code, false, &mut tracker, || {
                classify::ClassifyResult {
                    class: classify::FailureClass::Transient,
                    reason: "unexpected child exit".to_string(),
                }
            });

            assert_eq!(decision.kind, DaemonExitKind::Unexpected);
            assert!(!decision.enter_fail_slow);
            assert_eq!(tracker.consecutive_transient, 1);

            let current = (
                "node".to_string(),
                vec!["/bundles/v1/dist/cli.js".to_string()],
            );
            let settled = std::cell::Cell::new(false);
            let _ = refresh_daemon_command_for_respawn(
                true,
                decision.kind,
                &current,
                || settled.set(true),
                || current.clone(),
            );
            assert!(settled.get(), "exit_code={exit_code:?} must settle");
        }
    }

    #[test]
    fn three_consecutive_clean_ota_exits_never_enter_fail_slow() {
        let mut tracker = classify::FailureTracker::new();
        let settled = std::cell::Cell::new(0);
        let current = (
            "node".to_string(),
            vec!["/bundles/current/dist/cli.js".to_string()],
        );

        for _ in 0..3 {
            let decision = assess_daemon_exit(Some(0), false, &mut tracker, || {
                panic!("clean OTA exit must not be classified as a failure")
            });
            assert_eq!(decision.kind, DaemonExitKind::Intentional);
            assert!(!decision.enter_fail_slow);
            let _ = refresh_daemon_command_for_respawn(
                true,
                decision.kind,
                &current,
                || settled.set(settled.get() + 1),
                || current.clone(),
            );
        }

        assert_eq!(tracker.consecutive_transient, 0);
        assert!(!tracker.is_fail_slow());
        assert_eq!(settled.get(), 0);
    }

    #[test]
    fn command_channel_restart_remains_intentional_for_nonzero_exit() {
        let mut tracker = classify::FailureTracker::new();
        tracker.record(classify::FailureClass::Transient, "earlier crash");

        let decision = assess_daemon_exit(Some(143), true, &mut tracker, || {
            panic!("command-channel restart must not be classified as a failure")
        });

        assert_eq!(decision.kind, DaemonExitKind::Intentional);
        assert!(!decision.enter_fail_slow);
        assert_eq!(tracker.consecutive_transient, 0);
    }

    #[test]
    fn managed_runtime_is_resolved_again_before_respawn() {
        let current = (
            "node".to_string(),
            vec!["/bundles/v1/dist/cli.js".to_string()],
        );
        let settled = std::cell::Cell::new(false);
        let refreshed = refresh_daemon_command_for_respawn(
            true,
            DaemonExitKind::Unexpected,
            &current,
            || settled.set(true),
            || {
                (
                    "node".to_string(),
                    vec!["/bundles/v2/dist/cli.js".to_string()],
                )
            },
        );

        assert_eq!(refreshed.1, vec!["/bundles/v2/dist/cli.js"]);
        assert!(settled.get());
    }

    #[test]
    fn intentional_managed_restart_resolves_without_striking_current_boot() {
        let current = (
            "node".to_string(),
            vec!["/bundles/v1/dist/cli.js".to_string()],
        );
        let settled = std::cell::Cell::new(false);
        let refreshed = refresh_daemon_command_for_respawn(
            true,
            DaemonExitKind::Intentional,
            &current,
            || settled.set(true),
            || {
                (
                    "node".to_string(),
                    vec!["/bundles/v2/dist/cli.js".to_string()],
                )
            },
        );

        assert_eq!(refreshed.1, vec!["/bundles/v2/dist/cli.js"]);
        assert!(!settled.get());
    }

    #[test]
    fn explicit_rescue_command_is_not_replaced_during_respawn() {
        let current = ("/opt/rescue".to_string(), vec!["--serve".to_string()]);
        let resolver_called = std::cell::Cell::new(false);
        let settle_called = std::cell::Cell::new(false);
        let refreshed = refresh_daemon_command_for_respawn(
            false,
            DaemonExitKind::Unexpected,
            &current,
            || settle_called.set(true),
            || {
                resolver_called.set(true);
                (
                    "node".to_string(),
                    vec!["/bundles/v2/dist/cli.js".to_string()],
                )
            },
        );

        assert_eq!(refreshed, current);
        assert!(!settle_called.get());
        assert!(!resolver_called.get());
    }

    /// slow_ms parameter passed directly — no env read inside the function.
    /// Eliminates the process-global env race that occurred when multiple
    /// tests ran in parallel and called set_var/remove_var concurrently.
    #[test]
    fn test_disk_cleanup_slow_env_respected() {
        let start = std::time::Instant::now();
        let cmd = cmd::Command {
            id: "test-slow".to_string(),
            action: "disk_cleanup".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };
        let result = execute_disk_cleanup(&cmd, "now", 500);
        let elapsed = start.elapsed();

        assert!(
            result.status == "ok",
            "disk_cleanup with slow should succeed"
        );
        assert!(
            elapsed >= std::time::Duration::from_millis(500),
            "should have slept at least 500ms, got {:?}",
            elapsed
        );
    }

    #[test]
    fn test_disk_cleanup_no_slow_env() {
        let start = std::time::Instant::now();
        let cmd = cmd::Command {
            id: "test-fast".to_string(),
            action: "disk_cleanup".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };
        let result = execute_disk_cleanup(&cmd, "now", 0);
        let elapsed = start.elapsed();

        assert!(result.status == "ok", "disk_cleanup should succeed");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "without slow env should complete quickly, got {:?}",
            elapsed
        );
    }

    #[test]
    fn test_restart_command_delegates_respawn_to_monitor() {
        let command = cmd::Command {
            id: "restart-test".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };
        let state = Arc::new(DaemonState {
            pid: Mutex::new(0),
            alive: std::sync::atomic::AtomicBool::new(false),
            restart_requested: std::sync::atomic::AtomicBool::new(false),
        });

        let result = execute_restart_daemon(&command, &state, "now");

        assert_eq!(result.status, "ok");
        assert!(state
            .restart_requested
            .load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(result.result["old_pid"], 0);
    }

    /// Verify the timeout wrapper produces a timeout result when an action
    /// takes longer than the recv_timeout. Uses the parameterized slow_ms
    /// (no env manipulation). The recv_timeout branch is replicated inline
    /// because process_command has a hardcoded 30s timeout — impractical for
    /// a unit test. The real timeout path (30s deadline → process_command
    /// writes error to res.json) is covered by the container E2E test
    /// test-manager-s2.sh E7 case.
    #[test]
    fn test_action_timeout_produces_error_result() {
        let cmd = cmd::Command {
            id: "test-timeout".to_string(),
            action: "disk_cleanup".to_string(),
            params: serde_json::Value::Null,
            timestamp: "".to_string(),
        };

        let cmd_for_thread = cmd.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        // Pass slow_ms=5000 directly — sleeps 5s which exceeds the 200ms recv_timeout
        thread::spawn(move || {
            let r = execute_disk_cleanup(&cmd_for_thread, "now", 5000);
            let _ = tx.send(r);
        });

        // Use 200ms timeout to force the timeout path
        let result = match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(r) => r,
            Err(_) => cmd::CommandResult {
                id: "test-timeout".to_string(),
                status: "error".to_string(),
                result: serde_json::Value::Null,
                completed_at: "timeout".to_string(),
                error: Some("Action timed out after 200ms".to_string()),
            },
        };

        assert_eq!(result.status, "error");
        assert!(result.error.unwrap().contains("timed out"));
    }
}
