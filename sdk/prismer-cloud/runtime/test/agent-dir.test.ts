// release201/09 Phase 3 — agent-dir + device-dir + skill-sync per-agent unit tests.
//
// Coverage:
//   1. ensureAgentDir creates expected dir skeleton
//   2. writeAgentProfileSnapshot lays profile.json
//   3. writeDeviceJson populates devices/<did>/device.json
//   4. resolveSkillsRoot returns devices/<did>/agents/<aid>/skills when ctx given
//   5. resolveSkillsRoot respects profile.config.skillsDir override (deprecated)
//   6. Two agents on same daemon get distinct skill dirs (the latent-bug fix)

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../src/config.js';
import {
  ensureAgentDir,
  resolveAgentDirPaths,
  writeAgentProfileSnapshot,
} from '../src/daemon/agent-dir.js';
import { writeDeviceJson } from '../src/daemon/device-dir.js';
import { resolveSkillsRoot } from '../src/daemon/skill-sync.js';
import type { AgentProfile } from '../src/adapters/contract.js';

function makeProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-1',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-1',
    adapterName: 'hermes',
    name: 'CEO',
    config: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('release201/09 §9.1 — agent-dir', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it('ensureAgentDir creates devices/<did>/agents/<aid>/{skills,memory,artifacts}', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-agdir-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const dirs = ensureAgentDir(paths, 'daemon-x', 'agent-y');
    expect(dirs.root).toBe(join(home, 'devices', 'daemon-x', 'agents', 'agent-y'));
    expect(existsSync(dirs.skillsDir)).toBe(true);
    expect(existsSync(dirs.memoryDir)).toBe(true);
    expect(existsSync(dirs.artifactsDir)).toBe(true);
    expect(dirs.artifactsDir).toBe(join(home, 'devices', 'daemon-x', 'agents', 'agent-y', 'artifacts'));
    // append-only JSONL files NOT pre-created; consumers append on demand.
    expect(existsSync(dirs.syncOutboxFile)).toBe(false);
    expect(existsSync(dirs.metricsOutboxFile)).toBe(false);
  });

  it('writeAgentProfileSnapshot writes profile.json with snapshotAt', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-agdir-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    writeAgentProfileSnapshot(paths, 'daemon-x', {
      agentId: 'p-1',
      agentImUserId: 'agent-y',
      workspaceId: 'ws-1',
      adapterName: 'hermes',
      name: 'COO',
      config: { systemPrompt: 'You are COO', roleTemplate: { slug: 'coo' } },
      snapshotAt: '2026-05-26T00:00:00.000Z',
    });
    const file = join(home, 'devices', 'daemon-x', 'agents', 'agent-y', 'profile.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.agentImUserId).toBe('agent-y');
    expect(parsed.name).toBe('COO');
    expect(parsed.config.roleTemplate.slug).toBe('coo');
    expect(parsed.snapshotAt).toBe('2026-05-26T00:00:00.000Z');
  });

  it('writeDeviceJson populates devices/<did>/device.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-devdir-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const { dir, json } = writeDeviceJson(paths, 'daemon-zz', { kind: 'local' });
    expect(dir).toBe(join(home, 'devices', 'daemon-zz'));
    expect(json.daemonId).toBe('daemon-zz');
    expect(json.kind).toBe('local');
    expect(json.hostname.length).toBeGreaterThan(0);
    const onDisk = JSON.parse(readFileSync(join(dir, 'device.json'), 'utf8'));
    expect(onDisk.daemonId).toBe('daemon-zz');
    expect(onDisk.kind).toBe('local');
  });

  it('resolveAgentDirPaths returns consistent shape without creating dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-resolve-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const dirs = resolveAgentDirPaths(paths, 'd1', 'a1');
    // resolveAgentDirPaths is a pure path composer — no mkdir.
    expect(existsSync(dirs.root)).toBe(false);
    expect(dirs.skillsDir).toBe(join(home, 'devices', 'd1', 'agents', 'a1', 'skills'));
    expect(dirs.metricsOutboxFile).toBe(
      join(home, 'devices', 'd1', 'agents', 'a1', 'artifacts', 'metrics.jsonl'),
    );
    expect(dirs.transferManifestFile).toBe(
      join(home, 'devices', 'd1', 'agents', 'a1', 'transfer-manifest.json'),
    );
  });
});

describe('release201/09 §9.3.2 — resolveSkillsRoot per-agent', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it('returns devices/<did>/agents/<aid>/skills/ when ctx has paths+daemonId', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-skroot-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const profile = makeProfile({ adapterName: 'hermes' });
    const root = resolveSkillsRoot(profile, 'agent-7', {
      paths,
      daemonId: 'daemon-7',
    });
    expect(root).toBe(join(home, 'devices', 'daemon-7', 'agents', 'agent-7', 'skills'));
  });

  it('respects profile.config.skillsDir override (deprecated but accepted)', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-skroot-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const profile = makeProfile({
      adapterName: 'hermes',
      config: { skillsDir: '/custom/skills/path' },
    });
    const root = resolveSkillsRoot(profile, 'agent-7', { paths, daemonId: 'daemon-7' });
    expect(root).toBe('/custom/skills/path');
  });

  it('falls back to legacy path when no ctx (tests / container without paths)', () => {
    const profile = makeProfile({ adapterName: 'hermes' });
    const root = resolveSkillsRoot(profile);
    expect(root).not.toBeNull();
    // Legacy hermes path includes 'skills' suffix.
    expect(root!.endsWith('skills')).toBe(true);
  });

  it('returns null for adapters that do not consume skill files', () => {
    const profile = makeProfile({ adapterName: 'codex' });
    const root = resolveSkillsRoot(profile, 'agent-1', { paths: resolvePaths(), daemonId: 'd1' });
    expect(root).toBeNull();
  });

  it('two agents on same daemon get distinct skill dirs (latent-bug fix)', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-multi-agent-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    const a = resolveSkillsRoot(makeProfile({ id: 'p-a', agentImUserId: 'agent-A' }), 'agent-A', {
      paths,
      daemonId: 'same-daemon',
    });
    const b = resolveSkillsRoot(makeProfile({ id: 'p-b', agentImUserId: 'agent-B' }), 'agent-B', {
      paths,
      daemonId: 'same-daemon',
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a!.endsWith('agents/agent-A/skills')).toBe(true);
    expect(b!.endsWith('agents/agent-B/skills')).toBe(true);
  });
});

describe('release201/09 §9.1 — agent-outbox JSONL', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it('appendAgentMetricOutbox creates metrics.jsonl and append-only writes', async () => {
    // dynamic import to avoid circular fan-out at file top-level
    const { appendAgentMetricOutbox, appendAgentSyncOutbox } = await import(
      '../src/daemon/agent-outbox.js'
    );
    const home = mkdtempSync(join(tmpdir(), 'prismer-outbox-'));
    cleanup.push(home);
    const paths = resolvePaths(home);
    appendAgentMetricOutbox(paths, 'd1', 'a1', {
      eventType: 'task.dispatched',
      workspaceId: 'ws-1',
      projectId: null,
      taskId: 't-1',
      payload: { durationMs: 1234 },
    });
    appendAgentMetricOutbox(paths, 'd1', 'a1', {
      eventType: 'task.completed',
      workspaceId: 'ws-1',
      projectId: null,
      taskId: 't-1',
      payload: { tokensUsed: 500 },
    });
    appendAgentSyncOutbox(paths, 'd1', 'a1', {
      kind: 'memory.write',
      payload: { pageId: 'pg-1' },
    });

    const outboxRoot = join(home, 'devices', 'd1', 'agents', 'a1', 'artifacts');
    expect(readdirSync(outboxRoot).sort()).toEqual(['metrics.jsonl', 'sync.jsonl']);
    const metricsLines = readFileSync(join(outboxRoot, 'metrics.jsonl'), 'utf8').trim().split('\n');
    expect(metricsLines.length).toBe(2);
    expect(JSON.parse(metricsLines[0]!).eventType).toBe('task.dispatched');
    expect(JSON.parse(metricsLines[1]!).eventType).toBe('task.completed');
    const syncLines = readFileSync(join(outboxRoot, 'sync.jsonl'), 'utf8').trim().split('\n');
    expect(syncLines.length).toBe(1);
    expect(JSON.parse(syncLines[0]!).kind).toBe('memory.write');
  });
});
