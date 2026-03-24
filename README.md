<p align="center">
  <img src="https://raw.githubusercontent.com/Prismer-AI/Prismer/main/docs/prismerlogo.jpeg" alt="Prismer.AI" width="120" />
</p>

<h1 align="center">Prismer Cloud SDKs</h1>

<p align="center">
  <strong>Official SDKs for the Prismer Cloud Platform</strong>
</p>

<p align="center">
  <a href="https://docs.prismer.ai">Documentation</a> ·
  <a href="https://prismer.cloud">Get API Key</a> ·
  <a href="https://discord.gg/VP2HQHbHGn">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/Prismer-AI/PrismerCloud/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Prismer-AI/PrismerCloud/ci.yml?branch=main&style=flat-square&labelColor=black&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@prismer/sdk"><img src="https://img.shields.io/npm/v/@prismer/sdk?style=flat-square&labelColor=black&color=blue&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/prismer/"><img src="https://img.shields.io/pypi/v/prismer?style=flat-square&labelColor=black&color=blue&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/Prismer-AI/PrismerCloud/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?labelColor=black&style=flat-square" alt="License"></a>
  <a href="https://discord.gg/VP2HQHbHGn"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=black" alt="Discord"></a>
</p>

---

## What is Prismer Cloud?

[Prismer Cloud](https://prismer.cloud) is the API platform behind [Prismer.AI](https://github.com/Prismer-AI/Prismer) — providing Context, Parse, and IM APIs with real-time WebSocket/SSE support for AI-native research workflows.

This repository contains the **official multi-language SDKs** and **integrations** for the Prismer Cloud API.

---

## Available SDKs

| Language | Package | Install | Docs |
|----------|---------|---------|------|
| TypeScript / JavaScript | `@prismer/sdk` | `npm i @prismer/sdk` | [sdk/typescript/README.md](./sdk/typescript/README.md) |
| Python | `prismer` | `pip install prismer` | [sdk/python/README.md](./sdk/python/README.md) |
| Go | `github.com/Prismer-AI/PrismerCloud/sdk/golang` | `go get github.com/Prismer-AI/PrismerCloud/sdk/golang` | [sdk/golang/README.md](./sdk/golang/README.md) |
| Rust | `prismer` | `cargo add prismer` | [sdk/rust/README.md](./sdk/rust/README.md) |

## Integrations

| Integration | Package | Install |
|-------------|---------|---------|
| MCP Server (Claude Code / Cursor / Windsurf) | `@prismer/mcp-server` | `npx -y @prismer/mcp-server` |
| Claude Code Plugin | `@prismer/claude-code-plugin` | See [sdk/claude-code-plugin/README.md](./sdk/claude-code-plugin/README.md) |
| OpenCode Plugin | `@prismer/opencode-plugin` | See [sdk/opencode-plugin/README.md](./sdk/opencode-plugin/README.md) |
| OpenClaw Channel Plugin | `@prismer/openclaw-channel` | `openclaw plugins install @prismer/openclaw-channel` |

---

## API Coverage

All three SDKs provide full coverage of the Prismer Cloud API:

| API | Description |
|-----|-------------|
| **Context API** | Load, search, and save cached web content optimized for LLMs |
| **Parse API** | Extract structured markdown from PDFs and documents |
| **IM API** | Agent-to-agent and human-to-agent messaging, groups, conversations, contacts, credits, workspaces |
| **Real-Time** | WebSocket (bidirectional) and SSE (server-push) for live message delivery |

---

## Quick Start

### TypeScript

```typescript
import { PrismerClient } from '@prismer/sdk';

const client = new PrismerClient({ apiKey: 'sk-prismer-...' });

// Load context
const result = await client.context.load({ url: 'https://example.com' });

// Parse a document
const parsed = await client.parse.fromUrl({ url: 'https://example.com/paper.pdf' });
```

### Python

```python
from prismer import PrismerClient

client = PrismerClient(api_key="sk-prismer-...")

# Load context
result = client.context.load(url="https://example.com")

# Parse a document
parsed = client.parse.from_url(url="https://example.com/paper.pdf")
```

### Go

```go
import prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"

client := prismer.NewClient("sk-prismer-...")

// Load context
result, err := client.Context.Load(ctx, &prismer.ContextLoadParams{
    URL: "https://example.com",
})
```

---

## Authentication

All SDKs require an API key starting with `sk-prismer-`.

Get your key at [prismer.cloud](https://prismer.cloud).

---

## Repository Structure

```
PrismerCloud/
├── sdk/
│   ├── typescript/         # @prismer/sdk — TypeScript/JavaScript SDK
│   ├── python/             # prismer — Python SDK
│   ├── golang/             # Go SDK
│   ├── rust/               # prismer — Rust SDK
│   ├── mcp/                # @prismer/mcp-server — MCP integration
│   ├── claude-code-plugin/ # Claude Code plugin
│   ├── opencode-plugin/    # OpenCode plugin
│   ├── openclaw-channel/   # @prismer/openclaw-channel — OpenClaw plugin
│   ├── tests/              # Cross-SDK integration tests
│   └── scripts/            # Cross-SDK build scripts
├── README.md
└── LICENSE
```

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

<a href="https://github.com/Prismer-AI/PrismerCloud/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Prismer-AI/PrismerCloud" />
</a>

---

## Related Projects

- [Prismer.AI](https://github.com/Prismer-AI/Prismer) — The open-source research platform
- [Prismer Cloud](https://prismer.cloud) — Cloud API platform
- [Prismer Docs](https://docs.prismer.ai) — Full API documentation

---

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Built for researchers, by researchers.</sub>
</p>
