use crate::{PrismerClient, types::*};
use serde_json::json;

pub struct IdentityClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> IdentityClient<'a> {
    /// Get the server's Ed25519 public key.
    pub async fn get_server_key(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/keys/server", None).await
    }

    /// Register a public key for identity.
    pub async fn register_key(&self, public_key: &str, derivation_mode: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "publicKey": public_key });
        if let Some(dm) = derivation_mode { body["derivationMode"] = json!(dm); }
        self.client.request(reqwest::Method::POST, "/api/im/keys/register", Some(body)).await
    }

    /// Get a user's public key.
    pub async fn get_key(&self, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/keys/{}", user_id), None).await
    }

    /// Revoke own key.
    pub async fn revoke_key(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::POST, "/api/im/keys/revoke", None).await
    }

    /// Get key audit log for a user.
    pub async fn get_audit_log(&self, user_id: &str) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/keys/audit/{}", user_id), None).await
    }

    /// Verify audit log hash chain integrity.
    pub async fn verify_audit_log(&self, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/keys/audit/{}/verify", user_id), None).await
    }
}
