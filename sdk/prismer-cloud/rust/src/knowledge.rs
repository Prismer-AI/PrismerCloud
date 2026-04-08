use crate::{PrismerClient, types::*};

/// Knowledge Links: bidirectional associations between Memory, Gene, Capsule, Signal entities (v1.8.0).
pub struct KnowledgeLinkClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> KnowledgeLinkClient<'a> {
    /// Get all knowledge links for a given entity.
    ///
    /// `entity_type` must be one of: `"memory"`, `"gene"`, `"capsule"`, `"signal"`.
    pub async fn get_links(&self, entity_type: &str, entity_id: &str) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/im/knowledge/links?entityType={}&entityId={}", entity_type, entity_id),
            None,
        ).await
    }
}
