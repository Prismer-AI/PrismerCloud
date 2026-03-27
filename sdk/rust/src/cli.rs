//! Prismer CLI — context, parse, IM, and evolution commands.

use clap::{Parser, Subcommand};
use prismer_sdk::PrismerClient;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "prismer", version = "1.7.2", about = "Prismer Cloud CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Initialize with API key
    Init {
        /// API key (sk-prismer-...)
        api_key: String,
    },
    /// Show configuration and account status
    Status,
    /// Context API
    Context {
        #[command(subcommand)]
        action: ContextAction,
    },
    /// Parse API
    Parse {
        #[command(subcommand)]
        action: ParseAction,
    },
    /// IM messaging
    Im {
        #[command(subcommand)]
        action: ImAction,
    },
    /// Evolution engine
    Evolve {
        #[command(subcommand)]
        action: EvolveAction,
    },
}

#[derive(Subcommand)]
enum ContextAction {
    /// Load context from URL or query
    Load {
        /// URL or search query
        input: String,
    },
}

#[derive(Subcommand)]
enum ParseAction {
    /// Parse a document
    Run {
        /// Document URL
        url: String,
        /// Parse mode
        #[arg(long, default_value = "fast")]
        mode: String,
    },
}

#[derive(Subcommand)]
enum ImAction {
    /// Show own profile
    Me,
    /// Discover agents
    Discover {
        #[arg(long)]
        capability: Option<String>,
    },
    /// Send a direct message
    Send {
        /// Target user ID
        user_id: String,
        /// Message content
        message: String,
    },
    /// List conversations
    Conversations,
    /// List contacts
    Contacts,
}

#[derive(Subcommand)]
enum EvolveAction {
    /// Analyze signals and get gene recommendation
    Analyze {
        /// Error message or signal
        #[arg(short, long)]
        error: Option<String>,
        /// Signals (comma-separated)
        #[arg(short, long)]
        signals: Option<String>,
    },
    /// Record gene execution outcome
    Record {
        /// Gene ID
        #[arg(short, long)]
        gene: String,
        /// Outcome: success or failed
        #[arg(short, long)]
        outcome: String,
        /// Summary
        #[arg(short = 'S', long, default_value = "")]
        summary: String,
    },
    /// Show evolution stats
    Stats,
    /// List own genes
    Genes,
    /// Show A/B metrics
    Metrics,
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".prismer")
        .join("config.toml")
}

fn load_api_key() -> Option<String> {
    // 1. Environment variable
    if let Ok(key) = std::env::var("PRISMER_API_KEY") {
        return Some(key);
    }
    // 2. Config file
    let path = config_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = content.parse::<toml::Table>() {
            if let Some(default) = config.get("default").and_then(|v| v.as_table()) {
                if let Some(key) = default.get("api_key").and_then(|v| v.as_str()) {
                    return Some(key.to_string());
                }
            }
        }
    }
    None
}

fn get_client() -> PrismerClient {
    let api_key = load_api_key().unwrap_or_else(|| {
        eprintln!("Error: No API key found. Run `prismer init <key>` or set PRISMER_API_KEY.");
        std::process::exit(1);
    });
    let base_url = std::env::var("PRISMER_BASE_URL").ok();
    PrismerClient::new(&api_key, base_url.as_deref())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { api_key } => {
            let path = config_path();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let content = format!("[default]\napi_key = \"{}\"\n", api_key);
            match std::fs::write(&path, content) {
                Ok(_) => println!("API key saved to {}", path.display()),
                Err(e) => eprintln!("Error saving config: {}", e),
            }
        }

        Commands::Status => {
            match load_api_key() {
                Some(key) => {
                    let masked = if key.len() > 20 {
                        format!("{}...{}", &key[..15], &key[key.len()-4..])
                    } else {
                        key.clone()
                    };
                    println!("API Key: {}", masked);
                    println!("Config:  {}", config_path().display());
                    println!("Base URL: {}", std::env::var("PRISMER_BASE_URL").unwrap_or_else(|_| "https://prismer.cloud".to_string()));
                }
                None => println!("Not configured. Run `prismer init <api-key>`."),
            }
        }

        Commands::Context { action } => {
            let client = get_client();
            match action {
                ContextAction::Load { input } => {
                    match client.context().load(&input).await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
            }
        }

        Commands::Parse { action } => {
            let client = get_client();
            match action {
                ParseAction::Run { url, mode } => {
                    match client.parse().submit(&url, Some(&mode)).await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
            }
        }

        Commands::Im { action } => {
            let client = get_client();
            let im = client.im();
            match action {
                ImAction::Me => {
                    match im.me().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                ImAction::Discover { capability: _ } => {
                    match im.discover().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                ImAction::Send { user_id, message } => {
                    match im.send_message(&user_id, &message).await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                ImAction::Conversations => {
                    match im.conversations().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                ImAction::Contacts => {
                    match im.contacts().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
            }
        }

        Commands::Evolve { action } => {
            let client = get_client();
            let evo = client.evolution();
            match action {
                EvolveAction::Analyze { error, signals } => {
                    let mut sigs: Vec<serde_json::Value> = Vec::new();
                    if let Some(e) = &error {
                        sigs.push(serde_json::json!({"type": format!("error:{}", e)}));
                    }
                    if let Some(s) = &signals {
                        for sig in s.split(',') {
                            sigs.push(serde_json::json!(sig.trim()));
                        }
                    }
                    match evo.analyze(sigs).await {
                        Ok(res) => {
                            if let Some(data) = &res.data {
                                println!("Action:     {}", data.action);
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
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                EvolveAction::Record { gene, outcome, summary } => {
                    match evo.record(&gene, vec![], &outcome, &summary, None).await {
                        Ok(_) => println!("Recorded: {} → {}", gene, outcome),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                EvolveAction::Stats => {
                    match evo.stats().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                EvolveAction::Genes => {
                    match evo.list_genes().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
                EvolveAction::Metrics => {
                    match evo.metrics().await {
                        Ok(res) => println!("{}", serde_json::to_string_pretty(&res.data).unwrap_or_default()),
                        Err(e) => eprintln!("Error: {}", e),
                    }
                }
            }
        }
    }
}
