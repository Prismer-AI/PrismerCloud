/**
 * §A.7 Phase 1 — Multi-file Manifest sync regression suite.
 *
 * Covers the new contentManifest path: inline base64, S3 url fetch,
 * sha256 verification, path-traversal defense, orphan cleanup, incremental
 * skip-on-match, and forward/backward wire compat with legacy `content`.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncInstalledSkillsForDispatch,
  computeMerkle,
  isSafeRelativePath,
} from '../src/daemon/skill-sync.js';
import type { AgentProfile } from '../src/adapters/contract.js';

const oldHermesHome = process.env.HERMES_HOME;
const cleanupDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  process.env.HERMES_HOME = oldHermesHome;
  globalThis.fetch = originalFetch;
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('syncInstalledSkillsForDispatch — multi-file manifest', () => {
  it('writes every file from inline base64 manifest into the skill dir', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const files = [
      fileSpec('SKILL.md', '---\nname: multi-smoke\n---\n\n# multi-smoke\n'),
      fileSpec('scripts/hello.sh', '#!/bin/sh\necho hi\n'),
      fileSpec('references/notes.md', '# notes\n\nrefs here\n'),
    ];
    const manifest = JSON.stringify(files);
    const cloud = cloudWithSkills([
      {
        skill: {
          id: 'skill-multi-1',
          slug: 'multi-smoke',
          contentManifest: manifest,
          contentManifestRevision: computeMerkle(files),
        },
      },
    ]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(result.synced).toBe(1);
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'multi-smoke');
    await expect(readFile(join(base, 'SKILL.md'), 'utf8')).resolves.toBe(
      '---\nname: multi-smoke\n---\n\n# multi-smoke\n',
    );
    await expect(readFile(join(base, 'scripts', 'hello.sh'), 'utf8')).resolves.toBe(
      '#!/bin/sh\necho hi\n',
    );
    await expect(readFile(join(base, 'references', 'notes.md'), 'utf8')).resolves.toBe(
      '# notes\n\nrefs here\n',
    );
  });

  it('acks the merkle revision computed from the manifest', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const files = [
      fileSpec('SKILL.md', '# a\n'),
      fileSpec('scripts/x.py', 'print(1)\n'),
    ];
    const manifest = JSON.stringify(files);
    const merkle = computeMerkle(files);

    const request = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } }));
    const cloud = cloudWithSkills(
      [{ skill: { id: 's1', slug: 'ack-test', contentManifest: manifest, contentManifestRevision: merkle } }],
      request,
    );

    await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(request).toHaveBeenCalledWith('POST', '/api/im/agents/agent-1/skills/ack', {
      body: { skillId: 's1', revision: merkle },
      signal: undefined,
    });
  });

  it('skips files whose sha256 does not match the manifest', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    // Build manifest, then tamper one file's sha so it cannot verify.
    const f1 = fileSpec('SKILL.md', '# real\n');
    const f2: any = { ...fileSpec('scripts/evil.sh', '#!/bin/sh\necho hi\n') };
    f2.sha256 = 'deadbeef'.repeat(8); // 64 hex chars but wrong
    const cloud = cloudWithSkills([
      { skill: { id: 's1', slug: 'mismatch', contentManifest: JSON.stringify([f1, f2]) } },
    ]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    // Mismatch counts as skipped (per-file failure -> entry not acked OK).
    expect(result.skipped).toBe(1);
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'mismatch');
    await expect(readFile(join(base, 'SKILL.md'), 'utf8')).resolves.toBe('# real\n');
    // The bad file must NOT have been written
    await expect(stat(join(base, 'scripts', 'evil.sh'))).rejects.toThrow();
  });

  it('rejects path-traversal entries (.. /, absolute, drive letter)', async () => {
    expect(isSafeRelativePath('SKILL.md')).toBe(true);
    expect(isSafeRelativePath('scripts/foo.py')).toBe(true);
    expect(isSafeRelativePath('a/b/c.txt')).toBe(true);
    expect(isSafeRelativePath('../escape.sh')).toBe(false);
    expect(isSafeRelativePath('scripts/../../escape')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('\\etc\\passwd')).toBe(false);
    expect(isSafeRelativePath('C:\\Windows\\boot.ini')).toBe(false);
    expect(isSafeRelativePath('./hidden')).toBe(false);
    expect(isSafeRelativePath('with\0null')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });

  it('refuses to write a skill file whose path traverses out', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const goodFile = fileSpec('SKILL.md', '# ok\n');
    const evilFile: any = {
      path: '../evil.sh',
      size: 4,
      sha256: sha256('evil'),
      inline: true,
      content: Buffer.from('evil').toString('base64'),
    };
    const cloud = cloudWithSkills([
      {
        skill: { id: 's1', slug: 'evil-skill', contentManifest: JSON.stringify([goodFile, evilFile]) },
      },
    ]);

    await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    // Good file landed, evil file did not — and nothing escaped.
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'evil-skill');
    await expect(readFile(join(base, 'SKILL.md'), 'utf8')).resolves.toBe('# ok\n');
    await expect(
      readFile(join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'evil.sh'), 'utf8'),
    ).rejects.toThrow();
  });

  it('downloads url-only files and verifies their sha256', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const bigBytes = Buffer.from('# big content '.repeat(50), 'utf8');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bigBytes.buffer.slice(bigBytes.byteOffset, bigBytes.byteOffset + bigBytes.byteLength),
    }));
    globalThis.fetch = fetchMock as any;

    const inlineFile = fileSpec('SKILL.md', '# slim\n');
    const remoteFile = {
      path: 'assets/font.bin',
      size: bigBytes.byteLength,
      sha256: createHash('sha256').update(bigBytes).digest('hex'),
      inline: false,
      url: 'https://cdn.example/font.bin',
    };
    const cloud = cloudWithSkills([
      {
        skill: { id: 's1', slug: 'remote-skill', contentManifest: JSON.stringify([inlineFile, remoteFile]) },
      },
    ]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(result.synced).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'remote-skill');
    const written = await readFile(join(base, 'assets', 'font.bin'));
    expect(Buffer.compare(written, bigBytes)).toBe(0);
  });

  it('removes orphan files when manifest drops a previously synced path', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'orphan-skill');
    // Pre-seed an orphan that the new manifest will not contain.
    await mkdir(join(base, 'old'), { recursive: true });
    await writeFile(join(base, 'old', 'stale.txt'), 'stale\n', 'utf8');

    const files = [fileSpec('SKILL.md', '# fresh\n')];
    const cloud = cloudWithSkills([
      { skill: { id: 's1', slug: 'orphan-skill', contentManifest: JSON.stringify(files) } },
    ]);

    await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    await expect(stat(join(base, 'old', 'stale.txt'))).rejects.toThrow();
    await expect(readFile(join(base, 'SKILL.md'), 'utf8')).resolves.toBe('# fresh\n');
  });

  it('skips re-write when local sha matches manifest sha (incremental no-op)', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const skillMd = '# stable\n';
    const scriptBody = 'echo hi\n';
    const files = [fileSpec('SKILL.md', skillMd), fileSpec('scripts/run.sh', scriptBody)];
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'stable');
    await mkdir(join(base, 'scripts'), { recursive: true });
    await writeFile(join(base, 'SKILL.md'), skillMd, 'utf8');
    await writeFile(join(base, 'scripts', 'run.sh'), scriptBody, 'utf8');

    const cloud = cloudWithSkills([
      { skill: { id: 's1', slug: 'stable', contentManifest: JSON.stringify(files) } },
    ]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    // Nothing rewritten; entry classified as unchanged.
    // toMatchObject: result also carries a `backfill` status object (its own
    // test covers it); here we assert only the sync counters + loadedSkills.
    expect(result).toMatchObject({
      synced: 0,
      skipped: 0,
      unchanged: 1,
      // release201/11 S23 — loadedSkills carries slug + (optional) skillId for
      // dispatch.ts skill.invoked emit.
      loadedSkills: [{ slug: 'stable', skillId: 's1' }],
    });
  });

  it('falls back to legacy single-file content when no manifest is present', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const content = '---\nname: legacy\n---\n\n# legacy skill\n';
    const cloud = cloudWithSkills([{ skill: { id: 's1', slug: 'legacy', content } }]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(result.synced).toBe(1);
    const file = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'legacy', 'SKILL.md');
    await expect(readFile(file, 'utf8')).resolves.toBe(content);
  });

  it('prefers contentManifest over legacy content when both are present', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const legacy = '# legacy\n';
    const newSkill = '# new manifest version\n';
    const files = [fileSpec('SKILL.md', newSkill)];
    const cloud = cloudWithSkills([
      {
        skill: {
          id: 's1',
          slug: 'dual-write',
          content: legacy, // dual-write 6mo
          contentManifest: JSON.stringify(files),
        },
      },
    ]);

    await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    const file = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'dual-write', 'SKILL.md');
    await expect(readFile(file, 'utf8')).resolves.toBe(newSkill);
  });

  it('rejects non-http(s) urls to prevent file:// or data: smuggling', async () => {
    const root = await tempRoot();
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor('hermes', { hermesProfileName: 'ceo' });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
    globalThis.fetch = fetchMock as any;

    const evil = {
      path: 'assets/secret.bin',
      size: 4,
      sha256: sha256('hack'),
      inline: false,
      url: 'file:///etc/passwd',
    };
    const cloud = cloudWithSkills([
      { skill: { id: 's1', slug: 'scheme-evil', contentManifest: JSON.stringify([evil]) } },
    ]);

    const result = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloud as any);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

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
    request: request ?? vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } })),
  };
}

function fileSpec(path: string, body: string) {
  const buf = Buffer.from(body, 'utf8');
  return {
    path,
    size: buf.byteLength,
    sha256: sha256(body),
    inline: true,
    content: buf.toString('base64'),
  };
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(value as any).digest('hex');
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prismer-skill-sync-multifile-'));
  cleanupDirs.push(dir);
  return dir;
}

// silence unused: keep import for type asserts above
void readdir;
void dirname;
void beforeEach;
