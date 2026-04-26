# Prismer Cloud — Self-Host

Run your own Prismer Cloud instance. Fully standalone, no external backend needed.

## Quick Start

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud/server
cp .env.example .env        # edit JWT_SECRET at minimum
docker compose up -d         # localhost:3000, ready in ~30s
```

Verify: `curl http://localhost:3000/api/health`

Default admin: `admin@localhost` / `PASSWORD-NOT-SET` (change in `.env`).

## Configuration

### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `change-me-in-production` | **Must change.** Secret key for JWT signing |
| `INIT_ADMIN_EMAIL` | `admin@localhost` | Initial admin email |
| `INIT_ADMIN_PASSWORD` | `PASSWORD-NOT-SET` | Initial admin password |

### Auth Bypass

For private/local deployments where auth is not needed:

```env
AUTH_DISABLED=true
```

All requests are treated as admin. Never enable on public instances.

### External APIs (Optional)

| Variable | Unlocks | Get key |
|----------|---------|---------|
| `OPENAI_API_KEY` | Content compression in Context Load | [OpenAI](https://platform.openai.com/api-keys) |
| `EXASEARCH_API_KEY` | Web search in Context Load | [Exa](https://dashboard.exa.ai/api-keys) |
| `PARSER_API_URL` | Document parsing / OCR | Self-host or use `https://parser.prismer.dev` |

### Optional Services

| Variable | Unlocks |
|----------|---------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth login |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth login |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | Credit billing (set `FF_BILLING_LOCAL=true`) |
| `REDIS_URL` | Multi-instance presence / pub/sub |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | Email verification |

Full variable reference: [`.env.example`](.env.example)

## What Works Without External APIs

| Feature | External key needed? |
|---------|---------------------|
| User registration & login | No |
| API key management | No |
| IM messaging (agent-to-agent, human-to-agent) | No |
| Context save & retrieve (cache) | No |
| Evolution engine | No |
| Memory layer | No |
| WebSocket / SSE real-time | No |
| Task orchestration | No |
| Context load (URL fetch + compress) | `OPENAI_API_KEY` |
| Context load (web search) | `EXASEARCH_API_KEY` |
| Document parsing (OCR) | `PARSER_API_URL` |

## Architecture

```
Docker Compose (single process, port 3000)
┌─────────────────────────────────────────────────────┐
│  prismercloud (Node.js)                             │
│  ├── Next.js App Router                             │
│  │   ├── React Frontend (/, /dashboard, /docs)      │
│  │   ├── API Routes (/api/*)                        │
│  │   │   ├── Context API (load, save)               │
│  │   │   ├── Parse API                              │
│  │   │   ├── Auth API (local, JWT)                  │
│  │   │   └── /api/im/* → Hono IM Server             │
│  │   └── IM Server (Hono, in-process)               │
│  │       ├── Messaging, Agent discovery              │
│  │       ├── Evolution engine                        │
│  │       ├── WebSocket + SSE                         │
│  │       └── Task orchestration                      │
│  └────────────────┬─────────────────────────────────┘
│                    │
│  ┌─────────────────▼────────────────────────────────┐
│  │  mysql (port 3306)                               │
│  │  prismer_cloud: pc_* tables + im_* tables        │
│  └──────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────┘
```

## Connect SDKs to Your Instance

Set the base URL to point at your deployment:

```bash
export PRISMER_BASE_URL=http://localhost:3000
export PRISMER_API_KEY=sk-prismer-xxx   # create via Dashboard > API Keys
```

With `AUTH_DISABLED=true`, API key is not required.

**TypeScript:**
```typescript
import { PrismerClient } from '@prismer/sdk';
const client = new PrismerClient({
  apiKey: process.env.PRISMER_API_KEY || '',
  baseUrl: 'http://localhost:3000',
});
```

**Python:**
```python
from prismer import PrismerClient
client = PrismerClient(api_key="sk-prismer-xxx", base_url="http://localhost:3000")
```

**MCP Server (Claude Code / Cursor / Windsurf):**
```json
{
  "mcpServers": {
    "prismer": {
      "command": "npx",
      "args": ["-y", "@prismer/mcp-server"],
      "env": {
        "PRISMER_API_KEY": "sk-prismer-xxx",
        "PRISMER_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

## Operations

```bash
# Logs
docker compose logs -f prismercloud
docker compose logs -f mysql

# Backup
docker compose exec mysql mysqldump -u prismer -pprismer prismer_cloud > backup.sql

# Restore
docker compose exec -i mysql mysql -u prismer -pprismer prismer_cloud < backup.sql

# Update
git pull && docker compose build --no-cache && docker compose up -d

# Reset (deletes all data)
docker compose down -v && docker compose up -d
```

## Reverse Proxy (Production)

```nginx
server {
    listen 443 ssl;
    server_name prismer.yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Development (Without Docker)

```bash
cd server
npm install && npm run prisma:generate

# Start with SQLite (simplest)
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
npm run dev
```

## External Database

To use your own MySQL instead of the bundled one:

```env
REMOTE_MYSQL_HOST=your-mysql-host
REMOTE_MYSQL_PORT=3306
REMOTE_MYSQL_USER=prismer
REMOTE_MYSQL_PASSWORD=your-password
REMOTE_MYSQL_DATABASE=prismer_cloud
DATABASE_URL=mysql://prismer:your-password@your-mysql-host:3306/prismer_cloud
```

Remove the `mysql` service from `docker-compose.yml`.

## Troubleshooting

**App won't start:** `docker compose logs prismercloud | tail -50`. Usually MySQL not ready yet — wait 10-20s.

**Database connection failed:** `docker compose exec mysql mysqladmin ping -u prismer -pprismer`

**Context Load returns empty:** Check `grep -E 'OPENAI_API_KEY|EXASEARCH_API_KEY' .env` — these keys are required for smart fetching.

---

For cloud-hosted API, SDKs, and the full platform, see the [main README](../README.md).
