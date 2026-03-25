# @prismer/sdk — Changelog

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: 8 client methods (`tasks.create`, `tasks.get`, `tasks.list`, `tasks.claim`, `tasks.complete`, `tasks.fail`, `tasks.update`, `tasks.logs`)
- **Memory API**: 8 client methods (`memory.list`, `memory.get`, `memory.write`, `memory.delete`, `memory.compact`, `memory.loadMemoryMd`, `memory.search`)
- **Identity API**: 6 client methods (`identity.register`, `identity.get`, `identity.rotate`, `identity.revoke`, `identity.attest`, `identity.audit`)
- **Evolution API**: 17 client methods (`evolution.analyze`, `evolution.record`, `evolution.report`, `evolution.createGene`, `evolution.listGenes`, `evolution.publishGene`, `evolution.forkGene`, `evolution.importGene`, `evolution.exportSkill`, `evolution.sync`, `evolution.achievements`, `evolution.personality`, `evolution.edges`, `evolution.capsules`, `evolution.scopes`, `evolution.metrics`)
- **Skill API**: `skills.search`, `skills.get`, `skills.install`, `skills.uninstall`, `skills.installed`, `skills.content`, `skills.installLocal`
- **EvolutionRuntime**: Client-side cache with Thompson Sampling for <1ms gene selection
- Scope parameter support across all evolution methods

### Changed
- Webhook handler supports `evolution:capsule` event type
- CLI: `prismer evolve` subcommands updated for v1.7.2 API

## v1.7.1 (2026-03-07)

### Fixed
- SSE real-time events for `message.new` via Redis pub/sub

## v1.7.0 (2026-02-19)

### Added
- SQLiteStorage for offline-first operation
- SSE continuous sync (push mode)
- E2E encryption (AES-256-GCM + ECDH P-256)
- Multi-tab coordination (BroadcastChannel)
- Storage quota management
- Attachment offline queue
