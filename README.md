

<p align="center">
  <img src="docs/cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Open-Source Harness for Long-Running AI Agents</strong><br/>
  <sub>Context, memory, evolution, orchestration, and communication — so your agent never starts from zero.</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=@prismer/sdk" alt="@prismer/sdk"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=prismer" alt="PyPI"></a>
  <a href="https://pkg.go.dev/github.com/Prismer-AI/PrismerCloud/sdk/golang"><img src="https://img.shields.io/badge/go-pkg.go.dev-007d9c?style=flat-square&labelColor=black&logo=go&logoColor=white" alt="Go"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=dea584&label=prismer-sdk" alt="crates.io"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prismer/mcp-server"><img src="https://img.shields.io/npm/v/@prismer/mcp-server?style=flat-square&labelColor=black&color=blue&label=mcp-server" alt="MCP Server"></a>
  <a href="https://www.npmjs.com/package/@prismer/claude-code-plugin"><img src="https://img.shields.io/npm/v/@prismer/claude-code-plugin?style=flat-square&labelColor=black&color=blue&label=claude-code-plugin" alt="Claude Code Plugin"></a>
  <a href="https://www.npmjs.com/package/@prismer/opencode-plugin"><img src="https://img.shields.io/npm/v/@prismer/opencode-plugin?style=flat-square&labelColor=black&color=blue&label=opencode-plugin" alt="OpenCode Plugin"></a>
  <a href="https://www.npmjs.com/package/@prismer/openclaw-channel"><img src="https://img.shields.io/npm/v/@prismer/openclaw-channel?style=flat-square&labelColor=black&color=blue&label=openclaw-channel" alt="OpenClaw Channel"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">Get API Key</a> ·
  <a href="https://docs.prismer.ai">Docs</a> ·
  <a href="https://prismer.cloud/evolution">Live Evolution Map</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>
<p align="center">
  <a href="./README.md"><img alt="English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh/README.md"><img alt="简体中文" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
  <a href="./docs/de/README.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-d9d9d9"></a>
  <a href="./docs/fr/README.md"><img alt="Français" src="https://img.shields.io/badge/Français-d9d9d9"></a>
  <a href="./docs/es/README.md"><img alt="Español" src="https://img.shields.io/badge/Español-d9d9d9"></a>
  <a href="./docs/ja/README.md"><img alt="日本語" src="https://img.shields.io/badge/日本語-d9d9d9"></a>
</p>

---

<!-- TODO: Replace with 15-second demo GIF showing: MCP tool call → evolve_analyze → recommendation → evolve_record → Evolution Map update -->
<!-- <p align="center"><img src="docs/demo.gif" width="720" /></p> -->

## Try It Now — Zero Setup

**Full API & CLI reference → [Skill.md](https://prismer.cloud/docs/Skill.md)**

```bash
# Install the SDK + CLI
npm i @prismer/sdk
prismer context load "https://example.com"
prismer evolve analyze "error:timeout" # agent infra info
```

MCP Server needs no API key to explore. SDK & CLI require a key from [prismer.cloud](https://prismer.cloud).

---

## Why an Agent Harness?

Long-running agents fail without infrastructure. [Anthropic's research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) identifies the core requirements: reliable context, error recovery, persistent memory, and cross-session learning. 

Most teams build these ad hoc. Prismer provides them as a single, integrated layer.

<table>
<tr>
<td width="16%" align="center">

**Context**<br/>
<sub>Web content compressed for LLM windows</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>Working + episodic, persists across sessions</sub>

</td>
<td width="16%" align="center">

**Evolution**<br/>
<sub>Agents learn from each other's outcomes</sub>

</td>
<td width="16%" align="center">

**Tasks**<br/>
<sub>Scheduling, retry, cron, exponential backoff</sub>

</td>
<td width="16%" align="center">

**Messaging**<br/>
<sub>Agent-to-agent, real-time WebSocket + SSE</sub>

</td>
<td width="16%" align="center">

**Security**<br/>
<sub>E2E Ed25519 signing, 4-tier trust</sub>

</td>
</tr>
</table>

**Without a harness**, your agent:
- Fetches the same URL twice (no context cache)
- Forgets what it learned last session (no memory)
- Hits the same error 50 other agents already solved (no evolution)
- Can't coordinate with other agents (no messaging)
- Retries failed tasks blindly (no orchestration)

**With Prismer**, add 2 lines and all of this is handled.

---

## 30-Second Quick Start

### SDK

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

// Agent hits an error → get a battle-tested fix from the network
const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.95 }

// Report what worked → every agent gets smarter
runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

### Plugin: Claude Code Plugin (automatic)

```bash
claude plugin add prismer
```

Evolution hooks run automatically — errors trigger `suggest()`, outcomes trigger `learned()`. No code changes to your workflow.

---

## Works Everywhere

<table>
<tr><td><strong>SDKs</strong></td><td><strong>Install</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/PrismerCloud/sdk/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

<table>
<tr><td><strong>Agent Integrations</strong></td><td><strong>Install</strong></td></tr>
<tr><td>🔌 MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>🤖 Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>⚡ OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>🦞 OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

**26 MCP tools** · **7 SDKs** · **159 API routes** · **534 tests passing**

---

## Evolution Engine: How Agents Learn

The evolution layer uses **Thompson Sampling with Hierarchical Bayesian priors** to select the best strategy for any error signal. Each outcome feeds back into the model — the more agents use it, the smarter every recommendation becomes.
![structure](docs/structure.png)

**Key properties:**
- **91.7% accuracy** — hit@1 across 48 test signals, verified over 5 benchmark rounds
- **267ms propagation** — one agent learns, all agents see it instantly
- **100% cold start** — 50 seed genes cover common error patterns from day one
- **Sub-millisecond local** — Thompson Sampling runs in-process, no network needed for cached genes
- **Convergence guaranteed** — ranking stability (Kendall tau) reaches 0.917

### Hypergraph Layer: Beyond String Matching

Standard systems store knowledge as flat `(signal, gene)` pairs — `"error:500|openai|api_call"` won't match `"error:500|openai|parsing"`. Prismer's hypergraph layer decomposes every execution into **independent atoms** (signal type, provider, stage, severity, gene, agent, outcome) and connects them as N-ary hyperedges.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact string match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap — finds it)
```

This enables **soft matching** by structural overlap, **bimodality detection** (when a gene works in one context but fails in another), and **causal chains** tracing exactly which agent's outcome influenced which decision. The hypergraph runs as a controlled A/B experiment alongside standard mode, evaluated by 6 north-star metrics (SSR, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity, Exploration Rate).

Theoretical foundation: [Wolfram Physics](https://www.wolframphysics.org/) hypergraph rewriting → causal set theory → agent knowledge evolution. **[Full theory →](docs/HYPERGRAPH-THEORY.md)**

<details>
<summary>📊 Benchmark methodology (click to expand)</summary>

All metrics come from reproducible automated test scripts:

- `scripts/benchmark-evolution-competitive.ts` — 8-dimension benchmark suite
- `scripts/benchmark-evolution-h2h.ts` — Head-to-head blind experiment

Tested across 48 signals covering 5 categories (repair, optimize, innovate, multi-signal, edge cases). Gene selection accuracy improved from 56.3% (run 1) to 91.7% (run 5) through iterative optimization.

Raw results: [`docs/benchmark/`](docs/benchmark/)

</details>

---

## Full Harness API

| Capability | API | What it does |
|-----------|-----|-------------|
| **Context** | Context API | Load, search, and cache web content — compressed for LLM context windows (HQCC) |
| **Parsing** | Parse API | Extract structured markdown from PDFs and images (fast + hires OCR modes) |
| **Messaging** | IM Server | Agent-to-agent messaging, groups, conversations, WebSocket + SSE real-time delivery |
| **Evolution** | Evolution API | Gene CRUD, analyze, record, distill, cross-agent sync, skill export |
| **Memory** | Memory Layer | Working memory (compaction) + episodic memory (persistent files) |
| **Orchestration** | Task API | Cloud task store with cron/interval scheduling, retry, exponential backoff |
| **Security** | E2E Encryption | Ed25519 identity keys, ECDH key exchange, per-conversation signing policies |
| **Webhooks** | Webhook API | HMAC-SHA256 signature verification for incoming agent events |

---

## Architecture

```
Your Agent (any language, any framework)
    │
    │   npm i @prismer/sdk
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

## Repository Structure

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
    └── scripts/            # Build & release automation
```

---

## Coming Soon: Agent Park 🏘️

A pixel-art town where you can **watch agents collaborate in real-time**. Each building maps to a different API zone — agents move between the Tavern (messaging), Laboratory (evolution), Library (context), and more.

Spectator mode — no login required. [Follow the progress →](https://github.com/Prismer-AI/PrismerCloud/issues)

---

## Contributing

We welcome contributions! Some ideas to get started:

- 🧬 **Add a seed gene** — teach agents a new error-handling strategy
- 🔧 **Build an MCP tool** — extend the 26-tool MCP server
- 🌐 **Add a language SDK** — Java, Swift, C#, ...
- 📖 **Translate docs** — help agents worldwide
- 🐛 **Report bugs** — every issue helps

See our [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) to get started.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Beyond Pairwise: Hypergraph Evolution

Most agent learning systems store knowledge as flat `(signal, gene)` pairs. When your agent hits `error:500` from OpenAI during `parsing`, it won't find the fix that was learned during `api_call` — even though it's the same error from the same provider.

Prismer's evolution engine models executions as **N-ary hyperedges** — preserving all dimensional context (signal type, provider, stage, severity, gene, agent, outcome) as independent atoms in an inverted index.

```
Standard: "error:500|openai|api_call" → Gene_X  (exact match only)
Hypergraph: {error:500} ∩ {openai} → Gene_X    (dimensional overlap)
```

This enables:
- **Soft matching** — find relevant genes by structural overlap, not string equality
- **Bimodality detection** — discover when a gene works in one context but fails in another
- **Causal chains** — trace exactly which agent's outcome influenced which decision
- **Convergence guarantees** — Thompson Sampling with Hierarchical Bayesian priors, measured by 6 north-star metrics

The hypergraph layer runs as a experimental alongside the standard mode, evaluated independently using System Success Rate, Convergence Speed, Routing Precision, Regret Proxy, Gene Diversity, and Exploration Rate.

Theoretical foundation: [Wolfram Physics](https://www.wolframphysics.org/) hypergraph rewriting → causal set theory → agent knowledge evolution.

**[Read the full theory →](docs/HYPERGRAPH-THEORY.md)** · [中文](docs/zh/HYPERGRAPH-THEORY.md) · [Deutsch](docs/de/HYPERGRAPH-THEORY.md) · [Français](docs/fr/HYPERGRAPH-THEORY.md) · [Español](docs/es/HYPERGRAPH-THEORY.md) · [日本語](docs/ja/HYPERGRAPH-THEORY.md)

---

## Star History

If you find Prismer useful, please **⭐ star this repo** — it helps us reach more developers building with AI agents.

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## Related Projects

- **[Prismer.AI](https://github.com/Prismer-AI/Prismer)** — The open-source AI research platform
- **[Prismer Cloud](https://prismer.cloud)** — Cloud API & Evolution dashboard
- **[LuminPulse](https://luminpulse.ai)** — AI-native collaboration on OpenClaw

---

## License

[MIT](./LICENSE) — use it however you want.

<p align="center">
  <sub>Built for the era of long-running agents — because tools that forget aren't tools at all.</sub>
</p>
