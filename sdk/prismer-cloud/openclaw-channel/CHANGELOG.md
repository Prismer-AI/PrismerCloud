## v1.8.2 (2026-04-13)

- Version bump for 1.8.2 coordinated release.

---

## v1.8.1 (2026-04-10)

### Fixed — **Documentation**
- README prerequisite added: `npm i -g openclaw` before `openclaw plugins install @prismer/openclaw-channel` (the openclaw CLI isn't assumed to be installed).
- Version bump to 1.8.1 coordinated release.

---

## v1.8.0 (2026-04-04)

### Added — **Workspace Projection Renderer**
- `renderer.ts`: Full OpenClaw workspace bootstrap renderer — converts workspace superset (strategies, personality, identity, memory, extensions) into local file tree
  - Strategies rendered as `skills/<slug>/SKILL.md` with frontmatter + body (signals, preconditions, success rate)
  - Bootstrap files: SOUL.md (personality), IDENTITY.md (DID + capabilities), MEMORY.md, AGENTS.md, USER.md
  - Per-file truncation (20KB) and total budget (150KB) to prevent workspace bloat
  - Checksum-based meta for incremental sync
- `prismer_workspace_sync` tool (15th tool): Sync full workspace from Prismer Cloud to local OpenClaw workspace directory
  - Fetches strategies, memory, personality, identity, and extensions slots
  - Writes to `~/.openclaw/workspace/` (or `workspace-<profile>` for multi-profile)
  - Supports `OPENCLAW_WORKSPACE` env var override and `OPENCLAW_PROFILE` for named profiles
- `scope` parameter added to `prismer_evolve_analyze`, `prismer_evolve_record`, `prismer_evolve_report` for data isolation across projects/teams
- Total tools: 15 (was 14 in v1.7.3)

## v1.7.4 (2026-04-01)

### Added — **Evolution Loop Enhancement**
- Evolution hints now include explicit tool call guidance: after resolving an issue, agents are prompted to call `prismer_evolve_record` and `prismer_memory_write`
- When no gene matches, agents are prompted to call `prismer_evolve_report` to teach the system
- Parity test suite: 23 integration tests (Rust baseline)

### Changed
- Version alignment with platform v1.7.4
# @prismer/openclaw-channel — Changelog

## v1.7.3 (2026-03-27)

### Added
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **prismer_evolve_distill** tool — trigger server-side pattern extraction
- **prismer_evolve_browse** tool — browse public genes with pagination
- **prismer_evolve_import** tool — import public gene to agent's collection
- **prismer_memory_write** / **prismer_memory_read** / **prismer_recall** — 3 memory tools
- **prismer_discover** / **prismer_send** — agent discovery + messaging
- Scope parameter support across all evolution tools
- Total tools: 14 (was 8 in v1.7.1)

### Changed
- `prismer_evolve_analyze` supports SignalTag[] format
- `prismer_evolve_record` accepts optional metadata
- Gateway WebSocket reconnection improved

## v1.7.1 (2026-03-07)

### Added
- Initial channel registration + gateway
- 8 tools (load, parse, evolve_analyze, evolve_record, evolve_report, gene_create, discover, send)
