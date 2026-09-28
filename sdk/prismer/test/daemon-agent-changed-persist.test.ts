// SDK boundary wave2 B2 — daemon-side persistence of PATCH /agents/:id renames.
//
// `agent.changed` used to update only the in-memory hostedAgents entry; a
// rename inside the offline window (no profile-version bump → host.acked /
// syncProfileFromCloud never fire) was lost on restart, leaving
// declare/healthz/task-agentName on the stale name. This suite drives
// onAgentChanged against a REAL local.db (schema with the `agents` table via
// openLocalDb) and asserts the row converges.
//
// Usage: npx vitest run test/daemon-agent-changed-persist.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/daemon/runner.js';
import { openLocalDb, type LocalDb } from '../src/sync/store.js';

interface HostedAgent {
  imUserId: string;
  name: string;
  adapterName: string;
  capabilities: string[];
  profiles: Map<string, number>;
}

interface TestRunner {
  db: LocalDb;
  hostedAgents: Map<string, HostedAgent>;
  loadAgentsFromDb(): void;
  onAgentChanged(p: { agentImUserId: string; fields: Record<string, unknown> }): void;
}

let roots: string[] = [];

function makeRunner(): TestRunner {
  const root = mkdtempSync(join(tmpdir(), 'agent-changed-'));
  roots.push(root);
  const r = new Runner() as unknown as TestRunner;
  r.db = openLocalDb(join(root, 'local.db'));
  return r;
}

function seedAgent(r: TestRunner, imUserId: string, name: string): void {
  r.db
    .prepare(
      `INSERT INTO agents
       (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
       VALUES (?, 'ws-1', ?, 'hermes', '[]', 'offline', 1, 0, 0)`,
    )
    .run(imUserId, name);
  r.hostedAgents.set(imUserId, {
    imUserId,
    name,
    adapterName: 'hermes',
    capabilities: [],
    profiles: new Map(),
  });
}

function row(r: TestRunner, imUserId: string): { name: string; dirty: number } | undefined {
  return r.db
    .prepare('SELECT name, dirty FROM agents WHERE im_user_id = ?')
    .get(imUserId) as { name: string; dirty: number } | undefined;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('B2 — agent.changed rename persistence (offline-window convergence)', () => {
  it('persists the new displayName into the local agents row and the memory map', () => {
    const r = makeRunner();
    seedAgent(r, 'im-1', 'Old Name');

    r.onAgentChanged({ agentImUserId: 'im-1', fields: { displayName: 'New Name' } });

    const dbRow = row(r, 'im-1');
    expect(dbRow?.name).toBe('New Name');
    expect(dbRow?.dirty).toBe(0);
    expect(r.hostedAgents.get('im-1')?.name).toBe('New Name');
  });

  it('reboot convergence — loadAgentsFromDb picks up the persisted name', () => {
    const r = makeRunner();
    seedAgent(r, 'im-1', 'Old Name');

    r.onAgentChanged({ agentImUserId: 'im-1', fields: { displayName: 'Renamed While Offline' } });
    r.hostedAgents.clear(); // simulate daemon restart
    r.loadAgentsFromDb();

    expect(r.hostedAgents.get('im-1')?.name).toBe('Renamed While Offline');
  });

  it('ignores an event that only carries capabilities (row untouched)', () => {
    const r = makeRunner();
    seedAgent(r, 'im-1', 'Old Name');

    r.onAgentChanged({ agentImUserId: 'im-1', fields: { capabilities: ['a', 'b'] } });

    expect(row(r, 'im-1')?.name).toBe('Old Name');
  });

  it('is a no-op for an agent not in the local account (no row, no crash)', () => {
    const r = makeRunner();

    r.onAgentChanged({ agentImUserId: 'im-unknown', fields: { displayName: 'Ghost' } });

    expect(row(r, 'im-unknown')).toBeUndefined();
  });
});
