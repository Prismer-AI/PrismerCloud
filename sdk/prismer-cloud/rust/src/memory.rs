use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct MemoryClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> MemoryClient<'a> {
    /// Create a memory file.
    pub async fn create_file(&self, path: &str, content: &str, scope: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "path": path, "content": content });
        if let Some(s) = scope { body["scope"] = json!(s); }
        self.client.request(reqwest::Method::POST, "/api/im/memory/files", Some(body)).await
    }

    /// List memory files.
    pub async fn list_files(&self, scope: Option<&str>, path: Option<&str>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut params = vec![];
        if let Some(s) = scope { params.push(format!("scope={}", s)); }
        if let Some(p) = path { params.push(format!("path={}", p)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/memory/files{}", qs), None).await
    }

    /// Get a memory file by ID.
    pub async fn get_file(&self, file_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/memory/files/{}", file_id), None).await
    }

    /// Update a memory file.
    pub async fn update_file(&self, file_id: &str, operation: &str, content: &str, section: Option<&str>, version: Option<i32>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "operation": operation, "content": content });
        if let Some(s) = section { body["section"] = json!(s); }
        if let Some(v) = version { body["version"] = json!(v); }
        self.client.request(reqwest::Method::PATCH, &format!("/api/im/memory/files/{}", file_id), Some(body)).await
    }

    /// Delete a memory file.
    pub async fn delete_file(&self, file_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::DELETE, &format!("/api/im/memory/files/{}", file_id), None).await
    }

    /// Create a compaction summary.
    pub async fn compact(&self, conversation_id: &str, summary: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/memory/compact",
            Some(json!({ "conversationId": conversation_id, "summary": summary })),
        ).await
    }

    /// Load auto-memory (MEMORY.md).
    pub async fn load(&self, scope: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut params = vec![];
        if let Some(s) = scope { params.push(format!("scope={}", s)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/memory/load{}", qs), None).await
    }

    /// Get memory-gene knowledge links for the authenticated user's memory files (v1.8.0).
    pub async fn get_knowledge_links(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/memory/links", None).await
    }
}
