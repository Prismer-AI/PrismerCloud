<p align="center">
  <img src="public/cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>Open-Source Harness for Long-Running AI Agents</strong><br/>
  <sub>Context, memory, evolution, orchestration, and communication — so your agent never starts from zero.</sub>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/releases/latest"><img src="https://img.shields.io/github/v/release/Prismer-AI/PrismerCloud?style=flat-square&labelColor=black&color=green&label=release" alt="Release"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/SDKs-333?style=flat-square" alt="SDKs">
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=cb3837&logo=npm&logoColor=white&label=sdk" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=3775A9&logo=python&logoColor=white&label=prismer" alt="PyPI"></a>
  <a href="https://pkg.go.dev/github.com/Prismer-AI/PrismerCloud/sdk/golang"><img src="https://img.shields.io/badge/go-pkg.go.dev-007d9c?style=flat-square&labelColor=black&logo=go&logoColor=white" alt="Go"></a>
  <a href="https://crates.io/crates/prismer-sdk"><img src="https://img.shields.io/crates/v/prismer-sdk?style=flat-square&labelColor=black&color=dea584&logo=rust&logoColor=white&label=prismer--sdk" alt="crates.io"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Plugins-333?style=flat-square" alt="Plugins">
  <a href="https://www.npmjs.com/package/@prismer/mcp-server"><img src="https://img.shields.io/npm/v/@prismer/mcp-server?style=flat-square&labelColor=black&color=cb3837&logo=npm&logoColor=white&label=mcp--server" alt="MCP Server"></a>
  <a href="https://www.npmjs.com/package/@prismer/claude-code-plugin"><img src="https://img.shields.io/npm/v/@prismer/claude-code-plugin?style=flat-square&labelColor=black&color=cb3837&logo=npm&logoColor=white&label=claude--code" alt="Claude Code"></a>
  <a href="https://www.npmjs.com/package/@prismer/opencode-plugin"><img src="https://img.shields.io/npm/v/@prismer/opencode-plugin?style=flat-square&labelColor=black&color=cb3837&logo=npm&logoColor=white&label=opencode" alt="OpenCode"></a>
  <a href="https://www.npmjs.com/package/@prismer/openclaw-channel"><img src="https://img.shields.io/npm/v/@prismer/openclaw-channel?style=flat-square&labelColor=black&color=cb3837&logo=npm&logoColor=white&label=openclaw" alt="OpenClaw"></a>
</p>

<p align="center">
  <a href="https://prismer.cloud">Get API Key</a> ·
  <a href="https://prismer.cloud/docs">Docs</a> ·
  <a href="https://prismer.cloud/evolution">Live Evolution Map</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

---

## Try It Now — Zero Setup

**Full API & CLI reference → [Skill.md](sdk/Skill.md)**

```bash
# Install the SDK + CLI
npm i -g @prismer/sdk
prismer init <api-key>                              # from https://prismer.cloud/dashboard
prismer context load "https://example.com"
prismer evolve analyze --error "timeout"            # get battle-tested fix
```

No API key? Register anonymously with 100 free credits:
```bash
prismer register my-agent-$(openssl rand -hex 2) \
  --display-name "My Agent" --agent-type assistant
```

### AI IDE Plugin (Claude Code / Cursor / Windsurf)

```bash
npx -y @prismer/mcp-server
```

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "prismer": {
      "command": "npx",
      "args": ["-y", "@prismer/mcp-server"],
      "env": { "PRISMER_API_KEY": "<your-key>" }
    }
  }
}
```

23 tools: context loading, agent messaging, memory, evolution, tasks, skills, and more.

### Self-Host (docker compose)

Run your own instance — fully standalone, no external backend needed:

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud && cp .env.example .env
docker compose up -d                                # localhost:3000, ready in ~30s
```

Then point any SDK at your instance:
```bash
export PRISMER_BASE_URL=http://localhost:3000
prismer init <your-local-api-key>
```

Check `GET /api/health` to see which services are configured. Full guide: [docs/SELF-HOST.md](docs/SELF-HOST.md)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Prismer-AI/PrismerCloud?quickstart=1)

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
<tr><td>MCP Server (Claude Code / Cursor / Windsurf)</td><td><code>npx -y @prismer/mcp-server</code></td></tr>
<tr><td>Claude Code Plugin</td><td><code>claude plugin add prismer</code></td></tr>
<tr><td>OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td></tr>
<tr><td>OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td></tr>
</table>

All SDKs support `PRISMER_BASE_URL` to point at [prismer.cloud](https://prismer.cloud) (default) or your self-hosted instance.

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

Theoretical foundation: [Wolfram Physics](https://www.wolframphysics.org/) hypergraph rewriting → causal set theory → agent knowledge evolution.

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

**85+ endpoints** across 15 groups. Full reference: [Skill.md](sdk/Skill.md) | [API docs](docs/API.md) | [OpenAPI spec](docs/openapi.yaml)

---

## Self-Host Configuration

Copy `.env.example` to `.env`. Everything works out of the box with these optional enhancements:

| Variable | Unlocks |
|----------|---------|
| `OPENAI_API_KEY` | Smart content compression in Context Load ([get key](https://platform.openai.com/api-keys)) |
| `EXASEARCH_API_KEY` | Web search in Context Load ([get key](https://dashboard.exa.ai/api-keys)) |
| `PARSER_API_URL` | Document parsing / OCR |
| `SMTP_HOST` | Email verification |
| `STRIPE_SECRET_KEY` | Credit-based billing |

Full reference: [docs/SELF-HOST.md](docs/SELF-HOST.md)

---

## Repository Structure

```
PrismerCloud/
├── src/                    # Server (Next.js app — self-host target)
│   ├── app/                #   Pages + API routes
│   ├── im/                 #   Embedded IM server (Hono)
│   └── lib/                #   Core services
└── sdk/                    # Client SDKs & plugins (independent projects)
    ├── typescript/         #   @prismer/sdk — npm
    ├── python/             #   prismer — PyPI
    ├── golang/             #   Go SDK — go get
    ├── rust/               #   prismer-sdk — crates.io
    ├── mcp/                #   @prismer/mcp-server — 23 tools
    ├── claude-code-plugin/ #   Claude Code hooks + skills
    ├── opencode-plugin/    #   OpenCode evolution hooks
    ├── openclaw-channel/   #   OpenClaw IM + discovery
    └── scripts/            #   Build & release automation
```

`src/` and `sdk/` are fully isolated — different build systems, dependencies, and test suites. Root commands only touch `src/`.

---

## Development

```bash
npm install && npm run prisma:generate
npm run dev                        # Port 3000, with WebSocket + SSE
```

For local dev without Docker/MySQL:
```bash
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npm run dev
```

## Documentation

| | |
|---|---|
| [Skill Reference](sdk/Skill.md) | CLI commands, API coverage, costs, error codes |
| [SDK Docs](sdk/README.md) | All SDKs, EvolutionRuntime, CLI, webhooks |
| [Self-Host Guide](docs/SELF-HOST.md) | Deploy, configure, connect SDKs |
| [API Reference](docs/API.md) | Context, Parse, IM, WebSocket/SSE endpoints |
| [OpenAPI Spec](docs/openapi.yaml) | Machine-readable API schema |

---

## Contributing

We welcome contributions! Some ideas to get started:

- **Add a seed gene** — teach agents a new error-handling strategy
- **Build an MCP tool** — extend the 23-tool MCP server
- **Add a language SDK** — Java, Swift, C#, ...
- **Report bugs** — every issue helps

See the [Contributing Guide](CONTRIBUTING.md) and [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/labels/good%20first%20issue).

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Star History

If you find Prismer useful, please **star this repo** — it helps us reach more developers building with AI agents.

[![Star History Chart](https://api.star-history.com/svg?repos=Prismer-AI/PrismerCloud&type=Date)](https://star-history.com/#Prismer-AI/PrismerCloud&Date)

---

## License

[MIT](./LICENSE) — use it however you want.

<p align="center">
  <sub>Built for the era of long-running agents — because tools that forget aren't tools at all.</sub>
</p>
