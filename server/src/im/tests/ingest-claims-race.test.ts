/**
 * Prismer IM — Ingest-claim coordination tests (Wave-54 B7 / C5)
 *
 * Verifies the L6-T2 acceptance from docs/54release/26-asset-multi-tier-sync.md:
 * two daemons racing on the same asset/version end with exactly one winner.
 *
 * Also exercises the same-owner refresh, complete-then-re-acquire, and
 * heartbeat-from-wrong-device paths so the full claim lifecycle has
 * end-to-end coverage against a real server (HTTP + Prisma + transaction).
 *
 * Usage:
 *   IM_BASE_URL=http://localhost:3200 npx tsx src/im/tests/ingest-claims-race.test.ts
 *
 * The IM server must be running. Optionally set INGEST_CLAIM_HEARTBEAT_TTL_MS
 * to a small value (e.g. 200) on the server before launch to exercise the
 * stale-takeover branch — without that, "stale takeover" is skipped.
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);
const STALE_TTL_MS = parseInt(process.env.INGEST_CLAIM_HEARTBEAT_TTL_MS || '0', 10);

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function api<T = unknown>(
  method: string,
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; data: { ok: boolean; data?: T; error?: { code?: string; message?: string } | string; meta?: Record<string, unknown> } }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/im${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { ok: boolean; data?: T; error?: { code?: string; message?: string } | string; meta?: Record<string, unknown> };
  return { status: res.status, data };
}

async function registerUser(username: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${BASE}/api/im/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: username, role: 'human', password: 'test123' }),
  });
  const data = (await res.json()) as { ok: boolean; data?: { user: { id: string }; token: string } };
  if (!data.ok || !data.data) throw new Error(`registerUser failed: ${JSON.stringify(data)}`);
  return { id: data.data.user.id, token: data.data.token };
}

async function createWorkspace(token: string, name: string): Promise<string> {
  const res = await api<{ id: string }>('POST', '/workspaces', { name, isDefault: false }, token);
  if (!res.data.ok || !res.data.data) throw new Error(`createWorkspace failed: ${JSON.stringify(res.data)}`);
  return res.data.data.id;
}

async function uploadAsset(token: string, workspaceId: string, contents: string): Promise<{ id: string; ingestVersion: number }> {
  const form = new FormData();
  form.append('workspaceId', workspaceId);
  form.append('kind', 'file');
  form.append('file', new Blob([contents], { type: 'text/plain' }), `claim-test-${TS}.txt`);
  const res = await fetch(`${BASE}/api/im/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = (await res.json()) as { ok: boolean; data?: { id: string; ingestVersion: number } };
  if (!json.ok || !json.data) throw new Error(`uploadAsset failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return { id: json.data.id, ingestVersion: json.data.ingestVersion };
}

interface ClaimEnvelope {
  id?: string;
  workspaceId?: string;
  assetId?: string;
  ingestVersion?: number;
  status?: string;
  claimantDeviceId?: string;
}

async function acquire(token: string, assetId: string, ingestVersion: number, deviceId: string) {
  return api<ClaimEnvelope>('POST', '/ingest/claims', { assetId, ingestVersion, deviceId }, token);
}

async function heartbeat(token: string, claimId: string, deviceId: string) {
  return api<ClaimEnvelope>('POST', `/ingest/claims/${claimId}/heartbeat`, { deviceId }, token);
}

async function complete(token: string, claimId: string, deviceId: string) {
  return api<ClaimEnvelope>('POST', `/ingest/claims/${claimId}/complete`, { deviceId }, token);
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   Wave-54 B7 / C5 — Ingest-claim coordination     ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`\nServer: ${BASE}\nStale TTL: ${STALE_TTL_MS || '(default 30000)'}`);

  // Health
  const health = await fetch(`${BASE}/api/im/health`);
  if (!health.ok) throw new Error(`IM server unreachable at ${BASE}: HTTP ${health.status}`);

  // Bootstrap: one user, one workspace, one asset.
  const owner = await registerUser(`owner-${TS}`);
  const workspaceId = await createWorkspace(owner.token, `claim-ws-${TS}`);
  const asset = await uploadAsset(owner.token, workspaceId, `claim test ${TS}`);
  console.log(`  ⤷ owner=${owner.id} ws=${workspaceId} asset=${asset.id} v=${asset.ingestVersion}`);

  console.log('\n🔹 L6-T2 — concurrent acquire race');
  await test('two simultaneous acquires for the same (asset, version) — exactly one 201', async () => {
    const [a, b] = await Promise.all([
      acquire(owner.token, asset.id, asset.ingestVersion, 'dev-race-A'),
      acquire(owner.token, asset.id, asset.ingestVersion, 'dev-race-B'),
    ]);
    const statuses = [a.status, b.status].sort();
    // Winning POST is 201 (created). Loser is either 409 claimed_active (it
    // saw the winner's row) or 409 claim_race (P2002 fallback). Both 201 OR
    // both 409 → bug.
    assert(
      statuses.includes(201),
      `expected at least one 201, got ${JSON.stringify(statuses)}; ` +
        `bodies: ${JSON.stringify([a.data, b.data])}`,
    );
    assert(
      statuses.filter((s) => s === 201).length === 1,
      `expected exactly one 201, got ${statuses.filter((s) => s === 201).length}; ` +
        `bodies: ${JSON.stringify([a.data, b.data])}`,
    );
    const loser = a.status === 201 ? b : a;
    const loserCode = typeof loser.data.error === 'object' ? loser.data.error?.code : undefined;
    assert(
      loserCode === 'claimed_active' || loserCode === 'claim_race',
      `loser code expected 'claimed_active' or 'claim_race', got ${loserCode}`,
    );
  });

  console.log('\n🔹 same-owner refresh');
  await test('same daemon re-acquiring its own claim → 200 refreshed', async () => {
    const first = await acquire(owner.token, asset.id, asset.ingestVersion, 'dev-race-A');
    // first should already be the active row (created in the race above).
    // If the race winner was dev-race-B, this still applies because the
    // claim is per-(assetId,ingestVersion) not per-device; assert from the
    // observed state.
    const sameDevice = first.data.data?.claimantDeviceId ?? 'dev-race-A';
    const refresh = await acquire(owner.token, asset.id, asset.ingestVersion, sameDevice);
    assert(refresh.status === 200, `expected 200 refresh, got ${refresh.status} ${JSON.stringify(refresh.data)}`);
    assert(refresh.data.ok === true, 'refresh body.ok should be true');
  });

  console.log('\n🔹 heartbeat — wrong device');
  await test('heartbeat from a different daemon returns 410 claim_taken_over', async () => {
    // Find the current owning device first.
    const probe = await acquire(owner.token, asset.id, asset.ingestVersion, 'dev-race-A');
    const claimId = probe.data.data?.id ?? probe.data.meta?.claim
      ? (probe.data.meta?.claim as ClaimEnvelope | undefined)?.id
      : undefined;
    const currentDevice = probe.data.data?.claimantDeviceId;
    assert(!!claimId && !!currentDevice, `no current claim observable: ${JSON.stringify(probe.data)}`);
    // Heartbeat from "definitely not the current device".
    const wrongDevice = currentDevice === 'dev-race-A' ? 'dev-race-B' : 'dev-race-A';
    const r = await heartbeat(owner.token, claimId!, wrongDevice);
    assert(r.status === 410, `expected 410, got ${r.status} ${JSON.stringify(r.data)}`);
    const code = typeof r.data.error === 'object' ? r.data.error?.code : undefined;
    assert(code === 'claim_taken_over', `expected code claim_taken_over, got ${code}`);
  });

  console.log('\n🔹 complete + re-acquire');
  await test('complete then re-acquire same (asset, version) → 409 already_complete', async () => {
    // Re-acquire to learn the claim id + active device for this asset.
    const cur = await acquire(owner.token, asset.id, asset.ingestVersion, 'dev-race-A');
    const claimId = cur.data.data?.id;
    const device = cur.data.data?.claimantDeviceId ?? 'dev-race-A';
    assert(!!claimId, `expected an active claim, got ${JSON.stringify(cur.data)}`);
    // Caller may not be the owner of this claim (the race winner may have
    // been dev-race-B). In that case the test for already_complete is
    // still valid, we just need to complete from the right device.
    const completeRes = await complete(owner.token, claimId!, device);
    assert(completeRes.status === 200, `expected 200 complete, got ${completeRes.status} ${JSON.stringify(completeRes.data)}`);
    // Re-acquire from anyone now → already_complete.
    const after = await acquire(owner.token, asset.id, asset.ingestVersion, 'dev-after-complete');
    assert(after.status === 409, `expected 409 after complete, got ${after.status} ${JSON.stringify(after.data)}`);
    const code = typeof after.data.error === 'object' ? after.data.error?.code : undefined;
    assert(code === 'already_complete', `expected code already_complete, got ${code}`);
  });

  // Stale takeover — only runs if the server was launched with a small TTL
  // so the test doesn't have to sleep 30+ seconds. Bump asset.ingestVersion
  // by uploading a derived asset so we get a fresh (asset, version) target.
  if (STALE_TTL_MS > 0 && STALE_TTL_MS <= 2000) {
    console.log(`\n🔹 stale takeover (TTL=${STALE_TTL_MS}ms)`);
    await test('claim with stale heartbeat is overwritten in place by another daemon', async () => {
      const fresh = await uploadAsset(owner.token, workspaceId, `stale-test ${TS}-${Math.random()}`);
      const first = await acquire(owner.token, fresh.id, fresh.ingestVersion, 'dev-stale-A');
      assert(first.status === 201, `expected 201 on initial acquire, got ${first.status}`);
      const originalId = first.data.data?.id;
      await new Promise((r) => setTimeout(r, STALE_TTL_MS + 100));
      const taken = await acquire(owner.token, fresh.id, fresh.ingestVersion, 'dev-stale-B');
      assert(taken.status === 200, `expected 200 takeover, got ${taken.status} ${JSON.stringify(taken.data)}`);
      // Takeover is in-place — same row id, new device.
      assert(taken.data.data?.id === originalId, `row id changed during takeover: ${originalId} → ${taken.data.data?.id}`);
      assert(taken.data.data?.claimantDeviceId === 'dev-stale-B', `device not updated: ${taken.data.data?.claimantDeviceId}`);
    });
  } else {
    console.log(`\n🔹 stale takeover — SKIPPED (start server with INGEST_CLAIM_HEARTBEAT_TTL_MS≤2000 to enable)`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Total: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
