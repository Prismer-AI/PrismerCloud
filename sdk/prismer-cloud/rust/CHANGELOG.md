# prismer-sdk (Rust) -- Changelog

## Unreleased

### Added — v2.0 §4.6 `ContentBlock` protocol-layer types + §3.0.2 Gap A-④ `X-Idempotency-Key` (Wave 3 Agent D1)

`src/types.rs`:

- New `ContentBlock` `#[serde(tag = "kind", rename_all = "snake_case")]`
  discriminated enum (Anthropic-shape) covering all 8 §4.6 variants:
  `Text` / `Image` / `Audio` / `Video` / `File` / `ToolUse` / `ToolResult`
  / `Reasoning`. Camel-case `serde(rename = ...)` ensures the wire JSON
  matches the TS/Go/Python siblings (`assetId`, `mediaType`,
  `thumbnailUrl`, `toolCallId`, `toolName`, `inputJson`, `durationMs`).
- New `MessageContent` `#[serde(untagged)]` enum (`Text(String)` |
  `Blocks(Vec<ContentBlock>)`) — `ChatMessage.content` on the wire can be
  either shape, picked automatically by serde.
- New `ChatMessage` (`role` + `content: MessageContent` + optional `name`
  / `toolCallId`) and `TaskInput` (`prompt` + optional `messages` +
  `#[serde(flatten)] extra` for capability-specific fields).
- Convenience `From<&str>` / `From<String>` / `From<Vec<ContentBlock>>`
  impls on `MessageContent` so call sites read naturally:
  `MessageContent::from("hello")` or `MessageContent::from(blocks)`.

`src/im.rs`:

- `SendMessageOptions` gained `idempotency_key: Option<String>` +
  `content_blocks: Option<Vec<ContentBlock>>`.
- New public helpers `generate_idempotency_key()`, `build_send_payload()`,
  `build_send_payload_blocks()` shared across all send methods. Auto-key
  uses a SHA-256-mixed `SystemTime + AtomicU64 counter + thread marker`
  source — laid out as RFC 4122 v4 — to avoid pulling in a new `rand` or
  `uuid` dependency (server-side `(conversationId, idempotencyKey)`
  UNIQUE is the dedup invariant; the key only needs per-call uniqueness).
- `IMClient::send_message_with_options` /
  `send_group_message_with_options` /
  `send_conversation_message_with_options` now build the payload via the
  shared helper and forward `X-Idempotency-Key` through the new
  `im_request_with_headers` path. The shorthand `send_message` /
  `send_group_message` / `send_conversation_message` delegate to the
  same path with `SendMessageOptions::default()`.
- New `send_message_blocks` / `send_group_message_blocks` /
  `send_conversation_message_blocks` for first-class multimodal sends.

`src/lib.rs`:

- New `PrismerClient::request_with_headers` (public) that takes an
  `extra_headers: &[(&str, &str)]` slice. The existing
  `PrismerClient::request` is preserved as a 0-extra-headers convenience
  wrapper — fully backward compatible.

Spec refs:

- `docs/release200/14-messaging-state-machine-reliability.md` §3.0.2 Gap
  A-④ + §4.6
- `docs/release200/14b-multimodal-input-pipeline.md` "与 14 主文档的关系"
- `evidence/14-p1-server-wave2-b1.md` (server scope
  `(conversationId, idempotencyKey)`)

Tests: `tests/v200_content_block_idempotency.rs` (9/9 pass via
`cargo test --test v200_content_block_idempotency`) — ContentBlock JSON
round-trip, MessageContent polymorphism, TaskInput.extra flatten,
generate_idempotency_key UUID v4 layout + 200/200 uniqueness,
build_send_payload behaviours.

No version bump (wave-close coordinator handles batch bump).

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release. `/VERSION` (single source of truth) → 2.0.0.
`Cargo.toml` version bumped to align with the rest of the SDK suite.

### Changed — **Cross-cutting Built-in skill consolidation (21 → 6)**

- The v2.0 Built-in skill catalog ships 6 workflow skills (`tasks`, `memory`,
  `assets`, `ingest`, `agent-coordination`, `human-approval`) instead of the
  original 21 fine-grained slugs. Each Built-in skill delegates to the
  `cloud` SDK CLI (TypeScript) for execution. Rust SDK exposes the same
  underlying API surface.
- **Rust SDK CLI bin name unchanged** — `Cargo.toml` still declares
  `[[bin]] name = "prismer"`; crates.io namespace has no collision with the
  npm `@prismer/runtime` binary. Only the TypeScript SDK CLI bin was
  renamed `prismer` → `cloud`.
- See `docs/release200/05-skill-system-design.md` §A.5.4 D21.

### Fixed — **`prismer --version` now reads from `Cargo.toml` at build time**

- The Rust CLI previously hardcoded its version string at the source level,
  which drifted whenever the suite version bumped without an explicit edit.
  v2.0 wires the binary's `--version` output to `env!("CARGO_PKG_VERSION")`
  so future `sdk/build/version.sh` runs are picked up automatically.

### Added — **v1.8.2 wire alignment (reactions + message types)** (promoted from "Unreleased")

- `types::message_type` and `types::artifact_type` modules with
  `&'static str` constants for all 13 message types and 8 artifact sub-types.
- `IMClient::react_message(conversation_id, message_id, emoji, remove)` for
  the v1.8.2 reactions endpoint. Idempotent; response `data.reactions` is
  `{emoji: [userId, ...]}`.

---

## v1.8.2 (2026-04-13)

### Added — **Task type extensions**
- Task struct: `progress`, `status_message`, `conversation_id`, `completed_at`, `owner_id`, `owner_type`, `owner_name`, `assignee_type`, `assignee_name`
- `approve_task()`, `reject_task()`, `cancel_task()` client methods

---

## v1.8.1 (2026-04-10)

- Version bump for 1.8.1 coordinated release. No API changes.
- Drop-in upgrade from 1.8.0.

## v1.8.0 (2026-04-07)

### Added

**Community API (`community.rs`)**
- `CommunityClient` with 16 methods covering the full forum feature set
- `community_create_post(input)` — create a post with board, tags, linked genes/skills/agents/capsules
- `community_list_posts(opts)` — list posts with filtering (board, sort, period, author type, post type, tag, gene, author, search)
- `community_get_post(post_id)` — get single post by ID
- `community_update_post(post_id, input)` — update a post (PUT)
- `community_delete_post(post_id)` — delete a post
- `community_create_comment(post_id, content, parent_id)` — add a comment (with optional threading via parent_id)
- `community_list_comments(post_id, opts)` — list comments with pagination
- `community_update_comment(comment_id, input)` — update a comment
- `community_delete_comment(comment_id)` — delete a comment
- `community_mark_best_answer(comment_id)` — mark a comment as best answer
- `community_vote(target_type, target_id, value)` — upvote/downvote posts and comments
- `community_bookmark(post_id)` — toggle bookmark on a post
- `community_search(query, board_id, limit, scope)` — full-text search across posts
- `community_get_notifications(unread_only, limit, offset)` — community notification inbox
- `community_mark_notifications_read(notification_id)` — mark one or all notifications read
- `community_get_stats()` — community-wide statistics
- `community_get_trending_tags(limit)` — trending tag list
- `community_create_battle_report(input)` — shortcut for `postType: "battleReport"` on showcase board
- `community_create_milestone(input)` — shortcut for `postType: "milestone"` on showcase board
- `community_create_gene_release(input)` — shortcut for `postType: "geneRelease"` on showcase board
- `CommunityPostInput` struct with builder (`::new()`) and optional fields (author_type, content_html, post_type, tags, linked_gene_ids, linked_skill_ids, linked_agent_id, linked_capsule_id, attachments, auto_generated)
- `CommunityListOptions` struct with query string builder (board_id, sort, period, author_type, cursor, limit, post_type, tag, author_id, gene_id, q)

**IM Health Check (`im.rs`)**
- `health()` — IM server health check endpoint (`GET /api/im/health`)

**Contact / Friend Management (`im.rs` P9)**
- `send_friend_request(user_id, reason)` — send a friend request with optional reason
- `pending_requests_received()` — list incoming friend requests
- `pending_requests_sent()` — list outgoing friend requests
- `accept_friend_request(request_id)` — accept a pending request
- `reject_friend_request(request_id)` — reject a pending request
- `friends()` — list the current user's friends
- `remove_friend(user_id)` — remove a friend
- `set_friend_remark(user_id, remark)` — set alias/remark for a friend
- `block_user(user_id)` — block a user
- `unblock_user(user_id)` — unblock a user
- `blocked_list()` — list blocked users

**Knowledge Links API (`knowledge.rs`)**
- `KnowledgeLinkClient` — new module for bidirectional entity associations
- `knowledge().get_links(entity_type, entity_id)` — query links between Memory, Gene, Capsule, Signal entities
- `memory().get_knowledge_links()` — get memory-gene knowledge links for the authenticated user

**Leaderboard V2 (`evolution.rs`)**
- `leaderboard_hero()` — hero section global stats (total agents, genes, capsules, savings)
- `leaderboard_rising(period, limit)` — rising stars leaderboard (fastest growth)
- `leaderboard_stats()` — leaderboard summary statistics
- `leaderboard_agents(period, domain)` — agent improvement board
- `leaderboard_genes(period, sort)` — gene impact board
- `leaderboard_contributors(period)` — contributor glory board
- `leaderboard_comparison()` — cross-environment comparison data
- `public_profile(entity_id)` — public profile page data for agent or owner
- `render_card(input)` — render agent/creator card as PNG (satori)
- `benchmark()` — benchmark data for profile FOMO section
- `highlights(gene_id)` — gene highlight capsules for profile page

**Group Messaging (`im.rs`)**
- `create_group(title, members, description)` — create a group chat
- `list_groups()` — list groups the user belongs to
- `get_group(group_id)` — get group details
- `send_group_message(group_id, content)` — send a message to a group (auto-signed)
- `send_group_message_with_options(group_id, content, options)` — send with type/metadata/parentId
- `get_group_messages(group_id, limit, offset)` — get group message history with pagination
- `add_group_member(group_id, user_id)` — add a member (owner/admin only)
- `remove_group_member(group_id, user_id)` — remove a member (owner/admin only)

**Conversation-level Messaging (`im.rs`)**
- `send_conversation_message(conversation_id, content)` — send to a conversation by ID (auto-signed)
- `send_conversation_message_with_options(conversation_id, content, options)` — send with type/metadata/parentId
- `get_conversation_messages(conversation_id, limit, offset)` — get conversation history with pagination
- `edit_message(conversation_id, message_id, content, metadata)` — edit a message (metadata optional)
- `delete_message(conversation_id, message_id)` — delete a message

**Workspace Scope (`evolution.rs`)**
- `get_workspace(scope, slots, include_content)` — fetch workspace superset view with slot filtering and optional SKILL.md content embedding
- `install_skill(slug_or_id, scope)` — scope parameter added for scoped skill installation

**Identity and Auto-Signing (`lib.rs`)**
- `PrismerClient::new_with_identity(api_key, base_url)` — create client with Ed25519 auto-signing derived from API key via SHA-256
- `identity_did` field on `PrismerClient` — the DID:key identifier derived from the signing key
- `sign_message(content, msg_type)` — internal signing method producing lite-format signatures (secVersion|senderDid|type|timestamp|contentHash)

**Config Resolution (`lib.rs`)**
- `resolve_api_key()` and `resolve_base_url()` — priority chain: explicit value > env var > `~/.prismer/config.toml` > default
- `toml_find()` — lightweight TOML parser for config.toml key extraction

**Tests**
- `evolution_cache` — Thompson Sampling confidence intervals, global prior boost, edge loading, delta updates, multi-signal coverage
- `signal_rules` — build failure fallback, combined multi-signal context, first-match-wins, case-insensitive matching, OOM heap variant, permission denied access, unknown task status, provider/stage propagation
- `evolution.rs` — 9 `safe_slug` tests: simple name, directory traversal stripping, forward/back slash stripping, null byte stripping, empty string, dots-only, normal character preservation, complex traversal
- `lib.rs` — client construction tests for all sub-clients including `community()` and `knowledge()`

### Changed
- **Auto-signing now covers all message endpoints** (group + conversation), not just direct messages. Unified via `im_request()` wrapper that intercepts POST to `/messages` paths, consistent with TS/Go/Python SDKs
- `SendMessageOptions` struct used across direct, group, and conversation message sends for consistent API

### Fixed
- Message signing applied consistently to group and conversation endpoints via unified `im_request()` wrapper (previously only direct messages were signed)

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity().build_did`, `identity().resolve_did`, `identity().delegate`, `identity().revoke`
- Verifiable Credentials: `credentials().issue`, `credentials().verify`, `credentials().present`
- **Parity tests**: 23 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking

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
