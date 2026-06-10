// release201/11 §4 — S23 unit tests for daemon-side metric emit helper.
//
// Covers the three new emit paths added in S23:
//   - agent.dispatch       (single event, value=duration_ms)
//   - skill.invoked        (one event per loaded skill)
//   - outbox fallback      (cloud unreachable → metrics.jsonl)
//
// Does NOT exercise the full handleDispatch loop — those tests live in
// dispatch.test.ts. Here we drive the helper directly with a stubbed
// CloudClient so we can introspect the request body.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonMetricEmit } from '../src/daemon/metric-emit.js';
import type { CloudClient } from '../src/auth.js';
import type { ConfigPaths } from '../src/config.js';
import { resolveAgentDirPaths } from '../src/daemon/agent-dir.js';

function stubCloud(responses: Array<{ ok: boolean; status?: number; error?: { code: string; message: string } }>): {
  cloud: CloudClient;
  calls: Array<{ method: string; path: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let i = 0;
  const cloud = {
    async request(method: string, path: string, init?: { body?: unknown }) {
      calls.push({ method, path, body: init?.body });
      return responses[i++] ?? { ok: true, status: 200 };
    },
  } as unknown as CloudClient;
  return { cloud, calls };
}

function makeTmpPaths(): { paths: ConfigPaths; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'metric-emit-test-'));
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

describe('daemonMetricEmit — agent.dispatch + skill.invoked (S23)', () => {
  it('posts to /api/im/metrics/batch with normalised events', async () => {
    const { cloud, calls } = stubCloud([{ ok: true, status: 207 }]);
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 4321,
          dims: {
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            taskId: 'task-1',
            projectId: 'proj-1',
            capability: 'general',
          },
        },
        {
          namespace: 'skill',
          name: 'invoked',
          value: 1,
          dims: {
            workspaceId: 'ws-1',
            agentId: 'agent-1',
            skillId: 'sk-engineering',
            taskId: 'task-1',
          },
        },
      ],
      { cloud, agentImUserId: 'agent-1' },
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/api/im/metrics/batch');
    const body = calls[0]!.body as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(2);
    const ev0 = body.events[0] as { namespace: string; name: string; value: number; dims: Record<string, unknown> };
    expect(ev0.namespace).toBe('agent');
    expect(ev0.name).toBe('dispatch');
    expect(ev0.value).toBe(4321);
    expect(ev0.dims.workspaceId).toBe('ws-1');
    expect(ev0.dims.taskId).toBe('task-1');
    const ev1 = body.events[1] as { namespace: string; name: string; value: number; dims: Record<string, unknown> };
    expect(ev1.namespace).toBe('skill');
    expect(ev1.name).toBe('invoked');
    expect(ev1.dims.skillId).toBe('sk-engineering');
  });

  it('drops undefined dim values without breaking the envelope', async () => {
    const { cloud, calls } = stubCloud([{ ok: true }]);
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 100,
          dims: {
            workspaceId: 'ws-2',
            agentId: 'a',
            taskId: 't',
            projectId: undefined,
            capability: undefined,
          },
        },
      ],
      { cloud, agentImUserId: 'a' },
    );
    const body = calls[0]!.body as { events: Array<{ dims: Record<string, unknown> }> };
    expect('projectId' in body.events[0]!.dims).toBe(false);
    expect('capability' in body.events[0]!.dims).toBe(false);
    expect(body.events[0]!.dims.workspaceId).toBe('ws-2');
  });

  it('is a no-op on empty events without hitting cloud', async () => {
    const { cloud, calls } = stubCloud([]);
    await daemonMetricEmit([], { cloud, agentImUserId: 'a' });
    expect(calls.length).toBe(0);
  });

  it('falls back to per-agent outbox when cloud returns non-ok', async () => {
    const { cloud } = stubCloud([
      { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: 'boom' } },
    ]);
    const { paths, cleanup } = makeTmpPaths();
    try {
      await daemonMetricEmit(
        [
          {
            namespace: 'agent',
            name: 'dispatch',
            value: 99,
            dims: { workspaceId: 'ws-3', agentId: 'a', taskId: 't' },
          },
        ],
        { cloud, paths, daemonId: 'did-1', agentImUserId: 'a' },
      );
      const dirs = resolveAgentDirPaths(paths, 'did-1', 'a');
      expect(existsSync(dirs.metricsOutboxFile)).toBe(true);
      const lines = readFileSync(dirs.metricsOutboxFile, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const entry = JSON.parse(lines[0]!) as {
        kind: string;
        eventType: string;
        workspaceId: string;
        taskId: string;
        payload: { value: unknown };
      };
      expect(entry.kind).toBe('metric.event');
      expect(entry.eventType).toBe('agent.dispatch');
      expect(entry.workspaceId).toBe('ws-3');
      expect(entry.taskId).toBe('t');
      expect(entry.payload.value).toBe(99);
    } finally {
      cleanup();
    }
  });

  it('also writes to outbox when cloud throws (network error)', async () => {
    const cloud = {
      async request() {
        throw new Error('ECONNREFUSED');
      },
    } as unknown as CloudClient;
    const { paths, cleanup } = makeTmpPaths();
    try {
      await daemonMetricEmit(
        [
          {
            namespace: 'skill',
            name: 'invoked',
            value: 1,
            dims: { workspaceId: 'w', agentId: 'a', skillId: 's', taskId: 't' },
          },
        ],
        { cloud, paths, daemonId: 'did-2', agentImUserId: 'a' },
      );
      const dirs = resolveAgentDirPaths(paths, 'did-2', 'a');
      expect(existsSync(dirs.metricsOutboxFile)).toBe(true);
      const entry = JSON.parse(
        readFileSync(dirs.metricsOutboxFile, 'utf8').trim().split('\n')[0]!,
      ) as { eventType: string };
      expect(entry.eventType).toBe('skill.invoked');
    } finally {
      cleanup();
    }
  });

  it('silently drops to floor when outbox ctx is missing and cloud fails', async () => {
    const cloud = {
      async request() {
        throw new Error('offline');
      },
    } as unknown as CloudClient;
    // No paths / daemonId / agentImUserId — helper has nowhere to fall back to,
    // but must NOT throw or reject.
    await expect(
      daemonMetricEmit(
        [
          {
            namespace: 'agent',
            name: 'dispatch',
            value: 1,
            dims: { workspaceId: 'w', agentId: 'a', taskId: 't' },
          },
        ],
        { cloud },
      ),
    ).resolves.toBeUndefined();
  });

  it('serialises Date ts into ISO string', async () => {
    const { cloud, calls } = stubCloud([{ ok: true }]);
    const at = new Date('2026-01-01T00:00:00Z');
    await daemonMetricEmit(
      [
        {
          namespace: 'agent',
          name: 'dispatch',
          value: 1,
          dims: { workspaceId: 'w', agentId: 'a', taskId: 't' },
          ts: at,
        },
      ],
      { cloud },
    );
    const body = calls[0]!.body as { events: Array<{ ts?: string }> };
    expect(body.events[0]!.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});
