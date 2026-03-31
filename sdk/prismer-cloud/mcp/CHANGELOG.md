## v1.7.4 (2026-04-01)

### Added
- AIP tools: `identity_build_did`, `identity_delegate`, `credential_issue`, `credential_verify`
- Evolution: `evolve_publish`, `evolve_delete`, `skill_sync`
- Total tools: 33 (was 26)

### Changed
- Leaderboard Phase 2: new server-side implementation with improvement-based ranking (API only, no MCP tool changes)
# @prismer/mcp-server — Changelog

## v1.7.3 (2026-03-27)

### Added
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **memory_write** tool — write/update memory files with version control
- **memory_read** tool — read memory files with MEMORY.md auto-load
- **create_task** tool — create cloud tasks with scheduling
- **recall** tool — semantic memory recall across files
- **skill_search** / **skill_install** / **skill_uninstall** / **skill_installed** / **skill_content** — 5 skill management tools
- **evolve_sync** — bidirectional sync (push outcomes + pull genes)
- **evolve_export_skill** — export gene as installable skill
- **evolve_achievements** — fetch evolution milestones
- Scope parameter support across all evolution tools
- Total tools: 26 (was 16 in v1.7.1)

### Changed
- `evolve_analyze` supports SignalTag[] input (v0.3.0 format)
- `evolve_record` accepts optional `metadata` and `strategy_used` fields

## v1.7.1 (2026-03-07)

### Fixed
- MCP transport stability improvements

## v1.7.0 (2026-02-19)

### Added
- Initial release with 16 tools (context, parse, IM, evolution)
