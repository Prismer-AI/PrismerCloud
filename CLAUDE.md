# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**The Intelligence Runtime for AI Agents** — open-source side of Prismer Cloud. Two halves:

- `sdk/` — multi-language client SDKs and plugins (AIP identity + Prismer Cloud platform families).
- `server/` — Next.js 16 self-host backend (Workspace + IM + Evolution + Context/Parse APIs, WS/SSE on one custom port). Read [`server/CLAUDE.md`](server/CLAUDE.md) before touching `server/`.

## Two Sync Pipelines (critical mental model)

Both halves mirror the closed-source repo `gitlab.app:prismer/prismercloud` (local clone: `~/codes/prismer/prismercloud`). **The active upstream branch is `feat/workspace-release` — closed `main` is stale (stuck at v1.8.0); never sync from it.**

| Pipeline | Target | Driver |
|---|---|---|
| SDK sync | `sdk/` (whole-directory rsync --delete) | `sdk/build/sync.sh`, run FROM the closed repo with `OPENSRC_ROOT=<this repo> ... --yes` |
| Server sync | `server/` (3-way merge, whitelist/blacklist/content-scrub) | `build/sync-server/sync-server.sh plan --source-ref feat/workspace-release` → resolve conflicts in `state/stage/` → `apply` |

Rules:

- Don't hand-edit mirrored content under `sdk/` or `server/` — fix it in the closed repo and re-sync. **Exception:** paths in `build/sync-server/blacklist.txt` (server/CLAUDE.md, server/README.md, docker/, .github/, docs/, server/sdk/…) are open-side owned and edited here directly.
- Server sync base ref is recorded in `build/sync-server/LAST-SYNC.md` (tracked); `state/` and `patches/` are gitignored output. Sync commits look like `[PATCH NNN/TOTAL] feat(self-host): modify <path>` — preserve that prefix when rebasing.
- The scrub gate (`content-scrub.txt`) blocks staged secrets/internal identifiers at `apply`; real keys are `sk-prismer-live-…` format — patterns must tolerate hyphens.
- Post-sync verification trio in `server/`: `npm ci` → `npx prisma generate` + `npx prisma generate --schema=prisma/schema.mysql.prisma` → `npm run build`. If tsc suddenly shows mass implicit-any, suspect environment (stale ambient .d.ts shims, missing Prisma clients) before blaming the merge — upstream HEAD type-checks clean.
- The two `build/` dirs differ: `sdk/build/` = SDK release pipeline; top-level `build/sync-server/` = server sync tool.
- Split of duties: closed repo runs compile/pack/test; **this repo runs release** (`sdk/build/release.sh`).

## SDK Layout

```
sdk/
├── aip/                # Agent Identity Protocol: typescript/ python/ golang/ rust/ + docs/
├── prismer-cloud/      # platform: typescript/ python/ golang/ rust/ (language SDKs)
│   ├── runtime/        # @prismer/runtime (hermes adapters under src/adapters/)
│   ├── mcp/            # @prismer/mcp-server
│   ├── claude-code-plugin/  opencode-plugin/  openclaw-channel/
│   ├── built-in-skills/     # runtime skill resource pool (mirrored into server/sdk/… for Docker)
│   └── samples/  skill/  scripts/  icon/
│   # 0.x adapters/ adapters-core/ wire/ sandbox-runtime/ were retired upstream in v2.0
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

`.test/cookbook/` validates that `docs/cookbook/` capabilities = real API behavior (8 files, 52 tests; open-side owned). Self-host runbook incl. user seeding and the trust-tier rate-limit escape (`UPDATE im_users SET trustTier=4`) is in `.test/README.md` — tier-0 accounts get `tool_call` 2/min in production, which 429s rapid evolution writes.

## EvolutionRuntime — key cross-cutting pattern

Composes three layers in every language SDK (`sdk/prismer-cloud/<lang>/`): **EvolutionCache** (local Thompson Sampling gene selection, sub-ms), **signal enrichment** (error string → signal tags), **async outbox** (fire-and-forget outcome recording). Two-method API: `suggest(error) → strategy`, `learned(error, outcome, summary)`. Signal patterns live in the `signal-rules` module.

## Plugin Architecture

Three coding-agent plugins share the evolution loop: **claude-code-plugin** (hooks + MCP via `.mcp.json` + skills; no build step), **opencode-plugin** (tsup-compiled, `tool.execute.before/after` hooks), **openclaw-channel** (TS source distributed as-is, registered via `openclaw.plugin.json`).

## Key Conventions

- API keys are `sk-prismer-…` (real keys `sk-prismer-live-…`); base URL `https://prismer.cloud`. Cloud TS SDK's `webhook` module has a separate export path (`@prismer/sdk/webhook`).
- Positioning copy everywhere: **"The Intelligence Runtime for AI Agents"** (decided 2026-06-11; don't reintroduce "Harness for AI Agent Evolution" / "Knowledge Drive" taglines).
- Never hardcode versions/endpoint counts in docs; consult package manifests. Canonical API surface map: `sdk/prismer-cloud/skill/` (and published Skill.md), not individual SDK clients.
- Self-host installer: top-level `install.sh` (published at `https://prismer.cloud/install.sh`) — keep its embedded `VERSION` in step with releases.
- Self-host visual tour lives in `walkthrough/` (`record.mjs` re-records 12 scenes via Playwright against a running compose stack).
