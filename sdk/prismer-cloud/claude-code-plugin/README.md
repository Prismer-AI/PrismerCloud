# @prismer/claude-code-plugin (v1.7.8)

Prismer Evolution plugin for Claude Code (v3). Implements a **9-hook evolution architecture** that turns coding sessions into transferable knowledge — errors become learning strategies, successful fixes become shared recommendations across all agents.

## Quick Start

### Option A: Install from Marketplace (recommended)

```bash
/plugin marketplace add Prismer-AI/PrismerCloud
/plugin install prismer@prismer-cloud
```

Then run `/prismer:prismer-setup` to configure your API key (opens browser, zero copy-paste).

### Option B: MCP Tools (optional, separate)

Hooks (auto-learning, stuck detection, sync) work without MCP. To also enable active tools (`evolve_analyze`, `memory_write`, etc.):

```bash
claude mcp add prismer -- npx -y @prismer/mcp-server@1.7.8
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

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISMER_WEB_CACHE_LOAD` | `0` | Set to `1` to enable WebFetch cache load |
| `PRISMER_SCOPE` | auto-detected | Override project scope (default: from package.json or git remote) |
| `PRISMER_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## How It Works

```
┌─ SessionStart ─────────────────────────────────────────┐
│  1. Log rotate + cache cleanup (stale block files)    │
│  2. Sync pull: trending genes + hot strategies        │
│  3. Retry queue: resend failed session-end pushes     │
│  4. Memory pull: inject persistent memory + file list │
│  5. Skill sync: download cloud-installed skills       │
│  6. Pre-warm MCP server (background)                  │
│  7. Health report: [Prismer] ✓ scope:X | sync:ok     │
└────────────────────────────────────────────────────────┘
                         │
┌─ Mid-Session ──────────┼───────────────────────────────┐
│                        ▼                               │
│  PreToolUse(Bash): stuck detection                     │
│  - Same error signal ≥ 2x → query evolution network   │
│                                                        │
│  PreToolUse(WebFetch): context cache load (opt-in)     │
│                                                        │
│  PostToolUse(Bash|Edit|Write): session journal writer  │
│  - 12 signal patterns for error classification         │
│  - Signal count tracking for stuck detection           │
│                                                        │
│  PostToolUse(WebFetch|WebSearch): cache save (silent)   │
│                                                        │
│  PostToolUseFailure: direct failure signal extraction   │
│                                                        │
│  SubagentStart: inject strategies + parent signals     │
└────────────────────────────────────────────────────────┘
                         │
┌─ Session End ──────────┼───────────────────────────────┐
│                        ▼                               │
│  Stop: evolution value check → block + self-eval       │
│  - Per-scope cooldown (project A ≠ project B)          │
│  - Gene adherence feedback for Thompson Sampling       │
│                                                        │
│  SessionEnd: async fallback sync push + retry queue    │
└────────────────────────────────────────────────────────┘
```

## Components

### Hooks (9 Lifecycle Events)

| Event | Script | Purpose |
|-------|--------|---------|
| **SessionStart** | `session-start.mjs` | Sync pull + retry + memory + skills + health report |
| **PreToolUse** (Bash) | `pre-bash-suggest.mjs` | Stuck detection → conditional evolution query |
| **PreToolUse** (WebFetch) | `pre-web-cache.mjs` | Context cache load (opt-in) |
| **PostToolUse** (Bash\|Edit\|Write) | `post-bash-journal.mjs` | Local session journal + signal detection |
| **PostToolUse** (WebFetch\|WebSearch) | `post-web-save.mjs` | Silent context cache save |
| **PostToolUseFailure** | `post-tool-failure.mjs` | Failure signal extraction |
| **SubagentStart** | `subagent-start.mjs` | Strategy + signal injection to subagents |
| **Stop** | `session-stop.mjs` | Evolution value check → block + gene adherence |
| **SessionEnd** | `session-end.mjs` | Async fallback sync push + retry queue |

### Skills (7 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/prismer:prismer-setup` | First-run setup guidance + optional MCP install |
| `/prismer:evolve-analyze` | Query the evolution network for known fix strategies |
| `/prismer:evolve-create` | Create a new gene from a discovered pattern |
| `/prismer:evolve-record` | Record an outcome after applying a strategy |
| `/prismer:evolve-session-review` | Full session review with gene adherence evaluation |
| `/prismer:debug-log` | View plugin debug logs (`prismer-debug.log`) |
| `/prismer:plugin-dev` | Complete development guide for plugin contributors |

### Observability

All hooks write structured JSON logs to `{CACHE_DIR}/prismer-debug.log`:

```json
{"ts":"2026-04-02T10:30:00.000Z","lvl":"info","hook":"session-start","msg":"sync-pull-ok","genes":5,"cursor":42}
```

**Health report** on every session start:
```
[Prismer] ✓ scope:my-project | genes:5 | memory:3 files | skills:2 synced | sync:ok | 340ms
```

View logs: `/prismer:debug-log` or `tail -f .cache/prismer-debug.log`

## Development

### Local Dev Mode (no install/uninstall cycle)

```bash
cd sdk/prismer-cloud/claude-code-plugin
./scripts/dev.sh
```

This launches Claude Code with `--plugin-dir`, loading the plugin directly from disk. Edit any hook → type `/clear` → new code takes effect (2s iteration).

### Hook Isolation Testing

Test individual hooks without starting Claude Code:

```bash
# Test session-start
node scripts/test-hook.mjs session-start.mjs

# Test with custom event
node scripts/test-hook.mjs session-start.mjs --event resume

# Test post-tool hook with stdin
node scripts/test-hook.mjs post-bash-journal.mjs \
  --stdin '{"tool_name":"Bash","tool_input":{"command":"npm run build"},"tool_result":"Error: build failed"}'

# Test with custom env
node scripts/test-hook.mjs pre-bash-suggest.mjs \
  --env PRISMER_API_KEY=sk-prismer-xxx --env PRISMER_BASE_URL=http://localhost:3000
```

### Automated Tests

```bash
npx vitest run    # 81 tests (signals, hooks, graceful degradation)
npx vitest        # Watch mode
```

### Publishing Checklist

```bash
npm pack --dry-run                    # Verify package contents
node --check scripts/session-start.mjs  # Syntax check all scripts
npx vitest run                        # All 81 tests pass
npm version patch                     # Bump version
npm publish                           # Publish to npm
```

## File Structure

```
claude-code-plugin/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace catalog
├── hooks/
│   └── hooks.json               # 9 hook entries across 7 events
├── scripts/
│   ├── session-start.mjs        # SessionStart: sync + health report
│   ├── pre-bash-suggest.mjs     # PreToolUse(Bash): stuck detection
│   ├── pre-web-cache.mjs        # PreToolUse(WebFetch): cache load
│   ├── post-bash-journal.mjs    # PostToolUse: journal writer
│   ├── post-web-save.mjs        # PostToolUse: cache save
│   ├── post-tool-failure.mjs    # PostToolUseFailure: signal extraction
│   ├── subagent-start.mjs       # SubagentStart: strategy injection
│   ├── session-stop.mjs         # Stop: block + gene adherence
│   ├── session-end.mjs          # SessionEnd: async fallback sync
│   ├── dev.sh                   # Local dev mode launcher
│   ├── test-hook.mjs            # Hook isolation test tool
│   ├── setup.mjs                # Auto-setup (browser-based)
│   └── lib/
│       ├── logger.mjs           # Structured JSON logging + rotation
│       ├── resolve-config.mjs   # Config resolution chain
│       └── signals.mjs          # 12 shared signal patterns
├── skills/
│   ├── prismer-setup/           # First-run setup
│   ├── evolve-analyze/          # Query evolution network
│   ├── evolve-create/           # Create gene
│   ├── evolve-record/           # Record outcome
│   ├── evolve-session-review/   # Session review
│   ├── debug-log/               # View debug logs
│   └── plugin-dev/              # Development guide
├── templates/
│   ├── CLAUDE.md.template       # CLAUDE.md template for projects
│   ├── hooks.json               # Hook template
│   └── mcp_servers.json         # MCP config template
├── tests/
│   └── plugin.test.js           # 81 vitest tests
├── .mcp.json                    # MCP config (template only, not in npm)
├── CHANGELOG.md
├── DESIGN.md                    # v3 architecture design
├── LICENSE                      # MIT
├── README.md
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

## Troubleshooting

**Install fails with ENOENT mkdir**: Stale plugin cache. Clean and reinstall:

```bash
rm -rf ~/.claude/plugins/cache/prismer-cloud
rm -rf ~/.claude/plugins/npm-cache/node_modules/@prismer
/plugin install prismer@prismer-cloud
```

**MCP tools not available**: MCP is now installed separately. Run:

```bash
claude mcp add prismer -- npx -y @prismer/mcp-server@1.7.8
```

**Hooks not working after upgrade**: Run `/reload-plugins` or restart Claude Code.

**Debug failures**: Check logs with `/prismer:debug-log` or:

```bash
tail -50 ~/.claude/plugins/data/prismer/prismer-debug.log
```

## Related

- [@prismer/sdk](https://www.npmjs.com/package/@prismer/sdk) — Prismer SDK with CLI
- [@prismer/mcp-server](https://www.npmjs.com/package/@prismer/mcp-server) — MCP Server (33 tools)
- [@prismer/opencode-plugin](https://www.npmjs.com/package/@prismer/opencode-plugin) — OpenCode equivalent
- [Prismer Cloud](https://prismer.cloud) — Knowledge Drive for AI Agents

## License

MIT
