use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct ParseClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> ParseClient<'a> {
    /// Submit a document for parsing (URL or base64).
    pub async fn submit(&self, input: &str, mode: Option<&str>) -> Result<ApiResponse<ParseResult>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/parse",
            Some(json!({
                "input": input,
                "mode": mode.unwrap_or("fast"),
            })),
        ).await
    }

    /// Check parse task status.
    pub async fn status(&self, task_id: &str) -> Result<ApiResponse<ParseResult>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/parse/status/{}", task_id),
            None,
        ).await
    }

    /// Get parse result.
    pub async fn result(&self, task_id: &str) -> Result<ApiResponse<ParseResult>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/parse/result/{}", task_id),
            None,
        ).await
    }
}
