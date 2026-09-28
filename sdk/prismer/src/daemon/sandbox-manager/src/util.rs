// util.rs — Shared utility functions for sandbox-manager.

use std::ffi::{CStr, CString};
use std::process::Command;
use std::time::SystemTime;

/// Restricted carriers already run as the Runtime user. Never ask setuid sudo
/// to switch to the identity we already hold (no_new_privs correctly rejects it).
pub fn command_as_user(user: &str, program: &str, preserve_env: bool) -> Command {
    let mut storage = vec![0u8; 16384];
    let mut account = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let name = CString::new(user).expect("invalid Runtime username");
    let target = unsafe {
        let status = libc::getpwnam_r(
            name.as_ptr(),
            account.as_mut_ptr(),
            storage.as_mut_ptr().cast(),
            storage.len(),
            &mut result,
        );
        if status == 0 && !result.is_null() {
            let account = account.assume_init();
            Some((
                account.pw_uid,
                CStr::from_ptr(account.pw_dir)
                    .to_string_lossy()
                    .into_owned(),
            ))
        } else {
            None
        }
    };
    command_for_identity(
        user,
        program,
        preserve_env,
        unsafe { libc::getuid() },
        unsafe { libc::geteuid() },
        target.as_ref().map(|(uid, home)| (*uid, home.as_str())),
    )
}

fn command_for_identity(
    user: &str,
    program: &str,
    preserve_env: bool,
    real: u32,
    effective: u32,
    target: Option<(u32, &str)>,
) -> Command {
    if let Some((uid, home)) = target {
        if uid != 0 && real == uid && effective == uid {
            let mut command = Command::new(program);
            if preserve_env {
                command
                    .env("HOME", home)
                    .env("USER", user)
                    .env("LOGNAME", user);
            }
            return command;
        }
    }
    let mut command = Command::new("sudo");
    command.args(["-u", user]);
    if preserve_env {
        command.args(["-H", "--preserve-env"]);
    }
    command.arg(program);
    command
}

/// Get current time as ISO 8601 string (UTC, e.g. "2026-08-07T00:00:00.000Z").
pub fn epoch_to_iso8601() -> String {
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format_iso8601_millis(dur.as_secs(), dur.subsec_millis())
}

/// Format a Unix timestamp with canonical millisecond precision.
pub fn format_iso8601_millis(secs: u64, millis: u32) -> String {
    assert!(millis <= 999, "milliseconds must be in 0..=999");
    format_iso8601_parts(secs, millis)
}

fn format_iso8601_parts(secs: u64, millis: u32) -> String {
    let days_since_epoch = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let (year, month, day) = days_to_date(days_since_epoch);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, minutes, seconds, millis
    )
}

fn days_to_date(days: i64) -> (i64, u32, u32) {
    let mut y = 1970i64;
    let mut d = days;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0u32;
    while m < 12 && d >= month_days[m as usize] as i64 {
        d -= month_days[m as usize] as i64;
        m += 1;
    }
    (y, m + 1, (d + 1) as u32)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_nonroot_identity_executes_directly_with_target_home() {
        let cmd =
            command_for_identity("user", "node", true, 1000, 1000, Some((1000, "/home/user")));
        assert_eq!(cmd.get_program(), "node");
        assert_eq!(cmd.get_args().count(), 0);
        assert!(
            cmd.get_envs()
                .any(|(key, value)| key == "HOME"
                    && value == Some(std::ffi::OsStr::new("/home/user")))
        );
    }

    #[test]
    fn other_or_unresolved_identity_keeps_sudo_boundary() {
        for (real, effective, target) in [
            (999, 999, Some((1000, "/home/user"))),
            (0, 1000, Some((1000, "/home/user"))),
            (1000, 1000, None),
            (0, 0, Some((0, "/root"))),
        ] {
            let cmd = command_for_identity("user", "node", true, real, effective, target);
            assert_eq!(cmd.get_program(), "sudo");
            let args: Vec<_> = cmd.get_args().map(|v| v.to_str().unwrap()).collect();
            assert_eq!(args, ["-u", "user", "-H", "--preserve-env", "node"]);
        }
    }

    #[test]
    fn test_format_iso8601_millis_preserves_same_second_ordering() {
        assert_eq!(
            format_iso8601_millis(1754524800, 123),
            "2025-08-07T00:00:00.123Z"
        );
        assert!(format_iso8601_millis(1754524800, 456) > format_iso8601_millis(1754524800, 123));
    }

    #[test]
    fn test_epoch_to_iso8601_returns_current() {
        let ts = epoch_to_iso8601();
        assert!(!ts.is_empty());
        assert!(ts.ends_with("Z"));
    }
}
