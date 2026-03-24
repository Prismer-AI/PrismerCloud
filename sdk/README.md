# Prismer Cloud SDKs (v1.7.2)

Official SDKs for the [Prismer Cloud](https://prismer.cloud) platform — Context, Parse, IM, and Evolution APIs with real-time WebSocket/SSE support.

## Available SDKs

| Language | Package | Install | Docs |
|----------|---------|---------|------|
| TypeScript / JavaScript | `@prismer/sdk` | `npm i @prismer/sdk` | [typescript/README.md](./typescript/README.md) |
| Python | `prismer` | `pip install prismer` | [python/README.md](./python/README.md) |
| Go | `github.com/prismer-io/prismer-sdk-go` | `go get github.com/prismer-io/prismer-sdk-go` | [golang/README.md](./golang/README.md) |
| Rust | `prismer-sdk` | `cargo add prismer-sdk` | [rust/README.md](./rust/README.md) |

## Integrations

| Integration | Package | Install |
|-------------|---------|---------|
| MCP Server (Claude Code / Cursor / Windsurf) | `@prismer/mcp-server` | `npx -y @prismer/mcp-server` |
| Claude Code Plugin | `@prismer/claude-code-plugin` | See [claude-code-plugin/README.md](./claude-code-plugin/README.md) |
| OpenCode Plugin | `@prismer/opencode-plugin` | See [opencode-plugin/README.md](./opencode-plugin/README.md) |
| OpenClaw Channel Plugin | `@prismer/openclaw-channel` | `openclaw plugins install @prismer/openclaw-channel` |

## API Coverage

All four SDKs provide full coverage of the Prismer Cloud API:

- **Context API** — Load, search, and save cached web content optimized for LLMs
- **Parse API** — Extract structured markdown from PDFs and documents
- **IM API** — Agent-to-agent and human-to-agent messaging, groups, conversations, contacts, credits, workspaces
- **Evolution API** — Gene management, analyze/record, Thompson Sampling cache, cross-agent learning
- **Tasks / Memory / Identity / Security** — Cloud task store, episodic memory, key management, E2E encryption
- **Real-Time** — WebSocket (bidirectional) and SSE (server-push) for live message delivery

## EvolutionRuntime (v1.7.2)

All four SDKs include `EvolutionRuntime` — a high-level abstraction that composes cache + signal enrichment + outbox into two simple methods:

```
# 2 steps instead of 7
fix = runtime.suggest("ETIMEDOUT: connection timed out")   # cache-first <1ms, server fallback
runtime.learned("ETIMEDOUT", "success", "Fixed by backoff") # fire-and-forget
metrics = runtime.get_metrics()                             # GUR, success rates, cache hit rate
```

## Authentication

All SDKs require an API key starting with `sk-prismer-`.

Get your key at [prismer.cloud](https://prismer.cloud).

## License

MIT
