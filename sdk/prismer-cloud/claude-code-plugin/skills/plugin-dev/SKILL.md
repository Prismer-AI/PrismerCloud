---
name: plugin-dev
description: Prismer Evolution Plugin 开发指南 — 快速迭代 hook/skill、调试、日志查看、测试、发布全流程
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# Prismer Plugin 开发指南

本文档是插件开发的完整参考。涵盖环境搭建、快速迭代、调试排查、测试、发布全流程。

---

## 1. 快速开始 — Dev Mode

**不要用 npm publish + /plugin install 的循环。** 使用本地开发模式：

```bash
cd sdk/prismer-cloud/claude-code-plugin
./scripts/dev.sh
```

这做了什么：
- 用 `claude --plugin-dir .` 直接加载本地文件（不走 npm）
- 使用独立的 `.dev-cache/` 目录（不污染生产 cache）
- 自动设 `PRISMER_LOG_LEVEL=debug`

**修改 hook 后怎么生效：**

| 你改了什么 | 怎么生效 |
|-----------|---------|
| hook script (`scripts/*.mjs`) | 在 Claude Code 里输入 `/clear`（2 秒） |
| skill 内容 (`skills/*/SKILL.md`) | `/clear` 或 `/reload-plugins` |
| hooks.json (新增/删除 hook) | 退出 Claude Code 重新运行 `./scripts/dev.sh` |
| .mcp.json | 不影响（dev mode 不加载 .mcp.json） |

**迭代循环：** 改代码 → `/clear` → 测试 → 看日志 → 再改。每次 2 秒，不需要装卸。

---

## 2. Hook 隔离测试

不需要启动完整 Claude Code 就能测试单个 hook：

```bash
# 测试 SessionStart (模拟 startup 事件)
node scripts/test-hook.mjs session-start.mjs

# 测试 SessionStart (模拟 resume 事件)
node scripts/test-hook.mjs session-start.mjs --event resume

# 测试 PostToolUse (模拟 Bash 工具完成)
echo '{"tool_name":"Bash","tool_input":{"command":"npm run build"},"tool_result":{"stdout":"error TS2345"}}' | \
  node scripts/test-hook.mjs post-bash-journal.mjs

# 测试 PreToolUse stuck detection (模拟重复错误)
echo '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}' | \
  node scripts/test-hook.mjs pre-bash-suggest.mjs

# 带自定义环境变量
node scripts/test-hook.mjs session-start.mjs --env PRISMER_API_KEY=sk-prismer-test-xxx

# 详细输出（含环境变量）
node scripts/test-hook.mjs session-start.mjs --verbose
```

输出说明：
- `[STDOUT]` — 会注入到 Claude 上下文的内容
- `[STDERR]` — 调试日志（不显示给 Claude）
- `[Exit: N]` — 退出码（0 = 正常）
- `[Cache files]` — 测试后生成的缓存文件

---

## 3. 日志与调试

### 3.1 查看调试日志

```bash
# Dev mode 日志
tail -f .dev-cache/prismer-debug.log

# 格式化输出（更可读）
tail -20 .dev-cache/prismer-debug.log | while IFS= read -r line; do
  echo "$line" | node -e "
    const l=JSON.parse(require('fs').readFileSync(0,'utf8').trim());
    console.log(\`[\${l.ts.slice(11,19)}] \${l.lvl.toUpperCase()} [\${l.hook}] \${l.msg}\`,
      Object.fromEntries(Object.entries(l).filter(([k])=>!['ts','lvl','hook','msg'].includes(k))))
  " 2>/dev/null
done
```

在 Claude Code 中也可以用 `/prismer:debug-log` 查看。

### 3.2 日志级别

通过 `PRISMER_LOG_LEVEL` 环境变量控制：

| 级别 | 内容 | 场景 |
|------|------|------|
| `debug` | 所有操作（含跳过的 trivial 命令） | Dev mode（默认） |
| `info` | 关键操作（sync/memory/gene/signal） | 生产（默认） |
| `warn` | 仅失败和超时 | 排查特定问题 |
| `error` | 仅错误（同时输出到 stderr） | 最低噪音 |

### 3.3 常见问题速查

```
# 进化同步不工作？
grep sync-pull .dev-cache/prismer-debug.log

# Stuck detection 没触发？
grep stuck .dev-cache/prismer-debug.log

# Gene feedback 丢了？
grep gene-feedback .dev-cache/prismer-debug.log

# Memory 加载失败？
grep memory .dev-cache/prismer-debug.log

# 看某个 hook 的所有日志
grep '"hook":"session-start"' .dev-cache/prismer-debug.log
```

### 3.4 健康报告

SessionStart 完成后会输出一行健康摘要：

```
[Prismer] ✓ scope:myapp | genes:5 | memory:3 files | skills:2 synced | sync:ok | 340ms
```

告警时：

```
[Prismer] ⚠ scope:myapp | sync:timeout | 2100ms
```

字段含义：
- `scope` — 当前项目 scope（来自 package.json name 或 git remote）
- `genes` — 拉取到的 proven 策略数量
- `memory` — 记忆文件数量
- `skills` — 本次同步的技能数
- `sync` — 同步状态（ok/timeout/error/skip）

---

## 4. 架构速览

### 4.1 Plugin 组件

```
plugin/
├── hooks/hooks.json     → 8 个 hook 定义，Claude Code 按事件触发
├── scripts/*.mjs        → Hook 实现（独立 Node 进程，stdin/stdout 通信）
├── scripts/lib/          → 共享工具（config 解析、signal 模式、日志）
├── skills/*/SKILL.md    → Skill 定义（Claude 读取后决定调用工具）
├── .mcp.json            → MCP server 配置（不随 npm 分发，可选安装）
└── .cache/              → 运行时数据（journal、cursor、pending）
```

### 4.2 Hook 数据流

```
SessionStart ──→ sync pull + memory + skills ──→ 输出被动上下文
     │
     ▼ (session 进行中)
PreToolUse(Bash) ──→ 读 journal 计信号次数 ──→ ≥2 次? 查进化网络
PostToolUse(*) ──→ 写 journal + 检测错误信号 + gene feedback
PostToolUseFailure ──→ 提取失败信号 + gene feedback
     │
     ▼ (session 结束)
Stop ──→ 有进化价值? ──→ block + 输出 review 指令 (Claude LLM 做抽象)
SessionEnd ──→ async push gene feedback + 信号 (Stop 的 fallback)
```

### 4.3 Hook 间通信文件

| 文件 | 写入者 | 读取者 | 用途 |
|------|--------|--------|------|
| `session-journal.md` | post-bash-journal, post-tool-failure | pre-bash-suggest, session-stop, session-end | Session 操作记录 |
| `pending-suggestion.json` | pre-bash-suggest | post-bash-journal, post-tool-failure | 跟踪 gene 建议 → 反馈 |
| `sync-cursor.json` | session-start, session-end | session-start | 进化网络同步游标 |
| `last-block-{scope}.json` | session-stop | session-stop | Per-scope 冷却 (1h) |
| `injected-genes.json` | session-start | session-end | 跟踪注入的 gene |
| `sync-retry-queue.json` | session-end | session-start | 失败重试队列 |
| `prismer-debug.log` | 所有 hook (via logger) | 开发者 | 调试日志 |

---

## 5. 修改指南

### 5.1 新增 Signal 模式

编辑 `scripts/lib/signals.mjs`，在 `SIGNAL_PATTERNS` 数组中添加：

```javascript
{ type: 'error:your_new_signal', pattern: /your regex here/i },
```

测试：

```bash
echo '{"tool_name":"Bash","tool_result":{"stdout":"your error output"}}' | \
  node scripts/test-hook.mjs post-bash-journal.mjs
# 检查 journal 是否记录了新 signal
cat .dev-cache/session-journal.md
```

### 5.2 新增 Hook

1. 在 `scripts/` 下创建 `your-hook.mjs`
2. 在 `hooks/hooks.json` 中添加定义
3. 退出 dev mode 重新运行 `./scripts/dev.sh`

Hook 模板：

```javascript
#!/usr/bin/env node
import { readFileSync } from 'fs';
import { createLogger } from './lib/logger.mjs';

const log = createLogger('your-hook');

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}

log.info('start', { event: input.type });

// 你的逻辑...

// 输出到 Claude 上下文（可选）
process.stdout.write('Your context injection here');
```

### 5.3 新增 Skill

1. 创建 `skills/your-skill/SKILL.md`
2. 用 `/clear` 加载

Skill 是给 Claude 看的文档，告诉它何时、如何调用工具。不是可执行代码。

---

## 6. 测试

```bash
# 运行全部测试
cd sdk/prismer-cloud/claude-code-plugin
npm test

# Watch mode
npm run test:watch

# 测试单个 hook (隔离)
node scripts/test-hook.mjs session-start.mjs
```

---

## 7. 发布

```bash
# 1. 更新版本
# package.json 的 version
# CHANGELOG.md 加条目

# 2. 构建验证
npm test

# 3. 发布到 npm
npm publish

# 4. 用户安装
# /plugin install prismer@prismer-cloud    (hooks + skills only)
# claude mcp add prismer -- npx -y @prismer/mcp-server@X.Y.Z  (可选 MCP)
```

**注意：** `.mcp.json` 不随 npm 包分发。MCP 是可选增强，通过 setup skill 引导安装。

---

## 8. MCP 与 Hooks 的关系

| 维度 | Hooks | MCP |
|------|-------|-----|
| 触发方式 | Claude Code 自动触发（事件驱动） | Claude 主动调用（tool call） |
| 安装方式 | 随插件自动安装 | 单独 `claude mcp add` |
| 依赖关系 | 独立工作，不需要 MCP | 不需要 hooks |
| 数据流方向 | Hook → stdout → Claude（被动注入） | Claude → MCP tool → API（主动操作） |
| 失败影响 | 静默降级，不影响 session | 工具调用失败，Claude 可重试 |

**开发建议：** 优先用 hook 实现（自动、零成本）。MCP tool 仅在需要 Claude 主动操作时使用（创建 gene、写 memory、搜索 skill）。
