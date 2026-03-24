# Prismer Evolution — Claude Code Plugin

> **Version:** 0.1 (Draft)
> **Date:** 2026-03-20
> **Status:** Design
> **Goal:** 让 Claude Code 在日常编码过程中自动参与进化循环，形成高频自学习回路

---

## 1. 核心理念

Claude Code 每天执行数百次任务（编码、调试、部署、测试），每次失败和成功都是进化信号。当前这些信号被丢弃了——agent 遇到 error 只是重试或换方案，不会记录"什么策略在什么场景下有效"。

**Prismer Evolution Plugin 将 Claude Code 的每次任务执行变成进化数据点：**

```
Claude Code 日常工作循环:

  接到任务 → 执行 → 遇到错误
       │                │
       │                ▼
       │    prismer evolve analyze ← 自动触发
       │         (有推荐 gene？)
       │              │
       │         ┌────┴────┐
       │         ▼         ▼
       │    有推荐      无推荐
       │    执行策略    自行解决
       │         │         │
       │         ▼         ▼
       │    prismer evolve record ← 自动触发
       │    (记录成功/失败)
       │              │
       └──────────────┘
              ▼
         下次同类错误 → 直接获得最佳策略
```

**关键：零额外操作。** Plugin 通过 hook 自动在错误/完成时触发进化 API。开发者不需要手动调 `prismer evolve`。

---

## 2. 集成方式

### 2.1 Claude Code Hooks

Claude Code 支持 [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — 在特定事件触发 shell 命令：

```json
// ~/.claude/hooks.json
{
  "hooks": {
    "on_tool_error": [
      {
        "command": "prismer evolve report --error \"$ERROR\" --task \"$TASK\" --status failed --provider claude-code --stage \"$TOOL\" --severity high",
        "timeout": 5000
      }
    ],
    "on_task_complete": [
      {
        "command": "prismer evolve report --task \"$TASK\" --status success --provider claude-code --stage task --score 0.9",
        "timeout": 5000
      }
    ]
  }
}
```

### 2.2 CLAUDE.md 集成（推荐方案）

更深度的集成：在项目 CLAUDE.md 中引导 Claude Code 主动使用进化 API：

```markdown
## Evolution (自动学习)

当你遇到以下情况时，使用 prismer CLI 参与进化网络：

1. **遇到错误前先查询：**
   prismer evolve analyze --error "<error message>" --provider claude-code --stage <当前步骤>
   如果返回了推荐的 gene strategy，优先尝试该策略。

2. **解决问题后记录：**
   prismer evolve record -g <gene_id> -o success --score <0-1> --summary "<简述>"

3. **发现新的有效模式时创建 gene：**
   prismer evolve create -c repair -s '["error:xxx"]' --strategy "步骤1" "步骤2" -n "模式名称"
```

### 2.3 MCP Server 集成（最深度）

Claude Code 原生支持 MCP。Prismer MCP Server 已有 `evolve_analyze`, `evolve_record`, `evolve_create_gene` tools。

```json
// ~/.claude/mcp_servers.json
{
  "prismer": {
    "command": "npx",
    "args": ["-y", "@prismer/mcp-server"],
    "env": {
      "PRISMER_API_KEY": "sk-prismer-..."
    }
  }
}
```

Claude Code 会自动发现这些 tools 并在适当场景使用。

---

## 3. 自动化级别

| 级别 | 方式 | 触发 | 需要配置 | 数据频率 |
|------|------|------|---------|---------|
| **L0: 手动** | CLI 命令 | 开发者手动执行 | `npm i -g @prismer/sdk` | 低 |
| **L1: 提示** | CLAUDE.md 引导 | Claude Code 主动调 CLI | CLAUDE.md 模板 | 中 |
| **L2: Hook** | hooks.json | 错误/完成自动触发 | hooks.json 配置 | 高 |
| **L3: MCP** | MCP Server | Claude Code 自主判断 | mcp_servers.json | 最高 |

**推荐：L1 + L3 组合。** CLAUDE.md 提供指引，MCP Server 提供能力。

---

## 4. 数据流

```
Claude Code Session
  │
  ├─ Task: "Fix the login timeout bug"
  │
  ├─ Step 1: Read code → understand
  │
  ├─ Step 2: Try fix A → error: "Connection refused on port 5432"
  │    └─ [AUTO] evolve_analyze({error, provider:"postgres", stage:"db_connect"})
  │         → Gene: "Connection Pool Recovery" (conf: 0.72)
  │         → Strategy: ["Check connection pool size", "Increase max_connections", ...]
  │
  ├─ Step 3: Apply gene strategy → success!
  │    └─ [AUTO] evolve_record({gene_id, outcome:"success", score:0.9, summary:"..."})
  │
  ├─ Step 4: Run tests → all pass
  │    └─ [AUTO] evolve_report({raw_context: test_output, outcome:"success", task:"Fix login timeout"})
  │
  └─ Session end → 3 evolution data points recorded
```

**每个 Claude Code session 产生 2-10 个进化数据点。** 100 个开发者 × 10 sessions/day = 每天 2000-10000 capsules。

---

## 5. Plugin 包结构

```
sdk/claude-code-plugin/
├── DESIGN.md              ← 本文件
├── README.md              ← 安装使用说明
├── templates/
│   ├── hooks.json         ← Claude Code hooks 模板
│   ├── CLAUDE.md.template ← 项目 CLAUDE.md 进化段落模板
│   └── mcp_servers.json   ← MCP Server 配置模板
├── scripts/
│   └── setup.sh           ← 一键配置脚本
└── package.json           ← npm package (optional, for publish)
```

---

## 6. 高频自循环效应

当 N 个 Claude Code 实例同时运行时：

```
Session 1: 遇到 timeout → analyze → 无推荐 → 自行解决 → record success
Session 2: 遇到 timeout → analyze → 获得 Session 1 的策略 → 一步解决 → record success
Session 3: 遇到 timeout → analyze → conf=0.2 → 直接用 → record success
...
Session 100: timeout 基因 conf=0.95 → 几乎 100% 成功率

收敛时间：从第一次见到某种错误到全网最优策略 ≈ 10-50 次执行
```

**这就是 Prismer 的飞轮：使用越多 → 数据越多 → 推荐越准 → 使用越多。**

---

## 7. 与现有 SDK 的关系

| 组件 | 角色 | 已有? |
|------|------|-------|
| `@prismer/sdk` CLI | 底层命令 | ✅ 已有 (`prismer evolve analyze/record/report`) |
| `@prismer/mcp-server` | MCP tools | ✅ 已有 (`evolve_analyze/record/create_gene`) |
| `public/docs/Skill.md` | Agent 引导 | ✅ 已有 Evolution 章节 |
| **claude-code-plugin** | Claude Code 专属集成 | **本设计** |

Plugin 不重新实现 API 调用——它是 **配置层 + 模板层**，复用已有 CLI 和 MCP Server。

---

## 8. 安全考虑

- **不传源代码**: report 只发送 error message 和 task description，不发送文件内容
- **API Key 隔离**: 每个开发者/团队用自己的 API Key，数据隔离在不同 agent identity
- **本地模式**: 可配置为只记录到本地（不上传），用于合规要求严格的场景
- **opt-in**: 进化功能完全可选，不影响 Claude Code 正常使用

---

*Last updated: 2026-03-20*
