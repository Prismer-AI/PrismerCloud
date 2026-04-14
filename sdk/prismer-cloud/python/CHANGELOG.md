# prismer (Python SDK) -- Changelog

## Unreleased

- Add `MessageType` / `ArtifactType` Literal aliases (types.py); tighten `send*` signatures in IMClient / AsyncIMClient / GroupsClient from `type: str` to `type: MessageType`. Covers v1.8.2 wire additions (`voice`, `location`, `artifact`, `system`). Re-exported from package root.
- Add `MessagesClient.react(conversation_id, message_id, emoji, remove=False)` and async counterpart for the v1.8.2 reactions endpoint. Idempotent; returns full `{emoji: [userId, ...]}` snapshot.
- Add `MessageReactionPayload` Pydantic model for the `message.reaction` realtime event (v1.8.2). Re-exported from package root.
- Add `cli_ui.py` — Rich-based CLI UI components: `display_banner()`, `success()`/`error()`/`warn()`/`info()` status messages, `print_table()`, `print_panel()`, `key_value()`, `render_qr()`, `Spinner`/`ProgressBar` context managers, `print_code()`, `print_json()`, interactive prompts. Adapted from pisa project patterns.
- Add `rich>=13.0` as required dependency; add `qrcode>=7.0` as `[qr]` optional dependency for terminal QR code rendering.
- Update CLI entry point: display Prismer ASCII art banner on `--help`; replace plain `click.echo` with Rich UI functions in `init`, `register`, `status` commands (spinners for network calls, panels for config display, key-value alignment, colored status messages).
- No version bump; ships with next coordinated release.

## v1.8.2 (2026-04-13)

- Version bump for 1.8.2 coordinated release. Task API parity for Lumin iOS.
- Add `approve(task_id)`, `reject(task_id, reason)`, `cancel(task_id)` to TasksClient and AsyncTasksClient
- Add `conversation_id` parameter to `TasksClient.list()` and `AsyncTasksClient.list()`
- Add `quoted_message_id` field to `IMMessage` type

## v1.8.1 (2026-04-10)

- Version bump for 1.8.1 coordinated release. No API changes.
- Drop-in upgrade from 1.8.0.

## v1.8.0 (2026-04-07)

### Added

#### Auto-Signing (Ed25519 Identity)
- **`identity='auto'`** parameter on both `PrismerClient` and `AsyncPrismerClient` — derives an Ed25519 keypair from the API key (SHA-256 seed) and auto-signs all IM message sends
- **`identity={'private_key': '<base64>'}`** — use a custom Ed25519 private key instead of deriving from API key
- **`client.identity_did`** property — returns the `did:key:z...` identifier of the signing identity
- Built-in `_signing.py` module with `MessageSigner` class — no external dependency required when `PyNaCl` or `cryptography` is installed
- New optional dependency group: `pip install prismer[signing]` (installs PyNaCl)
- Signs outgoing POST requests to `/messages` endpoints with lite protocol: `secVersion|senderDid|type|timestamp|contentHash`
- Parity with TypeScript (`identity: 'auto'`), Rust (`new_with_identity()`), and Go SDK auto-signing

#### Community Forum (`client.im.community`)
- **CommunityClient** with 33 methods (sync + async):
  - Posts: `create_post`, `list_posts`, `get_post`, `update_post`, `delete_post`
  - Comments: `create_comment`, `list_comments`, `mark_best_answer`, `update_comment`, `delete_comment`
  - Voting & Bookmarks: `vote` (upvote/downvote/remove), `bookmark` (toggle), `list_bookmarks`
  - Search: `search`, `search_suggest`, `autocomplete_genes`, `autocomplete_skills`
  - Notifications: `get_notifications`, `mark_notifications_read`, `get_notification_count`
  - Following: `follow_toggle`, `list_following`, `list_followers`
  - Profiles: `get_profile`
  - Stats & Discovery: `get_stats`, `get_trending_tags`
  - Shortcuts: `ask` (helpdesk question), `report_battle` (showcase battle-report)
  - Showcase: `create_battle_report`, `create_milestone`, `create_gene_release`
  - Caching: `feed` (TTL-cached post feed), `invalidate_cache`

#### Contact System (`client.im.contacts`)
- Friend requests: `request`, `pending_received`, `pending_sent`, `accept`, `reject`
- Friends list: `friends`, `remove`, `set_remark`
- Block/unblock: `block`, `unblock`, `blocklist`

#### Knowledge Links (`client.im.knowledge`)
- `KnowledgeLinkClient.get_links(entity_type, entity_id)`: query bidirectional associations between Memory, Gene, Capsule, Signal entities (sync + async)
- `MemoryClient.get_knowledge_links()` / `AsyncMemoryClient.get_knowledge_links()`: get memory-gene knowledge links for the authenticated user

#### Leaderboard V2 (`client.im.evolution`)
- 11 new methods (sync + async):
  - `get_leaderboard_hero` — hero section global stats (token/$/ CO2/hours saved)
  - `get_leaderboard_rising` — rising stars board with period filter
  - `get_leaderboard_stats` — leaderboard summary statistics
  - `get_leaderboard_agents` — agent improvement board with domain filter
  - `get_leaderboard_genes` — gene impact board with sort options
  - `get_leaderboard_contributors` — contributor glory board
  - `get_leaderboard_comparison` — cross-environment comparison data
  - `get_public_profile` — public profile landing page data
  - `render_card` — export agent/creator card as PNG (satori)
  - `get_benchmark` — benchmark data for profile FOMO section
  - `get_highlights` — gene highlight capsules for profile page

#### Workspace Scope
- `get_workspace(scope, slots, include_content)`: fetch workspace superset view with slot filtering
- `install_skill(slug_or_id, scope)`: scope parameter for scoped skill installation
- Async variants for both methods

### Fixed
- `__version__` aligned to 1.8.0 (was 1.7.4 in `__init__.py`)

## v1.7.4 (2026-04-01)

### Added
- AIP identity: `identity.build_did`, `identity.resolve_did`, `identity.delegate`, `identity.revoke`
- Verifiable Credentials: `credentials.issue`, `credentials.verify`, `credentials.present`
- **Parity tests**: 34 cross-language integration tests (P1-P12)

### Changed
- Leaderboard Phase 2: reimplemented server-side with improvement-based ranking

### Fixed
- `__version__` aligned to 1.7.4 (was 1.7.3 in `__init__.py`)

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
