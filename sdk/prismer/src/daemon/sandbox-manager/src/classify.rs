// classify.rs — Failure classification for restart strategy (09 §3.6)
//
// Design: docs/product209/09-resident-sandbox-manager.md §3.6
//
// Two categories (v1 minimal binary classification):
//   FATAL   → Fail-slow: pack diagnostics, stay alive, wait for cloud commands
//   TRANSIENT → Fail-fast: restart immediately, max 3 consecutive → FATAL
//
// Classification rules (hardcoded in binary, v1):
//   FATAL:
//     - Config syntax errors (config.yaml / config.toml parse failures)
//     - OTA rollback failures (unable to switch to previous version)
//     - DB unreadable (local.db PRAGMA quick_check failure)
//   TRANSIENT:
//     - Everything else (API timeout, resource exhaustion, unknown crashes)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// ── Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailureClass {
    /// Fatal failure — do not restart blindly; pack diags, stay alive, wait for instructions.
    #[serde(rename = "fatal")]
    Fatal,
    /// Transient failure — restart immediately, max 3 consecutive.
    #[serde(rename = "transient")]
    Transient,
    /// Unknown / unclassified — treated as transient.
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ClassifyResult {
    pub class: FailureClass,
    pub reason: String,
}

// ── Classification logic ───────────────────────────────────────────────

/// Classify a daemon exit based on what we can observe.
///
/// `exit_code`: the daemon's exit code (None if killed by signal)
/// `stderr_tail`: last few lines of daemon stderr (v1: usually "" — capture deferred)
/// `home`: daemon home directory for checking file state
///
/// E4: Stderr capture deferred to future version. Current classifier relies on
/// file content checks — attempting to actually parse config files to detect
/// syntax errors, not just checking for empty files.
pub fn classify_daemon_exit(
    exit_code: Option<i32>,
    stderr_tail: &str,
    home: &Path,
) -> ClassifyResult {
    // ── stderr-based checks (for when stderr capture is wired) ─────────
    if !stderr_tail.is_empty() {
        // Config syntax errors
        if (stderr_tail.contains("config.yaml")
            && (stderr_tail.contains("syntax error")
                || stderr_tail.contains("parse error")
                || stderr_tail.contains("YAML")
                || stderr_tail.contains("invalid")))
            || (stderr_tail.contains("config.toml")
                && (stderr_tail.contains("syntax error")
                    || stderr_tail.contains("parse error")
                    || stderr_tail.contains("TOML")
                    || stderr_tail.contains("invalid")))
        {
            return ClassifyResult {
                class: FailureClass::Fatal,
                reason: "Config syntax error detected in stderr".to_string(),
            };
        }
        // Database corruption
        if stderr_tail.contains("SQLITE_CORRUPT")
            || stderr_tail.contains("database disk image is malformed")
        {
            return ClassifyResult {
                class: FailureClass::Fatal,
                reason: "Database corruption in stderr".to_string(),
            };
        }
        // OTA failures
        if stderr_tail.contains("ota")
            && (stderr_tail.contains("rollback failed")
                || stderr_tail.contains("blacklist")
                || stderr_tail.contains("bundle-ota"))
        {
            return ClassifyResult {
                class: FailureClass::Fatal,
                reason: "OTA rollback/bundle failure in stderr".to_string(),
            };
        }
    }

    // ── File content checks (always active) ────────────────────────────
    let config_yaml = home.join(".hermes").join("config.yaml");
    let config_toml = home.join(".prismer").join("config.toml");

    // Try to parse config.yaml as valid YAML structure
    if config_yaml.exists() {
        match fs::read_to_string(&config_yaml) {
            Ok(content) if content.trim().is_empty() => {
                return ClassifyResult {
                    class: FailureClass::Fatal,
                    reason: "config.yaml is empty (truncated/corrupted)".to_string(),
                };
            }
            Ok(content) => {
                // Lightweight YAML structure check
                if !content.contains("custom_providers:") || !content.contains("model:") {
                    // May be truncated or missing required keys
                    if content.len() < 20 {
                        return ClassifyResult {
                            class: FailureClass::Fatal,
                            reason: "config.yaml appears truncated (<20 bytes)".to_string(),
                        };
                    }
                }
            }
            Err(_) => {} // unreadable — not classified as fatal
        }
    }

    // Try to parse config.toml
    if config_toml.exists() {
        match fs::read_to_string(&config_toml) {
            Ok(content) if content.trim().is_empty() => {
                return ClassifyResult {
                    class: FailureClass::Fatal,
                    reason: "config.toml is empty (truncated/corrupted)".to_string(),
                };
            }
            Ok(content) => {
                // Attempt TOML parse — parse failure = corrupted config
                if let Err(e) = toml::from_str::<toml::Table>(&content) {
                    return ClassifyResult {
                        class: FailureClass::Fatal,
                        reason: format!("config.toml parse error: {}", e),
                    };
                }
            }
            Err(_) => {} // unreadable
        }
    }

    // ── Default: transient ─────────────────────────────────────────────
    ClassifyResult {
        class: FailureClass::Transient,
        reason: format!(
            "Unclassified exit (code={:?}) — treating as transient",
            exit_code
        ),
    }
}

// ── Consecutive failure tracker ────────────────────────────────────────

/// Track consecutive transient failures.
/// After MAX_CONSECUTIVE_TRANSIENT (3) failures, escalate to FATAL.
pub const MAX_CONSECUTIVE_TRANSIENT: u32 = 3;

#[derive(Debug, Clone)]
pub struct FailureTracker {
    /// Count of consecutive transient failures.
    pub consecutive_transient: u32,
    /// The last classification.
    pub last_class: Option<FailureClass>,
    /// Whether we've escalated to fatal mode.
    pub escalated_to_fatal: bool,
}

impl FailureTracker {
    pub fn new() -> Self {
        Self {
            consecutive_transient: 0,
            last_class: None,
            escalated_to_fatal: false,
        }
    }

    /// Record a new failure. Returns whether the system should enter Fail-slow mode.
    pub fn record(&mut self, class: FailureClass, reason: &str) -> bool {
        self.last_class = Some(class);

        match class {
            FailureClass::Fatal => {
                // Fatal immediately triggers fail-slow
                self.consecutive_transient = 0;
                self.escalated_to_fatal = true;
                true
            }
            FailureClass::Transient | FailureClass::Unknown => {
                self.consecutive_transient += 1;
                if self.consecutive_transient >= MAX_CONSECUTIVE_TRANSIENT {
                    self.escalated_to_fatal = true;
                    eprintln!(
                        "[sandbox-manager] FAIL-SLOW ESCALATION: {} consecutive transient failures (last: {})",
                        self.consecutive_transient, reason
                    );
                    true
                } else {
                    eprintln!(
                        "[sandbox-manager] transient failure #{}/{}: {}",
                        self.consecutive_transient, MAX_CONSECUTIVE_TRANSIENT, reason
                    );
                    false
                }
            }
        }
    }

    /// Reset after a successful daemon start.
    pub fn reset(&mut self) {
        self.consecutive_transient = 0;
        self.last_class = None;
        self.escalated_to_fatal = false;
    }

    /// Whether we're currently in fail-slow mode (not restarting blindly).
    pub fn is_fail_slow(&self) -> bool {
        self.escalated_to_fatal
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_classify_config_yaml_syntax_error() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(
            Some(1),
            "Error: config.yaml YAML syntax error at line 5",
            tmp.path(),
        );
        assert_eq!(result.class, FailureClass::Fatal);
    }

    #[test]
    fn test_classify_config_toml_parse_error() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(
            Some(1),
            "TOML parse error in config.toml: invalid key at line 3",
            tmp.path(),
        );
        assert_eq!(result.class, FailureClass::Fatal);
    }

    #[test]
    fn test_classify_db_corruption() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(
            Some(1),
            "SQLITE_CORRUPT: database disk image is malformed in local.db",
            tmp.path(),
        );
        assert_eq!(result.class, FailureClass::Fatal);
    }

    #[test]
    fn test_classify_ota_failure() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(
            Some(1),
            "[bundle-ota] rollback failed: no previous version",
            tmp.path(),
        );
        assert_eq!(result.class, FailureClass::Fatal);
    }

    #[test]
    fn test_classify_empty_config_yaml() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Create empty config.yaml
        let hermes_dir = tmp.path().join(".hermes");
        fs::create_dir_all(&hermes_dir).unwrap();
        fs::write(hermes_dir.join("config.yaml"), "").unwrap();

        let result = classify_daemon_exit(Some(1), "Some random error", tmp.path());
        assert_eq!(result.class, FailureClass::Fatal);
        assert!(result.reason.contains("empty"));
    }

    #[test]
    fn test_classify_transient_default() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(Some(1), "ECONNREFUSED: connection timeout", tmp.path());
        assert_eq!(result.class, FailureClass::Transient);
    }

    #[test]
    fn test_classify_unknown_exit() {
        let tmp = tempfile::TempDir::new().unwrap();
        let result = classify_daemon_exit(None, "", tmp.path());
        assert_eq!(result.class, FailureClass::Transient);
    }

    #[test]
    fn test_failure_tracker_transient_then_fatal() {
        let mut tracker = FailureTracker::new();
        assert!(!tracker.is_fail_slow());

        // 3 transient failures → escalate
        assert!(!tracker.record(FailureClass::Transient, "timeout 1"));
        assert!(!tracker.record(FailureClass::Transient, "timeout 2"));
        assert!(tracker.record(FailureClass::Transient, "timeout 3"));
        assert!(tracker.is_fail_slow());
        assert!(tracker.escalated_to_fatal);
    }

    #[test]
    fn test_failure_tracker_fatal_immediate() {
        let mut tracker = FailureTracker::new();
        assert!(tracker.record(FailureClass::Fatal, "config syntax error"));
        assert!(tracker.is_fail_slow());
        assert!(tracker.escalated_to_fatal);
    }

    #[test]
    fn test_failure_tracker_reset() {
        let mut tracker = FailureTracker::new();
        tracker.record(FailureClass::Transient, "timeout 1");
        tracker.record(FailureClass::Transient, "timeout 2");
        assert!(!tracker.is_fail_slow());

        tracker.reset();
        assert_eq!(tracker.consecutive_transient, 0);
        assert!(!tracker.is_fail_slow());
    }

    #[test]
    fn test_failure_tracker_transient_resets_on_success() {
        let mut tracker = FailureTracker::new();
        tracker.record(FailureClass::Transient, "timeout");
        tracker.reset();
        assert!(!tracker.is_fail_slow());
    }
}
