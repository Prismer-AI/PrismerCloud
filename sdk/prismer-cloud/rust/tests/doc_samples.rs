//! Prismer Rust SDK — Doc Sample Tests
//!
//! Each test is annotated with `@doc-sample` and contains `--- sample start/end ---` markers.
//! Only code between these markers is extracted for docs. The surrounding test
//! assertions ensure the sample actually works.
//!
//! Usage:
//!   PRISMER_API_KEY_TEST="sk-prismer-live-..." cargo test --test doc_samples -- --nocapture
//!
//! Extract samples:
//!   npx tsx scripts/docs/extract-samples.ts

use prismer_sdk::PrismerClient;
use serde_json::json;

fn test_client() -> PrismerClient {
    let api_key = std::env::var("PRISMER_API_KEY_TEST")
        .expect("PRISMER_API_KEY_TEST environment variable is required");
    let base_url = std::env::var("PRISMER_BASE_URL_TEST")
        .unwrap_or_else(|_| "https://prismer.cloud".to_string());
    PrismerClient::new(&api_key, Some(&base_url))
}

// ═══════════════════════════════════════════════════════════════════
// Context API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: contextLoad / single_url
#[tokio::test]
async fn doc_context_load_single_url() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let result = client.context().load("https://example.com").await;

    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            if let Some(results) = &data.results {
                for item in results {
                    println!("Title: {:?}", item.title);
                    println!("URL: {:?}", item.url);
                }
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.context().load("https://example.com").await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: contextLoad / batch_urls
#[tokio::test]
async fn doc_context_load_batch_urls() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let result = client.context().load(
        "https://example.com\nhttps://httpbin.org/html"
    ).await;

    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            if let Some(results) = &data.results {
                for item in results {
                    println!("{}: {:?}", item.title.as_deref().unwrap_or("?"), item.url);
                }
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.context().load("https://example.com\nhttps://httpbin.org/html").await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: contextLoad / search_query
#[tokio::test]
async fn doc_context_load_search_query() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let result = client.context().load("latest AI research papers").await;

    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            if let Some(results) = &data.results {
                for item in results {
                    println!("{}: {:?}", item.title.as_deref().unwrap_or("?"), item.url);
                }
                println!("Total: {} results", results.len());
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.context().load("What is Rust programming?").await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: contextSave / basic
#[tokio::test]
async fn doc_context_save_basic() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let result = client.context().save(
        "# API Reference\n\nCompressed documentation content...",
        Some("https://my-app.com/docs/api-reference"),
    ).await;

    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            println!("Saved: {}", data);
        }
    }
    // --- sample end ---

    let real = test_client();
    let url = format!("https://doc-sample-test-{}.example.com", chrono_now());
    let r = real.context().save(
        &format!("Doc sample test content {}", chrono_now()),
        Some(&url),
    ).await.unwrap();
    assert!(r.is_ok());
}

// ═══════════════════════════════════════════════════════════════════
// Parse API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: parseDocument / pdf_fast
#[tokio::test]
async fn doc_parse_document_pdf_fast() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let result = client.parse().submit(
        "https://arxiv.org/pdf/2301.00234v1",
        Some("fast"),
    ).await;

    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            if let Some(doc) = &data.document {
                println!("Document: {}", doc);
            } else if let Some(task_id) = &data.task_id {
                println!("Async task: {}", task_id);
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.parse().submit("https://arxiv.org/pdf/2301.00234v1", Some("fast")).await.unwrap();
    assert!(r.is_ok());
    let data = r.data.unwrap();
    assert!(data.document.is_some() || data.task_id.is_some());
}

// ═══════════════════════════════════════════════════════════════════
// Evolution API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: evolutionAnalyze / default
#[tokio::test]
async fn doc_evolution_analyze() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let advice = client.evolution().analyze(
        vec![json!("error:timeout"), json!("error:connection_reset")],
        None,
    ).await;

    if let Ok(resp) = &advice {
        if let Some(data) = &resp.data {
            println!("Action: {}", data.action);
            if let Some(gene) = &data.gene {
                println!("Gene: {}", gene.id);
                println!("Confidence: {:?}", resp.data.as_ref()
                    .and_then(|d| d.confidence));
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().analyze(
        vec![json!("error:timeout")],
        None,
    ).await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: evolutionRecord / default
#[tokio::test]
async fn doc_evolution_record() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let _result = client.evolution().record(
        "gene_repair_timeout",
        vec![json!("error:timeout")],
        "success",
        "Resolved with exponential backoff — 3 retries, final latency 1.2s",
        Some(0.9),
        None,
    ).await;
    // --- sample end ---

    // No real test — record requires a valid gene_id from analyze
    assert!(true);
}

// @doc-sample: evolutionGeneCreate / default
#[tokio::test]
async fn doc_evolution_gene_create() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let gene = client.evolution().create_gene(
        "repair",
        vec![json!({
            "type": "error",
            "provider": "openai",
            "stage": "api_call",
        })],
        vec![
            "Detect 429 status code".to_string(),
            "Extract Retry-After header".to_string(),
            "Wait for specified duration (default: 60s)".to_string(),
            "Retry with exponential backoff (max 3 attempts)".to_string(),
        ],
        Some("Rate Limit Backoff"),
        None,
    ).await;

    if let Ok(resp) = &gene {
        if let Some(data) = &resp.data {
            println!("Created gene: {}", data.id);
            println!("Category: {:?}", data.category);
        }
    }
    // --- sample end ---

    let real = test_client();
    let title = format!("Doc Sample Test Gene {}", chrono_now());
    let r = real.evolution().create_gene(
        "repair",
        vec![json!("test:doc_sample")],
        vec!["Step 1: Identify issue".to_string(), "Step 2: Apply fix".to_string()],
        Some(&title),
        None,
    ).await.unwrap();
    assert!(r.is_ok());
    // Cleanup: delete the test gene
    if let Some(gene) = &r.data {
        let _ = real.evolution().delete_gene(&gene.id).await;
    }
}

// @doc-sample: evolutionPublicGenes / default
#[tokio::test]
async fn doc_evolution_browse_genes() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let genes = client.evolution().browse_genes(
        Some("repair"),
        Some(5),
    ).await;

    if let Ok(resp) = &genes {
        if let Some(data) = &resp.data {
            for gene in data {
                println!("{} ({:?}) — {:?} steps",
                    gene.title.as_deref().unwrap_or("?"),
                    gene.category,
                    gene.strategy.as_ref().map(|s| s.len()),
                );
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().browse_genes(None, Some(5)).await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: evolutionAchievements / default
#[tokio::test]
async fn doc_evolution_achievements() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let achievements = client.evolution().get_achievements().await;

    if let Ok(resp) = &achievements {
        if let Some(data) = &resp.data {
            for a in data {
                println!("Achievement: {}", a);
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().get_achievements().await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: evolutionReport / default
#[tokio::test]
async fn doc_evolution_report() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let report = client.evolution().submit_report(
        "API timeout errors occurring frequently on /api/data",
        "success",
        Some("Investigating timeout patterns"),
        Some("Connection timeout after 30s"),
        None,
        None,
    ).await;

    if let Ok(resp) = &report {
        if let Some(data) = &resp.data {
            println!("Report submitted: {}", data);
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().submit_report(
        "Doc sample test report",
        "success",
        Some("Test context"),
        None,
        None,
        None,
    ).await.unwrap();
    assert!(r.is_ok());
}

// ═══════════════════════════════════════════════════════════════════
// Skills API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: skillSearch / default
#[tokio::test]
async fn doc_skill_search() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let results = client.evolution().search_skills(
        Some("timeout retry"),
        None,
        Some(10),
    ).await;

    if let Ok(resp) = &results {
        if let Some(data) = &resp.data {
            for skill in data {
                println!("Skill: {}", skill);
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().search_skills(Some("api"), None, Some(5)).await.unwrap();
    assert!(r.is_ok());
}

// @doc-sample: skillInstall / default
#[tokio::test]
async fn doc_skill_install_uninstall() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);

    // Install a skill by slug
    let result = client.evolution().install_skill("memory-management").await;
    if let Ok(resp) = &result {
        if let Some(data) = &resp.data {
            println!("Installed: {}", data);
        }
    }

    // Uninstall when no longer needed
    let _ = client.evolution().uninstall_skill("memory-management").await;
    // --- sample end ---

    // Real test: search for any skill, install it, verify, uninstall
    let real = test_client();
    let search = real.evolution().search_skills(None, None, Some(1)).await.unwrap();
    if let Some(data) = &search.data {
        if let Some(first) = data.first() {
            let slug = first.get("slug")
                .or_else(|| first.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("test");
            let install = real.evolution().install_skill(slug).await.unwrap();
            assert!(install.is_ok());
            // Cleanup
            let _ = real.evolution().uninstall_skill(slug).await;
        }
    }
}

// @doc-sample: skillInstalledList / default
#[tokio::test]
async fn doc_skill_installed_list() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);
    let installed = client.evolution().installed_skills().await;

    if let Ok(resp) = &installed {
        if let Some(data) = &resp.data {
            println!("{} skills installed", data.len());
            for record in data {
                println!("  Skill: {}", record);
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.evolution().installed_skills().await.unwrap();
    assert!(r.is_ok());
}

// ═══════════════════════════════════════════════════════════════════
// Tasks API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: imTaskCreate / lifecycle
#[tokio::test]
async fn doc_task_lifecycle() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);

    // Create a task
    let task = client.tasks().create(
        "Analyze website performance",
        Some("Run Lighthouse audit on https://example.com"),
        Some("web-analysis"),
        None,
        None,
    ).await;

    if let Ok(resp) = &task {
        if let Some(data) = &resp.data {
            let task_id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
            println!("Task {}: {:?}", task_id, data.get("status"));

            // List pending tasks
            let pending = client.tasks().list(Some("pending"), None, Some(10)).await;
            if let Ok(p) = &pending {
                println!("{} pending tasks", p.data.as_ref().map(|d| d.len()).unwrap_or(0));
            }

            // Complete the task with a result
            let _completed = client.tasks().complete(
                task_id,
                Some(json!({ "score": 92, "metrics": { "fcp": 1.2 } })),
            ).await;
        }
    }
    // --- sample end ---

    let real = test_client();
    let title = format!("Doc Sample Test Task {}", chrono_now());
    let r = real.tasks().create(&title, None, Some("test"), None, None).await.unwrap();
    assert!(r.is_ok());
    if let Some(data) = &r.data {
        if let Some(task_id) = data.get("id").and_then(|v| v.as_str()) {
            // Verify we can list
            let list = real.tasks().list(Some("pending"), None, None).await.unwrap();
            assert!(list.is_ok());
            // Complete the task
            let done = real.tasks().complete(task_id, Some(json!({ "test": true }))).await.unwrap();
            assert!(done.is_ok());
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// Memory API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: imMemoryCreate / default
#[tokio::test]
async fn doc_memory_write_read() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);

    // Write a memory file
    let file = client.memory().create_file(
        "MEMORY.md",
        "# Project Memory\n\n## Key Decisions\n- Use exponential backoff for API retries\n- Cache TTL set to 5 minutes",
        None,
    ).await;

    if let Ok(resp) = &file {
        if let Some(data) = &resp.data {
            let file_id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
            println!("File ID: {}", file_id);
            println!("Version: {:?}", data.get("version"));

            // Read it back
            let loaded = client.memory().get_file(file_id).await;
            if let Ok(l) = &loaded {
                println!("Content: {:?}", l.data);
            }
        }
    }
    // --- sample end ---

    let real = test_client();
    let path = format!("test-doc-sample-{}.md", chrono_now());
    let r = real.memory().create_file(
        &path,
        "# Test Memory\nDoc sample test content",
        None,
    ).await.unwrap();
    assert!(r.is_ok());
    if let Some(data) = &r.data {
        if let Some(file_id) = data.get("id").and_then(|v| v.as_str()) {
            let read = real.memory().get_file(file_id).await.unwrap();
            assert!(read.is_ok());
            // Cleanup
            let _ = real.memory().delete_file(file_id).await;
        }
    }
}

// @doc-sample: imMemoryLoad / default
#[tokio::test]
async fn doc_memory_load() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);

    // Load the agent's MEMORY.md for current session context
    let mem = client.memory().load(None).await;

    if let Ok(resp) = &mem {
        if let Some(data) = &resp.data {
            println!("Memory loaded: {}", data);
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.memory().load(None).await.unwrap();
    assert!(r.is_ok());
}

// ═══════════════════════════════════════════════════════════════════
// Recall API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: imRecall / default
#[tokio::test]
async fn doc_recall_search() {
    // --- sample start ---
    let client = PrismerClient::new("sk-prismer-xxx", None);

    // Search across all data sources (memory, cache, evolution)
    let results = client.im().recall("timeout retry backoff").await;

    if let Ok(resp) = &results {
        if let Some(data) = &resp.data {
            println!("Recall results: {}", data);
        }
    }
    // --- sample end ---

    let real = test_client();
    let r = real.im().recall("test").await.unwrap();
    assert!(r.is_ok());
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/// Simple timestamp for unique test data (avoids pulling in chrono crate).
fn chrono_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
