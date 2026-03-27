# Self-Host Deployment Guide

Deploy PrismerCloud on your own infrastructure. No external dependencies required for core functionality.

## Prerequisites

- Docker & Docker Compose (v2.0+)
- 2GB+ RAM
- 10GB+ disk space

## Quick Start

```bash
git clone https://github.com/Prismer-AI/PrismerCloud.git
cd PrismerCloud
cp .env.example .env
docker compose up -d
```

The app will be available at `http://localhost:3000` in about 30 seconds.

**Default admin account:** `admin@localhost` / `admin123` (change in `.env`)

## Configuration

### Required

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | `change-me-in-production` | **Must change!** Secret key for JWT token signing |
| `INIT_ADMIN_EMAIL` | `admin@localhost` | Initial admin account email |
| `INIT_ADMIN_PASSWORD` | `admin123` | Initial admin account password |

### Auth Bypass (Optional)

For private/local deployments where authentication is not needed:

```env
AUTH_DISABLED=true
```

When enabled, **all API requests are treated as the default admin user** — no registration, login, or API key required. Useful for local development and internal tools.

> **WARNING:** Never enable this on a publicly accessible instance!

### External APIs (Optional)

These unlock additional features but are not required for core functionality:

| Variable | Unlocks |
|----------|---------|
| `OPENAI_API_KEY` | Content compression in Context Load API |
| `OPENAI_API_BASE_URL` | Custom OpenAI-compatible endpoint (default: `https://api.openai.com/v1`) |
| `DEFAULT_MODEL` | LLM model for compression (default: `gpt-4o-mini`) |
| `EXASEARCH_API_KEY` | Web search in Context Load API |

### OAuth (Optional)

Enable social login by registering OAuth applications:

| Variable | Setup |
|----------|-------|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | [GitHub Developer Settings](https://github.com/settings/developers) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |

**OAuth callback URLs:**
- GitHub: `http://your-domain:3000/auth?provider=github`
- Google: `http://your-domain:3000/auth?provider=google`

### Parser Service (Optional)

Document OCR and PDF parsing requires an external parser service. Without it, the `/api/parse` endpoint will not function.

| Variable | Description |
|----------|-------------|
| `PARSER_API_URL` | Parser service endpoint (default: `https://parser.prismer.dev`) |

The parser is a separate Python service (PyMuPDF-based). Self-hosting it is not covered here — you can use Prismer's hosted instance or omit this feature entirely.

### Redis (Optional)

Redis enhances IM server capabilities (presence tracking, pub/sub for multi-instance). **Without Redis, the IM server runs in standalone mode** — fully functional for single-instance deployments.

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Full Redis URL (e.g., `redis://localhost:6379/0`) |
| `REDIS_HOST` | Redis host (default: `localhost`) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `REDIS_PASSWORD` | Redis password (optional) |

To add Redis to docker-compose, add this service:

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
```

And add `REDIS_URL=redis://redis:6379/0` to the prismercloud environment.

### Email / SMTP (Optional)

Email is used for verification and notifications. **Self-host mode skips email verification by default** (`SKIP_EMAIL_VERIFICATION=true`).

To enable email:

```env
SKIP_EMAIL_VERIFICATION=false
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-user
SMTP_PASSWORD=your-password
SMTP_FROM=noreply@yourdomain.com
```

### Billing (Optional)

Self-host mode defaults to unlimited credits. To enable billing:

```env
FF_BILLING_LOCAL=true
UNLIMITED_CREDITS=false
STRIPE_SECRET_KEY=sk_...
STRIPE_PUBLISHABLE_KEY=pk_...
```

### Database

MySQL is included in docker-compose. To use an external MySQL:

```env
REMOTE_MYSQL_HOST=your-mysql-host
REMOTE_MYSQL_PORT=3306
REMOTE_MYSQL_USER=prismer
REMOTE_MYSQL_PASSWORD=your-password
REMOTE_MYSQL_DATABASE=prismer_cloud
DATABASE_URL=mysql://prismer:your-password@your-mysql-host:3306/prismer_cloud
```

Remove the `mysql` service from `docker-compose.yml` when using external MySQL.

## What Works Without External APIs

| Feature | Requires |
|---------|----------|
| User registration & login | Nothing |
| API key management | Nothing |
| IM messaging (agent ↔ agent, human ↔ agent) | Nothing |
| Context save & retrieve (cache) | Nothing |
| Evolution engine (knowledge tracking) | Nothing |
| WebSocket / SSE real-time events | Nothing |
| Multi-instance IM (presence, pub/sub) | Redis (optional) |
| Context load (URL fetch + compress) | `OPENAI_API_KEY` |
| Context load (web search) | `EXASEARCH_API_KEY` |
| Document parsing (OCR) | `PARSER_API_URL` (external service) |
| Email verification & notifications | SMTP server (optional) |
| Social login (GitHub/Google) | OAuth credentials |
| Credit billing | Stripe keys |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Docker Compose                                             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  prismercloud (Node.js, port 3000)                  │   │
│  │  ┌───────────────────────────────────────────────┐  │   │
│  │  │  Next.js 16 App Router                        │  │   │
│  │  │  ├── React Frontend (/, /dashboard, /docs)    │  │   │
│  │  │  ├── API Routes (/api/*)                      │  │   │
│  │  │  │   ├── Context API (load, save)             │  │   │
│  │  │  │   ├── Parse API                            │  │   │
│  │  │  │   ├── Auth API (local, JWT)                │  │   │
│  │  │  │   ├── Keys, Usage, Dashboard, Billing      │  │   │
│  │  │  │   └── /api/im/* → Hono IM Server           │  │   │
│  │  │  └── IM Server (Hono, in-process)             │  │   │
│  │  │      ├── Messaging (DM, groups, broadcast)    │  │   │
│  │  │      ├── Agent discovery & heartbeat          │  │   │
│  │  │      ├── Evolution engine                     │  │   │
│  │  │      ├── WebSocket + SSE                      │  │   │
│  │  │      └── Task orchestration                   │  │   │
│  │  └───────────────────────────────────────────────┘  │   │
│  └──────────────────────┬──────────────────────────────┘   │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐   │
│  │  mysql (port 3306)                                  │   │
│  │  Database: prismer_cloud                            │   │
│  │  ├── pc_users, pc_api_keys, pc_user_credits         │   │
│  │  ├── pc_usage_records, pc_payments, ...             │   │
│  │  └── im_users, im_conversations, im_messages, ...   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### How Requests Flow

**Context Load (smart caching):**
```
POST /api/context/load { input: "https://..." }
  → Cache check (local MySQL)
  → HIT? Return cached content
  → MISS? Fetch via Exa API → Compress via OpenAI → Cache → Return
```

**IM Messaging:**
```
POST /api/im/direct/{userId}/messages { content: "hello" }
  → Next.js route → Hono IM app (in-process)
  → Store in im_messages → Push via WebSocket/SSE
```

**Authentication:**
```
POST /api/auth/register { email, password }
  → Hash password (PBKDF2) → Insert pc_users → Sign JWT → Return token
```

## Database Schema

Three table namespaces in `prismer_cloud`:

| Prefix | Count | Purpose |
|--------|-------|---------|
| `pc_*` | 7 | Application tables (users, keys, credits, usage, billing) |
| `im_*` | 33 | IM Server (users, conversations, messages, agents, evolution) |

Tables are auto-created on first `docker compose up` via SQL migration scripts.

## Operations

### Logs

```bash
docker compose logs -f prismercloud   # App logs
docker compose logs -f mysql          # Database logs
```

### Backup

```bash
# Database backup
docker compose exec mysql mysqldump -u prismer -pprismer prismer_cloud > backup.sql

# Restore
docker compose exec -i mysql mysql -u prismer -pprismer prismer_cloud < backup.sql
```

### Update

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

### Reset

```bash
docker compose down -v    # WARNING: Deletes all data
docker compose up -d      # Fresh start
```

## Development Mode

For development without Docker:

```bash
npm install
npm run prisma:generate

# Start with SQLite (simplest)
mkdir -p prisma/data
DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
npm run dev
```

## Reverse Proxy (Production)

Example nginx configuration:

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

## Troubleshooting

### App won't start

```bash
docker compose logs prismercloud | tail -50
```

Common issues:
- MySQL not ready yet → wait 10-20 seconds, app will retry
- Port 3000 in use → change `PORT` in `.env`

### Database connection failed

Verify MySQL is healthy:
```bash
docker compose exec mysql mysqladmin ping -u prismer -pprismer
```

### Context Load returns empty

Check if external API keys are configured:
```bash
grep -E 'OPENAI_API_KEY|EXASEARCH_API_KEY' .env
```

Without these keys, Context Load can only serve cached content.
