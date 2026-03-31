# @prismer/claude-code-plugin (v1.7.4)

Prismer Evolution plugin for Claude Code (v3). Implements an **8-hook evolution architecture** that turns coding sessions into transferable knowledge — errors become learning strategies, successful fixes become shared recommendations across all agents.

## How It Works (v3 Eight-Hook Architecture)

```
┌─ SessionStart ─────────────────────────────────────────┐
│  session-start.mjs                                     │
│  1. Sync pull: trending genes + hot strategies         │
│  2. Retry queue: resend any failed session-end pushes  │
│  3. Memory pull: inject persistent memory              │
│  4. Skill sync: download cloud-installed skills        │
│  5. Pre-warm MCP server (background)                   │
└────────────────────────────────────────────────────────┘
                         │
┌─ Mid-Session ──────────┼───────────────────────────────┐
│                        ▼                               │
│  PreToolUse(Bash): pre-bash-suggest.mjs                │
│  - Stuck detection: same error signal >= 2x in journal │
│  - Only queries /analyze when stuck (not every command) │
│                                                        │
│  PreToolUse(WebFetch): pre-web-cache.mjs               │
│  - Context cache load (opt-in, disabled by default)    │
│  - Cache hit → return cached content, skip fetch       │
│                                                        │
│  PostToolUse(Bash|Edit|Write): post-bash-journal.mjs   │
│  - Writes to LOCAL session-journal.md only             │
│  - 13 signal patterns for error classification         │
│  - Tracks signal counts for stuck detection            │
│                                                        │
│  PostToolUse(WebFetch|WebSearch): post-web-save.mjs    │
│  - Silently caches web content to Prismer Cloud        │
│                                                        │
│  PostToolUseFailure: post-tool-failure.mjs             │
│  - Direct failure signal extraction to journal         │
│                                                        │
│  SubagentStart: subagent-start.mjs                     │
│  - Injects top strategies + parent signals             │
└────────────────────────────────────────────────────────┘
                         │
┌─ Session End ──────────┼───────────────────────────────┐
│                        ▼                               │
│  Stop: session-stop.mjs (primary path)                 │
│  1. Read session journal → has evolution value?        │
│  2. YES → block + inject gene adherence self-eval      │
│  3. Claude LLM reviews session with full context       │
│  4. Calls MCP: evolve_record, evolve_create_gene,      │
│     memory_write (zero extra LLM cost)                 │
│                                                        │
│  SessionEnd: session-end.mjs (fallback path)           │
│  - Async sync push for gene feedback + signals         │
│  - Retry queue for failed pushes                       │
└────────────────────────────────────────────────────────┘
```

## Quick Start

### Install from Marketplace

```bash
/plugin marketplace add Prismer-AI/PrismerCloud
/plugin install prismer@prismer
```

On first enable, Claude Code will prompt for your API key (stored securely in keychain).

### Install from Local Directory (Development)

```bash
claude --plugin-dir /path/to/sdk/prismer-cloud/claude-code-plugin
```

### Configuration

The plugin reads config from multiple sources (in priority order):

| Source | Variables |
|--------|-----------|
| Environment variables | `PRISMER_API_KEY`, `PRISMER_BASE_URL` |
| Claude Code userConfig | Prompted on plugin enable (stored in keychain) |
| `~/.prismer/config.toml` | `api_key`, `base_url` (shared with CLI) |

```bash
# Option 1: Environment variable
export PRISMER_API_KEY="sk-prismer-..."

# Option 2: Config file
cat > ~/.prismer/config.toml << 'EOF'
api_key = "sk-prismer-..."
base_url = "https://prismer.cloud"
EOF
```

### Optional Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISMER_WEB_CACHE_LOAD` | `0` | Set to `1` to enable WebFetch cache load (pre-check before fetching) |
| `PRISMER_SCOPE` | auto-detected | Override project scope (default: from package.json name or git remote) |

## Components

### 1. Hooks (8 Lifecycle Events)

Registered via `hooks/hooks.json`:

| Event | Script | Purpose |
|-------|--------|---------|
| **SessionStart** | `session-start.mjs` | Sync pull + retry queue + memory + skill sync + MCP pre-warm |
| **PreToolUse** (Bash) | `pre-bash-suggest.mjs` | Stuck detection → conditional /analyze query |
| **PreToolUse** (WebFetch) | `pre-web-cache.mjs` | Context cache load (opt-in) |
| **PostToolUse** (Bash\|Edit\|Write) | `post-bash-journal.mjs` | Local session journal with signal detection |
| **PostToolUse** (WebFetch\|WebSearch) | `post-web-save.mjs` | Silent context cache save |
| **PostToolUseFailure** | `post-tool-failure.mjs` | Failure signal extraction |
| **SubagentStart** | `subagent-start.mjs` | Strategy + signal injection to subagents |
| **Stop** | `session-stop.mjs` | Evolution value check → block + gene adherence self-eval |
| **SessionEnd** | `session-end.mjs` | Async fallback sync push + retry queue |

### 2. MCP Server (33 Tools)

Configured via `.mcp.json` — `@prismer/mcp-server` provides tools including `evolve_analyze`, `evolve_record`, `evolve_create_gene`, `evolve_publish`, `evolve_delete`, `memory_write`, `recall`, `skill_search`, `skill_sync`, and more.

### 3. Skills (5 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/prismer:evolve-analyze` | Query the evolution network for known fix strategies |
| `/prismer:evolve-create` | Create a new gene from a discovered pattern |
| `/prismer:evolve-record` | Record an outcome after applying a strategy |
| `/prismer:evolve-session-review` | Full session review with gene adherence evaluation |
| `/prismer:prismer-setup` | First-run setup guidance |

## File Structure

```
claude-code-plugin/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest (with userConfig)
│   └── marketplace.json         # Marketplace catalog
├── hooks/
│   └── hooks.json               # 8 hook entries across 7 events
├── scripts/
│   ├── session-start.mjs        # SessionStart: sync + retry + memory + skills
│   ├── pre-bash-suggest.mjs     # PreToolUse(Bash): stuck detection
│   ├── pre-web-cache.mjs        # PreToolUse(WebFetch): cache load (opt-in)
│   ├── post-bash-journal.mjs    # PostToolUse(Bash|Edit|Write): journal
│   ├── post-web-save.mjs        # PostToolUse(WebFetch|WebSearch): cache save
│   ├── post-tool-failure.mjs    # PostToolUseFailure: failure signals
│   ├── subagent-start.mjs       # SubagentStart: strategy injection
│   ├── session-stop.mjs         # Stop: block + gene adherence
│   ├── session-end.mjs          # SessionEnd: async fallback sync
│   └── lib/
│       ├── resolve-config.mjs   # Config resolution (env → userConfig → toml)
│       └── signals.mjs          # 13 shared signal patterns
├── skills/
│   ├── evolve-analyze/SKILL.md
│   ├── evolve-create/SKILL.md
│   ├── evolve-record/SKILL.md
│   ├── evolve-session-review/SKILL.md
│   └── prismer-setup/SKILL.md
├── .mcp.json                    # MCP server configuration (33 tools)
├── DESIGN.md                    # v3 architecture design document
├── CHANGELOG.md
├── LICENSE                      # MIT
├── README.md                    # This file
└── package.json
```

## Privacy & Security

**What is sent:**
- Aggregated error signals (types + counts, not raw stderr)
- Gene proposals (abstracted strategies, no project-specific paths)
- Outcome feedback (success/failure + adherence assessment)
- WebFetch/WebSearch cached content (public URLs only, fire-and-forget)

**What is NOT sent:**
- Source code or file contents
- Environment variables or secrets
- Raw error output (kept in local journal only)
- Private/localhost URLs

All data is scoped to your API key. Evolution data propagates to other agents in the same scope.

## Related

- [@prismer/sdk](https://www.npmjs.com/package/@prismer/sdk) — Prismer SDK with CLI
- [@prismer/mcp-server](https://www.npmjs.com/package/@prismer/mcp-server) — MCP Server (33 tools)
- [@prismer/opencode-plugin](https://www.npmjs.com/package/@prismer/opencode-plugin) — OpenCode equivalent
- [Prismer Cloud](https://prismer.cloud) — Knowledge Drive for AI Agents

## License

MIT
