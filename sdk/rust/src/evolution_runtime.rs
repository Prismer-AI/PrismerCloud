//! EvolutionRuntime — High-level evolution API for Rust agents.
//!
//! Composes EvolutionCache + SignalEnrichment + outbox into two methods:
//!   - `suggest(error)` → strategy recommendation (<1ms local, fallback to server)
//!   - `learned(error, outcome, summary, gene_id)` → fire-and-forget outbox
//!
//! Port of sdk/typescript/src/evolution-runtime.ts and sdk/python/prismer/evolution_runtime.py.
//!
//! # Example
//! ```no_run
//! use prismer_sdk::PrismerClient;
//! use prismer_sdk::evolution_runtime::{EvolutionRuntime, EvolutionRuntimeConfig};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let client = PrismerClient::new("sk-prismer-...", None);
//!     let mut rt = EvolutionRuntime::new(&client, None);
//!     rt.start().await?;
//!
//!     let fix = rt.suggest("ETIMEDOUT: connection timed out").await?;
//!     // ... agent applies fix.strategy ...
//!     rt.learned("ETIMEDOUT", "success", "Fixed by increasing timeout", None);
//!
//!     rt.flush().await;
//!     Ok(())
//! }
//! ```

use std::time::{SystemTime, UNIX_EPOCH};

use crate::evolution::EvolutionClient;
use crate::evolution_cache::EvolutionCache;
use crate::signal_rules::{SignalExtractionContext, extract_signals};
use crate::types::{PrismerError, SignalTag};
use crate::PrismerClient;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Configuration for the evolution runtime.
pub struct EvolutionRuntimeConfig {
    /// Sync interval in milliseconds (default: 60000)
    pub sync_interval_ms: u64,
    /// Scope for evolution queries (default: "global")
    pub scope: String,
    /// Maximum outbox size before auto-flush (default: 50)
    pub outbox_max_size: usize,
    /// Outbox flush interval in milliseconds (default: 5000)
    pub outbox_flush_ms: u64,
}

impl Default for EvolutionRuntimeConfig {
    fn default() -> Self {
        Self {
            sync_interval_ms: 60_000,
            scope: "global".to_string(),
            outbox_max_size: 50,
            outbox_flush_ms: 5000,
        }
    }
}

/// A strategy suggestion returned by the runtime.
#[derive(Debug)]
pub struct Suggestion {
    /// "apply_gene", "create_suggested", or "none"
    pub action: String,
    pub gene_id: Option<String>,
    pub gene: Option<serde_json::Value>,
    pub strategy: Option<Vec<String>>,
    pub confidence: f64,
    pub signals: Vec<SignalTag>,
    pub from_cache: bool,
    pub reason: Option<String>,
    pub alternatives: Option<Vec<serde_json::Value>>,
}

/// Options for the suggest method.
pub struct SuggestOptions {
    pub provider: Option<String>,
    pub stage: Option<String>,
    pub severity: Option<String>,
    pub tags: Vec<String>,
}

impl Default for SuggestOptions {
    fn default() -> Self {
        Self {
            provider: None,
            stage: None,
            severity: None,
            tags: Vec::new(),
        }
    }
}

struct OutboxEntry {
    gene_id: String,
    signals: Vec<SignalTag>,
    outcome: String,
    summary: String,
    session_id: Option<String>,
}

/// Tracks a single suggest→learned cycle.
#[derive(Debug, Clone)]
pub struct EvolutionSession {
    pub id: String,
    pub suggested_at_ms: u64,
    pub suggested_gene_id: Option<String>,
    pub used_gene_id: Option<String>,
    pub adopted: bool,
    pub completed_at_ms: Option<u64>,
    pub outcome: Option<String>,
    pub duration_ms: Option<u64>,
    pub confidence: f64,
    pub from_cache: bool,
}

/// Aggregate session metrics for benchmarking.
#[derive(Debug, Default)]
pub struct SessionMetrics {
    pub total_suggestions: usize,
    pub suggestions_with_gene: usize,
    pub total_learned: usize,
    pub adopted_count: usize,
    pub gene_utilization_rate: f64,
    pub avg_duration_ms: f64,
    pub adopted_success_rate: f64,
    pub non_adopted_success_rate: f64,
    pub cache_hit_rate: f64,
}

/// High-level, cache-first evolution runtime for Rust agents.
///
/// The runtime is manually driven: call `flush()` periodically or before shutdown
/// to send queued outcomes to the server. For automatic background flushing,
/// use `tokio::spawn` with a timer calling `flush()`.
pub struct EvolutionRuntime<'a> {
    cache: EvolutionCache,
    client: EvolutionClient<'a>,
    config: EvolutionRuntimeConfig,
    outbox: Vec<OutboxEntry>,
    last_suggested_gene_id: Option<String>,
    started: bool,
    sessions: Vec<EvolutionSession>,
    active_session: Option<EvolutionSession>,
    session_counter: u64,
}

impl<'a> EvolutionRuntime<'a> {
    /// Create a new evolution runtime.
    pub fn new(client: &'a PrismerClient, config: Option<EvolutionRuntimeConfig>) -> Self {
        Self {
            cache: EvolutionCache::new(),
            client: client.evolution(),
            config: config.unwrap_or_default(),
            outbox: Vec::new(),
            last_suggested_gene_id: None,
            started: false,
            sessions: Vec::new(),
            active_session: None,
            session_counter: 0,
        }
    }

    /// Bootstrap: load snapshot from server.
    pub async fn start(&mut self) -> Result<(), PrismerError> {
        if self.started {
            return Ok(());
        }
        self.started = true;

        // Load initial snapshot
        match self.client.get_sync_snapshot(Some(0)).await {
            Ok(resp) => {
                if let Some(data) = resp.data {
                    // Unwrap nested "data" if present
                    let snapshot = if let Some(inner) = data.get("data") {
                        inner
                    } else {
                        &data
                    };
                    self.cache.load_snapshot(snapshot);
                }
            }
            Err(_) => {} // Silently ignore — cache stays empty
        }

        Ok(())
    }

    /// Get a strategy recommendation. Cache first (<1ms), server fallback.
    pub async fn suggest(&mut self, error: &str) -> Result<Suggestion, PrismerError> {
        self.suggest_with_opts(error, SuggestOptions::default()).await
    }

    /// Get a strategy recommendation with additional context options.
    pub async fn suggest_with_opts(&mut self, error: &str, opts: SuggestOptions) -> Result<Suggestion, PrismerError> {
        let ctx = SignalExtractionContext {
            error: Some(error.to_string()),
            provider: opts.provider,
            stage: opts.stage,
            severity: opts.severity,
            tags: opts.tags,
            ..Default::default()
        };
        let signals = extract_signals(&ctx);

        if signals.is_empty() {
            return Ok(Suggestion {
                action: "none".to_string(),
                gene_id: None,
                gene: None,
                strategy: None,
                confidence: 0.0,
                signals: vec![],
                from_cache: false,
                reason: Some("no signals extracted from error".to_string()),
                alternatives: None,
            });
        }

        // Try local cache first
        if self.cache.gene_count() > 0 {
            let local = self.cache.select_gene(&signals);
            if local.action == "apply_gene" && local.confidence > 0.3 {
                self.last_suggested_gene_id = local.gene_id.clone();
                self.start_session(local.gene_id.clone(), local.confidence, true);
                return Ok(Suggestion {
                    action: local.action,
                    gene_id: local.gene_id,
                    gene: local.gene,
                    strategy: local.strategy,
                    confidence: local.confidence,
                    signals,
                    from_cache: true,
                    reason: Some(local.reason),
                    alternatives: Some(local.alternatives.iter().map(|a| {
                        serde_json::json!({
                            "gene_id": a.gene_id,
                            "confidence": a.confidence,
                            "title": a.title,
                        })
                    }).collect()),
                });
            }
        }

        // Fallback to server — use raw JSON to avoid Serialize bounds on Gene
        let signal_values: Vec<serde_json::Value> = signals.iter().map(|s| {
            serde_json::json!({ "type": s.signal_type })
        }).collect();

        let path = match &self.config.scope as &str {
            "" | "global" => "/api/im/evolution/analyze".to_string(),
            s => format!("/api/im/evolution/analyze?scope={}", s),
        };
        let body = serde_json::json!({ "signals": signal_values });
        let result: Result<crate::types::ApiResponse<serde_json::Value>, PrismerError> =
            self.client.client.request(reqwest::Method::POST, &path, Some(body)).await;

        match result {
            Ok(resp) => {
                if let Some(data) = &resp.data {
                    let gene_id = data.get("gene_id")
                        .or_else(|| data.get("gene").and_then(|g| g.get("id")))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    self.last_suggested_gene_id = gene_id.clone();

                    let gene = data.get("gene").cloned();
                    let strategy = data.get("strategy")
                        .or_else(|| data.get("gene").and_then(|g| g.get("strategy")))
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());

                    let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("none").to_string();
                    let confidence = data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let reason = data.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string());

                    self.start_session(gene_id.clone(), confidence, false);

                    return Ok(Suggestion {
                        action,
                        gene_id,
                        gene,
                        strategy,
                        confidence,
                        signals,
                        from_cache: false,
                        reason,
                        alternatives: None,
                    });
                }

                Ok(Suggestion {
                    action: "none".to_string(),
                    gene_id: None,
                    gene: None,
                    strategy: None,
                    confidence: 0.0,
                    signals,
                    from_cache: false,
                    reason: Some("no recommendation".to_string()),
                    alternatives: None,
                })
            }
            Err(_) => {
                // Server unreachable — use cache even if low confidence
                let local = self.cache.select_gene(&signals);
                self.last_suggested_gene_id = local.gene_id.clone();
                self.start_session(local.gene_id.clone(), local.confidence, true);
                Ok(Suggestion {
                    action: local.action,
                    gene_id: local.gene_id,
                    gene: local.gene,
                    strategy: local.strategy,
                    confidence: local.confidence,
                    signals,
                    from_cache: true,
                    reason: Some("server unreachable, using cache fallback".to_string()),
                    alternatives: None,
                })
            }
        }
    }

    /// Record an outcome. Fire-and-forget — never blocks on network.
    /// Call `flush()` periodically to send queued outcomes.
    pub fn learned(&mut self, error: &str, outcome: &str, summary: &str, gene_id: Option<&str>) {
        let ctx = SignalExtractionContext {
            error: Some(error.to_string()),
            ..Default::default()
        };
        let signals = extract_signals(&ctx);

        let resolved = gene_id
            .map(|s| s.to_string())
            .or_else(|| self.last_suggested_gene_id.clone());
        let resolved = match resolved {
            Some(id) if !id.is_empty() => id,
            _ => return,
        };

        // Complete active session
        let session_id = self.complete_session(&resolved, outcome);

        self.outbox.push(OutboxEntry {
            gene_id: resolved,
            signals,
            outcome: outcome.to_string(),
            summary: summary.to_string(),
            session_id,
        });
    }

    /// Flush the outbox: send all queued outcomes to the server.
    pub async fn flush(&mut self) {
        if self.outbox.is_empty() {
            return;
        }

        let batch: Vec<OutboxEntry> = self.outbox.drain(..).collect();
        let mut failed: Vec<OutboxEntry> = Vec::new();

        for entry in batch {
            let signal_values: Vec<serde_json::Value> = entry.signals.iter().map(|s| {
                serde_json::json!(s.signal_type)
            }).collect();

            let result = self.client.record(
                &entry.gene_id,
                signal_values,
                &entry.outcome,
                &entry.summary,
                None,
                Some(&self.config.scope),
            ).await;

            if result.is_err() {
                failed.push(entry);
            }
        }

        // Re-enqueue failed entries
        if !failed.is_empty() {
            self.outbox.extend(failed);
        }
    }

    /// Perform a sync: pull remote gene updates into the cache.
    pub async fn sync(&mut self) -> Result<(), PrismerError> {
        let since = self.cache.cursor();
        let resp = self.client.sync(None, Some(since)).await?;
        if let Some(data) = resp.data {
            if data.get("pulled").is_some() {
                self.cache.apply_delta(&data);
            }
        }
        Ok(())
    }

    /// Number of pending outbox entries.
    pub fn outbox_len(&self) -> usize {
        self.outbox.len()
    }

    /// Number of genes in the local cache.
    pub fn gene_count(&self) -> usize {
        self.cache.gene_count()
    }

    /// Completed sessions.
    pub fn sessions(&self) -> &[EvolutionSession] {
        &self.sessions
    }

    /// Compute aggregate metrics from all completed sessions.
    pub fn get_metrics(&self) -> SessionMetrics {
        let total = self.sessions.len();
        if total == 0 {
            return SessionMetrics::default();
        }

        let with_gene = self.sessions.iter().filter(|s| s.suggested_gene_id.is_some()).count();
        let completed: Vec<&EvolutionSession> = self.sessions.iter().filter(|s| s.outcome.is_some()).collect();
        let total_learned = completed.len();
        let adopted_count = completed.iter().filter(|s| s.adopted).count();
        let cache_hits = self.sessions.iter().filter(|s| s.from_cache).count();

        let gene_utilization_rate = if with_gene > 0 {
            adopted_count as f64 / with_gene as f64
        } else {
            0.0
        };

        let durations: Vec<f64> = completed.iter()
            .filter_map(|s| s.duration_ms.map(|d| d as f64))
            .collect();
        let avg_duration_ms = if durations.is_empty() {
            0.0
        } else {
            durations.iter().sum::<f64>() / durations.len() as f64
        };

        let adopted_sessions: Vec<&&EvolutionSession> = completed.iter().filter(|s| s.adopted).collect();
        let adopted_success_rate = if adopted_sessions.is_empty() {
            0.0
        } else {
            adopted_sessions.iter().filter(|s| s.outcome.as_deref() == Some("success")).count() as f64
                / adopted_sessions.len() as f64
        };

        let non_adopted: Vec<&&EvolutionSession> = completed.iter().filter(|s| !s.adopted).collect();
        let non_adopted_success_rate = if non_adopted.is_empty() {
            0.0
        } else {
            non_adopted.iter().filter(|s| s.outcome.as_deref() == Some("success")).count() as f64
                / non_adopted.len() as f64
        };

        let cache_hit_rate = cache_hits as f64 / total as f64;

        SessionMetrics {
            total_suggestions: total,
            suggestions_with_gene: with_gene,
            total_learned,
            adopted_count,
            gene_utilization_rate,
            avg_duration_ms,
            adopted_success_rate,
            non_adopted_success_rate,
            cache_hit_rate,
        }
    }

    /// Reset all sessions and metrics.
    pub fn reset_metrics(&mut self) {
        self.sessions.clear();
        self.active_session = None;
        self.session_counter = 0;
    }

    // ── private helpers ──

    fn start_session(&mut self, gene_id: Option<String>, confidence: f64, from_cache: bool) {
        // Archive previous active session if any
        if let Some(prev) = self.active_session.take() {
            self.sessions.push(prev);
        }

        self.session_counter += 1;
        self.active_session = Some(EvolutionSession {
            id: format!("rs-{}", self.session_counter),
            suggested_at_ms: now_ms(),
            suggested_gene_id: gene_id,
            used_gene_id: None,
            adopted: false,
            completed_at_ms: None,
            outcome: None,
            duration_ms: None,
            confidence,
            from_cache,
        });
    }

    fn complete_session(&mut self, gene_id: &str, outcome: &str) -> Option<String> {
        let now = now_ms();
        if let Some(ref mut session) = self.active_session {
            session.used_gene_id = Some(gene_id.to_string());
            session.adopted = session.suggested_gene_id.as_deref() == Some(gene_id);
            session.outcome = Some(outcome.to_string());
            session.completed_at_ms = Some(now);
            session.duration_ms = Some(now.saturating_sub(session.suggested_at_ms));
            let id = session.id.clone();
            // Move to completed
            let completed = self.active_session.take().unwrap();
            self.sessions.push(completed);
            Some(id)
        } else {
            None
        }
    }
}
