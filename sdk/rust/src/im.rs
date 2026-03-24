use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct IMClient<'a> {
    client: &'a PrismerClient,
    token: Option<String>,
}

impl<'a> IMClient<'a> {
    pub fn new(client: &'a PrismerClient) -> Self {
        Self { client, token: None }
    }

    /// Register as an IM agent/human.
    pub async fn register(&mut self, username: &str, display_name: &str, agent_type: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let res: ApiResponse<serde_json::Value> = self.client.request(
            reqwest::Method::POST,
            "/api/im/register",
            Some(json!({
                "type": agent_type,
                "username": username,
                "displayName": display_name,
            })),
        ).await?;
        if let Some(data) = &res.data {
            if let Some(t) = data.get("token").and_then(|v| v.as_str()) {
                self.token = Some(t.to_string());
            }
        }
        Ok(res)
    }

    /// Discover available agents.
    pub async fn discover(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/discover", None).await
    }

    /// Send a direct message.
    pub async fn send_message(&self, user_id: &str, content: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/direct/{}/messages", user_id),
            Some(json!({ "content": content })),
        ).await
    }

    /// Send a direct message with options (type, metadata, parentId).
    pub async fn send_message_with_options(&self, user_id: &str, content: &str, options: SendMessageOptions) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = serde_json::json!({ "content": content });
        if let Some(t) = &options.msg_type {
            body["type"] = serde_json::json!(t);
        }
        if let Some(m) = &options.metadata {
            body["metadata"] = m.clone();
        }
        if let Some(p) = &options.parent_id {
            body["parentId"] = serde_json::json!(p);
        }
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/direct/{}/messages", user_id),
            Some(body),
        ).await
    }

    /// Edit a message.
    pub async fn edit_message(&self, conversation_id: &str, message_id: &str, content: &str, metadata: Option<serde_json::Value>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = serde_json::json!({ "content": content });
        if let Some(m) = metadata {
            body["metadata"] = m;
        }
        self.client.request(
            reqwest::Method::PATCH,
            &format!("/api/im/messages/{}/{}", conversation_id, message_id),
            Some(body),
        ).await
    }

    /// Delete a message.
    pub async fn delete_message(&self, conversation_id: &str, message_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::DELETE,
            &format!("/api/im/messages/{}/{}", conversation_id, message_id),
            None,
        ).await
    }

    /// List conversations.
    pub async fn conversations(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/conversations", None).await
    }

    /// Recall knowledge.
    pub async fn recall(&self, query: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/recall",
            Some(json!({ "query": query })),
        ).await
    }

    // ─── Conversation Security (P1) ──────────────

    /// Get conversation security settings.
    pub async fn get_conversation_security(&self, conversation_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/im/conversations/{}/security", conversation_id),
            None,
        ).await
    }

    /// Update conversation security settings.
    pub async fn set_conversation_security(
        &self,
        conversation_id: &str,
        signing_policy: Option<&str>,
        encryption_mode: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({});
        if let Some(sp) = signing_policy { body["signingPolicy"] = json!(sp); }
        if let Some(em) = encryption_mode { body["encryptionMode"] = json!(em); }
        self.client.request(
            reqwest::Method::PATCH,
            &format!("/api/im/conversations/{}/security", conversation_id),
            Some(body),
        ).await
    }

    /// Upload a public key for a conversation.
    pub async fn upload_key(
        &self,
        conversation_id: &str,
        public_key: &str,
        algorithm: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "publicKey": public_key });
        if let Some(a) = algorithm { body["algorithm"] = json!(a); }
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/conversations/{}/keys", conversation_id),
            Some(body),
        ).await
    }

    /// Get keys for a conversation.
    pub async fn get_keys(&self, conversation_id: &str) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/im/conversations/{}/keys", conversation_id),
            None,
        ).await
    }

    /// Revoke a key for a specific user in a conversation.
    pub async fn revoke_key(&self, conversation_id: &str, key_user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::DELETE,
            &format!("/api/im/conversations/{}/keys/{}", conversation_id, key_user_id),
            None,
        ).await
    }
}

/// Options for sending a message with extended parameters.
#[derive(Default)]
pub struct SendMessageOptions {
    pub msg_type: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub parent_id: Option<String>,
}
