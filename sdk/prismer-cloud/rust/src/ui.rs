//! Simplified CLI UI primitives per §15 cli-design spec
//!
//! This module provides consistent, beautiful CLI output across Prismer SDKs.
//! Design reference: docs/version190/15-cli-design.md

use std::env;

// ============================================================================
// Color codes
// ============================================================================

pub const COLOR_RESET: &str = "\x1b[0m";
pub const COLOR_RED: &str = "\x1b[31m";
pub const COLOR_GREEN: &str = "\x1b[32m";
pub const COLOR_YELLOW: &str = "\x1b[33m";
pub const COLOR_CYAN: &str = "\x1b[36m";
pub const COLOR_DIM: &str = "\x1b[2m";
pub const COLOR_BOLD: &str = "\x1b[1m";

// ============================================================================
// Status indicators per §15
// ============================================================================

pub const STATUS_OK: &str = "✓";
pub const STATUS_FAIL: &str = "✗";
pub const STATUS_ONLINE: &str = "●";
pub const STATUS_OFFLINE: &str = "○";
pub const STATUS_PENDING: &str = "⟳";
pub const STATUS_NOT_INSTALLED: &str = "·";

// ============================================================================
// Brand icon - compact mode only
// ============================================================================

pub const COMPACT_BANNER: [&str; 2] = ["◇ PRISMER", "  Runtime CLI"];

// ============================================================================
// Output mode
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Pretty,
    JSON,
    Quiet,
}

// ============================================================================
// UI struct
// ============================================================================

pub struct UI {
    color_enabled: bool,
    mode: OutputMode,
    width: usize,
}

impl UI {
    pub fn new() -> Self {
        let color_enabled = supports_color();
        let width = get_terminal_width();
        UI {
            color_enabled,
            mode: OutputMode::Pretty,
            width,
        }
    }

    pub fn set_mode(&mut self, mode: OutputMode) {
        self.mode = mode;
    }

    pub fn set_color(&mut self, enabled: bool) {
        self.color_enabled = enabled;
    }

    fn ansi(&self, code: &str, text: &str) -> String {
        if !self.color_enabled {
            return text.to_string();
        }
        format!("{}{}{}", code, text, COLOR_RESET)
    }

    fn red(&self, text: &str) -> String {
        self.ansi(COLOR_RED, text)
    }

    fn green(&self, text: &str) -> String {
        self.ansi(COLOR_GREEN, text)
    }

    fn yellow(&self, text: &str) -> String {
        self.ansi(COLOR_YELLOW, text)
    }

    fn cyan(&self, text: &str) -> String {
        self.ansi(COLOR_CYAN, text)
    }

    fn dim(&self, text: &str) -> String {
        self.ansi(COLOR_DIM, text)
    }

    fn bold(&self, text: &str) -> String {
        self.ansi(COLOR_BOLD, text)
    }

    // Level 1: Header
    pub fn header(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("{}", self.bold(text));
    }

    pub fn banner(&self, subtitle: Option<&str>, full: bool) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }

        if full && self.width >= 120 {
            for line in COMPACT_BANNER {
                println!("{}", self.cyan(line));
            }
        } else {
            println!("{}", self.cyan("◇ PRISMER"));
            println!("{}", self.dim("  Runtime CLI"));
        }

        if let Some(sub) = subtitle {
            println!("  {}", self.dim(sub));
        }
        println!();
    }

    // Level 2: Primary data
    pub fn blank(&self) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!();
    }

    pub fn line(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("{}", text);
    }

    pub fn info(&self, text: &str) {
        self.line(text);
    }

    // Level 3: Secondary
    pub fn secondary(&self, text: &str, indent: usize) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        let _padding: String = " ".repeat(indent);
        println!("{}{}", _padding, self.dim(text));
    }

    // Level 4: Action tips
    pub fn tip(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("Tip: {}", self.cyan(text));
    }

    pub fn next(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("Next: {}", self.cyan(text));
    }

    // Level 5: Status indicators
    pub fn ok(&self, text: &str, detail: Option<&str>) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        let suffix = match detail {
            Some(d) => format!("  {}", self.dim(d)),
            None => String::new(),
        };
        println!("  {} {}{}", self.green(STATUS_OK), text, suffix);
    }

    pub fn success(&self, text: &str, detail: Option<&str>) {
        self.ok(text, detail);
    }

    pub fn fail(&self, text: &str, detail: Option<&str>) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        let suffix = match detail {
            Some(d) => format!("  {}", self.dim(d)),
            None => String::new(),
        };
        println!("  {} {}{}", self.red(STATUS_FAIL), text, suffix);
    }

    pub fn online(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("  {} {}", self.green(STATUS_ONLINE), text);
    }

    pub fn offline(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("  {} {}", self.dim(STATUS_OFFLINE), text);
    }

    pub fn not_installed(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("  {} {}", self.dim(STATUS_NOT_INSTALLED), self.dim(text));
    }

    pub fn pending(&self, text: &str) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        println!("  {} {}", self.yellow(STATUS_PENDING), text);
    }

    pub fn warn(&self, text: &str, detail: Option<&str>) {
        if self.mode == OutputMode::Quiet || self.mode == OutputMode::JSON {
            return;
        }
        let suffix = match detail {
            Some(d) => format!("  {}", self.dim(d)),
            None => String::new(),
        };
        println!("  ! {}{}", text, suffix);
    }

    // Level 6: Error block
    pub fn error(&self, what: &str, cause: Option<&str>, fix: Option<&str>) {
        if self.mode == OutputMode::JSON {
            self.write_json_error(what, cause, fix);
            return;
        }
        eprintln!("{} {}", self.red(STATUS_FAIL), what);
        if let Some(c) = cause {
            eprintln!("  Cause: {}", self.dim(c));
        }
        if let Some(f) = fix {
            eprintln!("  Fix: {}{}", self.cyan(f), COLOR_RESET);
        }
    }

    fn write_json_error(&self, what: &str, cause: Option<&str>, fix: Option<&str>) {
        use serde_json::{json, Value};
        let mut err = json!({"error": what});
        if let Some(c) = cause {
            err["cause"] = Value::String(c.to_string());
        }
        if let Some(f) = fix {
            err["fix"] = Value::String(f.to_string());
        }
        eprintln!("{}", serde_json::to_string_pretty(&err).unwrap_or_default());
    }

    // JSON output
    pub fn json(&self, payload: &serde_json::Value) {
        let output = if payload.is_object() {
            serde_json::to_string_pretty(payload).unwrap_or_default()
        } else {
            payload.to_string()
        };
        println!("{}", output);
    }

    pub fn result<T: serde::Serialize>(&self, pretty: impl FnOnce(), json_payload: T) {
        match self.mode {
            OutputMode::Pretty => pretty(),
            _ => self.json(&serde_json::to_value(json_payload).unwrap_or(serde_json::json!(null))),
        }
    }

    // Brand voice checker
    pub fn check_brand_voice(text: &str, field: &str) -> Result<(), String> {
        // Check for forbidden substrings
        for fs in ["Sorry", "Unfortunately", "Oops"].iter() {
            if text.contains(fs) {
                return Err(format!("Brand voice error in {}: found forbidden substring {:?}", field, fs));
            }
        }

        // Check for forbidden words (whole word match)
        for fw in ["Please"].iter() {
            let words: Vec<&str> = text.split_whitespace().collect();
            if words.iter().any(|w| *w == *fw) {
                return Err(format!("Brand voice error in {}: found forbidden word {:?}", field, fw));
            }
        }

        // Check for trailing exclamation marks
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let in_double_quote = trimmed.contains('"');
            let in_single_quote = trimmed.contains('\'');
            if in_double_quote || in_single_quote {
                continue;
            }

            if trimmed.ends_with('!') && !trimmed.ends_with("!!") {
                return Err(format!("Brand voice error in {}: trailing exclamation mark in {:?}", field, line));
            }
        }

        Ok(())
    }
}

pub fn get_terminal_width() -> usize {
    if let Ok(cols) = env::var("COLUMNS") {
        if let Ok(width) = cols.parse::<usize>() {
            if width > 0 {
                return width;
            }
        }
    }
    80
}

fn supports_color() -> bool {
    env::var("NO_COLOR").is_ok()
}
