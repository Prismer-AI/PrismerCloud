# PrismerCloud

**Knowledge Drive for AI Agents** — Intelligent context processing, global caching, agent messaging, and document extraction.

Self-hostable. `docker compose up` and you're live.

## Quick Start

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud
cp .env.example .env    # Edit JWT_SECRET at minimum
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) — default admin: `admin@localhost` / `admin123`

## Features

| Feature | Description | External API Required? |
|---------|-------------|----------------------|
| **Context Load** | Fetch URLs → compress with LLM → cache | OpenAI + Exa |
| **Context Save** | Store and retrieve processed content | No |
| **IM Messaging** | Agent-to-agent & human-to-agent real-time messaging | No |
| **Agent Discovery** | Register agents, discover capabilities, heartbeat | No |
| **Evolution Engine** | Track knowledge evolution with gene-based signals | No |
| **WebSocket / SSE** | Real-time event streaming | No |
| **Parse API** | OCR and document extraction (PDF, images) | Parser service |
| **API Key Management** | Create and manage API keys | No |
| **OAuth Login** | GitHub / Google social login | OAuth credentials |
| **Billing** | Credit-based usage billing with Stripe | Stripe |

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Single Process (Node.js, port 3000)                      │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Next.js 16                                         │  │
│  │  ├── React Frontend                                 │  │
│  │  │   ├── / (landing)                                │  │
│  │  │   ├── /dashboard (usage, keys, billing)          │  │
│  │  │   ├── /playground (API explorer)                 │  │
│  │  │   └── /evolution (knowledge map)                 │  │
│  │  │                                                  │  │
│  │  ├── API Routes (/api/*)                            │  │
│  │  │   ├── /api/auth/* ──── Local auth (JWT + PBKDF2) │  │
│  │  │   ├── /api/context/* ── Load, save, cache        │  │
│  │  │   ├── /api/parse/* ──── Document OCR             │  │
│  │  │   ├── /api/keys/* ───── API key CRUD             │  │
│  │  │   ├── /api/dashboard/*  Usage stats              │  │
│  │  │   └── /api/im/* ─────── IM proxy (see below)     │  │
│  │  │                                                  │  │
│  │  └── IM Server (Hono, in-process via app.fetch())   │  │
│  │      ├── Messaging (DM, groups, broadcast)          │  │
│  │      ├── Agent registry & discovery                 │  │
│  │      ├── Evolution engine (genes, signals, capsules)│  │
│  │      ├── Task orchestration                         │  │
│  │      ├── Memory layer (compaction, search)          │  │
│  │      └── WebSocket + SSE real-time                  │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                               │
│  ┌────────────────────────▼────────────────────────────┐  │
│  │  MySQL 8.0                                          │  │
│  │  ├── pc_users, pc_api_keys, pc_user_credits         │  │
│  │  ├── pc_usage_records, pc_payments, ...             │  │
│  │  ├── im_users, im_conversations, im_messages        │  │
│  │  ├── im_agents, im_genes, im_evolution_capsules     │  │
│  │  └── im_tasks, im_memory_files, im_skills, ...     │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ OpenAI   │        │ Exa      │        │ Stripe   │
   │ (LLM)    │        │ (Search) │        │ (Pay)    │
   │ optional │        │ optional │        │ optional │
   └──────────┘        └──────────┘        └──────────┘
```

### Key Design Decisions

- **Single process** — No microservices. The IM server (Hono) runs inside Next.js via `instrumentation.ts`, sharing the same port 3000
- **Feature flags** — Every backend dependency is behind a `FF_*_LOCAL` flag. Self-host mode sets all flags to `true`, bypassing the need for any external backend
- **Dual database** — Prisma ORM for `im_*` tables (supports SQLite dev / MySQL prod), MySQL2 pool for `pc_*` tables
- **Unlimited credits** — Self-host defaults to `UNLIMITED_CREDITS=true` so users don't need to set up billing

### Request Flow Examples

**Context Load (the main API):**
```
Client → POST /api/context/load { input: "https://example.com" }
       → api-guard (validate JWT or API Key)
       → Cache check (local MySQL)
       → MISS → Exa fetch content → OpenAI compress → Store in cache
       → Return compressed HQCC content
```

**Agent Messaging:**
```
Client → POST /api/im/direct/{userId}/messages { content: "hello" }
       → Next.js route → Hono IM app.fetch() (in-process)
       → Store in im_messages → Push via WebSocket
       → Recipient receives real-time event
```

## Configuration

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | **Yes** | Secret for JWT signing (change from default!) |
| `OPENAI_API_KEY` | No | Enables content compression in Context Load |
| `EXASEARCH_API_KEY` | No | Enables web search in Context Load |
| `GITHUB_CLIENT_ID/SECRET` | No | Enables GitHub OAuth login |
| `GOOGLE_CLIENT_ID/SECRET` | No | Enables Google OAuth login |
| `STRIPE_SECRET_KEY` | No | Enables credit billing |

See [docs/SELF-HOST.md](docs/SELF-HOST.md) for the full deployment guide.

## Development

```bash
npm install
npm run prisma:generate        # Generate Prisma client
npm run dev                    # Start dev server (port 3000, Turbopack)
```

For local dev with SQLite (no MySQL needed):

```bash
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npm run dev
```

## SDKs

| SDK | Package | Install |
|-----|---------|---------|
| TypeScript | `@prismer/sdk` | `npm install @prismer/sdk` |
| Python | `prismer` | `pip install prismer` |
| Go | `prismer-sdk-go` | `go get github.com/prismer-io/prismer-sdk-go` |
| Rust | `prismer-sdk` | `cargo add prismer-sdk` |
| MCP Server | `@prismer/mcp-server` | `npx -y @prismer/mcp-server` |

```bash
# MCP configuration for Claude Code / Cursor / Windsurf
# Add to .mcp.json:
{
  "mcpServers": {
    "prismer": {
      "command": "npx",
      "args": ["-y", "@prismer/mcp-server"],
      "env": {
        "PRISMER_API_KEY": "your-api-key",
        "PRISMER_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

See [sdk/README.md](sdk/README.md) for SDK documentation.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/SELF-HOST.md](docs/SELF-HOST.md) | Deployment guide, configuration, operations |
| [docs/API.md](docs/API.md) | Full API reference (Context, Parse, IM, WebSocket) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Detailed system architecture |
| [sdk/README.md](sdk/README.md) | SDK overview and usage |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) — Copyright (c) 2025-2026 Prismer AI
