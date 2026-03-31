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

use reqwest::Client as HttpClient;

/// Main Prismer SDK client.
pub struct PrismerClient {
    http: HttpClient,
    api_key: String,
    base_url: String,
}

impl PrismerClient {
    /// Create a new client with API key and optional base URL override.
    pub fn new(api_key: &str, base_url: Option<&str>) -> Self {
        Self {
            http: HttpClient::new(),
            api_key: api_key.to_string(),
            base_url: base_url.unwrap_or("https://prismer.cloud").to_string(),
        }
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

    /// Internal: make authenticated request.
    pub(crate) async fn request<T: serde::de::DeserializeOwned>(
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
