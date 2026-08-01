# Changelog

All notable changes to Prismer Cloud are documented here. For per-package changelogs, see the individual SDK directories.

## [2.0.8] — 2026-06-10

Big catch-up sync from the closed-source tree (covers everything since 1.7.4, including the 1.9.x line). `sdk/` is now at v2.0.8.

### Added
- **Workspace surfaces**: task board (kanban), contacts panel, unified agent/profile creation flow (pro tiles, model + proxy-provider picker), workspace inspector with spreadsheet/PDF/PPTX/Word previews, session settings, mobile bottom-nav.
- **Task → Agent orchestration**: full task lifecycle (create → dispatch → progress → done/failed/cancelled) over REST + WS, with SSE task events.
- **Insights & admin**: insights cockpit, admin analytics (env-driven `ADMIN_EMAILS`/`INIT_ADMIN_EMAIL` RBAC), sandbox fleet view.
- **Built-in skills**: `sdk/prismer-cloud/built-in-skills/` runtime resource pool — auto-installed to agents at registration.
- **Asset pipeline**: blurHash instant placeholders, preview derivatives (PDF first-page via poppler/mupdf/qpdf), multi-tier delivery.

### Changed
- SDK tree restructured: the independent 0.x `adapters` / `adapters-core` / `wire` / `sandbox-runtime` surfaces were retired upstream and removed from `sdk/prismer-cloud/`.

### Security
- Redacted internal infrastructure credentials that had shipped in the v1.9.x sync; the patterns are now part of the sync content-scrub gate so they cannot recur. Treat the previously published values as compromised.

## [1.7.4] — 2026-03-28

### Added
- **AIP Identity (Layer 1-4)**: Ed25519 DID:KEY identity, DID Documents, delegation chains, verifiable credentials (`@prismer/aip-sdk`)
- **Auto-signing**: `PrismerClient({ identity: 'auto' })` derives identity from API key and auto-signs IM requests
- **Cookbook documentation**: 8 step-by-step tutorials covering Quick Start, Messaging, Evolution, Skills, Identity, File Upload, Real-Time, and Workspace
- **Cookbook integration tests**: 52 tests in `.test/cookbook/` validating all documented API capabilities
- **CI workflow**: Automated cookbook test runs on weekdays and PRs

### Changed
- SDK README updated with AIP Identity section and CLI identity commands
- Evolution `evolve()` one-shot API now preferred over separate `analyze()` + `record()` for simple use cases

### Fixed
- Version consistency across all package READMEs

## [1.7.3] — 2026-03-15

### Added
- **Skill Marketplace**: `searchSkills()`, `installSkill()`, `getSkillContent()`, `installedSkills()`, `uninstallSkill()`, `createSkill()`, `starSkill()`, `installSkillLocal()`
- **EvolutionRuntime**: High-level 2-method API (`suggest` / `learned`) replacing 7-step manual flow
- **EvolutionCache**: Local Thompson Sampling gene selection (<1ms, no network)
- **Signal enrichment**: 13 error pattern classifiers for automatic signal extraction
- **OpenClaw Channel**: IM channel + 14 agent tools for OpenClaw platform

### Changed
- MCP Server expanded from 23 to 33 tools
- Evolution API supports both `string[]` and `SignalTag[]` signal formats

## [1.7.2] — 2026-03-01

### Added
- **EvolutionRuntime** with session metrics (gene utilization rate, adoption success rate, cache hit rate)
- **Async report pipeline**: `submitReport()` / `getReportStatus()`
- **Achievements system**: `getAchievements()`
- **Sync snapshot**: `getSyncSnapshot()` for local cache bootstrap
- **Evolution scopes**: Multi-tenant gene pool isolation

## Per-Package Changelogs

| Package | Changelog |
|---------|-----------|
| TypeScript SDK | [`sdk/prismer-cloud/typescript/CHANGELOG.md`](sdk/prismer-cloud/typescript/CHANGELOG.md) |
| All SDKs (aggregated) | [`sdk/prismer-cloud/CHANGELOG.md`](sdk/prismer-cloud/CHANGELOG.md) |
