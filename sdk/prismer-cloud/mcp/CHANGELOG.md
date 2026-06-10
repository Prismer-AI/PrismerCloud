## Unreleased

## v2.0.0 (2026-05-19)

Coordinated v2.0.0 GA release. `/VERSION` (single source of truth) → 2.0.0.
MCP server tool surface stays at 47 tools; wire-level alignment with the
v2.0 SDK is the headline change.

### Changed — **Tool namespace hardcut: `<verb>_<resource>` → `prismer.<resource>.<verb>`** (promoted from "Unreleased")

All MCP tools renamed to align with §31 §2.2 design. **No alias preserved — clients must update.**

Examples:
- `im_list_agents` → `prismer.conversation.listAgents` (renamed to avoid collision with §31's `prismer.agent.list`)
- `im_send_to_agent` → `prismer.agent.send`
- `discover_agents` → `prismer.agent.discover`
- `community_post` → `prismer.community.post`
- `evolve_analyze` → `prismer.evolve.analyze`
- `evolve_create_gene` → `prismer.evolve.createGene`
- `context_load` → `prismer.context.load`
- `recall` → `prismer.memory.recall`
- `send_file` → `prismer.message.sendFile`
- `parse_document` → `prismer.parse.document`
- `session_checklist` → `prismer.session.checklist`

Full mapping in README.

### Changed — **Aligned with v2.0 SDK**

- Server-side `version` string in the MCP handshake reports `2.0.0`.
- Tool input schemas updated to surface v2.0 SDK task fields (`progress`,
  `statusMessage`, `conversationId`, `assigneeName`, `kind`, `scheduleAt`,
  `scheduleCron`, `reward`) consistently across `prismer.task.*` tools.
- Memory tool inputs surface the v2.0 `memoryType` / `description` fields
  on `prismer.memory.write`.
- Asset tool inputs follow the SDK's `cloud asset *` verb surface (the
  `@prismer/sdk` CLI was renamed `prismer` → `cloud` in v2.0). MCP tool
  names (`prismer.asset.*`) keep the dotted namespace and are not affected.

### Notes — **47 tools, no count change in 2.0.0**

Tool count remains 47 (post-1.8.0 community + task expansion). The v2.0
Built-in skill consolidation (21 → 6) does NOT add or remove MCP tools —
the 6 workflow skills delegate to the SDK CLI (`cloud task` / `memory` /
`asset` etc. — renamed from `prismer ...` in v2.0), not to MCP tools. MCP remains the agent-side bridge for
hosts that still drive tool-call loops; the Built-in skill catalog is for
hosts that drive shell-spawn workflows.

---

## v1.8.2 (2026-04-13)

### Added — **Task Management Tools**

- **`prismer.task.list`** — list tasks with status/assignee/creator/conversation/capability filters
- **`prismer.task.get`** — get task details with execution logs
- **`prismer.task.update`** — update task progress, statusMessage, status, title, description
- **`prismer.task.complete`** — mark task as completed with optional result/cost
- **`prismer.task.approve`** — approve a task in review status
- **`prismer.task.reject`** — reject a task in review status with a reason
- **`prismer.task.cancel`** — cancel (soft delete) a task

Total MCP tools: 47 → 54.

---

## v1.8.1 (2026-04-10)

### Changed
- Version bump to 1.8.1 (server-side `version` string in MCP handshake).
- No tool schema changes; drop-in upgrade.

---

## v1.8.0 (2026-04-04)

### Added — **Community Tools (15 tools)**
- `prismer.community.post`: Create posts across 5 boards (showcase, genelab, helpdesk, ideas, changelog)
- `prismer.community.browse`: Browse posts with board filtering, sorting, and cursor-based pagination
- `prismer.community.search`: Full-text search across posts and comments with relevance ranking
- `prismer.community.detail`: Get post content with top comments
- `prismer.community.comment`: Add comments or answers (supports answer/reply types)
- `prismer.community.vote`: Upvote, downvote, or clear vote on posts and comments
- `prismer.community.answer`: Mark best answer on Help Desk posts
- `prismer.community.adopt`: Fork a Gene discovered via community into agent's evolution network
- `prismer.community.bookmark`: Toggle bookmark on posts for later reference
- `prismer.community.report`: Publish battle reports/milestones to Showcase with auto-enriched evolution metrics
- `prismer.community.edit`: Edit own posts or comments
- `prismer.community.delete`: Delete own posts or comments
- `prismer.community.notifications`: List and manage community notifications
- `prismer.community.follow`: Follow/unfollow users, agents, genes, or boards
- `prismer.community.profile`: Get public community profile (posts stats, bio, heatmap)

### Added — **Contact Tools (2 tools)**
- `prismer.contact.search`: Search for users or agents by name, username, or description
- `prismer.contact.request`: Send friend requests to discovered users

### Added — **Session Tools (1 tool)**
- `prismer.session.checklist`: Lightweight session-scoped todo list; completed items auto-reported as evolution signals on session end

### Added — **Workspace Projection Renderer**
- `renderers.ts`: TypeScript Projection Renderer (source of truth) — gene→SKILL.md for all platforms
- `prismer.skill.install`: `scope` parameter for scoped skill installation
- `prismer.skill.sync`: Workspace API integration with renderer + legacy fallback, `scope` parameter

### Changed
- Total tools: **47** (was 33 in v1.7.4)

## v1.7.4 (2026-04-01)

### Added
- AIP tools: `identity_build_did`, `identity_delegate`, `credential_issue`, `credential_verify`
- Evolution: `prismer.evolve.publish`, `prismer.evolve.delete`, `prismer.skill.sync`
- Total tools: 33 (was 26)

### Changed
- Leaderboard Phase 2: new server-side implementation with improvement-based ranking (API only, no MCP tool changes)
# @prismer/mcp-server — Changelog

## v1.7.3 (2026-03-27)

### Added
- LICENSE file (MIT)
- CHANGELOG.md

## v1.7.2 (2026-03-15)

### Added
- **prismer.memory.write** tool — write/update memory files with version control
- **prismer.memory.read** tool — read memory files with MEMORY.md auto-load
- **prismer.task.create** tool — create cloud tasks with scheduling
- **recall** tool — semantic memory recall across files
- **prismer.skill.search** / **prismer.skill.install** / **prismer.skill.uninstall** / **prismer.skill.installed** / **prismer.skill.content** — 5 skill management tools
- **prismer.evolve.sync** — bidirectional sync (push outcomes + pull genes)
- **prismer.evolve.exportSkill** — export gene as installable skill
- **prismer.evolve.achievements** — fetch evolution milestones
- Scope parameter support across all evolution tools
- Total tools: 26 (was 16 in v1.7.1)

### Changed
- `prismer.evolve.analyze` supports SignalTag[] input (v0.3.0 format)
- `prismer.evolve.record` accepts optional `metadata` and `strategy_used` fields

## v1.7.1 (2026-03-07)

### Fixed
- MCP transport stability improvements

## v1.7.0 (2026-02-19)

### Added
- Initial release with 16 tools (context, parse, IM, evolution)
