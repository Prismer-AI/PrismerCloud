# Self-Host Standalone Design

**Date:** 2026-04-02
**Branch:** `feat/self-host-standalone`
**Goal:** `docker compose up -d` runs fully standalone — zero calls to Nacos, prismer.app backend, or any external auth gateway.

## Context

PrismerCloud server (`server/src/`) has dual-mode support via feature flags: cloud mode (proxy to Go backend) and local mode (direct DB). Self-host sets all `FF_*_LOCAL=true` + `NACOS_DISABLED=true`. Most paths already work locally, but 6 routes still make unconditional backend calls that fail in standalone mode.

## Changes

### 1. OAuth callback guard (CRITICAL)

**File:** `server/src/lib/auth-api.ts`

**Problem:** `githubCallback()` and `googleCallback()` always call `fetch(backendBase/auth/cloud/github/callback)`. In self-host mode `backendBase` is empty, causing network errors.

**Fix:** When `FF_AUTH_LOCAL=true`, return a clear error response: "OAuth not available in self-host mode. Configure GitHub/Google OAuth keys and use local auth instead." The local login/register path (`FF_AUTH_LOCAL` guards at lines 86 and 116) already works correctly.

### 2. API Keys DELETE/PATCH guard (CRITICAL)

**File:** `server/src/app/api/keys/[id]/route.ts`

**Problem:** DELETE and PATCH handlers proxy to backend without checking `FF_API_KEYS_LOCAL`. The GET and POST handlers in `keys/route.ts` correctly check the flag.

**Fix:** Add `FEATURE_FLAGS.API_KEYS_LOCAL` check at the top of DELETE and PATCH handlers. When true, perform the operation on local `pc_api_keys` table. When false, proxy to backend (existing behavior).

### 3. Billing endpoints guard (CRITICAL)

**Files:**
- `server/src/app/api/billing/topup/route.ts`
- `server/src/app/api/billing/invoices/route.ts`
- `server/src/app/api/billing/payment-methods/confirm-alipay/route.ts`

**Problem:** These routes call backend unconditionally even though other billing routes (`payment-methods/route.ts`, `payment-methods/[id]/route.ts`) correctly check `FF_BILLING_LOCAL`.

**Fix:** Add `FEATURE_FLAGS.BILLING_LOCAL` guard to each. When `FF_BILLING_LOCAL=true`, use local Stripe integration (already implemented in sibling routes). When false, proxy to backend. For `confirm-alipay`, guard with the flag and return 503 "Alipay not available" when billing is local-only without Stripe.

### 4. IM config JWT secret lazy getter (MODERATE)

**File:** `server/src/im/config.ts`

**Problem:** `jwt.secret` is assigned statically at module load time. If Nacos injects `JWT_SECRET` after module initialization, IM server uses the fallback `dev-secret-change-me` while api-guard uses the real secret — token mismatch.

**Fix:** Convert `secret` and `expiresIn` to getters:
```typescript
jwt: {
  get secret() {
    return process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || 'dev-secret-change-me';
  },
  get expiresIn() {
    return process.env.JWT_EXPIRES_IN || '7d';
  },
},
```

### 5. deductCredits UNLIMITED_CREDITS check (MODERATE)

**File:** `server/src/lib/db-credits.ts`

**Problem:** `api-guard.ts` skips the balance pre-check when `UNLIMITED_CREDITS=true`, but the actual `deductCredits()` function still checks balance and rejects if insufficient. Race condition: pre-check passes, deduction fails.

**Fix:** Add early return at the top of `deductCredits()`:
```typescript
if (FEATURE_FLAGS.UNLIMITED_CREDITS) {
  return; // Skip deduction entirely
}
```

### 6. Context API backend fallback removal (MODERATE)

**File:** `server/src/lib/context-api.ts`

**Problem:** `withdrawLocal()` falls back to `withdrawBackend()` on local cache miss when `authHeader` is provided (lines 108-127). In self-host mode this backend call fails silently.

**Fix:** When `FF_CONTEXT_CACHE_LOCAL=true`, skip the backend fallback entirely. Return `found: false` immediately on local cache miss. The deposit path similarly should only write locally.

## Not Changed

- `nacos-config.ts` — already short-circuits with `NACOS_DISABLED=true`
- `parser-client.ts` — already throws clear error when `PARSER_API_URL` not set
- `im/services/file.service.ts` — already has perfect local fallback
- Prisma schema — no changes needed
- No new feature flag additions

## Verification

After all changes:
1. `docker compose up -d` with all `FF_*_LOCAL=true` — no backend connection errors in logs
2. `GET /api/health` — all local services show as configured
3. Register user → create API key → delete API key → all local
4. Context load (cache miss without EXASEARCH key) → clear 503 message
5. IM register agent → send message → Evolution analyze → all work
6. Billing top-up with Stripe key → works locally; without Stripe → clear error
7. OAuth login attempt → clear "not available in self-host" message
