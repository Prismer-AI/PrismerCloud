# Prismer Cloud Backend API Requirements

**Version:** 1.6.0
**Date:** 2026-02-16
**Status:** Internal Document (for Go backend team)

> This document describes the **ideal backend API** that the Go backend service should implement.
> The Next.js frontend has already implemented most of these features via "frontend-first" strategy
> (direct DB access with feature flags). The backend team can implement at their own pace.

---

## Architecture Overview

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
└──────────────┘  └──────────────────┘
```

### Responsibility Split

| Component | Responsibilities |
|-----------|------------------|
| **Next.js** | Exa Search, URL Content Fetching, LLM Compression, Cache Check/Deposit, Token Calculation, UI Rendering |
| **Backend** | User Auth, Context Storage, Usage Recording, Credits Management, Stats Aggregation |

### Base URLs (Internal Backend Service)

| Environment | URL |
|-------------|-----|
| Production | `https://prismer.app/api/v1` |
| Test | `https://prismer.dev/api/v1` |
| Development | `http://localhost:8080/api/v1` |

---

## Production Test Findings (2026-02-05)

### Spec vs Reality

| Feature | Spec (v7.5.0) | Production Reality | Status |
|---------|---------------|-------------------|--------|
| withdraw `input` param | URL or `prismer://` | Both `input` and `raw_link` work | ✅ Fixed |
| withdraw format case | `"hqcc"` (lowercase) | Both uppercase/lowercase work | ✅ Working |
| withdraw `format:'both'` | Should return both | Returns `found:true` but contents NULL | ⚠️ Not Supported |
| withdraw/batch | `inputs: [...]` | `inputs` works, `raw_links` deprecated | ✅ Fixed (v7.3) |
| deposit visibility | Optional (defaults `private`) | Defaults correctly | ✅ Working |
| `content_uri` lookup | Should work with `prismer://` | Returns `found:false` for valid URIs | ⚠️ Not Working |
| `prismer://` generation | Backend generates on deposit | Works, returns valid URIs | ✅ Working |
| `raw_link` lookup | Lookup by original URL | Works correctly | ✅ Working |

### Remaining Issues

**Issue #1: `format:'both'` Not Supported** (Medium — Workaround Available)
- Calling withdraw with `format:'both'` returns `found:true` but both `hqcc_content` and `intr_content` are NULL.
- **Workaround:** Frontend converts `format:'both'` to `format:'hqcc'` before calling withdraw.

**Issue #2: `content_uri` Lookup Not Working** (High Priority)
- Withdraw with `input: "prismer://public/u_0/..."` returns `found:false` even for valid URIs just returned from deposit.
- Lookup by `raw_link` works correctly; only `prismer://` URI lookup fails.

**Issue #3: Backend Usage/Billing APIs Not Available**
- `GET /api/v1/cloud/usage` → 404, `GET /api/v1/cloud/billing` → 404.
- Not blocking — handled by Next.js frontend-first implementation.

### Frontend Adaptations

**`context-api.ts` (adapter layer):**
1. Single withdraw uses `raw_link` param (both `input` and `raw_link` work)
2. Format normalization: always lowercase `'hqcc'` or `'intr'`, never `'both'`
3. Batch withdraw: uses parallel single withdraws (legacy workaround)
4. Deposit: always sends `visibility` (defaults `'public'` for load, `'private'` for save)
5. Empty content check: only deposits if `compressData.hqcc` exists

---

## Database Schema

### Entity Relationship

```
users (PK: id)
  │
  ├── 1:N → usage_records (FK: user_id)
  │           └── 1:1 ref → credit_transactions (reference_id)
  │
  ├── 1:N → credit_transactions (FK: user_id)
  │
  ├── 1:N → context_cache (FK: user_id)
  │
  └── 1:N → api_keys (FK: user_id)
```

### Table: users

| Column | Type | Notes |
|--------|------|-------|
| id | VARCHAR(36) | PK |
| email | VARCHAR(255) | |
| password_hash | VARCHAR(255) | |
| credits_balance | DECIMAL(10,4) | Current balance |
| plan | VARCHAR(32) | free/pro/enterprise |
| created_at | TIMESTAMP | |

### Table: context_data (actual, probed 2026-02-16)

> **Note:** Spec called this `context_cache` but actual table is `context_data`.

| Column | Spec (v7.4) | Actual (test env) | Notes |
|--------|-------------|-------------------|-------|
| id | VARCHAR(36) | bigint unsigned AUTO_INCREMENT | PK |
| user_id | VARCHAR(36) FK | bigint unsigned (all `0`) | Backend never binds real user |
| content_uri | VARCHAR(512) | varchar(255) UNIQUE | `prismer://` URI |
| raw_link | TEXT | varchar(512) | Original URL (nullable) |
| hqcc_content | MEDIUMTEXT | text | Compressed markdown |
| intr_content | MEDIUMTEXT | longtext | Original cleaned text |
| visibility | VARCHAR(16) | varchar(20) NOT NULL | public/private/unlisted |
| meta | JSON | json | System + user fields |
| expires_at | TIMESTAMP | — | **Not present** in actual table |
| created_at | TIMESTAMP | timestamp | |
| updated_at | TIMESTAMP | timestamp | |
| s3_link | — | varchar(512) | Extra: not in spec |
| embedding | — | json | Extra: not in spec |
| deleted_at | — | timestamp | Extra: soft delete |

**Test env stats (2026-02-16):** 165 rows, 136 public / 28 private / 1 unlisted, 1.47 MB hqcc + 2.03 MB intr.

**Indexes:** `UNIQUE(content_uri)`, `INDEX(user_id)`, `INDEX(raw_link)`, `INDEX(deleted_at)`

### Table: usage_records

| Column | Type | Notes |
|--------|------|-------|
| id | VARCHAR(36) | PK |
| user_id | VARCHAR(36) | FK → users.id |
| task_id | VARCHAR(64) | UNIQUE, frontend-generated |
| task_type | VARCHAR(32) | `agent_ingest` |
| input_type | VARCHAR(16) | `url` / `query` |
| input_value | TEXT | The URL or query string |
| exa_searches | INT | Number of search calls |
| urls_processed | INT | Total URLs processed |
| urls_cached | INT | Cache hits |
| urls_compressed | INT | Newly compressed |
| tokens_input | INT | LLM input tokens |
| tokens_output | INT | LLM output tokens |
| processing_time_ms | INT | Total time in ms |
| search_credits | DECIMAL(10,4) | Credits for search |
| compression_credits | DECIMAL(10,4) | Credits for compression |
| total_credits | DECIMAL(10,4) | Total deducted |
| sources_json | JSON | Array of source details |
| status | VARCHAR(16) | `completed` / `failed` |
| created_at | TIMESTAMP | |

### Table: credit_transactions

| Column | Type | Notes |
|--------|------|-------|
| id | VARCHAR(36) | PK |
| user_id | VARCHAR(36) | FK → users.id |
| type | VARCHAR(16) | `usage` / `purchase` / `refund` / `bonus` |
| amount | DECIMAL(10,4) | Positive=add, Negative=deduct |
| balance_after | DECIMAL(10,4) | Balance after transaction |
| description | VARCHAR(255) | Human-readable |
| reference_type | VARCHAR(32) | `usage_record` / `payment` |
| reference_id | VARCHAR(64) | → usage_records.id or payment_id |
| created_at | TIMESTAMP | |

### Table: api_keys

| Column | Type | Notes |
|--------|------|-------|
| id | VARCHAR(36) | PK |
| user_id | VARCHAR(36) | FK → users.id |
| key_hash | VARCHAR(64) | SHA-256 of full key |
| key_prefix | VARCHAR(8) | First 8 chars for display |
| name | VARCHAR(100) | User-defined name |
| permissions | JSON | `['read','write','admin']` |
| last_used_at | TIMESTAMP | |
| expires_at | TIMESTAMP | Nullable |
| created_at | TIMESTAMP | |

---

## Content URI System & Access Control

### Design Principles (v7.3 — Breaking Change)

> **Major change:** Removed "Internet URL forced public" rule. Now uses unified `prismer://` URI.

| Content Type | content_uri | raw_link | visibility | Notes |
|--------------|-------------|----------|------------|-------|
| Internet URL (public) | `prismer://public/u_xxx/c_yyy` | URL | `public` | Other users can query |
| Internet URL (private) | `prismer://private/u_xxx/c_yyy` | URL | `private` | Only owner can access |
| User content | `prismer://*/u_xxx/c_yyy` | NULL | User-specified | Notes, OCR, Agent output |

### Content URI Format

```
prismer://{visibility}/{user_short_id}/{content_id}

user_short_id: u_{first 8 chars of user.id}
content_id:    c_{UUID v4 without dashes}  (32 chars, non-enumerable)
```

### Access Control Matrix

| Visibility | Owner | API Key (Same User) | API Key (Other) | Anonymous |
|------------|-------|---------------------|-----------------|-----------|
| public | ✅ | ✅ | ✅ | ✅ |
| unlisted | ✅ | ✅ | ✅ * | ✅ * |
| private | ✅ | ✅ | ❌ | ❌ |

\* unlisted: accessible only if you have the content_uri

### Withdraw Query Logic

Priority order when querying by URL (not `prismer://`):
1. **Logged-in user?** → Find user's own version first (`WHERE raw_link=? AND user_id=?`)
2. **Public version** → Find any public version (`WHERE raw_link=? AND visibility='public'`)
3. **Not found** → Return `{ found: false }`

When querying by `prismer://` URI: exact match on `content_uri` + access control check.

---

## Meta Field Design

### Structure

The `meta` column is a schemaless JSON object with conventions:

**System fields** (prefixed `_`, auto-filled by backend — users cannot set these):
- `_user_id`, `_user_email`, `_api_key_id` — From API key / JWT
- `_created_at`, `_updated_at` — Timestamps
- `_content_hash` — SHA-256 of hqcc_content
- `_size_bytes` — Content size
- `_version` — For future versioning

**User fields** (any structure, provided by caller):
- `source_type` — `web_page` / `pdf` / `audio` / `video` / `text`
- `title`, `author`, `published_date`, `language`, `tags`
- `strategy`, `model`, `tokens_input`, `tokens_output`

**Agent integration fields** (recommended):
- `source.agent` — Agent name
- `source.session_id`, `source.project_id`, `source.message_id`

**Chunking fields** (v7.5):
- `_chunked`, `_chunk_strategy`, `_chunk_count`, `_chunks[]` — On parent record
- `_parent`, `_chunk_index`, `_chunk_id`, `keywords` — On chunk records

---

## API Specifications

### Implementation Status

| Endpoint | Backend Status | Frontend-First Status | Notes |
|----------|---------------|----------------------|-------|
| POST `/cloud/context/withdraw` | ⚠️ Buggy | ✅ `FF_CONTEXT_CACHE_LOCAL` | Local Prisma cache (v1.6.0), backend as fallback |
| POST `/cloud/context/withdraw/batch` | ❌ Broken | ✅ `FF_CONTEXT_CACHE_LOCAL` | Single SQL via Prisma `findMany` |
| POST `/cloud/context/deposit` | ⚠️ user_id=0 | ✅ `FF_CONTEXT_CACHE_LOCAL` | Local primary + backend dual-write |
| POST `/cloud/context/deposit/batch` | ❌ Broken | ✅ `FF_CONTEXT_CACHE_LOCAL` | Parallel `deposit()` calls |
| GET `/cloud/keys` | ✅ Live | ✅ `FF_API_KEYS_LOCAL` | — |
| POST `/cloud/keys` | ✅ Live | ✅ `FF_API_KEYS_LOCAL` | — |
| POST `/usage/record` | 🔴 Not implemented | ✅ `FF_USAGE_RECORD_LOCAL` | `pc_usage_records` + `pc_credits` |
| GET `/activities` | 🔴 Not implemented | ✅ `FF_ACTIVITIES_LOCAL` | Query `pc_usage_records` |
| GET `/dashboard/stats` | 🔴 Not implemented | ✅ `FF_DASHBOARD_STATS_LOCAL` | Aggregate `pc_usage_records` |
| GET `/credits/balance` | 🔴 Not implemented | ✅ `FF_USER_CREDITS_LOCAL` | Query `pc_credits` |

> **v1.6.0 Note:** With all FF flags enabled, the only hard backend dependencies are `/auth/*` (login/register/OAuth) and `/cloud/billing/payment-methods/confirm-alipay`.

### Context Cache — Now Local (v1.6.0)

The context cache has been **decoupled from the backend** via `FF_CONTEXT_CACHE_LOCAL=true`:

| Feature | Before (backend) | After (local Prisma) |
|---------|-----------------|---------------------|
| Storage | `context_data` table (user_id always 0) | `im_context_cache` (real userId from apiGuard) |
| Batch withdraw | Broken (all `found:false`) | Single SQL `WHERE IN` (~26ms for 10 URLs) |
| Visibility | Not enforced | Strict enforcement (public/private/unlisted) |
| User isolation | None | Owner-based, no cross-user data leaks |
| Performance | ~200ms per request (HTTP proxy) | ~5ms cache hit (local Prisma) |

Backend context endpoints are still called as **fallback** (warm migration) and **dual-write target** (background), but are no longer the primary path.

### POST /usage/record (P0)

Record a completed task, deduct credits, create transaction log.

**Request:**
```json
{
  "task_id": "task_20260107_abc123",
  "task_type": "agent_ingest",
  "input": { "type": "query", "value": "latest humanoid robots 2024" },
  "metrics": {
    "exa_searches": 1,
    "urls_processed": 15,
    "urls_cached": 8,
    "urls_compressed": 7,
    "tokens_input": 45000,
    "tokens_output": 7500,
    "processing_time_ms": 12500
  },
  "cost": {
    "search_credits": 1.0,
    "compression_credits": 5.25,
    "total_credits": 6.25
  },
  "sources": [
    { "url": "https://figure.ai/helix", "cached": true, "tokens": 0 },
    { "url": "https://arxiv.org/2401.xxx", "cached": false, "tokens": 6500 }
  ]
}
```

**Backend Logic:** Within a transaction: check balance → insert usage_record → deduct credits → insert credit_transaction.

**Response:**
```json
{
  "success": true,
  "data": {
    "record_id": "rec_xyz789",
    "credits_deducted": 6.25,
    "credits_remaining": 43.75
  }
}
```

### GET /activities (P0)

Get recent tasks for dashboard "Recent Tasks" section.

**Request:** `GET /api/v1/activities?page=1&limit=20`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "rec_abc123",
      "url": "latest humanoid robots 2024",
      "strategy": "Auto-Detect",
      "status": "Completed",
      "cost": "6.250",
      "time": "2 mins ago"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 156, "has_more": true }
}
```

### GET /dashboard/stats (P0)

Aggregated statistics for dashboard.

**Request:** `GET /api/v1/dashboard/stats?period=7d`

**Response:**
```json
{
  "success": true,
  "data": {
    "chartData": [
      { "name": "Mon", "requests": 32000 },
      { "name": "Tue", "requests": 45000 }
    ],
    "monthlyRequests": 248392,
    "cacheHitRate": 89.4,
    "creditsRemaining": 42.80
  }
}
```

---

## Save API Upgrade (Phase 3)

Current: basic URL + HQCC save via backend deposit.
Needed: visibility parameter, content_uri return, user content (no URL), TTL support.

### Save Modes

**Mode 1: Save Internet URL** — Auto-fetch + compress + store
```json
{ "input": "https://example.com/article", "inputType": "url" }
```

**Mode 2: Save User Content** — Direct store
```json
{
  "content": "# My Notes\n\n...",
  "visibility": "private",
  "ttl": 86400,
  "meta": { "title": "Research Notes", "source_type": "text_note" }
}
```

**Mode 3: Agent Memory** — Recommended pattern
```json
{
  "content": "User prefers Tailwind CSS...",
  "visibility": "private",
  "ttl": 3600,
  "meta": {
    "source_type": "memory",
    "source": { "agent": "opencode-build", "session_id": "sess_xyz789" }
  }
}
```

### TTL Guidelines

| Scenario | Recommended TTL |
|----------|-----------------|
| Session memory | 1-24 hours |
| Project knowledge | No TTL or 30+ days |
| Temporary results | 1 hour |
| User notes | No TTL (permanent) |

---

## Database Migration: prismer_info → prismer_cloud

See [IM-PRODUCTION-MIGRATION.md](../src/app/docs/IM-PRODUCTION-MIGRATION.md) for the full migration plan.

### Summary

- **Goal:** Data isolation — Next.js/IM tables move entirely to `prismer_cloud` DB, separate from Go backend's `prismer_info`.
- **16 tables** belong to `prismer_cloud`: 7 `pc_*` + 9 `im_*`
- **Database** (`prismer_cloud`) tables are created via `docker/init-db.sql`.
- **Production RDS** needs: create `prismer_cloud` DB + user → create tables → migrate `pc_*` data → update Nacos config.
- **Feature flags** (`FF_API_KEYS_LOCAL=true` etc.) eliminate all cross-DB dependencies.
- **Rollback:** Change Nacos `REMOTE_MYSQL_DATABASE` back to `prismer_info`.

### Post-Migration Architecture

```
Go Backend (prismer.app)
  └── prismer_info (exclusive)
      └── users, api_keys, context_data, ... (~75 tables)

Next.js + IM Server (prismer.cloud)
  └── prismer_cloud (exclusive)
      ├── pc_* (7 tables: credits, usage, payments, api_keys, subscriptions)
      └── im_* (9 tables: users, agents, conversations, messages, etc.)

Interaction: Next.js → HTTP Proxy → Go Backend API → prismer_info
(No direct cross-DB SQL queries)
```

---

## Frontend-First Strategy

The Next.js frontend has already implemented all P0 features locally using feature flags:

| Feature Flag | Local Implementation | Backend Proxy Path |
|-------------|---------------------|-------------------|
| `FF_USAGE_RECORD_LOCAL` | `pc_usage_records` + `pc_credits` | POST `/cloud/usage/record` |
| `FF_ACTIVITIES_LOCAL` | Query `pc_usage_records` | GET `/cloud/activities` |
| `FF_DASHBOARD_STATS_LOCAL` | Aggregate `pc_usage_records` + `pc_credits` | GET `/cloud/dashboard/stats` |
| `FF_USER_CREDITS_LOCAL` | Query `pc_credits` | GET `/cloud/credits/balance` |
| `FF_BILLING_LOCAL` | Stripe SDK + `pc_payments` | POST `/payment/topup/create` |
| `FF_API_KEYS_LOCAL` | `pc_api_keys` (SHA-256 hash) | GET/POST `/cloud/keys` |
| `FF_CONTEXT_CACHE_LOCAL` | `im_context_cache` (Prisma) | POST `/cloud/context/withdraw*`, `/deposit*` |

**Backend handoff process:**
1. Backend team implements endpoint based on this spec
2. Frontend team verifies compatibility
3. Feature flag is set to `false` → traffic switches to backend
4. Local DB code remains as fallback

---

## SQL Schema Definitions

```sql
-- Context Cache (v7.4 — unified prismer:// URI + TTL)
CREATE TABLE context_cache (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  content_uri VARCHAR(512) NOT NULL,
  raw_link TEXT,
  hqcc_content MEDIUMTEXT NOT NULL,
  intr_content MEDIUMTEXT,
  visibility VARCHAR(16) NOT NULL DEFAULT 'private',
  meta JSON,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_content_uri (content_uri),
  INDEX idx_user_id (user_id),
  INDEX idx_raw_link_visibility (raw_link(255), visibility),
  INDEX idx_raw_link_user (raw_link(255), user_id),
  INDEX idx_visibility (visibility),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_expires_at (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Usage Records
CREATE TABLE usage_records (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  task_id VARCHAR(64) NOT NULL,
  task_type VARCHAR(32) NOT NULL DEFAULT 'agent_ingest',
  input_type VARCHAR(16) NOT NULL,
  input_value TEXT NOT NULL,
  exa_searches INT DEFAULT 0,
  urls_processed INT DEFAULT 0,
  urls_cached INT DEFAULT 0,
  urls_compressed INT DEFAULT 0,
  tokens_input INT DEFAULT 0,
  tokens_output INT DEFAULT 0,
  processing_time_ms INT DEFAULT 0,
  search_credits DECIMAL(10,4) DEFAULT 0,
  compression_credits DECIMAL(10,4) DEFAULT 0,
  total_credits DECIMAL(10,4) DEFAULT 0,
  sources_json JSON,
  status VARCHAR(16) DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_task_id (task_id),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Credit Transactions
CREATE TABLE credit_transactions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  type VARCHAR(16) NOT NULL,
  amount DECIMAL(10,4) NOT NULL,
  balance_after DECIMAL(10,4) NOT NULL,
  description VARCHAR(255),
  reference_type VARCHAR(32),
  reference_id VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_type (type),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

**Last updated:** 2026-02-16
