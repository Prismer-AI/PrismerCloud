# @prismer/opencode-plugin (v1.7.3)

Evolution-aware plugin for [OpenCode](https://opencode.ai) (v2). Implements the **three-stage evolution model**: sync pull at session start, local journal with stuck detection mid-session, and gene creation + feedback at session end.

## How It Works (v2 Three-Stage Model)

```
Session Start (event: session.created)
  ├── Sync pull: trending genes + hot strategies
  └── Inject evolution context via system.transform

Mid-Session (tool.execute.before / after)
  ├── In-memory journal tracks signal counts
  ├── Stuck detection: same error >= 2x → query /analyze
  └── NO remote writes (local journal only, reduces noise)

Session End (event: session.ended)
  ├── Record gene feedback outcomes
  ├── Report session summary for repeated errors
  └── Sync push batch outcomes
```

### Key Changes from v1

| Aspect | v1 | v2 |
|--------|----|----|
| /analyze queries | Every tool with error context | Only when stuck (same error >= 2x) |
| Error reporting | Every failure → remote /report | In-memory journal; batch at session end |
| System context | None | Passive injection of proven strategies |
| Gene feedback | Per-command | Per-session (task-level granularity) |

## Quick Start

### As an OpenCode Plugin (Recommended)

Add to `opencode.json`:

```json
{
  "plugin": ["@prismer/opencode-plugin"]
}
```

### Set API Key

```bash
export PRISMER_API_KEY="sk-prismer-..."
```

Get your API key at [prismer.cloud/dashboard](https://prismer.cloud/dashboard).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISMER_API_KEY` | (required) | Your Prismer API key |
| `PRISMER_BASE_URL` | `https://prismer.cloud` | API base URL |
| `PRISMER_SCOPE` | Auto-detected from project name | Evolution data scope |
| `PRISMER_EVOLVE` | `on` | Set to `off` to disable (shell wrapper only) |

## Components

### 1. Event Hooks (5 Lifecycle Points)

| Hook | Trigger | Purpose |
|------|---------|---------|
| `shell.env` | Before shell execution | Inject `PRISMER_API_KEY` + `PRISMER_BASE_URL` |
| `experimental.chat.system.transform` | System prompt build | Inject proven strategies as passive context |
| `tool.execute.before` | Before any tool | Stuck detection → conditional /analyze query |
| `tool.execute.after` | After tool completes | Local journal + gene feedback tracking |
| `event` (`session.created/ended`) | Session lifecycle | Sync pull on start, gene creation + feedback on end |

### 2. Session Journal (In-Memory)

During a session, the plugin tracks in memory:
- **Signal counts**: `Map<string, number>` — how many times each error type appeared
- **Gene suggestions**: which genes were recommended and when
- **Gene feedback**: success/failure outcomes for recommended genes
- **Tool entries**: all tool executions with error detection

### 3. Skills (3 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/prismer-evolve-analyze` | Query evolution for known fix strategies |
| `/prismer-evolve-create` | Create a new gene from a discovered pattern |
| `/prismer-evolve-record` | Record outcome after applying a strategy |

### 4. Shell Wrapper (Alternative)

For standalone use without the plugin system:

```bash
prismer-codex "Fix the timeout bug"
```

### 5. Evolution Harness (TypeScript API)

For programmatic integration:

```typescript
import { executeWithEvolution } from '@prismer/opencode-plugin/harness';

const outcome = await executeWithEvolution('Fix the bug', {
  execute: async (advice) => {
    // advice.strategies available if gene matched
    return { output: 'Fixed!', exitCode: 0 };
  },
});
```

## File Structure

```
sdk/opencode-plugin/
├── src/
│   ├── index.ts                 # Plugin entry: 5 hooks + session end handler
│   └── evolution-client.ts      # Evolution HTTP client (best-effort, never throws)
├── harness/
│   └── evolution-harness.ts     # TypeScript harness for batch task execution
├── skills/
│   ├── prismer-evolve-analyze/SKILL.md
│   ├── prismer-evolve-create/SKILL.md
│   └── prismer-evolve-record/SKILL.md
├── bin/
│   └── prismer-codex            # Shell wrapper for codex exec
├── tests/
│   ├── functional.test.ts       # E2E test with gene seeding
│   └── integration.test.ts      # API + hook contract tests
├── dist/                        # Built output (tsup ESM + DTS)
├── DESIGN.md                    # Design document
├── README.md                    # This file
├── package.json
├── tsconfig.json
└── LICENSE                      # MIT
```

## Build

```bash
npm install
npm run build   # tsup → dist/
```

## Cross-Tool Learning

This plugin shares the same evolution backend as:

- **@prismer/claude-code-plugin** — Claude Code hooks + MCP + skills
- **@prismer/mcp-server** — MCP Server with 26 evolution tools
- **@prismer/openclaw-channel** — OpenClaw messaging channel + 14 tools
- **@prismer/sdk** CLI — `prismer evolve` commands

All tools contribute to and benefit from the same global knowledge graph.

## License

MIT
