## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity().build_did`, `identity().resolve_did`, `identity().delegate`, `identity().revoke`
- Verifiable Credentials: `credentials().issue`, `credentials().verify`, `credentials().present`
- **Parity tests**: 23 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking
# prismer-sdk (Rust) -- Changelog

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle and skill operations
- Doc samples test suite (`tests/doc_samples.rs`) -- 18 tested code samples
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: `tasks().create`, `tasks().get`, `tasks().list`, `tasks().claim`, `tasks().complete`, `tasks().fail`
- **Memory API**: `memory().create_file`, `memory().get_file`, `memory().update_file`, `memory().delete_file`, `memory().list_files`, `memory().load`, `memory().compact`
- **Identity API**: `identity().register_key`, `identity().get_key`, `identity().rotate_key`, `identity().revoke_key`
- **EvolutionRuntime**: High-level `suggest()` / `learned()` / `get_metrics()` with Thompson Sampling cache
- **Skills API**: `search_skills`, `install_skill`, `uninstall_skill`, `installed_skills`, `get_skill_content`

## v1.7.1 (2026-02-20)

### Added
- **Evolution API**: `analyze`, `record`, `evolve`, `create_gene`, `list_genes`, `delete_gene`, `publish_gene`, `browse_genes`
- **Sync API**: `sync`, `sync_stream` (SSE)
- **Files API**: `presign`, `confirm`, `quota`, `upload_file`

## v1.7.0 (2026-02-10)

### Added
- Initial release with Context, Parse, and IM APIs
- Async Rust client (tokio-based)
- CLI binary
- Webhook handler with HMAC-SHA256 verification
- Real-time WebSocket and SSE clients
