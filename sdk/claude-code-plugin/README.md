# @prismer/claude-code-plugin

Prismer Evolution plugin for Claude Code. Turns every coding session into evolution data points — errors become learning opportunities, successful fixes become shared strategies.

## How It Works

```
Claude Code session:
  Bash command about to run
       |
  [PreToolUse] pre-bash-suggest.mjs
       → Calls evolve_analyze → injects recommended strategy
       |
  Command executes
       |
  [PostToolUse] post-bash-report.mjs
       → Detects errors → calls evolve_report
       → Records outcome for cross-agent learning
       |
  Next similar error → instant best strategy
```

The plugin hooks into Claude Code's event system with a **full evolution loop**: suggest before execution, report after execution.

## Quick Start

### As a Claude Code Plugin (Recommended)

```bash
# Install from the plugin directory
claude plugin add /path/to/sdk/claude-code-plugin
```

Or manually: copy the plugin directory to your Claude Code plugins location.

### Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `PRISMER_API_KEY` | Yes | — |
| `PRISMER_BASE_URL` | No | `https://prismer.cloud` |

## Components

### 1. Hooks (Automatic)

The plugin registers two hooks via `hooks/hooks.json`:

- **PreToolUse** (Bash): Before any Bash command, `pre-bash-suggest.mjs` calls the evolution network to check for recommended strategies. If a high-confidence gene exists, the suggestion is injected as context for Claude Code.

- **PostToolUse** (Bash): After any Bash command, `post-bash-report.mjs` analyzes the output for errors (exit code != 0, stderr patterns) and reports them to the evolution network.

### 2. MCP Server (23 Tools)

The plugin includes `.mcp.json` which configures the `@prismer/mcp-server` with 23 tools including `evolve_analyze`, `evolve_record`, `evolve_create_gene`, `memory_write`, `recall`, `skill_search`, and more.

### 3. Skills (3 Slash Commands)

| Skill | Description |
|-------|-------------|
| `/evolve-analyze` | Manually analyze an error and get gene recommendations with scope support |
| `/evolve-create` | Create a new gene from a pattern you've discovered |
| `/evolve-record` | Record an outcome after applying a strategy |

## File Structure

```
sdk/claude-code-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest (name, version, description)
├── hooks/
│   └── hooks.json               # PreToolUse + PostToolUse hook config
├── scripts/
│   ├── pre-bash-suggest.mjs     # PreToolUse: query evolution before Bash
│   └── post-bash-report.mjs     # PostToolUse: report errors after Bash
├── skills/
│   ├── evolve-analyze/SKILL.md  # /evolve-analyze slash command
│   ├── evolve-create/SKILL.md   # /evolve-create slash command
│   └── evolve-record/SKILL.md   # /evolve-record slash command
├── .mcp.json                    # MCP server configuration (23 tools)
├── DESIGN.md                    # Design document
├── README.md                    # This file
└── package.json                 # npm package metadata
```

## What Gets Sent

- Error messages and exit codes
- Task descriptions and provider/stage metadata
- Outcome (success/failure) and confidence scores

**What is NOT sent:**

- Source code or file contents
- Environment variables or secrets

## Related

- [@prismer/sdk](https://www.npmjs.com/package/@prismer/sdk) — Prismer SDK with CLI
- [@prismer/mcp-server](https://www.npmjs.com/package/@prismer/mcp-server) — MCP Server (23 tools)
- [Prismer Cloud](https://prismer.cloud) — Knowledge Drive for AI Agents

## License

MIT
