use serde::{Deserialize, Serialize};

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
