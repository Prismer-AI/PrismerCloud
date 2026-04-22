## v1.9.0 (2026-04-22)

### Changed — **PARA Adapter Integration**

#### PARA Protocol Support
- **Runtime Detection**: Auto-detect and connect to local PARA runtime daemon
- **Event Streaming**: Stream PARA events (tool calls, results, errors) to evolution engine
- **Command Execution**: Execute commands through PARA runtime with proper marshaling
- **Capability Discovery**: Discover and register agent capabilities via PARA descriptors
- **Session Integration**: Bind OpenCode sessions to PARA runtime for enhanced observability

#### Cloud Relay Integration
- **Pairing Flow**: QR-based pairing with runtime daemon through cloud relay
- **Remote Commands**: Execute remote commands from cloud with local execution
- **Push Notifications**: Support for push-based command notifications
- **Binding Management**: Manage agent-to-runtime bindings via cloud APIs

#### Memory Gateway (Phase 1-3)
- **Enhanced Recall**: Three-layer FTS5 memory search integration
- **Context Building**: Build context from memory files for code suggestions
- **Mention Routing**: Route @mentions to relevant memory files

#### Other Changes
- Version alignment with coordinated v1.9.0 release
- Drop-in upgrade from v1.8.1
- Updated PARA wire protocol schemas to v0.1.0

---

## v1.8.1 (2026-04-10)

### Fixed — **Documentation**
- README install instruction corrected: add `"plugin": ["@prismer/opencode-plugin"]` to `opencode.json` (OpenCode has no `plugins install` subcommand).
- Version bump to 1.8.1 coordinated release.

---

## v1.8.0 (2026-04-04)

### Added — **Workspace Projection Renderer**
- `renderer.ts`: OpenCode Projection Renderer — converts workspace strategies into local SKILL.md files
  - Gene strategies rendered with frontmatter (name, description) + body (strategy steps, signals, preconditions, success stats)
  - Checksum-based incremental sync via `.prismer-meta.json` sidecar files — skips unchanged content
- `EvolutionClient.getWorkspace(scope, slots)`: New method to fetch workspace superset from `/api/im/workspace`
  - Supports slot filtering (strategies, memory, personality, identity, extensions)
  - Best-effort with timeout, never throws
- SessionStart skill sync pipeline:
  - Fetches workspace strategies on session creation
  - Dual-layer write: project-level (`.opencode/skills/`) + user-level (`~/.config/opencode/skills/`)
  - Logs sync count to console (`[Prismer] Synced N skill file(s) to OpenCode`)

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
