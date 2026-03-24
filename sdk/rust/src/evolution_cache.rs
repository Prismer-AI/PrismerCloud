//! EvolutionCache — local gene cache with Thompson Sampling selection.
//!
//! Enables <1ms gene selection without network calls.
//! Port of sdk/typescript/src/evolution-cache.ts.

use std::collections::HashMap;
use crate::types::SignalTag;

/// Result of a local gene selection via Thompson Sampling.
#[derive(Debug)]
pub struct GeneSelectionResult {
    /// "apply_gene", "create_suggested", or "none"
    pub action: String,
    pub gene_id: Option<String>,
    pub gene: Option<serde_json::Value>,
    pub strategy: Option<Vec<String>>,
    pub confidence: f64,
    pub coverage_score: Option<f64>,
    pub alternatives: Vec<Alternative>,
    pub reason: String,
    pub from_cache: bool,
}

/// An alternative gene candidate.
#[derive(Debug)]
pub struct Alternative {
    pub gene_id: String,
    pub confidence: f64,
    pub title: Option<String>,
}

/// Local gene cache with Thompson Sampling selection.
///
/// # Example
/// ```no_run
/// use prismer_sdk::evolution_cache::EvolutionCache;
/// use prismer_sdk::types::SignalTag;
///
/// let mut cache = EvolutionCache::new();
/// // cache.load_snapshot(&snapshot);
/// // let result = cache.select_gene(&[SignalTag { signal_type: "error:timeout".into(), .. }]);
/// ```
pub struct EvolutionCache {
    genes: HashMap<String, serde_json::Value>,
    edges: HashMap<String, Vec<serde_json::Value>>,
    global_prior: HashMap<String, (f64, f64)>, // (alpha, beta)
    cursor: u64,
}

impl EvolutionCache {
    /// Create a new empty evolution cache.
    pub fn new() -> Self {
        Self {
            genes: HashMap::new(),
            edges: HashMap::new(),
            global_prior: HashMap::new(),
            cursor: 0,
        }
    }

    /// Number of genes in the cache.
    pub fn gene_count(&self) -> usize {
        self.genes.len()
    }

    /// Current sync cursor.
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Load from a full sync snapshot, replacing all existing data.
    pub fn load_snapshot(&mut self, snapshot: &serde_json::Value) {
        self.genes.clear();
        self.edges.clear();
        self.global_prior.clear();

        // Load genes
        if let Some(genes) = snapshot.get("genes").and_then(|v| v.as_array()) {
            for gene in genes {
                let id = gene.get("id").or_else(|| gene.get("gene_id"))
                    .and_then(|v| v.as_str());
                if let Some(id) = id {
                    self.genes.insert(id.to_string(), gene.clone());
                }
            }
        }

        // Load edges
        if let Some(edges) = snapshot.get("edges").and_then(|v| v.as_array()) {
            for edge in edges {
                let key = edge.get("signal_key").or_else(|| edge.get("signalKey"))
                    .and_then(|v| v.as_str());
                if let Some(key) = key {
                    self.edges.entry(key.to_string()).or_default().push(edge.clone());
                }
            }
        }

        // Load global prior
        let gp = snapshot.get("globalPrior").or_else(|| snapshot.get("global_prior"));
        if let Some(gp) = gp.and_then(|v| v.as_object()) {
            for (key, val) in gp {
                if let Some(obj) = val.as_object() {
                    let alpha = obj.get("alpha").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let beta = obj.get("beta").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    self.global_prior.insert(key.clone(), (alpha, beta));
                } else if let Some(f) = val.as_f64() {
                    self.global_prior.insert(key.clone(), (f, 1.0));
                }
            }
        }

        if let Some(cur) = snapshot.get("cursor").and_then(|v| v.as_u64()) {
            self.cursor = cur;
        }
    }

    /// Apply an incremental sync delta.
    pub fn apply_delta(&mut self, delta: &serde_json::Value) {
        let pulled = delta.get("pulled").unwrap_or(delta);

        // Update genes
        if let Some(genes) = pulled.get("genes").and_then(|v| v.as_array()) {
            for gene in genes {
                let id = gene.get("id").or_else(|| gene.get("gene_id"))
                    .and_then(|v| v.as_str());
                if let Some(id) = id {
                    self.genes.insert(id.to_string(), gene.clone());
                }
            }
        }

        // Remove quarantined
        if let Some(quarantines) = pulled.get("quarantines").and_then(|v| v.as_array()) {
            for qid in quarantines {
                if let Some(qid) = qid.as_str() {
                    self.genes.remove(qid);
                }
            }
        }

        // Update edges
        if let Some(edges) = pulled.get("edges").and_then(|v| v.as_array()) {
            for edge in edges {
                let key = edge.get("signal_key").or_else(|| edge.get("signalKey"))
                    .and_then(|v| v.as_str());
                let gene_id = edge.get("gene_id").or_else(|| edge.get("geneId"))
                    .and_then(|v| v.as_str()).unwrap_or("");
                if let Some(key) = key {
                    let list = self.edges.entry(key.to_string()).or_default();
                    let mut found = false;
                    for existing in list.iter_mut() {
                        let eid = existing.get("gene_id").or_else(|| existing.get("geneId"))
                            .and_then(|v| v.as_str()).unwrap_or("");
                        if eid == gene_id {
                            *existing = edge.clone();
                            found = true;
                            break;
                        }
                    }
                    if !found {
                        list.push(edge.clone());
                    }
                }
            }
        }

        // Update global prior
        let gp = pulled.get("globalPrior").or_else(|| pulled.get("global_prior"));
        if let Some(gp) = gp.and_then(|v| v.as_object()) {
            for (key, val) in gp {
                if let Some(obj) = val.as_object() {
                    let alpha = obj.get("alpha").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let beta = obj.get("beta").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    self.global_prior.insert(key.clone(), (alpha, beta));
                }
            }
        }

        if let Some(cur) = pulled.get("cursor").and_then(|v| v.as_u64()) {
            self.cursor = cur;
        }
    }

    /// Alias for `apply_delta` (API parity).
    pub fn load_delta(&mut self, delta: &serde_json::Value) {
        self.apply_delta(delta);
    }

    /// Select the best gene for the given signals using Thompson Sampling.
    /// Pure CPU, <1ms.
    pub fn select_gene(&self, signals: &[SignalTag]) -> GeneSelectionResult {
        if self.genes.is_empty() {
            return GeneSelectionResult {
                action: "none".to_string(),
                gene_id: None,
                gene: None,
                strategy: None,
                confidence: 0.0,
                coverage_score: None,
                alternatives: vec![],
                reason: "no genes in cache".to_string(),
                from_cache: true,
            };
        }

        let signal_keys: Vec<&str> = signals.iter().map(|s| s.signal_type.as_str()).collect();

        struct Candidate {
            gene: serde_json::Value,
            rank_score: f64,
            coverage_score: f64,
        }
        let mut candidates: Vec<Candidate> = Vec::new();

        for gene in self.genes.values() {
            // Skip quarantined
            if gene.get("visibility").and_then(|v| v.as_str()) == Some("quarantined") {
                continue;
            }

            // Extract gene signal types
            let gene_signal_types = self.extract_gene_signal_types(gene);
            if gene_signal_types.is_empty() {
                continue;
            }

            // Coverage score
            let match_count = signal_keys.iter()
                .filter(|k| gene_signal_types.iter().any(|gs| gs == *k))
                .count();
            let coverage_score = match_count as f64 / gene_signal_types.len() as f64;
            if coverage_score == 0.0 {
                continue;
            }

            // Thompson Sampling: Beta(alpha, beta) mean
            let sc = gene.get("success_count").or_else(|| gene.get("successCount"))
                .and_then(|v| v.as_f64()).unwrap_or(0.0);
            let fc = gene.get("failure_count").or_else(|| gene.get("failureCount"))
                .and_then(|v| v.as_f64()).unwrap_or(0.0);
            let mut alpha = sc + 1.0;
            let mut beta = fc + 1.0;

            // Blend with global prior (weight 0.3)
            for key in &signal_keys {
                if let Some(&(pa, pb)) = self.global_prior.get(*key) {
                    alpha += 0.3 * pa;
                    beta += 0.3 * pb;
                }
            }

            let sampled_score = alpha / (alpha + beta);

            // Ban threshold: skip if success rate < 18% with enough data
            let total_obs = sc + fc;
            if total_obs >= 10.0 && sc / total_obs < 0.18 {
                continue;
            }

            // Combined rank score
            let rank_score = coverage_score * 0.4 + sampled_score * 0.6;

            candidates.push(Candidate {
                gene: gene.clone(),
                rank_score,
                coverage_score,
            });
        }

        if candidates.is_empty() {
            return GeneSelectionResult {
                action: "create_suggested".to_string(),
                gene_id: None,
                gene: None,
                strategy: None,
                confidence: 0.0,
                coverage_score: None,
                alternatives: vec![],
                reason: "no matching genes for signals".to_string(),
                from_cache: true,
            };
        }

        // Sort by rank score descending
        candidates.sort_by(|a, b| b.rank_score.partial_cmp(&a.rank_score).unwrap_or(std::cmp::Ordering::Equal));

        let best = &candidates[0];

        // Build alternatives (top 3 after best)
        let limit = std::cmp::min(candidates.len(), 4);
        let alternatives: Vec<Alternative> = candidates[1..limit].iter().map(|c| {
            Alternative {
                gene_id: c.gene.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                confidence: round_to_2(c.rank_score),
                title: c.gene.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
            }
        }).collect();

        // Extract strategy
        let strategy = best.gene.get("strategy").and_then(|v| v.as_array()).map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        });

        let gene_id = best.gene.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

        GeneSelectionResult {
            action: "apply_gene".to_string(),
            gene_id: Some(gene_id),
            gene: Some(best.gene.clone()),
            strategy,
            confidence: round_to_2(best.rank_score),
            coverage_score: Some(round_to_2(best.coverage_score)),
            alternatives,
            reason: format!("local cache selection ({} genes)", self.genes.len()),
            from_cache: true,
        }
    }

    // ── helpers ───────────────────────────────────────────────

    fn extract_gene_signal_types(&self, gene: &serde_json::Value) -> Vec<String> {
        let raw = gene.get("signals_match").or_else(|| gene.get("signalsMatch"));
        match raw.and_then(|v| v.as_array()) {
            Some(arr) => arr.iter().filter_map(|s| {
                if let Some(str_val) = s.as_str() {
                    Some(str_val.to_string())
                } else if let Some(obj) = s.as_object() {
                    obj.get("type").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            }).collect(),
            None => vec![],
        }
    }
}

impl Default for EvolutionCache {
    fn default() -> Self {
        Self::new()
    }
}

fn round_to_2(v: f64) -> f64 {
    (v * 100.0 + 0.5).floor() / 100.0
}
