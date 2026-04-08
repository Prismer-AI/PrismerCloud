//! Prismer Cloud SDK for Rust
//!
//! # Quick Start
//! ```no_run
//! use prismer_sdk::PrismerClient;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = PrismerClient::new("sk-prismer-live-...", None);
//!     let result = client.context().load("https://example.com").await?;
//!     println!("{:?}", result);
//!     Ok(())
//! }
//! ```

pub mod types;
pub mod context;
pub mod parse;
pub mod im;
pub mod evolution;
pub mod evolution_cache;
pub mod evolution_runtime;
pub mod signal_rules;
pub mod webhook;
pub mod memory;
pub mod knowledge;
pub mod community;
pub mod tasks;
pub mod identity;
pub mod files;
pub mod daemon;

use reqwest::Client as HttpClient;
use ed25519_dalek::{SigningKey, Signer};
use sha2::{Sha256, Digest};

/// Resolve API key with priority chain:
///   1. Explicit value passed (non-empty string)
///   2. `PRISMER_API_KEY` environment variable
///   3. `~/.prismer/config.toml` api_key field
///   4. Empty string
fn resolve_api_key(explicit: &str) -> String {
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    if let Ok(env_key) = std::env::var("PRISMER_API_KEY") {
        if !env_key.is_empty() {
            return env_key;
        }
    }
    if let Some(home) = dirs::home_dir() {
        let config_path = home.join(".prismer").join("config.toml");
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Some(key) = toml_find(&raw, "api_key") {
                return key;
            }
        }
    }
    String::new()
}

/// Resolve base URL with priority chain:
///   1. Explicit value passed (Some with non-empty string)
///   2. `PRISMER_BASE_URL` environment variable
///   3. `~/.prismer/config.toml` base_url field
///   4. Default `https://prismer.cloud`
fn resolve_base_url(explicit: Option<&str>) -> String {
    if let Some(url) = explicit {
        if !url.is_empty() {
            return url.to_string();
        }
    }
    if let Ok(env_url) = std::env::var("PRISMER_BASE_URL") {
        if !env_url.is_empty() {
            return env_url;
        }
    }
    if let Some(home) = dirs::home_dir() {
        let config_path = home.join(".prismer").join("config.toml");
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Some(url) = toml_find(&raw, "base_url") {
                return url;
            }
        }
    }
    "https://prismer.cloud".to_string()
}

/// Parse a TOML-like config field from raw text.
/// Looks for lines matching: `key = 'value'` or `key = "value"` (whitespace tolerant).
fn toml_find(haystack: &str, key: &str) -> Option<String> {
    for line in haystack.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with(key) {
            let rest = &trimmed[key.len()..];
            let rest = rest.trim_start_matches(|c: char| c.is_whitespace());
            if let Some(rest) = rest.strip_prefix('=') {
                let rest = rest.trim_start();
                for quote in ['"', '\''] {
                    if rest.starts_with(quote) {
                        let inner = &rest[1..];
                        if let Some(end) = inner.find(quote) {
                            return Some(inner[..end].to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Main Prismer SDK client.
pub struct PrismerClient {
    http: HttpClient,
    api_key: String,
    base_url: String,
    /// v1.8.0 S7: Optional Ed25519 signing key for auto-signing IM messages.
    signing_key: Option<SigningKey>,
    /// DID:key identifier derived from signing key.
    pub identity_did: Option<String>,
}

impl PrismerClient {
    /// Create a new client with API key and optional base URL override.
    /// Fallback chain: explicit → PRISMER_API_KEY env → ~/.prismer/config.toml → ''
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        let resolved_key = resolve_api_key(api_key);
        let resolved_url = resolve_base_url(base_url);
        Self {
            http: HttpClient::new(),
            api_key: resolved_key,
            base_url: resolved_url,
            signing_key: None,
            identity_did: None,
        }
    }

    /// Create a client with auto-signing from API key (v1.8.0 S7).
    /// Derives Ed25519 key via SHA-256(api_key).
    /// Fallback chain: explicit → PRISMER_API_KEY env → ~/.prismer/config.toml → ''
    pub fn new_with_identity(api_key: &str, base_url: Option<&str>) -> Self {
        let resolved_key = resolve_api_key(api_key);
        let resolved_url = resolve_base_url(base_url);
        let seed: [u8; 32] = Sha256::digest(resolved_key.as_bytes()).into();
        let signing_key = SigningKey::from_bytes(&seed);
        let pub_key = signing_key.verifying_key();
        let did = public_key_to_did_key(&pub_key.to_bytes());
        Self {
            http: HttpClient::new(),
            api_key: resolved_key,
            base_url: resolved_url,
            signing_key: Some(signing_key),
            identity_did: Some(did),
        }
    }

    /// Sign a message payload and return (content_hash, signature, sender_did).
    /// Sign a message payload (lite format: secVersion|senderDid|type|timestamp|contentHash).
    /// Returns (content_hash, signature_b64, sender_did, timestamp_ms).
    pub(crate) fn sign_message(&self, content: &str, msg_type: &str) -> Option<(String, String, String, u64)> {
        let key = self.signing_key.as_ref()?;
        let did = self.identity_did.as_ref()?;
        let content_hash = hex::encode(Sha256::digest(content.as_bytes()));
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
        let payload = format!("1|{}|{}|{}|{}", did, msg_type, timestamp, content_hash);
        let sig = key.sign(payload.as_bytes());
        Some((content_hash, base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig.to_bytes()), did.clone(), timestamp))
    }

    /// Get Context API client.
    pub fn context(&self) -> context::ContextClient<'_> {
        context::ContextClient { client: self }
    }

    /// Get Parse API client.
    pub fn parse(&self) -> parse::ParseClient<'_> {
        parse::ParseClient { client: self }
    }

    /// Get IM API client.
    pub fn im(&self) -> im::IMClient<'_> {
        im::IMClient::new(self)
    }

    /// Get Evolution API client.
    pub fn evolution(&self) -> evolution::EvolutionClient<'_> {
        evolution::EvolutionClient { client: self }
    }

    /// Get Memory API client.
    pub fn memory(&self) -> memory::MemoryClient<'_> {
        memory::MemoryClient { client: self }
    }

    /// Get Knowledge Links API client (v1.8.0).
    pub fn knowledge(&self) -> knowledge::KnowledgeLinkClient<'_> {
        knowledge::KnowledgeLinkClient { client: self }
    }

    /// Get Community API client.
    pub fn community(&self) -> community::CommunityClient<'_> {
        community::CommunityClient { client: self }
    }

    /// Get Tasks API client.
    pub fn tasks(&self) -> tasks::TasksClient<'_> {
        tasks::TasksClient { client: self }
    }

    /// Get Identity API client.
    pub fn identity(&self) -> identity::IdentityClient<'_> {
        identity::IdentityClient { client: self }
    }

    /// Get Files API client.
    pub fn files(&self) -> files::FilesClient<'_> {
        files::FilesClient { client: self }
    }

    /// Make an authenticated request. Exposed for CLI and advanced usage.
    pub async fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<types::ApiResponse<T>, types::PrismerError> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.request(method, &url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json");

        if let Some(b) = body {
            req = req.json(&b);
        }

        let resp = req.send().await.map_err(|e| types::PrismerError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| types::PrismerError::Network(e.to_string()))?;

        if !status.is_success() {
            return Err(types::PrismerError::Api {
                status: status.as_u16(),
                message: text,
            });
        }

        serde_json::from_str(&text).map_err(|e| types::PrismerError::Parse(e.to_string()))
    }
}

/// Convert Ed25519 public key bytes to did:key format.
fn public_key_to_did_key(pub_key: &[u8; 32]) -> String {
    // Multicodec ed25519-pub = 0xed, varint = [0xed, 0x01]
    let mut multicodec = vec![0xed, 0x01];
    multicodec.extend_from_slice(pub_key);
    format!("did:key:z{}", bs58::encode(&multicodec).into_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_default_base_url() {
        let client = PrismerClient::new("sk-prismer-live-abc123", None);
        assert_eq!(client.base_url, "https://prismer.cloud");
        assert_eq!(client.api_key, "sk-prismer-live-abc123");
    }

    #[test]
    fn client_custom_base_url() {
        let client = PrismerClient::new("sk-test", Some("https://cloud.prismer.dev"));
        assert_eq!(client.base_url, "https://cloud.prismer.dev");
    }

    #[test]
    fn client_empty_api_key() {
        let client = PrismerClient::new("", None);
        assert_eq!(client.api_key, "");
    }

    #[test]
    fn client_context_returns_context_client() {
        let client = PrismerClient::new("sk-test", None);
        let _ctx = client.context();
    }

    #[test]
    fn client_parse_returns_parse_client() {
        let client = PrismerClient::new("sk-test", None);
        let _p = client.parse();
    }

    #[test]
    fn client_im_returns_im_client() {
        let client = PrismerClient::new("sk-test", None);
        let _im = client.im();
    }

    #[test]
    fn client_evolution_returns_evolution_client() {
        let client = PrismerClient::new("sk-test", None);
        let _ev = client.evolution();
    }

    #[test]
    fn client_memory_returns_memory_client() {
        let client = PrismerClient::new("sk-test", None);
        let _m = client.memory();
    }

    #[test]
    fn client_tasks_returns_tasks_client() {
        let client = PrismerClient::new("sk-test", None);
        let _t = client.tasks();
    }

    #[test]
    fn client_identity_returns_identity_client() {
        let client = PrismerClient::new("sk-test", None);
        let _id = client.identity();
    }

    #[test]
    fn client_files_returns_files_client() {
        let client = PrismerClient::new("sk-test", None);
        let _f = client.files();
    }

    #[test]
    fn client_community_returns_community_client() {
        let client = PrismerClient::new("sk-test", None);
        let _c = client.community();
    }

    #[test]
    fn client_knowledge_returns_knowledge_client() {
        let client = PrismerClient::new("sk-test", None);
        let _k = client.knowledge();
    }
}
