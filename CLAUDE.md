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
npm run test:all:test    # Multi-env test script against cloud.prismer.dev
npm run test:all:prod    # Multi-env test script against prismer.cloud
```

No automated test framework (no vitest/jest). IM server has custom test runners in `src/im/tests/`.

## Architecture

### Three-Layer System

```
User/Agent Request
       │
       ▼
┌─────────────────────────────────────────────┐
│  Next.js API Routes (BFF Layer)             │
│  - Orchestration (load: search+compress+    │
│    cache check+deposit)                     │
│  - Direct external API calls (Exa, OpenAI)  │
│  - Backend proxy (auth, keys, context CRUD) │
│  - Local DB (feature-flag controlled)       │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌──────────────┐  ┌──────────────────┐
│ Backend API  │  │ MySQL (direct)   │
│ (Go service) │  │ pc_* tables      │
│ prismer.app  │  │ feature-flagged  │
│ /api/v1      │  │                  │
└──────┬───────┘  └────────┬─────────┘
       │                   │
       ▼                   ▼
┌─────────────────────────────────────┐
│           MySQL Database            │
│  context_cache, users, api_keys    │
│  pc_usage_records, pc_payments...  │
└─────────────────────────────────────┘
```

The Next.js layer is **not** a thin proxy — it contains significant orchestration logic (the Load API), direct external API integrations, and (via feature flags) direct database access that can bypass the backend entirely.

### Custom Server (WebSocket + SSE)

The app uses a custom HTTP server that shares port 3000 for Next.js, WebSocket, and SSE:

- **Dev:** `server.ts` — creates `http.createServer`, attaches `WebSocketServer` on `/ws`, SSE handler on `/sse`, then passes everything else to Next.js
- **Prod:** `server.prod.js` — monkey-patches `http.createServer` before loading Next.js standalone `_next_server.js`, intercepting the server Next.js creates internally to add WS/SSE support

Both read IM handlers from `globalThis` (populated by `instrumentation.ts` → `bootstrap.ts`). The custom server files must NOT import `src/im/*` directly.

### IM Server (Agent Messaging)

Hono app **embedded in the Next.js process** — no separate port. All IM APIs are served on port 3000 via `/api/im/*`. The route handler calls `app.fetch()` directly in-process. Disable with `IM_SERVER_ENABLED=false`.

```
Docker Container (single process, single port: node server.js)
┌─────────────────────────────────────────────────────┐
│  Next.js (port 3000)                                │
│  ├── instrumentation.ts → import('./im/bootstrap')  │
│  │   └── createApp() → Hono app (no port binding)   │
│  │       └── stored in globalThis.__imApp            │
│  │                                                   │
│  └── /api/im/[...path] route handler                │
│      └── getIMApp().fetch(request) — in-process     │
└──────────────┬──────────────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
  SQLite (dev)    MySQL (prod/test)
  prisma/data/    im_* tables
  dev.db          in prismer_cloud
```

**Dual Prisma Schema:**

- `prisma/schema.prisma` — `provider = "sqlite"`, default Prisma client, for local dev
- `prisma/schema.mysql.prisma` — `provider = "mysql"`, output to `prisma/generated/mysql/`, for test/prod
- `src/lib/prisma.ts` — Dynamic client selection: checks `DATABASE_URL` prefix (`mysql://` → MySQL client, else → SQLite client)

**Database selection in `src/im/start.ts`:**

- If `DATABASE_URL` is set → use it directly
- Else if `NODE_ENV !== 'production'` → SQLite at `prisma/data/dev.db`
- Else → build MySQL URL from `REMOTE_MYSQL_*` env vars (loaded via Nacos)

**Key IM directories:**

- `src/im/` — IM server code (included in Next.js TS compilation; tests excluded)
- `src/im/services/` — Business logic (messages, conversations, agents, credits, bindings)
- `src/im/services/credit.service.ts` — CreditService abstraction (LocalCreditService for SQLite, CloudCreditService for MySQL bridging to `pc_user_credits`)
- `src/im/agent-protocol/` — Agent card registry, heartbeat, discovery
- `src/im/tests/` — Custom test runners (`npx tsx src/im/tests/*.test.ts`)
- `src/im/sql/` — MySQL migration scripts (001-004)
- `src/im/DESIGN.md` — v0.3.0 technical design (Task Marketplace + Escrow)
- `src/app/api/im/[...path]/route.ts` — Next.js proxy to IM server
- `src/instrumentation.ts` — Next.js startup hook that launches IM server in same process

**IM table namespace:** `im_*` prefix (`im_users`, `im_conversations`, `im_messages`, `im_agents`, `im_read_cursors`, `im_group_members`, `im_social_bindings`, `im_bridge_messages`, `im_credits`, `im_credit_transactions`)

### API Route Implementation Map

Each API route falls into one of these categories:

**Orchestration (multi-step, combines sources):**
| Route | What it does |
|-------|-------------|
| `/api/context/load` | Input detection → cache check (backend withdraw) → Exa fetch → OpenAI compress → backend deposit → usage recording. Main entry point. |
| `/api/parse` | Parser service call + usage recording. Supports sync/async modes. |

**Direct external API (no backend involved):**
| Route | External service |
|-------|-----------------|
| `/api/search` | Exa `searchAndContents()` |
| `/api/content` | Exa `getContents()` with livecrawl fallback |
| `/api/compress` | OpenAI LLM (streaming and non-streaming) |

**Backend proxy (forwards to Go backend at `/api/v1/...`):**
| Route | Backend endpoint |
|-------|-----------------|
| `/api/auth/login` | `/auth/login` |
| `/api/auth/register` | `/auth/register` |
| `/api/auth/github/callback` | `/auth/cloud/github/callback` (v7.3+) |
| `/api/auth/google/callback` | `/auth/cloud/google/callback` (v7.3+) |
| `/api/keys/*` | `/cloud/keys` (CRUD) |
| `/api/context/save` | `/cloud/context/deposit` |
| `/api/context/deposit` | `/cloud/context/deposit` (DEPRECATED, sunset 2026-04-01) |
| `/api/context/withdraw` | `/cloud/context/withdraw` (DEPRECATED, sunset 2026-04-01) |
| `/api/config/oauth` | Local (returns OAuth client IDs from env) |

**Feature-flag switchable (local DB or backend proxy):**
| Route | Flag | Local DB tables |
|-------|------|----------------|
| `/api/usage/record` | `FF_USAGE_RECORD_LOCAL` | `pc_usage_records`, `pc_credits` |
| `/api/activities` | `FF_ACTIVITIES_LOCAL` | `pc_usage_records` |
| `/api/dashboard/stats` | `FF_DASHBOARD_STATS_LOCAL` | `pc_usage_records`, `pc_credits` |
| `/api/billing/topup` | `FF_BILLING_LOCAL` | `pc_payments`, `pc_payment_methods` + Stripe |
| `/api/billing/payment-methods` | `FF_BILLING_LOCAL` | `pc_payment_methods` + Stripe |
| `/api/billing/invoices` | `FF_BILLING_LOCAL` | `pc_payments` |

**IM Server (in-process via Hono `app.fetch()`):**
| Route | IM endpoint | Notes |
|-------|-------------|-------|
| `/api/im/*` | `/api/*` | In-process call to Hono app (GET/POST/PATCH/DELETE/PUT) |
| | | API Key → JWT conversion, usage billing on write ops |

**Evolution (public, no auth, via IM):**
| Route | Notes |
|-------|-------|
| `GET /api/im/evolution/map` | Full map visualization data (30s cache) |
| `GET /api/im/evolution/stories` | Recent evolution events for L1 narrative (10s cache) |
| `GET /api/im/evolution/metrics` | North-star A/B metrics comparison |
| `GET /api/im/evolution/public/stats` | Global evolution statistics |
| `GET /api/im/evolution/public/hot` | Hot genes ranking |
| `GET /api/im/evolution/public/feed` | Global event feed |

**Admin (JWT required, admin whitelist):**
| Route | Notes |
|-------|-------|
| `GET /api/admin/analytics` | Platform analytics (9 sections + Evolution A/B experiment) |
| `PATCH /api/im/admin/users/:id/trust-tier` | Update user trust tier (0-4) |
| `GET /api/im/admin/users/:id/trust` | Get user trust info + violations |

**Security (per-conversation encryption + key exchange):**
| Route | Notes |
|-------|-------|
| `GET /api/im/conversations/:id/security` | Get signing policy + encryption mode |
| `PATCH /api/im/conversations/:id/security` | Set encryption mode (none/available/required) |
| `POST /api/im/conversations/:id/keys` | Upload ECDH public key |
| `GET /api/im/conversations/:id/keys` | Get all member public keys |
| `DELETE /api/im/conversations/:id/keys/:userId` | Revoke a key |

**Mock (not yet backed by real data):**
| Route | Note |
|-------|------|
| `/api/notifications` | In-memory mock data |

### Routing (Next.js App Router)

All routes live under `src/app/`. Pages: `/` (landing), `/playground`, `/dashboard`, `/auth`, `/docs`, `/evolution`.

URL rewrite in `next.config.ts` maps `/api/v1/*` to `/api/*` for backwards compatibility.

### Key Directories

- `src/lib/` — Core service layer and utilities
- `src/lib/db-usage.ts` — Local DB operations for `pc_usage_records` (create, query, aggregate)
- `src/lib/db-billing.ts` — Local DB operations for payments, payment methods, subscriptions
- `src/lib/context-api.ts` — Backend Context API adapter (v7.2/v7.3 version compat)
- `src/lib/api.ts` — Centralized frontend API client (~1400 lines)
- `src/components/ui/` — Shadcn/ui components (new-york style)
- `src/contexts/` — React context providers (auth via `AppContext`, theme via `ThemeContext`)
- `src/types/` — Shared TypeScript type definitions

### Configuration Resolution

Two modes depending on deployment:

**Self-host mode** (`NACOS_DISABLED=true`): All config via environment variables directly. No external config service needed.

**Cloud mode** (default): Runtime configuration loads from **Nacos configuration center** via HTTP API (not the npm package, which is incompatible with Nacos 2.x). Priority: **Environment Variables > Nacos > Defaults**. The `ensureNacosConfig()` call in API routes triggers lazy initialization.

- `APP_ENV` determines the Nacos namespace (`prod`/`test`/`dev`)
- All environments use dataId `PrismerCloud`
- Nacos config is parsed as YAML or .env format and injected into `process.env`

### Backend API Integration

`src/lib/backend-api.ts` resolves the backend URL. Priority: `BACKEND_API_BASE` > `BACKGROUND_BASE_URL` + `/api/v1` > `https://prismer.app/api/v1`.

`src/lib/context-api.ts` adapts between backend v7.2 (`raw_link` params) and v7.3 (`input`/`content_uri` params) via automatic version detection. The detected version is cached for the process lifetime.

The backend handles: user auth, context storage (`context_cache` table), API key management. Auth is always verified by the backend — Next.js passes the Authorization header through.

### Feature Flags (Frontend-First Development)

`src/lib/feature-flags.ts` — Environment variable flags (`FF_*_LOCAL=true`) control whether API routes use direct MySQL or proxy to the backend. Flags use getters to read env vars dynamically (important because Nacos loads async).

When a flag is `true`, the Next.js route directly queries `pc_*` tables via `src/lib/db.ts`. When `false`, it proxies to the equivalent backend endpoint. This pattern exists because the backend doesn't yet implement all these endpoints — the local DB path is the "frontend-first" implementation.

| Flag                       | Local path                                        | Backend proxy path           |
| -------------------------- | ------------------------------------------------- | ---------------------------- |
| `FF_AUTH_LOCAL`            | Local JWT + `pc_users`/`pc_api_keys`              | Backend `/auth/*`            |
| `FF_USAGE_RECORD_LOCAL`    | Write to `pc_usage_records` + deduct `pc_credits` | POST `/cloud/usage/record`   |
| `FF_ACTIVITIES_LOCAL`      | Query `pc_usage_records`                          | GET `/cloud/activities`      |
| `FF_DASHBOARD_STATS_LOCAL` | Aggregate `pc_usage_records` + `pc_credits`       | GET `/cloud/dashboard/stats` |
| `FF_USER_CREDITS_LOCAL`    | Query `pc_credits`                                | GET `/cloud/credits/balance` |
| `FF_API_KEYS_LOCAL`        | Local `pc_api_keys` CRUD                          | Backend `/cloud/keys`        |
| `FF_CONTEXT_CACHE_LOCAL`   | Local `pc_context_cache`                          | Backend `/cloud/context/*`   |
| `FF_BILLING_LOCAL`         | Stripe SDK + `pc_payments`/`pc_payment_methods`   | POST `/payment/topup/create` |
| `FF_NOTIFICATIONS_LOCAL`   | Local notification storage                        | Backend notifications        |

In self-host mode, all flags are `true` — the app is fully standalone with no backend dependency. `UNLIMITED_CREDITS=true` bypasses credit checks.

### Database

`src/lib/db.ts` — MySQL2 connection pool (singleton, max 10 connections). Must call `ensureNacosConfig()` before first use so `REMOTE_MYSQL_*` env vars are set.

Three table namespaces coexist in the same MySQL database (`prismer_info`):

- **Backend tables** (no prefix): `users`, `api_keys`, `context_cache` — managed by the Go backend
- **Frontend-first tables** (`pc_` prefix): `pc_usage_records`, `pc_credits`, `pc_payments`, `pc_payment_methods`, `pc_subscriptions` — managed by Next.js local DB code
- **IM tables** (`im_` prefix, 33 models): Core (`im_users`, `im_conversations`, `im_messages`, `im_agents`), Security (`im_identity_keys`, `im_key_audit_logs`, `im_conversation_security`), Evolution (`im_genes`, `im_gene_signals`, `im_evolution_edges`, `im_evolution_capsules`, `im_evolution_metrics`, `im_unmatched_signals`, `im_evolution_achievements`, `im_evolution_acl`), Hypergraph (`im_atoms`, `im_hyperedges`, `im_hyperedge_atoms`, `im_causal_links`), Tasks (`im_tasks`, `im_task_logs`), Memory (`im_memory_files`, `im_compaction_summaries`), Skills (`im_skills`), and more — managed by IM server via Prisma. Evolution tables have `scope` field for data domain isolation (default `"global"`).

Key helpers: `query<T>()`, `execute()`, `queryOne<T>()`, `withTransaction()`.

**IM dev database:** SQLite at `prisma/data/dev.db`, managed by Prisma with `prisma db push`. Includes additional `im_credits` / `im_credit_transactions` tables (dev-only, not in MySQL — prod uses `pc_user_credits` via CloudCreditService).

### Authentication

Dual auth: JWT tokens (session-based, stored in `prismer_auth` localStorage) and API keys (`sk-prismer-*`, stored in `prismer_active_api_key`). OAuth supported via GitHub and Google. Auth state managed in `AppContext`.

**Two auth paths** (feature-flag controlled):
- `FF_AUTH_LOCAL=true` (self-host): Auth handled locally — JWT signed with `JWT_SECRET`, users stored in `pc_users` table, API keys in `pc_api_keys`
- `FF_AUTH_LOCAL=false` (cloud): Auth proxied to Go backend at `prismer.app` — Next.js passes Authorization header through

### Content Processing Pipeline (Load API)

The Load API (`/api/context/load`) is the main entry point and the most complex route:

```
POST /api/context/load { input: "..." }
  │
  ├─ Input detection (single_url / batch_urls / query)
  │
  ├─ Cache check → backend /cloud/context/withdraw (or /withdraw/batch)
  │     ├─ HIT → return cached HQCC
  │     └─ MISS → continue
  │
  ├─ Fetch content → Exa API (getContents or searchAndContents)
  │
  ├─ Compress → OpenAI LLM (concurrent, maxConcurrent=3)
  │
  ├─ Background deposit → backend /cloud/context/deposit (fire-and-forget)
  │
  ├─ Rank results (ranking presets: cache_first, relevance_first, balanced)
  │
  └─ Record usage (background, feature-flag controlled)
```

### External Services

- **Exa Search API** — Web search and content extraction
- **OpenAI** — LLM-based content compression (model configurable via Nacos)
- **Stripe** — Payments, credit top-up, payment methods (used in local billing path)
- **Parser service** (`parser.prismer.dev`) — OCR with Fast/HiRes modes

### Public API Endpoints

Public-facing APIs (documented at `/docs` page and `docs/API.md`):

**Context:**

- `POST /api/context/load` — Smart context loader (URL, batch, or query)
- `POST /api/context/save` — Store content in context cache

**Parse:**

- `POST /api/parse` — OCR and document parsing (PDF, images)

**IM (via `/api/im/*` proxy):**

- `POST /api/im/register` — Self-register user/agent
- `POST /api/im/agents/register` — Declare agent capabilities
- `POST /api/im/workspace/init` — One-call workspace setup
- `GET /api/im/discover` — Discover available agents
- `POST /api/im/direct/{userId}/messages` — Send direct message
- `POST /api/im/messages/{conversationId}` — Send to conversation
- `GET /api/im/conversations` — List conversations
- `WS /ws?token={token}` — Real-time WebSocket events
- Full lifecycle documented on `/docs` page (13 phases, 25 endpoints)

### Official SDKs (`sdk/`)

Four official SDKs plus integrations live in `sdk/` at project root (also open-sourced separately). This is the source-of-truth copy — changes are made here, then synced to the open-source repo.

```
sdk/
├── typescript/        @prismer/sdk (v1.7.2) — npm
├── python/            prismer (v1.7.2) — PyPI
├── golang/            github.com/prismer-io/prismer-sdk-go — Go modules
├── rust/              prismer-sdk (v1.7.2) — crates.io
├── mcp/               @prismer/mcp-server (v1.7.2) — MCP Server for Claude Code/Cursor/Windsurf
├── openclaw-channel/  @prismer/openclaw-channel (v1.7.2) — OpenClaw channel plugin
├── scripts/           build-all.sh
└── README.md
```

**SDK features:**

- Context API, Parse API, IM API client
- WebSocket + SSE real-time support
- CLI tool (`prismer` command)
- Webhook handler (`PrismerWebhook`) with HMAC-SHA256 verification + framework adapters
- OpenClaw bridge (webhook → OpenClaw `/hooks/agent` → auto-reply)

**MCP Server (`sdk/mcp/`):**

- 23 tools: `context_load`, `context_save`, `parse`, `discover`, `send_message`, `edit_message`, `delete_message`, `evolve_analyze`, `evolve_record`, `evolve_create_gene`, `evolve_distill`, `evolve_browse`, `evolve_import`, `evolve_report`, `evolve_achievements`, `evolve_sync`, `evolve_export_skill`, `memory_write`, `memory_read`, `recall`, `create_task`, `skill_search`, `skill_install`
- Stdio transport, works with Claude Code, Cursor, Windsurf
- Auth via `PRISMER_API_KEY` env var, base URL via `PRISMER_BASE_URL` (default: `https://prismer.cloud`)
- Build: `cd sdk/mcp && npm install && npm run build`
- Test: `npx @modelcontextprotocol/inspector node sdk/mcp/dist/index.js`
- Usage: `npx -y @prismer/mcp-server`

**OpenClaw Channel Plugin (`sdk/openclaw-channel/`):**

- Registers `prismer` as an OpenClaw messaging channel
- Gateway: agent auto-registration + WebSocket for inbound messages
- Outbound: send DMs via Prismer IM API
- Directory: agent discovery via `/api/im/agents`
- Agent tools: `prismer_load` (web knowledge), `prismer_parse` (document OCR)
- Install: `openclaw plugins install @prismer/openclaw-channel`

**SDK commands:**

```bash
# TypeScript SDK
cd sdk/typescript && npm run build     # tsup build (CJS + ESM + DTS)
cd sdk/typescript && npm test          # vitest
cd sdk/typescript && npm run lint      # eslint

# Python SDK
cd sdk/python && pip install -e ".[dev]"   # editable install
cd sdk/python && pytest                     # test suite
cd sdk/python && ruff check .               # lint

# Go SDK
cd sdk/golang && go test ./...         # test suite
cd sdk/golang && go build ./cmd/prismer  # CLI binary

# MCP Server
cd sdk/mcp && npm install && npm run build  # tsup build (ESM + shebang)

# OpenClaw Channel Plugin (no build step — TypeScript consumed directly by OpenClaw)
```

**SDK and server coordinated features:** File transfer (v0.4.0) requires synchronized SDK + server implementation — SDK handles chunking, progress, resume; server handles presign, validation, quota. See `docs/TODO.md` for full design.

### Documentation

Consolidated engineering docs live in `docs/` at project root:

- `docs/SELF-HOST.md` — Self-host deployment guide (prerequisites, config, troubleshooting)
- `docs/API.md` — External API reference (Context, Parse, IM, WebSocket/SSE)
- `docs/openapi.yaml` — OpenAPI spec (served at runtime by `/api/docs/openapi`)
- `docs/ROADMAP.md` — Project roadmap with version plan and phase status
- `docs/ARCHITECTURE.md` — System architecture overview
- `docs/BACKEND-REQUIREMENTS.md` — Backend API spec (DB schema, access control, content URI)
- `docs/TODO.md` — Project TODO with next-phase implementation design
- `docs/PRD.md` — Product requirements document
- `docs/SDK.md` — SDK design and API surface
- `docs/im/` — IM subsystem design docs
- `docs/evolution/` — Evolution engine design docs

## Path Alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

## Deployment

### Self-Host (docker compose)

```bash
cp .env.example .env   # Configure JWT_SECRET + optional API keys
docker compose up -d   # Starts MySQL 8.0 + Next.js app
```

`docker-compose.yml` provisions:
- **mysql** service — MySQL 8.0 with health check, auto-runs SQL migrations from `scripts/sql/` (pc_* tables) and `src/im/sql/` (im_* tables) via `/docker-entrypoint-initdb.d/`
- **prismercloud** service — Next.js app with all `FF_*_LOCAL=true` flags enabled, `NACOS_DISABLED=true`, local auth (`FF_AUTH_LOCAL=true`, `SKIP_EMAIL_VERIFICATION=true`)

Default admin: `admin@localhost` / `admin123` (configurable via `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD`). `UNLIMITED_CREDITS=true` in self-host mode.

See `docs/SELF-HOST.md` for full configuration reference and `.env.example` for all variables.

### Docker Build

Multi-stage Node 20 Alpine, standalone Next.js output, port 3000. Both Prisma clients (SQLite + MySQL) are generated in the build stage. The custom production server (`server.prod.js`) replaces the default Next.js `server.js` to add WebSocket/SSE support. IM server starts automatically via `instrumentation.ts` in the same process.

### Environment Modes

- **Self-host:** `NACOS_DISABLED=true` + all `FF_*_LOCAL=true` — fully standalone, no external backend needed
- **Cloud:** Nacos config center + backend proxy — `APP_ENV` determines namespace (`prod`/`test`/`dev`)
- IM server's `start.ts` uses `NODE_ENV !== 'production'` to decide SQLite (dev) vs MySQL (prod)

## API Testing

**Quick API test (against local instance):**

```bash
# Set your API key (create one via the dashboard after registering)
export PRISMER_API_KEY="your-api-key-here"

curl -X POST http://localhost:3000/api/context/load \
  -H "Authorization: Bearer $PRISMER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "https://example.com"}'
```

## Testing

```bash
# IM Server tests (standalone mode)
npx tsx src/im/tests/comprehensive.test.ts    # 109 tests — full IM API coverage
npx tsx src/im/tests/v030-integration.test.ts # 42 tests — v0.3.0 features
npx tsx src/im/tests/agent-lifecycle.test.ts  # 35 tests — agent registration, discovery
npx tsx src/im/tests/webhook.test.ts          # 15 tests — webhook dispatch, HMAC
```

**IM standalone setup (for local IM tests):**

```bash
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
```

## Working Principles

**Documentation-First Workflow (mandatory):**

1. **Before starting work:** Read relevant docs under `docs/` and `CLAUDE.md` to understand current architecture, API specs, and conventions. Check `docs/ROADMAP.md` for status and `docs/TODO.md` for planned work.
2. **During work:** If you discover discrepancies between docs and code, note them.
3. **After finishing work:** Update all affected documentation:
   - `docs/API.md` — If any API endpoint behavior changed
   - `docs/ARCHITECTURE.md` — If architecture or integration patterns changed
   - `docs/ROADMAP.md` — If feature status or test counts changed
   - `docs/TODO.md` — If backlog items were completed or new ones identified
   - `docs/BACKEND-REQUIREMENTS.md` — If backend API findings or adaptations changed
   - `CLAUDE.md` — If project structure, commands, or conventions changed
4. **Update dates:** Always update the "Last updated" / "Date" fields in modified docs.

**Test before theorize:** Always run actual tests to verify assumptions. Do not theorize about code behavior without testing.

**Check specs systematically:** When investigating an issue, cross-reference docs, code, and actual API behavior. Don't assume the spec is correct — test it.

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

## Current Version: v1.7.2 — Agent Intelligence Platform ✅

**All deliverables complete (待部署):**

- Server: 4 pillars (148/148 tests) — Orchestration, E2E Signing, Memory, Evolution
- Evolution Engine v0.3.0: SignalTag 层级标签 + Thompson Sampling + Diagnostic Gene + Bimodality Index
- Evolution Engine v0.3.1: 超图层(im_atoms/hyperedges/causal_links) + 北极星指标(im_evolution_metrics) + mode A/B 开关
- Frontend: Evolution Map 模块化重构 — 4 级宇宙缩放 + Ghost 渲染 + Gene 形状编码 + Story 嵌入 + Louvain 社区检测
- SDK: TS/Python/Go/Rust v1.7.2 (Tasks, Memory, Identity, Evolution, Security) + MCP Server 23 tools
- Admin: Evolution Experiment A/B 对比区块 (标准 vs 超图模式指标)
- Bugfix: Skills API slug/ID, GeneCard click, TiltCard CSS-only, Skillhub sync removed, register metadata 合并
- Pending: deploy to test/prod, docs/API.md update, npm/PyPI/Go publish

**v1.7.3 规划:** Agent Park + OpenClaw tools (discover/send/schedule/memory) + Event subscriptions
