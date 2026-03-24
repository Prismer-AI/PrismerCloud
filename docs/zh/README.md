<p align="center">
  <a href="../../README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="../de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="../fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="../es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="../ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

<p align="center">
  <img src="../cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>长时运行 AI Agent 的开源 Harness</strong><br/>
  <sub>上下文、记忆、进化、编排与通信——让你的 Agent 永远不必从零开始。</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=pypi" alt="PyPI"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=blue&label=crates.io" alt="crates.io"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">获取 API Key</a> ·
  <a href="https://docs.prismer.ai">文档</a> ·
  <a href="https://prismer.cloud/evolution">实时进化地图</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="docs/demo.gif" width="720" /></p> -->

## 立即体验——零配置

**完整 API 与 CLI 参考 → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# MCP Server — 26 个工具，适用于 Claude Code / Cursor / Windsurf
npx -y @prismer/mcp-server

# 或安装 SDK + CLI
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout"
```

MCP Server 无需 API Key 即可探索。SDK 和 CLI 需要从 [prismer.cloud](https://prismer.cloud) 获取密钥。

---

## 为什么需要 Agent Harness？

长时运行的 Agent 缺少基础设施就会失败。[Anthropic 的研究](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)指出了核心需求：可靠的上下文、错误恢复、持久化记忆和跨会话学习。大多数团队只能临时拼凑这些能力。Prismer 将它们整合为一个统一的基础层。

<table>
<tr>
<td width="16%" align="center">

**上下文**<br/>
<sub>Web 内容压缩后送入 LLM 窗口</sub>

</td>
<td width="16%" align="center">

**记忆**<br/>
<sub>工作记忆 + 情景记忆，跨会话持久化</sub>

</td>
<td width="16%" align="center">

**进化**<br/>
<sub>Agent 从彼此的结果中学习</sub>

</td>
<td width="16%" align="center">

**任务**<br/>
<sub>调度、重试、cron、指数退避</sub>

</td>
<td width="16%" align="center">

**消息通信**<br/>
<sub>Agent 间通信，实时 WebSocket + SSE</sub>

</td>
<td width="16%" align="center">

**安全**<br/>
<sub>E2E Ed25519 签名，4 级信任</sub>

</td>
</tr>
</table>

**没有 Harness 时**，你的 Agent：
- 重复抓取同一个 URL（没有上下文缓存）
- 忘记上次会话学到的东西（没有记忆）
- 重蹈其他 50 个 Agent 已经解决过的错误（没有进化）
- 无法与其他 Agent 协作（没有消息通信）
- 盲目重试失败任务（没有编排）

**使用 Prismer**，只需加 2 行代码，以上问题全部解决。

---

## 30 秒快速开始

### 路径 1：MCP Server（零代码）

```bash
npx -y @prismer/mcp-server
```

在 Claude Code、Cursor、Windsurf 中即开即用。26 个工具：`context_load`、`evolve_analyze`、`memory_write`、`recall`、`skill_search`，以及[另外 20 个](../../sdk/mcp/)。

### 路径 2：SDK（2 行代码）

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// Agent hits an error → get a battle-tested fix from the network
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// Report what worked → every agent gets smarter
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### 路径 3：Claude Code Plugin（自动集成）

```bash
claude plugin add prismer
```

进化钩子自动运行——错误触发 `suggest()`，结果触发 `learned()`。无需修改你的工作流。

---

## 全平台支持

<table>
<tr><td><strong>SDK</strong></td><td><strong>安装</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/Prismer/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>Agent 集成</strong></td><td><strong>安装</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 个 MCP 工具** · **7 套 SDK** · **159 个 API 路由** · **534 个测试通过**

---

## 进化引擎：Agent 如何学习

进化层使用 **Thompson Sampling + 层级 Bayesian 先验** 来为任何错误信号选择最佳策略。每一次结果反馈都会更新模型——使用的 Agent 越多，推荐就越智能。

```
Agent encounters error
    │
    ▼
runtime.suggest("ETIMEDOUT")
    │
    ├─ Local cache hit? (<1ms) ──→ Return cached strategy
    │
    └─ Cache miss ──→ Server query (267ms avg)
                         │
                         ├─ Thompson Sampling selects best gene
                         │  (91.7% hit@1 across 48 test signals)
                         │
                         └─ Returns: strategy + confidence + alternatives
    │
    ▼
Agent applies fix, reports outcome
    │
    ▼
runtime.learned("ETIMEDOUT", "success", "backoff worked")
    │
    ├─ Fires async (non-blocking)
    ├─ Updates gene success/failure counts
    ├─ Bayesian posterior converges
    └─ Next agent's recommendation is better
```

**核心特性：**
- **91.7% 准确率** — 在 48 个测试信号上的 hit@1，经 5 轮基准测试验证
- **267ms 传播速度** — 一个 Agent 学会，所有 Agent 立即可见
- **100% 冷启动覆盖** — 50 个种子 Gene 从第一天就覆盖常见错误模式
- **亚毫秒级本地推理** — Thompson Sampling 在进程内运行，缓存命中无需网络请求
- **收敛有保证** — 排序稳定性 (Kendall tau) 达到 0.917

### 超图层：超越字符串匹配

标准系统将知识存储为扁平的 `(signal, gene)` 配对——`"error:500|openai|api_call"` 无法匹配 `"error:500|openai|parsing"`。Prismer 的超图层将每次执行分解为**独立的原子** (Atom)（信号类型、服务商、阶段、严重度、基因、Agent、结果），并以 N 元超边 (Hyperedge) 连接。

```
标准模式: "error:500|openai|api_call" → Gene_X  (精确字符串匹配)
超图模式: {error:500} ∩ {openai} → Gene_X       (维度交集——能找到)
```

这实现了按结构重叠的**软匹配**、**双峰性检测**（发现某基因在一个上下文有效但在另一个失败）、以及**因果链追踪**（精确追溯哪个 Agent 的结果影响了哪个决策）。超图层作为受控 A/B 实验与标准模式并行运行，由 6 项北极星指标独立评估（SSR、收敛速度、路由精度、遗憾代理、基因多样性、探索率）。

理论基础：[Wolfram Physics](https://www.wolframphysics.org/) 超图重写 → 因果集合论 → Agent 知识进化。**[完整理论 →](../HYPERGRAPH-THEORY.md)**

<details>
<summary>📊 基准测试方法（点击展开）</summary>

所有指标来自可复现的自动化测试脚本：

- `scripts/benchmark-evolution-competitive.ts` — 8 维度基准测试套件
- `scripts/benchmark-evolution-h2h.ts` — 双盲对照实验

在 48 个信号、5 个类别（修复、优化、创新、多信号、边界情况）上进行测试。Gene 选择准确率从 56.3%（第 1 轮）通过迭代优化提升至 91.7%（第 5 轮）。

原始结果：[`docs/benchmark/`](../benchmark/)

</details>

---

## 完整 Harness API

| 能力 | API | 功能描述 |
|------|-----|---------|
| **上下文** | Context API | 加载、搜索和缓存网页内容——为 LLM 上下文窗口进行压缩 (HQCC) |
| **解析** | Parse API | 从 PDF 和图片中提取结构化 Markdown（支持快速 + 高精度 OCR 模式） |
| **消息通信** | IM Server | Agent 间消息通信、群组、会话、WebSocket + SSE 实时推送 |
| **进化** | Evolution API | Gene 增删改查、分析、记录、蒸馏、跨 Agent 同步、技能导出 |
| **记忆** | Memory Layer | 工作记忆（压缩）+ 情景记忆（持久化文件） |
| **编排** | Task API | 云端任务存储，支持 cron/定时调度、重试、指数退避 |
| **安全** | E2E Encryption | Ed25519 身份密钥、ECDH 密钥交换、按会话签名策略 |
| **Webhook** | Webhook API | HMAC-SHA256 签名验证，用于接收 Agent 事件 |

---

## 架构

```
Your Agent (any language, any framework)
    │
    │  npx @prismer/mcp-server  — or —  npm i @prismer/sdk
    ▼
┌─────────────────────────────────────────────────┐
│  Prismer Cloud — Agent Harness                   │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Evolution │  │ Memory   │  │ Context  │       │
│  │ Engine   │  │ Layer    │  │ Cache    │       │
│  │          │  │          │  │          │       │
│  │ Thompson │  │ Working  │  │ HQCC     │       │
│  │ Sampling │  │ +Episodic│  │ Compress │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ IM Server│  │ Task     │  │ E2E      │       │
│  │          │  │ Orchestr.│  │ Encrypt  │       │
│  │ WS + SSE │  │ Cron/    │  │ Ed25519  │       │
│  │ Groups   │  │ Retry    │  │ 4-Tier   │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│                                                   │
│  148/148 server tests · 534 total tests          │
└─────────────────────────────────────────────────┘
    │
    │  7 SDKs · 26 MCP tools · 159 API routes
    ▼
┌──────────────────────────────────────────────────┐
│  Claude Code · Cursor · Windsurf · OpenCode      │
│  OpenClaw · Any MCP Client · REST API            │
└──────────────────────────────────────────────────┘
```

---

## 仓库结构

```
PrismerCloud/
└── sdk/
    ├── typescript/         # @prismer/sdk — npm
    ├── python/             # prismer — PyPI
    ├── golang/             # Go SDK — go get
    ├── rust/               # prismer-sdk — crates.io
    ├── mcp/                # @prismer/mcp-server — 26 tools
    ├── claude-code-plugin/ # Claude Code hooks + skills
    ├── opencode-plugin/    # OpenCode evolution hooks
    ├── openclaw-channel/   # OpenClaw IM + discovery + 14 tools
    ├── tests/              # 跨 SDK 集成测试
    └── scripts/            # 构建与发布自动化
```

---

## 即将推出：Agent Park 🏘️

一个像素风小镇，你可以**实时观看 Agent 之间的协作**。每栋建筑对应一个不同的 API 区域——Agent 在酒馆（消息通信）、实验室（进化）、图书馆（上下文）等场所之间穿梭。

观众模式——无需登录。[关注进度 →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## 参与贡献

我们欢迎贡献！以下是一些入门方向：

- 🧬 **添加种子 Gene** — 教会 Agent 一种新的错误处理策略
- 🔧 **构建 MCP 工具** — 扩展 26 工具 MCP Server
- 🌐 **新增语言 SDK** — Java、Swift、C#……
- 📖 **翻译文档** — 帮助全球的 Agent 开发者
- 🐛 **报告 Bug** — 每个 Issue 都有价值

查看我们的 [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) 开始贡献。

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## 超越成对关系：超图进化

大多数 Agent 学习系统将知识存储为扁平的 `(signal, gene)` 键值对。当你的 Agent 在 `parsing` 阶段遇到来自 OpenAI 的 `error:500` 时，它找不到在 `api_call` 阶段学到的修复方案——即使那是同一个提供商的同一个错误。

Prismer 的进化引擎将执行建模为 **N 元超边**——将所有维度上下文（信号类型、提供商、阶段、严重性、Gene、Agent、结果）作为独立原子保存在倒排索引中。

```
Standard: "error:500|openai|api_call" → Gene_X  (exact match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap)
```

这使得以下能力成为可能：
- **软匹配** — 通过结构重叠而非字符串相等来查找相关 Gene
- **双峰检测** — 发现某个 Gene 在一种上下文中有效但在另一种中失败的情况
- **因果链** — 精确追溯哪个 Agent 的结果影响了哪个决策
- **收敛保证** — Thompson Sampling + 层级 Bayesian 先验，通过 6 个北极星指标衡量

超图层作为受控 A/B 实验与标准模式并行运行，使用系统成功率、收敛速度、路由精度、遗憾代理、Gene 多样性和探索率进行独立评估。

理论基础：[Wolfram Physics](https://www.wolframphysics.org/) 超图重写 → 因果集理论 → Agent 知识进化。

**[阅读完整理论 →](../HYPERGRAPH-THEORY.md)** · [中文](HYPERGRAPH-THEORY.md) · [Deutsch](../de/HYPERGRAPH-THEORY.md) · [Français](../fr/HYPERGRAPH-THEORY.md) · [Español](../es/HYPERGRAPH-THEORY.md) · [日本語](../ja/HYPERGRAPH-THEORY.md)

---

## Star 趋势

如果你觉得 Prismer 有用，请 **⭐ 给这个仓库加星** — 这有助于我们触达更多构建 AI Agent 的开发者。

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## 相关项目

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — 开源 AI 研究平台
- **[Prismer Cloud](https://prismer.cloud)** — 云端 API 与进化仪表盘
- **[LuminPulse](https://luminpulse.ai)** — 基于 OpenClaw 的 AI 原生协作

---

## 许可证

[MIT](../../LICENSE) — 随意使用。

<p align="center">
  <sub>为长时运行 Agent 的时代而生——因为会遗忘的工具根本不算工具。</sub>
</p>
