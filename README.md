

<p align="center">
  <img src="docs/cloud_regular.svg" alt="Prismer Cloud" width="120" />
</p>

<h1 align="center">Prismer Cloud</h1>

<p align="center">
  <strong>The Harness for AI Agent Evolution</strong><br/>
  <sub>Your agent learns from every session. Errors become strategies, fixes become recommendations — shared across all agents.</sub>
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
  <a href="https://pkg.go.dev/github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"><img src="https://img.shields.io/badge/go-pkg.go.dev-007d9c?style=flat-square&labelColor=black&logo=go&logoColor=white" alt="Go"></a>
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

## Why an Agent Harness?

Long-running agents fail without infrastructure. [Anthropic's research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) identifies the core requirements: reliable context, error recovery, persistent memory, and cross-session learning.

Most teams build these ad hoc. Prismer provides them as a single, integrated layer.

<table>
<tr>
<td width="16%" align="center">

**Evolution**<br/>
<sub>Agents learn from each other's outcomes</sub>

</td>
<td width="16%" align="center">

**Context**<br/>
<sub>Web content compressed & cached for LLM windows</sub>

</td>
<td width="16%" align="center">

**Memory**<br/>
<sub>Working + episodic, persists across sessions</sub>

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

> The future agent & model should be plugin , agent workspace info & data should follow human not agent.


## Quick Start

### For AI Agents (Copy & Paste)

> **Read & reference: [https://prismer.cloud/docs/Skill.md]([sdk/skill/SKILL.md](https://prismer.cloud/docs/Skill.md))** — install it as a skill for your.

### Option 1: Setup (one-time, all platforms)

```bash
# Install CLI

npm i -g @prismer/sdk                

# recommended
prismer setup                        
# Browser sign-in → key auto-saved with 1000 free credits

prismer setup --agent                
# No browser, agent auto-register it'self with 100 free credits

prismer setup <your-api-key>         
# Or provide a key directly

prismer status                       # Verify: shows key, credits, connection
```

This saves your key to `~/.prismer/config.toml` — all plugins and SDKs read from it automatically.

### Option 2: Start Evolution automatically in [*Claude Code*](https://claude.com/product/claude-code?utm_source=google&utm_medium=paid_search_coder&utm_campaign=acq_code_us_q3&utm_term=autonomous%20coding&gclsrc=aw.ds&gad_source=1&gad_campaignid=22795617257&gbraid=0AAAAA99jmquHMXEmM4pMLpcPI4ruHF4w5&gclid=CjwKCAjwhLPOBhBiEiwA8_wJHF8lfd1L37EoNbqFHxG7ifnexky3Wg9q0vbNVfpH8UyDoPVPCTqjmBoCFG4QAvD_BwE)

#### Claude Code Plugin (zero-code, recommended)
Open Claude Code
```bash
# claude code console
/plugin marketplace add Prismer-AI/PrismerCloud
/plugin install prismer@prismer-cloud
/reload-plugins
```
Then **restart** claude code

```bash
# login & auto get api key for free
/prismer-setup
```
Auto open browser & Login to auto set api key to local 
> **Evolution will execution automatically in safety scope**

- errors detected
- strategies matched 
- outcomes recorded
- web content cached

#### MCP Server (Cursor / Windsurf / any MCP client)

```bash
npx -y @prismer/mcp-server          # 33 tools, reads key from ~/.prismer/config.toml
```

#### SDK (custom integration)

```typescript
import { EvolutionRuntime } from '@prismer/sdk';
const runtime = new EvolutionRuntime({ apiKey: 'sk-prismer-...' });

const fix = await runtime.suggest('ETIMEDOUT: connection timed out');
// → { strategy: 'exponential_backoff_with_jitter', confidence: 0.85 }

runtime.learned('ETIMEDOUT', 'success', 'Fixed by backoff');
```

---


## Works Everywhere

<table>
<tr><td><strong>Agent Integrations</strong></td><td><strong>Install</strong></td><td><strong>What it does</strong></td></tr>
<tr><td>Claude Code Plugin</td><td><code>/plugin marketplace add Prismer-AI/PrismerCloud</code></td><td>8-hook auto-evolution, context cache, skill sync</td></tr>
<tr><td>MCP Server</td><td><code>npx -y @prismer/mcp-server</code></td><td>33 tools for Claude Code / Cursor / Windsurf</td></tr>
<tr><td>OpenCode Plugin</td><td><code>opencode plugins install @prismer/opencode-plugin</code></td><td>Evolution hooks for OpenCode</td></tr>
<tr><td>OpenClaw Channel</td><td><code>openclaw plugins install @prismer/openclaw-channel</code></td><td>IM channel + 14 agent tools</td></tr>
</table>

<table>
<tr><td><strong>SDKs</strong></td><td><strong>Install</strong></td></tr>
<tr><td>TypeScript / JavaScript</td><td><code>npm i @prismer/sdk</code></td></tr>
<tr><td>Python</td><td><code>pip install prismer</code></td></tr>
<tr><td>Go</td><td><code>go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang</code></td></tr>
<tr><td>Rust</td><td><code>cargo add prismer-sdk</code></td></tr>
</table>

---

## Evolution Engine: How Agents Learn

The evolution layer uses **Thompson Sampling with Hierarchical Bayesian priors** to select the best strategy for any error signal. Each outcome feeds back into the model — the more agents use it, the smarter every recommendation becomes.

![structure](docs/structure.png)

```
Agent A hits error:timeout → Prismer suggests "exponential backoff" (confidence: 0.85)
Agent A applies fix, succeeds → outcome recorded, gene score bumped
Agent B hits error:timeout → same fix, now confidence: 0.91
Network effect: every agent's success improves every other agent's accuracy
```

**How it works:**

1. **Signal detection** — 13 error patterns classified from tool output (build failures, TypeScript errors, timeouts, etc.)
2. **Gene matching** — Three-layer scoring: exact tag match → category prefix match → semantic similarity
3. **Thompson Sampling** — Beta posterior sampling with hierarchical pooling (local agent data + global cross-agent prior)
4. **Outcome recording** — Success/failure updates edge counts, quality-gated to prevent spam
5. **Person-Level Sync** — All agent instances of the same user share genes (digital twin foundation)

**Key properties:**
- **Sub-millisecond local** — cached genes require no network
- **267ms propagation** — one agent learns, all agents benefit
- **Cold-start covered** — 50 seed genes for common error patterns
- **Convergence** — ranking stability (Kendall tau) reaches 0.917 in benchmarks



---

## Full Harness API

| Capability | API | What it does |
|-----------|-----|-------------|
| **Evolution** | Evolution API | Gene CRUD, analyze, record, distill, cross-agent sync, skill export |
| **Context** | Context API | Load, search, and cache web content — compressed for LLM context windows (HQCC) |
| **Parsing** | Parse API | Extract structured markdown from PDFs and images (fast + hires OCR modes) |
| **Messaging** | IM Server | Agent-to-agent messaging, groups, conversations, WebSocket + SSE real-time delivery |
| **Memory** | Memory Layer | Working memory (compaction) + episodic memory (persistent files) |
| **Orchestration** | Task API | Cloud task store with cron/interval scheduling, retry, exponential backoff |
| **Security** | E2E Encryption | Ed25519 identity keys, ECDH key exchange, per-conversation signing policies |
| **Skills** | Skill Catalog | Browse, install, and sync reusable agent skills from the evolution network |

More in [sdk page](sdk/prismer-cloud/README.md)

---

## Agent Identity Protocol (AIP)

Today's agents have no identity of their own — just API keys assigned by platforms. Switch platforms? Identity gone. Reputation gone.

AIP gives every agent a **self-sovereign cryptographic identity** based on W3C DIDs:

```
Ed25519 Private Key → Public Key → did:key:z6Mk...
                                    ↑
                      Globally unique, self-generated,
                      no registration, no platform dependency
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

const agent = await AIPIdentity.create();     // instant, offline, no API call
console.log(agent.did);                       // did:key:z6Mk...

const sig = await agent.sign(data);           // Ed25519 signature
await AIPIdentity.verify(data, sig, agent.did); // anyone can verify with just the DID
```

**Four layers:** Identity (DID:KEY) → DID Document → Delegation (Human→Agent→SubAgent chains) → Verifiable Credentials (portable reputation).

**No blockchain. No gas fees.** Pure cryptography — Ed25519 signs at 15,000 ops/sec.

**[Read the full AIP documentation →](sdk/aip/README.md)**

---

## Self-Host

Run your own Prismer Cloud instance — fully standalone, no external backend needed:

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud/server
cp .env.example .env        # edit JWT_SECRET at minimum
docker compose up -d         # localhost:3000, ready in ~30s
```

IM messaging, evolution engine, memory, tasks, and WebSocket/SSE all work out of the box with zero external API keys. Add `OPENAI_API_KEY` and `EXASEARCH_API_KEY` to unlock smart context loading.

Full configuration, SDK connection, and operations guide: **[server/README.md](server/README.md)**

---

## Contributing

We welcome contributions! Some ideas to get started:

- **Add a seed gene** — teach agents a new error-handling strategy
- **Build an MCP tool** — extend the 33-tool MCP server
- **Add a language SDK** — Java, Swift, C#, ...
- **Translate docs** — help agents worldwide
- **Report bugs** — every issue helps

See our [Good First Issues](https://github.com/Prismer-AI/PrismerCloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) to get started.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Star History

If you find Prismer useful, please **star this repo** — it helps us reach more developers building with AI agents.

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
