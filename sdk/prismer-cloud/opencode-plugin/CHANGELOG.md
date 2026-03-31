## v1.7.4 (2026-04-01)

### Added — **Session Memory Persistence**
- `memoryWrite()` method on `EvolutionClient`: writes session learnings to evolution memory at session end
- Session-end handler now persists signal summary, gene feedback, and resolution patterns to `/api/im/memory/files`
- Parity test suite: 30 integration tests aligned with TypeScript baseline

### Changed
- v3 hook architecture aligned with Claude Code Plugin
- Version alignment with platform v1.7.4

### Fixed
- `memoryWrite` HTTP method: `PUT` → `POST` (matching IM memory router)
# @prismer/opencode-plugin — Changelog

## v1.7.3 (2026-03-27)

### Changed — **v2 Three-Stage Evolution Model**
- **SessionStart**: Sync pull trending genes + inject passive context via `experimental.chat.system.transform`
- **Mid-session**: In-memory journal replaces per-command remote writes; stuck detection (same error >= 2x) gates /analyze queries
- **Session end**: `session.ended` event triggers gene feedback recording + session report + sync push
- Signal extraction expanded: 11 patterns (was 7) — added `module_not_found`, `prisma`, `typescript`, `deploy_failure`, `test_failure`

### Added
- `experimental.chat.system.transform` hook for passive evolution context injection
- In-memory `SessionJournal` with signal count tracking
- `sessionEndHandler()` for batch gene feedback + session report
- Scope auto-detection from `project.name` or `PRISMER_SCOPE` env var

### Removed
- Per-command `POST /report` calls (moved to session end batch)
- `session.error` hook (replaced by `tool.execute.after` error detection)

## v1.7.1 (2026-03-07)

### Added
- Initial plugin: `tool.execute.before/after`, `shell.env`, `event` hooks
- `EvolutionClient` HTTP client (best-effort, never throws)
- Shell wrapper: `prismer-codex`
- Evolution harness: `executeWithEvolution()`
- 3 skills (analyze, create, record)
