# Prismer Cloud SDKs (v1.7.4)

Official SDKs for the [Prismer Cloud](https://prismer.cloud) platform — Context, Parse, IM, Evolution, and Data Governance APIs with real-time WebSocket/SSE support.

## Available SDKs

| Language | Package | Version | Install | Docs | Changelog |
|----------|---------|---------|---------|------|-----------|
| TypeScript / JavaScript | `@prismer/sdk` | 1.7.4 | `npm i @prismer/sdk` | [README](./typescript/README.md) | [CHANGELOG](./typescript/CHANGELOG.md) |
| Python | `prismer` | 1.7.4 | `pip install prismer` | [README](./python/README.md) | [CHANGELOG](./python/CHANGELOG.md) |
| Go | `github.com/prismer-io/prismer-sdk-go` | 1.7.4 | `go get github.com/prismer-io/prismer-sdk-go` | [README](./golang/README.md) | [CHANGELOG](./golang/CHANGELOG.md) |
| Rust | `prismer-sdk` | 1.7.4 | `cargo add prismer-sdk` | [README](./rust/README.md) | [CHANGELOG](./rust/CHANGELOG.md) |

## Integrations

| Integration | Package | Version | Install | Changelog |
|-------------|---------|---------|---------|-----------|
| MCP Server (Claude Code / Cursor / Windsurf) | `@prismer/mcp-server` | 1.7.4 | `npx -y @prismer/mcp-server` | [CHANGELOG](./mcp/CHANGELOG.md) |
| Claude Code Plugin | `@prismer/claude-code-plugin` | 1.7.4 | See [README](./claude-code-plugin/README.md) | [CHANGELOG](./claude-code-plugin/CHANGELOG.md) |
| OpenCode Plugin | `@prismer/opencode-plugin` | 1.7.4 | See [README](./opencode-plugin/README.md) | [CHANGELOG](./opencode-plugin/CHANGELOG.md) |
| OpenClaw Channel Plugin | `@prismer/openclaw-channel` | 1.7.4 | `openclaw plugins install @prismer/openclaw-channel` | [CHANGELOG](./openclaw-channel/CHANGELOG.md) |

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
- **MCP Server** — [docs/api/mcp.md](../docs/api/mcp.md) (26 tools)
- **Live Docs** — [prismer.cloud/docs](https://prismer.cloud/docs)

## Authentication

All SDKs require an API key starting with `sk-prismer-`.

Get your key at [prismer.cloud](https://prismer.cloud).

## License

MIT
