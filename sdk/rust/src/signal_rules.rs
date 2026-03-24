//! Signal Enrichment — SDK-side signal extraction using regex rules.
//!
//! Ported from server's signal-extractor.ts. 16 error patterns.
//! Zero external deps beyond std, synchronous.

use crate::types::SignalTag;

/// Execution context for signal extraction.
pub struct SignalExtractionContext {
    pub error: Option<String>,
    pub task_status: Option<String>,
    pub task_capability: Option<String>,
    pub provider: Option<String>,
    pub stage: Option<String>,
    pub severity: Option<String>,
    pub tags: Vec<String>,
}

impl Default for SignalExtractionContext {
    fn default() -> Self {
        Self {
            error: None,
            task_status: None,
            task_capability: None,
            provider: None,
            stage: None,
            severity: None,
            tags: Vec::new(),
        }
    }
}

struct ErrorPattern {
    keywords: &'static [&'static str],
    signal_type: &'static str,
}

const ERROR_PATTERNS: &[ErrorPattern] = &[
    ErrorPattern { keywords: &["timeout", "timed out", "timedout", "deadline exceeded", "context deadline"], signal_type: "timeout" },
    ErrorPattern { keywords: &["econnrefused", "connection refused"], signal_type: "connection_refused" },
    ErrorPattern { keywords: &["enotfound", "dns", "getaddrinfo", "resolve"], signal_type: "dns_error" },
    ErrorPattern { keywords: &["rate limit", "too many requests", "429"], signal_type: "rate_limit" },
    ErrorPattern { keywords: &["401", "unauthorized", "unauthenticated"], signal_type: "auth_error" },
    ErrorPattern { keywords: &["403", "forbidden", "access denied", "permission"], signal_type: "permission_error" },
    ErrorPattern { keywords: &["404", "not found"], signal_type: "not_found" },
    ErrorPattern { keywords: &["500", "502", "503", "504", "internal server", "server error"], signal_type: "server_error" },
    ErrorPattern { keywords: &["typeerror", "type error"], signal_type: "type_error" },
    ErrorPattern { keywords: &["syntaxerror", "syntax error", "unexpected token"], signal_type: "syntax_error" },
    ErrorPattern { keywords: &["referenceerror", "reference error", "is not defined"], signal_type: "reference_error" },
    ErrorPattern { keywords: &["out of memory", "oom", "heap", "allocation failed"], signal_type: "oom" },
    ErrorPattern { keywords: &["crash", "panic", "segfault", "sigsegv", "sigabrt"], signal_type: "crash" },
    ErrorPattern { keywords: &["quota", "limit exceeded", "insufficient"], signal_type: "quota_exceeded" },
    ErrorPattern { keywords: &["tls", "ssl", "certificate", "cert verify"], signal_type: "tls_error" },
    ErrorPattern { keywords: &["deadlock", "lock timeout", "lock wait"], signal_type: "deadlock" },
];

/// Extract structured SignalTag list from execution context.
/// Pure keyword matching, zero external deps, synchronous.
pub fn extract_signals(ctx: &SignalExtractionContext) -> Vec<SignalTag> {
    let mut result = Vec::new();

    if let Some(error) = &ctx.error {
        let lower = error.to_lowercase();
        let mut matched = false;

        for pattern in ERROR_PATTERNS {
            if pattern.keywords.iter().any(|kw| lower.contains(kw)) {
                let tag = SignalTag {
                    signal_type: format!("error:{}", pattern.signal_type),
                    provider: ctx.provider.clone(),
                    stage: ctx.stage.clone(),
                    severity: ctx.severity.clone(),
                };
                result.push(tag);
                matched = true;
                break;
            }
        }

        if !matched {
            let normalized: String = lower.chars().take(50)
                .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            result.push(SignalTag {
                signal_type: format!("error:{}", normalized),
                provider: ctx.provider.clone(),
                stage: ctx.stage.clone(),
                severity: None,
            });
        }
    }

    if let Some(status) = &ctx.task_status {
        match status.as_str() {
            "failed" => result.push(SignalTag { signal_type: "task.failed".to_string(), provider: None, stage: None, severity: None }),
            "completed" => result.push(SignalTag { signal_type: "task.completed".to_string(), provider: None, stage: None, severity: None }),
            _ => {}
        }
    }

    if let Some(cap) = &ctx.task_capability {
        result.push(SignalTag { signal_type: format!("capability:{}", cap), provider: None, stage: None, severity: None });
    }

    for tag in &ctx.tags {
        result.push(SignalTag { signal_type: tag.clone(), provider: None, stage: None, severity: None });
    }

    result
}
