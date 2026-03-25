# @prismer/claude-code-plugin

Prismer Evolution plugin for Claude Code (v2). Implements a **three-stage evolution model** that turns coding sessions into transferable knowledge — errors become learning opportunities, successful fixes become shared strategies that persist locally and propagate across agents.

## How It Works (v2 Three-Stage Model)

```
┌─ SessionStart ─────────────────────────────────────────┐
│  session-start.mjs                                     │
│  1. Rotate session journal (clear previous)            │
│  2. Sync pull: trending genes + hot strategies         │
│  3. Inject passive context (proven patterns)           │
│  4. Pre-warm MCP server                                │
└────────────────────────────────────────────────────────┘
                         │
┌─ Mid-Session ──────────┼───────────────────────────────┐
│                        ▼                               │
│  PreToolUse: pre-bash-suggest.mjs                      │
│  - Stuck detection: same error signal >= 2x in journal │
│  - Only queries /analyze when stuck (not every command) │
│                                                        │
│  PostToolUse: post-bash-journal.mjs                    │
│  - Writes to LOCAL session-journal.md only             │
│  - Does NOT write to evolution network (reduces noise) │
│  - Tracks signal counts for stuck detection            │
└────────────────────────────────────────────────────────┘
                         │
┌─ Session End ──────────┼───────────────────────────────┐
│                        ▼                               │
│  Stop: session-stop.mjs (< 200ms, non-blocking)       │
│  1. Read session journal                               │
│  2. Check: has evolution value?                        │
│  3. Spawn async subagent (detached, fire-and-forget)   │
│                                                        │
│  Async: session-evolve.mjs (30s timeout)               │
│  - Extract repeated signals → create gene proposal     │
│  - POST /genes (rule-based abstraction)                │
│  - POST /record (feedback for suggested genes)         │
│  - POST /sync (batch push + pull cursor update)        │
│  - Write local suggestions (memory + CLAUDE.md hints)  │
└────────────────────────────────────────────────────────┘
```

### Key Changes from v1

| Aspect | v1 | v2 |
|--------|----|----|
| /analyze queries | Every bash command | Only when stuck (same error >= 2x) |
| Error reporting | Every failure → remote /report | Local journal only; batch at session end |
| Gene creation | Never (server-side /distill only) | Agent-side at session end via /genes |
| Local persistence | None | Suggestions for memory + CLAUDE.md |
| Session context | Lost after each command | Accumulated in session-journal.md |

## Quick Start

### Install from Marketplace (Recommended)

```bash
/plugin marketplace add Prismer-AI/PrismerCloud
/plugin install prismer@prismer
```

### Install from Local Directory (Development)

```bash
claude --plugin-dir /path/to/sdk/claude-code-plugin
```

### Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `PRISMER_API_KEY` | Yes | -- |
| `PRISMER_BASE_URL` | No | `https://prismer.cloud` |
| `PRISMER_SCOPE` | No | Auto-detected from package.json or git remote |

```bash
export PRISMER_API_KEY="sk-prismer-..."
```

## Components

### 1. Hooks (4 Lifecycle Events)

Registered via `hooks/hooks.json`:

| Event | Script | Purpose |
|-------|--------|---------|
| **SessionStart** | `session-start.mjs` | Sync pull + passive context inject + scope detection + MCP pre-warm |
| **PreToolUse** (Bash) | `pre-bash-suggest.mjs` | Stuck detection → conditional /analyze query |
| **PostToolUse** (Bash) | `post-bash-journal.mjs` | Local session journal (no remote writes) |
| **Stop** | `session-stop.mjs` | Collect context → spawn async `session-evolve.mjs` |

### 2. Async Subagent: session-evolve.mjs

Spawned as a detached process at session end. Runs independently after Claude Code exits:

- Extracts repeated error signals from journal
- Creates gene proposals via `POST /genes` (rule-based; LLM version planned)
- Records outcomes for any genes suggested during the session
- Pushes batch sync to evolution network
- Writes local evolution suggestions for next session

### 3. MCP Server (26 Tools)

Configured via `.mcp.json` — `@prismer/mcp-server` provides tools including `evolve_analyze`, `evolve_record`, `evolve_create_gene`, `memory_write`, `recall`, `skill_search`, and more.

### 4. Skills (3 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/prismer:evolve-analyze` | Query the evolution network for known fix strategies |
| `/prismer:evolve-create` | Create a new gene from a discovered pattern |
| `/prismer:evolve-record` | Record an outcome after applying a strategy |

## File Structure

```
sdk/claude-code-plugin/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace catalog
├── hooks/
│   └── hooks.json               # 4 events: SessionStart, PreToolUse, PostToolUse, Stop
├── scripts/
│   ├── session-start.mjs        # SessionStart: sync pull + context inject
│   ├── pre-bash-suggest.mjs     # PreToolUse: stuck detection + conditional /analyze
│   ├── post-bash-journal.mjs    # PostToolUse: local journal writer
│   ├── session-stop.mjs         # Stop: collect context + spawn subagent
│   ├── session-evolve.mjs       # Async: gene creation + feedback + sync + local persistence
│   └── deprecated/
│       └── post-bash-report.mjs # v1 PostToolUse (kept for reference)
├── skills/
│   ├── evolve-analyze/SKILL.md
│   ├── evolve-create/SKILL.md
│   └── evolve-record/SKILL.md
├── .mcp.json                    # MCP server configuration (26 tools)
├── DESIGN-V2.md                 # v2 architecture design document
├── DESIGN.md                    # v1 design (historical)
├── CHANGELOG.md
├── LICENSE                      # MIT
├── README.md                    # This file
└── package.json
```

## Session Journal Format

During a session, `post-bash-journal.mjs` writes a local markdown journal:

```markdown
# Session Journal

Started: 2026-03-26T10:00:00Z

- bash: `npm run build` (10:01)
  - signal:error:typescript (count: 1, at: 10:01)
- bash: `vim src/fix.ts` (10:02)
- bash: `npm run build` (10:03)
  - signal:error:typescript (count: 2, at: 10:03)
- bash: `npx prisma generate` (10:04)
- bash: `npm run build` (10:05)
  - gene_feedback: "Prisma Generate Before Build" outcome=success
```

## Privacy & Security

**What is sent (at session end only):**
- Aggregated error signals (types + counts, not raw stderr)
- Gene proposals (abstracted strategies, no project-specific paths)
- Outcome feedback (success/failure + score)

**What is NOT sent:**
- Source code or file contents
- Environment variables or secrets
- Raw error output (kept in local journal only)
- Mid-session command-by-command data

All data is scoped to your API key. Evolution data propagates to other agents in the same scope.

## Related

- [@prismer/sdk](https://www.npmjs.com/package/@prismer/sdk) — Prismer SDK with CLI
- [@prismer/mcp-server](https://www.npmjs.com/package/@prismer/mcp-server) — MCP Server (26 tools)
- [@prismer/opencode-plugin](https://www.npmjs.com/package/@prismer/opencode-plugin) — OpenCode equivalent
- [Prismer Cloud](https://prismer.cloud) — Knowledge Drive for AI Agents

## License

MIT
