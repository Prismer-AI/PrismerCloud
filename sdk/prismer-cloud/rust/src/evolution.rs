use crate::{PrismerClient, types::*};
use serde_json::json;

/// Sanitize a slug to prevent directory traversal attacks.
/// Strips `..`, `/`, `\`, null bytes, and takes only the basename component.
fn safe_slug(s: &str) -> String {
    let s = s.replace("..", "").replace('/', "").replace('\\', "").replace('\0', "");
    std::path::Path::new(&s)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default()
}

pub struct EvolutionClient<'a> {
    pub(crate) client: &'a PrismerClient,
}

impl<'a> EvolutionClient<'a> {
    // ─── Public (no auth) ────────────────────────

    /// Get evolution statistics.
    pub async fn stats(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/evolution/public/stats", None).await
    }

    /// Get hot genes.
    pub async fn hot_genes(&self, limit: Option<u32>) -> Result<ApiResponse<Vec<Gene>>, PrismerError> {
        let path = match limit {
            Some(l) => format!("/api/im/evolution/public/hot?limit={}", l),
            None => "/api/im/evolution/public/hot".to_string(),
        };
        self.client.request(reqwest::Method::GET, &path, None).await
    }

    /// Browse public genes.
    pub async fn browse_genes(&self, category: Option<&str>, limit: Option<u32>) -> Result<ApiResponse<Vec<Gene>>, PrismerError> {
        let mut params = vec![];
        if let Some(c) = category { params.push(format!("category={}", c)); }
        if let Some(l) = limit { params.push(format!("limit={}", l)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/public/genes{}", qs), None).await
    }

    /// Get evolution feed.
    pub async fn feed(&self, limit: Option<u32>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let path = match limit {
            Some(l) => format!("/api/im/evolution/public/feed?limit={}", l),
            None => "/api/im/evolution/public/feed".to_string(),
        };
        self.client.request(reqwest::Method::GET, &path, None).await
    }

    /// Get evolution stories (L1 narrative).
    pub async fn stories(&self, limit: Option<u32>, since_minutes: Option<u32>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut params = vec![];
        if let Some(l) = limit { params.push(format!("limit={}", l)); }
        if let Some(s) = since_minutes { params.push(format!("since={}", s)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/stories{}", qs), None).await
    }

    /// Get evolution map data.
    pub async fn map_data(&self) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/evolution/map", None).await
    }

    /// Get north-star A/B metrics comparison.
    pub async fn metrics(&self) -> Result<ApiResponse<EvolutionMetrics>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/evolution/metrics", None).await
    }

    // ─── Auth required ───────────────────────────

    /// Analyze signals and get gene recommendation.
    pub async fn analyze(&self, signals: Vec<serde_json::Value>, scope: Option<&str>) -> Result<ApiResponse<EvolutionAdvice>, PrismerError> {
        let path = match scope {
            Some(s) => format!("/api/im/evolution/analyze?scope={}", s),
            None => "/api/im/evolution/analyze".to_string(),
        };
        self.client.request(
            reqwest::Method::POST,
            &path,
            Some(json!({ "signals": signals })),
        ).await
    }

    /// Record gene execution outcome.
    pub async fn record(
        &self,
        gene_id: &str,
        signals: Vec<serde_json::Value>,
        outcome: &str,
        summary: &str,
        score: Option<f64>,
        scope: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({
            "gene_id": gene_id,
            "signals": signals,
            "outcome": outcome,
            "summary": summary,
        });
        if let Some(s) = score {
            body["score"] = json!(s);
        }
        let path = match scope {
            Some(s) => format!("/api/im/evolution/record?scope={}", s),
            None => "/api/im/evolution/record".to_string(),
        };
        self.client.request(reqwest::Method::POST, &path, Some(body)).await
    }

    /// One-step evolution: analyze context → get gene → auto-record outcome.
    pub async fn evolve(
        &self,
        signals: Vec<serde_json::Value>,
        outcome: &str,
        summary: &str,
        score: Option<f64>,
        scope: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let analysis: ApiResponse<serde_json::Value> = self.client.request(
            reqwest::Method::POST,
            &match scope {
                Some(s) if !s.is_empty() => format!("/api/im/evolution/analyze?scope={}", s),
                _ => "/api/im/evolution/analyze".to_string(),
            },
            Some(json!({ "signals": signals })),
        ).await?;

        let data = match &analysis.data {
            Some(d) => d,
            None => return Ok(ApiResponse {
                success: Some(true),
                ok: Some(true),
                data: Some(json!({ "recorded": false })),
                error: None,
            }),
        };

        let gene_id = data.get("gene_id")
            .or_else(|| data.get("gene").and_then(|g| g.get("id")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");

        if gene_id.is_empty() || (action != "apply_gene" && action != "explore") {
            return Ok(ApiResponse {
                success: Some(true),
                ok: Some(true),
                data: Some(json!({ "analysis": data, "recorded": false })),
                error: None,
            });
        }

        let rec_signals = data.get("signals")
            .and_then(|v| v.as_array())
            .cloned()
            .map(|arr| arr.into_iter().collect())
            .unwrap_or(signals);

        let _ = self.record(gene_id, rec_signals, outcome, summary, score, scope).await?;
        Ok(ApiResponse {
            success: Some(true),
            ok: Some(true),
            data: Some(json!({ "analysis": data, "recorded": true })),
            error: None,
        })
    }

    /// Create a new gene.
    pub async fn create_gene(
        &self,
        category: &str,
        signals_match: Vec<serde_json::Value>,
        strategy: Vec<String>,
        title: Option<&str>,
        scope: Option<&str>,
    ) -> Result<ApiResponse<Gene>, PrismerError> {
        let mut body = json!({
            "category": category,
            "signals_match": signals_match,
            "strategy": strategy,
        });
        if let Some(t) = title {
            body["title"] = json!(t);
        }
        let path = match scope {
            Some(s) => format!("/api/im/evolution/genes?scope={}", s),
            None => "/api/im/evolution/genes".to_string(),
        };
        self.client.request(reqwest::Method::POST, &path, Some(body)).await
    }

    /// List own genes.
    pub async fn list_genes(&self, scope: Option<&str>) -> Result<ApiResponse<Vec<Gene>>, PrismerError> {
        let path = match scope {
            Some(s) => format!("/api/im/evolution/genes?scope={}", s),
            None => "/api/im/evolution/genes".to_string(),
        };
        self.client.request(reqwest::Method::GET, &path, None).await
    }

    /// Delete a gene.
    pub async fn delete_gene(&self, gene_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::DELETE, &format!("/api/im/evolution/genes/{}", gene_id), None).await
    }

    /// Publish gene as canary.
    pub async fn publish_gene(&self, gene_id: &str) -> Result<ApiResponse<Gene>, PrismerError> {
        self.client.request(reqwest::Method::POST, &format!("/api/im/evolution/publish/{}", gene_id), None).await
    }

    /// Get edges.
    pub async fn edges(&self, signal_key: Option<&str>, gene_id: Option<&str>, scope: Option<&str>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut params = vec![];
        if let Some(s) = signal_key { params.push(format!("signal_key={}", s)); }
        if let Some(g) = gene_id { params.push(format!("gene_id={}", g)); }
        if let Some(sc) = scope { params.push(format!("scope={}", sc)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/edges{}", qs), None).await
    }

    /// Get personality.
    pub async fn personality(&self, agent_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/personality/{}", agent_id), None).await
    }

    /// List available evolution scopes.
    pub async fn list_scopes(&self) -> Result<ApiResponse<Vec<String>>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/evolution/scopes", None).await
    }

    /// Trigger metrics collection.
    pub async fn collect_metrics(&self, window_hours: u32) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            "/api/im/evolution/metrics/collect",
            Some(json!({ "window_hours": window_hours })),
        ).await
    }

    // ─── Skills ──────────────────────────────────

    /// Search skills catalog.
    pub async fn search_skills(&self, query: Option<&str>, category: Option<&str>, limit: Option<u32>) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        let mut params = vec![];
        if let Some(q) = query { params.push(format!("query={}", q)); }
        if let Some(c) = category { params.push(format!("category={}", c)); }
        if let Some(l) = limit { params.push(format!("limit={}", l)); }
        let qs = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        self.client.request(reqwest::Method::GET, &format!("/api/im/skills/search{}", qs), None).await
    }

    /// Install a skill — creates cloud record + Gene, returns content for local install.
    pub async fn install_skill(&self, slug_or_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/skills/{}/install", urlencoding::encode(slug_or_id)),
            None,
        ).await
    }

    /// Uninstall a skill.
    pub async fn uninstall_skill(&self, slug_or_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::DELETE,
            &format!("/api/im/skills/{}/install", urlencoding::encode(slug_or_id)),
            None,
        ).await
    }

    /// List installed skills for this agent.
    pub async fn installed_skills(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/skills/installed", None).await
    }

    /// Get full skill content (SKILL.md + package info).
    pub async fn get_skill_content(&self, slug_or_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(
            reqwest::Method::GET,
            &format!("/api/im/skills/{}/content", urlencoding::encode(slug_or_id)),
            None,
        ).await
    }

    // ─── Local file sync ────────────────────────────

    /// Install a skill and write SKILL.md to local filesystem.
    /// Combines cloud install + local file sync for Claude Code / OpenClaw / OpenCode.
    pub async fn install_skill_local(
        &self,
        slug_or_id: &str,
        platforms: Option<&[&str]>,
        project: bool,
        project_root: Option<&str>,
    ) -> Result<(ApiResponse<serde_json::Value>, Vec<String>), PrismerError> {
        // 1. Cloud install
        let cloud_res = self.install_skill(slug_or_id).await?;

        let mut local_paths = Vec::new();

        // 2. Extract content and slug from response
        let (content, slug) = if let Some(ref data) = cloud_res.data {
            let skill = data.get("skill").and_then(|s| s.as_object());
            let content = skill
                .and_then(|s| s.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            let raw_slug = skill
                .and_then(|s| s.get("slug"))
                .and_then(|s| s.as_str())
                .unwrap_or(slug_or_id);
            let slug = safe_slug(raw_slug);
            if slug.is_empty() {
                return Ok((cloud_res, local_paths));
            }
            (content, slug)
        } else {
            return Ok((cloud_res, local_paths));
        };

        // 3. If no content, fetch it
        let content = if content.is_empty() {
            match self.get_skill_content(slug_or_id).await {
                Ok(res) => res
                    .data
                    .as_ref()
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                Err(_) => String::new(),
            }
        } else {
            content
        };

        if content.is_empty() {
            return Ok((cloud_res, local_paths));
        }

        // 4. Determine target paths
        let home = dirs::home_dir().unwrap_or_default();
        let root = project_root
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."));

        let plugin_dir = std::env::var("PRISMER_PLUGIN_DIR")
            .unwrap_or_else(|_| home.join(".claude").join("plugins").join("prismer").to_string_lossy().to_string());
        let plugin_base = std::path::PathBuf::from(&plugin_dir);

        let all_platforms: Vec<(&str, std::path::PathBuf)> = if project {
            vec![
                ("claude-code", root.join(".claude").join("skills").join(&slug)),
                ("openclaw", root.join("skills").join(&slug)),
                ("opencode", root.join(".opencode").join("skills").join(&slug)),
                ("plugin", root.join(".claude").join("plugins").join("prismer").join("skills").join(&slug)),
            ]
        } else {
            vec![
                ("claude-code", home.join(".claude").join("skills").join(&slug)),
                ("openclaw", home.join(".openclaw").join("skills").join(&slug)),
                ("opencode", home.join(".config").join("opencode").join("skills").join(&slug)),
                ("plugin", plugin_base.join("skills").join(&slug)),
            ]
        };

        // Filter by requested platforms
        let targets: Vec<_> = match platforms {
            Some(ps) => all_platforms
                .into_iter()
                .filter(|(name, _)| ps.contains(name))
                .collect(),
            None => all_platforms,
        };

        // 5. Write SKILL.md
        for (_, dir) in &targets {
            if let Err(_) = std::fs::create_dir_all(dir) {
                continue;
            }
            let file_path = dir.join("SKILL.md");
            if std::fs::write(&file_path, &content).is_ok() {
                local_paths.push(file_path.to_string_lossy().to_string());
            }
        }

        Ok((cloud_res, local_paths))
    }

    /// Uninstall a skill and remove local SKILL.md files.
    pub async fn uninstall_skill_local(
        &self,
        slug_or_id: &str,
    ) -> Result<(ApiResponse<serde_json::Value>, Vec<String>), PrismerError> {
        let cloud_res = self.uninstall_skill(slug_or_id).await?;
        let mut removed = Vec::new();

        let safe = safe_slug(slug_or_id);
        if safe.is_empty() {
            return Ok((cloud_res, removed));
        }

        if let Some(home) = dirs::home_dir() {
            let plugin_dir = std::env::var("PRISMER_PLUGIN_DIR")
                .unwrap_or_else(|_| home.join(".claude").join("plugins").join("prismer").to_string_lossy().to_string());
            let plugin_base = std::path::PathBuf::from(&plugin_dir);

            let dirs = [
                home.join(".claude").join("skills").join(&safe),
                home.join(".openclaw").join("skills").join(&safe),
                home.join(".config").join("opencode").join("skills").join(&safe),
                plugin_base.join("skills").join(&safe),
            ];

            for dir in &dirs {
                if dir.exists() {
                    if std::fs::remove_dir_all(dir).is_ok() {
                        removed.push(dir.to_string_lossy().to_string());
                    }
                }
            }
        }

        Ok((cloud_res, removed))
    }

    /// Sync all installed skills to local filesystem.
    pub async fn sync_skills_local(
        &self,
        platforms: Option<&[&str]>,
    ) -> Result<(usize, usize, Vec<String>), PrismerError> {
        let installed = self.installed_skills().await?;
        let mut synced = 0usize;
        let mut failed = 0usize;
        let mut paths = Vec::new();

        let records = match &installed.data {
            Some(data) => data.clone(),
            None => return Ok((0, 0, paths)),
        };

        let home = dirs::home_dir().unwrap_or_default();

        for record in records {
            let slug = record
                .get("skill")
                .and_then(|s| s.get("slug"))
                .and_then(|s| s.as_str());

            let slug = match slug {
                Some(s) => {
                    let safe = safe_slug(s);
                    if safe.is_empty() {
                        failed += 1;
                        continue;
                    }
                    safe
                }
                None => {
                    failed += 1;
                    continue;
                }
            };

            let content = match self.get_skill_content(&slug).await {
                Ok(res) => res
                    .data
                    .as_ref()
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                Err(_) => {
                    failed += 1;
                    continue;
                }
            };

            if content.is_empty() {
                failed += 1;
                continue;
            }

            let plugin_dir = std::env::var("PRISMER_PLUGIN_DIR")
                .unwrap_or_else(|_| home.join(".claude").join("plugins").join("prismer").to_string_lossy().to_string());
            let plugin_base = std::path::PathBuf::from(&plugin_dir);

            let all_paths: Vec<(&str, std::path::PathBuf)> = vec![
                ("claude-code", home.join(".claude").join("skills").join(&slug)),
                ("openclaw", home.join(".openclaw").join("skills").join(&slug)),
                ("opencode", home.join(".config").join("opencode").join("skills").join(&slug)),
                ("plugin", plugin_base.join("skills").join(&slug)),
            ];

            let targets: Vec<_> = match platforms {
                Some(ps) => all_paths
                    .into_iter()
                    .filter(|(name, _)| ps.contains(name))
                    .collect(),
                None => all_paths,
            };

            for (_, dir) in &targets {
                let _ = std::fs::create_dir_all(dir);
                let fp = dir.join("SKILL.md");
                if std::fs::write(&fp, &content).is_ok() {
                    paths.push(fp.to_string_lossy().to_string());
                }
            }
            synced += 1;
        }

        Ok((synced, failed, paths))
    }

    // ─── P0: Report, Achievements, Sync ──────────────

    /// Submit a raw-context evolution report (auto-creates signals + gene match).
    pub async fn submit_report(
        &self,
        raw_context: &str,
        outcome: &str,
        task_context: Option<&str>,
        task_error: Option<&str>,
        task_id: Option<&str>,
        metadata: Option<serde_json::Value>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({
            "raw_context": raw_context,
            "outcome": outcome,
        });
        if let Some(tc) = task_context { body["task_context"] = json!(tc); }
        if let Some(te) = task_error { body["task_error"] = json!(te); }
        if let Some(ti) = task_id { body["task_id"] = json!(ti); }
        if let Some(m) = metadata { body["metadata"] = m; }
        self.client.request(reqwest::Method::POST, "/api/im/evolution/report", Some(body)).await
    }

    /// Get status of a submitted report by traceId.
    pub async fn get_report_status(&self, trace_id: &str) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/report/{}", trace_id), None).await
    }

    /// Get evolution achievements for the current agent.
    pub async fn get_achievements(&self) -> Result<ApiResponse<Vec<serde_json::Value>>, PrismerError> {
        self.client.request(reqwest::Method::GET, "/api/im/evolution/achievements", None).await
    }

    /// Get a sync snapshot (global gene/edge state since a sequence number).
    pub async fn get_sync_snapshot(&self, since: Option<u64>) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut params = vec!["scope=global".to_string()];
        if let Some(s) = since { params.push(format!("since={}", s)); }
        let qs = format!("?{}", params.join("&"));
        self.client.request(reqwest::Method::GET, &format!("/api/im/evolution/sync/snapshot{}", qs), None).await
    }

    /// Bidirectional sync: push local outcomes and pull remote updates.
    pub async fn sync(
        &self,
        push_outcomes: Option<Vec<serde_json::Value>>,
        pull_since: Option<u64>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({});
        if let Some(outcomes) = push_outcomes {
            body["push"] = json!({ "outcomes": outcomes });
        }
        if let Some(since) = pull_since {
            body["pull"] = json!({ "since": since });
        }
        self.client.request(reqwest::Method::POST, "/api/im/evolution/sync", Some(body)).await
    }

    /// Export a Gene as a Skill (export_gene_as_skill).
    pub async fn export_gene_as_skill(
        &self,
        gene_id: &str,
        slug: Option<&str>,
        display_name: Option<&str>,
        changelog: Option<&str>,
    ) -> Result<ApiResponse<serde_json::Value>, PrismerError> {
        let mut body = json!({});
        if let Some(s) = slug { body["slug"] = json!(s); }
        if let Some(dn) = display_name { body["displayName"] = json!(dn); }
        if let Some(cl) = changelog { body["changelog"] = json!(cl); }
        self.client.request(
            reqwest::Method::POST,
            &format!("/api/im/evolution/genes/{}/export-skill", gene_id),
            Some(body),
        ).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_slug_simple_name() {
        assert_eq!(safe_slug("my-skill"), "my-skill");
    }

    #[test]
    fn safe_slug_strips_directory_traversal() {
        assert_eq!(safe_slug("../../etc/passwd"), "etcpasswd");
    }

    #[test]
    fn safe_slug_strips_forward_slashes() {
        assert_eq!(safe_slug("path/to/skill"), "pathtoskill");
    }

    #[test]
    fn safe_slug_strips_backslashes() {
        assert_eq!(safe_slug("path\\to\\skill"), "pathtoskill");
    }

    #[test]
    fn safe_slug_strips_null_bytes() {
        assert_eq!(safe_slug("skill\0name"), "skillname");
    }

    #[test]
    fn safe_slug_empty_string() {
        assert_eq!(safe_slug(""), "");
    }

    #[test]
    fn safe_slug_only_dots() {
        // ".." gets stripped, "." should be handled by file_name()
        let result = safe_slug("..");
        assert_eq!(result, "");
    }

    #[test]
    fn safe_slug_preserves_normal_chars() {
        assert_eq!(safe_slug("hello-world_v2"), "hello-world_v2");
    }

    #[test]
    fn safe_slug_complex_traversal() {
        // "../../" stripped -> "" -> empty
        let result = safe_slug("../../../");
        assert_eq!(result, "");
    }
}
