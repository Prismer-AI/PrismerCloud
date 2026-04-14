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

    /// Unified IM request wrapper (v1.8.0 S7).
    /// Auto-signs POST requests to message endpoints (path contains "/messages"),
    /// consistent with TS/Go/Python SDKs.
    async fn im_request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<ApiResponse<T>, PrismerError> {
        let body = if method == reqwest::Method::POST && path.contains("/messages") {
            if let Some(mut b) = body {
                // Only sign if not already signed
                if b.get("signature").is_none() {
                    let content = b.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let msg_type = b.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                    if let Some((content_hash, signature, sender_did, timestamp)) =
                        self.client.sign_message(content, msg_type)
                    {
                        b["secVersion"] = json!(1);
                        b["senderDid"] = json!(sender_did);
                        b["contentHash"] = json!(content_hash);
                        b["signature"] = json!(signature);
                        b["signedAt"] = json!(timestamp);
                    }
                }
                Some(b)
            } else {
                None
            }
        } else {
            body
        };
        self.client.request(method, path, body).await
    }

    /// Health check for the IM server.
    pub async fn health(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/health", None).await
    }

    /// Register as an IM agent/human.
    pub async fn register(&mut self, username: &str, display_name: &str, agent_type: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let res: ApiResponse<serde_json::Value> = self.im_request(
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
        self.im_request(reqwest::Method::GET, "/api/im/discover", None).await
    }

    /// Send a direct message (auto-signs if identity is set).
    pub async fn send_message(&self, user_id: &str, content: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/direct/{}/messages", user_id),
            Some(json!({ "content": content })),
        ).await
    }

    /// Send a direct message with options (type, metadata, parentId, quotedMessageId).
    pub async fn send_message_with_options(&self, user_id: &str, content: &str, options: SendMessageOptions) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(t) = &options.msg_type {
            body["type"] = json!(t);
        }
        if let Some(m) = &options.metadata {
            body["metadata"] = m.clone();
        }
        if let Some(p) = &options.parent_id {
            body["parentId"] = json!(p);
        }
        if let Some(q) = &options.quoted_message_id {
            body["quotedMessageId"] = json!(q);
        }
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/direct/{}/messages", user_id),
            Some(body),
        ).await
    }

    // ─── Group Messaging ──────────────

    /// Create a group chat.
    pub async fn create_group(&self, title: &str, members: &[&str], description: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "title": title, "members": members });
        if let Some(d) = description {
            body["description"] = json!(d);
        }
        self.im_request(reqwest::Method::POST, "/api/im/groups", Some(body)).await
    }

    /// List groups you belong to.
    pub async fn list_groups(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/groups", None).await
    }

    /// Get group details.
    pub async fn get_group(&self, group_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(reqwest::Method::GET, &format!("/api/im/groups/{}", group_id), None).await
    }

    /// Send a message to a group (auto-signs if identity is set).
    pub async fn send_group_message(&self, group_id: &str, content: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/groups/{}/messages", group_id),
            Some(json!({ "content": content })),
        ).await
    }

    /// Send a message to a group with options (auto-signs if identity is set).
    pub async fn send_group_message_with_options(&self, group_id: &str, content: &str, options: SendMessageOptions) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(t) = &options.msg_type {
            body["type"] = json!(t);
        }
        if let Some(m) = &options.metadata {
            body["metadata"] = m.clone();
        }
        if let Some(p) = &options.parent_id {
            body["parentId"] = json!(p);
        }
        if let Some(q) = &options.quoted_message_id {
            body["quotedMessageId"] = json!(q);
        }
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/groups/{}/messages", group_id),
            Some(body),
        ).await
    }

    /// Get group message history.
    pub async fn get_group_messages(&self, group_id: &str, limit: Option<u32>, offset: Option<u32>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut query = String::new();
        let mut sep = '?';
        if let Some(l) = limit {
            query.push_str(&format!("{}limit={}", sep, l));
            sep = '&';
        }
        if let Some(o) = offset {
            query.push_str(&format!("{}offset={}", sep, o));
        }
        self.im_request(reqwest::Method::GET, &format!("/api/im/groups/{}/messages{}", group_id, query), None).await
    }

    /// Add a member to a group (owner/admin only).
    pub async fn add_group_member(&self, group_id: &str, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/groups/{}/members", group_id),
            Some(json!({ "userId": user_id })),
        ).await
    }

    /// Remove a member from a group (owner/admin only).
    pub async fn remove_group_member(&self, group_id: &str, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::DELETE,
            &format!("/api/im/groups/{}/members/{}", group_id, user_id),
            None,
        ).await
    }

    // ─── Conversation-level Messaging ──────────────

    /// Send a message to a conversation by ID (auto-signs if identity is set).
    pub async fn send_conversation_message(&self, conversation_id: &str, content: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/messages/{}", conversation_id),
            Some(json!({ "content": content })),
        ).await
    }

    /// Send a message to a conversation with options (auto-signs if identity is set).
    pub async fn send_conversation_message_with_options(&self, conversation_id: &str, content: &str, options: SendMessageOptions) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(t) = &options.msg_type {
            body["type"] = json!(t);
        }
        if let Some(m) = &options.metadata {
            body["metadata"] = m.clone();
        }
        if let Some(p) = &options.parent_id {
            body["parentId"] = json!(p);
        }
        if let Some(q) = &options.quoted_message_id {
            body["quotedMessageId"] = json!(q);
        }
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/messages/{}", conversation_id),
            Some(body),
        ).await
    }

    /// Get message history for a conversation.
    pub async fn get_conversation_messages(&self, conversation_id: &str, limit: Option<u32>, offset: Option<u32>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut query = String::new();
        let mut sep = '?';
        if let Some(l) = limit {
            query.push_str(&format!("{}limit={}", sep, l));
            sep = '&';
        }
        if let Some(o) = offset {
            query.push_str(&format!("{}offset={}", sep, o));
        }
        self.im_request(reqwest::Method::GET, &format!("/api/im/messages/{}{}", conversation_id, query), None).await
    }

    // ─── Message Operations ──────────────

    /// Edit a message.
    pub async fn edit_message(&self, conversation_id: &str, message_id: &str, content: &str, metadata: Option<serde_json::Value>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "content": content });
        if let Some(m) = metadata {
            body["metadata"] = m;
        }
        self.im_request(
            reqwest::Method::PATCH,
            &format!("/api/im/messages/{}/{}", conversation_id, message_id),
            Some(body),
        ).await
    }

    /// Delete a message.
    pub async fn delete_message(&self, conversation_id: &str, message_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::DELETE,
            &format!("/api/im/messages/{}/{}", conversation_id, message_id),
            None,
        ).await
    }

    /// Add or remove an emoji reaction on a message (v1.8.2).
    ///
    /// Idempotent — adding an existing reaction or removing a non-existent one is a no-op.
    /// Response `data.reactions` has shape `{ "👍": ["userId-a", ...], ... }`.
    pub async fn react_message(
        &self,
        conversation_id: &str,
        message_id: &str,
        emoji: &str,
        remove: bool,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = serde_json::json!({ "emoji": emoji });
        if remove {
            body["remove"] = serde_json::Value::Bool(true);
        }
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/messages/{}/{}/reactions", conversation_id, message_id),
            Some(body),
        ).await
    }

    /// List conversations.
    pub async fn conversations(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/conversations", None).await
    }

    /// Get own profile (identity, agent card, credits, stats).
    pub async fn me(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/me", None).await
    }

    /// List contacts.
    pub async fn contacts(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/contacts", None).await
    }

    /// Get credits balance.
    pub async fn credits(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(reqwest::Method::GET, "/api/im/credits", None).await
    }

    /// Get credit transaction history.
    pub async fn transactions(&self, limit: u32) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(reqwest::Method::GET, &format!("/api/im/credits/transactions?limit={}", limit), None).await
    }

    /// Recall knowledge.
    pub async fn recall(&self, query: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            "/api/im/recall",
            Some(json!({ "query": query })),
        ).await
    }

    // ─── Conversation Security (P1) ──────────────

    /// Get conversation security settings.
    pub async fn get_conversation_security(&self, conversation_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
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
        self.im_request(
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
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/conversations/{}/keys", conversation_id),
            Some(body),
        ).await
    }

    /// Get keys for a conversation.
    pub async fn get_keys(&self, conversation_id: &str) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(
            reqwest::Method::GET,
            &format!("/api/im/conversations/{}/keys", conversation_id),
            None,
        ).await
    }

    /// Revoke a key for a specific user in a conversation.
    pub async fn revoke_key(&self, conversation_id: &str, key_user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::DELETE,
            &format!("/api/im/conversations/{}/keys/{}", conversation_id, key_user_id),
            None,
        ).await
    }

    // ─── Friend / Contact Management (P9) ──────────────

    /// Send a friend request to another user.
    pub async fn send_friend_request(&self, user_id: &str, reason: Option<&str>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({ "userId": user_id });
        if let Some(r) = reason {
            body["reason"] = json!(r);
        }
        self.im_request(
            reqwest::Method::POST,
            "/api/im/contacts/request",
            Some(body),
        ).await
    }

    /// List pending friend requests received by the current user.
    pub async fn pending_requests_received(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(
            reqwest::Method::GET,
            "/api/im/contacts/requests/received",
            None,
        ).await
    }

    /// List pending friend requests sent by the current user.
    pub async fn pending_requests_sent(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(
            reqwest::Method::GET,
            "/api/im/contacts/requests/sent",
            None,
        ).await
    }

    /// Accept a pending friend request.
    pub async fn accept_friend_request(&self, request_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/contacts/requests/{}/accept", request_id),
            Some(json!({})),
        ).await
    }

    /// Reject a pending friend request.
    pub async fn reject_friend_request(&self, request_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/contacts/requests/{}/reject", request_id),
            Some(json!({})),
        ).await
    }

    /// List the current user's friends.
    pub async fn friends(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(
            reqwest::Method::GET,
            "/api/im/contacts/friends",
            None,
        ).await
    }

    /// Remove a friend by user ID.
    pub async fn remove_friend(&self, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::DELETE,
            &format!("/api/im/contacts/{}/remove", user_id),
            None,
        ).await
    }

    /// Set a remark/alias for a friend.
    pub async fn set_friend_remark(&self, user_id: &str, remark: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::PATCH,
            &format!("/api/im/contacts/{}/remark", user_id),
            Some(json!({ "remark": remark })),
        ).await
    }

    /// Block a user.
    pub async fn block_user(&self, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::POST,
            &format!("/api/im/contacts/{}/block", user_id),
            Some(json!({})),
        ).await
    }

    /// Unblock a user.
    pub async fn unblock_user(&self, user_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.im_request(
            reqwest::Method::DELETE,
            &format!("/api/im/contacts/{}/block", user_id),
            None,
        ).await
    }

    /// List blocked users.
    pub async fn blocked_list(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.im_request(
            reqwest::Method::GET,
            "/api/im/contacts/blocked",
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
    pub quoted_message_id: Option<String>,
}
