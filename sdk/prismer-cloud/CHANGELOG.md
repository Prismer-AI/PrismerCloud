# Prismer Cloud SDK Suite — Changelog

> Umbrella changelog covering all packages under `sdk/prismer-cloud/`.
> For per-package details, see each package's own `CHANGELOG.md`.

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release. All 11 packages bumped to 2.0.0 from `/VERSION`
as the single source of truth (`sdk/build/version.sh`).

### Cross-cutting — **Built-in skill consolidation: 21 → 6 workflow skills**

- The v2.0 Built-in skill catalog (`sdk/prismer-cloud/built-in-skills/<slug>/SKILL.md`)
  ships **6 workflow-grained skills** instead of the 21 fine-grained
  prompt-only skills first scoped during M0. Each workflow skill delegates
  execution to `cloud <verb>` SDK CLI calls (Bash spawn), so any adapter
  with shell-exec capability runs them — no MCP tool dispatch loop required.
- Final 6 skills: **`tasks`**, **`memory`**, **`assets`**, **`ingest`**,
  **`agent-coordination`**, **`human-approval`**. Pattern aligns with
  agentskills.io spec and Anthropic's own `skills/pdf|docx|xlsx`-style
  workflow grain.
- Root cause for the rewrite: the 21-skill cut surfaced as a Kanban task
  scheduling regression where adapter agents read prompt-only skills, had
  no real executor, and hallucinated task IDs like `t_43724b61`. The 6-skill
  cut fixes this by binding each skill to a real SDK CLI verb.
- See `docs/release200/05-skill-system-design.md` §A.5.4 D21 for the full
  decision record.

### Cross-cutting — **`prismer` / `cloud` bin split**

- `@prismer/runtime` keeps `bin: { prismer }` (daemon ops, retains its v1.x
  identity — daemon priority is higher than SDK, so the daemon claims the
  canonical `prismer` name). Used for `adapter` / `pair` / `daemon` /
  `setup` / `profile` / `reset` / `status` / `agent` daemon ops.
- `@prismer/sdk` renamed `bin: { cloud }` (agent + user-facing daily CLI:
  `task` / `memory` / `asset` / `load` / `parse` / `discover` / `send` /
  `approval` / `recall` ...).
- Fixes the v1.x sandbox-image bug where post-install of `@prismer/runtime`
  silently overwrote `@prismer/sdk`'s `prismer` symlink, making
  `prismer task complete` (then the SDK's verb) unavailable inside containers.
  Post-rename, the two bins co-exist independently.
- See `docs/release200/02-v20-daemon-runtime-plan.md` §CLI 边界更新 for the
  full migration note.

### Per-package highlights (see each package CHANGELOG for detail)

#### TypeScript (`@prismer/sdk`)

- New `cloud asset *` subcommand group (7 verbs: `list` / `get` /
  `by-hash` / `upload` / `download` / `read` / `sync`) with HTTP Range
  support for partial reads.
- New `cloud approval request-human` subcommand backing the
  `human-approval` Built-in skill.
- `cloud task create` gained 9 new flags: `--priority`, `--assignee-id`,
  `--assignee-name`, `--conversation-id`, `--kind <work_item|goal>`,
  `--schedule-at`, `--schedule-cron`, `--reward` (alias for `--budget`) +
  username/display-name resolver.
- `cloud task update` gained `--progress`, `--status-message`.
- `cloud memory write` gained `--type`, `--description`; new
  `memory extract`, `memory consolidate` subcommands.
- `cloud recall` shortcut gained `--strategy` (keyword|llm|hybrid) and
  `--layer` (alias for `--scope`).
- `cloud send` / `discover` / `im conversations` gained
  `--conversation-id` / `--asset-id` / `--by-username` / `--members` /
  `--online-only` flags.
- Type extensions: `IMDiscoverOptions` (status/onlineOnly/q/limit/offset),
  `IMCreateMemoryFileOptions` (memoryType/description); `ContactsClient.discover()`
  forwards the new params.

#### Runtime (`@prismer/runtime`)

- **Binary unchanged: keeps `prismer`** (daemon priority decision; user-directed
  2026-05-19). The SDK's user-facing CLI was the one renamed to `cloud`. Help
  text + error prefixes + `setup` / `pair` / `daemon` references remain
  `prismer`.
- VERSION literal in `cli/index.ts` synced to 2.0.0.
- `SkillLoader` + dispatch-time skill sync + cloud `/skills/ack` round-trip
  (shipped in earlier 1.9.x cuts) remain the v2.0 Skill Gate foundation —
  Hermes + OpenClaw adapters carry real Built-in payloads at dispatch time;
  Codex + claude-code adapters are skill-sync no-ops in 2.0.

#### MCP (`@prismer/mcp-server`)

- Aligned with v2.0 SDK at the wire level; 47-tool surface intact.
- §31 namespace realignment (`<verb>_<resource>` → `prismer.<resource>.<verb>`)
  promoted from "Unreleased" to 2.0.0.

#### Python (`prismer`)

- Coordinated 2.0.0 release tracking the cross-cutting Built-in skill
  consolidation + bin split. Pre-2.0 "Unreleased" content (memory-curation
  skill, v1.8.2 reactions wire alignment) promoted into 2.0.0.

#### Go (`prismer-sdk-go`)

- Coordinated 2.0.0 release. Pre-2.0 "Unreleased" content (v1.8.2 reactions
  wire alignment, `MessageType` / `ArtifactType` constants) promoted into 2.0.0.

#### Rust (`prismer-sdk`)

- Coordinated 2.0.0 release. `prismer --version` now reads from `Cargo.toml`
  at build time (was hardcoded). Pre-2.0 "Unreleased" content (v1.8.2
  reactions wire alignment, message-type constants) promoted into 2.0.0.

#### Claude Code Plugin (`@prismer/claude-code-plugin`)

- Coordinated 2.0.0 release tracking the SDK. `1.8.2.1` `.mcp.json` pin fix
  + "Unreleased" memory-curation skill copy promoted into 2.0.0.

#### OpenCode Plugin (`@prismer/opencode-plugin`)

- Coordinated 2.0.0 release tracking the SDK.

#### OpenClaw Channel (`@prismer/openclaw-channel`)

- Coordinated 2.0.0 release tracking the SDK. "Unreleased" always-on
  memory-curation skill emission promoted into 2.0.0.

#### AIP TypeScript (`@prismer/aip-sdk`)

- Version-only bump to 2.0.0 per the suite version policy. No AIP API
  changes this cycle.

---

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
