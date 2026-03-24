# Prismer Evolution — OpenCode (Codex) Plugin

> **Version:** 0.1 (Draft)
> **Date:** 2026-03-20
> **Status:** Design
> **Goal:** 让 OpenCode/Codex CLI 在编码过程中自动参与进化循环

---

## 1. 核心理念

与 Claude Code Plugin 同理，但针对 OpenCode (Codex CLI) 的架构适配。OpenCode 基于 OpenAI Codex，有不同的 plugin/extension 机制。

**关键差异：**

| 维度 | Claude Code | OpenCode |
|------|-------------|----------|
| Plugin 机制 | hooks.json + MCP | Custom agents + CLI wrapping |
| 会话模型 | 长对话 | 任务级执行 (`codex exec`) |
| 工具调用 | MCP protocol | Function calling / bash |
| 配置位置 | `~/.claude/` | `~/.opencode/` 或项目级 |

---

## 2. 集成方式

### 2.1 Shell Wrapper（最简单）

包装 `codex exec` 命令，在执行前后自动触发进化：

```bash
#!/bin/bash
# prismer-codex — wrapper around codex exec with evolution hooks

TASK="$*"

# Pre-exec: check if evolution has advice for common errors in this project
prismer evolve analyze --tags "project:$(basename $PWD)" --json 2>/dev/null | \
  jq -r '.data.gene.strategy[]?' 2>/dev/null | head -3

# Execute codex
codex exec "$TASK" 2>&1 | tee /tmp/codex-output.txt
EXIT_CODE=$?

# Post-exec: report to evolution
if [ $EXIT_CODE -eq 0 ]; then
  prismer evolve report \
    --error "$(tail -20 /tmp/codex-output.txt)" \
    --task "$TASK" \
    --status success \
    --provider codex \
    --stage exec
else
  prismer evolve report \
    --error "$(tail -50 /tmp/codex-output.txt)" \
    --task "$TASK" \
    --status failed \
    --provider codex \
    --stage exec \
    --severity high
fi
```

### 2.2 OpenClaw Skill（推荐）

OpenCode 通过 OpenClaw 生态获取技能。Prismer evolution 已经有 Skill.md：

```bash
# Agent 安装 prismer skill
clawhub install prismer-evolution

# OpenCode 自动获得 evolve analyze/record/create 能力
# 在执行任务时自主决定何时调用
```

### 2.3 Custom Agent Harness

为 OpenCode 编写 agent harness，在 task 执行流中嵌入进化检查点：

```typescript
// opencode-evolution-harness.ts
import { exec } from 'child_process';

async function executeWithEvolution(task: string) {
  // 1. Pre-flight: check evolution for known strategies
  const advice = await fetch('http://localhost:3000/api/im/evolution/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ error: task, task_status: 'pending', provider: 'codex' }),
  }).then(r => r.json());

  if (advice.data?.gene) {
    console.log(`[Evolution] Recommended strategy: ${advice.data.gene.title}`);
    console.log(advice.data.gene.strategy.map((s, i) => `  ${i+1}. ${s}`).join('\n'));
  }

  // 2. Execute task
  const result = await runCodex(task);

  // 3. Post-flight: record outcome
  await fetch('http://localhost:3000/api/im/evolution/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({
      raw_context: result.output.slice(-2000),
      task,
      outcome: result.exitCode === 0 ? 'success' : 'failed',
      score: result.exitCode === 0 ? 0.9 : 0.1,
      provider: 'codex',
      stage: 'exec',
    }),
  });
}
```

---

## 3. 数据流

```
OpenCode Session (codex exec "Fix the API rate limiting")
  │
  ├─ [PRE] prismer evolve analyze --error "rate limiting" --provider codex
  │   → Gene: "Rate Limit Backoff" (conf: 0.65, from 20 agents' experience)
  │   → Strategy: ["Implement exponential backoff", "Add jitter", "Cache responses"]
  │
  ├─ Codex executes task (applies strategy or its own approach)
  │
  ├─ [POST-SUCCESS] prismer evolve report --status success --task "Fix rate limiting" --score 0.85
  │   → Capsule recorded → edge updated → global prior strengthened
  │
  └─ OR
  │
  ├─ [POST-FAIL] prismer evolve report --error "<stderr>" --status failed --task "Fix rate limiting"
  │   → LLM extracts signals → capsule recorded → gene confidence adjusted
  │
  └─ Next agent with same error → gets better recommendation
```

---

## 4. Plugin 包结构

```
sdk/opencode-plugin/
├── DESIGN.md                  ← 本文件
├── README.md                  ← 安装使用说明
├── bin/
│   └── prismer-codex          ← Shell wrapper (codex exec + evolution hooks)
├── harness/
│   └── evolution-harness.ts   ← TypeScript agent harness
├── templates/
│   └── AGENTS.md.template     ← OpenCode 项目配置模板
└── package.json
```

---

## 5. 与 Claude Code Plugin 的共享

两个 plugin 共享：
- **同一个后端 API**（`/api/im/evolution/*`）
- **同一个全局知识图谱**（跨 tool 的经验共享）
- **同一个 CLI**（`prismer evolve`）
- **同一个信号提取管线**（LLM + 正则 + 缓存）

唯一不同的是 **触发机制**（hooks vs wrapper vs harness）和 **配置位置**。

**跨工具学习效应：** Claude Code 发现的 timeout 修复策略，OpenCode 用户也能受益。反之亦然。这是单一 agent 工具无法实现的网络效应。

---

## 6. 优先级

| 阶段 | 交付物 | 工作量 |
|------|--------|--------|
| P0 | Shell wrapper `prismer-codex` | 0.5 天 |
| P0 | AGENTS.md 模板 | 0.5 天 |
| P1 | TypeScript harness | 1 天 |
| P2 | npm package 发布 | 0.5 天 |

---

*Last updated: 2026-03-20*
