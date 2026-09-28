import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { syncInstalledSkillsForDispatch, withPerAgentSkillsDir } from '../src/daemon/skill-sync.js';
import { HermesSkillLoader } from '../src/adapters/persistence/hermes/skill-loader.js';
import { getHermesProfileDir, getHermesProfileName } from '../src/adapters/persistence/hermes/index.js';
import { projectHermesSkillRoot } from '../src/adapters/persistence/hermes/native-skill-projection.js';
import { resolvePaths } from '../src/config.js';
import type { AgentProfile } from '../src/adapters/contract.js';
import { handleDispatch } from '../src/daemon/dispatch.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(override = false) {
  const root = await mkdtemp(join(tmpdir(), 'skill-rejection-'));
  roots.push(root);
  vi.stubEnv('HERMES_HOME', join(root, 'hermes'));
  const ctx = { paths: resolvePaths(join(root, 'runtime')), daemonId: 'device' };
  const profile = withPerAgentSkillsDir({ id: 'fixture', agentImUserId: 'agent', adapterName: 'hermes',
    config: override ? { skillsDir: join(root, 'user-skills') } : {} } as AgentProfile, ctx.paths, ctx.daemonId);
  const source = profile.config.skillsDir as string;
  const native = join(getHermesProfileDir(getHermesProfileName(profile)), 'skills');
  const content = '---\nname: rejection-fixture\ndescription: trusted\n---\nTRUSTED';
  let entries: unknown[] = [{ slug: 'rejection-fixture', content }];
  const cloud = { get: vi.fn(async () => entries), request: async () => ({ ok: true, status: 200, data: { ok: true, data: { installed: 0 } } }) };
  const sync = () => syncInstalledSkillsForDispatch(profile, 'agent', cloud as any, undefined, ctx);
  await sync();
  projectHermesSkillRoot(source, native);
  const loader = new HermesSkillLoader(source, join(root, 'config.yaml'), []);
  return { root, source, native, loader, sync, cloud, profile, ctx, setEntries: (value: unknown[]) => { entries = value; } };
}
async function absent(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.loader.listCommands()).not.toContainEqual(expect.objectContaining({ name: 'rejection-fixture' }));
  expect(await f.loader.expandSlashInvocation('/rejection-fixture')).toBeNull();
  expect((await f.loader.loadSystemPromptFragment()) ?? '').not.toContain('rejection-fixture');
  await expect(lstat(join(f.native, 'rejection-fixture'))).rejects.toMatchObject({ code: 'ENOENT' });
}
it('quarantines a rejected modified install before slash, prompt and native can reload it', async () => {
  const f = await fixture(true);
  await writeFile(join(f.source, 'rejection-fixture', 'SKILL.md'), '---\nname: rejection-fixture\n---\nTAMPERED');
  f.setEntries([{ skill: { slug: 'rejection-fixture', contentManifest: JSON.stringify([{ path: 'SKILL.md', size: 3, sha256: '0'.repeat(64), content: 'YmFk' }]) } }]);
  const result = await f.sync();
  expect(result.resolutions?.[0].ok).toBe(false);
  await absent(f);
  expect(result.pruned).toBe(1);
  const rejected = (result as any).quarantined[0];
  expect(await readFile(join(rejected.path, 'SKILL.md'), 'utf8')).toContain('TAMPERED');
});
it('prunes a revoked Runtime-pinned install and its native projection, retaining unowned directories', async () => {
  const f = await fixture();
  await mkdir(join(f.source, 'user-local'));
  await writeFile(join(f.source, 'user-local', 'SKILL.md'), 'USER BYTES');
  f.setEntries([]);
  expect((await f.sync()).pruned).toBe(1);
  await absent(f);
  expect(await readFile(join(f.source, 'user-local', 'SKILL.md'), 'utf8')).toBe('USER BYTES');
});
it('does not prune a real user override on grant removal', async () => {
  const f = await fixture(true);
  f.setEntries([]);
  expect((await f.sync()).pruned).toBe(0);
  expect(await f.loader.listCommands()).toContainEqual(expect.objectContaining({ name: 'rejection-fixture' }));
  expect(await readFile(join(f.native, 'rejection-fixture', 'SKILL.md'), 'utf8')).toContain('TRUSTED');
});
it('retains modified revoked skill bytes in quarantine rather than deleting user edits', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'rejection-fixture', 'notes.txt'), 'USER NOTES');
  f.setEntries([]);
  const result = await f.sync();
  await absent(f);
  expect(await readFile(join(result.quarantined![0]!.path, 'notes.txt'), 'utf8')).toBe('USER NOTES');
});
it('does not let catalog transport failure bypass local receipt validation', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'rejection-fixture', 'SKILL.md'), 'TAMPERED');
  f.cloud.get.mockRejectedValue(new Error('offline fixture'));
  const result = await f.sync();
  expect(result.pruned).toBe(1);
  await absent(f);
});
it('retains verified LKG without treating a catalog outage as a grant revocation', async () => {
  const f = await fixture();
  f.cloud.get.mockRejectedValue(new Error('offline fixture'));
  const result = await f.sync();
  expect(result.pruned).toBe(0);
  expect(result.resolutions?.[0]?.source).toBe('lkg');
  expect(await f.loader.listCommands()).toContainEqual(expect.objectContaining({ name: 'rejection-fixture' }));
});
it('isolates or hard-fails revoked read-only contents, never reporting successful stale delivery', async () => {
  const f = await fixture();
  const target = join(f.source, 'rejection-fixture');
  await chmod(target, 0o555);
  f.setEntries([]);
  try {
    const outcome = await f.sync().then(result => ({ result }), error => ({ error }));
    if ('error' in outcome) expect(outcome.error).toMatchObject({ name: 'SkillSyncSafetyError' });
    else {
      await absent(f);
      expect(outcome.result.pruned).toBe(1);
      for (const entry of outcome.result.quarantined ?? []) await chmod(entry.path, 0o755);
    }
  } finally {
    await chmod(target, 0o755).catch(() => {});
  }
});
it('aborts the actual dispatch before service creation when revocation cannot be isolated', async () => {
  const f = await fixture();
  // Root-proof fault injection (CI check jobs run as uid 0, where chmod 0o555
  // no longer blocks removal). The quarantine root is a SIBLING of the skills
  // dir; a plain file parked there makes mkdir/rename fail with EEXIST/ENOTDIR
  // for every uid — the same production path a real EPERM would take.
  const quarantineBlocker = join(dirname(f.source), '.prismer-skill-quarantine');
  await writeFile(quarantineBlocker, 'not a directory');
  const ensureService = vi.fn();
  const send = vi.fn();
  let reachedSkills = false;
  const cloud = { ...f.cloud, get: async (path: string) => {
    if (path.includes('/agent_profiles/')) return f.profile;
    if (path.includes('/skills/installed')) { reachedSkills = true; return []; }
    return {};
  } };
  try {
    await handleDispatch({ taskId: 'fixture-task', agentImUserId: 'agent', profileId: 'fixture',
      capability: 'code', prompt: 'must not dispatch revoked skill' }, 'fixture-request', {
      ...f.ctx, cloud, registry: { get: () => ({ name: 'hermes', kind: 'long-running', capabilities: [],
        validate: () => ({ ok: true }), health: async () => ({ available: true }) }) },
      uriResolver: { rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }) },
      assetCache: { unpin: vi.fn() }, ws: { send }, ensureService,
    } as any);
    expect(reachedSkills).toBe(true);
    expect(ensureService).not.toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls)).toContain('Cannot safely remove revoked skills');
  } finally { await rm(quarantineBlocker, { force: true }); }
});
it('raises a hard safety failure when source permissions prevent isolation', async () => {
  const f = await fixture();
  // Same root-proof injection as above: quarantine root occupied by a file.
  const quarantineBlocker = join(dirname(f.source), '.prismer-skill-quarantine');
  await writeFile(quarantineBlocker, 'not a directory');
  f.setEntries([]);
  try {
    await expect(f.sync()).rejects.toMatchObject({ name: 'SkillSyncSafetyError' });
  } finally { await rm(quarantineBlocker, { force: true }); }
});
