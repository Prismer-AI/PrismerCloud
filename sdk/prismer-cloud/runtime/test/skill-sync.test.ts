import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncInstalledSkillsForDispatch } from '../src/daemon/skill-sync.js';
import type { AgentProfile } from '../src/adapters/contract.js';

// §A.7 — daemon's per-file sha then merkle(sorted "path:sha256" lines).
// For a legacy single-file content, manifest is implicit
//   [{ path: 'SKILL.md', sha256: sha256(utf8(content)) }]
// so merkle = sha256(`SKILL.md:${sha256(content)}`).
function legacyMerkle(content: string): string {
  const fileSha = sha256(content);
  return sha256(`SKILL.md:${fileSha}`);
}

const oldHermesHome = process.env.HERMES_HOME;
const oldOpenClawHome = process.env.OPENCLAW_HOME;
const cleanupDirs: string[] = [];

afterEach(async () => {
  process.env.HERMES_HOME = oldHermesHome;
  process.env.OPENCLAW_HOME = oldOpenClawHome;
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('syncInstalledSkillsForDispatch', () => {
  it('writes installed Hermes skills into the per-profile skills directory', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });
    const content = skillContent('prismer-task-lifecycle');
    const cloud = cloudWithSkills([{ slug: 'prismer-task-lifecycle', content }]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    // toMatchObject (not toEqual): the result also carries a `backfill` status
    // object whose shape depends on whether the mock cloud exposes `.request`
    // (covered by its own test below). This assertion only cares about the
    // sync counters + loadedSkills.
    expect(result).toMatchObject({
      synced: 1,
      skipped: 0,
      unchanged: 0,
      // release201/11 S23 — loadedSkills is the slug list dispatch.ts uses
      // to fan out skill.invoked metric emit. Synced + unchanged both count.
      loadedSkills: [{ slug: 'prismer-task-lifecycle', skillId: null }],
    });
    await expect(
      readFile(join(process.env.HERMES_HOME, 'profiles', 'ceo', 'skills', 'prismer-task-lifecycle', 'SKILL.md'), 'utf8'),
    ).resolves.toBe(content);
    expect(cloud.get).toHaveBeenCalledWith('/api/im/skills/installed?agentId=agent-1', { signal: undefined });
  });

  it('skips unchanged skills by content hash', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'researcher' });
    const content = skillContent('research');
    const target = join(process.env.HERMES_HOME, 'profiles', 'researcher', 'skills', 'research', 'SKILL.md');
    await writeFileWithParents(target, content);
    const cloud = cloudWithSkills([{ skill: { slug: 'research', content } }]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-2', cloud as any);

    expect(result).toMatchObject({
      synced: 0,
      skipped: 0,
      unchanged: 1,
      loadedSkills: [{ slug: 'research', skillId: null }],
    });
  });

  it('writes OpenClaw skills to the adapter skills directory', async () => {
    const root = await tempRoot();
    process.env.OPENCLAW_HOME = join(root, 'openclaw');
    const profile = profileFor('openclaw', { apiKey: 'key', baseUrl: 'http://127.0.0.1:9999' });
    const content = skillContent('memory-curation');
    const cloud = cloudWithSkills([{ slug: 'memory-curation', content }]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-3', cloud as any);

    expect(result.synced).toBe(1);
    await expect(
      readFile(join(process.env.OPENCLAW_HOME, 'profiles', 'agent-user', 'skills', 'memory-curation', 'SKILL.md'), 'utf8'),
    ).resolves.toBe(content);
  });

  it('acks synced skill revisions when cloud request is available', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });
    const content = skillContent('ackable');
    const request = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const cloud = cloudWithSkills([{ skill: { id: 'skill-1', slug: 'ackable', content } }], request);

    await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(request).toHaveBeenCalledWith('POST', '/api/im/agents/agent-1/skills/ack', {
      body: { skillId: 'skill-1', revision: legacyMerkle(content) },
      signal: undefined,
    });
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prismer-skill-sync-'));
  cleanupDirs.push(dir);
  return dir;
}

function profileFor(adapterName: string, config: Record<string, unknown>): AgentProfile {
  return {
    id: 'profile-12345678',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-1',
    agentUsername: 'agent-user',
    adapterName,
    name: 'Agent',
    config,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function cloudWithSkills(data: unknown[], request?: ReturnType<typeof vi.fn>) {
  return {
    get: vi.fn(async () => ({ ok: true, data })),
    ...(request ? { request } : {}),
  };
}

function skillContent(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n# ${name}\n`;
}

async function writeFileWithParents(path: string, content: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
