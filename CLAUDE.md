# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**The Harness for AI Agent Evolution** — open-source side of Prismer Cloud. The repo has two halves:

- `sdk/` — multi-language client SDKs and plugins. Two product families (AIP identity + Prismer Cloud platform), four target languages each, plus runtime/MCP/adapter/plugin surfaces.
- `server/` — Next.js 16 self-host backend (Context + Parse + IM + Evolution APIs, WebSocket/SSE on a single custom port). Has its own [`server/CLAUDE.md`](server/CLAUDE.md) — read it before touching anything under `server/`.

Both halves are mirrored from closed-source sources; **do not hand-edit either tree** (see *Two Sync Pipelines* below).

## Two Sync Pipelines (critical mental model)

This repo is the *target* of two independent sync flows. Mixing them up will create lost-work bugs.

| Pipeline | Source | Target | Driver |
|---|---|---|---|
| **SDK sync** | closed-source `prismer-cloud-next/sdk/` | `sdk/` (whole-directory rsync --delete) | `sdk/build/sync.sh` |
| **Server sync** | closed-source `gitlab.app:prismer/prismercloud` | `server/` (whitelist + content-scrub + author-attributed patches) | `build/sync-server/sync-server.sh` |

Implications:

- **Never edit files under `sdk/` or `server/` directly in this repo** — the next sync overwrites them. Make the change in the closed-source source, then re-sync.
- The two `build/` dirs are different: `sdk/build/` = SDK release pipeline; `build/sync-server/` (top-level) = server sync tool with its own `whitelist.txt`/`blacklist.txt`/`content-scrub.txt`.
- Split of duties: closed-source repo runs compile/pack/test (up to `pack`); **this repo runs release** (`sdk/build/release.sh`).
- Server sync emits per-patch commits like `[PATCH NNN/TOTAL] feat(self-host): modify <path>` — preserve that prefix when rebasing or squashing.

## SDK Layout

```
sdk/
├── aip/                          # AIP — Agent Identity Protocol (4 publishable packages)
│   ├── typescript/   python/  golang/  rust/
│   └── docs/
├── prismer-cloud/                # Prismer Cloud platform (14 publishable surfaces)
│   ├── typescript/  python/  golang/  rust/    # language SDKs
│   ├── runtime/                  # @prismer/runtime
│   ├── mcp/                      # @prismer/mcp-server
│   ├── claude-code-plugin/  opencode-plugin/  openclaw-channel/
│   ├── adapters/   adapters-core/   wire/       # independent 0.x line (hotfix release)
│   ├── sandbox-runtime/  samples/  skill/  scripts/
│   └── icon/  smallicon/
├── build/                        # shared release pipeline (see below)
└── README.md                     # canonical family overview
```

`@prismer/aip-sdk` is a peer of `@prismer/sdk` (Prismer Cloud TS SDK depends on it). Go module paths differ: `github.com/nicepkg/aip-sdk-go` for AIP vs `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` for Cloud.

## Build & Release Pipeline (sdk/build/)

```bash
# Closed-source → open-source sync (whole-directory replace under sdk/)
sdk/build/sync.sh

# Scope-aware build/test/verify gates
sdk/build/test.sh    --scope aip|prismer-cloud|all
sdk/build/pack.sh    --scope all --clean       # build artifacts only
sdk/build/release.sh --scope aip               # publish AIP first
sdk/build/release.sh --scope prismer-cloud     # then Cloud

# Version bumps
sdk/build/version.sh --scope aip <semver>           # coordinated 1.x packages
sdk/build/version.sh --scope prismer-cloud <semver>
sdk/build/hotfix.sh                                  # independent 0.x packages (@prismer/wire, adapters-core, hermes adapters)
```

Release gates (build → local-install → sandbox smoke) must all pass before `release.sh` publishes. Full workflow lives in [`sdk/build/WORKFLOW.md`](sdk/build/WORKFLOW.md).

## Individual SDK Commands

| Package | Install | Build | Test |
|---|---|---|---|
| `sdk/aip/typescript` | `npm install` | `npm run build` (tsup) | `npm test` (plain `tsx test/aip.test.ts`) |
| `sdk/aip/python` | `pip install -e '.[dev]'` | `python -m build` | `pytest` |
| `sdk/aip/golang` | — | `go build ./...` | `go test ./...` |
| `sdk/aip/rust` | — | `cargo build` | `cargo test` |
| `sdk/prismer-cloud/typescript` | `npm install` | `npm run build` (tsup) | `npm test` (vitest) |
| `sdk/prismer-cloud/python` | `pip install -e '.[dev]'` | `python -m build` | `pytest` |
| `sdk/prismer-cloud/golang` | — | `go build ./...` | `go test ./...` |
| `sdk/prismer-cloud/rust` | — | `cargo build` | `cargo test` |
| `sdk/prismer-cloud/mcp` | `npm install` | `npm run build` (tsup) | N/A |
| `sdk/prismer-cloud/runtime` | `npm install` | `npm run build` | varies |
| `sdk/prismer-cloud/{claude-code-plugin,opencode-plugin,openclaw-channel}` | varies | varies | N/A |

### Run a single test

```bash
# Prismer Cloud TS — single vitest file
cd sdk/prismer-cloud/typescript && npx vitest run tests/webhook.test.ts

# AIP TS — pick a test in the harness (no vitest)
cd sdk/aip/typescript && npx tsx test/aip.test.ts

# Python — single test
cd sdk/prismer-cloud/python && pytest tests/test_webhook.py -v

# Go — single test function
cd sdk/prismer-cloud/golang && go test -run TestVerifySignature -v

# Rust — single test
cd sdk/prismer-cloud/rust && cargo test test_verify_signature
```

### Lint

```bash
cd sdk/prismer-cloud/typescript && npm run lint        # eslint
cd sdk/prismer-cloud/python      && ruff check . && mypy .
cd sdk/prismer-cloud/rust        && cargo clippy
```

### Integration tests (against production)

```bash
# Requires PRISMER_API_KEY_TEST env var; never hardcode (GitGuardian blocks PRs)
PRISMER_API_KEY_TEST="sk-prismer-..." sdk/build/test.sh --scope all
PRISMER_API_KEY_TEST="sk-prismer-..." PRISMER_BASE_URL_TEST="https://cloud.prismer.dev" sdk/build/test.sh --scope all
```

## Server (Next.js 16 SaaS)

The `server/` tree is a complete Next.js 16 app — it has its own `package.json`, Prisma schemas, custom HTTP+WS+SSE server, and embedded IM (Hono) service. **Defer to [`server/CLAUDE.md`](server/CLAUDE.md) for**: dev/build/start commands, IM standalone test runners, dual Prisma schema setup (sqlite local / mysql prod), self-host docker compose, feature-flag matrix, and Next.js 16 routing conventions.

Quick top-level pointers for cross-references:

- Self-host installer: top-level `install.sh` (also published at `https://prismer.cloud/install.sh`).
- Server sync state lives in `build/sync-server/state/` (gitignored runtime cache); patches are in `build/sync-server/patches/`.

## EvolutionRuntime — key cross-cutting pattern

The most important abstraction across all Prismer Cloud SDKs. It composes three layers:

1. **EvolutionCache** — local Thompson Sampling gene selection (sub-millisecond, no network).
2. **Signal enrichment** — extracts signal tags from error strings to match genes.
3. **Async outbox** — fire-and-forget outcome recording.

Two-method API: `suggest(error) → strategy` and `learned(error, outcome, summary)`. Implemented in each language under `sdk/prismer-cloud/<lang>/`. Signal patterns live in `signal-rules` module.

## Plugin Architecture

Three coding-agent plugins share the same evolution loop pattern:

- **Claude Code Plugin** (`sdk/prismer-cloud/claude-code-plugin/`) — hooks (`PreToolUse`/`PostToolUse`) + MCP server via `.mcp.json` + skills. No build step; files are consumed directly by Claude Code's plugin loader.
- **OpenCode Plugin** (`sdk/prismer-cloud/opencode-plugin/`) — TypeScript entry points compiled with tsup. Uses `tool.execute.before` / `tool.execute.after` hooks.
- **OpenClaw Channel** (`sdk/prismer-cloud/openclaw-channel/`) — TypeScript source distributed as-is (OpenClaw compiles it). Registered via `openclaw.plugin.json`.

## Key Conventions

- All SDKs authenticate with API keys prefixed `sk-prismer-`. Base URL: `https://prismer.cloud`.
- TypeScript SDKs export CJS + ESM + DTS via tsup. The Cloud SDK's `webhook` module has a separate export path (`@prismer/sdk/webhook`).
- Python SDKs use `httpx` (async HTTP) + `pydantic` (models) + `websockets` (realtime). AIP targets `>=3.9`; Cloud may target older.
- AIP coordinated `1.x` packages share a version; Prismer Cloud has mixed cadence — coordinated `1.x` SDKs vs independent `0.x` adapters / wire (released via `hotfix.sh`). Never hardcode versions in this doc; consult each package's manifest.
- MCP Server exposes ~23 tools across context, parse, IM, evolution, memory, tasks namespaces.

## API Surface

85+ endpoints across 15 groups. `sdk/prismer-cloud/skill/` (and `sdk/Skill.md` if present) contains the canonical CLI reference — use it as the authoritative API surface map rather than scraping individual SDK clients.
