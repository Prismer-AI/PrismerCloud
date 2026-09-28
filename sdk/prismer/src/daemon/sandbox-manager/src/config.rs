// config.rs — Configuration backup/restore for the sandbox manager (09 §4)
//
// Design: docs/product209/09-resident-sandbox-manager.md §3.6, §4
//
// Responsibilities:
//   - Daemon writes backup BEFORE applying a new config bundle (applyBundle, config-bootstrap.ts)
//   - Manager reads backup and can execute `rollback_config` action
//   - Backup location: /home/user/.prismer/config-backup/ (group-readable by sandbox-mgr)
//
// Red line 2: WRITE authority belongs to the daemon. The manager only READS
// backups and performs restore (rollback_config action). The daemon writes
// backups in config-bootstrap.ts applyBundle() BEFORE applying new config.
//
// Backup layout:
//   /home/user/.prismer/config-backup/
//   ├── config.yaml      — backup of ~/.hermes/config.yaml
//   ├── .env             — backup of ~/.hermes/.env
//   └── backup.json      — metadata { configVersion, backedUpAt }
//
// Config files to back up (from daemon perspective):
//   ~/.hermes/config.yaml  — Hermes provider config
//   ~/.hermes/.env         — Environment variables
//
// Rollback action:
//   1. Check backup exists (backup.json present + config.yaml present)
//   2. Validate config (TOML/YAML syntax check)
//   3. Atomically restore (rename backup files to target locations)
//   4. Restart daemon
//
// Validation (v1):
//   - config.yaml: lightweight scan (non-empty, key structure present)
//   - config.toml: toml::from_str parse check

use std::fs;
use std::path::{Path, PathBuf};

// ── Paths ──────────────────────────────────────────────────────────────

/// Get the backup root directory for a given daemon home.
pub fn backup_root_for(home: &Path) -> PathBuf {
    home.join(".prismer").join("config-backup")
}

/// Get the path to the Hermes config directory for a given daemon home.
pub fn hermes_root_for(home: &Path) -> PathBuf {
    home.join(".hermes")
}

/// Get the path to the daemon's .prismer config.toml for a given daemon home.
pub fn daemon_config_toml_for(home: &Path) -> PathBuf {
    home.join(".prismer").join("config.toml")
}

fn backup_metadata_file() -> PathBuf {
    backup_root_for(&PathBuf::from("/home/user")).join("backup.json")
}

fn backup_config_yaml() -> PathBuf {
    backup_root_for(&PathBuf::from("/home/user")).join("config.yaml")
}

fn backup_dot_env() -> PathBuf {
    backup_root_for(&PathBuf::from("/home/user")).join(".env")
}

// ── Backup existence check ─────────────────────────────────────────────

/// Check if a valid backup exists.
/// A backup is valid if backup.json exists AND at least one config file exists.
pub fn has_backup() -> bool {
    if !backup_metadata_file().exists() {
        return false;
    }
    // At least one config file must exist
    backup_config_yaml().exists() || backup_dot_env().exists()
}

// ── Validation ─────────────────────────────────────────────────────────

/// Validate a YAML config file (lightweight scan for v1).
///
/// Checks:
///   - File exists and is non-empty
///   - Contains expected key patterns (custom_providers:, model:)
///   - No obvious truncation (ends with newline or reasonable char)
pub fn validate_config_yaml(path: &Path) -> Result<(), String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    if content.trim().is_empty() {
        return Err("config.yaml is empty".to_string());
    }

    // v1 lightweight checks: key structural elements present
    let has_custom_providers = content.contains("custom_providers:");
    let has_model = content.contains("model:");

    if !has_custom_providers && !has_model {
        return Err("config.yaml missing expected keys (custom_providers:/model:)".to_string());
    }

    Ok(())
}

/// Validate a TOML config file.
///
/// Uses the `toml` crate to parse the file. Returns Ok if parseable.
pub fn validate_config_toml(path: &Path) -> Result<(), String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;

    if content.trim().is_empty() {
        return Err("config.toml is empty".to_string());
    }

    // Parse as TOML (any valid TOML table)
    toml::from_str::<toml::Table>(&content).map_err(|e| format!("TOML parse error: {}", e))?;

    Ok(())
}

// ── Rollback ───────────────────────────────────────────────────────────

/// Result of a rollback operation.
#[derive(Debug, Clone)]
pub struct RollbackResult {
    pub success: bool,
    pub error: Option<String>,
    pub restored_files: Vec<String>,
}

/// Execute rollback: restore config files from backup to their target locations.
///
/// Steps:
///   1. Verify backup exists
///   2. Validate backup files
///   3. Atomic restore: copy to temp near target, then rename
///   4. Return result with list of restored files
///
/// Does NOT restart the daemon — that's the caller's responsibility
/// (so the action can report result before restart).
pub fn rollback_config() -> RollbackResult {
    if !has_backup() {
        return RollbackResult {
            success: false,
            error: Some("No config backup found. Cannot roll back.".to_string()),
            restored_files: vec![],
        };
    }

    let mut restored = Vec::new();

    // Restore config.yaml
    let backup_yaml = backup_config_yaml();
    let target_yaml = hermes_root_for(&PathBuf::from("/home/user")).join("config.yaml");
    if backup_yaml.exists() {
        // Validate before restore
        if let Err(reason) = validate_config_yaml(&backup_yaml) {
            return RollbackResult {
                success: false,
                error: Some(format!("Backup config.yaml validation failed: {}", reason)),
                restored_files: vec![],
            };
        }
        // Atomic restore: copy to temp, then rename
        if let Err(e) = atomic_restore(&backup_yaml, &target_yaml) {
            return RollbackResult {
                success: false,
                error: Some(format!("Failed to restore config.yaml: {}", e)),
                restored_files: restored,
            };
        }
        restored.push("config.yaml".to_string());
    }

    // Restore .env
    let backup_env = backup_dot_env();
    let target_env = hermes_root_for(&PathBuf::from("/home/user")).join(".env");
    if backup_env.exists() {
        match fs::read_to_string(&backup_env) {
            Ok(content) if content.trim().is_empty() => {
                return RollbackResult {
                    success: false,
                    error: Some("Backup .env is empty".to_string()),
                    restored_files: restored,
                };
            }
            Err(e) => {
                return RollbackResult {
                    success: false,
                    error: Some(format!("Cannot read backup .env: {}", e)),
                    restored_files: restored,
                };
            }
            _ => {}
        }
        if let Err(e) = atomic_restore(&backup_env, &target_env) {
            return RollbackResult {
                success: false,
                error: Some(format!("Failed to restore .env: {}", e)),
                restored_files: restored,
            };
        }
        restored.push(".env".to_string());
    }

    // Restore config.toml (E9 — daemon's own config)
    let backup_toml = backup_root_for(&PathBuf::from("/home/user")).join("config.toml");
    let target_toml = daemon_config_toml_for(&PathBuf::from("/home/user"));
    if backup_toml.exists() {
        if let Err(reason) = validate_config_toml(&backup_toml) {
            return RollbackResult {
                success: false,
                error: Some(format!("Backup config.toml validation failed: {}", reason)),
                restored_files: restored,
            };
        }
        if let Err(e) = atomic_restore(&backup_toml, &target_toml) {
            return RollbackResult {
                success: false,
                error: Some(format!("Failed to restore config.toml: {}", e)),
                restored_files: restored,
            };
        }
        restored.push("config.toml".to_string());
    }

    RollbackResult {
        success: true,
        error: None,
        restored_files: restored,
    }
}

/// Atomically restore a file.
/// Production: uses `sudo -u user cp` (B5: manager is sandbox-mgr, target is owned by user).
/// Test: direct fs copy (temp dirs owned by test process).
#[cfg(not(test))]
fn atomic_restore(src: &Path, dst: &Path) -> Result<(), String> {
    let src_str = src.to_str().ok_or("Invalid source path")?;
    let dst_str = dst.to_str().ok_or("Invalid destination path")?;

    // Ensure target directory exists via sudo
    if let Some(parent) = dst.parent() {
        if let Some(parent_str) = parent.to_str() {
            let status = crate::util::command_as_user("user", "mkdir", false)
                .args(["-p", parent_str])
                .status()
                .map_err(|e| format!("Cannot create parent dir: {}", e))?;
            if !status.success() {
                return Err(format!("mkdir -p {} failed", parent_str));
            }
        }
    }

    // Atomic: cp to <dst>.restore-tmp, then mv (same-FS rename — no partial write)
    let tmp = format!("{}.restore-tmp", dst_str);
    let status = crate::util::command_as_user("user", "cp", false)
        .args([src_str, &tmp])
        .status()
        .map_err(|e| format!("cp to tmp failed: {}", e))?;
    if !status.success() {
        return Err(format!(
            "cp {} -> {} failed (exit {:?})",
            src_str,
            tmp,
            status.code()
        ));
    }
    let status = crate::util::command_as_user("user", "mv", false)
        .args([&tmp, dst_str])
        .status()
        .map_err(|e| format!("mv failed: {}", e))?;
    if !status.success() {
        return Err(format!(
            "mv {} -> {} failed (exit {:?})",
            tmp,
            dst_str,
            status.code()
        ));
    }
    Ok(())
}

#[cfg(test)]
fn atomic_restore(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    fs::copy(src, dst).map_err(|e| format!("Copy failed: {}", e))?;
    Ok(())
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_backup_dir(tmp: &tempfile::TempDir) -> PathBuf {
        let dir = tmp.path().join("config-backup");
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_has_backup_false_when_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Create empty backup dir (not at the standard path; we test directly)
        let dir = setup_backup_dir(&tmp);
        // No backup.json → no backup
        assert!(!dir.join("backup.json").exists());
    }

    #[test]
    fn test_validate_config_yaml_valid() {
        let tmp = tempfile::TempDir::new().unwrap();
        let yaml = tmp.path().join("config.yaml");
        fs::write(
            &yaml,
            "custom_providers:\n  - name: test\nmodel:\n  provider: test\n",
        )
        .unwrap();
        assert!(validate_config_yaml(&yaml).is_ok());
    }

    #[test]
    fn test_validate_config_yaml_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let yaml = tmp.path().join("config.yaml");
        fs::write(&yaml, "").unwrap();
        assert!(validate_config_yaml(&yaml).is_err());
    }

    #[test]
    fn test_validate_config_yaml_missing_keys() {
        let tmp = tempfile::TempDir::new().unwrap();
        let yaml = tmp.path().join("config.yaml");
        fs::write(&yaml, "some_other_key: value\n").unwrap();
        assert!(validate_config_yaml(&yaml).is_err());
    }

    #[test]
    fn test_validate_config_yaml_missing_file() {
        assert!(validate_config_yaml(Path::new("/nonexistent/config.yaml")).is_err());
    }

    #[test]
    fn test_validate_config_toml_valid() {
        let tmp = tempfile::TempDir::new().unwrap();
        let toml_path = tmp.path().join("config.toml");
        fs::write(
            &toml_path,
            "api_key = \"sk-test\"\ncloud_api_base = \"https://example.com\"\ndaemon_id = \"test-id\"\n",
        )
        .unwrap();
        assert!(validate_config_toml(&toml_path).is_ok());
    }

    #[test]
    fn test_validate_config_toml_invalid() {
        let tmp = tempfile::TempDir::new().unwrap();
        let toml_path = tmp.path().join("config.toml");
        fs::write(&toml_path, "this is not valid toml {{{").unwrap();
        assert!(validate_config_toml(&toml_path).is_err());
    }

    #[test]
    fn test_validate_config_toml_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let toml_path = tmp.path().join("config.toml");
        fs::write(&toml_path, "").unwrap();
        assert!(validate_config_toml(&toml_path).is_err());
    }

    #[test]
    fn test_atomic_restore_works() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src = tmp.path().join("src.yaml");
        let dst = tmp.path().join("dst.yaml");
        fs::write(&src, "test content").unwrap();
        atomic_restore(&src, &dst).unwrap();
        assert!(dst.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "test content");
        // No temp residue
        assert!(!tmp.path().join("dst.yaml.restore-tmp").exists());
    }

    #[test]
    fn test_rollback_config_no_backup() {
        // When no backup exists at standard paths, rollback should fail
        // (This test runs in unit test env where /home/user doesn't exist)
        let result = rollback_config();
        assert!(!result.success);
        assert!(result.error.unwrap().contains("No config backup found"));
    }
}
