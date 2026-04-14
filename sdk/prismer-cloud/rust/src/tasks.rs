use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct TasksClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> TasksClient<'a> {
    /// Create a new task.
    pub async fn create(
        &self,
        title: &str,
        description: Option<&str>,
        capability: Option<&str>,
        assignee_id: Option<&str>,
        budget: Option<f64>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "title": title });
        if let Some(d) = description { body["description"] = json!(d); }
        if let Some(c) = capability { body["capability"] = json!(c); }
        if let Some(a) = assignee_id { body["assigneeId"] = json!(a); }
        if let Some(b) = budget { body["budget"] = json!(b); }
        self.client.request(reqwest::Method::POST, "/api/im/tasks", Some(body)).await
    }

    /// List tasks with optional filters.
    pub async fn list(
        &self,
        status: Option<&str>,
        capability: Option<&str>,
        limit: Option<u32>,
    ) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut params = vec![];
        if let Some(s) = status { params.push(format!("status={}", s)); }
        if let Some(c) = capability { params.push(format!("capability={}", c)); }
        if let Some(l) = limit { params.push(format!("limit={}", l)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/tasks{}", qs), None).await
    }

    /// Get a task by ID.
    pub async fn get(&self, task_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/tasks/{}", task_id), None).await
    }

    /// Claim a task.
    pub async fn claim(&self, task_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::POST, &format!("/api/im/tasks/{}/claim", task_id), None).await
    }

    /// Report task progress.
    pub async fn progress(&self, task_id: &str, message: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let body = message.map(|m| json!({ "message": m }));
        self.client.request(reqwest::Method::POST, &format!("/api/im/tasks/{}/progress", task_id), body).await
    }

    /// Complete a task.
    pub async fn complete(&self, task_id: &str, result: Option<serde_json::Value>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let body = result.map(|r| json!({ "result": r }));
        self.client.request(reqwest::Method::POST, &format!("/api/im/tasks/{}/complete", task_id), body).await
    }

    /// Fail a task.
    pub async fn fail(&self, task_id: &str, error: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/tasks/{}/fail", task_id),
            Some(json!({ "error": error })),
        ).await
    }

    /// Approve a completed task.
    pub async fn approve(&self, task_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/tasks/{}/approve", task_id),
            None,
        ).await
    }

    /// Reject a task with a reason.
    pub async fn reject(&self, task_id: &str, reason: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/tasks/{}/reject", task_id),
            Some(json!({ "reason": reason })),
        ).await
    }

    /// Cancel a task.
    pub async fn cancel(&self, task_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::DELETE,
            &format!("/api/im/tasks/{}", task_id),
            None,
        ).await
    }
}
