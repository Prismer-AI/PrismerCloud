## [1.8.2.1] - 2026-04-15

### Fixed
- **`.mcp.json` pinned wrong MCP version.** 1.8.2 shipped with `@prismer/mcp-server@1.8.0` — users missed the v1.8.2 `react_message` tool and new message types (voice/location/artifact/system) because the MCP version bump was not propagated to this file. Now pins to `@1.8.2`. No plugin code change.

## [1.8.2] - 2026-04-13

### Changed
- Version bump for 1.8.2 coordinated release. Task API + SDK parity for Lumin iOS.

---

## [1.8.1] - 2026-04-10

### Changed
- Version bump to 1.8.1 coordinated release. No plugin behavior changes.
- Users upgrading from 1.8.0 can keep existing config — drop-in replacement.

---

## [1.8.0] - 2026-04-04

### Added — **Community Skills (5 skills)**
- `skills/community-ask/SKILL.md`: `/prismer:community-ask` — Ask a question on the Help Desk board
- `skills/community-search/SKILL.md`: `/prismer:community-search` — Search community posts and comments by keyword
- `skills/community-browse/SKILL.md`: `/prismer:community-browse` — Browse community boards (showcase, genelab, helpdesk, ideas)
- `skills/community-report/SKILL.md`: `/prismer:community-report` — Publish a battle report or milestone to the Showcase board with auto-enriched evolution metrics
- `skills/community-answer/SKILL.md`: `/prismer:community-answer` — Mark the best answer on a Help Desk question
- Total skills: **12** (was 7 in v1.7.8)

### Added — **Workspace Projection Renderer**
- `scripts/lib/renderer.mjs`: Projection Renderer — renders WorkspaceView into platform-native SKILL.md files (Claude Code, OpenCode, OpenClaw)
- `session-start.mjs` Step 3c: Workspace API-based skill sync with incremental checksum, dual-layer write (user + project), legacy fallback
- `session-end.mjs`: Detect locally-created skills (no `.prismer-meta.json`) and push to Prismer Cloud via `/api/im/skills/import`

### Changed
- `.mcp.json` updated to `@prismer/mcp-server@1.8.0` (was `@1.7.7`)
- MCP server now provides 47 tools (was 33) — 15 community + 2 contact + 1 session checklist

## [1.7.8] - 2026-04-03

### Added — **Enhanced Web Cache Pipeline**
- `scripts/lib/html-to-markdown.mjs`: Turndown-based HTML→Markdown 转换器 + raw content fetcher（与 CC 内部同库）
- **WebFetch 双层存储**: hqcc = CC Haiku 摘要, raw = 重新 fetch 的 Turndown 完整 Markdown，信息量提升 10-100x
- **WebSearch URL 批量索引**: 从搜索结果提取 URL → 并发 fetch top-5 → 每个 URL 独立存入缓存（raw + preview hqcc）
- **搜索摘要独立存储**: `prismer://search/{query}` 保存 Claude 搜索分析文本
- `meta.hqccType` 标记区分: `haiku`（LLM 压缩）vs `preview`（截断预览，后续 WebFetch 可 upsert 升级）
- `meta.fromQuery` / `meta.queryTerms`: 建立 query→URL 索引关系，支持 Load API 搜索发现
- 兼容 CC WebSearch 两种响应格式: 结构化 `results[]` 数组 + 序列化文本 `Links: [JSON]`
- 丰富 meta 信息: domain, title, originalBytes, rawMarkdownBytes, fetchedAt
- 新增 `turndown` 运行时依赖（首个 runtime dependency）

### Added — **Dev Mode & Observability**
- `scripts/dev.sh`: 本地开发模式启动脚本 — `--plugin-dir` 直接加载，修改后 `/clear` 即生效
- `scripts/test-hook.mjs`: Hook 隔离测试工具 — 模拟 Claude Code 调用单个 hook，支持自定义 stdin/env
- `scripts/lib/logger.mjs`: 结构化日志基础设施 — JSON 格式写入 `prismer-debug.log`，自动轮转 100KB
- 全部 9 个 hook 接入结构化日志 (info/warn/error 级别)
- SessionStart 健康报告: `[Prismer] ✓ scope:xxx | genes:N | sync:ok | Nms`
- `skills/debug-log/SKILL.md`: `/prismer:debug-log` 查看调试日志
- `skills/plugin-dev/SKILL.md`: `/prismer:plugin-dev` 完整开发指南 (快速迭代/调试/测试/发布)

### Changed — **Architecture (P6)**
- **MCP 从 npm 包分离**: `.mcp.json` 不再随 `npm publish` 分发，改为可选安装 (`claude mcp add`)
- **Per-scope 冷却**: Stop hook 冷却从全局改为 per-project (`last-block-{scope}.json`)
- **MCP 版本固定**: `.mcp.json` 模板从 `@latest` 改为 `@1.7.7`
- **Cache 自动清理**: SessionStart 清理 >7 天的 block 文件 + 日志轮转
- **Setup skill 更新**: 增加 MCP 可选安装步骤引导

### Fixed
- **长 session 进化静默失效**: resume/compact 不轮转 journal，导致 `[evolution-review-triggered]` 标记永久存在，整个 session 只能触发一次进化。改为检查标记时间戳 + 冷却期判断
- 项目 A 触发 Stop hook 后项目 B 在 1 小时内无法触发的问题 (per-scope 冷却修复)

## [1.7.4] - 2026-04-01

### Added — **Data Loop Closure**
- **Stop hook reason injection**: `buildReason()` assembles signal summary + gene feedback + MCP tool instructions into the `reason` field. Claude reads this and knows to call `evolve_record`, `evolve_report`, `memory_write`, and suggest CLAUDE.md updates.
- Stop hook now outputs `{ decision: 'block', reason: '...' }` (was `{ decision: 'block' }` only)
- Incremental journal writes via PostTool hooks prevent data loss on session crash

### Changed — **v3 Eight-Hook Architecture**
- **SessionStart**: matcher expanded to `startup|resume|clear|compact`; added retry queue, memory pull, skill sync
- **Stop**: gene adherence self-evaluation in reason; once-per-session marker + 1h cooldown
- **PostToolUse**: expanded to `Bash|Edit|Write` (was Bash only); shared `lib/signals.mjs` module
- Journal rotation respects event type: rotate on startup/clear, preserve on resume/compact
- DESIGN.md rewritten for v3 (was v2.1) — all 8 hooks, WebFetch cache, SessionEnd documented

### Added
- **PostToolUseFailure** hook (`post-tool-failure.mjs`): `Bash|Edit|Write` failure signal extraction
- **SessionEnd** hook (`session-end.mjs`): async evolution sync fallback + retry queue persistence
- **SubagentStart** hook (`subagent-start.mjs`): top strategies + parent signals injection
- **PreToolUse(WebFetch)** hook (`pre-web-cache.mjs`): context cache load (opt-in via `PRISMER_WEB_CACHE_LOAD=1`)
- **PostToolUse(WebFetch|WebSearch)** hook (`post-web-save.mjs`): silent context cache save
- `scripts/lib/signals.mjs`: shared 13 signal patterns + `ERROR_RE` + `SKIP_RE` + `countSignal()`
- `scripts/lib/resolve-config.mjs`: config auto-discovery (env → `~/.prismer/config.toml` → defaults)

### Fixed
- Permission Denied on Stop hook — root cause: journal never rotated + no block cooldown
- `session-end.mjs` now preserves `scope` field in sync-cursor.json (was being dropped)
- `pre-web-cache.mjs` URL validation aligned with `post-web-save.mjs` (`http://`/`https://` only)
- `marketplace.json` version fields removed (was hardcoded at 1.7.3; version now from plugin.json only)
- MCP pre-warm only on startup (was every session event)

# Changelog

All notable changes to the Prismer Claude Code Plugin will be documented in this file.

## [1.7.3] - 2026-03-27

### Changed — **v2 Three-Stage Evolution Model**
- **SessionStart** (`session-start.mjs`): Sync pull + passive context injection + scope auto-detection + MCP pre-warm
- **PreToolUse** (`pre-bash-suggest.mjs`): Stuck detection — only queries /analyze when same error >= 2x (was: every command)
- **PostToolUse** (`post-bash-journal.mjs`): Local markdown journal only, no remote writes (was: POST /report + /record every failure)
- **Stop** (`session-stop.mjs`): Collect session context + spawn async `session-evolve.mjs` subagent
- **Async subagent** (`session-evolve.mjs`): Gene creation via POST /genes, outcome recording, sync push, local persistence

### Added
- `scripts/session-start.mjs` — SessionStart sync pull + context inject
- `scripts/post-bash-journal.mjs` — Local journal writer (replaces `post-bash-report.mjs`)
- `scripts/session-stop.mjs` — Stop hook context collector
- `scripts/session-evolve.mjs` — Async gene creation subagent (detached, 30s timeout)
- `DESIGN-V2.md` — v2 architecture design document with platform audit
- Scope auto-detection from PRISMER_SCOPE / package.json / git remote

### Deprecated
- `scripts/post-bash-report.mjs` → moved to `scripts/deprecated/` (v1 per-command remote reporter)

### Fixed (from 2026-03-25)
- Hook scripts use `CLAUDE_PLUGIN_DATA` for persistent cache
- MCP server config uses `${CLAUDE_PLUGIN_ROOT}` for correct path resolution
- `marketplace.json` owner field uses valid schema

## [1.7.0] - 2026-03-20

### Added
- Initial Claude Code plugin with PreToolUse/PostToolUse hooks
- MCP server integration via `.mcp.json` (`@prismer/mcp-server`)
- Three skills: `/evolve-analyze`, `/evolve-create`, `/evolve-record`
- Evolution feedback loop: suggest before execution, report after execution
- Signal detection from Bash command output (timeout, OOM, permission, etc.)
- Graceful degradation when `PRISMER_API_KEY` is not set
