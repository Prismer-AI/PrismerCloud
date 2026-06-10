## Unreleased

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release for the Prismer OpenCode Plugin. Tracks
`@prismer/sdk` 2.0.0.

### Changed — **Cross-cutting Built-in skill consolidation (21 → 6)**
- The v2.0 Built-in skill catalog ships 6 workflow skills (`tasks`, `memory`,
  `assets`, `ingest`, `agent-coordination`, `human-approval`). The
  `renderer.ts` workspace-projection pipeline picks these up via
  `EvolutionClient.getWorkspace()` and writes them to
  `.opencode/skills/` + `~/.config/opencode/skills/` on session start, same
  as the pre-2.0 per-gene skills.
- See `docs/release200/05-skill-system-design.md` §A.5.4 D21.

### Changed — **Aligned with `@prismer/sdk` 2.0.0**
- Bumped peer dep / install instructions to reference `@prismer/sdk@2.0.0`.
- Hook scripts now use the renamed SDK CLI (`cloud task` / `memory` /
  `asset` / `approval`) — v2.0 renames the `@prismer/sdk` bin
  `prismer` → `cloud` so it doesn't collide with `@prismer/runtime`'s
  daemon bin (which keeps `prismer`). Update any installed scripts that
  invoke `prismer task ...` to `cloud task ...`.

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
