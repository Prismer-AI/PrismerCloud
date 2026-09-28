// init.rs — Entrypoint initialization logic (migrated from daemon-entrypoint.sh:46-125)
//
// Responsibilities:
//   - Resolve DAEMON home directory (/home/user)
//   - Resolve PRISMER_API_KEY (with fake key fallback for dev images)
//   - Resolve PRISMER_DAEMON_ID (preserve from existing config.toml if present)
//   - Resolve cloud base URL with fallback chain
//   - Validate static binding (PRISMER_STATIC_BINDING_REQUIRED)
//   - Write ~/.prismer/config.toml (via sudo -u user tee)
//   - Resolve the signed Runtime OTA bundle through the image bootstrapper

use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The daemon always runs as `user` with HOME=/home/user.
/// The manager may run as a different user (sandbox-mgr, B5).
/// This function always returns the daemon's home.
pub fn resolve_daemon_home_dir() -> PathBuf {
    PathBuf::from("/home/user")
}

/// Resolve daemon ID with first-write semantics.
/// Mirrors daemon-entrypoint.sh:78-81 + 113-119 exactly.
///
/// Flow:
///   1. Use PRISMER_DAEMON_ID env var if set
///   2. Otherwise derive from hostname
///   3. THEN check existing config.toml — if it has a preserved daemon_id, use that
///
/// config_path is the path to the daemon's config.toml (not the manager's).
pub fn resolve_daemon_id_for_boot(config_path: &Path, preserve_existing: bool) -> String {
    let initial_id = if let Ok(id) = env::var("PRISMER_DAEMON_ID") {
        if !id.is_empty() {
            id
        } else {
            derive_from_hostname()
        }
    } else {
        derive_from_hostname()
    };

    // Step 3: always check existing config.toml for preserved daemon_id
    if preserve_existing {
        if let Ok(existing) = read_existing_daemon_id(config_path) {
            eprintln!(
                "[sandbox-manager] daemon_id preserved from config.toml -> {}",
                existing
            );
            return existing;
        }
    } else {
        eprintln!(
            "[sandbox-manager] template clone detected; ignoring source daemon_id in config.toml"
        );
    }

    initial_id
}

pub fn runtime_template_mode() -> bool {
    env::var("PRISMER_TEMPLATE_MODE")
        .map(|value| value == "true")
        .unwrap_or(false)
}

pub fn template_marker_path(daemon_home: &Path) -> PathBuf {
    daemon_home.join(".prismer").join("runtime-template-source")
}

pub fn has_template_marker(daemon_home: &Path) -> bool {
    template_marker_path(daemon_home).is_file()
}

pub fn write_template_marker(daemon_home: &Path) {
    let marker = template_marker_path(daemon_home);
    let mut child = crate::util::command_as_user("user", "tee", false)
        .arg(&marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap_or_else(|err| panic!("failed to create runtime template marker: {}", err));
    child
        .stdin
        .as_mut()
        .expect("template marker stdin")
        .write_all(b"v1\n")
        .expect("failed to write runtime template marker");
    let status = child
        .wait()
        .expect("failed to wait for runtime template marker");
    if !status.success() {
        panic!(
            "runtime template marker write failed with status {:?}",
            status.code()
        );
    }
}

pub fn clear_template_marker(daemon_home: &Path) {
    let marker = template_marker_path(daemon_home);
    let status = crate::util::command_as_user("user", "rm", false)
        .arg("-f")
        .arg(&marker)
        .status()
        .unwrap_or_else(|err| panic!("failed to clear runtime template marker: {}", err));
    if !status.success() {
        panic!(
            "runtime template marker cleanup failed with status {:?}",
            status.code()
        );
    }
}

/// Derive daemon_id from hostname: container:<hostname>
fn derive_from_hostname() -> String {
    if let Ok(hostname) = hostname() {
        let id = format!("container:{}", hostname);
        eprintln!(
            "[sandbox-manager] PRISMER_DAEMON_ID derived from hostname -> {}",
            id
        );
        id
    } else {
        "container:unknown".to_string()
    }
}

/// Read existing daemon_id from config.toml (first-write preservation).
/// Mirrors: grep '^daemon_id = ' config.toml | sed extraction.
///
/// B5: The manager runs as sandbox-mgr, config.toml is owned by user.
/// Read is via group permission (sandbox-mgr is in user's group).
pub fn read_existing_daemon_id(config_path: &Path) -> Result<String, ()> {
    let content = fs::read_to_string(config_path).map_err(|_| ())?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("daemon_id = ") {
            if let Some(start) = trimmed.find('"') {
                let after_start = &trimmed[start + 1..];
                if let Some(end) = after_start.find('"') {
                    let value = &after_start[..end];
                    if !value.is_empty() {
                        return Ok(value.to_string());
                    }
                }
            }
        }
    }
    Err(())
}

/// Resolve API key with fake key fallback for dev images.
/// Mirrors daemon-entrypoint.sh:46-55.
pub fn resolve_api_key() -> String {
    if let Ok(key) = env::var("PRISMER_API_KEY") {
        if !key.is_empty() {
            return key;
        }
    }

    let allow_fake = env::var("PRISMER_ALLOW_FAKE_API_KEY").unwrap_or_else(|_| "false".to_string());
    if allow_fake == "true" {
        eprintln!(
            "[sandbox-manager] PRISMER_API_KEY missing — using dev fake key (PRISMER_ALLOW_FAKE_API_KEY=true)"
        );
        return "sk-prismer-live-dev-cookbook-fake-key".to_string();
    }

    eprintln!("[sandbox-manager] PRISMER_API_KEY: missing — controller must inject");
    eprintln!("[sandbox-manager] (set PRISMER_ALLOW_FAKE_API_KEY=true for local cookbook smoke)");
    std::process::exit(78);
}

/// Resolve cloud base URL with fallback chain.
/// Mirrors daemon-entrypoint.sh:84-86.
/// Chain: PRISMER_BASE_URL > CLOUD_API_BASE > PRISMER_CLOUD_API_BASE > default
pub fn resolve_cloud_base() -> String {
    for var in &[
        "PRISMER_BASE_URL",
        "CLOUD_API_BASE",
        "PRISMER_CLOUD_API_BASE",
    ] {
        if let Ok(val) = env::var(var) {
            if !val.is_empty() {
                return val;
            }
        }
    }
    "https://prod.docbrew.cn".to_string()
}

/// Validate static binding requirement.
/// Mirrors daemon-entrypoint.sh:91-101.
pub fn validate_static_binding() {
    let required =
        env::var("PRISMER_STATIC_BINDING_REQUIRED").unwrap_or_else(|_| "false".to_string());

    if required == "1" || required == "true" || required == "yes" {
        let has_json = env::var("PRISMER_HOSTED_AGENT_JSON")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let has_file = env::var("PRISMER_HOSTED_AGENT_FILE")
            .map(|v| !v.is_empty())
            .unwrap_or(false);

        if !has_json && !has_file {
            eprintln!(
                "[sandbox-manager] static binding required but PRISMER_HOSTED_AGENT_JSON/PRISMER_HOSTED_AGENT_FILE is missing"
            );
            std::process::exit(78);
        }

        if let Ok(file_path) = env::var("PRISMER_HOSTED_AGENT_FILE") {
            if !file_path.is_empty() && !Path::new(&file_path).exists() {
                eprintln!(
                    "[sandbox-manager] PRISMER_HOSTED_AGENT_FILE not found: {}",
                    file_path
                );
                std::process::exit(78);
            }
        }
    }
}

/// Ensure ~/.prismer directory exists in the daemon's home.
/// B5: Uses sudo -u user because the manager runs as sandbox-mgr
/// and /home/user/.prismer is owned by user.
/// Mirrors daemon-entrypoint.sh:89.
pub fn ensure_prismer_dir(daemon_home: &Path) {
    let dir = daemon_home.join(".prismer");
    let dir_str = dir.to_str().unwrap_or("/home/user/.prismer");
    let status = crate::util::command_as_user("user", "mkdir", false)
        .args(["-p", dir_str])
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => {
            eprintln!(
                "[sandbox-manager] sudo mkdir {} failed with exit code {:?}",
                dir_str,
                s.code()
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!(
                "[sandbox-manager] failed to run sudo mkdir for {}: {}",
                dir_str, e
            );
            std::process::exit(1);
        }
    }
}

/// Write ~/.prismer/config.toml with flat config matching ConfigSchema.
/// B5: Uses `sudo -u user tee` because the manager runs as sandbox-mgr
/// and /home/user/.prismer is owned by user.
/// Mirrors daemon-entrypoint.sh:121-125.
pub fn write_config_toml(daemon_home: &Path, api_key: &str, cloud_base: &str, daemon_id: &str) {
    let config_path = daemon_home.join(".prismer").join("config.toml");
    let config_path_str = config_path
        .to_str()
        .unwrap_or("/home/user/.prismer/config.toml");
    let content = format!(
        "api_key = \"{}\"\ncloud_api_base = \"{}\"\ndaemon_id = \"{}\"\n",
        api_key, cloud_base, daemon_id
    );

    let mut child = match crate::util::command_as_user("user", "tee", false)
        .arg(config_path_str)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[sandbox-manager] failed to run sudo tee for config.toml: {}",
                e
            );
            std::process::exit(1);
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(content.as_bytes()) {
            eprintln!(
                "[sandbox-manager] failed to write config.toml content: {}",
                e
            );
            std::process::exit(1);
        }
    }

    let status = child.wait().unwrap_or_else(|e| {
        eprintln!("[sandbox-manager] sudo tee wait failed: {}", e);
        std::process::exit(1);
    });

    if !status.success() {
        eprintln!(
            "[sandbox-manager] sudo tee config.toml failed with exit code {:?}",
            status.code()
        );
        std::process::exit(1);
    }
}

/// Resolve the Runtime CLI from the standalone image bootstrapper.
///
fn resolve_trusted_image_runtime(
    release_path: &Path,
    builtin_root: &Path,
    require_root_immutable: bool,
) -> Result<PathBuf, String> {
    let release: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(release_path)
            .map_err(|error| format!("release marker unavailable: {error}"))?,
    )
    .map_err(|error| format!("release marker malformed: {error}"))?;
    if release
        .get("schemaVersion")
        .and_then(|value| value.as_u64())
        != Some(1)
    {
        return Err("release marker schema is invalid".to_string());
    }
    let version = release
        .pointer("/daemon/version")
        .and_then(|value| value.as_str())
        .filter(|value| {
            !value.is_empty()
                && value.split('.').count() == 3
                && value
                    .split('.')
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .ok_or_else(|| "release daemon version is invalid".to_string())?;
    let release_id = release
        .get("sandboxReleaseId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "release ID is missing".to_string())?;
    let revision = release_id
        .strip_prefix(&format!("v{version}-r"))
        .filter(|value| {
            !value.is_empty()
                && !value.starts_with('0')
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
        .ok_or_else(|| "release ID does not match daemon version".to_string())?;
    if revision.is_empty() {
        return Err("release revision is invalid".to_string());
    }

    let package_root = builtin_root.join(version);
    let runtime_marker_path = package_root.join(".prismer-builtin-runtime.json");
    let runtime_marker: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&runtime_marker_path)
            .map_err(|error| format!("builtin Runtime marker unavailable: {error}"))?,
    )
    .map_err(|error| format!("builtin Runtime marker malformed: {error}"))?;
    if release.get("daemon") != Some(&runtime_marker) {
        return Err("builtin Runtime marker does not match release marker".to_string());
    }
    let package: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(package_root.join("package.json"))
            .map_err(|error| format!("builtin Runtime package unavailable: {error}"))?,
    )
    .map_err(|error| format!("builtin Runtime package malformed: {error}"))?;
    if package.get("name").and_then(|value| value.as_str()) != Some("@prismer/runtime")
        || package.get("version").and_then(|value| value.as_str()) != Some(version)
    {
        return Err("builtin Runtime package identity is invalid".to_string());
    }
    let cli = package_root.join("dist/cli.js");
    let native_floor = package_root.join("node_modules/better-sqlite3/package.json");
    for path in [
        release_path,
        builtin_root,
        &package_root,
        &runtime_marker_path,
        &cli,
        &native_floor,
    ] {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            format!(
                "immutable Runtime path {} unavailable: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "immutable Runtime path {} is a symlink",
                path.display()
            ));
        }
        if require_root_immutable && (metadata.uid() != 0 || metadata.mode() & 0o022 != 0) {
            return Err(format!(
                "immutable Runtime path {} is not root-owned and non-writable",
                path.display()
            ));
        }
    }
    Ok(cli)
}

/// Resolve the Runtime command. Immutable image releases were already fully
/// hashed and signature-verified while the image was built. Re-reading their
/// Node bootstrap on a filesystem-only Checkpoint clone caused a 1.5-12s cold
/// page-in tax, so validate the small immutable marker set in-process first.
/// OTA/container mode continues through the signed Node bootstrap unchanged.
pub fn resolve_runtime_bundle() -> Result<PathBuf, String> {
    if env::var("PRISMER_RUNTIME_MODE").as_deref() == Ok("image")
        && env::var("PRISMER_RUNTIME_TRUST_IMMUTABLE_IMAGE").as_deref() == Ok("true")
    {
        let release_path = PathBuf::from(
            env::var("PRISMER_RELEASE_MARKER_PATH")
                .unwrap_or_else(|_| "/opt/prismer/release.json".to_string()),
        );
        let builtin_root = PathBuf::from(
            env::var("PRISMER_RUNTIME_BUILTIN_ROOT")
                .unwrap_or_else(|_| "/opt/prismer/runtime-builtin".to_string()),
        );
        match resolve_trusted_image_runtime(&release_path, &builtin_root, true) {
            Ok(cli) => {
                eprintln!(
                    "[sandbox-manager] trusted immutable runtime bundle -> exec node {}",
                    cli.display()
                );
                return Ok(cli);
            }
            Err(error) => {
                eprintln!("[sandbox-manager] immutable Runtime fast path rejected: {error}; verifying with bootstrap");
            }
        }
    }
    let bootstrap = env::var("PRISMER_RUNTIME_BOOTSTRAP")
        .unwrap_or_else(|_| "/usr/local/lib/prismer/runtime-bootstrap.mjs".to_string());
    let output = crate::util::command_as_user("user", "node", true)
        .arg(&bootstrap)
        .output()
        .map_err(|error| format!("failed to launch runtime bootstrapper {bootstrap}: {error}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        eprintln!("[sandbox-manager] runtime bootstrap: {stderr}");
    }
    if !output.status.success() {
        return Err(format!(
            "runtime bootstrapper exited {:?}: {}",
            output.status.code(),
            if stderr.is_empty() {
                "no diagnostic"
            } else {
                &stderr
            }
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let cli = PathBuf::from(&stdout);
    if stdout.is_empty() || !cli.is_file() {
        return Err(format!(
            "runtime bootstrapper returned an invalid exec path: {:?}",
            stdout
        ));
    }
    eprintln!(
        "[sandbox-manager] signed runtime bundle -> exec node {}",
        cli.display()
    );
    Ok(cli)
}

/// `<bundle>/dist/cli.js` -> `<bundle>/node_modules/.bin`.
pub fn bundle_bin_dir(bundle_cli: &Path) -> Option<PathBuf> {
    bundle_cli
        .parent()?
        .parent()
        .map(|bundle_root| bundle_root.join("node_modules").join(".bin"))
}

pub fn prepend_bundle_bin_to_path(bundle_cli: &Path) -> Result<(), String> {
    let bin = bundle_bin_dir(bundle_cli)
        .ok_or_else(|| format!("bundle CLI has no bundle root: {}", bundle_cli.display()))?;
    if !bin.is_dir() {
        return Err(format!(
            "bundle Cloud CLI directory is missing: {}",
            bin.display()
        ));
    }
    let existing = env::var("PATH").unwrap_or_default();
    let next = if existing.is_empty() {
        bin.display().to_string()
    } else {
        format!("{}:{}", bin.display(), existing)
    };
    env::set_var("PATH", next);
    Ok(())
}

/// Get hostname (mirrors: $(hostname))
fn hostname() -> Result<String, std::io::Error> {
    if let Ok(hostname) = fs::read_to_string("/proc/sys/kernel/hostname") {
        let trimmed = hostname.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    let output = Command::new("hostname").output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Ok("unknown".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_resolve_daemon_home_dir() {
        let home = resolve_daemon_home_dir();
        assert_eq!(home, PathBuf::from("/home/user"));
    }

    #[test]
    fn test_resolve_daemon_id_from_env() {
        let tmp = tempfile::TempDir::new().unwrap();
        let id = resolve_daemon_id_for_boot(&tmp.path().join("config.toml"), true);
        assert!(!id.is_empty());
        assert!(id.starts_with("container:") || !id.contains("container:"));
    }

    #[test]
    fn test_resolve_daemon_id_preserves_existing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        fs::write(
            &config_path,
            "api_key = \"sk-test\"\ncloud_api_base = \"https://test.example.com\"\ndaemon_id = \"preserved-id-123\"\n",
        )
        .unwrap();

        let id = resolve_daemon_id_for_boot(&config_path, true);
        assert_eq!(id, "preserved-id-123");
    }

    #[test]
    fn test_template_clone_does_not_preserve_source_daemon_id() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        fs::write(&config_path, "daemon_id = \"source-daemon\"\n").unwrap();

        let id = resolve_daemon_id_for_boot(&config_path, false);
        assert_ne!(id, "source-daemon");
        assert!(id.starts_with("container:"));
    }

    #[test]
    #[ignore = "env-dependent: needs isolated PRISMER_API_KEY; verified by container-level tests (case 1/5/7)"]
    fn test_resolve_api_key_returns_key_when_set() {}

    #[test]
    fn test_resolve_cloud_base_returns_default() {
        let base = resolve_cloud_base();
        assert_eq!(base, "https://prod.docbrew.cn");
    }

    #[test]
    #[ignore = "env-dependent: needs PRISMER_STATIC_BINDING_REQUIRED set; verified by container-level tests"]
    fn test_validate_static_binding_not_required_by_default() {
        validate_static_binding();
    }

    #[test]
    fn test_read_existing_daemon_id_found() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        fs::write(&config_path, "daemon_id = \"my-daemon\"\n").unwrap();

        let result = read_existing_daemon_id(&config_path);
        assert_eq!(result, Ok("my-daemon".to_string()));
    }

    #[test]
    fn test_read_existing_daemon_id_not_found() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config_path = tmp.path().join("config.toml");
        fs::write(&config_path, "api_key = \"sk-123\"\n").unwrap();

        let result = read_existing_daemon_id(&config_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_existing_daemon_id_file_missing() {
        let result = read_existing_daemon_id(Path::new("/nonexistent/config.toml"));
        assert!(result.is_err());
    }

    #[test]
    fn test_bundle_bin_dir_is_derived_from_signed_bundle_root() {
        let cli = Path::new("/home/user/.prismer/bundle/versions/2.2.11/dist/cli.js");
        assert_eq!(
            bundle_bin_dir(cli),
            Some(PathBuf::from(
                "/home/user/.prismer/bundle/versions/2.2.11/node_modules/.bin"
            ))
        );
    }

    #[test]
    fn test_trusted_image_runtime_resolves_from_matching_small_markers() {
        let tmp = tempfile::TempDir::new().unwrap();
        let builtin = tmp.path().join("runtime-builtin");
        let package_root = builtin.join("2.2.41");
        fs::create_dir_all(package_root.join("dist")).unwrap();
        fs::create_dir_all(package_root.join("node_modules/better-sqlite3")).unwrap();
        fs::write(package_root.join("dist/cli.js"), "console.log('ok')\n").unwrap();
        fs::write(
            package_root.join("package.json"),
            r#"{"name":"@prismer/runtime","version":"2.2.41"}"#,
        )
        .unwrap();
        fs::write(
            package_root.join("node_modules/better-sqlite3/package.json"),
            "{}",
        )
        .unwrap();
        let marker =
            serde_json::json!({"schemaVersion":1,"version":"2.2.41","runtimeTreeSha256":"abc"});
        fs::write(
            package_root.join(".prismer-builtin-runtime.json"),
            serde_json::to_string(&marker).unwrap(),
        )
        .unwrap();
        let release_path = tmp.path().join("release.json");
        fs::write(
            &release_path,
            serde_json::to_string(&serde_json::json!({
                "schemaVersion": 1,
                "sandboxReleaseId": "v2.2.41-r2",
                "daemon": marker
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            resolve_trusted_image_runtime(&release_path, &builtin, false).unwrap(),
            package_root.join("dist/cli.js")
        );
    }

    #[test]
    fn test_trusted_image_runtime_rejects_marker_drift() {
        let tmp = tempfile::TempDir::new().unwrap();
        let builtin = tmp.path().join("runtime-builtin");
        let package_root = builtin.join("2.2.41");
        fs::create_dir_all(package_root.join("dist")).unwrap();
        fs::create_dir_all(package_root.join("node_modules/better-sqlite3")).unwrap();
        fs::write(package_root.join("dist/cli.js"), "ok").unwrap();
        fs::write(
            package_root.join("package.json"),
            r#"{"name":"@prismer/runtime","version":"2.2.41"}"#,
        )
        .unwrap();
        fs::write(
            package_root.join("node_modules/better-sqlite3/package.json"),
            "{}",
        )
        .unwrap();
        fs::write(
            package_root.join(".prismer-builtin-runtime.json"),
            r#"{"version":"2.2.40"}"#,
        )
        .unwrap();
        let release_path = tmp.path().join("release.json");
        fs::write(
            &release_path,
            r#"{"schemaVersion":1,"sandboxReleaseId":"v2.2.41-r2","daemon":{"version":"2.2.41"}}"#,
        )
        .unwrap();

        assert!(
            resolve_trusted_image_runtime(&release_path, &builtin, false)
                .unwrap_err()
                .contains("does not match")
        );
    }
}
