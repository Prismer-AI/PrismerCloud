// memory211/01 §6.11 D11-5 (W7 item 1) — the READ side of `[memory-trace]`.
//
// The write lane has logged trace stages since memory203/18 R8.2; until W7 the
// four read handlers (search / load / browse=place-context / the search
// miss-lane's navigation) emitted NOTHING, so the §6.9-1 "渐进披露 +
// direct-recall shortcut" claim had no observational face on the path where it
// actually happens. This suite pins the read lines:
//
//   stage=search    queries=N navigation_used=true|false tiers=wiki:2,raw:1
//                   results=N duration_ms=N traceId=…
//   stage=navigate  queries=N start_points=N …        (only when the miss lane fired)
//   stage=browse    hubs=N nearest=M queried=true|false …
//   stage=load      path=… found=true|false …
//
// Acceptance (spec §6.11 item 1): the negative control is that REMOVING the
// trace call turns these assertions red. That mutation was executed by hand
// while landing this file — the emitReadTrace write commented out ⇒ 5 of this
// suite's 7 tests failed (see task-W7-report.md §1) — and restored. Two
// in-test controls keep the suite honest without a mutation:
//   · a denied request (no cap) and a malformed request produce NO trace line,
//     so a green run cannot come from some other log source;
//   · the query TEXT never appears in any trace line — the read trace carries
//     counts/paths/durations only (the same privacy boundary item 4 pins for
//     the tool-sequence ring).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';
import { MemoryRuntime, attachMemoryRpc } from '../src/daemon/memory/index.js';
import { mintSystemCap } from '../src/daemon/memory/cap.js';

let cleanupDirs: string[] = [];
let server: LocalServer | undefined;
let runtime: MemoryRuntime | undefined;
let baseUrl = '';
let sysCap = '';
let stderr = '';
let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

const QUERY = 'quorum ring ordering heuristics';

const baseState: LocalServerState = {
  daemonId: 'dev_x',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

beforeEach(async () => {
  // Placement is not under test here; keep the legacy flat-write posture.
  process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE = 'warn';
  const dir = mkdtempSync(join(tmpdir(), 'prismer-memory-read-trace-'));
  cleanupDirs.push(dir);
  sysCap = mintSystemCap();
  runtime = new MemoryRuntime({ baseDir: dir, deviceId: 'dev_x' });
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    attachMemory: attachMemoryRpc({ runtime }),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
  stderr = '';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as never);
});

afterEach(async () => {
  stderrSpy?.mockRestore();
  delete process.env.PRISMER_MEMORY_PLACEMENT_ENFORCE;
  await server?.stop();
  runtime?.closeAll();
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-prismer-memory-cap': sysCap } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-prismer-memory-cap': sysCap },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Seed one INDEX hub + a leaf with searchable prose. Write-lane noise lines
 *  (placement_warn) are cleared so only READ traces remain asserted. */
async function seedPages(): Promise<void> {
  await post('/local/memory/write', {
    workspaceId: 'ws_trace',
    path: 'INDEX.md',
    content: '# index\n\n- aurora/index.md',
    pageType: 'hub',
    title: 'Workspace Index',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  await post('/local/memory/write', {
    workspaceId: 'ws_trace',
    path: 'aurora/index.md',
    content: '# aurora\n\n## quorum-rings\n\nQuorum rings order themselves by lease age.',
    pageType: 'hub',
    title: 'Aurora',
    actorImUserId: 'im_alice',
    actorKind: 'human',
  });
  stderr = '';
}

/** The `[memory-trace]` lines only (write-lane noise excluded). */
function traceLines(): string[] {
  return stderr
    .split('\n')
    .filter((l) => l.startsWith('[memory-trace] '))
    .map((l) => l.slice('[memory-trace] '.length));
}

function field(line: string, key: string): string | undefined {
  for (const part of line.split(' ')) {
    const [k = '', v = ''] = part.split('=', 2);
    if (k === key) return v;
  }
  return undefined;
}

describe('read-side [memory-trace] (W7 item 1, D11-5)', () => {
  it('stage=search logs queries / navigation_used / tier distribution / results / duration / traceId', async () => {
    await seedPages();
    const r = await get(
      `/local/memory/search?workspaceId=ws_trace&q=${encodeURIComponent(QUERY)}&topK=5`,
    );
    expect(r.status).toBe(200);

    const lines = traceLines().filter((l) => l.startsWith('stage=search '));
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(field(line, 'queries')).toBe('1');
    expect(field(line, 'navigation_used')).toBe('false'); // lexical hit ⇒ no miss lane
    expect(field(line, 'results')).toBe('1');
    expect(field(line, 'tiers')).toBe('wiki:1');
    expect(Number(field(line, 'duration_ms'))).toBeGreaterThanOrEqual(0);
    expect(field(line, 'traceId')).toMatch(/^rd_[0-9a-f]{10}$/);
  });

  it('a text miss adds navigation_used=true AND a second stage=navigate line with the start points', async () => {
    await seedPages();
    const r = await get(
      `/local/memory/search?workspaceId=ws_trace&q=${encodeURIComponent('zzz no such term anywhere qqq')}&topK=5`,
    );
    expect(r.status).toBe(200);
    const body = r.body as { navigation?: { startPoints?: unknown[] }; results: unknown[] };
    expect(body.results).toEqual([]);
    expect((body.navigation?.startPoints ?? []).length).toBeGreaterThan(0);

    const search = traceLines().find((l) => l.startsWith('stage=search '));
    expect(search).toBeDefined();
    expect(field(search!, 'navigation_used')).toBe('true');
    expect(field(search!, 'results')).toBe('0');

    const nav = traceLines().find((l) => l.startsWith('stage=navigate '));
    expect(nav, 'the miss lane must emit its own stage=navigate line').toBeDefined();
    expect(field(nav!, 'queries')).toBe('1');
    expect(Number(field(nav!, 'start_points'))).toBe((body.navigation?.startPoints ?? []).length);
    expect(field(nav!, 'traceId')).toBe(field(search!, 'traceId'));
  });

  it('stage=load logs found=true on a hit and found=false on a 404 (with the page path)', async () => {
    await seedPages();
    const hit = await get('/local/memory/load?workspaceId=ws_trace&path=aurora/index.md');
    expect(hit.status).toBe(200);
    const hitLine = traceLines().find((l) => l.startsWith('stage=load '));
    expect(hitLine).toBeDefined();
    expect(field(hitLine!, 'path')).toBe('aurora/index.md');
    expect(field(hitLine!, 'found')).toBe('true');

    stderr = '';
    const miss = await get('/local/memory/load?workspaceId=ws_trace&path=aurora/missing.md');
    expect(miss.status).toBe(404);
    const missLine = traceLines().find((l) => l.startsWith('stage=load '));
    expect(missLine).toBeDefined();
    expect(field(missLine!, 'path')).toBe('aurora/missing.md');
    expect(field(missLine!, 'found')).toBe('false');
  });

  it('stage=browse logs the structure view shape (hubs / nearest / queried) without the query text', async () => {
    await seedPages();
    const r = await get(
      `/local/memory/place-context?workspaceId=ws_trace&q=${encodeURIComponent(QUERY)}`,
    );
    expect(r.status).toBe(200);
    const line = traceLines().find((l) => l.startsWith('stage=browse '));
    expect(line, 'memory_browse (place-context) must emit stage=browse').toBeDefined();
    expect(Number(field(line!, 'hubs'))).toBeGreaterThan(0);
    expect(field(line!, 'queried')).toBe('true');
    expect(field(line!, 'traceId')).toMatch(/^rd_[0-9a-f]{10}$/);
  });

  it('a caller-supplied traceId is honoured so a read joins the write-side chain', async () => {
    await seedPages();
    await get(
      `/local/memory/search?workspaceId=ws_trace&q=quorum&topK=3&traceId=${encodeURIComponent('wr_abc123def4')}`,
    );
    const line = traceLines().find((l) => l.startsWith('stage=search '));
    expect(field(line!, 'traceId')).toBe('wr_abc123def4');
  });

  it('a hostile traceId (newline / over-length / odd characters) never reaches a trace line', async () => {
    await seedPages();
    stderr = '';
    // A newline would forge a second "trace row"; a 200-char token would bloat
    // every line; a space would shift the key=value parsing. All three must be
    // replaced by a freshly minted id, never echoed verbatim.
    for (const hostile of [
      'wr_evil\n[memory-trace] stage=forged path=x',
      'a'.repeat(200),
      'has space and/slash',
    ]) {
      const r = await get(
        `/local/memory/search?workspaceId=ws_trace&q=quorum&topK=3&traceId=${encodeURIComponent(hostile)}`,
      );
      expect(r.status).toBe(200);
    }
    const ids = traceLines()
      .filter((l) => l.startsWith('stage=search '))
      .map((l) => field(l, 'traceId'));
    expect(ids.length).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(id).toMatch(/^rd_/);
    }
    expect(stderr).not.toContain('stage=forged');
    expect(stderr).not.toContain('has space');
    expect(stderr).not.toContain('a'.repeat(33));
  });

  it('CONTROL — a denied (no cap) or malformed request emits no read trace at all', async () => {
    await seedPages();
    stderr = '';
    // No cap header → the fail-closed cap gate answers before any handler runs.
    const denied = await fetch(
      `${baseUrl}/local/memory/search?workspaceId=ws_trace&q=${encodeURIComponent(QUERY)}`,
    );
    expect(denied.status).toBe(401);
    // Malformed recall (no q / queries) → 400, nothing was recalled.
    const bad = await get('/local/memory/search?workspaceId=ws_trace');
    expect(bad.status).toBe(400);
    expect(traceLines()).toEqual([]);
  });

  it('CONTROL — the query text never reaches any read trace line (privacy boundary)', async () => {
    await seedPages();
    await get(`/local/memory/search?workspaceId=ws_trace&q=${encodeURIComponent(QUERY)}&topK=5`);
    await get(`/local/memory/place-context?workspaceId=ws_trace&q=${encodeURIComponent(QUERY)}`);
    await get('/local/memory/load?workspaceId=ws_trace&path=aurora/index.md');
    expect(stderr).not.toContain(QUERY);
    expect(stderr).not.toContain('quorum ring');
  });
});
