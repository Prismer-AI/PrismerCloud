# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**The Intelligence Runtime for AI Agents** — open-source SDK repository for Prismer Cloud.

- `sdk/` — multi-language client SDKs and plugins (AIP identity + Prismer Cloud platform families).

> **Note:** The server backend is closed-source and is **not** included in this public repository. This repo is SDK-only.

## SDK Sync Pipeline (critical mental model)

The `sdk/` directory mirrors the closed-source repo `gitlab.app:prismer/prismercloud` (local clone: `~/codes/prismer/prismercloud`). **The active upstream branch is `feat/workspace-release` — closed `main` is stale (stuck at v1.8.0); never sync from it.**

| Pipeline | Target | Driver |
|---|---|---|
| SDK sync | `sdk/` (whole-directory rsync --delete) | `sdk/build/sync.sh`, run FROM the closed repo with `OPENSRC_ROOT=<this repo> ... --yes` |

Rules:

- Don't hand-edit mirrored content under `sdk/` — fix it in the closed repo and re-sync.
- Split of duties: closed repo runs compile/pack/test; **this repo runs release** (`sdk/build/release.sh`).

## SDK Layout

```
sdk/
├── aip/                # Agent Identity Protocol: typescript/ python/ golang/ rust/ + docs/
├── prismer-cloud/      # platform: typescript/ python/ golang/ rust/ (language SDKs)
│   ├── runtime/        # @prismer/runtime (hermes adapters under src/adapters/)
│   ├── mcp/            # @prismer/mcp-server
│   ├── claude-code-plugin/  opencode-plugin/  openclaw-channel/
│   ├── built-in-skills/     # runtime skill resource pool
│   └── samples/  skill/  scripts/  icon/
├── build/              # release pipeline (sync.sh, test.sh, pack.sh, release.sh, version.sh, hotfix.sh)
└── README.md
```

`@prismer/aip-sdk` is a peer dependency of `@prismer/sdk`. Go module paths: `github.com/nicepkg/aip-sdk-go` (AIP) vs `github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang` (Cloud).

## Build / Test / Release

```bash
sdk/build/test.sh    --scope aip|prismer-cloud|all   # build/test/verify gates
sdk/build/pack.sh    --scope all --clean
sdk/build/release.sh --scope aip                     # publish AIP first, then prismer-cloud
sdk/build/version.sh --scope <family> <semver>       # coordinated version bump (root VERSION)
sdk/build/hotfix.sh  <pkg> <X.Y.Z.N|--auto>          # single-package out-of-band bump
```

Release gates (build → local-install → sandbox smoke) must pass before `release.sh` publishes; see [`sdk/build/WORKFLOW.md`](sdk/build/WORKFLOW.md).

Per-language conventions (same in every package dir):

- **TS**: `npm install && npm run build` (tsup, CJS+ESM+DTS), `npm test` (Cloud = vitest, e.g. `npx vitest run tests/webhook.test.ts`; AIP = plain `npx tsx test/aip.test.ts`), `npm run lint`.
- **Python**: `pip install -e '.[dev]'`, `pytest [tests/test_x.py -v]`, `ruff check . && mypy .` (httpx + pydantic + websockets; AIP targets ≥3.9).
- **Go**: `go build ./...`, `go test [-run TestName -v] ./...`.
- **Rust**: `cargo build`, `cargo test [name]`, `cargo clippy`.

Integration tests need `PRISMER_API_KEY_TEST` (never hardcode — GitGuardian blocks PRs); optional `PRISMER_BASE_URL_TEST`.

## Cookbook Contract Tests (`.test/`)

`.test/cookbook/` validates that `docs/cookbook/` capabilities = real API behavior (8 files, 52 tests; open-side owned).

## EvolutionRuntime — key cross-cutting pattern

Composes three layers in every language SDK (`sdk/prismer-cloud/<lang>/`): **EvolutionCache** (local Thompson Sampling gene selection, sub-ms), **signal enrichment** (error string → signal tags), **async outbox** (fire-and-forget outcome recording). Two-method API: `suggest(error) → strategy`, `learned(error, outcome, summary)`. Signal patterns live in the `signal-rules` module.

## Plugin Architecture

Three coding-agent plugins share the evolution loop: **claude-code-plugin** (hooks + MCP via `.mcp.json` + skills; no build step), **opencode-plugin** (tsup-compiled, `tool.execute.before/after` hooks), **openclaw-channel** (TS source distributed as-is, registered via `openclaw.plugin.json`).

## Key Conventions

- API keys are `sk-prismer-…` (real keys `sk-prismer-live-…`); base URL `https://prismer.cloud`. Cloud TS SDK's `webhook` module has a separate export path (`@prismer/sdk/webhook`).
- Positioning copy everywhere: **"The Intelligence Runtime for AI Agents"** (decided 2026-06-11; don't reintroduce "Harness for AI Agent Evolution" / "Knowledge Drive" taglines).
- Never hardcode versions/endpoint counts in docs; consult package manifests. Canonical API surface map: `sdk/prismer-cloud/skill/` (and published Skill.md), not individual SDK clients.
