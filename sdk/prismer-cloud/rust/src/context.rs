use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct ContextClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> ContextClient<'a> {
    /// Load context from URL, batch URLs, or search query.
    pub async fn load(&self, input: &str) -> Result<ApiResponse<ContextLoadResult>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/context/load",
            Some(json!({ "input": input })),
        ).await
    }

    /// Save content to context cache.
    pub async fn save(&self, content: &str, url: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(u) = url {
            body["url"] = json!(u);
        }
        self.client.request(reqwest::Method::POST, "/api/context/save", Some(body)).await
    }
}
