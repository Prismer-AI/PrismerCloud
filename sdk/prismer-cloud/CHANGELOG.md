# Prismer Cloud SDK Suite — Changelog

> Umbrella changelog covering all packages under `sdk/prismer-cloud/`.
> For per-package details, see each package's own `CHANGELOG.md`.

## v1.7.4 (2026-03-30)

### Platform

- **Leaderboard Phase 2**: Country AEI + Domain AEI + Economy Metrics + Signals Summary
- **AIP v1.0 Foundation**: DID:KEY identity, DID Document, Delegation Chains, Verifiable Credentials, Bitstring Revocation
- **Unified Credit Billing Middleware**: Evolution/Memory/Skills/Tasks auto-deduction
- **Security Fixes**: Open redirect, JWT secret dynamic getter, PBKDF2 salt per-user
- **Database**: 2 migrations (024 leaderboard, 025 AIP+E2E unified), 5 new tables, 4 extended models

### TypeScript (`@prismer/sdk`)

- AIP identity methods: `identity.buildDID`, `identity.resolveDID`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- Leaderboard data: `evolution.countryAei`, `evolution.domainAei`, `evolution.economy`, `evolution.signalsSummary`

### Python (`prismer`)

- AIP identity methods: `identity.build_did`, `identity.resolve_did`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- Leaderboard data: `evolution.country_aei`, `evolution.domain_aei`, `evolution.economy`

### Go (`prismer-sdk-go`)

- AIP identity methods: `Identity().BuildDID`, `Identity().ResolveDID`, `Identity().Delegate`, `Identity().Revoke`
- Verifiable Credentials: `Credentials().Issue`, `Credentials().Verify`, `Credentials().Present`
- Leaderboard data: `Evolution().CountryAEI`, `Evolution().DomainAEI`, `Evolution().Economy`

### Rust (`prismer-sdk`)

- AIP identity methods: `identity().build_did`, `identity().resolve_did`, `identity().delegate`, `identity().revoke`
- Verifiable Credentials: `credentials().issue`, `credentials().verify`, `credentials().present`
- Leaderboard data: `evolution().country_aei`, `evolution().domain_aei`, `evolution().economy`

### MCP Server (`@prismer/mcp-server`)

- New tools: `identity_build_did`, `identity_delegate`, `credential_issue`, `credential_verify`
- New tools: `evolution_country_aei`, `evolution_domain_aei`, `evolution_economy`
- Total tools: 33 (was 26)

### Claude Code Plugin (`@prismer/claude-code-plugin`)

- **v3 Hook Architecture**: 6 hooks (was 4)
  - NEW: `PostToolUseFailure` — Direct error capture without regex
  - NEW: `SessionEnd` — Async evolution sync fallback
  - FIX: `SessionStart` matcher covers `startup|resume|clear|compact` (was `startup` only)
  - FIX: `Stop` hook once-per-session + 1h cooldown (fixes Permission Denied)
- Shared signal module (`lib/signals.mjs`) eliminates pattern duplication
- Journal rotation respects event type: rotate on `startup/clear`, preserve on `resume/compact`

### OpenCode Plugin (`@prismer/opencode-plugin`)

- v3 hook architecture aligned with Claude Code Plugin

---

## v1.7.3 (2026-03-27)

### Platform

- **Data Governance**: qualityScore weight system, paid reporting, admin moderation, library ranking
- **Evolution Engine v0.3.1**: SignalTag + Thompson Sampling + Hypergraph + North Star Metrics

### All SDKs

- Data Governance: qualityScore wired into gene lifecycle and skill operations
- LICENSE files (MIT) added to all packages
- CHANGELOG.md created for all packages

### Claude Code Plugin

- v2 Three-Stage Evolution Model (SessionStart/PreToolUse/PostToolUse/Stop)
- Async subagent for gene creation
- Config auto-discovery (`~/.prismer/config.toml`)

---

## v1.7.2 (2026-03-15)

### All SDKs

- Tasks API, Memory API, Identity API, Skills API
- EvolutionRuntime with Thompson Sampling
- MCP Server: 26 tools (was 16)

---

## v1.7.1 (2026-03-07)

### All SDKs

- Evolution API, Sync API, Files API
- SSE real-time events

---

## v1.7.0 (2026-02-19)

### All SDKs

- Initial release: Context, Parse, IM APIs
- Offline-first (SQLiteStorage), E2E encryption, webhook handlers
- MCP Server: 16 tools
- Claude Code Plugin: v1 hooks
