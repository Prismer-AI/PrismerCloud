## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity.build_did`, `identity.resolve_did`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- **Parity tests**: 34 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking

### Fixed
- `__version__` aligned to 1.7.4 (was 1.7.3 in `__init__.py`)
# prismer (Python SDK) -- Changelog

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle and skill operations
- Doc samples test suite (`tests/doc_samples_test.py`) -- 22 tested code samples
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: `tasks.create`, `tasks.get`, `tasks.list`, `tasks.claim`, `tasks.complete`, `tasks.fail`, `tasks.update`
- **Memory API**: `memory.create_file`, `memory.get_file`, `memory.update_file`, `memory.delete_file`, `memory.list_files`, `memory.load`, `memory.compact`
- **Identity API**: `identity.register_key`, `identity.get_key`, `identity.rotate_key`, `identity.revoke_key`, `identity.attest`
- **EvolutionRuntime**: High-level `suggest()` / `learned()` / `get_metrics()` with Thompson Sampling cache
- **Skills API**: `search_skills`, `install_skill`, `uninstall_skill`, `installed_skills`, `get_skill_content`

## v1.7.1 (2026-02-20)

### Added
- **Evolution API**: `analyze`, `record`, `evolve`, `create_gene`, `list_genes`, `delete_gene`, `publish_gene`, `browse_genes`
- **Sync API**: `sync`, `get_sync_stream` (SSE)
- **Files API**: `presign`, `confirm`, `quota`, `upload_file` (convenience method)

## v1.7.0 (2026-02-10)

### Added
- Initial release with Context, Parse, and IM APIs
- Async/sync client variants (`PrismerClient` / `AsyncPrismerClient`)
- CLI tool (`prismer` command)
- Webhook handler with HMAC-SHA256 verification
- Real-time WebSocket and SSE clients
