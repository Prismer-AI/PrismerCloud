// ota.rs — OTA settle logic (strike/rollback/blacklist) migrated from TS ota-check.ts
//
// File formats (MUST match TS bundle-store.ts byte-for-byte):
//   boot-attempt.json:  { "version": "X.Y.Z", "at": "ISO8601" }
//   current/previous:   { "version": "X.Y.Z" }  (pointer files)
//   blacklist.json:     { "X.Y.Z": <failCount> }
//
// Semantics:
//   1. Read boot marker → if absent, nothing to settle
//   2. Clear boot marker
//   3. Record boot failure → strike count
//   4. If current == marker.version: rollback (current ← previous, clear previous)
//   5. If blacklisted (strike >= 2): remove bundle dir
//
// This runs BEFORE OTA resolve so the resolver sees the settled state.
// TS-side settle (ota-check.ts settlePreviousBoot) must be disabled when
// manager is present (checked via SANDBOX_MANAGER_PRESENT env).
//
// B5: Manager runs as sandbox-mgr. Bundle files in ~user/.prismer/bundle/
// are owned by user. Writes use `sudo -u user tee` + `sudo mv` for atomicity.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const BUNDLE_FAIL_THRESHOLD: u32 = 2;

// ── Write helpers ─────────────────────────────────────────────────────
// B5: In production the manager runs as sandbox-mgr but bundle files are
// owned by user. Writes go through `sudo -u user`. In unit tests, the temp
// dirs are owned by the test process — direct fs operations.

#[cfg(not(test))]
fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    let path_str = path.to_str().unwrap_or("/nonexistent");
    // Atomic: sudo tee to <path>.tmp, then sudo mv <path>.tmp → <path>.
    // This prevents torn writes — the target is never a partial file.
    let tmp = format!("{}.tmp", path_str);

    let mut child = match crate::util::command_as_user("user", "tee", false)
        .arg(&tmp)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("sudo tee spawn failed: {}", e)),
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(content.as_bytes());
    }
    let status = child.wait();
    if !status.map(|s| s.success()).unwrap_or(false) {
        return Err(format!("sudo tee {} failed", tmp));
    }
    // The Runtime user owns pointer state, but sandbox-mgr is deliberately in
    // that user's group so it can settle crash/rollback state. An inherited
    // 0077 umask must not turn current/previous into manager-invisible files.
    let chmod = crate::util::command_as_user("user", "chmod", false)
        .args(["0640", &tmp])
        .status();
    if !chmod.map(|s| s.success()).unwrap_or(false) {
        return Err(format!("sudo chmod {} failed", tmp));
    }
    // Atomic rename (same filesystem — no torn writes)
    let mv = crate::util::command_as_user("user", "mv", false)
        .args([&tmp, path_str])
        .status();
    match mv {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("sudo mv failed with status {:?}", status.code())),
        Err(e) => Err(format!("sudo mv failed: {}", e)),
    }
}

#[cfg(not(test))]
fn remove_file(path: &Path) -> Result<(), String> {
    let path_str = path.to_str().unwrap_or("");
    if path_str.is_empty() {
        return Err("refusing to remove a non-UTF8 path".to_string());
    }
    match crate::util::command_as_user("user", "rm", false)
        .args(["-f", path_str])
        .status()
    {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("sudo rm failed with status {:?}", status.code())),
        Err(error) => Err(format!("sudo rm failed: {}", error)),
    }
}

#[cfg(not(test))]
fn remove_dir(path: &Path) {
    let path_str = path.to_str().unwrap_or("");
    if !path_str.is_empty() {
        let _ = crate::util::command_as_user("user", "rm", false)
            .args(["-rf", path_str])
            .status();
    }
}

#[cfg(not(test))]
fn create_dir(path: &Path) {
    let path_str = path.to_str().unwrap_or("");
    if !path_str.is_empty() {
        let _ = crate::util::command_as_user("user", "mkdir", false)
            .args(["-p", path_str])
            .status();
    }
}

// Test mode: direct fs operations (temp dirs owned by test process)
#[cfg(test)]
fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let target = path.to_path_buf();
    let tmp = format!("{}.tmp", target.display());
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o640))
        .map_err(|error| error.to_string())?;
    fs::rename(&tmp, &target).map_err(|error| error.to_string())
}

#[cfg(test)]
fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
fn remove_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

#[cfg(test)]
fn create_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
}

// ── File format types (must match TS) ──────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BootMarker {
    pub version: String,
    pub at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointerFile {
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedRuntimeMetadata {
    pub schema_version: u8,
    pub version: String,
    pub current: String,
    pub previous: Option<String>,
    pub sha256: String,
    pub signature_sha256: String,
    pub verified: bool,
}

// ── Path helpers ──────────────────────────────────────────────────────

/// Root dir for bundle state: `<prismer_home>/bundle`.
/// prismer_home is typically `~/.prismer` (matches TS bundleRoot in bundle-store.ts).
pub fn bundle_root(prismer_home: &Path) -> PathBuf {
    prismer_home.join("bundle")
}

/// Versioned bundle dir (no existence check).
pub fn bundle_dir(root: &Path, version: &str) -> PathBuf {
    root.join(version)
}

fn pointer_file(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn blacklist_file(root: &Path) -> PathBuf {
    root.join("blacklist.json")
}

fn boot_marker_file(root: &Path) -> PathBuf {
    root.join("boot-attempt.json")
}

fn verified_runtime_metadata_file(root: &Path, version: &str) -> PathBuf {
    bundle_dir(root, version).join("verified-runtime.json")
}

fn is_safe_version(version: &str) -> bool {
    !version.is_empty() && !version.contains('/') && !version.contains("..")
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// ── Pointer operations ─────────────────────────────────────────────────

/// Read a pointer file. Returns None on any failure.
pub fn read_pointer(root: &Path, name: &str) -> Option<String> {
    let f = pointer_file(root, name);
    let content = fs::read_to_string(&f).ok()?;
    let parsed: serde_json::Result<PointerFile> = serde_json::from_str(&content);
    match parsed {
        Ok(p) if !p.version.is_empty() && !p.version.contains('/') && !p.version.contains("..") => {
            Some(p.version)
        }
        _ => None,
    }
}

/// Atomic pointer write (temp + rename via sudo — never a torn pointer).
/// B5: Uses sudo because bundle files are owned by user.
#[cfg_attr(not(test), allow(dead_code))]
pub fn write_pointer(root: &Path, name: &str, version: &str) {
    create_dir(root);
    let target = pointer_file(root, name);
    let data = serde_json::to_string(&PointerFile {
        version: version.to_string(),
    })
    .unwrap();
    if let Err(error) = write_file_atomic(&target, &data) {
        eprintln!("[sandbox-manager] ota: pointer write failed: {}", error);
    }
}

/// Clear (delete) a pointer file via sudo.
pub fn clear_pointer(root: &Path, name: &str) {
    if let Err(error) = remove_file(&pointer_file(root, name)) {
        eprintln!("[sandbox-manager] ota: pointer clear failed: {}", error);
    }
}

fn read_verified_runtime_metadata(
    root: &Path,
    version: &str,
) -> Result<VerifiedRuntimeMetadata, String> {
    if !is_safe_version(version) {
        return Err("unsafe rollback version".to_string());
    }
    let content = fs::read_to_string(verified_runtime_metadata_file(root, version))
        .map_err(|error| format!("verified-runtime.json unavailable: {}", error))?;
    let metadata: VerifiedRuntimeMetadata = serde_json::from_str(&content)
        .map_err(|error| format!("verified-runtime.json malformed: {}", error))?;
    if metadata.schema_version != 1
        || !metadata.verified
        || metadata.version != version
        || metadata.current != version
        || metadata
            .previous
            .as_deref()
            .is_some_and(|previous| !is_safe_version(previous))
        || !is_lowercase_sha256(&metadata.sha256)
        || !is_lowercase_sha256(&metadata.signature_sha256)
    {
        return Err("verified-runtime.json does not match the rollback bundle".to_string());
    }
    Ok(metadata)
}

/** Promote only a rollback slot carrying exact version-scoped proof. */
pub fn promote_verified_bundle_to_current(root: &Path, version: &str) -> Result<(), String> {
    if !is_valid_bundle_dir(&bundle_dir(root, version)) {
        return Err("verified rollback bundle directory is unavailable".to_string());
    }
    let mut metadata = read_verified_runtime_metadata(root, version)?;
    metadata.current = version.to_string();
    metadata.previous = None;
    let data = serde_json::to_string(&metadata)
        .map_err(|error| format!("verified-runtime.json serialization failed: {}", error))?;
    write_file_atomic(&verified_runtime_metadata_file(root, version), &data)
        .map_err(|error| format!("verified-runtime.json persistence failed: {}", error))?;

    let current_data = serde_json::to_string(&PointerFile {
        version: version.to_string(),
    })
    .map_err(|error| format!("current pointer serialization failed: {}", error))?;
    write_file_atomic(&pointer_file(root, "current"), &current_data)
        .map_err(|error| format!("current pointer persistence failed: {}", error))?;
    remove_file(&pointer_file(root, "previous"))
        .map_err(|error| format!("previous pointer clear failed: {}", error))?;
    Ok(())
}

// ── Boot marker operations ─────────────────────────────────────────────

/// Read the boot-attempt marker. Returns None on any failure.
pub fn read_boot_marker(root: &Path) -> Option<BootMarker> {
    let f = boot_marker_file(root);
    let content = fs::read_to_string(&f).ok()?;
    let parsed: serde_json::Result<BootMarker> = serde_json::from_str(&content);
    match parsed {
        Ok(m) if !m.version.is_empty() => Some(m),
        _ => None,
    }
}

/// Arm the boot marker (called by resolver when handing out a bundle target).
/// B5: Uses sudo because bundle files are owned by user.
#[cfg(test)]
pub fn arm_boot_marker(root: &Path, version: &str) {
    create_dir(root);
    let target = boot_marker_file(root);
    let at = crate::util::epoch_to_iso8601();
    let data = serde_json::to_string(&BootMarker {
        version: version.to_string(),
        at,
    })
    .unwrap();
    if let Err(error) = write_file_atomic(&target, &data) {
        eprintln!("[sandbox-manager] ota: boot marker write failed: {}", error);
    }
}

/// Clear (delete) the boot marker via sudo.
pub fn clear_boot_marker(root: &Path) {
    if let Err(error) = remove_file(&boot_marker_file(root)) {
        eprintln!("[sandbox-manager] ota: boot marker clear failed: {}", error);
    }
}

// ── Blacklist operations ───────────────────────────────────────────────

fn read_blacklist_map(root: &Path) -> std::collections::HashMap<String, u32> {
    let f = blacklist_file(root);
    match fs::read_to_string(&f) {
        Ok(content) => {
            let parsed: serde_json::Result<std::collections::HashMap<String, u32>> =
                serde_json::from_str(&content);
            parsed.unwrap_or_default()
        }
        Err(_) => std::collections::HashMap::new(),
    }
}

fn write_blacklist_map(root: &Path, map: &std::collections::HashMap<String, u32>) {
    create_dir(root);
    let target = blacklist_file(root);
    let data = serde_json::to_string(map).unwrap();
    if let Err(error) = write_file_atomic(&target, &data) {
        eprintln!("[sandbox-manager] ota: blacklist write failed: {}", error);
    }
}

/// Check if a version is blacklisted (fail count >= threshold).
#[cfg(test)]
pub fn is_blacklisted(root: &Path, version: &str) -> bool {
    read_blacklist_map(root).get(version).copied().unwrap_or(0) >= BUNDLE_FAIL_THRESHOLD
}

/// Record a boot failure for a version.
/// Returns (new_count, blacklisted).
pub fn record_boot_failure(root: &Path, version: &str) -> (u32, bool) {
    let mut map = read_blacklist_map(root);
    let count = map.get(version).copied().unwrap_or(0) + 1;
    map.insert(version.to_string(), count);
    write_blacklist_map(root, &map);
    let blacklisted = count >= BUNDLE_FAIL_THRESHOLD;
    (count, blacklisted)
}

/// Clear failure record for a version (on confirmed successful boot).
/// Deferred: called by daemon's boot_ok signal (TS-side clearBootFailures).
/// Not yet wired in manager — the daemon clears this via TS-side confirmation.
#[allow(dead_code)]
pub fn clear_boot_failures(root: &Path, version: &str) {
    let mut map = read_blacklist_map(root);
    if map.remove(version).is_some() {
        write_blacklist_map(root, &map);
    }
}

// ── Bundle dir operations ──────────────────────────────────────────────

/// Check if a bundle dir exists and is usable.
/// v1: just checks existence (full REQUIRED_ENTRIES check is TS-side).
pub fn is_valid_bundle_dir(dir: &Path) -> bool {
    dir.exists() && dir.is_dir()
}

/// Remove a versioned bundle dir via sudo (best-effort).
pub fn remove_bundle_dir(root: &Path, version: &str) {
    let dir = bundle_dir(root, version);
    remove_dir(&dir);
}

// ── Main settle logic ──────────────────────────────────────────────────

/// Result of settling a previous boot attempt.
#[derive(Debug, Clone)]
pub struct SettleResult {
    /// The marker that was found (if any).
    pub marker_version: Option<String>,
    /// Strike count after recording failure.
    pub strike_count: u32,
    /// Whether the version was blacklisted.
    pub blacklisted: bool,
    /// Whether a rollback was performed.
    pub rolled_back: bool,
    /// The version rolled back to (None = no verified local slot).
    pub rolled_to_version: Option<String>,
}

/// Settle a surviving boot-attempt marker.
///
/// Called by the manager BEFORE OTA resolve. If the previous boot left an
/// unconfirmed marker, this means the daemon crashed before confirming boot.
/// Actions:
///   1. Record one failure (strike)
///   2. If current == marker version: roll back to previous or clear current
///   3. If strike >= threshold: blacklist + remove dir
///
/// Returns the settle result for logging.
pub fn settle_previous_boot(home: &Path, log: &mut dyn FnMut(&str)) -> SettleResult {
    let root = bundle_root(home);
    let marker = read_boot_marker(&root);

    let marker_version = marker.as_ref().map(|m| m.version.clone());

    let Some(ref marker) = marker else {
        return SettleResult {
            marker_version: None,
            strike_count: 0,
            blacklisted: false,
            rolled_back: false,
            rolled_to_version: None,
        };
    };

    clear_boot_marker(&root);

    let (count, blacklisted) = record_boot_failure(&root, &marker.version);
    log(&format!(
        "[sandbox-manager] OTA settle: previous boot of v{} never confirmed (strike {}/{})",
        marker.version, count, BUNDLE_FAIL_THRESHOLD
    ));

    let mut rolled_back = false;
    let mut rolled_to_version: Option<String> = None;

    if read_pointer(&root, "current").as_deref() == Some(&marker.version) {
        let previous = read_pointer(&root, "previous");
        if let Some(ref prev) = previous {
            match promote_verified_bundle_to_current(&root, prev) {
                Ok(()) => {
                    rolled_to_version = Some(prev.clone());
                    log(&format!(
                        "[sandbox-manager] OTA settle: rolled back current → verified v{}",
                        prev
                    ));
                }
                Err(error) => {
                    clear_pointer(&root, "current");
                    log(&format!(
                        "[sandbox-manager] OTA settle: cleared current (previous slot not verified: {})",
                        error
                    ));
                }
            }
        } else {
            clear_pointer(&root, "current");
            log("[sandbox-manager] OTA settle: cleared current (no previous slot)");
        }
        rolled_back = true;
    }

    if blacklisted {
        remove_bundle_dir(&root, &marker.version);
        log(&format!(
            "[sandbox-manager] OTA settle: v{} BLACKLISTED after {} strikes — dir removed",
            marker.version, count
        ));
    }

    SettleResult {
        marker_version,
        strike_count: count,
        blacklisted,
        rolled_back,
        rolled_to_version,
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

// (Date functions in util.rs — shared between ota.rs and cmd.rs)

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_verified_runtime_metadata(root: &Path, version: &str, previous: Option<&str>) {
        let dir = bundle_dir(root, version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("verified-runtime.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "version": version,
                "current": version,
                "previous": previous,
                "sha256": "a".repeat(64),
                "signatureSha256": "b".repeat(64),
                "verified": true
            })
            .to_string(),
        )
        .unwrap();
    }

    fn setup_bundle_root(tmp: &tempfile::TempDir) -> PathBuf {
        let root = tmp.path().join("bundle");
        fs::create_dir_all(&root).unwrap();
        root
    }

    // ── Pointer tests ────────────────────────────────────────────────

    #[test]
    fn test_read_pointer_valid() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        write_pointer(&root, "current", "1.2.3");
        assert_eq!(read_pointer(&root, "current"), Some("1.2.3".to_string()));
    }

    #[test]
    fn test_read_pointer_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        assert_eq!(read_pointer(&root, "current"), None);
    }

    #[test]
    fn test_read_pointer_rejects_path_traversal() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        // Write a malicious pointer manually
        fs::write(
            pointer_file(&root, "current"),
            r#"{"version":"../../etc/passwd"}"#,
        )
        .unwrap();
        assert_eq!(read_pointer(&root, "current"), None);
    }

    #[test]
    fn test_read_pointer_rejects_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        fs::write(pointer_file(&root, "current"), r#"{"version":""}"#).unwrap();
        assert_eq!(read_pointer(&root, "current"), None);
    }

    #[test]
    fn test_write_pointer_atomic() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        write_pointer(&root, "previous", "2.0.0");
        // Should be readable back
        assert_eq!(read_pointer(&root, "previous"), Some("2.0.0".to_string()));
        // No .tmp residue
        assert!(!pointer_file(&root, "previous")
            .with_extension("tmp")
            .exists());
        assert_eq!(
            fs::metadata(pointer_file(&root, "previous"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }

    #[test]
    fn test_clear_pointer() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        write_pointer(&root, "current", "3.0.0");
        clear_pointer(&root, "current");
        assert_eq!(read_pointer(&root, "current"), None);
    }

    // ── Boot marker tests ────────────────────────────────────────────

    #[test]
    fn test_boot_marker_roundtrip() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        arm_boot_marker(&root, "1.0.0");
        let marker = read_boot_marker(&root);
        assert!(marker.is_some());
        let m = marker.unwrap();
        assert_eq!(m.version, "1.0.0");
        assert!(!m.at.is_empty());
    }

    #[test]
    fn test_boot_marker_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        assert!(read_boot_marker(&root).is_none());
    }

    #[test]
    fn test_clear_boot_marker() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        arm_boot_marker(&root, "1.0.0");
        clear_boot_marker(&root);
        assert!(read_boot_marker(&root).is_none());
    }

    // ── Blacklist tests ──────────────────────────────────────────────

    #[test]
    fn test_blacklist_record_single_strike() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        let (count, blacklisted) = record_boot_failure(&root, "1.0.0");
        assert_eq!(count, 1);
        assert!(!blacklisted);
        assert!(!is_blacklisted(&root, "1.0.0"));
    }

    #[test]
    fn test_blacklist_record_two_strikes() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        record_boot_failure(&root, "1.0.0");
        let (count, blacklisted) = record_boot_failure(&root, "1.0.0");
        assert_eq!(count, 2);
        assert!(blacklisted);
        assert!(is_blacklisted(&root, "1.0.0"));
    }

    #[test]
    fn test_blacklist_independent_versions() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        record_boot_failure(&root, "1.0.0");
        record_boot_failure(&root, "1.0.0"); // blacklisted
        record_boot_failure(&root, "2.0.0"); // only 1 strike
        assert!(is_blacklisted(&root, "1.0.0"));
        assert!(!is_blacklisted(&root, "2.0.0"));
    }

    #[test]
    fn test_clear_boot_failures() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        record_boot_failure(&root, "1.0.0");
        clear_boot_failures(&root, "1.0.0");
        assert!(!is_blacklisted(&root, "1.0.0"));
    }

    #[test]
    fn test_blacklist_file_format_matches_ts() {
        // The TS side writes: JSON.stringify({ "1.0.0": 2 })
        let tmp = tempfile::TempDir::new().unwrap();
        let root = setup_bundle_root(&tmp);
        // Write using the Rust function
        record_boot_failure(&root, "1.0.0");
        record_boot_failure(&root, "1.0.0");
        // Read the raw file — should be parsable as HashMap<String, u32>
        let content = fs::read_to_string(blacklist_file(&root)).unwrap();
        let map: std::collections::HashMap<String, u32> = serde_json::from_str(&content).unwrap();
        assert_eq!(map.get("1.0.0"), Some(&2));
    }

    // ── Settle tests ──────────────────────────────────────────────────

    #[test]
    fn test_settle_no_marker() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let _root = setup_bundle_root(&tmp);
        let result = settle_previous_boot(&home, &mut |_| {});
        assert!(result.marker_version.is_none());
        assert_eq!(result.strike_count, 0);
    }

    #[test]
    fn test_settle_single_strike_no_rollback() {
        // If current != marker.version, just strike, no rollback
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let root = bundle_root(&home);
        fs::create_dir_all(&root).unwrap();

        // Set current to a different version
        write_pointer(&root, "current", "2.0.0");
        // Arm a marker for a different version
        arm_boot_marker(&root, "1.0.0");

        let result = settle_previous_boot(&home, &mut |_| {});

        assert_eq!(result.marker_version, Some("1.0.0".to_string()));
        assert_eq!(result.strike_count, 1);
        assert!(!result.blacklisted);
        assert!(!result.rolled_back);
        // Current should still be 2.0.0 (unchanged)
        assert_eq!(read_pointer(&root, "current"), Some("2.0.0".to_string()));
        // Marker should be cleared
        assert!(read_boot_marker(&root).is_none());
    }

    #[test]
    fn test_settle_rollback_to_previous() {
        // current == marker.version, previous is valid → rollback
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let root = bundle_root(&home);
        fs::create_dir_all(&root).unwrap();

        write_pointer(&root, "current", "2.0.0");
        write_pointer(&root, "previous", "1.0.0");
        // Create the previous bundle dir so it's "valid"
        let prev_dir = bundle_dir(&root, "1.0.0");
        fs::create_dir_all(&prev_dir).unwrap();
        write_verified_runtime_metadata(&root, "1.0.0", Some("0.9.0"));

        arm_boot_marker(&root, "2.0.0");

        let result = settle_previous_boot(&home, &mut |_| {});

        assert_eq!(result.marker_version, Some("2.0.0".to_string()));
        assert_eq!(result.strike_count, 1);
        assert!(result.rolled_back);
        assert_eq!(result.rolled_to_version, Some("1.0.0".to_string()));

        // Current should now be 1.0.0
        assert_eq!(read_pointer(&root, "current"), Some("1.0.0".to_string()));
        // Previous should be cleared
        assert_eq!(read_pointer(&root, "previous"), None);
        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(prev_dir.join("verified-runtime.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["current"], "1.0.0");
        assert_eq!(metadata["previous"], serde_json::Value::Null);
    }

    #[test]
    fn test_settle_rejects_previous_without_verified_runtime_metadata() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let root = bundle_root(&home);
        fs::create_dir_all(bundle_dir(&root, "1.0.0")).unwrap();
        write_pointer(&root, "current", "2.0.0");
        write_pointer(&root, "previous", "1.0.0");
        arm_boot_marker(&root, "2.0.0");

        let result = settle_previous_boot(&home, &mut |_| {});

        assert!(result.rolled_back);
        assert_eq!(result.rolled_to_version, None);
        assert_eq!(read_pointer(&root, "current"), None);
        assert_eq!(read_pointer(&root, "previous"), Some("1.0.0".to_string()));
    }

    #[test]
    fn test_settle_clears_current_when_no_previous() {
        // current == marker.version, no previous → clear current
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let root = bundle_root(&home);
        fs::create_dir_all(&root).unwrap();

        write_pointer(&root, "current", "2.0.0");
        // No previous pointer
        arm_boot_marker(&root, "2.0.0");

        let result = settle_previous_boot(&home, &mut |_| {});

        assert!(result.rolled_back);
        assert_eq!(result.rolled_to_version, None);
        assert_eq!(read_pointer(&root, "current"), None);
    }

    #[test]
    fn test_settle_blacklist_removes_dir() {
        // Two strikes → blacklist → dir removed
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let root = bundle_root(&home);
        fs::create_dir_all(&root).unwrap();

        // Create a bundle dir for the bad version
        let bad_dir = bundle_dir(&root, "3.0.0");
        fs::create_dir_all(bad_dir.join("dist")).unwrap();
        fs::write(bad_dir.join("dist").join("cli.js"), "fake").unwrap();

        // Pre-populate blacklist with 1 strike
        record_boot_failure(&root, "3.0.0");
        // Set current to that version
        write_pointer(&root, "current", "3.0.0");
        write_pointer(&root, "previous", "2.0.0");
        let prev_dir = bundle_dir(&root, "2.0.0");
        fs::create_dir_all(&prev_dir).unwrap();
        write_verified_runtime_metadata(&root, "2.0.0", None);

        arm_boot_marker(&root, "3.0.0");

        let result = settle_previous_boot(&home, &mut |_| {});

        assert_eq!(result.strike_count, 2);
        assert!(result.blacklisted);
        assert!(result.rolled_back);

        // Dir should be removed
        assert!(!bundle_dir(&root, "3.0.0").exists());
        // Current should be rolled back
        assert_eq!(read_pointer(&root, "current"), Some("2.0.0".to_string()));
    }
}
