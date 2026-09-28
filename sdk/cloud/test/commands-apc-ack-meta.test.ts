/**
 * apc P0-1 / P0-2 — `cloud skill ack` + `cloud task meta set`.
 *
 * Anti-open-book discipline (apc/11 §1):
 *
 *  - `fetch` is NOT mocked. Every case runs a REAL `node:http` server on
 *    127.0.0.1 and a REAL `PrismerClient` (global fetch), so the oracle is the
 *    request the server actually received — method, path, and parsed JSON body
 *    — plus the process exit code. No injected transport, no stubbed client.
 *  - Every "cannot produce a receipt" / "server refused" case asserts a
 *    SIDE-EFFECT absence: `server.calls.length === 0` (nothing was written) or
 *    a specific exit code, never the wording of a message.
 *  - Each positive case ships with a negative control that must flip it red.
 *
 * The endpoints these verbs wrap are load-bearing and were verified against
 * source before this file was written:
 *   POST /api/im/tasks/:id/event  — src/im/api/tasks.ts:2486 (assignee-only :2510)
 *   PATCH /api/im/tasks/:id       — src/im/api/tasks.ts:1784
 *     → metadata shallow-merge      src/im/services/task.service.ts:2661-2662
 *     → edit-content gate           src/im/services/task-permission.ts:817-822
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { register as registerTask, parseMetaAssignments, applyMetaAssignment } from '../src/commands/task';
import { register as registerSkill } from '../src/commands/skill';
// Real HTTP fake-cloud (no fetch mock — the SDK performs genuine requests).
// Moved to test/helpers/fake-cloud.ts when the git CLI suite needed it too.
import { startFakeCloud, makeRealClient, runCli, type FakeCloud, type Route } from './helpers/fake-cloud';

const okEvent: Route = ({ path }) => ({
  status: 200,
  json: { ok: true, data: { taskId: path.split('/')[4], action: 'skill_ack' } },
});

let cloud: FakeCloud;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  cloud = await startFakeCloud(okEvent);
  for (const k of ['PRISMER_TASK_ID', 'PRISMER_AGENT_IM_USER_ID']) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await cloud.close();
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 — cloud skill ack
// ═══════════════════════════════════════════════════════════════════════════

describe('cloud skill ack — real HTTP round trip', () => {
  it('POSTs /api/im/tasks/:id/event with code SKILL_ACK + slug payload, exit 0', async () => {
    const client = makeRealClient(cloud.baseUrl);
    process.env.PRISMER_AGENT_IM_USER_ID = 'imu_agent_1';

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'spec-intake', '--task', 'tsk_abc']);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    const call = cloud.calls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/im/tasks/tsk_abc/event');
    const body = call.body as { code: string; payload: Record<string, unknown>; message?: string };
    expect(body.code).toBe('SKILL_ACK');
    expect(body.payload.skillSlug).toBe('spec-intake');
    expect(body.payload.taskId).toBe('tsk_abc');
    expect(body.payload.agentId).toBe('imu_agent_1');
    expect(typeof body.payload.ts).toBe('string');
  });

  it('falls back to PRISMER_TASK_ID when --task is omitted', async () => {
    const client = makeRealClient(cloud.baseUrl);
    process.env.PRISMER_TASK_ID = 'tsk_from_env';

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'test-runner']);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0].path).toBe('/api/im/tasks/tsk_from_env/event');
  });

  // ── negative control 1: no task context ⇒ no receipt can exist ──────────
  // Oracle is the ABSENCE of a side effect (zero HTTP calls) + the dedicated
  // exit code — not the wording of the error.
  it('NEGATIVE: no --task and no PRISMER_TASK_ID → exit 3 and ZERO requests', async () => {
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'env-doctor']);

    expect(r.exitCode).toBe(3);
    expect(cloud.calls).toHaveLength(0);
  });

  // ── negative control 2: a chat-dispatch run has no task row ─────────────
  it('NEGATIVE: run_ id → exit 3 and ZERO requests', async () => {
    const client = makeRealClient(cloud.baseUrl);
    process.env.PRISMER_TASK_ID = 'run_xyz';

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'git-ops']);

    expect(r.exitCode).toBe(3);
    expect(cloud.calls).toHaveLength(0);
  });

  // ── negative control 3: the load-bearing assignee-only server gate ──────
  it('NEGATIVE: server 403 TASK_ACCESS_DENIED → exit 4 (distinct from generic failure)', async () => {
    cloud.setRoute(() => ({
      status: 403,
      json: {
        ok: false,
        error: { code: 'TASK_ACCESS_DENIED', message: 'only the task assignee can post task events' },
      },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'tdd', '--task', 'tsk_not_mine']);

    expect(r.exitCode).toBe(4);
    expect(cloud.calls).toHaveLength(1);
  });

  it('NEGATIVE: server 500 → exit 1 (not conflated with the assignee gate)', async () => {
    cloud.setRoute(() => ({
      status: 500,
      json: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'failed to record task event' } },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerSkill, client, ['skill', 'ack', 'tdd', '--task', 'tsk_abc']);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 — cloud task meta set
// ═══════════════════════════════════════════════════════════════════════════

const okPatch: Route = ({ method, path }) => {
  if (method === 'PATCH') return { status: 200, json: { ok: true, data: { id: path.split('/')[4] } } };
  return { status: 404, json: { ok: false, error: { code: 'NOT_FOUND', message: path } } };
};

describe('cloud task meta set — real HTTP round trip', () => {
  it('top-level --set → single PATCH /api/im/tasks/:id with {metadata}, no GET', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_1',
      '--set', 'loopId=lp_9',
      '--set', 'retries=2',
      '--set', 'blocked=false',
    ]);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1); // no read-modify-write needed
    expect(cloud.calls[0].method).toBe('PATCH');
    expect(cloud.calls[0].path).toBe('/api/im/tasks/tsk_1');
    expect((cloud.calls[0].body as { metadata: unknown }).metadata).toEqual({
      loopId: 'lp_9', // unparseable as JSON → stays a string
      retries: 2, // JSON number
      blocked: false, // JSON boolean
    });
  });

  it('nested --set GETs the task first and preserves sibling keys under the touched top-level key', async () => {
    cloud.setRoute(({ method, path }) => {
      if (method === 'GET') {
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              task: {
                id: 'tsk_2',
                metadata: {
                  kind: 'work_item',
                  assets: { linkedAssetIds: ['ast_old'], aggregatedAssetIds: ['ast_chat'] },
                },
              },
              logs: [],
            },
          },
        };
      }
      return okPatch({ method, path, body: undefined });
    });
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_2',
      '--set', 'assets.linkedAssetIds=["ast_spec"]',
    ]);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    const patched = (cloud.calls[1].body as { metadata: Record<string, any> }).metadata;
    // The written key…
    expect(patched.assets.linkedAssetIds).toEqual(['ast_spec']);
    // …and the sibling the server's TOP-LEVEL-ONLY merge would otherwise drop.
    // This is the whole reason the read-modify-write exists.
    expect(patched.assets.aggregatedAssetIds).toEqual(['ast_chat']);
    // Untouched top-level keys are left to the server merge, not resent.
    expect(patched.kind).toBeUndefined();
  });

  it('--json-value is passed through verbatim as the metadata patch', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_3',
      '--json-value', '{"git":{"branch":"feat/x","sha":"deadbeef"}}',
    ]);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    expect((cloud.calls[0].body as { metadata: unknown }).metadata).toEqual({
      git: { branch: 'feat/x', sha: 'deadbeef' },
    });
  });

  // ── negative control 1: nothing to write must not issue a request ───────
  it('NEGATIVE: neither --set nor --json-value → exit 1 and ZERO requests', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, ['task', 'meta', 'set', 'tsk_4']);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(0);
  });

  // ── negative control 2: the load-bearing edit-content gate ──────────────
  it('NEGATIVE: server 403 TASK_ACCESS_DENIED (assignee is not allowed) → exit 4', async () => {
    cloud.setRoute(() => ({
      status: 403,
      json: {
        ok: false,
        error: { code: 'TASK_ACCESS_DENIED', message: 'only the task creator can update task metadata' },
      },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, ['task', 'meta', 'set', 'tsk_5', '--set', 'a=1']);

    expect(r.exitCode).toBe(4);
    expect(cloud.calls).toHaveLength(1);
  });

  // ── negative control 3: a failed read must not be papered over with a
  //    blind nested PATCH (which would delete the sibling keys) ────────────
  it('NEGATIVE: GET fails on a nested --set → exit 1 and NO PATCH is sent', async () => {
    cloud.setRoute(({ method }) => {
      if (method === 'GET') {
        return { status: 404, json: { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'task not found' } } };
      }
      return { status: 200, json: { ok: true, data: {} } };
    });
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, ['task', 'meta', 'set', 'tsk_6', '--set', 'assets.x=1']);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('NEGATIVE: run_ id is rejected before any request', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, ['task', 'meta', 'set', 'run_abc', '--set', 'a=1']);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F5 — sha fidelity. `--set` infers JSON, and a git sha that happens to be all
// digits is therefore stored as a NUMBER: `sha=1234567` → 1234567, and a 40-char
// all-digit sha → 1.2345678901234568e+39 (the value is destroyed, not merely
// retyped). ~3.7% of 7-char short shas are all digits ((10/16)^7), and git-ops
// provenance is the load-bearing consumer of this verb.
//
// The oracle is the PARSED value + its `typeof` in the body the server actually
// received — not the CLI's own wording.
// ═══════════════════════════════════════════════════════════════════════════

describe('cloud task meta set — --set-string preserves shas verbatim (F5)', () => {
  const shas = {
    short: '1234567', // 7-char, all digits
    long: '1234567890123456789012345678901234567890', // 40-char, all digits
    hex: 'deadbeef',
    leadingZero: '0012345', // JSON.parse rejects this, but only by luck
  };

  it('--set-string keeps every sha shape a string, byte-for-byte', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_sha',
      '--set-string', `short=${shas.short}`,
      '--set-string', `long=${shas.long}`,
      '--set-string', `hex=${shas.hex}`,
      '--set-string', `zero=${shas.leadingZero}`,
      '--set-string', 'branch=2',
    ]);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    const md = (cloud.calls[0].body as { metadata: Record<string, unknown> }).metadata;
    expect(md).toEqual({
      short: shas.short,
      long: shas.long,
      hex: shas.hex,
      zero: shas.leadingZero,
      branch: '2',
    });
    for (const k of Object.keys(md)) expect(typeof md[k]).toBe('string');
    // Round-trip identity: what the server got IS what git would print.
    expect(md.long).toBe(shas.long);
    expect(String(md.long)).not.toContain('e+');
  });

  it('--set-string works through a nested (read-modify-write) path too', async () => {
    cloud.setRoute(({ method, path }) => {
      if (method === 'GET') {
        return {
          status: 200,
          json: { ok: true, data: { task: { id: 'tsk_n', metadata: { git: { branch: 'feat/x' } } }, logs: [] } },
        };
      }
      return okPatch({ method, path, body: undefined });
    });
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_n', '--set-string', `git.sha=${shas.short}`,
    ]);

    expect(r.exitCode).toBe(0);
    const md = (cloud.calls[1].body as { metadata: { git: Record<string, unknown> } }).metadata;
    expect(md.git.sha).toBe(shas.short);
    expect(typeof md.git.sha).toBe('string');
    // The sibling key the server's top-level-only merge would drop is still there.
    expect(md.git.branch).toBe('feat/x');
  });

  // NEGATIVE CONTROL 1: the corruption is REAL on the inferring surface. If this
  // ever goes green as a string, `--set` silently changed semantics and the
  // `--set-string` cases above stopped proving anything.
  it('negative control — plain --set still infers, which is exactly why --set-string exists', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_bad',
      '--set', `short=${shas.short}`,
      '--set', `long=${shas.long}`,
    ]);

    expect(r.exitCode).toBe(0);
    const md = (cloud.calls[0].body as { metadata: Record<string, unknown> }).metadata;
    expect(typeof md.short).toBe('number');
    expect(md.short).toBe(1234567);
    expect(typeof md.long).toBe('number');
    expect(md.long).not.toBe(shas.long); // precision is gone, not just the type
  });

  // NEGATIVE CONTROL 2: `--set-string` must not be a blanket "everything is a
  // string" switch that breaks the JSON surface. Both options in one invocation:
  // each keeps its own rule, and neither leaks into the other.
  it('negative control — --set and --set-string coexist, each keeping its own rule', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(registerTask, client, [
      'task', 'meta', 'set', 'tsk_mix',
      '--set', 'retries=2',
      '--set', 'blocked=false',
      '--set-string', 'sha=1234567',
    ]);

    expect(r.exitCode).toBe(0);
    const md = (cloud.calls[0].body as { metadata: Record<string, unknown> }).metadata;
    expect(md).toEqual({ retries: 2, blocked: false, sha: '1234567' });
    expect(typeof md.retries).toBe('number');
    expect(typeof md.sha).toBe('string');
  });

  it('negative control — --set-string alone still counts as "something to write"', async () => {
    cloud.setRoute(okPatch);
    const client = makeRealClient(cloud.baseUrl);
    const r = await runCli(registerTask, client, ['task', 'meta', 'set', 'tsk_only', '--set-string', 'sha=abc']);
    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Assignment parsing (pure) — the value/typing rules the CLI contract promises
// ═══════════════════════════════════════════════════════════════════════════

describe('parseMetaAssignments / applyMetaAssignment', () => {
  it('splits on the FIRST = and JSON-parses only when parseable', () => {
    const parsed = parseMetaAssignments(['a=1', 'b=hello', 'c={"k":1}', 'd=a=b']);
    expect(parsed).toEqual([
      { path: ['a'], value: 1 },
      { path: ['b'], value: 'hello' },
      { path: ['c'], value: { k: 1 } },
      { path: ['d'], value: 'a=b' },
    ]);
  });

  it('rejects malformed keys', () => {
    expect(() => parseMetaAssignments(['noequals'])).toThrow();
    expect(() => parseMetaAssignments(['=1'])).toThrow();
    expect(() => parseMetaAssignments(['a..b=1'])).toThrow();
  });

  it('json:false never infers — same inputs, all strings (F5)', () => {
    expect(parseMetaAssignments(['a=1', 'b=hello', 'c={"k":1}', 'd=a=b'], { json: false })).toEqual([
      { path: ['a'], value: '1' },
      { path: ['b'], value: 'hello' },
      { path: ['c'], value: '{"k":1}' },
      { path: ['d'], value: 'a=b' },
    ]);
    // …and it still rejects the same malformed keys (the guard is shared).
    expect(() => parseMetaAssignments(['noequals'], { json: false })).toThrow();
    expect(() => parseMetaAssignments(['a..b=1'], { json: false })).toThrow();
  });

  it('deep-sets without mutating the current metadata object it seeds from', () => {
    const current = { assets: { linkedAssetIds: ['old'], aggregatedAssetIds: ['chat'] } };
    const patch: Record<string, unknown> = {};
    applyMetaAssignment(patch, current, { path: ['assets', 'linkedAssetIds'], value: ['new'] });
    expect(patch).toEqual({ assets: { linkedAssetIds: ['new'], aggregatedAssetIds: ['chat'] } });
    expect(current.assets.linkedAssetIds).toEqual(['old']); // source untouched
  });

  it('creates intermediate objects for a 3-level path', () => {
    const patch: Record<string, unknown> = {};
    applyMetaAssignment(patch, {}, { path: ['a', 'b', 'c'], value: 7 });
    expect(patch).toEqual({ a: { b: { c: 7 } } });
  });
});
