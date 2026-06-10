/**
 * Phase 1 smoke — verifies the integration harness can:
 *   1. reach the running cloud (port 3000) via /api/health + /api/im/health
 *   2. mint real users + workspace through bootstrapSuite()
 *   3. clean up after itself via cleanup()
 *
 * Pre-requisite: `npm run dev:stack && npm run dev` running, with
 * docker-compose MySQL 8 reachable on 3307. The harness does NOT start
 * anything itself — it only drives the live server.
 */

import { describe, test, expect } from 'vitest';
import { api, bootstrapSuite } from '../_helpers';

describe('harness — health', () => {
  test('GET /api/health returns 200', async () => {
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
  });

  test('GET /api/im/health returns 200 + ok:true', async () => {
    const r = await api<{ ok: boolean; service: string }>('GET', '/api/im/health');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.service).toBe('prismer-im-server');
  });
});

describe('harness — bootstrap', () => {
  test('bootstrapSuite creates owner + member + observer + outsider + workspace', async () => {
    const ctx = await bootstrapSuite('phase1-smoke');

    // Workspace id shape: cuid (≥ 20 alphanumeric chars). Prisma defaults to
    // cuid2-style ids (e.g. cmpomvq1e0001xzwro2ciwg6q), but we keep the
    // pattern loose to accept any url-safe id.
    expect(ctx.workspace.id).toMatch(/^[a-zA-Z0-9_-]{20,}$/);
    expect(ctx.workspace.ownerImUserId).toBe(ctx.owner.imUserId);

    // Actor invariants — every actor must have a token + distinct imUserId.
    expect(ctx.owner.token.length).toBeGreaterThan(20);
    expect(ctx.member.token.length).toBeGreaterThan(20);
    expect(ctx.observer.token.length).toBeGreaterThan(20);
    expect(ctx.outsider.token.length).toBeGreaterThan(20);

    const ids = new Set([ctx.owner.imUserId, ctx.member.imUserId, ctx.observer.imUserId, ctx.outsider.imUserId]);
    expect(ids.size).toBe(4);

    // Owner can read their own /users/me through the token.
    const me = await api<{ ok: boolean; data?: { id: string } }>('GET', '/users/me', { actor: ctx.owner });
    expect(me.status).toBe(200);
    expect(me.data.ok).toBe(true);
    expect(me.data.data?.id).toBe(ctx.owner.imUserId);

    await ctx.cleanup();
  }, 60_000);
});
