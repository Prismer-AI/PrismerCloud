# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

PrismerCloud is a multi-language SDK monorepo for the [Prismer Cloud](https://prismer.cloud) API platform. It provides Context (web content), Parse (PDF/OCR), IM (agent messaging), and Evolution (cross-agent learning) APIs with real-time WebSocket/SSE support. All SDK code lives under `sdk/`.

## Critical: SDK Source of Truth

**`sdk/` 目录是从 `/Users/prismer/workspace/prismer-cloud-next/sdk/` 同步过来的，不是本地开发的。**

任何对 SDK 的修改（bug fix、新功能、配置变更）都必须：
1. 先在源码仓库 `prismer-cloud-next/sdk/` 中修改
2. 然后通过 `build/sync.sh` 同步到本仓库
3. 在本仓库验证、打包、发布

**绝对不要直接修改 `PrismerCloud/sdk/` 下的文件** — 下次 `build/sync.sh` 会覆盖所有改动。

本仓库的职责是：release 管道（sync → test → verify → pack → release），不是开发。

## Build & Release Pipeline

```bash
build/sync.sh          # 从源码仓库同步 sdk/
build/test.sh           # 运行所有测试（生产环境）
build/verify.sh         # 版本一致性 + 构建验证
build/pack.sh           # 打包所有产物到 build/artifacts/
build/release.sh        # 发布到 GitHub + npm + PyPI + crates.io
build/version.sh X.Y.Z  # 版本号全量更新（17 个文件）
```

完整文档见 `docs/release-workflow.md`。

## Build Commands

### Build All
```bash
cd sdk && chmod +x scripts/build-all.sh && ./scripts/build-all.sh
```

### Individual SDKs

| SDK | Install deps | Build | Test |
|-----|-------------|-------|------|
| TypeScript | `cd sdk/typescript && npm install` | `npm run build` (tsup) | `npm test` (vitest) |
| Python | `cd sdk/python && pip install -e '.[dev]'` | `python -m build` | `pytest` |
| Go | `cd sdk/golang` | `go build ./...` | `go test ./...` |
| Rust | `cd sdk/rust` | `cargo build` | `cargo test` |
| MCP Server | `cd sdk/mcp && npm install` | `npm run build` (tsup) | N/A |
| OpenCode Plugin | `cd sdk/opencode-plugin && npm install` | `npm run build` (tsup) | N/A |
| Claude Code Plugin | N/A | No build step | N/A |
| OpenClaw Channel | N/A | No build step | N/A |

### Run a single test
```bash
# TypeScript — single test file
cd sdk/typescript && npx vitest run tests/webhook.test.ts

# Python — single test
cd sdk/python && pytest tests/test_webhook.py -v

# Go — single test function
cd sdk/golang && go test -run TestVerifySignature -v

# Rust — single test
cd sdk/rust && cargo test test_verify_signature
```

### Lint
```bash
cd sdk/typescript && npm run lint          # eslint
cd sdk/python && ruff check . && mypy .    # ruff + mypy (strict mode, target py3.8)
cd sdk/rust && cargo clippy
```

### Integration tests (against production)
```bash
# Requires PRISMER_API_KEY_TEST env var
PRISMER_API_KEY_TEST="sk-prismer-..." build/test.sh

# Against test environment
PRISMER_API_KEY_TEST="sk-prismer-..." PRISMER_BASE_URL_TEST="https://cloud.prismer.dev" build/test.sh
```

## Architecture

### SDK structure — all four SDKs mirror the same module layout:

```
PrismerClient (main entry)
├── context     — load/search/save web content (HQCC compressed)
├── parse       — PDF/image → markdown (sync fast + async hires modes)
├── im          — IM sub-client
│   ├── account/direct/groups/conversations/contacts/credits
│   └── evolution — gene CRUD, analyze, record, sync
├── realtime    — WebSocket + SSE clients for live message delivery
├── offline     — queue mutations when offline, replay on reconnect
├── encryption  — E2E encryption (ECDH key exchange)
├── webhook     — HMAC-SHA256 signature verification
├── evolution-cache    — local gene cache with Thompson Sampling selection (<1ms)
├── evolution-runtime  — high-level API composing cache + signal enrichment + outbox
└── signal-rules       — pattern matching to extract signal tags from errors
```

### EvolutionRuntime — the key cross-cutting pattern

The most important abstraction across all SDKs. It composes three layers:
1. **EvolutionCache** — local Thompson Sampling gene selection (sub-millisecond, no network)
2. **Signal enrichment** — extracts signal tags from error strings to match genes
3. **Async outbox** — fire-and-forget outcome recording

Two-method API: `suggest(error) → strategy` and `learned(error, outcome, summary)`.

### Plugin architecture

Three coding-agent plugins share the same evolution loop pattern:
- **Claude Code Plugin** (`sdk/claude-code-plugin/`) — hooks (PreToolUse/PostToolUse) + MCP server (.mcp.json) + skills. No build step; files are used directly by Claude Code's plugin system.
- **OpenCode Plugin** (`sdk/opencode-plugin/`) — TypeScript entry points compiled with tsup. Uses `tool.execute.before`/`tool.execute.after` hooks.
- **OpenClaw Channel** (`sdk/openclaw-channel/`) — TypeScript source distributed as-is (OpenClaw compiles it). Registered via `openclaw.plugin.json`.

## Key Conventions

- All SDKs authenticate with API keys prefixed `sk-prismer-`. Base URL: `https://prismer.cloud`.
- TypeScript SDK exports CJS + ESM + DTS. The `webhook` module has a separate export path (`@prismer/sdk/webhook`).
- Python targets `>=3.8` with `httpx` (async HTTP) + `pydantic` (models) + `websockets` (realtime).
- Go module path: `github.com/Prismer-AI/Prismer/sdk/golang` (uses cobra CLI + nhooyr websocket).
- Rust crate: `prismer-sdk` (async with reqwest + tokio).
- MCP Server uses `@modelcontextprotocol/sdk` and exposes 23 tools (context, parse, IM, evolution, memory, tasks).
- Version is `1.7.2` across all packages — keep them in sync when bumping.

## API Surface

85+ endpoints across 15 groups. The `sdk/Skill.md` file contains the complete CLI reference with all commands and flags — use it as the authoritative API reference.
