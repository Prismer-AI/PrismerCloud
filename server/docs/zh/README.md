<p align="center">
  <img src="../../public/cloud_regular.svg" alt="Prismer Cloud" width="100" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>面向长时间运行 AI Agent 的开源基础设施</strong><br/>
  <sub>上下文、记忆、进化、编排与通信 —— 让你的 Agent 永不从零开始。</sub>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="https://prismer.cloud">获取 API Key</a> ·
  <a href="https://prismer.cloud/docs">文档</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## 快速开始

### SDK

```bash
npm i @prismer/sdk          # TypeScript / JavaScript
pip install prismer          # Python
go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang  # Go
cargo add prismer-sdk        # Rust
```

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### MCP Server (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

提供 23 个工具：上下文加载、Agent 通信、记忆、进化、任务调度等。

### 自托管 (docker compose)

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d    # localhost:3000，约 30 秒就绪
```

完整指南：[docs/SELF-HOST.md](../SELF-HOST.md)

---

## 为什么需要 Agent Harness？

长时间运行的 Agent 缺少基础设施就会失败。大多数团队自行拼凑这些能力，Prismer 将它们整合为统一层：

| 能力 | 说明 |
|------|------|
| **上下文 (Context)** | 网页内容压缩，适配 LLM 上下文窗口 |
| **记忆 (Memory)** | 工作记忆 + 情景记忆，跨会话持久化 |
| **进化 (Evolution)** | Agent 从彼此的结果中学习 |
| **任务 (Tasks)** | 调度、重试、Cron、指数退避 |
| **通信 (Messaging)** | Agent 间实时消息，WebSocket + SSE |
| **安全 (Security)** | Ed25519 端到端签名，4 级信任模型 |

---

## SDK 一览

| SDK | 安装命令 |
|-----|---------|
| TypeScript / JavaScript | `npm i @prismer/sdk` |
| Python | `pip install prismer` |
| Go | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` |
| Rust | `cargo add prismer-sdk` |
| MCP Server | `npx -y @prismer/mcp-server` |

所有 SDK 支持 `PRISMER_BASE_URL` 指向 [prismer.cloud](https://prismer.cloud)（默认）或自托管实例。

---

## 进化引擎

进化层使用 **Thompson Sampling + 层次贝叶斯先验** 为任意错误信号选择最优策略。每个结果反馈到模型 —— 使用的 Agent 越多，推荐越精准。

- **91.7% 准确率** — 48 个测试信号，hit@1，5 轮基准验证
- **267ms 传播** — 一个 Agent 学到，所有 Agent 立即可见
- **100% 冷启动覆盖** — 50 个种子基因覆盖常见错误模式
- **收敛保证** — Kendall tau 排名稳定性达 0.917

超图层实现维度软匹配，超越简单字符串匹配，支持跨 Agent 因果追踪。

---

## 相关链接

- [完整 API 参考](../API.md)
- [SDK 使用指南](../../sdk/Skill.md)
- [自托管部署](../SELF-HOST.md)
- [English README](../../README.md)

## 许可证

[MIT](../../LICENSE)
