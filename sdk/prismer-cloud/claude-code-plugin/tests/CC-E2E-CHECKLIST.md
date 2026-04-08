# CC E2E Test Checklist — Prismer Plugin v1.8.0

## Prerequisites

```bash
cd sdk/prismer-cloud/claude-code-plugin
export PRISMER_API_KEY="sk-prismer-live-8203d352cc8d2b41d17efe877b4b9c9420afd1e89666b5b0ae7161e80c39acd2"
export PRISMER_BASE_URL="https://cloud.prismer.dev"
```

---

## Round 1: 功能验证 (--plugin-dir)

### Phase 0: 环境加载

```bash
# 启动 dev mode
./scripts/dev.sh
```

在 CC session 中验证：
- [ ] `hooks.json` 7 个事件被加载（SessionStart/PreToolUse/PostToolUse/PostToolUseFailure/SubagentStart/Stop/SessionEnd）
- [ ] `/prismer:` Tab 补全显示 12 个 skills
- [ ] MCP tools 可用（输入："list your prismer MCP tools"）

### Phase 1: SessionStart

启动 session 后立即检查：

```bash
# 在 session 中运行：
! tail -5 .dev-cache/prismer-debug.log
```

- [ ] 日志包含 `"hook":"session-start"` 条目
- [ ] 无 error 级别日志
- [ ] 如果有 API key：日志显示 sync 结果（genes count）

### Phase 2: PreToolUse:Bash

在 session 中执行一条命令（让 Claude 运行它）：

> "请执行 `ls /tmp` 命令"

```bash
# 验证：
! grep pre-bash-suggest .dev-cache/prismer-debug.log | tail -3
```

- [ ] 日志有 `"hook":"pre-bash-suggest"` 条目
- [ ] 如果有匹配 gene：Claude 输出包含 evolution hint

### Phase 3: PostToolUse + PostToolUseFailure

让 Claude 执行一条会失败的命令：

> "请执行 `cat /nonexistent_file_xyz`"

```bash
# 验证：
! grep -E 'post-tool-failure|post-bash-journal' .dev-cache/prismer-debug.log | tail -5
```

- [ ] 日志有 `"hook":"post-tool-failure"` 条目（失败命令）
- [ ] 日志有 `"hook":"post-bash-journal"` 条目（成功命令，来自 Phase 2）
- [ ] `session-journal.md` 存在：`! ls -la .dev-cache/session-journal.md`

### Phase 4: Skills

依次在 session 中输入：

1. `/prismer:evolve-analyze` → 应加载 skill 内容
2. `/prismer:debug-log` → 应显示最近日志
3. `/prismer:community-browse` → 应加载社区浏览 skill

- [ ] 三个 skills 都成功加载并执行

### Phase 5: MCP Tools

输入以下 prompts（让 Claude 调用 MCP tools）：

1. > "用 evolve_analyze 工具分析 error:timeout 信号，scope 设为 global"
2. > "用 community_browse 工具浏览最新社区帖子"
3. > "用 memory_write 工具写一个测试记忆文件，路径为 _test/cc-e2e.md，内容为 CC E2E test"

- [ ] `evolve_analyze` 返回有效的 gene 推荐或 no_match
- [ ] `community_browse` 返回帖子列表
- [ ] `memory_write` 成功创建文件

清理测试记忆：
> "用 memory_read 找到刚才创建的 _test/cc-e2e.md，然后删除它"

### Phase 6: Stop + SessionEnd

输入 `/exit` 结束 session。

```bash
# Session 结束后立即运行验证器：
node tests/verify-cc-session.mjs .dev-cache
```

- [ ] 验证器全部 PASS
- [ ] 日志有 `"hook":"session-stop"` 和 `"hook":"session-end"` 条目
- [ ] 冷却文件存在：`ls .dev-cache/last-block-*`

### Phase 6b: 长 session 冷却验证

再次启动 session（`./scripts/dev.sh`），快速做一些操作然后 `/exit`。

```bash
# 检查第二次 Stop 是否被冷却跳过：
grep -c session-stop .dev-cache/prismer-debug.log
# 应该看到两次，但第二次日志应包含 cooldown/skip 信息
```

- [ ] 短时间内第二次 Stop 被冷却跳过（日志有 cooldown 标记）

---

## Round 2: 安装路径验证

```bash
bash tests/verify-install.sh
```

- [ ] 全部 PASS

---

## 自动验证器

任何时候都可以运行：

```bash
# dev mode:
node tests/verify-cc-session.mjs .dev-cache

# 默认路径（CLAUDE_PLUGIN_DATA）:
node tests/verify-cc-session.mjs
```

---

## 结果记录

| Phase | 状态 | 备注 |
|---|---|---|
| Phase 0 环境加载 | | |
| Phase 1 SessionStart | | |
| Phase 2 PreToolUse | | |
| Phase 3 PostToolUse | | |
| Phase 4 Skills | | |
| Phase 5 MCP Tools | | |
| Phase 6 Lifecycle | | |
| Phase 6b 冷却 | | |
| Round 2 安装路径 | | |
