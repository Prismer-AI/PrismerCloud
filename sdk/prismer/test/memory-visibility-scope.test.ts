// E4 (product204) — role/council-scoped memory-write round-trip.
//
// What this proves (end-to-end through the REAL write path, not a mock):
//   tool `visibility` string  →  handleWrite parseVisibilityString  →
//   store.write persist (visibilityKind + visibilityImUserId column)  →
//   rowToPage rehydrate (page.visibility union)  →  visibilityToString  →
//   the `memory.page.upsert` outbox envelope's `visibility` field.
//
// The oracle is the OUTBOX ENVELOPE STRING (the exact bytes that up-sync to the
// cloud, which honors body.visibility) — read from the store's own outbox table,
// never asserted from a mock. Cloud already honors `role:<slug>` / `council:<id>`
// (memory-write.service + memory-acl); this test locks the DAEMON half so the
// scope round-trips instead of being silently flattened to `workspace`.
//
// Cases:
//   1. council:<id>  → envelope visibility === 'council:<id>' AND the rehydrated
//      page.visibility === { kind:'council', id }.
//   2. role:<slug>   → envelope visibility === 'role:<slug>' AND page.visibility
//      === { kind:'role', slug }.
//   3. NEGATIVE / DEFAULT — visibility absent → envelope 'workspace',
//      page.visibility { kind:'workspace' }.
//   4. NEGATIVE — an unknown scope string ('bogus:xyz' / 'garbage') degrades to
//      'workspace' (conservative D3), never leaks the raw string up-sync.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { withDescription } from './_helpers/pkf-description.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintSystemCap } from '../src/daemon/memory/cap.js';

const WS = 'ws_e4_visibility';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';

const baseState: LocalServerState = {
  daemonId: 'dev_e4',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99998,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

// spec16 §8.1 — fail-closed RPC: this suite locks the role/council round-trip
// (parse → persist → rehydrate → envelope), NOT the visibility authz gate
// (that is memory-acl-predicate.test.ts), so the helper carries the
// daemon-internal system cap, which bypasses the visibility gate exactly like
// the old no-cap path did.
let sysCap = '';

async function startServer(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-e4-vis-'));
  cleanupDirs.push(dir);
  sysCap = mintSystemCap();
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_e4' });
  // No cloud wired: op=replace is local-first, so the write + outbox enqueue run
  // without any cloud dependency (the round-trip we assert is purely daemon-side).
  server = new LocalServer({
    port: 0, // ephemeral — read the real port back after start (O16-b)
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime, deviceId: 'dev_e4' }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

beforeEach(async () => {
  // Visibility round-trip is orthogonal to structural placement.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  await startServer();
});

afterEach(async () => {
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  server = undefined;
  runtime?.closeAll();
  runtime = undefined;
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  // memory211/01 轴H ② — a NEW page must carry a frontmatter description. These
  // fixtures test the visibility surface, so the mandated frontmatter is stamped
  // on write bodies here rather than hand-written per case.
  if (path === '/local/memory/write') {
    const b = body as { content?: unknown };
    if (typeof b?.content === 'string') body = { ...b, content: withDescription(b.content) };
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': sysCap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The `visibility` field on the newest memory.page.upsert outbox envelope. */
function lastUpsertVisibility(): string | undefined {
  const db = runtime!.resolve(WS).store.rawDb();
  const row = db
    .prepare(
      "SELECT envelopeJson FROM memory_outbox WHERE eventType = 'memory.page.upsert' ORDER BY createdAt DESC, id DESC LIMIT 1",
    )
    .get() as { envelopeJson: string } | undefined;
  if (!row) return undefined;
  return (JSON.parse(row.envelopeJson) as { visibility?: string }).visibility;
}

const writeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspaceId: WS,
  path: 'decisions/scope.pkf',
  content: '<h1>Scope decision</h1><p>body</p>',
  title: 'Scope',
  actorImUserId: 'im_orchestrator',
  actorKind: 'agent',
  ...overrides,
});

describe('E4 — role/council visibility round-trips tool → store → outbox envelope', () => {
  it('council:<id> is persisted, rehydrated as {kind:council,id}, and emitted verbatim on the envelope', async () => {
    const councilId = 'cnl_abc123';
    const r = await post('/local/memory/write', writeBody({
      path: 'councils/roundtable-a/decision.pkf',
      visibility: `council:${councilId}`,
    }));
    expect(r.status).toBe(200);

    // Rehydrated page carries the structured union (store column round-trip).
    const page = runtime!.resolve(WS).store.loadByAnyPath('councils/roundtable-a/decision.pkf')!;
    expect(page.visibility).toEqual({ kind: 'council', id: councilId });

    // The outbox envelope string is EXACTLY what the cloud memory-acl expects.
    expect(lastUpsertVisibility()).toBe(`council:${councilId}`);
  });

  it('role:<slug> is persisted, rehydrated as {kind:role,slug}, and emitted verbatim on the envelope', async () => {
    const slug = 'growth-strategist';
    const r = await post('/local/memory/write', writeBody({
      path: 'roles/growth/playbook.pkf',
      visibility: `role:${slug}`,
    }));
    expect(r.status).toBe(200);

    const page = runtime!.resolve(WS).store.loadByAnyPath('roles/growth/playbook.pkf')!;
    expect(page.visibility).toEqual({ kind: 'role', slug });

    expect(lastUpsertVisibility()).toBe(`role:${slug}`);
  });

  it('task:<id> is persisted and emitted verbatim for task-bound PKF pages', async () => {
    const taskId = 'cmp_pkf6_task';
    const r = await post('/local/memory/write', writeBody({
      path: 'reports/task-bound.pkf',
      visibility: `task:${taskId}`,
    }));
    expect(r.status).toBe(200);
    expect(runtime!.resolve(WS).store.loadByAnyPath('reports/task-bound.pkf')!.visibility).toEqual({
      kind: 'task',
      id: taskId,
    });
    expect(lastUpsertVisibility()).toBe(`task:${taskId}`);
  });

  it('NEGATIVE CONTROL — absent visibility defaults to workspace (never council/role)', async () => {
    const r = await post('/local/memory/write', writeBody({ path: 'plain/leaf.pkf' }));
    expect(r.status).toBe(200);

    const page = runtime!.resolve(WS).store.loadByAnyPath('plain/leaf.pkf')!;
    expect(page.visibility).toEqual({ kind: 'workspace' });

    expect(lastUpsertVisibility()).toBe('workspace');
  });

  it('NEGATIVE CONTROL — an unknown scope string degrades to workspace (D3, no raw leak up-sync)', async () => {
    const r1 = await post('/local/memory/write', writeBody({ path: 'x/a.pkf', visibility: 'bogus:xyz' }));
    expect(r1.status).toBe(200);
    expect(runtime!.resolve(WS).store.loadByAnyPath('x/a.pkf')!.visibility).toEqual({ kind: 'workspace' });
    expect(lastUpsertVisibility()).toBe('workspace');

    const r2 = await post('/local/memory/write', writeBody({ path: 'x/b.pkf', visibility: 'garbage' }));
    expect(r2.status).toBe(200);
    expect(runtime!.resolve(WS).store.loadByAnyPath('x/b.pkf')!.visibility).toEqual({ kind: 'workspace' });
    expect(lastUpsertVisibility()).toBe('workspace');
  });

  it('agent:<id> still round-trips (regression — the existing owner-scoped path is unchanged)', async () => {
    const r = await post('/local/memory/write', writeBody({
      path: 'agent/note.pkf',
      visibility: 'agent:im_orchestrator',
    }));
    expect(r.status).toBe(200);
    expect(runtime!.resolve(WS).store.loadByAnyPath('agent/note.pkf')!.visibility).toEqual({
      kind: 'agent',
      imUserId: 'im_orchestrator',
    });
    expect(lastUpsertVisibility()).toBe('agent:im_orchestrator');
  });
});
