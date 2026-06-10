## Unreleased

### N/A — v2.0 §4.3 two-phase dispatch reply migration (Wave 5 Agent F3)

**Outcome: NO-OP for Go SDK.** Investigation under Wave 5 F3 (TS daemon two-phase
dispatch reply migration — `evidence/14-e7-daemon-reply-skills.md`) confirmed the
Go SDK does **not** contain a daemon-side `/api/im/dispatch/reply` transport. The
Go `daemon` subcommand (`daemon.go::RunDaemonProcess`) is exclusively an evolution
sync + outbox flush background loop — it never POSTs to `/api/im/dispatch/reply`
and has no Runner / agent-dispatch-reply architecture analogous to the TS
`runtime` package.

What Go SDK *does* have w.r.t. "reply":

- `cmd/prismer/im.go::imSendReplyTo` — CLI flag that maps to `IMSendOptions.ParentID`
  (a regular IM message thread reply, NOT the agent dispatch reply path).
- `webhook.go::WebhookReply` — optional reply struct returned by a user's webhook
  handler back to the cloud HTTP response (NOT a `/dispatch/reply` POST).

What Go SDK does **not** have:

- No `Reply` / `SendDispatchReply` / `postMessageDispatchReply` method
- No `/api/im/dispatch/` path in any HTTP call (verified via `grep -rn "dispatch/reply\|/dispatch/" --include="*.go"` → zero hits)
- No `pending-reply-cache` or local SQLite cache for in-flight dispatch state
- No agent runner that processes inbound `agent.task.dispatched` events

**Hand-off:** the two-phase migration becomes relevant only when the Go SDK gains
an agent-runner / dispatch-reply transport. The TS reference implementation lives
at `sdk/prismer-cloud/runtime/src/daemon/{pending-reply-cache,dispatch-reply-transport}.ts`.
At that future point the Go side should mirror that contract using `modernc.org/sqlite`
or a JSON-file cache for crash recovery (see `evidence/14-w3-dispatch-two-phase.md`
§"Wave 4 daemon hand-off contract" for the wire protocol).

Evidence: `evidence/14-f3-golang-sdk-reply-migration.md`.

### Added — v2.0 §4.6 `ContentBlock` protocol-layer types + §3.0.2 Gap A-④ `X-Idempotency-Key` (Wave 3 Agent D1)

`types.go`:

- New `ContentBlock` struct + `ContentBlockKind` enum covering all 8 §4.6
  variants (`text` / `image` / `audio` / `video` / `file` / `tool_use` /
  `tool_result` / `reasoning`). Anthropic-shape `kind` discriminator (NOT
  OpenAI's `{type: "image_url"}` shape).
- Constructor helpers: `NewTextBlock`, `NewImageBlock`, `NewAudioBlock`,
  `NewVideoBlock`, `NewFileBlock`, `NewToolUseBlock`, `NewToolResultBlock`,
  `NewReasoningBlock`.
- New `ChatMessage` with custom `MarshalJSON` / `UnmarshalJSON` so
  `content` can be either a JSON string (legacy single-text) OR a JSON
  array of ContentBlock (multimodal) on the wire.
- New `TaskInput` (`Prompt` + optional `Messages []ChatMessage` + free
  `Extra map[string]any` flattened into the top-level JSON object).
- `IMMessage` gained `ContentBlocks []ContentBlock` and `BoundarySeq int64`
  (Wave 2-B1 server outbox path stamps boundarySeq on every accepted
  message).
- `IMSendOptions` gained `IdempotencyKey string` (json:"-") + `ContentBlocks
  []ContentBlock` (json:"-") — these drive the new header / body path.

`prismer.go`:

- New `requestOption` + `WithHeader(key, value)` variadic-functional option
  for per-call extra HTTP headers.
- New `generateIdempotencyKey()` (crypto/rand-backed RFC 4122 v4).
- New `buildSendPayload(content, opts)` + `buildSendPayloadBlocks(blocks,
  opts)` shared by all three send methods. Auto-generates the key when
  `opts.IdempotencyKey` is empty; mirrors the key into both the JSON body
  AND the `X-Idempotency-Key` HTTP header.
- `Client.doRequest` + `IMClient.do` extended with variadic
  `...requestOption`; the message-signing path forwards options unchanged.
- `MessagesClient.Send` / `DirectClient.Send` / `GroupsClient.Send` now
  stamp the header automatically. Caller can supply the same
  `opts.IdempotencyKey` across retry attempts to trigger server-side
  dedup (UNIQUE `(conversationId, idempotencyKey)`).
- New `MessagesClient.SendBlocks` / `DirectClient.SendBlocks` /
  `GroupsClient.SendBlocks` accept a `[]ContentBlock` first-class.
- `FilesClient.SendFile` also auto-stamps the idempotency header now.
- Legacy `sendPayload` is preserved as a deprecated shim around
  `buildSendPayload` to avoid breaking external code that imported it.

Spec refs:

- `docs/release200/14-messaging-state-machine-reliability.md` §3.0.2 Gap
  A-④ + §4.6
- `docs/release200/14b-multimodal-input-pipeline.md` "与 14 主文档的关系"
- `evidence/14-p1-server-wave2-b1.md`

Tests: `v200_content_block_idempotency_test.go` (13/13 pass via
`go test ./...`) — ContentBlock JSON round-trip, ChatMessage
polymorphism, TaskInput.Extra flattening, key uniqueness, retry-key
reuse, multi-client header stamping, SendBlocks wire-format.

No version bump (wave-close coordinator handles batch bump).

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release. `/VERSION` (single source of truth) → 2.0.0.
Go module version bumped to align with the rest of the SDK suite.

### Changed — **Cross-cutting Built-in skill consolidation (21 → 6)**

- The v2.0 Built-in skill catalog ships 6 workflow skills (`tasks`, `memory`,
  `assets`, `ingest`, `agent-coordination`, `human-approval`) instead of the
  original 21 fine-grained slugs. Each Built-in skill delegates to the
  `cloud` SDK CLI (TypeScript) for execution. Go SDK exposes the same
  underlying API surface.
- **Go SDK CLI bin name unchanged** — `cmd/prismer/main.go` continues to
  build a `prismer` binary; Go module namespace has no collision with the
  npm `@prismer/runtime` binary. Only the TypeScript SDK CLI bin was
  renamed `prismer` → `cloud`.
- See `docs/release200/05-skill-system-design.md` §A.5.4 D21.

### Added — **v1.8.2 wire alignment (reactions + message types)** (promoted from "Unreleased")
- Distinct `MessageType` and `ArtifactType` string types with exported
  constants (`MessageTypeText`, `MessageTypeVoice`, `MessageTypeLocation`,
  `MessageTypeArtifact`, `MessageTypeSystem`, `ArtifactTypePDF`, …).
  Existing untyped string call sites continue to compile; typed callers
  gain autocomplete and typo protection.
- `MessagesClient.React(ctx, conversationID, messageID, emoji, remove)` for
  the v1.8.2 reactions endpoint. Idempotent; response `data.reactions` is
  `map[emoji][]userId`.

---

## v1.8.2 (2026-04-13)

### Added — **Task type extensions**
- Task struct: `Progress`, `StatusMessage`, `ConversationID`, `CompletedAt`, `OwnerID`, `OwnerType`, `OwnerName`, `AssigneeType`, `AssigneeName`
- `ApproveTask()`, `RejectTask()`, `CancelTask()` client methods
- `TaskStatus` now includes `"review"` state

---

## v1.8.1 (2026-04-10)

### Fixed — **Module path**
- Previous `v1.8.0` tag was published before the `go.mod` path was corrected to `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` — users running `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang@v1.8.0` hit `module declares its path as: github.com/Prismer-AI/PrismerCloud/sdk/golang`. v1.8.1 tag includes the corrected go.mod.
- No API changes; drop-in upgrade from 1.8.0.

---

## v1.8.0 (2026-04-04)

### Added
- `GetWorkspace(scope, slots, includeContent)`: Fetch workspace superset view with slot filtering
- `InstallSkill(slugOrID, scope)`: Scope parameter for scoped skill installation

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `Identity().BuildDID`, `Identity().ResolveDID`, `Identity().Delegate`, `Identity().Revoke`
- Verifiable Credentials: `Credentials().Issue`, `Credentials().Verify`, `Credentials().Present`
- **Parity tests**: 30 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking
# prismer-sdk-go -- Changelog

## v1.7.3 (2026-03-27)

### Added
- Data Governance: qualityScore wired into gene lifecycle and skill operations
- Doc samples test suite (`doc_samples_test.go`) -- 21 tested code samples
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **Tasks API**: `Tasks().Create`, `Tasks().Get`, `Tasks().List`, `Tasks().Claim`, `Tasks().Complete`, `Tasks().Fail`
- **Memory API**: `Memory().CreateFile`, `Memory().GetFile`, `Memory().UpdateFile`, `Memory().DeleteFile`, `Memory().ListFiles`, `Memory().Load`, `Memory().Compact`
- **Identity API**: `Identity().RegisterKey`, `Identity().GetKey`, `Identity().RotateKey`, `Identity().RevokeKey`
- **EvolutionRuntime**: High-level `Suggest()` / `Learned()` / `GetMetrics()` with Thompson Sampling cache
- **Skills API**: `SearchSkills`, `InstallSkill`, `UninstallSkill`, `InstalledSkills`, `GetSkillContent`

## v1.7.1 (2026-02-20)

### Added
- **Evolution API**: `Analyze`, `Record`, `Evolve`, `CreateGene`, `ListGenes`, `DeleteGene`, `PublishGene`, `BrowseGenes`
- **Sync API**: `Sync`, `SyncStream` (SSE)
- **Files API**: `Presign`, `Confirm`, `Quota`, `UploadFile`

## v1.7.0 (2026-02-10)

### Added
- Initial release with Context, Parse, and IM APIs
- CLI binary (`prismer` command)
- Webhook handler with HMAC-SHA256 verification
- Real-time WebSocket and SSE clients
