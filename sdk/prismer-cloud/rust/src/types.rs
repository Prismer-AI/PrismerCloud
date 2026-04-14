use serde::{Deserialize, Serialize};

/// IM message content types (v1.8.2).
///
/// The wire protocol uses strings; this module exposes them as `&'static str`
/// constants so Rust users get autocomplete and catch typos at compile time.
pub mod message_type {
    pub const TEXT: &str = "text";
    pub const MARKDOWN: &str = "markdown";
    pub const CODE: &str = "code";
    pub const IMAGE: &str = "image";
    pub const FILE: &str = "file";
    pub const VOICE: &str = "voice"; // v1.8.2
    pub const LOCATION: &str = "location"; // v1.8.2
    pub const ARTIFACT: &str = "artifact"; // v1.8.2
    pub const TOOL_CALL: &str = "tool_call";
    pub const TOOL_RESULT: &str = "tool_result";
    /// Deprecated — use `SYSTEM` with `metadata.action`.
    pub const SYSTEM_EVENT: &str = "system_event";
    pub const SYSTEM: &str = "system"; // v1.8.2
    pub const THINKING: &str = "thinking";
}

/// Artifact sub-types for `message_type::ARTIFACT` (v1.8.2).
/// Passed via `metadata.artifactType`.
pub mod artifact_type {
    pub const PDF: &str = "pdf";
    pub const CODE: &str = "code";
    pub const DOCUMENT: &str = "document";
    pub const DATASET: &str = "dataset";
    pub const CHART: &str = "chart";
    pub const NOTEBOOK: &str = "notebook";
    pub const LATEX: &str = "latex";
    pub const OTHER: &str = "other";
}

/// Standard API response wrapper.
#[derive(Debug, Deserialize)]
pub struct ApiResponse<T> {
    pub success: Option<bool>,
    pub ok: Option<bool>,
    pub data: Option<T>,
    pub error: Option<ApiError>,
}

impl<T> ApiResponse<T> {
    pub fn is_ok(&self) -> bool {
        self.success.unwrap_or(false) || self.ok.unwrap_or(false)
    }
}

#[derive(Debug, Deserialize)]
pub struct ApiError {
    pub code: Option<String>,
    pub message: Option<String>,
}

/// SDK error types.
#[derive(Debug)]
pub enum PrismerError {
    Network(String),
    Api { status: u16, message: String },
    Parse(String),
}

impl std::fmt::Display for PrismerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PrismerError::Network(e) => write!(f, "Network error: {}", e),
            PrismerError::Api { status, message } => write!(f, "API error {}: {}", status, message),
            PrismerError::Parse(e) => write!(f, "Parse error: {}", e),
        }
    }
}

impl std::error::Error for PrismerError {}

/// Context Load result.
#[derive(Debug, Serialize, Deserialize)]
pub struct ContextLoadResult {
    pub results: Option<Vec<ContextItem>>,
    #[serde(rename = "processingTime")]
    pub processing_time: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ContextItem {
    pub title: Option<String>,
    pub url: Option<String>,
    pub content: Option<String>,
    pub score: Option<f64>,
}

/// Parse result.
#[derive(Debug, Serialize, Deserialize)]
pub struct ParseResult {
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    pub status: Option<String>,
    pub document: Option<serde_json::Value>,
}

/// IM types.
#[derive(Debug, Serialize, Deserialize)]
pub struct SignalTag {
    #[serde(rename = "type")]
    pub signal_type: String,
    pub provider: Option<String>,
    pub stage: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gene {
    pub id: String,
    pub category: Option<String>,
    pub title: Option<String>,
    pub signals_match: Option<Vec<serde_json::Value>>,
    pub strategy: Option<Vec<String>>,
    pub visibility: Option<String>,
    pub success_count: Option<i64>,
    pub failure_count: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EvolutionAdvice {
    pub action: String,
    pub gene: Option<Gene>,
    pub confidence: Option<f64>,
    pub signals: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EvolutionMetrics {
    pub standard: Option<serde_json::Value>,
    pub hypergraph: Option<serde_json::Value>,
    pub verdict: Option<String>,
}

// ============================================================================
// IM Task Types
// ============================================================================

/// A task returned from the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMTask {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub capability: Option<String>,
    pub input: Option<serde_json::Value>,
    #[serde(rename = "contextUri")]
    pub context_uri: Option<String>,
    #[serde(rename = "creatorId")]
    pub creator_id: String,
    #[serde(rename = "assigneeId")]
    pub assignee_id: Option<String>,
    pub status: String,
    pub progress: Option<f64>,
    #[serde(rename = "statusMessage")]
    pub status_message: Option<String>,
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    #[serde(rename = "ownerType")]
    pub owner_type: Option<String>,
    #[serde(rename = "ownerName")]
    pub owner_name: Option<String>,
    #[serde(rename = "assigneeType")]
    pub assignee_type: Option<String>,
    #[serde(rename = "assigneeName")]
    pub assignee_name: Option<String>,
    #[serde(rename = "scheduleType")]
    pub schedule_type: Option<String>,
    #[serde(rename = "scheduleCron")]
    pub schedule_cron: Option<String>,
    #[serde(rename = "intervalMs")]
    pub interval_ms: Option<i64>,
    #[serde(rename = "nextRunAt")]
    pub next_run_at: Option<String>,
    #[serde(rename = "lastRunAt")]
    pub last_run_at: Option<String>,
    #[serde(rename = "runCount")]
    pub run_count: Option<i64>,
    #[serde(rename = "maxRuns")]
    pub max_runs: Option<i64>,
    pub result: Option<serde_json::Value>,
    #[serde(rename = "resultUri")]
    pub result_uri: Option<String>,
    pub error: Option<String>,
    pub budget: Option<f64>,
    pub cost: Option<f64>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<i64>,
    pub deadline: Option<String>,
    #[serde(rename = "maxRetries")]
    pub max_retries: Option<i64>,
    #[serde(rename = "retryDelayMs")]
    pub retry_delay_ms: Option<i64>,
    #[serde(rename = "retryCount")]
    pub retry_count: Option<i64>,
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// A single log entry for a task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMTaskLog {
    pub id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "actorId")]
    pub actor_id: Option<String>,
    pub action: String,
    pub message: Option<String>,
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// A task with its logs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMTaskDetail {
    pub task: IMTask,
    pub logs: Vec<IMTaskLog>,
}

// ============================================================================
// Realtime Event Payloads
// ============================================================================

/// Payload for a new message event.
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageNewPayload {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub routing: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Payload for a message edit event.
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageEditPayload {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "editedAt")]
    pub edited_at: String,
    #[serde(rename = "editedBy")]
    pub edited_by: String,
    pub metadata: Option<serde_json::Value>,
}

/// Payload for a message deleted event.
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageDeletedPayload {
    pub id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── ApiResponse ──────────────────────────────────────

    #[test]
    fn api_response_is_ok_with_success_true() {
        let resp: ApiResponse<()> = ApiResponse {
            success: Some(true),
            ok: None,
            data: None,
            error: None,
        };
        assert!(resp.is_ok());
    }

    #[test]
    fn api_response_is_ok_with_ok_true() {
        let resp: ApiResponse<()> = ApiResponse {
            success: None,
            ok: Some(true),
            data: None,
            error: None,
        };
        assert!(resp.is_ok());
    }

    #[test]
    fn api_response_is_ok_both_false() {
        let resp: ApiResponse<()> = ApiResponse {
            success: Some(false),
            ok: Some(false),
            data: None,
            error: None,
        };
        assert!(!resp.is_ok());
    }

    #[test]
    fn api_response_is_ok_all_none() {
        let resp: ApiResponse<()> = ApiResponse {
            success: None,
            ok: None,
            data: None,
            error: None,
        };
        assert!(!resp.is_ok());
    }

    #[test]
    fn api_response_deserialize_success_field() {
        let json_str = r#"{"success": true, "data": {"results": []}}"#;
        let resp: ApiResponse<ContextLoadResult> = serde_json::from_str(json_str).unwrap();
        assert!(resp.is_ok());
        assert!(resp.data.is_some());
    }

    #[test]
    fn api_response_deserialize_ok_field() {
        let json_str = r#"{"ok": true, "data": null}"#;
        let resp: ApiResponse<serde_json::Value> = serde_json::from_str(json_str).unwrap();
        assert!(resp.is_ok());
    }

    #[test]
    fn api_response_deserialize_with_error() {
        let json_str = r#"{"success": false, "error": {"code": "UNAUTHORIZED", "message": "Bad key"}}"#;
        let resp: ApiResponse<()> = serde_json::from_str(json_str).unwrap();
        assert!(!resp.is_ok());
        let err = resp.error.unwrap();
        assert_eq!(err.code.as_deref(), Some("UNAUTHORIZED"));
        assert_eq!(err.message.as_deref(), Some("Bad key"));
    }

    // ── PrismerError Display ─────────────────────────────

    #[test]
    fn error_display_network() {
        let e = PrismerError::Network("connection refused".to_string());
        assert_eq!(e.to_string(), "Network error: connection refused");
    }

    #[test]
    fn error_display_api() {
        let e = PrismerError::Api { status: 401, message: "Unauthorized".to_string() };
        assert_eq!(e.to_string(), "API error 401: Unauthorized");
    }

    #[test]
    fn error_display_parse() {
        let e = PrismerError::Parse("invalid json".to_string());
        assert_eq!(e.to_string(), "Parse error: invalid json");
    }

    #[test]
    fn error_implements_std_error() {
        let e: Box<dyn std::error::Error> = Box::new(PrismerError::Network("test".into()));
        assert!(e.to_string().contains("Network error"));
    }

    // ── ContextLoadResult serde roundtrip ────────────────

    #[test]
    fn context_load_result_roundtrip() {
        let result = ContextLoadResult {
            results: Some(vec![ContextItem {
                title: Some("Test".to_string()),
                url: Some("https://example.com".to_string()),
                content: Some("Hello".to_string()),
                score: Some(0.95),
            }]),
            processing_time: Some(123),
        };
        let json = serde_json::to_string(&result).unwrap();
        let decoded: ContextLoadResult = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.processing_time, Some(123));
        assert_eq!(decoded.results.as_ref().unwrap().len(), 1);
        assert_eq!(decoded.results.as_ref().unwrap()[0].title.as_deref(), Some("Test"));
    }

    #[test]
    fn context_load_result_processing_time_rename() {
        let json_str = r#"{"processingTime": 456, "results": null}"#;
        let decoded: ContextLoadResult = serde_json::from_str(json_str).unwrap();
        assert_eq!(decoded.processing_time, Some(456));
    }

    // ── ParseResult serde ────────────────────────────────

    #[test]
    fn parse_result_roundtrip() {
        let result = ParseResult {
            task_id: Some("task-123".to_string()),
            status: Some("completed".to_string()),
            document: Some(json!({"pages": 5})),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("taskId")); // verify rename
        let decoded: ParseResult = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.task_id.as_deref(), Some("task-123"));
    }

    // ── SignalTag serde ──────────────────────────────────

    #[test]
    fn signal_tag_roundtrip() {
        let tag = SignalTag {
            signal_type: "error:timeout".to_string(),
            provider: Some("openai".to_string()),
            stage: Some("fetch".to_string()),
            severity: Some("high".to_string()),
        };
        let json = serde_json::to_string(&tag).unwrap();
        assert!(json.contains(r#""type":"error:timeout"#));
        let decoded: SignalTag = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.signal_type, "error:timeout");
        assert_eq!(decoded.provider.as_deref(), Some("openai"));
    }

    #[test]
    fn signal_tag_minimal() {
        let json_str = r#"{"type": "task.completed"}"#;
        let tag: SignalTag = serde_json::from_str(json_str).unwrap();
        assert_eq!(tag.signal_type, "task.completed");
        assert!(tag.provider.is_none());
    }

    // ── Gene serde ───────────────────────────────────────

    #[test]
    fn gene_roundtrip() {
        let gene = Gene {
            id: "gene-1".to_string(),
            category: Some("error-handling".to_string()),
            title: Some("Timeout Fix".to_string()),
            signals_match: Some(vec![json!("error:timeout")]),
            strategy: Some(vec!["increase timeout".to_string()]),
            visibility: Some("public".to_string()),
            success_count: Some(10),
            failure_count: Some(2),
        };
        let json = serde_json::to_string(&gene).unwrap();
        let decoded: Gene = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.id, "gene-1");
        assert_eq!(decoded.strategy.as_ref().unwrap()[0], "increase timeout");
    }

    #[test]
    fn gene_clone() {
        let gene = Gene {
            id: "g1".to_string(),
            category: None,
            title: None,
            signals_match: None,
            strategy: None,
            visibility: None,
            success_count: None,
            failure_count: None,
        };
        let cloned = gene.clone();
        assert_eq!(cloned.id, "g1");
    }

    // ── EvolutionAdvice serde ────────────────────────────

    #[test]
    fn evolution_advice_roundtrip() {
        let advice = EvolutionAdvice {
            action: "apply_gene".to_string(),
            gene: Some(Gene {
                id: "g1".into(), category: None, title: None,
                signals_match: None, strategy: None, visibility: None,
                success_count: None, failure_count: None,
            }),
            confidence: Some(0.85),
            signals: Some(vec![json!({"type": "error:timeout"})]),
        };
        let json = serde_json::to_string(&advice).unwrap();
        let decoded: EvolutionAdvice = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.action, "apply_gene");
        assert_eq!(decoded.confidence, Some(0.85));
    }

    // ── MessageNewPayload serde ──────────────────────────

    #[test]
    fn message_new_payload_roundtrip() {
        let payload = MessageNewPayload {
            id: "msg-1".to_string(),
            conversation_id: "conv-1".to_string(),
            content: "Hello".to_string(),
            msg_type: "text".to_string(),
            sender_id: "user-1".to_string(),
            routing: None,
            metadata: Some(json!({"key": "value"})),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("conversationId"));
        assert!(json.contains("senderId"));
        assert!(json.contains("createdAt"));
        let decoded: MessageNewPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.id, "msg-1");
        assert_eq!(decoded.conversation_id, "conv-1");
    }

    // ── MessageEditPayload serde ─────────────────────────

    #[test]
    fn message_edit_payload_roundtrip() {
        let payload = MessageEditPayload {
            id: "msg-1".to_string(),
            conversation_id: "conv-1".to_string(),
            content: "Edited".to_string(),
            msg_type: "text".to_string(),
            edited_at: "2026-01-01T01:00:00Z".to_string(),
            edited_by: "user-2".to_string(),
            metadata: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("editedAt"));
        assert!(json.contains("editedBy"));
        let decoded: MessageEditPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.edited_by, "user-2");
    }

    // ── MessageDeletedPayload serde ──────────────────────

    #[test]
    fn message_deleted_payload_roundtrip() {
        let payload = MessageDeletedPayload {
            id: "msg-99".to_string(),
            conversation_id: "conv-5".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        let decoded: MessageDeletedPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.id, "msg-99");
        assert_eq!(decoded.conversation_id, "conv-5");
    }
}
