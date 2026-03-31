//! Offline-first support — outbox queue, sync engine, read cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Outbox operation status.
#[derive(Debug, Clone, PartialEq)]
pub enum OpStatus {
    Pending,
    Inflight,
    Confirmed,
    Failed,
}

/// A queued outbox operation.
#[derive(Debug, Clone)]
pub struct OutboxOp {
    pub id: String,
    pub method: String,
    pub path: String,
    pub body: Option<serde_json::Value>,
    pub status: OpStatus,
    pub created_at: u64,
    pub retries: u32,
    pub max_retries: u32,
    pub idempotency_key: String,
}

/// In-memory storage for offline operations.
pub struct OfflineStorage {
    outbox: Vec<OutboxOp>,
    cursors: HashMap<String, u64>,
    message_cache: HashMap<String, Vec<serde_json::Value>>,
    conversation_cache: Vec<serde_json::Value>,
}

impl OfflineStorage {
    pub fn new() -> Self {
        Self {
            outbox: Vec::new(),
            cursors: HashMap::new(),
            message_cache: HashMap::new(),
            conversation_cache: Vec::new(),
        }
    }

    /// Enqueue a write operation. Returns the operation ID.
    pub fn enqueue(&mut self, method: &str, path: &str, body: Option<serde_json::Value>, max_retries: u32) -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let id = format!("op_{}_{:x}", now, rand::random::<u32>());
        let op = OutboxOp {
            id: id.clone(),
            method: method.to_string(),
            path: path.to_string(),
            body,
            status: OpStatus::Pending,
            created_at: now,
            retries: 0,
            max_retries,
            idempotency_key: format!("{}:{}:{}", method, path, now),
        };
        self.outbox.push(op);
        id
    }

    /// Get pending operations (up to limit).
    pub fn dequeue_ready(&mut self, limit: usize) -> Vec<&mut OutboxOp> {
        self.outbox.iter_mut()
            .filter(|op| op.status == OpStatus::Pending)
            .take(limit)
            .collect()
    }

    /// Mark an operation as confirmed.
    pub fn ack(&mut self, op_id: &str) {
        if let Some(op) = self.outbox.iter_mut().find(|op| op.id == op_id) {
            op.status = OpStatus::Confirmed;
        }
        self.outbox.retain(|op| op.status != OpStatus::Confirmed);
    }

    /// Mark an operation as failed (with retry logic).
    pub fn nack(&mut self, op_id: &str, _error: &str) {
        if let Some(op) = self.outbox.iter_mut().find(|op| op.id == op_id) {
            op.retries += 1;
            if op.retries >= op.max_retries {
                op.status = OpStatus::Failed;
            } else {
                op.status = OpStatus::Pending;
            }
        }
        self.outbox.retain(|op| op.status != OpStatus::Failed);
    }

    /// Get count of pending operations.
    pub fn pending_count(&self) -> usize {
        self.outbox.iter().filter(|op| op.status == OpStatus::Pending).count()
    }

    /// Get sync cursor value.
    pub fn get_cursor(&self, key: &str) -> u64 {
        self.cursors.get(key).copied().unwrap_or(0)
    }

    /// Set sync cursor value.
    pub fn set_cursor(&mut self, key: &str, value: u64) {
        self.cursors.insert(key.to_string(), value);
    }

    /// Cache messages for a conversation.
    pub fn cache_messages(&mut self, conversation_id: &str, messages: Vec<serde_json::Value>) {
        self.message_cache.insert(conversation_id.to_string(), messages);
    }

    /// Get cached messages.
    pub fn get_cached_messages(&self, conversation_id: &str) -> Option<&Vec<serde_json::Value>> {
        self.message_cache.get(conversation_id)
    }

    /// Cache conversations.
    pub fn cache_conversations(&mut self, conversations: Vec<serde_json::Value>) {
        self.conversation_cache = conversations;
    }

    /// Get cached conversations.
    pub fn get_cached_conversations(&self) -> &Vec<serde_json::Value> {
        &self.conversation_cache
    }

    /// Apply a sync event from the server (message.new, message.edit, message.delete).
    pub fn apply_sync_event(&mut self, event_type: &str, data: &serde_json::Value, conversation_id: Option<&str>) {
        match event_type {
            "message.new" => {
                if let Some(conv_id) = conversation_id.or_else(|| data.get("conversationId").and_then(|v| v.as_str())) {
                    let messages = self.message_cache.entry(conv_id.to_string()).or_default();
                    messages.push(data.clone());
                }
            }
            "message.edit" => {
                if let Some(msg_id) = data.get("id").and_then(|v| v.as_str()) {
                    for messages in self.message_cache.values_mut() {
                        for msg in messages.iter_mut() {
                            if msg.get("id").and_then(|v| v.as_str()) == Some(msg_id) {
                                if let Some(content) = data.get("content") {
                                    msg["content"] = content.clone();
                                }
                                if let Some(metadata) = data.get("metadata") {
                                    msg["metadata"] = metadata.clone();
                                }
                                if let Some(at) = data.get("at").or_else(|| data.get("editedAt")) {
                                    msg["updatedAt"] = at.clone();
                                }
                                return;
                            }
                        }
                    }
                }
            }
            "message.delete" => {
                if let Some(msg_id) = data.get("id").and_then(|v| v.as_str()) {
                    for messages in self.message_cache.values_mut() {
                        messages.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(msg_id));
                    }
                }
            }
            _ => {}
        }
    }

    /// Clear all caches.
    pub fn clear(&mut self) {
        self.outbox.clear();
        self.cursors.clear();
        self.message_cache.clear();
        self.conversation_cache.clear();
    }
}

impl Default for OfflineStorage {
    fn default() -> Self {
        Self::new()
    }
}

/// Thread-safe offline manager wrapping OfflineStorage.
pub struct OfflineManager {
    storage: Arc<Mutex<OfflineStorage>>,
}

impl OfflineManager {
    pub fn new() -> Self {
        Self {
            storage: Arc::new(Mutex::new(OfflineStorage::new())),
        }
    }

    pub fn with_storage(storage: OfflineStorage) -> Self {
        Self {
            storage: Arc::new(Mutex::new(storage)),
        }
    }

    pub fn enqueue(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> String {
        self.storage.lock().unwrap().enqueue(method, path, body, 5)
    }

    pub fn pending_count(&self) -> usize {
        self.storage.lock().unwrap().pending_count()
    }

    pub fn ack(&self, op_id: &str) {
        self.storage.lock().unwrap().ack(op_id);
    }

    pub fn nack(&self, op_id: &str, error: &str) {
        self.storage.lock().unwrap().nack(op_id, error);
    }

    pub fn get_cursor(&self, key: &str) -> u64 {
        self.storage.lock().unwrap().get_cursor(key)
    }

    pub fn set_cursor(&self, key: &str, value: u64) {
        self.storage.lock().unwrap().set_cursor(key, value);
    }

    pub fn apply_sync_event(&self, event_type: &str, data: &serde_json::Value, conversation_id: Option<&str>) {
        self.storage.lock().unwrap().apply_sync_event(event_type, data, conversation_id);
    }

    pub fn clear(&self) {
        self.storage.lock().unwrap().clear();
    }
}

impl Default for OfflineManager {
    fn default() -> Self {
        Self::new()
    }
}
