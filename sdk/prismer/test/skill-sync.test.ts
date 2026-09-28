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
const cleanupDirs: string[] = [];

afterEach(async () => {
  process.env.HERMES_HOME = oldHermesHome;
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
    // An unsealed legacy directory is refreshed once before it can be trusted.
    expect(await syncInstalledSkillsForDispatch(profile, 'agent-2', cloud as any)).toMatchObject({ synced: 1 });
    const result = await syncInstalledSkillsForDispatch(profile, 'agent-2', cloud as any);

    expect(result).toMatchObject({
      synced: 0,
      skipped: 0,
      unchanged: 1,
      loadedSkills: [{ slug: 'research', skillId: null }],
    });
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

  it('installs a folded canonical slug but acks the preserved historical alias id', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });
    const content = skillContent('remotion');
    const request = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const cloud = cloudWithSkills(
      [{ skill: { id: 'skill-remotion-create', slug: 'remotion', content } }],
      request,
    );

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(result.loadedSkills).toEqual([{ slug: 'remotion', skillId: 'skill-remotion-create' }]);
    await expect(
      readFile(join(process.env.HERMES_HOME, 'profiles', 'ceo', 'skills', 'remotion', 'SKILL.md'), 'utf8'),
    ).resolves.toBe(content);
    expect(request).toHaveBeenCalledWith('POST', '/api/im/agents/agent-1/skills/ack', {
      body: { skillId: 'skill-remotion-create', revision: legacyMerkle(content) },
      signal: undefined,
    });
  });

  it('backfills PKF authoring skills for an older Hermes agent that already has the legacy baseline', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'legacy-manager' });
    const legacy = ['tasks', 'office-artifacts'].map((slug) => ({ slug, content: skillContent(slug) }));
    const repaired = [
      ...legacy,
      { slug: 'pkf-writing', content: skillContent('pkf-writing') },
      { slug: 'pkf-svg', content: skillContent('pkf-svg') },
    ];
    const get = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: legacy })
      .mockResolvedValueOnce({ ok: true, data: repaired });
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, data: { installed: 2 } },
    }));

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-legacy', { get, request } as any);

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/im/agents/agent-legacy/skills/install-builtins',
      { body: {}, signal: undefined },
    );
    expect(result.backfill).toMatchObject({ attempted: true, ok: true, installed: 2 });
    await expect(
      readFile(join(process.env.HERMES_HOME, 'profiles', 'legacy-manager', 'skills', 'pkf-writing', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: pkf-writing');
    await expect(
      readFile(join(process.env.HERMES_HOME, 'profiles', 'legacy-manager', 'skills', 'pkf-svg', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: pkf-svg');
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
