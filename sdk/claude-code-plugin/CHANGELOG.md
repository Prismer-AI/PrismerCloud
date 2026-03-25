# Changelog

All notable changes to the Prismer Claude Code Plugin will be documented in this file.

## [1.7.2] - 2026-03-26

### Changed — **v2 Three-Stage Evolution Model**
- **SessionStart** (`session-start.mjs`): Sync pull + passive context injection + scope auto-detection + MCP pre-warm
- **PreToolUse** (`pre-bash-suggest.mjs`): Stuck detection — only queries /analyze when same error >= 2x (was: every command)
- **PostToolUse** (`post-bash-journal.mjs`): Local markdown journal only, no remote writes (was: POST /report + /record every failure)
- **Stop** (`session-stop.mjs`): Collect session context + spawn async `session-evolve.mjs` subagent
- **Async subagent** (`session-evolve.mjs`): Gene creation via POST /genes, outcome recording, sync push, local persistence

### Added
- `scripts/session-start.mjs` — SessionStart sync pull + context inject
- `scripts/post-bash-journal.mjs` — Local journal writer (replaces `post-bash-report.mjs`)
- `scripts/session-stop.mjs` — Stop hook context collector
- `scripts/session-evolve.mjs` — Async gene creation subagent (detached, 30s timeout)
- `DESIGN-V2.md` — v2 architecture design document with platform audit
- Scope auto-detection from PRISMER_SCOPE / package.json / git remote

### Deprecated
- `scripts/post-bash-report.mjs` → moved to `scripts/deprecated/` (v1 per-command remote reporter)

### Fixed (from 2026-03-25)
- Hook scripts use `CLAUDE_PLUGIN_DATA` for persistent cache
- MCP server config uses `${CLAUDE_PLUGIN_ROOT}` for correct path resolution
- `marketplace.json` owner field uses valid schema

## [1.7.0] - 2026-03-20

### Added
- Initial Claude Code plugin with PreToolUse/PostToolUse hooks
- MCP server integration via `.mcp.json` (`@prismer/mcp-server`)
- Three skills: `/evolve-analyze`, `/evolve-create`, `/evolve-record`
- Evolution feedback loop: suggest before execution, report after execution
- Signal detection from Bash command output (timeout, OOM, permission, etc.)
- Graceful degradation when `PRISMER_API_KEY` is not set
