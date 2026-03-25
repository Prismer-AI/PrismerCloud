# @prismer/openclaw-channel — Changelog

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
