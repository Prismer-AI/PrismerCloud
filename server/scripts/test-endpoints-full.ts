/**
 * 全量端点测试 — 覆盖所有 public + auth endpoints
 *
 * npx tsx scripts/test-endpoints-full.ts
 */

const BASE = process.env.TEST_BASE || 'http://localhost:3000';

let pass = 0, fail = 0, skip = 0;

async function test(method: string, path: string, opts?: {
  auth?: string;
  body?: unknown;
  expectStatus?: number;
}) {
  const expectStatus = opts?.expectStatus ?? 201;
  try {
    const headers: Record<string, string> = {};
    if (opts?.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
    if (opts?.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const ok = r.status === expectStatus;
    const label = ok ? '✅' : '❌';
    console.log(`  ${label} ${method} ${path} → ${r.status}${ok ? '' : ` (expected ${expectStatus})`}`);
    if (ok) pass++; else fail++;
    return r;
  } catch (e) {
    console.log(`  ❌ ${method} ${path} → NETWORK ERROR`);
    fail++;
    return null;
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  Prismer Cloud — 全量端点测试                  ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE}\n`);

  // ─── 1. Public (no auth) ───────────────────────
  console.log('── 1. Public Endpoints (no auth) ──');
  await test('GET', '/api/version');
  await test('GET', '/api/config/oauth');
  await test('GET', '/api/im/health');

  // ─── 2. Evolution Public ────────────────────────
  console.log('\n── 2. Evolution Public ──');
  await test('GET', '/api/im/evolution/map');
  await test('GET', '/api/im/evolution/stories?limit=3&since=1440');
  await test('GET', '/api/im/evolution/metrics');
  await test('GET', '/api/im/evolution/public/stats');
  await test('GET', '/api/im/evolution/public/hot?limit=5');
  await test('GET', '/api/im/evolution/public/genes?limit=5');
  await test('GET', '/api/im/evolution/public/feed?limit=5');
  await test('GET', '/api/im/evolution/public/unmatched?limit=5');

  // ─── 3. Skills Public ──────────────────────────
  console.log('\n── 3. Skills Public ──');
  await test('GET', '/api/im/skills/search?limit=3');
  await test('GET', '/api/im/skills/stats');
  await test('GET', '/api/im/skills/categories');

  // ─── 4. IM Register + Auth Flow ─────────────────
  console.log('\n── 4. IM Register + Evolution Auth Flow ──');
  const regRes = await test('POST', '/api/im/register', {
    body: { username: `fulltest_${Date.now()}`, displayName: 'Full Test', type: 'agent', metadata: { evolution_mode: 'standard' } },
  });
  let token = '';
  if (regRes) {
    try {
      const j = await regRes.json();
      token = j.data?.token || '';
      console.log(`  → Token acquired: ${token ? 'yes' : 'no'}`);
    } catch {}
  }

  if (!token) {
    console.log('  ⏭ Skipping auth endpoints (no token)');
    skip += 20;
  } else {
    // ─── 5. Evolution Auth Endpoints ───────────────
    console.log('\n── 5. Evolution (auth required) ──');
    await test('POST', '/api/im/evolution/analyze', { auth: token, body: { signals: ['error:timeout'] } });

    // Create gene
    const geneRes = await test('POST', '/api/im/evolution/genes', {
      auth: token,
      body: { category: 'repair', title: 'Test Gene', signals_match: [{ type: 'error:test' }], strategy: ['Fix'] },
    });
    let geneId = '';
    if (geneRes) {
      try { const j = await geneRes.json(); geneId = j.data?.id || ''; } catch {}
    }

    if (geneId) {
      await test('POST', '/api/im/evolution/record', {
        auth: token,
        body: { gene_id: geneId, outcome: 'success', signals: ['error:test'], score: 0.9, summary: 'test' },
      });
      await test('GET', '/api/im/evolution/genes', { auth: token });
      await test('GET', `/api/im/evolution/genes/${geneId}`, { auth: token });
      await test('GET', '/api/im/evolution/edges', { auth: token });
      await test('GET', '/api/im/evolution/capsules?limit=5', { auth: token });
      await test('GET', '/api/im/evolution/report', { auth: token });
      await test('GET', '/api/im/evolution/personality/' + (await regRes?.json().catch(() => ({})) as Record<string, unknown>)?.data?.imUserId, { auth: token });
      await test('POST', '/api/im/evolution/distill?dry_run=true', { auth: token, body: {} });
    }

    // ─── 6. IM Core ──────────────────────────────
    console.log('\n── 6. IM Core (auth required) ──');
    await test('GET', '/api/im/conversations', { auth: token });
    await test('GET', '/api/im/discover', { auth: token });

    // ─── 7. Memory ──────────────────────────────
    console.log('\n── 7. Memory (auth required) ──');
    await test('GET', '/api/im/memory/files', { auth: token });

    // ─── 8. Recall ──────────────────────────────
    console.log('\n── 8. Recall (auth required) ──');
    await test('POST', '/api/im/recall', { auth: token, body: { query: 'timeout' } });
  }

  // ─── 9. Auth rejection ─────────────────────────
  console.log('\n── 9. Auth rejection (should 401) ──');
  await test('POST', '/api/im/evolution/analyze', { expectStatus: 401, body: { signals: ['test'] } });
  await test('POST', '/api/im/evolution/record', { expectStatus: 401, body: {} });

  // ─── Summary ───────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Total: ${pass + fail + skip}  ✅ ${pass}  ❌ ${fail}  ⏭ ${skip}`);
  console.log('═══════════════════════════════════════════════\n');
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
