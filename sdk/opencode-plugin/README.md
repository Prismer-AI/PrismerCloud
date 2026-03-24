# @prismer/opencode-plugin

Evolution-aware plugin for [OpenCode](https://opencode.ai). Connects every task execution to the Prismer Evolution Network, enabling cross-agent learning: strategies discovered by one agent become recommendations for all future agents.

## Features

- **Event hooks** — `tool.execute.before` (suggest), `tool.execute.after` + `session.error` (report/record)
- **Skills** — 3 slash commands for manual evolution interaction
- **Shell wrapper** — `prismer-codex` drop-in for `codex exec` with automatic evolution hooks
- **Cross-tool learning** — shares the same evolution backend as Claude Code, MCP Server, and custom agents

## Quick Start

### As an OpenCode Plugin (Recommended)

Add to `opencode.json`:

```json
{
  "plugin": ["@prismer/opencode-plugin"]
}
```

Or install via npm:

```bash
npm install -g @prismer/opencode-plugin
```

### Set API Key

```bash
export PRISMER_API_KEY="sk-prismer-..."
```

Get your API key at [prismer.cloud/dashboard](https://prismer.cloud/dashboard).

## How It Works

```
Tool about to execute
  |
  +-- [tool.execute.before]
  |     → Analyzes task for error signals
  |     → Queries evolution network for known fixes
  |     → Injects strategy as context (if confidence > 0.3)
  |
  +-- Tool executes
  |
  +-- [tool.execute.after]  OR  [session.error]
  |     → Detects errors (exit code, stderr, exception)
  |     → Reports to evolution network
  |     → Auto-records outcome if gene was suggested
  |
  +-- Next agent with same error → gets better recommendation
```

### Event Hooks (Automatic)

The plugin registers three event hooks in `src/index.ts`:

| Hook | Trigger | What it does |
|------|---------|-------------|
| `tool.execute.before` | Before any tool runs | Extracts error signals → queries `evolve_analyze` → injects strategy |
| `tool.execute.after` | After tool completes | Detects errors → calls `evolve_report` + `evolve_record` |
| `session.error` | On unhandled errors | Reports error to evolution network |

### Skills (3 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/prismer-evolve-analyze` | Manually query evolution for a specific error pattern |
| `/prismer-evolve-create` | Create a new gene from a discovered pattern |
| `/prismer-evolve-record` | Record an outcome after applying a strategy |

Install skills:

```bash
bash scripts/install-skills.sh
```

### Shell Wrapper (Alternative)

For standalone use without the plugin system:

```bash
# Instead of: codex exec "Fix the timeout bug"
prismer-codex "Fix the timeout bug"
```

This wraps `codex exec` with pre/post evolution hooks.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRISMER_API_KEY` | (required) | Your Prismer API key |
| `PRISMER_BASE_URL` | `https://prismer.cloud` | API base URL |
| `PRISMER_EVOLVE` | `on` | Set to `off` to disable evolution hooks |

## File Structure

```
sdk/opencode-plugin/
├── src/
│   ├── index.ts                 # Plugin entry: event hooks (before/after/error)
│   └── evolution-client.ts      # Evolution API client for OpenCode
├── skills/
│   ├── prismer-evolve-analyze/SKILL.md
│   ├── prismer-evolve-create/SKILL.md
│   └── prismer-evolve-record/SKILL.md
├── scripts/
│   └── install-skills.sh        # Skill installation helper
├── bin/
│   └── prismer-codex            # Shell wrapper for codex exec
├── DESIGN.md                    # Design document
├── README.md                    # This file
├── package.json                 # npm package metadata
└── tsconfig.json                # TypeScript config
```

## Cross-Tool Learning

This plugin shares the same evolution backend as:

- **@prismer/claude-code-plugin** — Claude Code hooks + MCP + skills
- **@prismer/mcp-server** — MCP Server with 23 evolution tools
- **@prismer/sdk** CLI — `prismer evolve` commands

All tools contribute to and benefit from the same global knowledge graph.

## License

MIT
