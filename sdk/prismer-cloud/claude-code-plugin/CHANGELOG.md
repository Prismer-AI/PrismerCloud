## [1.7.4] - 2026-04-01

### Added — **Data Loop Closure**
- **Stop hook reason injection**: `buildReason()` assembles signal summary + gene feedback + MCP tool instructions into the `reason` field. Claude reads this and knows to call `evolve_record`, `evolve_report`, `memory_write`, and suggest CLAUDE.md updates.
- Stop hook now outputs `{ decision: 'block', reason: '...' }` (was `{ decision: 'block' }` only)
- Incremental journal writes via PostTool hooks prevent data loss on session crash

### Changed — **v3 Eight-Hook Architecture**
- **SessionStart**: matcher expanded to `startup|resume|clear|compact`; added retry queue, memory pull, skill sync
- **Stop**: gene adherence self-evaluation in reason; once-per-session marker + 1h cooldown
- **PostToolUse**: expanded to `Bash|Edit|Write` (was Bash only); shared `lib/signals.mjs` module
- Journal rotation respects event type: rotate on startup/clear, preserve on resume/compact
- DESIGN.md rewritten for v3 (was v2.1) — all 8 hooks, WebFetch cache, SessionEnd documented

### Added
- **PostToolUseFailure** hook (`post-tool-failure.mjs`): `Bash|Edit|Write` failure signal extraction
- **SessionEnd** hook (`session-end.mjs`): async evolution sync fallback + retry queue persistence
- **SubagentStart** hook (`subagent-start.mjs`): top strategies + parent signals injection
- **PreToolUse(WebFetch)** hook (`pre-web-cache.mjs`): context cache load (opt-in via `PRISMER_WEB_CACHE_LOAD=1`)
- **PostToolUse(WebFetch|WebSearch)** hook (`post-web-save.mjs`): silent context cache save
- `scripts/lib/signals.mjs`: shared 13 signal patterns + `ERROR_RE` + `SKIP_RE` + `countSignal()`
- `scripts/lib/resolve-config.mjs`: config auto-discovery (env → `~/.prismer/config.toml` → defaults)

### Fixed
- Permission Denied on Stop hook — root cause: journal never rotated + no block cooldown
- `session-end.mjs` now preserves `scope` field in sync-cursor.json (was being dropped)
- `pre-web-cache.mjs` URL validation aligned with `post-web-save.mjs` (`http://`/`https://` only)
- `marketplace.json` version fields removed (was hardcoded at 1.7.3; version now from plugin.json only)
- MCP pre-warm only on startup (was every session event)

# Changelog

All notable changes to the Prismer Claude Code Plugin will be documented in this file.

## [1.7.3] - 2026-03-27

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
