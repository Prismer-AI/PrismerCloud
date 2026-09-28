// cmd.rs — Command channel (Y-channel file queue, 09 §3.5)
//
// Design: docs/product209/09-resident-sandbox-manager.md §3.5
//
// Inbound: cloud → sandbox via sandbox-gateway files.write → /var/run/sandbox/cmd.json
// Manager watches cmd.json with inotify → validates whitelist → executes → writes res.json
// Outbound: cloud reads /var/run/sandbox/res.json via sandbox-gateway files.read
//
// Idempotency: commands carry an id. Same id replayed returns cached result.
// Trust: files are injected by sandbox-gateway with cloud-side token (same as 07 §3.7.3).
//
// White-list actions (v1, 09 §3.6):
//   - rollback_config  — restore config from backup point
//   - ota_rollback     — switch to previous OTA version
//   - restart_daemon   — request monitor-owned SIGTERM/SIGKILL + respawn
//   - diag_bundle      — read-only pack: config/logs/health/resources
//   - disk_cleanup     — clean whitelisted paths

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Types ──────────────────────────────────────────────────────────────

/// Inbound command from cloud side.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Command {
    /// Unique command id for idempotency.
    pub id: String,
    /// Action name (must be in whitelist).
    pub action: String,
    /// Optional parameters for the action.
    #[serde(default)]
    pub params: serde_json::Value,
    /// ISO 8601 timestamp from cloud side.
    #[serde(default)]
    pub timestamp: String,
}

/// Outbound result written to res.json.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandResult {
    /// Echo of the command id.
    pub id: String,
    /// "ok" or "error"
    pub status: String,
    /// Structured result data (action-specific).
    #[serde(default)]
    pub result: serde_json::Value,
    /// ISO 8601 completion timestamp.
    #[serde(rename = "completedAt")]
    pub completed_at: String,
    /// Error message if status is "error".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// White-listed action names (v1, 09 §3.6).
const WHITELIST: &[&str] = &[
    "rollback_config",
    "ota_rollback",
    "restart_daemon",
    "diag_bundle",
    "disk_cleanup",
];

// ── Result cache (idempotency) ─────────────────────────────────────────

/// Global cache of command results keyed by command id.
/// Wrapped in Mutex for thread-safe access from the inotify handler.
pub struct ResultCache {
    cache: Mutex<HashMap<String, CommandResult>>,
}

impl ResultCache {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, id: &str) -> Option<CommandResult> {
        let cache = self.cache.lock().unwrap();
        cache.get(id).cloned()
    }

    pub fn set(&self, id: &str, result: CommandResult) {
        let mut cache = self.cache.lock().unwrap();
        cache.insert(id.to_string(), result);
    }

    #[cfg(test)]
    pub fn clear(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.clear();
    }
}

// ── File paths ─────────────────────────────────────────────────────────

/// Base directory for command channel files.
pub fn cmd_dir() -> PathBuf {
    PathBuf::from("/var/run/sandbox")
}

fn cmd_file() -> PathBuf {
    cmd_dir().join("cmd.json")
}

fn res_file() -> PathBuf {
    cmd_dir().join("res.json")
}

// ── Validation ─────────────────────────────────────────────────────────

/// Check if an action is in the whitelist.
pub fn is_action_whitelisted(action: &str) -> bool {
    WHITELIST.contains(&action)
}

/// Validate a command JSON structure.
pub fn parse_command(data: &str) -> Result<Command, String> {
    let cmd: Command =
        serde_json::from_str(data).map_err(|e| format!("Invalid command JSON: {}", e))?;

    if cmd.id.is_empty() {
        return Err("Command missing 'id' field".to_string());
    }
    if cmd.action.is_empty() {
        return Err("Command missing 'action' field".to_string());
    }
    if !is_action_whitelisted(&cmd.action) {
        return Err(format!("Action '{}' not in whitelist", cmd.action));
    }

    Ok(cmd)
}

fn canonical_timestamp_parts(value: &str) -> Option<(u32, u32, u32, u32, u32, u32, u32)> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return None;
    }
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.get(19) != Some(&b'.')
        || bytes.get(23) != Some(&b'Z')
    {
        return None;
    }

    let digits = |start: usize, end: usize| -> Option<u32> {
        let part = value.get(start..end)?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let year = digits(0, 4)?;
    let month = digits(5, 7)?;
    let day = digits(8, 10)?;
    let hour = digits(11, 13)?;
    let minute = digits(14, 16)?;
    let second = digits(17, 19)?;
    let millisecond = digits(20, 23)?;
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    Some((year, month, day, hour, minute, second, millisecond))
}

fn result_is_fresh_for_command(command: &Command, result: &CommandResult) -> bool {
    if result.id != command.id || (result.status != "ok" && result.status != "error") {
        return false;
    }
    matches!(
        (
            canonical_timestamp_parts(&command.timestamp),
            canonical_timestamp_parts(&result.completed_at),
        ),
        (Some(command_at), Some(completed_at)) if completed_at >= command_at
    )
}

// ── Command file operations ────────────────────────────────────────────

/// Read and parse the current cmd.json file.
/// Returns None if file doesn't exist or is unreadable.
pub fn read_command() -> Option<Command> {
    let content = fs::read_to_string(cmd_file()).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    parse_command(&content).ok()
}

/// Validate a persisted command result before it is allowed to suppress a
/// command after a manager restart.
pub fn parse_result(data: &str) -> Result<CommandResult, String> {
    let result: CommandResult =
        serde_json::from_str(data).map_err(|e| format!("Invalid command result JSON: {}", e))?;

    if result.id.is_empty() {
        return Err("Command result missing 'id' field".to_string());
    }
    if result.status != "ok" && result.status != "error" {
        return Err(format!("Invalid command result status: {}", result.status));
    }
    if canonical_timestamp_parts(&result.completed_at).is_none() {
        return Err("Command result has invalid 'completedAt' field".to_string());
    }

    Ok(result)
}

/// Read and validate the last durable command result.
pub fn read_result() -> Option<CommandResult> {
    let content = fs::read_to_string(res_file()).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    parse_result(&content).ok()
}

/// Accept a command only when this manager process has not already completed
/// the same id.
pub fn uncached_command(candidate: Option<Command>, cache: &ResultCache) -> Option<Command> {
    let command = candidate?;
    if let Some(result) = cache.get(&command.id) {
        if result_is_fresh_for_command(&command, &result) {
            return None;
        }
    }
    Some(command)
}

/// Hydrate a fresh manager cache from an exact durable result before deciding
/// whether a pre-existing cmd.json still needs execution.
pub fn recover_startup_command(
    candidate: Option<Command>,
    persisted_result: Option<CommandResult>,
    cache: &ResultCache,
) -> Option<Command> {
    let command = candidate?;
    if let Some(result) = persisted_result {
        if result_is_fresh_for_command(&command, &result) {
            cache.set(&command.id, result);
            return None;
        }
    }
    uncached_command(Some(command), cache)
}

/// Write result to res.json (atomic: write to temp, rename).
pub fn write_result(result: &CommandResult) -> io::Result<()> {
    let dir = cmd_dir();
    fs::create_dir_all(&dir)?;

    let target = res_file();
    let tmp = format!("{}.tmp", target.display());
    let data =
        serde_json::to_string(result).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp, &data)?;
    fs::rename(&tmp, &target)?;
    Ok(())
}

// ── Command watcher ────────────────────────────────────────────────────
//
// Design (09 §3.5): inotify on /var/run/sandbox/cmd.json for immediate
// command detection. Deployment target is Linux musl containers.
//
// On Linux: primary path uses inotify (real-time, zero-latency).
// On macOS: inotify crate doesn't compile (kcmp syscall Linux-only),
//           so dev uses mtime polling at 1s intervals.
//
// Both paths: poll() is always available as a fallback. Inotify functions
// are #[cfg(target_os = "linux")] only.

use std::time::{Duration, SystemTime};

/// Poll for a new command via mtime comparison.
/// Always available — used as primary on macOS, fallback on Linux.
pub fn poll_command(last_mtime: &mut Option<SystemTime>, cache: &ResultCache) -> Option<Command> {
    let path = cmd_file();
    let current_mtime = match fs::metadata(&path) {
        Ok(meta) => meta.modified().ok(),
        Err(_) => None,
    };

    let mtime = current_mtime?;

    if let Some(last) = last_mtime {
        if mtime <= *last {
            return None;
        }
    }
    *last_mtime = Some(mtime);

    uncached_command(read_command(), cache)
}

/// Poll interval (1s — commands are infrequent).
pub const POLL_INTERVAL: Duration = Duration::from_secs(1);

// ── Linux inotify (primary path on deployment target) ─────────────────

#[cfg(target_os = "linux")]
pub mod inotify_watcher {
    use super::*;
    use inotify::{Inotify, WatchMask};
    use std::io;

    /// Start an inotify watcher on /var/run/sandbox/.
    /// Watches the directory to handle atomic rename (temp → cmd.json).
    pub fn init() -> io::Result<Inotify> {
        let inotify = Inotify::init()?;
        let dir = cmd_dir();
        fs::create_dir_all(&dir)?;
        inotify
            .watches()
            .add(&dir, WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO)?;
        Ok(inotify)
    }

    /// Check for new commands via inotify.
    /// The `read_events` takes `&mut self` on the internal fd set,
    /// so we pass `&mut Inotify`.
    pub fn check(inotify: &mut Inotify, cache: &ResultCache) -> Option<Command> {
        let mut buffer = [0u8; 4096];
        let events = match inotify.read_events(&mut buffer) {
            Ok(events) => events,
            Err(_) => return None,
        };

        for event in events {
            let name = event.name.and_then(|n| n.to_str()).unwrap_or("");
            if name != "cmd.json" {
                continue;
            }

            if let Some(command) = uncached_command(read_command(), cache) {
                return Some(command);
            }
        }

        None
    }

    /// Wait interval between inotify reads when no events arrive.
    pub const WATCH_SLEEP: Duration = Duration::from_millis(500);
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_command_valid() {
        let json =
            r#"{"id":"cmd-001","action":"restart_daemon","timestamp":"2026-08-07T00:00:00Z"}"#;
        let cmd = parse_command(json).unwrap();
        assert_eq!(cmd.id, "cmd-001");
        assert_eq!(cmd.action, "restart_daemon");
    }

    #[test]
    fn test_parse_command_missing_id() {
        let json = r#"{"action":"restart_daemon"}"#;
        assert!(parse_command(json).is_err());
    }

    #[test]
    fn test_parse_command_not_whitelisted() {
        let json = r#"{"id":"cmd-002","action":"delete_everything"}"#;
        assert!(parse_command(json).is_err());
    }

    #[test]
    fn test_parse_command_invalid_json() {
        assert!(parse_command("not json").is_err());
    }

    #[test]
    fn test_whitelist_contains_required_actions() {
        assert!(is_action_whitelisted("rollback_config"));
        assert!(is_action_whitelisted("ota_rollback"));
        assert!(is_action_whitelisted("restart_daemon"));
        assert!(is_action_whitelisted("diag_bundle"));
        assert!(is_action_whitelisted("disk_cleanup"));
    }

    #[test]
    fn test_whitelist_rejects_unknown() {
        assert!(!is_action_whitelisted("rm -rf /"));
        assert!(!is_action_whitelisted(""));
        assert!(!is_action_whitelisted("random_action"));
    }

    #[test]
    fn test_result_cache_get_set() {
        let cache = ResultCache::new();
        assert!(cache.get("cmd-1").is_none());

        let result = CommandResult {
            id: "cmd-1".to_string(),
            status: "ok".to_string(),
            result: serde_json::json!({"restarted": true}),
            completed_at: "2026-08-07T00:00:00Z".to_string(),
            error: None,
        };
        cache.set("cmd-1", result);

        let cached = cache.get("cmd-1");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().status, "ok");
    }

    #[test]
    fn test_result_cache_idempotent() {
        let cache = ResultCache::new();

        // First result
        let r1 = CommandResult {
            id: "dup".to_string(),
            status: "ok".to_string(),
            result: serde_json::json!({"count": 1}),
            completed_at: "2026-08-07T00:00:00Z".to_string(),
            error: None,
        };
        cache.set("dup", r1);

        // Attempt to set a different result for same id
        let r2 = CommandResult {
            id: "dup".to_string(),
            status: "error".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-07T00:00:01Z".to_string(),
            error: Some("different".to_string()),
        };
        cache.set("dup", r2); // overwrites

        // Cache returns last set
        let cached = cache.get("dup").unwrap();
        assert_eq!(cached.status, "error"); // last write wins
    }

    #[test]
    fn test_preexisting_command_is_consumed_once_after_watcher_start() {
        let cache = ResultCache::new();
        let command = Command {
            id: "preexisting-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::json!({"targetVersion":"2.2.11-session.n1"}),
            timestamp: "2026-08-11T02:00:00.000Z".to_string(),
        };

        assert_eq!(
            uncached_command(Some(command.clone()), &cache).unwrap().id,
            command.id
        );
        cache.set(
            &command.id,
            CommandResult {
                id: command.id.clone(),
                status: "ok".to_string(),
                result: serde_json::Value::Null,
                completed_at: "2026-08-11T02:00:01.000Z".to_string(),
                error: None,
            },
        );
        assert!(uncached_command(Some(command), &cache).is_none());
    }

    #[test]
    fn test_live_cache_replays_a_newer_same_id_command() {
        let cache = ResultCache::new();
        let command = Command {
            id: "live-reused-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "2026-08-11T02:00:00.456Z".to_string(),
        };
        cache.set(
            &command.id,
            CommandResult {
                id: command.id.clone(),
                status: "ok".to_string(),
                result: serde_json::Value::Null,
                completed_at: "2026-08-11T02:00:00.123Z".to_string(),
                error: None,
            },
        );

        assert_eq!(
            uncached_command(Some(command.clone()), &cache).unwrap().id,
            command.id
        );
    }

    #[test]
    fn test_live_cache_replays_same_id_when_a_timestamp_is_malformed() {
        let cache = ResultCache::new();
        let command = Command {
            id: "live-malformed-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "2026-08-11T02:00:00.456Z".to_string(),
        };
        cache.set(
            &command.id,
            CommandResult {
                id: command.id.clone(),
                status: "ok".to_string(),
                result: serde_json::Value::Null,
                completed_at: "not-a-timestamp".to_string(),
                error: None,
            },
        );

        assert_eq!(
            uncached_command(Some(command.clone()), &cache).unwrap().id,
            command.id
        );
    }

    #[test]
    fn test_new_manager_cache_does_not_replay_completed_persisted_command() {
        let cache = ResultCache::new();
        let command = Command {
            id: "persisted-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::json!({"targetVersion":"2.2.11-session.n1"}),
            timestamp: "2026-08-11T02:00:00.000Z".to_string(),
        };
        let completed = CommandResult {
            id: command.id.clone(),
            status: "ok".to_string(),
            result: serde_json::json!({"restart_requested":true}),
            completed_at: "2026-08-11T02:00:01.000Z".to_string(),
            error: None,
        };

        assert!(cache.get(&command.id).is_none());
        assert!(
            recover_startup_command(Some(command.clone()), Some(completed.clone()), &cache)
                .is_none()
        );
        assert_eq!(
            cache.get(&command.id).unwrap().completed_at,
            completed.completed_at
        );
    }

    #[test]
    fn test_startup_recovery_ignores_a_result_for_another_command() {
        let cache = ResultCache::new();
        let command = Command {
            id: "pending-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "2026-08-11T02:00:00Z".to_string(),
        };
        let completed = CommandResult {
            id: "older-restart".to_string(),
            status: "ok".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-11T01:59:59.000Z".to_string(),
            error: None,
        };

        assert_eq!(
            recover_startup_command(Some(command.clone()), Some(completed), &cache)
                .unwrap()
                .id,
            command.id
        );
        assert!(cache.get(&command.id).is_none());
    }

    #[test]
    fn test_new_manager_cache_replays_a_stale_same_id_persisted_command() {
        let cache = ResultCache::new();
        let command = Command {
            id: "reused-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "2026-08-11T02:00:02.000Z".to_string(),
        };
        let stale = CommandResult {
            id: command.id.clone(),
            status: "ok".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-11T02:00:01.000Z".to_string(),
            error: None,
        };

        assert_eq!(
            recover_startup_command(Some(command.clone()), Some(stale), &cache)
                .unwrap()
                .id,
            command.id
        );
        assert!(cache.get(&command.id).is_none());
    }

    #[test]
    fn test_new_manager_cache_replays_when_same_id_timestamps_are_malformed() {
        let cache = ResultCache::new();
        let command = Command {
            id: "malformed-time-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "not-a-timestamp".to_string(),
        };
        let completed = CommandResult {
            id: command.id.clone(),
            status: "ok".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-11T02:00:01.000Z".to_string(),
            error: None,
        };

        assert_eq!(
            recover_startup_command(Some(command.clone()), Some(completed), &cache)
                .unwrap()
                .id,
            command.id
        );
        assert!(cache.get(&command.id).is_none());

        let cache = ResultCache::new();
        let command = Command {
            id: "malformed-result-time-restart".to_string(),
            action: "restart_daemon".to_string(),
            params: serde_json::Value::Null,
            timestamp: "2026-08-11T02:00:00.000Z".to_string(),
        };
        let completed = CommandResult {
            id: command.id.clone(),
            status: "ok".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-11 02:00:01Z".to_string(),
            error: None,
        };

        assert_eq!(
            recover_startup_command(Some(command.clone()), Some(completed), &cache)
                .unwrap()
                .id,
            command.id
        );
        assert!(cache.get(&command.id).is_none());
    }

    #[test]
    fn test_parse_result_rejects_invalid_status_or_missing_completion_time() {
        assert!(parse_result(
            r#"{"id":"completed","status":"pending","result":null,"completedAt":"2026-08-11T02:00:01Z"}"#
        )
        .is_err());
        assert!(
            parse_result(r#"{"id":"completed","status":"ok","result":null,"completedAt":""}"#)
                .is_err()
        );
        assert!(parse_result(
            r#"{"id":"completed","status":"ok","result":null,"completedAt":"2026-08-11T02:00:01Z"}"#
        )
        .is_err());
    }

    #[test]
    fn test_result_cache_clear() {
        let cache = ResultCache::new();
        cache.set(
            "c1",
            CommandResult {
                id: "c1".to_string(),
                status: "ok".to_string(),
                result: serde_json::Value::Null,
                completed_at: "2026-08-07T00:00:00Z".to_string(),
                error: None,
            },
        );
        cache.clear();
        assert!(cache.get("c1").is_none());
    }

    #[test]
    fn test_write_and_read_result() {
        // Serialization/deserialization roundtrip
        let result = CommandResult {
            id: "test-1".to_string(),
            status: "ok".to_string(),
            result: serde_json::json!({"files_restored": ["config.yaml"]}),
            completed_at: "2026-08-07T00:00:00Z".to_string(),
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: CommandResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "test-1");
        assert_eq!(parsed.status, "ok");
        assert_eq!(parsed.error, None);
    }

    #[test]
    fn test_write_result_with_error() {
        let result = CommandResult {
            id: "fail-1".to_string(),
            status: "error".to_string(),
            result: serde_json::Value::Null,
            completed_at: "2026-08-07T00:00:00Z".to_string(),
            error: Some("No backup found".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: CommandResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.status, "error");
        assert_eq!(parsed.error, Some("No backup found".to_string()));
    }

    // ISO8601 format tests are in util.rs
}
