# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Prismer Cloud is a Next.js 16 SaaS application — a "Knowledge Drive for AI Agents" providing intelligent context processing, global caching, and document extraction. Built with TypeScript, React 19, and Tailwind CSS 4.

## Commands

```bash
# Development
npm run dev        # Custom server (HTTP + WebSocket + SSE on port 3000) via npx tsx server.ts
npm run dev:next   # Plain Next.js dev server (no WS/SSE support)
npm run build      # Production build (standalone output for Docker)
npm run start      # Production custom server (node custom-server.js)

# Quality
npm run lint       # ESLint
npm run check      # ESLint + tsc --noEmit (combined)
npm run format     # Prettier --write on src/**/*.{ts,tsx}
npm run circular   # madge circular dependency check

# IM Server (standalone, for testing without Next.js)
npm run im:start   # Start IM server standalone (Hono on port 3200)
npm run im:dev     # Same with file watch

# Prisma
npm run prisma:generate        # Generate SQLite client (dev)
npm run prisma:generate:mysql  # Generate MySQL client (prisma/generated/mysql/)
npm run prisma:generate:all    # Generate both clients

# Testing
npm run test:all:local   # Multi-env test script against localhost
```

No automated test framework (no vitest/jest). IM server has custom test runners in `src/im/tests/`.

## Architecture

### Custom Server (WebSocket + SSE)

The app uses a custom HTTP server that shares port 3000 for Next.js, WebSocket, and SSE:

- **Dev:** `server.ts` — creates `http.createServer`, attaches `WebSocketServer` on `/ws`, SSE handler on `/sse`, then passes everything else to Next.js
- **Prod:** `server.prod.js` — monkey-patches `http.createServer` before loading Next.js standalone `_next_server.js`, intercepting the server Next.js creates internally to add WS/SSE support

Both read IM handlers from `globalThis` (populated by `instrumentation.ts` → `bootstrap.ts`). The custom server files must NOT import `src/im/*` directly.

### IM Server (Agent Messaging)

Hono app **embedded in the Next.js process** — no separate port. All IM APIs are served on port 3000 via `/api/im/*`. The route handler calls `app.fetch()` directly in-process. Disable with `IM_SERVER_ENABLED=false`.

**Dual Prisma Schema:**

- `prisma/schema.prisma` — `provider = "sqlite"`, default Prisma client, for local dev
- `prisma/schema.mysql.prisma` — `provider = "mysql"`, output to `prisma/generated/mysql/`, for test/prod
- `src/lib/prisma.ts` — Dynamic client selection: checks `DATABASE_URL` prefix (`mysql://` → MySQL client, else → SQLite client)

**Key IM directories:**

- `src/im/` — IM server code (included in Next.js TS compilation; tests excluded)
- `src/im/services/` — Business logic (messages, conversations, agents, credits, bindings)
- `src/im/agent-protocol/` — Agent card registry, heartbeat, discovery
- `src/im/tests/` — Custom test runners (`npx tsx src/im/tests/*.test.ts`)
- `src/im/sql/` — MySQL migration scripts
- `src/app/api/im/[...path]/route.ts` — Next.js proxy to IM server
- `src/instrumentation.ts` — Next.js startup hook that launches IM server in same process

### Routing (Next.js App Router)

All routes live under `src/app/`. Pages: `/` (landing), `/playground`, `/dashboard`, `/auth`, `/docs`, `/evolution`.

URL rewrite in `next.config.ts` maps `/api/v1/*` to `/api/*` for backwards compatibility.

### Key Directories

- `src/lib/` — Core service layer and utilities
- `src/lib/api.ts` — Centralized frontend API client
- `src/components/ui/` — Shadcn/ui components (new-york style)
- `src/contexts/` — React context providers (auth via `AppContext`, theme via `ThemeContext`)
- `src/types/` — Shared TypeScript type definitions

### Feature Flags

`src/lib/feature-flags.ts` — Environment variable flags (`FF_*_LOCAL=true`) control whether API routes use direct database access or proxy to an external backend. In self-host mode, all flags are `true` — the app is fully standalone.

### Authentication

Dual auth: JWT tokens (session-based) and API keys (`sk-prismer-*`). OAuth supported via GitHub and Google. Auth state managed in `AppContext`.

**Auth modes** (feature-flag controlled):
- `AUTH_DISABLED=true`: All auth bypassed — for private/local deployments only.
- `FF_AUTH_LOCAL=true` (self-host): Auth handled locally — JWT signed with `JWT_SECRET`.
- `FF_AUTH_LOCAL=false`: Auth proxied to external backend.

### Content Processing Pipeline (Load API)

The Load API (`/api/context/load`) is the main entry point:

```
POST /api/context/load { input: "..." }
  │
  ├─ Input detection (single_url / batch_urls / query)
  ├─ Cache check
  ├─ Fetch content → Exa API
  ├─ Compress → OpenAI LLM
  ├─ Background cache deposit
  └─ Record usage
```

### Official SDKs (`sdk/`)

```
sdk/
├── typescript/        @prismer/sdk — npm
├── python/            prismer — PyPI
├── golang/            github.com/prismer-io/prismer-sdk-go
├── rust/              prismer-sdk — crates.io
├── mcp/               @prismer/mcp-server — MCP Server for Claude Code/Cursor/Windsurf
├── openclaw-channel/  @prismer/openclaw-channel — OpenClaw channel plugin
├── scripts/           build-all.sh
└── README.md
```

**SDK commands:**

```bash
# TypeScript SDK
cd sdk/typescript && npm run build && npm test

# Python SDK
cd sdk/python && pip install -e ".[dev]" && pytest

# Go SDK
cd sdk/golang && go test ./...

# MCP Server
cd sdk/mcp && npm install && npm run build
```

### Documentation

- `docs/SELF-HOST.md` — Self-host deployment guide
- `docs/API.md` — External API reference
- `docs/openapi.yaml` — OpenAPI spec
- `docs/SDK.md` — SDK design and API surface

## Path Alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

## Deployment

### Self-Host (docker compose)

```bash
cp .env.example .env   # Configure JWT_SECRET + optional API keys
docker compose up -d   # Starts MySQL 8.0 + Next.js app
```

Default admin: configurable via `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD`. See `docs/SELF-HOST.md` for full configuration reference and `.env.example` for all variables.

### Docker Build

Multi-stage Node 20 Alpine, standalone Next.js output, port 3000. Both Prisma clients (SQLite + MySQL) are generated in the build stage.

## API Testing

```bash
export PRISMER_API_KEY="your-api-key-here"

curl -X POST http://localhost:3000/api/context/load \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "https://example.com"}'
```

## Testing

```bash
# IM Server tests (standalone mode)
npx tsx src/im/tests/comprehensive.test.ts    # Full IM API coverage
npx tsx src/im/tests/v030-integration.test.ts # v0.3.0 features
npx tsx src/im/tests/agent-lifecycle.test.ts  # Agent registration, discovery
npx tsx src/im/tests/webhook.test.ts          # Webhook dispatch, HMAC
```

**IM standalone setup:**

```bash
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
```

## Conventions

**Logging:** Prefix with module name in brackets:

```typescript
console.log('[ModuleName] Action: details');
console.error('[ModuleName] ❌ Error message');
```

**API Response Format:**

```json
{
  "success": true,
  "data": { ... },
  "error": { "code": "ERROR_CODE", "message": "..." },
  "requestId": "...",
  "processingTime": 123
}
```
