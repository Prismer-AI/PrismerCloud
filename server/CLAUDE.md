# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Prismer Cloud is a Next.js 16 SaaS application — "The Intelligence Runtime for AI Agents": workspace (sessions / task board / assets / insights), agent IM with task orchestration, the evolution engine, plus context processing, global caching, and document extraction. TypeScript, React 19, Tailwind CSS 4.

This tree is a sync target mirrored from the closed-source repo (see top-level `CLAUDE.md`, *Two Sync Pipelines*). This file itself is open-side owned (sync-blacklisted), as are README.md, docker/, .github/, and server/sdk/.

## Commands

```bash
# Development
npm run dev        # Custom server (HTTP + WebSocket + SSE on port 3000) via npx tsx server.ts
npm run dev:next   # Plain Next.js dev server (no WS/SSE support)
npm run build      # Production build (standalone output for Docker)
npm run start      # Production custom server

# Quality
npm run lint / check / format / circular

# Prisma — generate BOTH clients before build or tsc will fail on the MySQL client
npm run prisma:generate        # SQLite client (dev)
npm run prisma:generate:mysql  # MySQL client → prisma/generated/mysql/
npm run prisma:generate:all

# Tests (vitest since v2.0)
npm test                # vitest run (full suite)
npm run test:unit       # src/lib/__tests__
npm run test:skills     # built-in skill runners via tsx
npx tsx src/im/tests/<name>.test.ts   # IM custom runners (no framework)
```

Known mirror limitation: a few `src/lib/__tests__` parity tests read `sdk/prismer-cloud/runtime/...` relative to the server root (closed-repo layout) and fail with ENOENT here — `server/sdk/` is a curated copy, not the full SDK tree.

## Architecture

### Custom Server (WebSocket + SSE)

One HTTP server shares port 3000 for Next.js, WS (`/ws`), and SSE (`/sse`):

- **Dev:** `server.ts` — creates the server, attaches handlers, delegates the rest to Next.js.
- **Prod:** `server.prod.js` — monkey-patches `http.createServer` before loading the Next.js standalone `_next_server.js` to intercept the server Next.js creates internally.

Both read IM handlers from `globalThis` (populated by `instrumentation.ts` → `bootstrap.ts`). The custom server files must NOT import `src/im/*` directly.

### IM Server (Agent Messaging)

Hono app **embedded in the Next.js process** — all IM APIs served on port 3000 via `/api/im/*` (route handler calls `app.fetch()` in-process). Disable with `IM_SERVER_ENABLED=false`.

- `src/im/services/` — business logic; `src/im/agent-protocol/` — agent cards, heartbeat, discovery; `src/im/sql/` — MySQL migrations; `src/im/tests/` — custom runners.
- Rate limiting is trust-tier based (`src/im/services/rate-limiter.service.ts`): tier-0 users get `tool_call` **2/min** in production (10× in dev); tier ≥ 4 is exempt (`im_users.trustTier`). Evolution writes, file uploads etc. consume these budgets — relevant for tests and demos.

### Dual Prisma Schema

- `prisma/schema.prisma` — sqlite, default client (local dev); `prisma/schema.mysql.prisma` — mysql → `prisma/generated/mysql/` (test/prod).
- `src/lib/prisma.ts` picks the client by `DATABASE_URL` prefix (`mysql://` → MySQL client, else SQLite).

### Routing & Key Directories

App Router under `src/app/` (pages: `/`, `/workspace`, `/playground`, `/dashboard`, `/auth`, `/docs`, `/evolution`, `/community`). `next.config.ts` rewrites `/api/v1/*` → `/api/*`. `@/*` maps to `./src/*`. `src/lib/api.ts` = frontend API client; `src/components/ui/` = shadcn (new-york); `packages/asset-viewers/` is path-aliased as `@prismer/asset-viewers` in tsconfig.

### Feature Flags & Auth

`src/lib/feature-flags.ts` — `FF_*_LOCAL=true` switches API routes from external-backend proxy to local implementations; self-host sets all local. Auth is dual: JWT sessions + API keys (`sk-prismer-*`). Modes: `AUTH_DISABLED=true` (no login wall, private deploys), `FF_AUTH_LOCAL=true` (local JWT via `JWT_SECRET`). v2 login (`src/lib/auth/local-auth.ts`) reads **im_users** (password = bcrypt(SHA256(plaintext)) — the frontend posts the SHA256 hex).

**Self-host auth gotchas (v2.0.8):** `INIT_ADMIN_EMAIL/PASSWORD` bootstrap writes the legacy `pc_users` table, which v2 login does not read — the bootstrap admin cannot log in. Self-serve signup needs an email provider (verification codes live in Redis; `SKIP_EMAIL_VERIFICATION` only affects the legacy path). Workaround: seed `im_users` directly (see `walkthrough/walkthrough.md` "环境准备"), then mint an API key via `POST /api/keys` with the JWT.

## Self-Host (docker compose)

```bash
docker compose up -d   # zero config: MySQL 8 + Redis 7 bundled; first boot runs ~150 SQL migrations (~1 min)
```

Defaults live in docker-compose.yml; override via `.env` (`cp .env.example .env`). The entrypoint applies Prisma + IM SQL migrations automatically. Health: `/api/health`. File uploads in local-storage mode return a **relative** `/api/im/files/dev-upload/<id>` URL that requires the same `Authorization` header (S3 mode returns a bare absolute URL). Port busy? `PORT=3100 docker compose up -d`.

Docker build is multi-stage Node 20 Alpine, standalone output, both Prisma clients generated in the build stage, and COPYs `sdk/prismer-cloud/built-in-skills/` (runtime resource pool read via `process.cwd()`).

## server/sdk/

Hand-curated self-host SDK examples + the mirrored `built-in-skills` pool — NOT the full SDK tree (that lives at top-level `sdk/`, synced separately). Don't expect upstream sdk paths here.

## Conventions

- Logging: `console.log('[ModuleName] Action: details')`; errors with `❌`.
- API responses: `{ success, data, error: { code, message }, requestId, processingTime }`.
- API smoke: `curl -X POST localhost:3000/api/context/load -H "Authorization: Bearer $PRISMER_API_KEY" -d '{"input":"https://example.com"}'`.
- Docs: `docs/SELF-HOST.md`, `docs/API.md`, `docs/openapi.yaml`; cookbook contract tests live at repo-root `.test/` (52 tests, self-host runbook in `.test/README.md`).
