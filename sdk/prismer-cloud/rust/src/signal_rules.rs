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

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_error(error: &str) -> SignalExtractionContext {
        SignalExtractionContext { error: Some(error.to_string()), ..Default::default() }
    }

    #[test]
    fn test_timeout() {
        let signals = extract_signals(&ctx_error("Request timed out after 30s"));
        assert_eq!(signals[0].signal_type, "error:timeout");
    }
    #[test]
    fn test_connection_refused() {
        let signals = extract_signals(&ctx_error("ECONNREFUSED 127.0.0.1:3000"));
        assert_eq!(signals[0].signal_type, "error:connection_refused");
    }
    #[test]
    fn test_dns_error() {
        let signals = extract_signals(&ctx_error("getaddrinfo ENOTFOUND api.example.com"));
        assert_eq!(signals[0].signal_type, "error:dns_error");
    }
    #[test]
    fn test_rate_limit() {
        let signals = extract_signals(&ctx_error("429 Too Many Requests"));
        assert_eq!(signals[0].signal_type, "error:rate_limit");
    }
    #[test]
    fn test_auth_error() {
        let signals = extract_signals(&ctx_error("401 Unauthorized"));
        assert_eq!(signals[0].signal_type, "error:auth_error");
    }
    #[test]
    fn test_permission_error() {
        let signals = extract_signals(&ctx_error("403 Forbidden - Access Denied"));
        assert_eq!(signals[0].signal_type, "error:permission_error");
    }
    #[test]
    fn test_not_found() {
        let signals = extract_signals(&ctx_error("404 Not Found"));
        assert_eq!(signals[0].signal_type, "error:not_found");
    }
    #[test]
    fn test_server_error() {
        let signals = extract_signals(&ctx_error("500 Internal Server Error"));
        assert_eq!(signals[0].signal_type, "error:server_error");
    }
    #[test]
    fn test_type_error() {
        let signals = extract_signals(&ctx_error("TypeError: Cannot read properties"));
        assert_eq!(signals[0].signal_type, "error:type_error");
    }
    #[test]
    fn test_syntax_error() {
        let signals = extract_signals(&ctx_error("SyntaxError: Unexpected token"));
        assert_eq!(signals[0].signal_type, "error:syntax_error");
    }
    #[test]
    fn test_reference_error() {
        let signals = extract_signals(&ctx_error("ReferenceError: foo is not defined"));
        assert_eq!(signals[0].signal_type, "error:reference_error");
    }
    #[test]
    fn test_oom() {
        let signals = extract_signals(&ctx_error("JavaScript heap out of memory"));
        assert_eq!(signals[0].signal_type, "error:oom");
    }
    #[test]
    fn test_crash() {
        let signals = extract_signals(&ctx_error("SIGSEGV: segmentation fault"));
        assert_eq!(signals[0].signal_type, "error:crash");
    }
    #[test]
    fn test_quota_exceeded() {
        let signals = extract_signals(&ctx_error("Quota exceeded for API key"));
        assert_eq!(signals[0].signal_type, "error:quota_exceeded");
    }
    #[test]
    fn test_tls_error() {
        let signals = extract_signals(&ctx_error("unable to verify the first certificate"));
        assert_eq!(signals[0].signal_type, "error:tls_error");
    }
    #[test]
    fn test_deadlock() {
        let signals = extract_signals(&ctx_error("deadlock detected in transaction"));
        assert_eq!(signals[0].signal_type, "error:deadlock");
    }
    #[test]
    fn test_fallback_normalization() {
        let signals = extract_signals(&ctx_error("some weird error @#$ happened"));
        assert!(signals[0].signal_type.starts_with("error:"));
        assert!(!signals[0].signal_type.contains('@'));
    }
    #[test]
    fn test_no_error_no_signals() {
        let ctx = SignalExtractionContext::default();
        let signals = extract_signals(&ctx);
        assert!(signals.is_empty());
    }
    #[test]
    fn test_task_failed() {
        let ctx = SignalExtractionContext { task_status: Some("failed".to_string()), ..Default::default() };
        let signals = extract_signals(&ctx);
        assert_eq!(signals[0].signal_type, "task.failed");
    }
    #[test]
    fn test_task_completed() {
        let ctx = SignalExtractionContext { task_status: Some("completed".to_string()), ..Default::default() };
        let signals = extract_signals(&ctx);
        assert_eq!(signals[0].signal_type, "task.completed");
    }
    #[test]
    fn test_capability() {
        let ctx = SignalExtractionContext { task_capability: Some("code_review".to_string()), ..Default::default() };
        let signals = extract_signals(&ctx);
        assert_eq!(signals[0].signal_type, "capability:code_review");
    }
    #[test]
    fn test_custom_tags() {
        let ctx = SignalExtractionContext { tags: vec!["custom:tag1".to_string(), "custom:tag2".to_string()], ..Default::default() };
        let signals = extract_signals(&ctx);
        assert_eq!(signals.len(), 2);
        assert_eq!(signals[0].signal_type, "custom:tag1");
    }
    #[test]
    fn test_combined() {
        let ctx = SignalExtractionContext {
            error: Some("Request timed out".to_string()),
            task_status: Some("failed".to_string()),
            task_capability: Some("api_call".to_string()),
            tags: vec!["env:test".to_string()],
            provider: Some("openai".to_string()),
            ..Default::default()
        };
        let signals = extract_signals(&ctx);
        assert_eq!(signals.len(), 4);
        assert_eq!(signals[0].signal_type, "error:timeout");
        assert_eq!(signals[0].provider, Some("openai".to_string()));
    }
    #[test]
    fn test_provider_stage_severity() {
        let ctx = SignalExtractionContext {
            error: Some("timeout".to_string()),
            provider: Some("openai".to_string()),
            stage: Some("inference".to_string()),
            severity: Some("critical".to_string()),
            ..Default::default()
        };
        let signals = extract_signals(&ctx);
        assert_eq!(signals[0].provider, Some("openai".to_string()));
        assert_eq!(signals[0].stage, Some("inference".to_string()));
        assert_eq!(signals[0].severity, Some("critical".to_string()));
    }
}
