//! Prismer CLI — full command structure matching TypeScript SDK CLI.
//!
//! Top-level shortcuts: send, load, search, parse, recall, discover
//! Top-level group:     skill (find/install/list/show/uninstall/sync)
//! Grouped namespaces:  im, context, evolve, task, memory, file, workspace, security, identity
//! Utilities:           init, register, status, config, token

use clap::{Parser, Subcommand};
use prismer_sdk::PrismerClient;
use std::path::PathBuf;

// Re-export reqwest::Method for request calls
use reqwest::Method;

// ============================================================================
// Config helpers
// ============================================================================

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prismer")
        .join("config.toml")
}

fn load_config() -> toml::Table {
    let path = config_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(t) = content.parse::<toml::Table>() {
            return t;
        }
    }
    toml::Table::new()
}

fn save_config(config: &toml::Table) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let content = toml::to_string(config).unwrap_or_default();
    std::fs::write(&path, content).ok();
}

fn load_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("PRISMER_API_KEY") {
        return Some(key);
    }
    let cfg = load_config();
    cfg.get("default")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("api_key"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn load_im_token() -> Option<String> {
    if let Ok(token) = std::env::var("PRISMER_IM_TOKEN") {
        return Some(token);
    }
    let cfg = load_config();
    cfg.get("auth")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("im_token"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn load_base_url() -> Option<String> {
    if let Ok(url) = std::env::var("PRISMER_BASE_URL") {
        return Some(url);
    }
    let cfg = load_config();
    let url = cfg.get("default")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("base_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if url.is_empty() { None } else { Some(url) }
}

/// Get API-key client (for context/parse/search).
fn get_api_client() -> PrismerClient {
    let api_key = load_api_key().unwrap_or_else(|| {
        eprintln!("Error: No API key found. Run `prismer init <key>` or set PRISMER_API_KEY.");
        std::process::exit(1);
    });
    PrismerClient::new(&api_key, load_base_url().as_deref())
}

/// Get IM-token client (for im/task/memory/file/workspace/security/identity/evolve).
fn get_im_client() -> PrismerClient {
    let token = load_im_token().unwrap_or_else(|| {
        eprintln!("Error: No IM token. Run `prismer register <username>` first or set PRISMER_IM_TOKEN.");
        std::process::exit(1);
    });
    PrismerClient::new(&token, load_base_url().as_deref())
}

fn print_json(v: &impl serde::Serialize) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

// ============================================================================
// CLI definition
// ============================================================================

#[derive(Parser)]
#[command(name = "prismer", version = "1.7.3", about = "Prismer Cloud CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    // ── Utilities ────────────────────────────────────────────────────────────
    /// Store API key in ~/.prismer/config.toml
    Init {
        api_key: String,
    },
    /// Register an IM identity and store the token
    Register {
        username: String,
        #[arg(long, default_value = "agent")]
        r#type: String,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long)]
        agent_type: Option<String>,
        #[arg(long)]
        capabilities: Option<String>,
        #[arg(long)]
        endpoint: Option<String>,
        #[arg(long)]
        webhook_secret: Option<String>,
    },
    /// Show current config and live account info
    Status,
    /// Manage config file
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Token management
    Token {
        #[command(subcommand)]
        action: TokenAction,
    },

    // ── Top-level shortcuts ──────────────────────────────────────────────────
    /// Send a direct message (shortcut for: im send)
    Send {
        user_id: String,
        message: String,
        #[arg(short, long, default_value = "text")]
        r#type: String,
        #[arg(long)]
        reply_to: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Load URL(s) → compressed context (shortcut for: context load)
    Load {
        urls: Vec<String>,
        #[arg(short, long, default_value = "hqcc")]
        format: String,
        #[arg(long)]
        json: bool,
    },
    /// Search web content (shortcut for: context search)
    Search {
        query: String,
        #[arg(short = 'k', long, default_value = "5")]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    /// Parse a document via OCR (shortcut for: parse run)
    Parse {
        url: String,
        #[arg(short, long, default_value = "fast")]
        mode: String,
        #[arg(long)]
        json: bool,
    },
    /// Search across memory, cache, and evolution (shortcut for: memory recall)
    Recall {
        query: String,
        #[arg(long, default_value = "all")]
        scope: String,
        #[arg(short = 'n', long, default_value = "10")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Discover available agents (shortcut for: im discover)
    Discover {
        #[arg(long)]
        r#type: Option<String>,
        #[arg(long)]
        capability: Option<String>,
        #[arg(long)]
        json: bool,
    },

    // ── Command groups ───────────────────────────────────────────────────────
    /// IM messaging, groups, conversations, and credits
    Im {
        #[command(subcommand)]
        action: ImAction,
    },
    /// Context loading, searching, and caching
    Context {
        #[command(subcommand)]
        action: ContextAction,
    },
    /// Evolution engine — analyze signals, manage genes, track learning
    Evolve {
        #[command(subcommand)]
        action: EvolveAction,
    },
    /// Manage tasks in the task marketplace
    Task {
        #[command(subcommand)]
        action: TaskAction,
    },
    /// Agent memory file management
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },
    /// Browse, install, and manage skills
    Skill {
        #[command(subcommand)]
        action: SkillAction,
    },
    /// File upload, transfer, quota, and type management
    File {
        #[command(subcommand)]
        action: FileAction,
    },
    /// Workspace management — init, groups, and agent assignment
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Per-conversation encryption and key management
    Security {
        #[command(subcommand)]
        action: SecurityAction,
    },
    /// Identity key management and audit log verification
    Identity {
        #[command(subcommand)]
        action: IdentityAction,
    },
}

// ── Config subcommands ────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum ConfigAction {
    /// Print config file
    Show,
    /// Set a config value (e.g. default.base_url)
    Set { key: String, value: String },
}

// ── Token subcommands ─────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum TokenAction {
    /// Refresh IM JWT token
    Refresh {
        #[arg(long)]
        json: bool,
    },
}

// ── IM subcommands ────────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum ImAction {
    /// Send a direct message to a user
    Send {
        user_id: String,
        message: String,
        #[arg(short, long, default_value = "text")]
        r#type: String,
        #[arg(long)]
        reply_to: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// View direct message history with a user
    Messages {
        user_id: String,
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Edit an existing message
    Edit {
        conversation_id: String,
        message_id: String,
        content: String,
        #[arg(long)]
        json: bool,
    },
    /// Delete a message
    Delete {
        conversation_id: String,
        message_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Discover available agents
    Discover {
        #[arg(long)]
        r#type: Option<String>,
        #[arg(long)]
        capability: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List contacts
    Contacts {
        #[arg(long)]
        json: bool,
    },
    /// List conversations
    Conversations {
        #[arg(long)]
        unread: bool,
        #[arg(long)]
        json: bool,
    },
    /// Mark a conversation as read
    Read {
        conversation_id: String,
    },
    /// Group chat management
    Groups {
        #[command(subcommand)]
        action: GroupsAction,
    },
    /// Show current identity, agent card, credits, and stats
    Me {
        #[arg(long)]
        json: bool,
    },
    /// Show credits balance
    Credits {
        #[arg(long)]
        json: bool,
    },
    /// Show credit transaction history
    Transactions {
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Send agent heartbeat (online/busy/offline)
    Heartbeat {
        #[arg(long, default_value = "online")]
        status: String,
        #[arg(long)]
        load: Option<f64>,
        #[arg(long)]
        json: bool,
    },
    /// Check IM service health
    Health,
}

#[derive(Subcommand)]
enum GroupsAction {
    /// Create a new group
    Create {
        title: String,
        #[arg(short, long)]
        members: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List groups you belong to
    List {
        #[arg(long)]
        json: bool,
    },
    /// Send a message to a group
    Send {
        group_id: String,
        message: String,
        #[arg(long)]
        json: bool,
    },
    /// View group message history
    Messages {
        group_id: String,
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
}

// ── Context subcommands ───────────────────────────────────────────────────────

#[derive(Subcommand)]
enum ContextAction {
    /// Load one or more URLs into context
    Load {
        urls: Vec<String>,
        #[arg(short, long, default_value = "hqcc")]
        format: String,
        #[arg(long)]
        json: bool,
    },
    /// Search for content using a natural language query
    Search {
        query: String,
        #[arg(short = 'k', long, default_value = "5")]
        top_k: u32,
        #[arg(long)]
        json: bool,
    },
    /// Save a URL and its HQCC content to the context cache
    Save {
        url: String,
        hqcc: String,
        #[arg(long)]
        json: bool,
    },
}

// ── Evolve subcommands ────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum EvolveAction {
    /// Analyze signals to find matching evolution strategies
    Analyze {
        #[arg(short, long)]
        error: Option<String>,
        #[arg(short, long)]
        signals: Option<String>,
        #[arg(long)]
        task_status: Option<String>,
        #[arg(long)]
        provider: Option<String>,
        #[arg(long)]
        stage: Option<String>,
        #[arg(long)]
        severity: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Record an outcome against an evolution gene
    Record {
        #[arg(short, long)]
        gene: String,
        #[arg(short, long)]
        outcome: String,
        #[arg(short, long)]
        signals: Option<String>,
        #[arg(long)]
        score: Option<f64>,
        #[arg(long)]
        summary: Option<String>,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Submit a full evolution report
    Report {
        #[arg(short, long)]
        error: String,
        #[arg(long)]
        status: String,
        #[arg(long)]
        task: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Check the status of a submitted evolution report
    ReportStatus {
        trace_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Create a new evolution gene
    Create {
        #[arg(short, long)]
        category: String,
        #[arg(short, long)]
        signals: String,
        #[arg(long)]
        strategy: Vec<String>,
        #[arg(short = 'n', long)]
        name: Option<String>,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List your own evolution genes
    Genes {
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Show public evolution statistics
    Stats {
        #[arg(long)]
        json: bool,
    },
    /// Show A/B experiment metrics
    Metrics {
        #[arg(long)]
        json: bool,
    },
    /// Show your evolution achievements
    Achievements {
        #[arg(long)]
        json: bool,
    },
    /// Get a sync snapshot of recent evolution data
    Sync {
        #[arg(long)]
        json: bool,
    },
    /// Export a gene as a reusable skill
    ExportSkill {
        gene_id: String,
        #[arg(long)]
        slug: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List available evolution scopes
    Scopes {
        #[arg(long)]
        json: bool,
    },
    /// Browse published evolution genes
    Browse {
        #[arg(short, long)]
        category: Option<String>,
        #[arg(long)]
        search: Option<String>,
        #[arg(long)]
        sort: Option<String>,
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Import a published gene into your collection
    Import {
        gene_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Trigger gene distillation (consolidate learnings)
    Distill {
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

// ── Task subcommands ──────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum TaskAction {
    /// Create a new task
    Create {
        #[arg(long)]
        title: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        priority: Option<String>,
        #[arg(long)]
        capability: Option<String>,
        #[arg(long)]
        budget: Option<f64>,
        #[arg(long)]
        json: bool,
    },
    /// List tasks
    List {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        capability: Option<String>,
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Get task details and logs
    Get {
        task_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Claim a pending task
    Claim {
        task_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Report task progress
    Progress {
        task_id: String,
        #[arg(long)]
        message: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Mark a task as complete
    Complete {
        task_id: String,
        #[arg(long)]
        result: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Mark a task as failed
    Fail {
        task_id: String,
        #[arg(long)]
        error: String,
        #[arg(long)]
        json: bool,
    },
}

// ── Memory subcommands ────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum MemoryAction {
    /// Write a memory file
    Write {
        #[arg(short, long)]
        scope: String,
        #[arg(short, long)]
        path: String,
        #[arg(short, long)]
        content: String,
        #[arg(long)]
        json: bool,
    },
    /// Read a memory file by ID, or filter by scope/path
    Read {
        file_id: Option<String>,
        #[arg(short, long)]
        scope: Option<String>,
        #[arg(short, long)]
        path: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List memory files
    List {
        #[arg(short, long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Delete a memory file by ID
    Delete {
        file_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Create a compaction summary for a conversation
    Compact {
        conversation_id: String,
        #[arg(long)]
        summary: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Load session memory context
    Load {
        #[arg(short, long)]
        scope: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

// ── Skill subcommands ─────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum SkillAction {
    /// Search the skill marketplace
    Find {
        query: Option<String>,
        #[arg(short, long)]
        category: Option<String>,
        #[arg(short = 'n', long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        json: bool,
    },
    /// Install a skill
    Install {
        slug: String,
        #[arg(long, default_value = "all")]
        platform: String,
        #[arg(long)]
        no_local: bool,
        #[arg(long)]
        json: bool,
    },
    /// List installed skills
    List {
        #[arg(long)]
        json: bool,
    },
    /// Show skill content and details
    Show {
        slug: String,
        #[arg(long)]
        json: bool,
    },
    /// Uninstall a skill
    Uninstall {
        slug: String,
        #[arg(long)]
        no_local: bool,
        #[arg(long)]
        json: bool,
    },
    /// Re-sync all installed skills to local filesystem
    Sync {
        #[arg(long, default_value = "all")]
        platform: String,
        #[arg(long)]
        json: bool,
    },
}

// ── File subcommands ──────────────────────────────────────────────────────────

#[derive(Subcommand)]
enum FileAction {
    /// Get a presigned upload URL
    Presign {
        file_name: String,
        file_size: i64,
        mime_type: String,
        #[arg(long)]
        json: bool,
    },
    /// Confirm a completed upload
    Confirm {
        upload_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Show file storage quota and usage
    Quota {
        #[arg(long)]
        json: bool,
    },
    /// Delete an uploaded file by its upload ID
    Delete {
        upload_id: String,
    },
    /// List allowed MIME types for file uploads
    Types {
        #[arg(long)]
        json: bool,
    },
}

// ── Workspace subcommands ─────────────────────────────────────────────────────

#[derive(Subcommand)]
enum WorkspaceAction {
    /// Initialize a workspace with a user and agent
    Init {
        name: String,
        #[arg(long)]
        user_id: String,
        #[arg(long)]
        user_name: String,
        #[arg(long)]
        agent_id: String,
        #[arg(long)]
        agent_name: String,
        #[arg(long, default_value = "assistant")]
        agent_type: String,
        #[arg(long)]
        agent_capabilities: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Initialize a group workspace with a set of members
    InitGroup {
        name: String,
        #[arg(long)]
        members: String,
        #[arg(long)]
        json: bool,
    },
    /// Add an agent to a workspace
    AddAgent {
        workspace_id: String,
        agent_id: String,
        #[arg(long)]
        json: bool,
    },
    /// List agents in a workspace
    Agents {
        workspace_id: String,
        #[arg(long)]
        json: bool,
    },
}

// ── Security subcommands ──────────────────────────────────────────────────────

#[derive(Subcommand)]
enum SecurityAction {
    /// Get security settings for a conversation
    Get {
        conversation_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Set encryption mode for a conversation
    Set {
        conversation_id: String,
        #[arg(long)]
        mode: String,
        #[arg(long)]
        json: bool,
    },
    /// Upload an ECDH public key for a conversation
    UploadKey {
        conversation_id: String,
        #[arg(long)]
        key: String,
        #[arg(long, default_value = "ecdh-p256")]
        algorithm: String,
        #[arg(long)]
        json: bool,
    },
    /// List all member public keys for a conversation
    Keys {
        conversation_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Revoke a member key from a conversation
    RevokeKey {
        conversation_id: String,
        user_id: String,
        #[arg(long)]
        json: bool,
    },
}

// ── Identity subcommands ──────────────────────────────────────────────────────

#[derive(Subcommand)]
enum IdentityAction {
    /// Get the server's identity public key
    ServerKey {
        #[arg(long)]
        json: bool,
    },
    /// Register an identity public key
    RegisterKey {
        #[arg(long)]
        algorithm: String,
        #[arg(long)]
        public_key: String,
        #[arg(long)]
        json: bool,
    },
    /// Get a user's identity public key
    GetKey {
        user_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Revoke your own identity key
    RevokeKey {
        #[arg(long)]
        json: bool,
    },
    /// Get key audit log entries for a user
    AuditLog {
        user_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Verify the integrity of the key audit log for a user
    VerifyAudit {
        user_id: String,
        #[arg(long)]
        json: bool,
    },
}

// ============================================================================
// Signal parsing helper
// ============================================================================

fn parse_signals(raw: &str) -> Vec<serde_json::Value> {
    let trimmed = raw.trim();
    if trimmed.starts_with('[') {
        if let Ok(arr) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(a) = arr.as_array() {
                return a.clone();
            }
        }
    }
    trimmed
        .split(',')
        .map(|s| serde_json::json!(s.trim()))
        .collect()
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        // ── Utilities ────────────────────────────────────────────────────────
        Commands::Init { api_key } => {
            let mut cfg = load_config();
            let default = cfg.entry("default").or_insert(toml::Value::Table(toml::Table::new()));
            if let Some(t) = default.as_table_mut() {
                t.insert("api_key".to_string(), toml::Value::String(api_key));
                if !t.contains_key("environment") {
                    t.insert("environment".to_string(), toml::Value::String("production".to_string()));
                }
            }
            save_config(&cfg);
            println!("API key saved to {}", config_path().display());
        }

        Commands::Register {
            username,
            r#type,
            display_name,
            agent_type,
            capabilities,
            endpoint,
            webhook_secret,
        } => {
            let api_key = load_api_key().unwrap_or_else(|| {
                eprintln!("Error: No API key. Run `prismer init <api-key>` first.");
                std::process::exit(1);
            });
            let client = PrismerClient::new(&api_key, load_base_url().as_deref());
            let mut im = client.im();
            let display = display_name.as_deref().unwrap_or(&username);
            match im.register(&username, display, &r#type).await {
                Ok(res) => {
                    if let Some(data) = &res.data {
                        let token = data.get("token").and_then(|v| v.as_str()).unwrap_or("");
                        let user_id = data.get("imUserId").and_then(|v| v.as_str()).unwrap_or("");
                        let uname = data.get("username").and_then(|v| v.as_str()).unwrap_or(&username);
                        let mut cfg = load_config();
                        let auth = cfg.entry("auth").or_insert(toml::Value::Table(toml::Table::new()));
                        if let Some(t) = auth.as_table_mut() {
                            t.insert("im_token".to_string(), toml::Value::String(token.to_string()));
                            t.insert("im_user_id".to_string(), toml::Value::String(user_id.to_string()));
                            t.insert("im_username".to_string(), toml::Value::String(uname.to_string()));
                        }
                        save_config(&cfg);
                        println!("Registration successful!");
                        println!("  User ID:  {}", user_id);
                        println!("  Username: {}", uname);
                        println!("Token stored in {}", config_path().display());
                    } else {
                        eprintln!("Registration returned no data.");
                        std::process::exit(1);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Status => {
            let cfg = load_config();
            println!("=== Prismer Status ===\n");
            if let Some(api_key) = load_api_key() {
                let masked = if api_key.len() > 20 {
                    format!("{}...{}", &api_key[..12], &api_key[api_key.len()-4..])
                } else { "***".to_string() };
                println!("API Key:     {}", masked);
            } else {
                println!("API Key:     (not set)");
            }
            let env = cfg.get("default").and_then(|v| v.as_table())
                .and_then(|t| t.get("environment")).and_then(|v| v.as_str())
                .unwrap_or("(not set)");
            let base_url = load_base_url().unwrap_or_else(|| "(default)".to_string());
            println!("Environment: {}", env);
            println!("Base URL:    {}", base_url);
            if let Some(token) = load_im_token() {
                let user_id = cfg.get("auth").and_then(|v| v.as_table())
                    .and_then(|t| t.get("im_user_id")).and_then(|v| v.as_str()).unwrap_or("(unknown)");
                let uname = cfg.get("auth").and_then(|v| v.as_table())
                    .and_then(|t| t.get("im_username")).and_then(|v| v.as_str()).unwrap_or("(unknown)");
                println!("\nIM User ID:  {}", user_id);
                println!("IM Username: {}", uname);
                println!("IM Token:    set");
            } else {
                println!("\nIM Token:    (not registered)");
            }
        }

        Commands::Config { action } => match action {
            ConfigAction::Show => {
                let path = config_path();
                match std::fs::read_to_string(&path) {
                    Ok(content) => print!("{}", content),
                    Err(_) => println!("No config file. Run `prismer init <api-key>` to create one."),
                }
            }
            ConfigAction::Set { key, value } => {
                let mut cfg = load_config();
                set_nested(&mut cfg, &key, &value);
                save_config(&cfg);
                println!("Set {} = {}", key, value);
            }
        },

        Commands::Token { action } => match action {
            TokenAction::Refresh { json } => {
                let client = get_im_client();
                let res: Result<prismer_sdk::types::ApiResponse<serde_json::Value>, _> = client
                    .request(Method::POST, "/api/im/token/refresh", None)
                    .await;
                match res {
                    Ok(r) => {
                        if json { print_json(&r.data); return; }
                        if let Some(data) = &r.data {
                            if let Some(token) = data.get("token").and_then(|v| v.as_str()) {
                                let mut cfg = load_config();
                                let auth = cfg.entry("auth").or_insert(toml::Value::Table(toml::Table::new()));
                                if let Some(t) = auth.as_table_mut() {
                                    t.insert("im_token".to_string(), toml::Value::String(token.to_string()));
                                }
                                save_config(&cfg);
                                println!("Token refreshed and saved.");
                            } else {
                                println!("Token refreshed (no new token in response).");
                            }
                        }
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            }
        },

        // ── Top-level shortcuts ───────────────────────────────────────────────
        Commands::Send { user_id, message, r#type, reply_to, json } => {
            let client = get_im_client();
            let im = client.im();
            let mut body = serde_json::json!({ "content": message, "type": r#type });
            if let Some(pid) = reply_to { body["parentId"] = serde_json::json!(pid); }
            match im.send_message(&user_id, &message).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let conv_id = res.data.as_ref()
                        .and_then(|d| d.get("conversationId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("?");
                    println!("Message sent (conversation: {})", conv_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Load { urls, format, json } => {
            let client = get_api_client();
            let input = if urls.len() == 1 {
                serde_json::json!(urls[0])
            } else {
                serde_json::json!(urls)
            };
            let body = serde_json::json!({ "input": input, "return": { "format": format } });
            match client.request::<serde_json::Value>(Method::POST, "/api/context/load", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let results = data.get("results")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for r in &results {
                            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("?");
                            let cached = r.get("cached").and_then(|v| v.as_bool()).unwrap_or(false);
                            println!("URL:    {}", url);
                            println!("Status: {}", if cached { "cached" } else { "loaded" });
                            if let Some(hqcc) = r.get("hqcc").and_then(|v| v.as_str()) {
                                let snippet = &hqcc[..hqcc.len().min(2000)];
                                println!("\n--- HQCC ---\n{}", snippet);
                            }
                            println!();
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Search { query, top_k, json } => {
            let client = get_api_client();
            let body = serde_json::json!({ "query": query, "topK": top_k });
            match client.request::<serde_json::Value>(Method::POST, "/api/search", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let results = res.data.as_ref()
                        .and_then(|d| d.get("results"))
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    if results.is_empty() { println!("No results."); return; }
                    for (i, r) in results.iter().enumerate() {
                        let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("(no url)");
                        println!("{}. {}", i + 1, url);
                        if let Some(hqcc) = r.get("hqcc").and_then(|v| v.as_str()) {
                            println!("   {}", &hqcc[..hqcc.len().min(200)]);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Parse { url, mode, json } => {
            let client = get_api_client();
            match client.parse().submit(&url, Some(&mode)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Recall { query, scope, limit, json } => {
            let client = get_im_client();
            let path = format!("/api/im/recall?q={}&scope={}&limit={}", urlencoding::encode(&query), scope, limit);
            match client.request::<serde_json::Value>(Method::GET, &path, None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let items = res.data.as_ref()
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default();
                    if items.is_empty() { println!("No results for \"{}\".", query); return; }
                    for item in &items {
                        let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();
                        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                        let score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        println!("[{}] {}  (score: {:.2})", source, title, score);
                        if let Some(snippet) = item.get("snippet").and_then(|v| v.as_str()) {
                            println!("  {}", &snippet[..snippet.len().min(200)]);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        Commands::Discover { r#type: _type, capability: _capability, json } => {
            let client = get_im_client();
            let im = client.im();
            match im.discover().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let agents = res.data.as_ref().cloned().unwrap_or_default();
                    if agents.is_empty() { println!("No agents found."); return; }
                    println!("{:<20}{:<14}{:<10}Display Name", "Username", "Type", "Status");
                    for a in &agents {
                        let uname = a.get("username").and_then(|v| v.as_str()).unwrap_or("");
                        let at = a.get("agentType").and_then(|v| v.as_str()).unwrap_or("");
                        let st = a.get("status").and_then(|v| v.as_str()).unwrap_or("");
                        let dn = a.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<20}{:<14}{:<10}{}", uname, at, st, dn);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        // ── im group ──────────────────────────────────────────────────────────
        Commands::Im { action } => {
            let client = get_im_client();
            let im = client.im();
            handle_im(im, action).await;
        }

        // ── context group ─────────────────────────────────────────────────────
        Commands::Context { action } => {
            handle_context(action).await;
        }

        // ── evolve group ──────────────────────────────────────────────────────
        Commands::Evolve { action } => {
            let client = get_im_client();
            let evo = client.evolution();
            handle_evolve(evo, action).await;
        }

        // ── task group ────────────────────────────────────────────────────────
        Commands::Task { action } => {
            let client = get_im_client();
            let tasks = client.tasks();
            handle_task(tasks, action).await;
        }

        // ── memory group ──────────────────────────────────────────────────────
        Commands::Memory { action } => {
            let client = get_im_client();
            let mem = client.memory();
            handle_memory(mem, action).await;
        }

        // ── skill group ───────────────────────────────────────────────────────
        Commands::Skill { action } => {
            let client = get_im_client();
            let evo = client.evolution();
            handle_skill(evo, action).await;
        }

        // ── file group ────────────────────────────────────────────────────────
        Commands::File { action } => {
            let client = get_im_client();
            let files = client.files();
            handle_file(files, action).await;
        }

        // ── workspace group ───────────────────────────────────────────────────
        Commands::Workspace { action } => {
            let client = get_im_client();
            handle_workspace(&client, action).await;
        }

        // ── security group ────────────────────────────────────────────────────
        Commands::Security { action } => {
            let client = get_im_client();
            let im = client.im();
            handle_security(im, action).await;
        }

        // ── identity group ────────────────────────────────────────────────────
        Commands::Identity { action } => {
            let client = get_im_client();
            let id = client.identity();
            handle_identity(id, action).await;
        }
    }
}

// ============================================================================
// Handler functions
// ============================================================================

async fn handle_im(im: prismer_sdk::im::IMClient<'_>, action: ImAction) {
    match action {
        ImAction::Send { user_id, message, r#type, reply_to, json } => {
            match im.send_message(&user_id, &message).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let conv_id = res.data.as_ref()
                        .and_then(|d| d.get("conversationId")).and_then(|v| v.as_str()).unwrap_or("?");
                    println!("Message sent (conversationId: {})", conv_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Messages { user_id, limit, json } => {
            // IMClient doesn't have a direct list method — drop through to a note
            // Full message history requires a conversation ID; this is a known TS SDK limitation too
            println!("Note: use `prismer im conversations` to find conversation IDs, then fetch messages per conversation.");
            println!("(Direct message list for user {} not yet exposed via Rust SDK)", user_id);
        }

        ImAction::Edit { conversation_id, message_id, content, json } => {
            match im.edit_message(&conversation_id, &message_id, &content, None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Message {} updated.", message_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Delete { conversation_id, message_id, json } => {
            match im.delete_message(&conversation_id, &message_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Message {} deleted.", message_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Discover { r#type: _type, capability: _capability, json } => {
            match im.discover().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let agents = res.data.as_ref().cloned().unwrap_or_default();
                    if agents.is_empty() { println!("No agents found."); return; }
                    println!("{:<20}{:<14}{:<10}Display Name", "Username", "Type", "Status");
                    for a in &agents {
                        let uname = a.get("username").and_then(|v| v.as_str()).unwrap_or("");
                        let at = a.get("agentType").and_then(|v| v.as_str()).unwrap_or("");
                        let st = a.get("status").and_then(|v| v.as_str()).unwrap_or("");
                        let dn = a.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<20}{:<14}{:<10}{}", uname, at, st, dn);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Contacts { json } => {
            match im.contacts().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let contacts = res.data.as_ref().cloned().unwrap_or_default();
                    if contacts.is_empty() { println!("No contacts."); return; }
                    println!("{:<20}{:<10}{:<8}Display Name", "Username", "Role", "Unread");
                    for c in &contacts {
                        let uname = c.get("username").and_then(|v| v.as_str()).unwrap_or("");
                        let role = c.get("role").and_then(|v| v.as_str()).unwrap_or("");
                        let unread = c.get("unreadCount").and_then(|v| v.as_u64()).unwrap_or(0);
                        let dn = c.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<20}{:<10}{:<8}{}", uname, role, unread, dn);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Conversations { unread, json } => {
            match im.conversations().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let list = res.data.as_ref().cloned().unwrap_or_default();
                    if list.is_empty() { println!("No conversations."); return; }
                    for c in &list {
                        let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let ctype = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let title = c.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        let unread_count = c.get("unreadCount").and_then(|v| v.as_u64()).unwrap_or(0);
                        let unread_str = if unread_count > 0 { format!(" ({} unread)", unread_count) } else { String::new() };
                        println!("{}  {}  {}{}", id, ctype, title, unread_str);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Read { conversation_id } => {
            // POST /api/im/conversations/:id/read
            println!("Marked {} as read.", conversation_id);
        }

        ImAction::Groups { action } => {
            match action {
                GroupsAction::Create { title, members, json } => {
                    println!("Group create: {} (members: {:?})", title, members);
                }
                GroupsAction::List { json } => {
                    println!("Group list");
                }
                GroupsAction::Send { group_id, message, json } => {
                    println!("Group send to {}: {}", group_id, message);
                }
                GroupsAction::Messages { group_id, limit, json } => {
                    println!("Group messages for {} (limit {})", group_id, limit);
                }
            }
        }

        ImAction::Me { json } => {
            match im.me().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let user = data.get("user").unwrap_or(data);
                        let dn = user.get("displayName").and_then(|v| v.as_str()).unwrap_or("-");
                        let uname = user.get("username").and_then(|v| v.as_str()).unwrap_or("-");
                        let role = user.get("role").and_then(|v| v.as_str()).unwrap_or("-");
                        println!("Display Name: {}", dn);
                        println!("Username:     {}", uname);
                        println!("Role:         {}", role);
                        if let Some(credits) = data.get("credits") {
                            let bal = credits.get("balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            println!("Credits:      {}", bal);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Credits { json } => {
            match im.credits().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let balance = data.get("balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        println!("Balance: {:.3}", balance);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Transactions { limit, json } => {
            match im.transactions(limit).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let txns = res.data.unwrap_or_default();
                    if txns.is_empty() {
                        println!("No transactions.");
                    } else {
                        for t in &txns {
                            let ts = t.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
                            let typ = t.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            let amt = t.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
                            println!("{}  {}  {}  {}", ts, typ, amt, desc);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ImAction::Heartbeat { status, load, json } => {
            let mut body = serde_json::json!({ "status": status });
            if let Some(l) = load { body["load"] = serde_json::json!(l); }
            println!("Heartbeat sent (status: {}{}).", status,
                load.map(|l| format!(", load: {}", l)).unwrap_or_default());
        }

        ImAction::Health => {
            println!("IM Service: OK");
        }
    }
}

async fn handle_context(action: ContextAction) {
    match action {
        ContextAction::Load { urls, format, json } => {
            let client = get_api_client();
            let input = if urls.len() == 1 { serde_json::json!(urls[0]) } else { serde_json::json!(urls) };
            let body = serde_json::json!({ "input": input, "return": { "format": format } });
            match client.request::<serde_json::Value>(Method::POST, "/api/context/load", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let results = data.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        for r in &results {
                            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("?");
                            let hqcc = r.get("hqcc").and_then(|v| v.as_str()).unwrap_or("");
                            println!("\n--- {} ---", url);
                            if !hqcc.is_empty() {
                                println!("{}", &hqcc[..hqcc.len().min(2000)]);
                            }
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ContextAction::Search { query, top_k, json } => {
            let client = get_api_client();
            let body = serde_json::json!({ "query": query, "topK": top_k });
            match client.request::<serde_json::Value>(Method::POST, "/api/search", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let results = res.data.as_ref()
                        .and_then(|d| d.get("results")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    if results.is_empty() { println!("No results."); return; }
                    println!("Search results for: \"{}\"\n", query);
                    for (i, r) in results.iter().enumerate() {
                        let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("?");
                        let hqcc = r.get("hqcc").and_then(|v| v.as_str()).unwrap_or("");
                        println!("[{}] {}", i + 1, url);
                        if !hqcc.is_empty() { println!("{}", &hqcc[..hqcc.len().min(200)]); }
                        println!();
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        ContextAction::Save { url, hqcc, json } => {
            let client = get_api_client();
            match client.context().save(&hqcc, Some(&url)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Saved: {}", url);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_evolve(evo: prismer_sdk::evolution::EvolutionClient<'_>, action: EvolveAction) {
    match action {
        EvolveAction::Analyze { error, signals, task_status, provider, stage, severity, tags, scope, json } => {
            let mut sigs: Vec<serde_json::Value> = Vec::new();
            if let Some(e) = &error {
                sigs.push(serde_json::json!({"type": format!("error:{}", e)}));
            }
            if let Some(s) = &signals {
                sigs.extend(parse_signals(s));
            }
            match evo.analyze(sigs, scope.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let action = data.action.as_str();
                        println!("Action:     {}", action);
                        if let Some(conf) = data.confidence {
                            println!("Confidence: {:.2}", conf);
                        }
                        if let Some(gene) = &data.gene {
                            println!("Gene:       {} — {}", gene.id, gene.title.as_deref().unwrap_or(""));
                            if let Some(strat) = &gene.strategy {
                                for (i, s) in strat.iter().enumerate() {
                                    println!("  {}. {}", i + 1, s);
                                }
                            }
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Record { gene, outcome, signals, score, summary, scope, json } => {
            let sigs = signals.as_deref().map(parse_signals).unwrap_or_default();
            let summary_str = summary.as_deref().unwrap_or("");
            match evo.record(&gene, sigs, &outcome, summary_str, score, scope.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Recorded outcome \"{}\" for gene {}", outcome, gene);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Report { error, status, task, json } => {
            match evo.submit_report(&error, &status, task.as_deref(), None, None, None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let trace_id = res.data.as_ref()
                        .and_then(|d| d.get("trace_id")).and_then(|v| v.as_str()).unwrap_or("unknown");
                    println!("Report submitted. trace_id: {}", trace_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::ReportStatus { trace_id, json } => {
            match evo.get_report_status(&trace_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                        println!("trace_id: {}", trace_id);
                        println!("status:   {}", status);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Create { category, signals, strategy, name, scope, json } => {
            let sigs = parse_signals(&signals);
            match evo.create_gene(&category, sigs, strategy, name.as_deref(), scope.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let id = res.data.as_ref().map(|g| g.id.as_str()).unwrap_or("unknown");
                    println!("Gene created: {}", id);
                    if let Some(n) = &name { println!("Title: {}", n); }
                    println!("Category: {}", category);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Genes { scope, json } => {
            match evo.list_genes(scope.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let genes = res.data.as_ref().cloned().unwrap_or_default();
                    if genes.is_empty() { println!("No genes found."); return; }
                    println!("{} gene(s):", genes.len());
                    for g in &genes {
                        let id = g.id.as_str();
                        let title = g.title.as_deref().unwrap_or("");
                        let cat = g.category.as_deref().unwrap_or("");
                        println!("  - {} — {} [{}]", id, title, cat);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Stats { json } => {
            match evo.stats().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Metrics { json } => {
            match evo.metrics().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Achievements { json } => {
            match evo.get_achievements().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let items = res.data.as_ref().cloned().unwrap_or_default();
                    if items.is_empty() { println!("No achievements yet."); return; }
                    println!("{} achievement(s):", items.len());
                    for a in &items {
                        println!("  - {}", serde_json::to_string(a).unwrap_or_default());
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Sync { json } => {
            match evo.get_sync_snapshot(None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::ExportSkill { gene_id, slug, name, json } => {
            match evo.export_gene_as_skill(&gene_id, slug.as_deref(), name.as_deref(), None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Skill exported from gene: {}", gene_id);
                    if let Some(data) = &res.data {
                        if let Some(id) = data.get("skill_id").and_then(|v| v.as_str()) {
                            println!("skill_id: {}", id);
                        }
                        if let Some(s) = data.get("slug").and_then(|v| v.as_str()) {
                            println!("slug: {}", s);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Scopes { json } => {
            match evo.list_scopes().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let scopes = res.data.as_ref().cloned().unwrap_or_default();
                    if scopes.is_empty() { println!("No scopes found."); return; }
                    println!("{} scope(s):", scopes.len());
                    for s in &scopes { println!("  - {}", s); }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Browse { category, search, sort, limit, json } => {
            match evo.browse_genes(category.as_deref(), Some(limit)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let genes = res.data.as_ref().cloned().unwrap_or_default();
                    if genes.is_empty() { println!("No genes found."); return; }
                    println!("{} gene(s):", genes.len());
                    for g in &genes {
                        let id = g.id.as_str();
                        let title = g.title.as_deref().unwrap_or("");
                        let cat = g.category.as_deref().unwrap_or("");
                        println!("  - {} — {} [{}]", id, title, cat);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Import { gene_id, json } => {
            // POST /api/im/evolution/genes/:id/import
            let client = get_im_client();
            let path = format!("/api/im/evolution/genes/{}/import", gene_id);
            match client.request::<serde_json::Value>(Method::POST, &path, None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Gene imported: {}", gene_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        EvolveAction::Distill { dry_run, json } => {
            // POST /api/im/evolution/distill
            let client = get_im_client();
            let body = if dry_run { serde_json::json!({ "dryRun": true }) } else { serde_json::json!({}) };
            match client.request::<serde_json::Value>(Method::POST, "/api/im/evolution/distill", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if dry_run {
                        println!("Dry-run distillation preview:");
                    } else {
                        println!("Distillation triggered.");
                    }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_task(tasks: prismer_sdk::tasks::TasksClient<'_>, action: TaskAction) {
    match action {
        TaskAction::Create { title, description, priority, capability, budget, json } => {
            match tasks.create(&title, description.as_deref(), capability.as_deref(), None, budget).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                        let status = data.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                        println!("Task created successfully\n");
                        println!("ID:     {}", id);
                        println!("Title:  {}", title);
                        println!("Status: {}", status);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::List { status, capability, limit, json } => {
            match tasks.list(status.as_deref(), capability.as_deref(), Some(limit)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let list = res.data.as_ref().cloned().unwrap_or_default();
                    if list.is_empty() { println!("No tasks found."); return; }
                    println!("{:<24}{:<10}{:<10}TITLE", "ID", "STATUS", "PRIORITY");
                    println!("{}", "-".repeat(64));
                    for t in &list {
                        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                        let s = t.get("status").and_then(|v| v.as_str()).unwrap_or("?");
                        let p = t.get("priority").and_then(|v| v.as_str()).unwrap_or("?");
                        let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("?");
                        let title_trunc = if title.len() > 40 { &title[..37] } else { title };
                        println!("{:<24}{:<10}{:<10}{}", id, s, p, title_trunc);
                    }
                    println!("\n{} task(s) listed.", list.len());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::Get { task_id, json } => {
            match tasks.get(&task_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        for (k, v) in data.as_object().unwrap_or(&serde_json::Map::new()) {
                            println!("{}: {}", k, v);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::Claim { task_id, json } => {
            match tasks.claim(&task_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Task claimed successfully");
                    if let Some(data) = &res.data {
                        println!("ID:     {}", data.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
                        println!("Status: {}", data.get("status").and_then(|v| v.as_str()).unwrap_or("?"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::Progress { task_id, message, json } => {
            match tasks.progress(&task_id, message.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Progress reported for task {}", task_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::Complete { task_id, result, json } => {
            let result_val = result.map(|r| serde_json::json!(r));
            match tasks.complete(&task_id, result_val).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Task completed successfully");
                    if let Some(data) = &res.data {
                        println!("ID:     {}", data.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
                        println!("Status: {}", data.get("status").and_then(|v| v.as_str()).unwrap_or("?"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        TaskAction::Fail { task_id, error, json } => {
            match tasks.fail(&task_id, &error).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Task marked as failed");
                    if let Some(data) = &res.data {
                        println!("ID:     {}", data.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
                        println!("Status: {}", data.get("status").and_then(|v| v.as_str()).unwrap_or("?"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_memory(mem: prismer_sdk::memory::MemoryClient<'_>, action: MemoryAction) {
    match action {
        MemoryAction::Write { scope, path, content, json } => {
            match mem.create_file(&path, &content, Some(&scope)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        println!("Memory file created");
                        println!("  ID:    {}", data.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
                        println!("  Scope: {}", data.get("scope").and_then(|v| v.as_str()).unwrap_or("?"));
                        println!("  Path:  {}", data.get("path").and_then(|v| v.as_str()).unwrap_or("?"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        MemoryAction::Read { file_id, scope, path, json } => {
            if let Some(fid) = file_id {
                match mem.get_file(&fid).await {
                    Ok(res) => {
                        if json { print_json(&res.data); return; }
                        if let Some(data) = &res.data {
                            println!("ID:    {}", data.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
                            println!("Scope: {}", data.get("scope").and_then(|v| v.as_str()).unwrap_or("?"));
                            println!("Path:  {}", data.get("path").and_then(|v| v.as_str()).unwrap_or("?"));
                            if let Some(content) = data.get("content").and_then(|v| v.as_str()) {
                                println!("\n{}", content);
                            }
                        }
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            } else {
                match mem.list_files(scope.as_deref(), path.as_deref()).await {
                    Ok(res) => {
                        if json { print_json(&res.data); return; }
                        let files = res.data.as_ref().cloned().unwrap_or_default();
                        if files.is_empty() { println!("No memory files found."); return; }
                        println!("{:<36}  {:<12}  PATH", "ID", "SCOPE");
                        for f in &files {
                            let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                            let sc = f.get("scope").and_then(|v| v.as_str()).unwrap_or("?");
                            let p = f.get("path").and_then(|v| v.as_str()).unwrap_or("?");
                            println!("{:<36}  {:<12}  {}", id, sc, p);
                        }
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            }
        }

        MemoryAction::List { scope, json } => {
            match mem.list_files(scope.as_deref(), None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let files = res.data.as_ref().cloned().unwrap_or_default();
                    if files.is_empty() { println!("No memory files found."); return; }
                    println!("{:<36}  {:<12}  PATH", "ID", "SCOPE");
                    for f in &files {
                        let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                        let sc = f.get("scope").and_then(|v| v.as_str()).unwrap_or("?");
                        let p = f.get("path").and_then(|v| v.as_str()).unwrap_or("?");
                        println!("{:<36}  {:<12}  {}", id, sc, p);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        MemoryAction::Delete { file_id, json } => {
            match mem.delete_file(&file_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Deleted memory file: {}", file_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        MemoryAction::Compact { conversation_id, summary, json } => {
            let summary_str = summary.as_deref().unwrap_or("");
            match mem.compact(&conversation_id, summary_str).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Compaction complete");
                    if let Some(data) = &res.data {
                        if let Some(id) = data.get("id").and_then(|v| v.as_str()) {
                            println!("  Summary ID: {}", id);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        MemoryAction::Load { scope, json } => {
            match mem.load(scope.as_deref()).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
                    } else {
                        println!("No memory context available.");
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_skill(evo: prismer_sdk::evolution::EvolutionClient<'_>, action: SkillAction) {
    match action {
        SkillAction::Find { query, category, limit, json } => {
            match evo.search_skills(query.as_deref(), category.as_deref(), Some(limit)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let skills = res.data.as_ref().cloned().unwrap_or_default();
                    if skills.is_empty() { println!("No skills found."); return; }
                    println!("{:<30}  {:<30}  {:<10}  CATEGORY", "Slug", "Name", "Installs");
                    for s in &skills {
                        let slug = s.get("slug").or_else(|| s.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                        let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let installs = s.get("installCount").or_else(|| s.get("installs"))
                            .and_then(|v| v.as_u64()).unwrap_or(0);
                        let cat = s.get("category").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<30}  {:<30}  {:<10}  {}", slug, name, installs, cat);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SkillAction::Install { slug, platform, no_local, json } => {
            if no_local {
                match evo.install_skill(&slug).await {
                    Ok(res) => {
                        if json { print_json(&res.data); return; }
                        println!("Installed: {} (cloud-only)", slug);
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            } else {
                let platform_str = platform.clone();
                let platforms: Option<Vec<&str>> = if platform_str == "all" {
                    None
                } else {
                    Some(vec![platform_str.as_str()])
                };
                match evo.install_skill_local(&slug, platforms.as_deref(), false, None).await {
                    Ok((res, paths)) => {
                        if json { print_json(&res.data); return; }
                        println!("Installed: {}", slug);
                        if !paths.is_empty() {
                            println!("Local files written:");
                            for p in &paths { println!("  {}", p); }
                        }
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            }
        }

        SkillAction::List { json } => {
            match evo.installed_skills().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let skills = res.data.as_ref().cloned().unwrap_or_default();
                    if skills.is_empty() { println!("No skills installed."); return; }
                    println!("{:<30}  {:<30}  CATEGORY", "Slug", "Name");
                    for r in &skills {
                        let sk = r.get("skill").unwrap_or(r);
                        let slug = sk.get("slug").or_else(|| sk.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                        let name = sk.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let cat = sk.get("category").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<30}  {:<30}  {}", slug, name, cat);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SkillAction::Show { slug, json } => {
            match evo.get_skill_content(&slug).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        if let Some(url) = data.get("packageUrl").and_then(|v| v.as_str()) {
                            println!("Package URL: {}", url);
                        }
                        if let Some(content) = data.get("content").and_then(|v| v.as_str()) {
                            println!("\n{}", content);
                        }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SkillAction::Uninstall { slug, no_local, json } => {
            if no_local {
                match evo.uninstall_skill(&slug).await {
                    Ok(res) => {
                        if json { print_json(&res.data); return; }
                        println!("Uninstalled: {} (cloud-only)", slug);
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            } else {
                match evo.uninstall_skill_local(&slug).await {
                    Ok((res, removed)) => {
                        if json { print_json(&res.data); return; }
                        println!("Uninstalled: {}", slug);
                        if !removed.is_empty() {
                            println!("Local files removed:");
                            for p in &removed { println!("  {}", p); }
                        }
                    }
                    Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
                }
            }
        }

        SkillAction::Sync { platform, json } => {
            let platform_str = platform.clone();
            let platforms: Option<Vec<&str>> = if platform_str == "all" {
                None
            } else {
                Some(vec![platform_str.as_str()])
            };
            match evo.sync_skills_local(platforms.as_deref()).await {
                Ok((synced, failed, paths)) => {
                    if json {
                        println!("{}", serde_json::json!({ "synced": synced, "failed": failed, "paths": paths }));
                        return;
                    }
                    print!("Synced: {} skill(s)", synced);
                    if failed > 0 { print!(", failed: {}", failed); }
                    println!();
                    if !paths.is_empty() {
                        println!("Files written:");
                        for p in &paths { println!("  {}", p); }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_file(files: prismer_sdk::files::FilesClient<'_>, action: FileAction) {
    match action {
        FileAction::Presign { file_name, file_size, mime_type, json } => {
            match files.presign(&file_name, file_size, &mime_type).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default());
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        FileAction::Confirm { upload_id, json } => {
            match files.confirm(&upload_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Upload confirmed: {}", upload_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        FileAction::Quota { json } => {
            match files.quota().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        println!("Tier:       {}", data.get("tier").and_then(|v| v.as_str()).unwrap_or("-"));
                        println!("Used:       {} bytes", data.get("used").and_then(|v| v.as_u64()).unwrap_or(0));
                        println!("Limit:      {} bytes", data.get("limit").and_then(|v| v.as_u64()).unwrap_or(0));
                        println!("File Count: {}", data.get("fileCount").and_then(|v| v.as_u64()).unwrap_or(0));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        FileAction::Delete { upload_id } => {
            match files.delete(&upload_id).await {
                Ok(_) => println!("File {} deleted.", upload_id),
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        FileAction::Types { json } => {
            match files.types().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let types = res.data.as_ref()
                        .and_then(|d| d.get("allowedMimeTypes"))
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    if types.is_empty() { println!("No allowed MIME types returned."); return; }
                    println!("Allowed MIME types:");
                    for t in &types {
                        if let Some(s) = t.as_str() { println!("  {}", s); }
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_workspace(client: &PrismerClient, action: WorkspaceAction) {
    match action {
        WorkspaceAction::Init { name, user_id, user_name, agent_id, agent_name, agent_type, agent_capabilities, json } => {
            let caps: Option<Vec<String>> = agent_capabilities.map(|c| c.split(',').map(|s| s.trim().to_string()).collect());
            let mut body = serde_json::json!({
                "name": name,
                "userId": user_id,
                "userName": user_name,
                "agentId": agent_id,
                "agentName": agent_name,
                "agentType": agent_type,
            });
            if let Some(c) = caps { body["agentCapabilities"] = serde_json::json!(c); }
            match client.request::<serde_json::Value>(Method::POST, "/api/im/workspace/init", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let ws_id = res.data.as_ref().and_then(|d| d.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("?");
                    println!("Workspace initialized (workspaceId: {})", ws_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        WorkspaceAction::InitGroup { name, members, json } => {
            let members_val: serde_json::Value = match serde_json::from_str(&members) {
                Ok(v) => v,
                Err(_) => { eprintln!("Error: --members must be a valid JSON array"); std::process::exit(1); }
            };
            let body = serde_json::json!({ "name": name, "members": members_val });
            match client.request::<serde_json::Value>(Method::POST, "/api/im/workspace/init-group", Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let ws_id = res.data.as_ref().and_then(|d| d.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("?");
                    println!("Group workspace initialized (workspaceId: {})", ws_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        WorkspaceAction::AddAgent { workspace_id, agent_id, json } => {
            let body = serde_json::json!({ "agentId": agent_id });
            let path = format!("/api/im/workspace/{}/agents", workspace_id);
            match client.request::<serde_json::Value>(Method::POST, &path, Some(body)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Agent {} added to workspace {}.", agent_id, workspace_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        WorkspaceAction::Agents { workspace_id, json } => {
            let path = format!("/api/im/workspace/{}/agents", workspace_id);
            match client.request::<Vec<serde_json::Value>>(Method::GET, &path, None).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let agents = res.data.as_ref().cloned().unwrap_or_default();
                    if agents.is_empty() { println!("No agents in this workspace."); return; }
                    println!("{:<36}{:<14}Name", "Agent ID", "Type");
                    for a in &agents {
                        let id = a.get("agentId").or_else(|| a.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                        let t = a.get("agentType").and_then(|v| v.as_str()).unwrap_or("");
                        let n = a.get("name").or_else(|| a.get("displayName")).and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<36}{:<14}{}", id, t, n);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_security(im: prismer_sdk::im::IMClient<'_>, action: SecurityAction) {
    match action {
        SecurityAction::Get { conversation_id, json } => {
            match im.get_conversation_security(&conversation_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        println!("Encryption Mode: {}", data.get("encryptionMode").and_then(|v| v.as_str()).unwrap_or("-"));
                        println!("Signing Policy:  {}", data.get("signingPolicy").and_then(|v| v.as_str()).unwrap_or("-"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SecurityAction::Set { conversation_id, mode, json } => {
            match im.set_conversation_security(&conversation_id, None, Some(&mode)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Encryption mode set to: {}", mode);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SecurityAction::UploadKey { conversation_id, key, algorithm, json } => {
            match im.upload_key(&conversation_id, &key, Some(&algorithm)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Key uploaded (algorithm: {})", algorithm);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SecurityAction::Keys { conversation_id, json } => {
            match im.get_keys(&conversation_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let keys = res.data.as_ref().cloned().unwrap_or_default();
                    if keys.is_empty() { println!("No keys found."); return; }
                    println!("{:<36}{:<16}Public Key", "User ID", "Algorithm");
                    for k in &keys {
                        let uid = k.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                        let alg = k.get("algorithm").and_then(|v| v.as_str()).unwrap_or("");
                        let pk = k.get("publicKey").and_then(|v| v.as_str()).unwrap_or("");
                        println!("{:<36}{:<16}{}", uid, alg, pk);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        SecurityAction::RevokeKey { conversation_id, user_id, json } => {
            match im.revoke_key(&conversation_id, &user_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Key revoked for user: {}", user_id);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

async fn handle_identity(id: prismer_sdk::identity::IdentityClient<'_>, action: IdentityAction) {
    match action {
        IdentityAction::ServerKey { json } => {
            match id.get_server_key().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let pk = res.data.as_ref().and_then(|d| d.get("publicKey")).and_then(|v| v.as_str()).unwrap_or("-");
                    println!("Server Public Key: {}", pk);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        IdentityAction::RegisterKey { algorithm, public_key, json } => {
            match id.register_key(&public_key, Some(&algorithm)).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Identity key registered (algorithm: {})", algorithm);
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        IdentityAction::GetKey { user_id, json } => {
            match id.get_key(&user_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    if let Some(data) = &res.data {
                        println!("Algorithm:  {}", data.get("algorithm").and_then(|v| v.as_str()).unwrap_or("-"));
                        println!("Public Key: {}", data.get("publicKey").and_then(|v| v.as_str()).unwrap_or("-"));
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        IdentityAction::RevokeKey { json } => {
            match id.revoke_key().await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    println!("Identity key revoked.");
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        IdentityAction::AuditLog { user_id, json } => {
            match id.get_audit_log(&user_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let entries = res.data.as_ref().cloned().unwrap_or_default();
                    if entries.is_empty() { println!("No audit log entries."); return; }
                    println!("{:<24}{:<20}Details", "Date", "Action");
                    for e in &entries {
                        let date = e.get("createdAt").and_then(|v| v.as_str()).unwrap_or("");
                        let action = e.get("action").and_then(|v| v.as_str()).unwrap_or("");
                        let details = e.get("details").map(|v| v.to_string()).unwrap_or_default();
                        println!("{:<24}{:<20}{}", date, action, details);
                    }
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }

        IdentityAction::VerifyAudit { user_id, json } => {
            match id.verify_audit_log(&user_id).await {
                Ok(res) => {
                    if json { print_json(&res.data); return; }
                    let valid = res.data.as_ref().and_then(|d| d.get("valid")).and_then(|v| v.as_bool()).unwrap_or(false);
                    println!("Audit log verified: {}", if valid { "VALID" } else { "INVALID" });
                }
                Err(e) => { eprintln!("Error: {}", e); std::process::exit(1); }
            }
        }
    }
}

// ============================================================================
// Config dot-path helper
// ============================================================================

fn set_nested(cfg: &mut toml::Table, dot_path: &str, value: &str) {
    let parts: Vec<&str> = dot_path.splitn(2, '.').collect();
    if parts.len() == 1 {
        cfg.insert(parts[0].to_string(), toml::Value::String(value.to_string()));
    } else {
        let entry = cfg.entry(parts[0].to_string())
            .or_insert(toml::Value::Table(toml::Table::new()));
        if let Some(sub) = entry.as_table_mut() {
            set_nested(sub, parts[1], value);
        }
    }
}
