// B-P1a — tests for the metric-outbox replay worker (the first reader of
// metrics.jsonl).
//
// The writer side is `daemonMetricEmit`'s offline fallback; here we seed
// metrics.jsonl the way `appendAgentMetricOutbox` writes it (same entry shape,
// same path resolver) and drive the worker against a stubbed CloudClient so we
// can introspect the POSTed batch bodies.
//
// Mutation negative control (truncate vs rename-first): case D appends a line
// to the live outbox *while the cloud POST is in flight* and asserts that line
// survives the drain. It is red if the worker swaps the file by truncating it
// after the read (the line is wiped) and green with the shipped rename-first
// discipline (the append lands in a fresh live file, drained next tick).

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MetricOutboxReplayWorker,
  type MetricOutboxReplayOptions,
  type ReplayOutcome,
} from '../src/daemon/metric-outbox-replay.js';
import { appendAgentMetricOutbox } from '../src/daemon/agent-outbox.js';
import { resolveAgentDirPaths } from '../src/daemon/agent-dir.js';
import type { CloudClient, CloudResponse } from '../src/auth.js';
import type { ConfigPaths } from '../src/config.js';

const DAEMON_ID = 'did-replay';

function makeTmpPaths(): { paths: ConfigPaths; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'metric-replay-test-'));
  const paths: ConfigPaths = {
    root,
    configFile: join(root, 'config.toml'),
    localDb: join(root, 'local.db'),
    cacheDir: join(root, 'cache'),
    devicesDir: join(root, 'devices'),
    runsDir: join(root, 'runs'),
    workspacesDir: join(root, 'workspaces'),
    logsDir: join(root, 'logs'),
  };
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedOutbox(
  paths: ConfigPaths,
  agentImUserId: string,
  lines: string[],
): string {
  const dirs = resolveAgentDirPaths(paths, DAEMON_ID, agentImUserId);
  mkdirSync(dirs.artifactsDir, { recursive: true });
  writeFileSync(dirs.metricsOutboxFile, lines.map((l) => l + '\n').join(''), 'utf8');
  return dirs.metricsOutboxFile;
}

/** Write one outbox entry exactly like the production write side does. */
function appendMetric(
  paths: ConfigPaths,
  agentImUserId: string,
  eventType: string,
  value: number | string | null,
  dims: Record<string, string | number | boolean | null>,
): void {
  appendAgentMetricOutbox(paths, DAEMON_ID, agentImUserId, {
    eventType,
    workspaceId: typeof dims.workspaceId === 'string' ? dims.workspaceId : null,
    projectId: typeof dims.projectId === 'string' ? dims.projectId : null,
    taskId: typeof dims.taskId === 'string' ? dims.taskId : null,
    payload: { value, dims },
  });
}

interface RecordedCall {
  method: string;
  path: string;
  events: Array<Record<string, unknown>>;
}

/**
 * CloudClient stub. `onRequest` runs before the canned response is returned, so
 * tests can inject concurrent outbox appends at the exact ack moment.
 */
function stubCloud(
  responses: Array<Partial<CloudResponse<unknown>>>,
  onRequest?: (call: { method: string; path: string }) => void,
): { cloud: CloudClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const cloud = {
    async request(
      method: string,
      path: string,
      init?: { body?: unknown },
    ): Promise<CloudResponse<unknown>> {
      calls.push({
        method,
        path,
        events: ((init?.body as { events?: Array<Record<string, unknown>> })?.events ?? []) as Array<
          Record<string, unknown>
        >,
      });
      onRequest?.({ method, path });
      const res = responses[i++] ?? { ok: true, status: 207 };
      return { status: 207, ...res } as CloudResponse<unknown>;
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

function worker(
  cloud: CloudClient,
  paths: ConfigPaths,
  overrides: Partial<MetricOutboxReplayOptions> = {},
): { w: MetricOutboxReplayWorker; logs: string[] } {
  const logs: string[] = [];
  const w = new MetricOutboxReplayWorker({
    cloud,
    paths,
    daemonId: DAEMON_ID,
    ...overrides,
    log: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
      ...(overrides.log ?? {}),
    },
  });
  return { w, logs };
}

describe('MetricOutboxReplayWorker', () => {
  it('A: drains 3 metric.event lines past 1 bad-JSON + 1 foreign-kind line, then renames+deletes the file', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const file = seedOutbox(paths, 'agent-a', [
        JSON.stringify({ kind: 'not.a.metric', ts: 'x', payload: {} }),
        '{ this is not json',
        JSON.stringify({
          kind: 'metric.event',
          ts: '2026-01-02T03:04:05.000Z',
          eventType: 'turn.tokens_input',
          workspaceId: 'ws-1',
          projectId: null,
          taskId: 'task-1',
          payload: {
            value: 1200,
            dims: { workspaceId: 'ws-1', agentId: 'agent-a', taskId: 'task-1', model: 'glm-4.7' },
          },
        }),
        JSON.stringify({
          kind: 'metric.event',
          ts: '2026-01-02T03:04:06.000Z',
          eventType: 'turn.count',
          workspaceId: 'ws-1',
          projectId: null,
          taskId: 'task-1',
          payload: { value: 1, dims: { workspaceId: 'ws-1', agentId: 'agent-a', status: 'ok' } },
        }),
        JSON.stringify({
          kind: 'metric.event',
          ts: '2026-01-02T03:04:07.000Z',
          eventType: 'agent.dispatch',
          workspaceId: 'ws-2',
          projectId: null,
          taskId: null,
          payload: { value: null, dims: { workspaceId: 'ws-2', agentId: 'agent-a' } },
        }),
      ]);

      const { cloud, calls } = stubCloud([{ ok: true, status: 207, data: { ok: true, data: { accepted: 3, rejected: 0 } } }]);
      const { w } = worker(cloud, paths);
      const outcome = await w.replayOnce();

      // Exactly one batch POST to the same endpoint the online path uses.
      expect(calls.length).toBe(1);
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.path).toBe('/api/im/metrics/batch');
      // The two unusable lines are skipped, not POSTed.
      expect(calls[0]!.events.length).toBe(3);

      const [tokens, count, dispatch] = calls[0]!.events as Array<{
        namespace: string;
        name: string;
        value?: unknown;
        dims: Record<string, unknown>;
        ts?: string;
      }>;

      // eventType splits at the FIRST dot → namespace.name.
      expect(tokens.namespace).toBe('turn');
      expect(tokens.name).toBe('tokens_input');
      expect(tokens.value).toBe(1200);
      expect(tokens.ts).toBe('2026-01-02T03:04:05.000Z');
      expect(tokens.dims).toEqual({
        workspaceId: 'ws-1',
        agentId: 'agent-a',
        taskId: 'task-1',
        model: 'glm-4.7',
      });

      expect(count.namespace).toBe('turn');
      expect(count.name).toBe('count');
      expect(count.value).toBe(1);
      expect(count.dims.status).toBe('ok');

      // A null payload.value is dropped, mirroring the online path's
      // `value: ev.value ?? undefined`.
      expect(dispatch.namespace).toBe('agent');
      expect(dispatch.name).toBe('dispatch');
      expect('value' in dispatch).toBe(false);

      expect(outcome).toMatchObject({
        agents: 1,
        filesDrained: 1,
        filesRetained: 0,
        posted: 3,
        accepted: 3,
        rejected: 0,
        skippedLines: 2,
      });

      // rename-then-delete: neither the live file nor the frozen copy survives.
      expect(existsSync(file)).toBe(false);
      expect(existsSync(file + '.replayed')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('A2: an entry whose payload dims lost workspaceId is repaired from the entry mirror', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      seedOutbox(paths, 'agent-a', [
        JSON.stringify({
          kind: 'metric.event',
          ts: '2026-01-02T03:04:05.000Z',
          eventType: 'turn.duration_ms',
          workspaceId: 'ws-from-mirror',
          projectId: null,
          taskId: null,
          payload: { value: 900, dims: { agentId: 'agent-a' } },
        }),
      ]);
      const { cloud, calls } = stubCloud([]);
      const { w } = worker(cloud, paths);
      await w.replayOnce();
      const ev = calls[0]!.events[0] as { dims: Record<string, unknown> };
      expect(ev.dims.workspaceId).toBe('ws-from-mirror');
      expect(ev.dims.agentId).toBe('agent-a');
    } finally {
      cleanup();
    }
  });

  it('B: a failed POST retains the outbox; the next round replays and drains it', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const file = seedOutbox(paths, 'agent-b', []);
      appendMetric(paths, 'agent-b', 'turn.tool_calls', 2, { workspaceId: 'ws-1', agentId: 'agent-b' });

      const { cloud, calls } = stubCloud([
        { ok: false, status: 0, error: { code: 'cloud_unreachable', message: 'ECONNREFUSED' } },
        { ok: true, status: 207, data: { ok: true, data: { accepted: 1, rejected: 0 } } },
      ]);
      const logs: string[] = [];
      const { w } = worker(cloud, paths, {
        log: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      });

      const first = await w.replayOnce();
      expect(first.posted).toBe(0);
      expect(first.filesRetained).toBe(1);
      // Retained on disk — content survived the failed round (frozen copy).
      expect(readFileSync(file + '.replayed', 'utf8')).toContain('turn.tool_calls');

      const second = await w.replayOnce();
      expect(second.filesDrained).toBe(1);
      expect(second.posted).toBe(1);
      expect(calls.length).toBe(2);
      expect((calls[1]!.events[0] as { name: string }).name).toBe('tool_calls');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(file + '.replayed')).toBe(false);
      expect(logs.some((l) => l.includes('retaining'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('B2: a live file is not frozen over an unacked frozen copy (no clobber)', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const dirs = resolveAgentDirPaths(paths, DAEMON_ID, 'agent-b2');
      mkdirSync(dirs.artifactsDir, { recursive: true });
      writeFileSync(
        dirs.metricsOutboxFile + '.replayed',
        JSON.stringify({
          kind: 'metric.event',
          ts: 't',
          eventType: 'turn.count',
          workspaceId: 'ws-1',
          payload: { value: 1, dims: { workspaceId: 'ws-1' } },
        }) + '\n',
        'utf8',
      );
      writeFileSync(dirs.metricsOutboxFile, 'unparseable-but-new\n', 'utf8');

      // Both rounds fail → the frozen copy must still hold the ORIGINAL event,
      // never overwritten by a freeze of the live file.
      const { cloud } = stubCloud([
        { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: 'boom' } },
      ]);
      const { w } = worker(cloud, paths);
      await w.replayOnce();
      await w.replayOnce();

      const frozen = readFileSync(dirs.metricsOutboxFile + '.replayed', 'utf8');
      expect(frozen).toContain('turn.count');
      expect(frozen).not.toContain('unparseable-but-new');
      expect(existsSync(dirs.metricsOutboxFile)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('C: missing and empty outboxes are a silent no-op', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      // No device dir at all.
      const { cloud: cloud1, calls: calls1 } = stubCloud([]);
      const { w: w1 } = worker(cloud1, paths);
      const r1: ReplayOutcome = await w1.replayOnce();
      expect(calls1.length).toBe(0);
      expect(r1).toEqual({ agents: 0, filesDrained: 0, filesRetained: 0, posted: 0, accepted: 0, rejected: 0, skippedLines: 0 });

      // Agent dir present, outbox file empty.
      const file = seedOutbox(paths, 'agent-c', []);
      const { cloud: cloud2, calls: calls2 } = stubCloud([]);
      const { w: w2 } = worker(cloud2, paths);
      const r2 = await w2.replayOnce();
      expect(calls2.length).toBe(0);
      expect(r2.posted).toBe(0);
      expect(existsSync(file)).toBe(false);

      // An all-garbage file is dropped (counted), never POSTed, never retried forever.
      seedOutbox(paths, 'agent-c2', ['{oops', JSON.stringify({ kind: 'skill.ack', ts: 't', payload: {} })]);
      const { cloud: cloud3, calls: calls3 } = stubCloud([]);
      const { w: w3, logs } = worker(cloud3, paths);
      const r3 = await w3.replayOnce();
      expect(calls3.length).toBe(0);
      expect(r3.skippedLines).toBe(2);
      expect(existsSync(resolveAgentDirPaths(paths, DAEMON_ID, 'agent-c2').metricsOutboxFile)).toBe(false);
      expect(logs.some((l) => l.includes('non-replayable'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('C2: chunks large outboxes at ≤ batchSize events per POST', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const dirs = resolveAgentDirPaths(paths, DAEMON_ID, 'agent-chunk');
      mkdirSync(dirs.artifactsDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(
          JSON.stringify({
            kind: 'metric.event',
            ts: 't',
            eventType: 'turn.count',
            workspaceId: 'ws-1',
            payload: { value: i, dims: { workspaceId: 'ws-1' } },
          }),
        );
      }
      writeFileSync(dirs.metricsOutboxFile, lines.join('\n') + '\n', 'utf8');

      const { cloud, calls } = stubCloud([]);
      const { w } = worker(cloud, paths, { batchSize: 3 });
      const outcome = await w.replayOnce();
      expect(calls.map((c) => c.events.length)).toEqual([3, 3, 1]);
      expect(outcome.posted).toBe(7);
      expect(existsSync(dirs.metricsOutboxFile)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('D (mutation negative control): a line appended while the POST is in flight is NOT lost', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const file = seedOutbox(paths, 'agent-d', []);
      appendMetric(paths, 'agent-d', 'turn.count', 1, { workspaceId: 'ws-1', agentId: 'agent-d' });

      // The mock appends to the LIVE outbox path at ack time — the exact window
      // where an in-place truncate would destroy the line.
      let appended = false;
      const { cloud, calls } = stubCloud(
        [
          { ok: true, status: 207, data: { ok: true, data: { accepted: 1, rejected: 0 } } },
          { ok: true, status: 207, data: { ok: true, data: { accepted: 1, rejected: 0 } } },
        ],
        () => {
          if (appended) return;
          appended = true;
          appendMetric(paths, 'agent-d', 'turn.tool_calls', 4, {
            workspaceId: 'ws-1',
            agentId: 'agent-d',
          });
        },
      );
      const { w } = worker(cloud, paths);

      const first = await w.replayOnce();
      expect(first.posted).toBe(1); // only the pre-existing line went out this round

      // The concurrently appended line must still be on disk …
      expect(existsSync(file)).toBe(true);
      const live = readFileSync(file, 'utf8');
      expect(live).toContain('turn.tool_calls');
      expect(live).not.toContain('"turn.count"');
      // … and the next round drains it cloud-ward (nothing stuck on the floor).
      const second = await w.replayOnce();
      expect(second.posted).toBe(1);
      expect((calls[1]!.events[0] as { eventType?: string; name?: string }).name).toBe('tool_calls');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(file + '.replayed')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('E: start() drains on startup, stop() clears the timer, ticks stay single-flight', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      seedOutbox(paths, 'agent-e', [
        JSON.stringify({
          kind: 'metric.event',
          ts: 't',
          eventType: 'turn.count',
          workspaceId: 'ws-1',
          payload: { value: 1, dims: { workspaceId: 'ws-1' } },
        }),
      ]);
      const { cloud, calls } = stubCloud([]);
      const { w } = worker(cloud, paths, { intervalMs: 20 });

      w.start(); // fires the startup tick
      await w.replayOnce(); // must serialise behind the busy flag, not double-POST
      w.stop();
      w.stop(); // idempotent
      await new Promise((r) => setTimeout(r, 60)); // would fire ~3 interval ticks if not stopped

      expect(calls.length).toBe(1);
      expect(existsSync(resolveAgentDirPaths(paths, DAEMON_ID, 'agent-e').metricsOutboxFile)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('F: consecutive failed ticks retain the file and escalate warn → error after the limit', async () => {
    const { paths, cleanup } = makeTmpPaths();
    try {
      const file = seedOutbox(paths, 'agent-f', []);
      appendMetric(paths, 'agent-f', 'turn.count', 1, { workspaceId: 'ws-1', agentId: 'agent-f' });
      const responses = [1, 2, 3, 4, 5, 6].map(() => ({
        ok: false as const,
        status: 503,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'down' },
      }));
      const { cloud } = stubCloud(responses);
      const logs: string[] = [];
      const { w } = worker(cloud, paths, {
        maxConsecutiveFailures: 3,
        log: { info: () => {}, warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
      });
      for (let i = 0; i < 4; i++) await w.replayOnce();

      expect(existsSync(file + '.replayed')).toBe(true);
      // Escalation line: warn for failures 1..2 (limit 3), error afterwards.
      const escalations = logs.filter((l) => l.includes('metrics outbox flush failed'));
      expect(escalations.filter((l) => l.startsWith('warn ')).length).toBe(2);
      expect(escalations.filter((l) => l.startsWith('error ')).length).toBe(2);
      // Plus one per-tick "retaining <file>" line for all four failed rounds.
      expect(logs.filter((l) => l.includes('retaining')).length).toBe(4);
    } finally {
      cleanup();
    }
  });
});
