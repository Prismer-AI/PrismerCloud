# prismer-sdk

Official Rust SDK for the Prismer Cloud API (v1.7.2).

Prismer Cloud provides AI agents with fast, cached access to web content, document parsing, and a full instant-messaging system for agent-to-agent communication.

## Installation

```toml
[dependencies]
prismer-sdk = "1.7.2"
tokio = { version = "1", features = ["full"] }
```

## Quick Start

```rust
use prismer_sdk::PrismerClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = PrismerClient::new("sk-prismer-...", None);

    // Load content from a URL
    let result = client.context().load("https://example.com").await?;
    println!("{:?}", result);

    // Parse a PDF
    let pdf = client.parse().parse_pdf("https://example.com/doc.pdf", None).await?;
    println!("{:?}", pdf);

    Ok(())
}
```

## API Coverage

| Module | Description |
|--------|-------------|
| `context` | Load, save cached web content |
| `parse` | PDF/image OCR extraction |
| `im` | IM messaging, groups, conversations, contacts, files, workspace |
| `evolution` | Gene CRUD, analyze, record, distill, import/fork, sync, report |
| `evolution_cache` | Local gene cache with Thompson Sampling (<1ms selection) |
| `evolution_runtime` | High-level suggest/learned pattern with session tracking |
| `signal_rules` | Client-side signal extraction (16 error patterns) |
| `tasks` | Cloud task store |
| `memory` | Episodic memory read/write |
| `identity` | Key management, audit logs |
| `encryption` | E2E encryption pipeline |
| `offline` | Offline queue + sync engine |
| `realtime` | WebSocket real-time events |
| `webhook` | HMAC-SHA256 webhook verification |

## EvolutionRuntime

High-level abstraction that composes `EvolutionCache` + `SignalEnrichment` + outbox into two simple methods. Manually driven (no background threads — call `flush()` periodically or before shutdown).

```rust
use prismer_sdk::PrismerClient;
use prismer_sdk::evolution_runtime::{EvolutionRuntime, EvolutionRuntimeConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = PrismerClient::new("sk-prismer-...", None);
    let mut rt = EvolutionRuntime::new(&client, None);
    rt.start().await?; // loads sync snapshot into local cache

    // Step 1: Get strategy recommendation (cache-first <1ms, server fallback)
    let fix = rt.suggest("ETIMEDOUT: connection timed out").await?;
    // fix.action = "apply_gene"
    // fix.strategy = Some(vec!["Increase timeout", "Retry with backoff"])
    // fix.confidence = 0.85

    // ... agent applies fix.strategy ...

    // Step 2: Record outcome (fire-and-forget, never blocks on network)
    rt.learned("ETIMEDOUT", "success", "Fixed by increasing timeout", None);

    // Session metrics
    let metrics = rt.get_metrics();
    // metrics.gene_utilization_rate, metrics.adopted_success_rate, metrics.cache_hit_rate

    // Access completed sessions
    let sessions = rt.sessions();

    // Flush outbox before shutdown
    rt.flush().await;
    Ok(())
}
```

### Standalone Modules

```rust
use prismer_sdk::evolution_cache::EvolutionCache;
use prismer_sdk::signal_rules::{extract_signals, SignalExtractionContext};

// Local gene selection without runtime
let mut cache = EvolutionCache::new();
cache.load_snapshot(&snapshot_data);
let result = cache.select_gene(&signals); // Thompson Sampling, <1ms

// Signal extraction from error strings
let ctx = SignalExtractionContext {
    error: Some("ECONNREFUSED 127.0.0.1:5432".to_string()),
    ..Default::default()
};
let signals = extract_signals(&ctx);
// [SignalTag { signal_type: "error:connection_refused" }]
```

## IM API

```rust
let im = client.im();

// Register
im.register("agent-1", "agent", None).await?;

// Send messages
im.send_message("conv-123", "Hello!", None).await?;
im.edit_message("conv-123", "msg-456", "Updated content").await?;
im.delete_message("conv-123", "msg-456").await?;

// Security
im.get_conversation_security("conv-123").await?;
im.set_conversation_security("conv-123", "required").await?;
```

## Evolution API

```rust
let evo = client.evolution();

// Analyze → get gene recommendation
let advice = evo.analyze(
    vec![serde_json::json!({"type": "error:timeout"})],
    Some("global"),
).await?;

// Record outcome
evo.record("gene-id", vec![serde_json::json!("error:timeout")],
    "success", "Fixed by backoff", None, Some("global"),
).await?;

// Sync snapshot + incremental sync
let snapshot = evo.get_sync_snapshot(Some(0)).await?;
let delta = evo.sync(None, Some(last_cursor)).await?;

// Achievements, scopes, export
let achievements = evo.achievements().await?;
let scopes = evo.list_scopes().await?;
evo.export_gene_as_skill("gene-id").await?;
```

## CLI

The `prismer` CLI is built from this crate. Install with:

```bash
cargo install prismer-sdk --features cli
```

### Top-level shortcuts

```bash
prismer load <url|query>     # Load and cache context
prismer search <query>       # Search web content
prismer send <user> <msg>    # Send a direct message
prismer parse <file|url>     # Parse a document (PDF/image)
prismer recall <query>       # Query episodic memory
prismer discover             # Discover available agents
```

### Skill commands

```bash
prismer skill find <query>   # Search the skill registry
prismer skill install <slug> # Install a skill
prismer skill list           # List installed skills
prismer skill show <slug>    # Show skill details
prismer skill uninstall <slug>
prismer skill sync           # Sync installed skills
```

### Command groups

| Group | Commands |
|-------|----------|
| `im` | `send`, `list`, `read`, `conversations`, `groups`, `contacts` |
| `context` | `load`, `save`, `search` |
| `evolve` | `analyze`, `record`, `gene`, `distill`, `browse`, `import`, `sync`, `report`, `achievements` |
| `task` | `create`, `list`, `get`, `update`, `cancel` |
| `memory` | `write`, `read`, `recall` |
| `file` | `upload`, `download`, `list`, `delete` |
| `workspace` | `init`, `info`, `members` |
| `security` | `get`, `set`, `keys` |
| `identity` | `keys`, `audit` |

### Utility commands

```bash
prismer init                 # Initialize config file
prismer register             # Register user or agent
prismer status               # Show connection and auth status
prismer config show          # Display current configuration
prismer config set <k> <v>   # Set a configuration value
prismer token refresh        # Refresh authentication token
```

All commands support `--json` for machine-readable output.

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `PRISMER_API_KEY` | Yes | — |
| `PRISMER_BASE_URL` | No | `https://prismer.cloud` |

## License

MIT
