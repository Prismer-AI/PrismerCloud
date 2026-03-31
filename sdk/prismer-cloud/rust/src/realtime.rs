//! Real-time clients — WebSocket (bidirectional) and SSE (server-push).

use std::sync::Arc;
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Connection state for real-time clients.
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

/// Real-time event from the server.
#[derive(Debug, Clone)]
pub struct RealtimeEvent {
    pub event_type: String,
    pub payload: serde_json::Value,
}

/// Callback type for real-time events.
pub type EventHandler = Box<dyn Fn(RealtimeEvent) + Send + Sync>;

/// WebSocket configuration.
pub struct WSConfig {
    pub base_url: String,
    pub token: String,
    pub max_reconnect_attempts: u32,
    pub reconnect_delay_ms: u64,
}

impl Default for WSConfig {
    fn default() -> Self {
        Self {
            base_url: "wss://prismer.cloud".to_string(),
            token: String::new(),
            max_reconnect_attempts: 10,
            reconnect_delay_ms: 1000,
        }
    }
}

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;

/// WebSocket real-time client with auto-reconnect.
pub struct RealtimeWSClient {
    config: WSConfig,
    state: Arc<Mutex<ConnectionState>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
    write: Arc<Mutex<Option<WsSink>>>,
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    ping_counter: Arc<Mutex<u64>>,
}

impl RealtimeWSClient {
    /// Create a new WebSocket client.
    pub fn new(config: WSConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(ConnectionState::Disconnected)),
            handlers: Arc::new(Mutex::new(Vec::new())),
            write: Arc::new(Mutex::new(None)),
            stop_tx: None,
            ping_counter: Arc::new(Mutex::new(0)),
        }
    }

    /// Get current connection state.
    pub async fn state(&self) -> ConnectionState {
        self.state.lock().await.clone()
    }

    /// Register an event handler.
    pub async fn on(&self, event_type: &str, handler: EventHandler) {
        self.handlers.lock().await.push((event_type.to_string(), handler));
    }

    /// Connect and start receiving events.
    pub async fn connect(&mut self) -> Result<(), String> {
        let url = format!("{}/ws?token={}", self.config.base_url, self.config.token);

        *self.state.lock().await = ConnectionState::Connecting;

        let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        *self.state.lock().await = ConnectionState::Connected;

        let (write, mut read) = ws_stream.split();
        *self.write.lock().await = Some(write);
        let state = self.state.clone();
        let handlers = self.handlers.clone();
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        self.stop_tx = Some(stop_tx);

        // Spawn receive loop
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = read.next() => {
                        match msg {
                            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) {
                                    let event_type = payload.get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown")
                                        .to_string();
                                    let event = RealtimeEvent {
                                        event_type: event_type.clone(),
                                        payload,
                                    };
                                    let hs = handlers.lock().await;
                                    for (t, h) in hs.iter() {
                                        if t == &event_type || t == "*" {
                                            h(event.clone());
                                        }
                                    }
                                }
                            }
                            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                                *state.lock().await = ConnectionState::Disconnected;
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ = &mut stop_rx => {
                        *state.lock().await = ConnectionState::Disconnected;
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    /// Send a raw JSON command over WebSocket.
    pub async fn send(&self, command: serde_json::Value) -> Result<(), String> {
        let mut guard = self.write.lock().await;
        let sink = guard.as_mut().ok_or("Not connected")?;
        let text = serde_json::to_string(&command).map_err(|e| e.to_string())?;
        sink.send(WsMessage::Text(text)).await.map_err(|e| format!("WS send failed: {}", e))
    }

    /// Join a conversation room.
    pub async fn join_conversation(&self, conversation_id: &str) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "conversation.join",
            "payload": { "conversationId": conversation_id }
        })).await
    }

    /// Send a message via WebSocket.
    pub async fn send_message(
        &self,
        conversation_id: &str,
        content: &str,
        msg_type: &str,
        metadata: Option<serde_json::Value>,
        parent_id: Option<&str>,
    ) -> Result<(), String> {
        let mut counter = self.ping_counter.lock().await;
        *counter += 1;
        let request_id = format!("msg-{}", *counter);
        let mut payload = serde_json::json!({
            "conversationId": conversation_id,
            "content": content,
            "type": msg_type,
        });
        if let Some(m) = metadata {
            payload["metadata"] = m;
        }
        if let Some(p) = parent_id {
            payload["parentId"] = serde_json::json!(p);
        }
        self.send(serde_json::json!({
            "type": "message.send",
            "payload": payload,
            "requestId": request_id,
        })).await
    }

    /// Start typing indicator.
    pub async fn start_typing(&self, conversation_id: &str) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "typing.start",
            "payload": { "conversationId": conversation_id }
        })).await
    }

    /// Stop typing indicator.
    pub async fn stop_typing(&self, conversation_id: &str) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "typing.stop",
            "payload": { "conversationId": conversation_id }
        })).await
    }

    /// Disconnect.
    pub async fn disconnect(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        *self.write.lock().await = None;
        *self.state.lock().await = ConnectionState::Disconnected;
    }
}

/// SSE (Server-Sent Events) client for read-only push.
pub struct RealtimeSSEClient {
    base_url: String,
    token: String,
    state: Arc<Mutex<ConnectionState>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl RealtimeSSEClient {
    /// Create a new SSE client.
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            token: token.to_string(),
            state: Arc::new(Mutex::new(ConnectionState::Disconnected)),
            handlers: Arc::new(Mutex::new(Vec::new())),
            stop_tx: None,
        }
    }

    /// Get current connection state.
    pub async fn state(&self) -> ConnectionState {
        self.state.lock().await.clone()
    }

    /// Register an event handler.
    pub async fn on(&self, event_type: &str, handler: EventHandler) {
        self.handlers.lock().await.push((event_type.to_string(), handler));
    }

    /// Connect and start receiving SSE events.
    pub async fn connect(&mut self) -> Result<(), String> {
        let url = format!("{}/api/im/sync/stream?token={}", self.base_url, self.token);
        *self.state.lock().await = ConnectionState::Connecting;

        let client = reqwest::Client::new();
        let resp = client.get(&url)
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| format!("SSE connect failed: {}", e))?;

        *self.state.lock().await = ConnectionState::Connected;

        let state = self.state.clone();
        let handlers = self.handlers.clone();
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
        self.stop_tx = Some(stop_tx);

        let mut stream = resp.bytes_stream();

        tokio::spawn(async move {
            let mut buffer = String::new();
            loop {
                tokio::select! {
                    chunk = stream.next() => {
                        match chunk {
                            Some(Ok(bytes)) => {
                                buffer.push_str(&String::from_utf8_lossy(&bytes));
                                // Parse SSE frames
                                while let Some(pos) = buffer.find("\n\n") {
                                    let frame = buffer[..pos].to_string();
                                    buffer = buffer[pos + 2..].to_string();

                                    let mut event_type = "message".to_string();
                                    let mut data = String::new();
                                    for line in frame.lines() {
                                        if let Some(val) = line.strip_prefix("event: ") {
                                            event_type = val.to_string();
                                        } else if let Some(val) = line.strip_prefix("data: ") {
                                            data = val.to_string();
                                        }
                                    }

                                    if !data.is_empty() {
                                        let payload = serde_json::from_str(&data)
                                            .unwrap_or(serde_json::Value::String(data));
                                        let event = RealtimeEvent {
                                            event_type: event_type.clone(),
                                            payload,
                                        };
                                        let hs = handlers.lock().await;
                                        for (t, h) in hs.iter() {
                                            if t == &event_type || t == "*" {
                                                h(event.clone());
                                            }
                                        }
                                    }
                                }
                            }
                            Some(Err(_)) | None => {
                                *state.lock().await = ConnectionState::Disconnected;
                                break;
                            }
                        }
                    }
                    _ = &mut stop_rx => {
                        *state.lock().await = ConnectionState::Disconnected;
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    /// Disconnect.
    pub async fn disconnect(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        *self.state.lock().await = ConnectionState::Disconnected;
    }
}
