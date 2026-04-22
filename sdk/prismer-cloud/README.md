# Prismer Cloud SDKs (v1.9.0)

Official SDKs for the [Prismer Cloud](https://prismer.cloud) platform — Context, Parse, IM, Evolution, and Data Governance APIs with real-time WebSocket/SSE support.

> **Package surface:** `sdk/prismer-cloud/` currently ships 14 publishable package surfaces: 10 npm packages, 2 PyPI packages, 1 Rust crate, and 1 Go module.
>
> **Versioning:** Platform-coupled packages follow the unified v1.9.0 release. `@prismer/wire`, `@prismer/adapters-core`, and Hermes adapters stay on independent 0.x versions — see [`sdk/build/WORKFLOW.md`](../build/WORKFLOW.md).

## Available SDKs

| Language | Package | Version | Install | Docs | Changelog |
|----------|---------|---------|---------|------|-----------|
| TypeScript / JavaScript | `@prismer/sdk` | 1.9.0 | `npm i @prismer/sdk` | [README](./typescript/README.md) | [CHANGELOG](./typescript/CHANGELOG.md) |
| Python | `prismer` | 1.9.0 | `pip install prismer` | [README](./python/README.md) | [CHANGELOG](./python/CHANGELOG.md) |
| Go | `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` | 1.9.0 | `go get github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang@v1.9.0` | [README](./golang/README.md) | [CHANGELOG](./golang/CHANGELOG.md) |
| Rust | `prismer-sdk` | 1.9.0 | `cargo add prismer-sdk` | [README](./rust/README.md) | [CHANGELOG](./rust/CHANGELOG.md) |

## Integrations

| Integration | Package | Version | Install | Changelog |
|-------------|---------|---------|---------|-----------|
| MCP Server (Claude Code / Cursor / Windsurf) | `@prismer/mcp-server` | 1.9.0 | `npx -y @prismer/mcp-server` | [CHANGELOG](./mcp/CHANGELOG.md) |
| Claude Code Plugin | `@prismer/claude-code-plugin` | 1.9.0 | See [README](./claude-code-plugin/README.md) | [CHANGELOG](./claude-code-plugin/CHANGELOG.md) |
| OpenCode Plugin | `@prismer/opencode-plugin` | 1.9.0 | See [README](./opencode-plugin/README.md) | [CHANGELOG](./opencode-plugin/CHANGELOG.md) |
| OpenClaw Channel Plugin | `@prismer/openclaw-channel` | 1.9.0 | `openclaw plugins install @prismer/openclaw-channel` | [CHANGELOG](./openclaw-channel/CHANGELOG.md) |

## Runtime & PARA Infrastructure

New in v1.9.0 — the modular runtime and Prismer Agent Runtime ABI (PARA) building blocks.

| Package | Name | Version | Install | Purpose |
|---------|------|---------|---------|---------|
| Runtime Daemon | `@prismer/runtime` | 1.9.0 | `npm i -g @prismer/runtime` | Agent supervisor, local HTTP API, event bus, CLI (`prismer pair`, `migrate`, `status`, `daemon`) |
| Wire Protocol | `@prismer/wire` | 0.1.0 | `npm i @prismer/wire` | Canonical PARA wire schemas |
| Adapters Core | `@prismer/adapters-core` | 0.1.0 | `npm i @prismer/adapters-core` | Shared utilities for PARA adapters |
| Sandbox Runtime | `@prismer/sandbox-runtime` | 1.9.0 | `npm i @prismer/sandbox-runtime` | FS sandbox types + FROZEN lists (seatbelt/AppArmor/bwrap) |

## Adapters

Framework-specific PARA adapters (independent 0.x versioning).

| Adapter | Package | Version | Registry | Install |
|---------|---------|---------|----------|---------|
| Hermes (Python) | `prismer-adapter-hermes` | 0.2.0 | PyPI | `pip install prismer-adapter-hermes` |
| Hermes (Node) | `@prismer/adapter-hermes` | 0.1.0 | npm | `npm i @prismer/adapter-hermes` |

## API Coverage

All four SDKs provide full coverage of the Prismer Cloud API (125 endpoints, 233 tested code samples):

- **Context API** — Load, search, and save cached web content optimized for LLMs
- **Parse API** — Extract structured markdown from PDFs and documents
- **IM API** — Agent-to-agent and human-to-agent messaging, groups, conversations, contacts, credits, workspaces
- **Evolution API** — Gene management, analyze/record, Thompson Sampling cache, cross-agent learning
- **Skills API** — Browse, search, install 19,000+ agent skills from catalog
- **AIP Identity** — DID-based agent identity, delegation chains, verifiable credentials (re-exports `@prismer/aip-sdk`)
- **Tasks / Memory / Identity / Security** — Cloud task store, episodic memory, key management, E2E encryption
- **Real-Time** — WebSocket (bidirectional) and SSE (server-push) for live message delivery

## EvolutionRuntime

All four SDKs include `EvolutionRuntime` — a high-level abstraction that composes cache + signal enrichment + outbox into two simple methods:

```
# 2 steps instead of 7
fix = runtime.suggest("ETIMEDOUT: connection timed out")   # cache-first <1ms, server fallback
runtime.learned("ETIMEDOUT", "success", "Fixed by backoff") # fire-and-forget
metrics = runtime.get_metrics()                             # GUR, success rates, cache hit rate
```

## Documentation

- **API Reference** — [docs/api/](../docs/api/) (per-domain markdown)
- **OpenAPI Spec** — [docs/openapi.yaml](../docs/openapi.yaml) (auto-generated from [docs/specs/](../docs/specs/))
- **MCP Server** — [docs/api/mcp.md](../docs/api/mcp.md) (47 tools)
- **Live Docs** — [prismer.cloud/docs](https://prismer.cloud/docs)

## Authentication

All SDKs require an API key starting with `sk-prismer-`.

Get your key at [prismer.cloud](https://prismer.cloud).

## License

MIT
