## Unreleased

- (K 空腔闭合) `prismer.message.send`：跨台发送无 active 联系人边时服务端回
  202 `ACTION_DEFERRED`——工具输出改为「Message deferred — awaiting contact
  approval (approvalId: …)」，不再误报 "sent"；工具描述补外部联系人边
  （`cloud im contacts --external`）与 deferred 语义一句话。

- (agent-name-unification §7 follow-up) `lib/client.ts` 的 X-IM-Agent 值形态：
  优先 `im:<PRISMER_AGENT_IM_USER_ID>`（daemon 在 service spawn 时注入的自证
  id），回落 `PRISMER_AGENT_USERNAME`，再回退 legacy `PRISMER_IM_AGENT`。
  服务端 middleware 已接受 `im:<cuid>` 前缀（Wave1 B1/B5），本改消除跨
  workspace 同名 slug 时 username 腿的非确定性归属；长驻进程旧 env 仍靠
  respawn 换新 env。

- Aligned package and server-reported metadata with monorepo version `2.2.40`
  for the immutable sandbox/runtime release coordinate; no npm publication is
  implied.
- Aligned package and server-reported metadata with monorepo version `2.2.39`
  for the immutable sandbox/runtime release coordinate; no npm publication is
  implied.

## 2.2.5 (2026-08-02)

- Moved the MCP package under the Cloud product root while preserving the
  published package name `@prismer/mcp-server`.
- Aligned package and server-reported versions with the root `/VERSION` source
  of truth and the Cloud release scope.

### Changed — `prismer.skill.install` / `prismer.skill.uninstall` 进默认消费型角色 allowlist（product204 ⑥a）

- 默认 assistant（executor）与 CEO（orchestrator）role-runtime-policy 的
  `skills` 授权面新增 `install` / `uninstall` verb，投影出
  `prismer.skill.install` / `prismer.skill.uninstall`。普通用户的消费型 agent
  自装 marketplace skill 时不再被 `POST /api/im/skills/:slug/install` 的
  toolset 门（`requireAgentToolAllowed`）挡成 403。工具本身无改动，仅默认可用性。
- 受限角色（coding 净身 / denylist）不受影响——其治理走 `nativeSkillScope` →
  daemon `disabled_toolsets`，与该 cloud 侧 install 门是正交轴。

### Added — `prismer.config.request_skill_config`（product204/09 §2.4）

- 新工具：skill 声明的 required 配置缺失时，agent 以 `{skill_slug, keys[],
  task_id?, conversation_id?, workspace_id?}` 发起问询（打
  `POST /api/im/skill-config/requests`，落 approval 轨道 category
  `skill-config`，intentHash 去重），随后停止当前回合；owner 在 agent profile
  设置面补值保存后平台自动 redispatch。`task_id` 缺省时回退
  `PRISMER_TASK_ID` / `PRISMER_RUN_ID` env。
- `lib/client.ts::inferToolNameForRequest` 增该端点映射（allowlist 归因）。

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
