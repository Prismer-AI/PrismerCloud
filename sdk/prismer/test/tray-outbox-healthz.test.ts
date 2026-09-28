// tray-outbox-healthz.test.ts — desktop205/04 §4 (W13), daemon half.
//
// WHY THIS EXISTS
// The 2026-07-26 product ruling makes the desktop Tray the ONLY observability
// surface an ordinary user has (daemon runtime is a server-side thing; the
// `prismer` CLI is structurally blind to the desktop daemon). One of the four
// things they could not see was "产物去哪了" — the cleanup that day found 2
// in-flight + 4 dead-letter rows in `asset-origin.db` that no UI ever mentioned.
//
// ORACLE — deliberately NOT a log line or a mocked count:
//   real OriginOutbox (real SQLite, real rows)
//     → real snapshotOriginOutboxCounts (the THREE PRE-EXISTING accessors)
//       → LocalServerState
//         → real LocalServer over real HTTP
//           → parsed /healthz JSON
// Every assertion reads that final JSON body.
//
// THE COST CONSTRAINT IS ITSELF UNDER TEST
// /healthz is a zero-I/O in-memory projection and the Tray POLLS it. So the
// counting must happen on the PRODUCER side and healthz must only read the
// pushed sample. `getState` call counting below pins that: N healthz hits must
// not produce N samples.
//
// NEGATIVE CONTROLS (a test that goes green either way is not a test):
//   NC-2  state without the field ⇒ the key is ABSENT from healthz, so the
//         CLI / K8s response shape is byte-identical to pre-W13.
//   NC-3  invert the data source (drop dead-letter rows / stop sampling) ⇒ the
//         positive assertion must go RED. Expressed as `runOnce(tamper)`, one
//         parameter of the same scenario — not a second mechanism.

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundPort } from './_helpers/listen-ephemeral.js';
import {
  OriginOutbox,
  snapshotOriginOutboxCounts,
  type OriginObservationRecord,
} from '../src/daemon/asset/origin/outbox.js';

const dirs: string[] = [];
let server: LocalServer | undefined;
let port = 0;

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'prismer-w13-'));
  dirs.push(d);
  return d;
}

function observation(overrides: Partial<OriginObservationRecord> = {}): OriginObservationRecord {
  return {
    workspaceId: 'ws_w13',
    originKind: 'drop-folder',
    sourceRef: 'folder://drop/a.csv',
    payloadJson: JSON.stringify({ path: '/tmp/drop/a.csv', mtime: 1 }),
    hintsJson: JSON.stringify({ filename: 'a.csv', folderPath: 'drop' }),
    observedAt: 1,
    ...overrides,
  };
}

function baseState(overrides: Partial<LocalServerState> = {}): LocalServerState {
  return {
    daemonId: 'daemon-w13',
    daemonVersion: '2.2.4',
    cloudBaseUrl: 'http://cloud.test',
    workspaceId: 'ws_w13',
    pid: 4242,
    startedAt: Date.now() - 1_000,
    wsConnected: true,
    hostedAgents: [],
    runningTaskIds: [],
    ...overrides,
  };
}

/**
 * The real drop-folder world: an OriginOutbox on disk plus the producer-side
 * sampling step the runner performs on its 1s tick.
 */
function makeOutboxWorld() {
  const dbPath = join(tmpDir(), 'asset-origin.db');
  const outbox = new OriginOutbox({ dbPath });
  let sample: ReturnType<typeof snapshotOriginOutboxCounts> | undefined;
  return {
    outbox,
    /** what the runner's drop-folder tick does */
    tick: () => {
      sample = snapshotOriginOutboxCounts(outbox);
    },
    /** what the runner exposes to /healthz — a pushed value, never a live read */
    read: () => sample,
    stopSampling: () => {
      sample = undefined;
    },
    /**
     * "user cleaned up the failed uploads". Done with a second connection to the
     * SAME db file rather than by adding a purge method to production code: the
     * test may manipulate the WORLD, it may not grow the SUT to suit itself.
     */
    clearDeadLetters: () => {
      const raw = new Database(dbPath);
      raw.prepare('DELETE FROM asset_origin_artifacts_dead_letter').run();
      raw.close();
    },
  };
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('W13 — asset outbox backlog on /healthz (desktop205/04 §4)', () => {
  /**
   * One run of the whole scenario. `tamper` is the negative-control seam: it
   * runs against the SAME world right before the assertions, so a green run and
   * a red run differ by exactly one injected fault.
   */
  async function runOnce(tamper?: (w: ReturnType<typeof makeOutboxWorld>) => void) {
    const w = makeOutboxWorld();
    // 2 healthy pending rows + 3 dead-letter rows (missing workspaceId fails
    // envelope validation → dead-letter, same as the real drop-folder path).
    w.outbox.enqueue(observation({ sourceRef: 'folder://drop/a.csv', observedAt: 1 }));
    w.outbox.enqueue(observation({ sourceRef: 'folder://drop/b.csv', observedAt: 2 }));
    for (let i = 0; i < 3; i++) {
      w.outbox.enqueue(observation({ workspaceId: '', sourceRef: `folder://drop/bad${i}.csv` }));
    }
    w.tick();
    tamper?.(w);

    let getStateCalls = 0;
    server = new LocalServer({
      port: 0, // ephemeral — read the real port back after start (O16-b)
      getState: () => {
        getStateCalls += 1;
        const s = w.read();
        return baseState({ ...(s ? { assetOutbox: s } : {}) });
      },
    });
    await server.start();
    port = boundPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    return { body, world: w, getStateCalls: () => getStateCalls };
  }

  it('positive control — a real dead-letter backlog reaches /healthz, and clearing it zeroes the count', async () => {
    const { body, world } = await runOnce();

    const outbox = body.assetOutbox as { pending: number; uploaded: number; deadLetter: number; sampledAt: number };
    expect(outbox).toBeDefined();
    expect(outbox.deadLetter).toBe(3);
    expect(outbox.pending).toBe(2);
    expect(outbox.uploaded).toBe(0);
    expect(outbox.sampledAt).toBeGreaterThan(0);

    // …drain the queue for real (claim → markUploaded) and wipe the dead
    // letters, re-sample, re-read: the number must FOLLOW the db, not latch.
    for (;;) {
      const claim = world.outbox.claimNext();
      if (!claim) break;
      world.outbox.markUploaded(claim.id, { assetId: `as_${claim.id}`, contentHash: 'deadbeef' });
    }
    world.clearDeadLetters();
    world.tick();

    const after = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;
    const outbox2 = after.assetOutbox as { pending: number; uploaded: number; deadLetter: number };
    expect(outbox2.deadLetter).toBe(0);
    expect(outbox2.pending).toBe(0);
    expect(outbox2.uploaded).toBe(2);
  });

  it('NC-3 — with the dead-letter rows removed before sampling, the backlog assertion goes red', async () => {
    // Same scenario, one injected fault: the dead letters are gone at sample
    // time. If the positive assertion above could pass here, it was not reading
    // the outbox at all.
    const { body } = await runOnce((w) => {
      w.clearDeadLetters();
      w.tick();
    });
    const outbox = body.assetOutbox as { deadLetter: number };
    expect(outbox.deadLetter).not.toBe(3);
    expect(outbox.deadLetter).toBe(0);
  });

  it('NC-3 — with the producer not sampling, /healthz omits the field entirely (no data ≠ 0)', async () => {
    const { body } = await runOnce((w) => w.stopSampling());
    expect('assetOutbox' in body).toBe(false);
    // …and specifically NOT a zeroed reading, which would claim "nothing pending"
    // while 3 dead letters sit on disk.
    expect(body.assetOutbox).toBeUndefined();
  });

  it('NC-2 — a state without the field leaves the CLI / K8s healthz shape untouched', async () => {
    const state = baseState();
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    port = boundPort(server);
    const body = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;

    expect('assetOutbox' in body).toBe(false);
    // The pre-W13 fields are all still there and unchanged.
    expect(body.status).toBe('ok');
    expect(body.daemonId).toBe('daemon-w13');
    expect(body.daemonVersion).toBe('2.2.4');
    expect(body.wsConnected).toBe(true);
    expect(body.hostedAgents).toEqual([]);
  });

  it('healthz stays zero-I/O: polling it never counts rows (the sample is pushed in)', async () => {
    const { getStateCalls, world } = await runOnce();
    const before = getStateCalls();

    // Mutate the db WITHOUT ticking the producer. If healthz counted rows, the
    // reading would move; it must not — the Tray polls this endpoint.
    world.outbox.enqueue(observation({ sourceRef: 'folder://drop/late.csv', observedAt: 99 }));
    for (let i = 0; i < 5; i++) await fetch(`http://127.0.0.1:${port}/healthz`);

    const body = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;
    const outbox = body.assetOutbox as { pending: number };
    expect(outbox.pending).toBe(2); // still the pre-enqueue sample
    expect(getStateCalls()).toBeGreaterThan(before); // we really did hit it repeatedly

    // …and after ONE producer tick it catches up. (Proves the staleness above is
    // the sampling design, not a broken read.)
    world.tick();
    const fresh = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;
    expect((fresh.assetOutbox as { pending: number }).pending).toBe(3);
  });
});

describe('W13 — GET /tasks/running detail rows (desktop205/04 §4)', () => {
  it('carries per-task descriptors when the runner supplies them', async () => {
    const state = baseState({
      runningTaskIds: ['t_1', 't_2'],
      runningTasks: [
        { taskId: 't_1', agentName: 'helper', kind: 'run', scopeLabel: 'Workspace: 研发 · Project: none', startedAt: 1 },
        { taskId: 't_2', kind: 'task', startedAt: 2 },
      ],
    });
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    port = boundPort(server);

    const body = (await (await fetch(`http://127.0.0.1:${port}/tasks/running`)).json()) as Record<string, unknown>;
    expect(body.taskIds).toEqual(['t_1', 't_2']);
    const tasks = body.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ taskId: 't_1', agentName: 'helper', scopeLabel: 'Workspace: 研发 · Project: none' });
    // t_2 has no agentName — absent, not an empty string.
    expect('agentName' in tasks[1]!).toBe(false);
  });

  it('NC-2 — a runner that supplies no detail leaves /tasks/running byte-shaped as before', async () => {
    const state = baseState({ runningTaskIds: ['t_1'] });
    server = new LocalServer({ port: 0, getState: () => state });
    await server.start();
    port = boundPort(server);

    const body = (await (await fetch(`http://127.0.0.1:${port}/tasks/running`)).json()) as Record<string, unknown>;
    expect(body).toEqual({ taskIds: ['t_1'] });
  });
});
