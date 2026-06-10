# Changelog — @prismer/runtime

## Unreleased

### Fixed

- **Upstream LLM failures no longer surface as fake-successful tasks**
  (release202/12, D1+D2). Hermes serializes an exhausted LLM call
  (`API call failed after N retries: …`) into `assistant.completed` content;
  the sessions SSE consumer now detects that signature (anchored, requires zero
  streamed deltas to avoid false-positives) and sets `SessionsSseResult.upstreamError`.
  `sessions-dispatcher` turns it into a FAILED `AdapterResult`
  (`code:'upstream_llm_error'`, carrying the HTTP status) instead of `ok:true`
  with the error string as output. The daemon retry loop (`dispatch.ts`) adds
  `isPermanentUpstreamError` so permanent causes skip the 3× retry and surface
  the real reason instead of `daemon_local_retry_exhausted`. Detection +
  classification key on the hermes message WORDING — `has no usable upstream
  source` (provider chain unconfigured), `Billing or credits exhausted:` (HTTP
  402 from the cloud balance gate), `HTTP <4xx>` — because hermes'
  `_summarize_provider_error` DROPS the JSON `error.type`, so a machine token
  can't be matched. Mirrored to the `/v1/runs` dispatcher so the flag-gated path
  can't reintroduce the bug. Pairs with the cloud-side
  `503 provider_chain_unconfigured` (release202/07 §5b) so a provider-chain
  misconfig reads as a clear failed task end-to-end.

### Added

- **`mode:'message-attach'` for `POST /local/deliver`** (release202/09 P5#3, 动作
  A2). Appends a freshly-uploaded asset to an ALREADY-SENT message. Body adds
  `messageId` (and requires `conversationId`); the daemon uploads with its own
  credential (same `deliverFile` upload path + agent-output-policy +
  magic-bytes as the other modes) then POSTs the resulting `assetId` to the
  cloud conversation-scoped attach route
  `POST /api/im/messages/:conversationId/:messageId/attach` (X-IM-Agent stamped
  so the cloud sender-check resolves the same agent that authored the message).
  Unlike `mode:'send'` it does not start a new message; unlike `mode:'attach'`
  it does not ride the reply. Wired from the in-container `cloud attach` SDK
  command. Complements `mode:'attach'` (reply does not exist yet) — A2 is for a
  reply that already exists.
- **`mode:'task-attach'` for `POST /local/deliver`** (release202/09 P5#2, 动作
  ③). The daemon uploads the file as a **task-bound** asset (`deliverFile`
  already stamps `sourceTaskId = taskId`), which the cloud `POST /assets`
  handler auto-rolls onto the kanban task card
  (`appendOutputAssetIdToTask` + `reemitTerminalDigestForAssetArrival`) plus the
  asset library. Unlike `mode:'attach'` it does **not** call
  `recordDeliveredAsset` (a kanban task may run without a chat reply — its
  products belong on the card, not a turn reply) and unlike `mode:'send'` it
  posts no message. No new cloud HTTP call is needed: the existing
  `sourceTaskId`-driven rollup is the kanban + library landing. Wired from the
  in-container `cloud task attach` SDK command.
- **Explicit agent-driven file delivery** (release202/09 P2). New daemon
  local-server route `POST /local/deliver` (`local-server.ts` `onDeliver` +
  `daemon/asset/deliver.ts` `attachDeliver`): the in-container agent's
  `cloud deliver` / `cloud file send` proxy here so the daemon (which holds a
  usable IM credential the agent lacks) performs the upload + delivery. Body
  `{ taskId, path, mode:'attach'|'send', conversationId?, agentUsername? }`.
  `mode:'attach'` (动作 A) records the assetId onto `ArtifactsWatcher`'s
  existing `pendingByTask` so dispatch-end `flushPending` rides it on
  `reply.assetIds`; `mode:'send'` (动作 B) posts a standalone message with the
  asset attachment, stamped as the agent (`X-IM-Agent`). New public
  `ArtifactsWatcher.recordDeliveredAsset(taskId, assetId)` +
  `ArtifactsWatcher.deliverFile(...)`. `PRISMER_CONVERSATION_ID` is now
  injected into the agent env for 动作 B targeting.

### Changed

- **ArtifactsWatcher directory auto-scan is now flag-gated OFF by default**
  (release202/09 P2). New `ArtifactsWatcherOptions.autoScan` (default
  **false**): when off, the polling scan / `scanNow()` are no-ops (no implicit
  directory-magic), but `pendingByTask` / `flushPending` /
  `recordDeliveredAsset` / `upload` all still work. The legacy scan code is
  retained behind the flag and re-enablable via `PRISMER_ARTIFACTS_AUTOSCAN=1`.
  File delivery is now EXPLICIT (`cloud deliver` / `cloud file send`).

- **Hermes one-shot task-run dispatch via `/v1/runs`** (release202/08 Phase 1,
  flag-gated **default OFF**). New `HERMES_TASK_RUNS_DISPATCH` env flag. When ON
  and a dispatch is classified as a one-shot **run** (execution context
  `task-run` AND no triggering chat sender — pure kanban / scheduled fire /
  programmatic orchestration), the hermes adapter routes through the new
  `runs-dispatcher.ts` (`POST /v1/runs` → 202 + run_id, then `GET
  /v1/runs/{id}/events` SSE) instead of the stateful Sessions API. The run is
  **stateless** — no hermes session, no `local_run_sessions` mapping; its input
  is the bare task prompt (+ inline asset blocks) and `system_prompt` embeds a
  standalone `<execution_context type="task-run">` block (no SEED/THIN
  envelope, no participants/current_turn_sender). Multimodal image_url parts and
  the `/events` SSE parser (`consumeSessionsSse`) are reused verbatim. Chat
  turns (group/dm with a triggering sender) keep going through
  `dispatchViaSessions` unchanged. With the flag OFF the router is inert —
  `deriveDispatchKind` returns `'turn'` unconditionally, so 100% of traffic
  stays on Sessions (release201/25 §16.4 A3 behaviour, byte-for-byte).
  `adapters/hermes/{flag.ts,runs-dispatcher.ts,index.ts}`,
  `daemon/conversation-context.ts` (`renderExecutionContextXml`).

- **Role templates declare `taskDispatchScope`** (release202/08 §3.2 P3 —
  config-driven, role-agnostic task-dispatch permission). A role's template /
  agent-profile `config.taskDispatchScope` (`'any' | 'agents' | 'self' |
  'none'`) is the middle layer of cloud's three-layer dispatch resolver
  (`workspace.metadata.dispatchPolicy` > role/profile config >
  `DEFAULT_DISPATCH_POLICY`), so a NEW role gets its dispatch capability by
  declaring this field — the cloud resolver needs zero code changes. Declared:
  `ceo` → `any` (orchestrator, sibling of `taskAuthority`), `product-manager`
  → `agents` (delegates to engineer/verifier, never a human peer), `engineer`
  / `researcher` / `verifier` → `none` (executors, no peer delegation).
  `templates/roles/*.json`.

### Fixed

- **Model reasoning trace restored in agent messages on the hermes sessions
  stream** (regression from `2cdd2cad`, 2026-05-29). When dispatch migrated from
  `/v1/runs` (legacy `consumeSse`) to the sessions stream (`consumeSessionsSse`),
  the deleted `reasoning.available` handler was the only path feeding the model's
  thinking trace into `recorder.recordReasoningChunk(...)`, so reasoning stopped
  becoming `reasoning_chunk` steps and the expandable reasoning block vanished
  (tool-call steps still showed — separate handlers). Root cause of the shape
  mismatch: the sessions endpoint (`api_server.py:1585-1590 _tool_progress`)
  does **not** emit `reasoning.available`; it **remaps** reasoning into a
  `tool.progress` event with `tool_name: '_thinking'` and the text in `delta`
  (not `preview`), which the old `tool.progress` handler — reading only
  `preview` — silently dropped. Fix: `tool.progress` now reads `delta` first and
  routes reasoning through `recordReasoningChunk` + a `kind:'reasoning'`
  onProgress hint (no `lastProgress` bump — reasoning is not a progress unit for
  the reaper, mirroring the deleted handler). Also added a defensive top-level
  `reasoning.available` case (accepts `text`/`reasoning_content`/`delta`/
  `content`) for the `/v1/runs`-style direct event in case a hermes build
  surfaces it on the sessions stream. Guarded against empty strings. Covered by
  `test/reasoning-sse.test.ts`.
- **Hermes adapter no longer reuses a stale/foreign gateway squatting on the
  port** (release202/07 robustness). `ensureService` decided reuse-vs-respawn
  with the UNAUTHENTICATED `/health` check, which an old-version (pre-sessions,
  404 on `/v1/capabilities`) or wrong-`API_SERVER_KEY` (401) gateway — e.g. an
  orphan we spawned in a PRIOR daemon session — answers `200` to. Reusing such a
  squatter made the capability gate later trip with the misleading "Hermes does
  not advertise session_chat_streaming", failing every dispatch after a daemon
  restart until the orphans were manually `pkill`ed. Now the reuse decision is
  AUTHENTICATED: a hermes counts as reusable only if it answers
  `GET /v1/capabilities` as ours; otherwise the adapter frees the port
  (`stopStaleHermesGateways`, matches `-p <profile>` / `API_SERVER_PORT`) and
  spawns a fresh gateway with our key — self-healing on restart. The capability
  probe result is reused as the pinned `HermesService.capabilities` (no extra
  fetch on the happy path). `adapters/hermes/index.ts` `ensureService`.

### Changed

- **Provider chain routing — `proxyProvider` widened from `'newapi'|'deepseek'`
  enum to any chain id** (release202/07). The codex adapter previously hardcoded
  the gateway base_url to `<PRISMER_BASE_URL>/api/v1` "regardless of
  proxyProvider" — silently dropping a `deepseek` selection so every Codex
  request landed on newapi (and 500'd for deepseek-only models). Now both the
  codex and hermes adapters resolve `base_url` by the configured chain:
  `newapi`/`default` → `/api/v1`; any other chain → `/api/v1/proxy/<chain>`
  (codex appends `/responses`, hermes `/chat/completions`). The cloud walks the
  chain (source1 → source2 → …) with per-source fallback.
  - `adapters/codex/index.ts` — `proxyProvider` schema `z.enum` → `z.string`;
    `resolveCodexPrismerProvider` honors the chain in base_url.
  - `adapters/hermes/index.ts` — same schema widening; `resolvePrismerProviderBaseUrl`
    generalized from the `deepseek`-only branch to any chain id.

- **Document-deliverable SOP — markdown files, not chat prose** (B-line,
  release201/3x). Codified the rule that document-type deliverables
  (research memos, PRDs, reports, reviews, summaries) MUST be written as
  markdown files into `${PRISMER_OUTBOX_DIR}/` (physically
  `${TASK_WORKDIR}/result/`) so the daemon outbox-watcher auto-registers
  them as task-bound IMAssets; the chat reply is a summary/teaser, not the
  deliverable itself.
  - `built-in-skills/tasks/SKILL.md` §产物输出 — added §文档型交付物 (= markdown
    文件) sub-section referencing the real `${PRISMER_OUTBOX_DIR}` /
    `result/` auto-archival wiring (`dispatch.ts` `appendArtifactsInstruction`,
    `PRISMER_ARTIFACTS_DIR` env). Filenames/structure are skill-defined
    (no hardcoded schema).
  - `templates/roles/{researcher,product-manager,engineer}.json`
    `systemPrompt` — replaced the old "upload as workspace file +
    prismer://file URI" convention with the markdown-to-`result/` SOP and a
    summary-vs-deliverable distinction; each points at the tasks skill SOP.
  - `templates/roles/verifier.json` `systemPrompt` + `operatingPrinciples` —
    extended the same SOP to the verifier: the full acceptance record
    (per-criterion method / params / observed result / repro steps) is now a
    markdown file in `${PRISMER_OUTBOX_DIR}/` (e.g. `verification-report.md`),
    auto-archived as a task-bound IMAsset. Binary evidence (screenshots /
    benchmark output / logs) still goes via `cloud task attach` +
    `evidenceRefs`; the `verify-criterion --note` stays a summary. The two
    paths are complementary.
  - Audit (cross-referenced docs): `templates/roles/ceo.json` left unchanged —
    it already routes all file deliverables through `office-artifacts` /
    `image-generate` / `canvas-design` / `web-artifacts-builder` skills (no
    legacy "upload as workspace file" anti-pattern), so it needs no SOP
    backfill. `templates/roles/skill-author.json` left unchanged — its
    deliverable is a structured `status=draft` IMSkill submitted via
    `cloud skill draft create`, not a chat-bound markdown document, so the
    `result/` SOP does not apply.

### Added

- **Adapter version probe with KNOWN_GOOD pinning** (Release 201 v2.0.7
  post-release P1). All four adapters (hermes / codex / claude-code /
  openclaw) now run `<binary> --version` on startup, parse the result,
  warn when the detected version drifts below the per-adapter
  `MIN_VERSION`, and warn when it diverges from `KNOWN_GOOD`. Pins are
  declared in the new `sdk/prismer-cloud/runtime/src/adapters/known-versions.ts`
  manifest:

  - hermes: MIN=`0.0.0` (soft-pass), KNOWN_GOOD=`unknown` — TODO(v2.0.8):
    pin after cookbook run exercises a real hermes binary
  - codex: MIN=`0.0.0` (soft-pass), KNOWN_GOOD=`unknown` — TODO(v2.0.8):
    pin after cookbook run against `@openai/codex`
  - claude-code: MIN=`2.0.0` (Wave-4 flag set requires 2.x), KNOWN_GOOD=
    `unknown` — TODO(v2.0.8): pin knownGood after cookbook run
  - openclaw: MIN=`2026.4.0`, KNOWN_GOOD=`2026.4.0` — wrapper carries a
    2026.4.x stderr-bleed workaround, revisit once upstream fixes

  Honesty note: three of the four pins are intentionally unpinned at
  the floor — this is the governance scaffold, not a claim that we've
  validated specific upstream revs. Bumping the pins is a v2.0.8 task
  blocked on real cookbook runs.

- New `sdk/prismer-cloud/runtime/src/adapters/version-check.ts` —
  `compareSemver`, `isVersionInRange`, `parseVersionFromStdout` shared
  helpers so the four adapters do not redefine their own semver math.

- `/healthz` `adapters[]` entries now carry `minVersion` + `knownGood`
  alongside the existing `name` / `ready` / `version` fields so cloud
  debug-pipeline can flag drift between detected and tested versions.

- `test/adapters-version-check.test.ts` — vitest regression covering
  compareSemver, range checks, pre-release stripping, parseVersionFromStdout,
  and the `ADAPTER_KNOWN_VERSIONS` manifest shape.

## v2.0.1 — 2026-05-21 — Skill multi-file manifest protocol (§A.7 Phase 1) + URL asset fetch

Coordinated v2.0.1 patch release. `/VERSION` → 2.0.1. Internal preview only;
open-source npm publish deferred.

### Added — Multi-file Skill Manifest protocol (agentskills.io 合规)

`src/daemon/skill-sync.ts` extended for the §A.7 multi-file manifest
protocol. Existing single-file callers stay functional via dual-write on
cloud side.

- **New wire shape**: cloud `/api/im/skills/installed` now returns
  `skill.contentManifest` (JSON `files[]`) + `skill.contentManifestRevision`
  (merkle). Daemon parses files[], per-file writes to
  `<skillsRoot>/<slug>/<path>`, per-file sha256 verifies, computes merkle,
  acks back to cloud.
- **`computeMerkle(files)`** export — sha256 of sorted `"path:sha256\n"`
  lines. Same formula the cloud uses, so
  `IMAgentSkill.installedRevision == manifestRevision` after ack.
- **Hybrid inline/url storage** — files ≤ 100 KB inline as base64;
  > threshold goes to S3 presigned URL (env-overridable via
  `PRISMER_SKILL_INLINE_THRESHOLD_BYTES`).
- **Path traversal guard** — `isSafeRelativePath` rejects `..`, absolute
  paths, symlink-escaping joins. Double-checked at the writeFile call site.
- **Legacy single-file fallback** — when cloud row has `contentManifest=null`
  (pre-migration 400), daemon synthesises a single-file manifest
  `[{path:"SKILL.md", sha256: sha256(content)}]` and acks the same merkle
  the cloud computes (cloud side aligned in this release too).

### Added — `AssetCache.getOrFetchUrl()` — public URL fetch with SSRF + size + redirect guards

`src/asset-cache.ts` new helper mirrors `getOrFetch` shape but takes a URL.
Hash computed after download; cache-key = sha256 of body bytes.

- **SSRF guard**: DNS-resolves host before each hop, rejects loopback /
  RFC1918 / link-local / cloud-metadata IPv4 + IPv6 ULA/link-local.
  Cross-host redirects re-validate before following.
- **Manual redirect chain** — max 3 hops; refuses loops.
- **Hard timeout** — default 15 s, override via env
  `PRISMER_URL_FETCH_TIMEOUT_MS`.
- **Streaming read with abort-at-limit** — default 5 MiB, override via env
  `PRISMER_URL_FETCH_MAX_BYTES`. Truncated bodies are NOT cached.
- Non-2xx throws; caller surfaces an `error` observation.

### Tests

- 11 new `test/skill-sync-multifile.test.ts` (mocked cloud, real file
  writes to tmpdir, sha256 + merkle verification).
- Runtime vitest 362/362 PASS.

## v2.0.0 — 2026-05-19 — `prismer` daemon bin retained + Skill Gate GA

Coordinated v2.0.0 GA. `/VERSION` (single source of truth) → 2.0.0 via
`sdk/build/version.sh`. The headline bin-split was resolved by keeping
`@prismer/runtime` on `bin: { prismer }` (daemon priority is higher than
SDK, so the daemon claims the canonical name) and renaming `@prismer/sdk`
to `bin: { cloud }` instead.

### Changed — **Binary retained: `bin: prismer`** (daemon priority decision, 2026-05-19)

- `package.json` `bin` keeps mapping `prismer` → `./dist/cli.js`. `@prismer/sdk`
  renamed its binary to `cloud` (see `@prismer/sdk` CHANGELOG). The two bins
  now coexist — sandbox image install order no longer creates conflicts.
- Executable shim at `src/bin/prismer.ts`. Tsup emits to `dist/cli.js`;
  package.json bin maps it to `prismer`.
- `cli/index.ts`: `new Command('prismer')` (unchanged from v1.x); `--help`
  and parse errors report `Usage: prismer [options]`.
- Help text + error prefixes + cookbook references stay on `prismer` across
  `src/cli/*`, `src/cli/commands/*`, `src/config.ts`, `src/daemon-id.ts`,
  `src/pair.ts`, `src/index.ts`. (An intermediate Session-3 commit had
  temporarily renamed these to a daemon-suffixed form; reverted before GA
  per user direction.)
- See `docs/release200/02-v20-daemon-runtime-plan.md` §CLI 边界更新 for the
  rationale (fixes v1.x sandbox-image bin clobber bug that caused the v2.0
  Built-in skill Kanban scheduling regression).

### Changed — **VERSION sync**

- `cli/index.ts` `VERSION` literal synced from 1.9.7 → 2.0.0. Now sourced
  from `/VERSION` via `sdk/build/version.sh`.

### Added — **Skill Gate foundation (v2.0 GA gate)**

The Skill Gate (cloud `/skills/ack` round-trip + dispatch-time skill sync
+ `SkillLoader` per-adapter) was incrementally landed across 1.9.x cuts.
v2.0 promotes it to GA. Recap of the components carried by this release:

- **SkillSyncManager** (`daemon/skill-sync.ts`): reconciles
  `agent.skills.list` ↔ local `~/.prismer/agents/<id>/skills/`,
  writes `SKILL.md` to disk, replies `skills.ack` once content is durable.
- **SkillLoader SPI**: adapters can opt into per-dispatch skill payload
  composition. Hermes + OpenClaw implement; Codex + claude-code are no-ops
  in 2.0 (skill sync still writes files to disk for those, but the
  dispatch-time injection is gated by adapter capability).
- **v2.0 Skill Gate scope**: dispatch-time skill payload coverage validated
  for `hermes` + `openclaw` only. `codex` + `claude-code` skill sync remains
  a file-write no-op pending adapter framework support (tracked v2.1+).
- Live-gate evidence: `dev-loop.sh skill-live-gate` /
  `scripts/sandbox/e2e/skill-agent-dispatch-live.ts` capture 21 Built-in +
  1 magic-marker skill in `POST /v1/runs.instructions` (~31 KB payload).
  See `docs/release200/evidence/05-live-dispatch-gate-2026-05-19.md`.

### Added — **Origin Adapter framework** (promoted from "Unreleased")

`daemon/asset/origin/` — daemon-side asset producers behind a uniform
OriginAdapter SPI (doc 26 §4 Phase 2). Foundation for the v2.0 `assets` +
`ingest` Built-in skills.

- **SPI** (`spi.ts`): `OriginAdapter` interface with
  `kind: 'upload' | 'drop-folder' | 'agent-gen'`,
  `observe / identifySource / fetch` decomposition. Identification stays
  separate from byte fetch so the outbox can dedupe before paying read cost.
- **Outbox** (`outbox.ts`): SQLite-backed pending-upload queue mirroring
  `daemon/memory/outbox.ts` shape — Zod validation → dead-letter,
  `idempotencyKey = sha256(originKind|wid|sourceRef|observedAt)` UNIQUE,
  `claimNext()` transactional, `recordFailure(maxAttempts)` auto-spills to
  dead-letter. Restart-resume-friendly.
- **Drop-folder adapter** (`drop-folder.ts`): polls
  `~/.prismer/workspaces/<wid>/drop/` (1 s tick, recursive), enqueues
  observations, moves files to `uploaded/` on success and `upload-failed/`
  on persistent failure.
- **Agent-gen adapter** (`agent-gen.ts`): synchronous
  `handleAssetWrite(body, { cloud })` for the `POST /local/asset/write` RPC.
- **Web-upload adapter** (`web-upload.ts`): cloud-side marker class for SPI
  symmetry.
- **Upload runner** (`upload-runner.ts`): generic worker draining the
  outbox; `onUploadSuccess` / `onUploadFailure` hooks per adapter.
- **`POST /local/asset/write` route** (`local-server.ts`): wires
  `onAssetWrite` sink alongside `onDispatch` / `attachMemory`. Returns
  `{ assetId, contentHash, prismerUri }`. 400 / 502 / 501 error contract.

### Added — **memory-curation skill** (promoted from "Unreleased")

- **Codex adapter** (`adapters/codex/index.ts`): `buildCodexPrompt()`
  extracted as pure function; injects `MEMORY_CURATION_SKILL_TEXT` as
  system-prompt preamble (Codex has no native skill framework).
- **Embedded skill module** (`src/skills/memory-curation.ts`): regenerated
  from canonical `sdk/prismer-cloud/skill/memory-curation.md` via
  `scripts/regenerate-memory-curation-skill.cjs`.

### Added — **CLI hardening pass** (promoted from "Unreleased")

Audit of the 16-verb CLI surface. No new daemon behavior; existing commands
now fail closed and emit consistent JSON.

- **`prismer config (path|show|set)`** — inspect or edit `~/.prismer/config.toml`.
  `show` redacts the api_key by default; `--reveal` prints clear text.
  `set cloud_api_base <url>` runs through `normalizeCloudUrl`,
  `set api_key sk-…` validates the key format.
- **`prismer setup --check`** — dry-run mode. Validates `--cloud`, prints
  the would-be config target and api-key source, returns without touching
  disk. JSON: `{ok:true, check:true, mode, cloud, …}`.
- **Default `--cloud` URL is `https://prismer.cloud`** (was
  `https://cloud.prismer.dev`). Visible in `setup --help` / `pair --help`.
- **Stable error codes** on every CLI exit path so JSON consumers can
  branch on `error.code` (e.g. `invalid_cloud_url`, `config_missing`,
  `task_create_failed`).

### Fixed — **CLI hardening pass** (promoted from "Unreleased")

- **`--json` was dead code on every subcommand.** `applyCommonFlags`
  stripped `--json` from argv before commander parsed per-command options,
  so JSON branches silently no-op'd (e.g. `prismer status --json` exit 0
  with no body). Now `--json` is kept in argv and declared on every
  printing subcommand.
- **`prismer setup --cloud 0.0.0.0:3000` accepted bare host:port and
  exploded with raw Zod JSON.** `normalizeCloudUrl()` now auto-prefixes
  `http://` for bare host shapes and rejects everything else with a
  single-line error.
- **`exitWithError` is JSON-aware.** Emits
  `{ok:false, error:{code, message}}` to stdout when UI is in JSON mode.
  Every action handler goes through a `runAction(fn, { code })` wrapper.
- **Daemon ignored application-level `AUTH_FAILED`.** The runner now
  detects `AUTH_FAILED` / `AUTH_REQUIRED` / `auth_invalid` payload codes,
  emits `auth-failed`, and `daemon run` clears the pid file + exits 2.
- **`memory stats` returned exit 0 when the gateway was unavailable** even
  though `delete` and `sync` exited 1 in the same condition. Now consistent.
- **`task create` printed `(0): fetch failed`.** Network errors now render
  as `(network error): …` so the `0` HTTP status doesn't leak.
- **`daemon restart` dropped `--port` / `--foreground` / `--no-local-server`
  on the floor.** Restart now forwards the flags through to `start`.
- **`daemon logs --tail` read the entire log file into memory.** Now seeks
  from the end in 64 KiB chunks.

### Tests

- Origin Adapter framework: 44 new vitest assertions across 8 new test files
  (`origin-spi`, `origin-outbox`, `origin-drop-folder`, `origin-agent-gen`,
  `local-server-asset-write`, `origin-web-upload`,
  `skill-memory-curation-sync`, `codex-adapter-skill-injection`).
- Acceptance criteria covered: doc 26 §5 L2-T1 (100-burst, dead-letter=0),
  L2-T2 (restart resume), L2-T3 (RPC sync return).
- Total runtime suite: 192 → 234 passing, 0 failures.

### Cookbook

- `docs/cookbook/m-asset-origin-drop-folder.md`
- `docs/cookbook/m-asset-origin-agent-gen.md`

---

## v1.9.7 — 2026-05-12 — Device capacity fix + setup daemon auto-start

### Fixed

- **`host.declare` now upserts `im_containers` row** so agent.register's
  `assertDeviceCapacityAvailable` can find the daemon device. Previously only
  Redis presence was written; the MySQL `im_containers` table was empty for
  local daemons, causing `UNKNOWN_DAEMON` (409) on every agent create from
  the workspace UI.
- **`prismer setup` auto-starts daemon when config already exists** — the
  "Already configured" branch was returning early before `startDaemonDetached`,
  leaving users with a working config but no running daemon (no device
  appeared in the workspace).

### Internal

- `src/im/ws/handler.ts` — upsert im_containers on host.declare, guarded
  against empty daemonId; `startedAt` preserved across heartbeat redeclares.
- `src/im/api/register.ts` — `assertDeviceCapacityAvailable` matches by
  `OR(agentImUserId, daemonId)` so both runtime-installation and local daemon
  paths find the device row.
- `src/im/db/index.ts` — Prisma client re-export (unchanged, listed for audit
  completeness).

## v1.9.6 — 2026-05-12 — Refactoring wave: register hardening + CLI version sync

Batch delivery of §30 / §31 refactoring items affecting IM register flow,
CEO authorization data layer, and runtime version hygiene.

### Fixed

- **CLI `--version` + banner displayed stale `1.9.3`** after package.json was
  bumped to 1.9.6. `src/cli/index.ts` hardcoded `VERSION` const and
  `src/cli/util.ts` banner strings were missed in the 1.9.4→1.9.5→1.9.6 bump
  chain. Now reads `1.9.6` in both places.
- **Hermes adapter prompt still referenced old `im_send_to_agent` /
  `im_list_agents` tool names** after the MCP 58-tool rename sweep. Replaced
  with `prismer.agent.send` / `prismer.conversation.listAgents`. The old names
  returned 404 at dispatch time if the adapter actually called them.
- **`--json` output from `agent list` now surfaces `local.hosted: true`
  correctly** for agents that were registered with an adapter (was returning
  `local.hosted: false` when the local mirror hadn't synced yet).

### Internal

- Tool name sweep: `sdk/prismer-cloud/runtime/src/adapters/hermes/index.ts`
  (`buildHermesPrompt`), `src/im/types/im-events.ts` (unused old types),
  `src/im/services/message.service.ts` (WS event type const),
  `src/im/daemon/dispatch.ts` (dispatch compose).
- Version files bumped via `sdk/build/version.sh --scope prismer-cloud --patch`:
  `VERSION`, all SDK package.json, `mcp/src/index.ts`,
  `python/prismer/__init__.py`, `rust/Cargo.toml`, plugin manifests, root
  `package.json`, `src/lib/version.ts`.

---

## v1.9.3 — 2026-05-07 — Hosted agents + Hermes long-running + 16-verb CLI

First published cut of `@prismer/runtime`. The runtime is the TS-only daemon that hosts Prismer agents on a user's Mac (under `launchd`) or inside a sandbox pod (as PID 1). One binary, one WebSocket to cloud, four in-process adapters, local SQLite mirror.

### Added

- **CLI: 8 new verbs** — `setup`, `banner`, `chat`, `cookbook`, `asset`, `sandbox`, `memory`, `events` (+ `events:stats`). Plus `workspace` (already shipped). Total surface is now **16 verbs**.
  - `setup` — three onboarding paths (direct API key, `--token <jwt>` mints a daemon-scoped key via `POST /api/keys`, `--pair` delegates to QR/local-only). `--force` archives `local.db` → `local.db.<iso>.bak` when key/cloud/daemon_id changed.
  - `chat` — `me` / `direct` / `messages` / `group (create|send|messages|remove-member)`. Sanitizes `sk-prismer-*` from error messages.
  - `cookbook run` — 54release MVP regression suites (`status` / `im` / `task` / `group` / `asset` / `sandbox`); `--strict` treats skips as failure.
  - `asset` — `list` / `upload` (multipart) / `download` / `get` / `by-hash`.
  - `sandbox` — full `/api/sandboxes` CRUD + `runCmd` + log streaming.
  - `memory` — daemon Memory Gateway first; falls back to read-only view of `~/.prismer/local.db` cache tables when gateway is absent (returns `error.code='memory_gateway_unavailable'` with a fix hint).
  - `events` / `events:stats` — read `~/.prismer/para/events.jsonl` with `--limit / --agent-id / --session-id / --family / --type` filters; stats aggregates `byFamily / byType / byAgentId / bySessionId`.
- **Hermes long-running adapter** — autostart from `~/.hermes/profiles/<name>/config.yaml`, `/v1/runs` SSE consumer, full `tool.started` / `tool.completed` / `reasoning.available` event handling, Kanban + Goal mirror writeback onto `IMTask.metadata.bridge.hermes`. New runtime dep: `yaml@^2.8.2`. Hermes runs in the user's own Python venv; the runtime stays TS-only.
- **Hosted-agent pipeline** — `agent.host.declare` payload now stamps `daemonId` onto `IMAgentCard.metadata` so the workspace runtime view groups daemon-declared agents under the right device (instead of `__unbound__`). New `POST /v1/agents/install` LocalServer endpoint + `POST /:id/installAgent` sandbox-controller proxy enable cloud→daemon agent install RPC.
- **Static binding** — `PRISMER_HOSTED_AGENT_FILE` / `PRISMER_HOSTED_AGENT_JSON` / `PRISMER_STATIC_BINDING_REQUIRED` env vars consumed by `Runner.installStaticHostedAgentFromEnv`. K8s deployments seed one `agents` + `agent_profiles` row before the first `host.declare`.
- **Daemon-local shell route** — `runtimeRoute='shell'` (or `metadata.execution.kind === 'shell'`) routes through `shell-executor.ts`. Output capping (default 256 KiB, hard max 5 MiB), timeout enforcement (default 60s, hard max 30 min), `allowedWorkspaces` allow-list, `bash|zsh|sh` selector, structured error codes (`shell_disabled`, `shell_workspace_not_allowed`, `shell_command_required`, `shell_cwd_missing`, `shell_spawn_failed`, `shell_timeout`, `task_cancelled`, `shell_exit_nonzero`).
- **Stuck-task reaper** (60s) + **per-`taskId` dedupe** in `Runner.runningTasks` — closes the failure mode where cloud's `redispatchPending` fires the same task five times during a long LLM call and an upstream gateway half-closes a connection. Reaper aborts past `max(timeoutMs, 5min)` and emits `task.dispatch.reply {ok:false, error.code:'daemon_task_timeout'}`.
- **30s heartbeat re-declare** — re-sends `agent.host.declare` so cloud's 90s `sweepTimedOut()` doesn't flip status back offline.
- **Bridge + observability writeback** — dispatch PATCH-merges `result.metadata.hermes` onto `IMTask.metadata.bridge.hermes` (with `lastSyncedAt`) and writes `metadata.observability` with `{identity, memory, goals, lastSyncedAt}`.
- **8 new tests** under `test/` (Vitest):
  - `asset.test.ts` (240 LOC) — CLI asset CRUD + envelope normalization.
  - `chat-cli.test.ts` (135 LOC) — chat envelope + `sk-prismer` redaction.
  - `cookbook.test.ts` (148 LOC) — suite parsing, summary, strict-skip.
  - `dispatch.test.ts` (265 LOC) — `composePrompt` / `appendGoalContext` / `appendMemoryContext` + full `handleDispatch` path with mocked resolver/cache/ws/service-pool, plus error paths.
  - `hermes-validate.test.ts` (88 LOC) — `hermesAdapter.validate` accepts/rejects port, apiKey, env-var key regex, provider URL.
  - `sandbox.test.ts` (189 LOC) — sandbox CRUD + `runCmd` + logs streaming.
  - `shell-executor.test.ts` (66 LOC) — `resolveShellConfig` defaults + clamping, `isShellDispatch` routing, `executeShellDispatch` enabled/disabled/timeout.
  - `workspace-cli.test.ts` (89 LOC) — `prismer workspace (list|create|get|runtime|files)` envelope unwrapping.
- **2 opt-in Playwright e2e specs** under `e2e-playwright/specs/`:
  - `workspace-hermes-daemon-runtime.spec.ts` — `WAVE7_HERMES_E2E=1 HERMES_API_KEY=...`. Drives full `pair → register Hermes agent → AgentProfile → host.declare → POST /api/im/tasks → Hermes reply` chain via product APIs only.
  - `workspace-hermes-ui-flow.spec.ts` — `WAVE7_HERMES_UI_E2E=1`. Workspace UI: New Agent dialog → Hermes long-running role → direct session → IM message → reply persisted. Requires a real local daemon on `127.0.0.1:3210`.

### Evolved

- **5 existing CLI verbs reworked**: `adapter` (richer install/uninstall + per-adapter register, new `doctor` + `hooks`), `agent` (host register/list/unregister + 6-check `doctor`), `daemon` (`--foreground` for LaunchAgent + log tail-N + follow), `status` (consolidated banner + composite `/healthz` + `/api/im/me` + `local.db` row counts), `task` (tolerant envelope parsing for both `{task:{...}}` and flat shapes; reads `output` from `task.output` or `task.result.output`).
- **`Runner` + `dispatch` + `LocalServer`** gain hosted-agent paths (~940 lines added across the three files).

### Breaking

- **`package.json` `module` + `exports.import` now point at `dist/index.js`** (was `dist/index.mjs`, which `tsup` never actually emitted — bug fix that may affect bundlers respecting the old field).
- **`yaml@^2.8.2` is a new runtime dependency.** Used by the Hermes adapter to read/write `~/.hermes/profiles/<name>/config.yaml`.
- **`public/install.sh` strict-pins `@prismer/runtime@1.9.3`** (no caret). Stale 1.8.x installs will not auto-upgrade via curl re-run; users must explicitly re-run the installer.
- **LaunchAgent plist `ProgramArguments` now include `--foreground`.** Existing 1.8.x installs that loaded the plist without it would respawn-loop unless the user re-runs the installer (which does `bootout` + `bootstrap`).
- **`agent.host.declare` payload now requires `daemonId`** to be honored by cloud — without it the agent renders under `__unbound__` in the workspace runtime view.
- **`runtimeRoute` extended** with `'shell'` as a valid value of `TaskDispatchRequestPayload.runtimeRoute`. Cloud-side dispatchers that previously hard-coded `'agent'|'sandbox'` need a passthrough for `'shell'`.
- **`adapter list` JSON output now includes `installed: { package_manager, package_name, binary, version, installed_at } | null`** field. Strict-shape consumers need an update.
- **New CLI verbs may shadow user aliases**: `setup`, `banner`, `chat`, `cookbook`, `asset`, `sandbox`, `memory`, `events`, `events:stats`, `workspace`. None overlap with the prior 7-verb shape, but wrapper scripts that did `prismer <unknown>` and got a friendly error will now get command-not-found.
- **claude-code adapter closes child stdin** (`stdio: ['ignore', 'pipe', 'pipe']`). Operators relying on stdin-mode interactive use of `claude` via the daemon (which was never supported) see no behavior change; this only removes the 3s "no stdin" warning that made daemon dispatches appear hung on `claude` ≥ 2.1.128.

### Fixed

- **LaunchAgent KeepAlive respawn loop on macOS** — `install.sh` now passes `--foreground` to `prismer daemon start` in the plist `ProgramArguments`. Without it, `daemon start` spawned a child and exited, `launchd` saw exit-zero, KeepAlive=true respawned immediately. With `--foreground` the binary blocks in the polling loop until `config.toml` appears.

### Internal

- `module` / `exports.import` field correctness (`dist/index.js`).
- `qrcode@^1.5.4` runtime dep added (used by the QR pair flow).
- `eslint-plugin-react-hooks` added to dev tooling.

---

## v1.8.x — Pre-publish scaffolding

The runtime tree was scaffolded across the `feat/refactoring` branch. There were no published cuts before v1.9.3; the package landed at v1.9.3 directly when its public API surface stabilized.
