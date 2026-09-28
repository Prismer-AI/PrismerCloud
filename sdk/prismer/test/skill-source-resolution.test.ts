import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSkillResolutionHealth,
  resolveBundledSkillDirectory,
  resolveSkillSource,
  snapshotSkillResolutionHealth,
  type ResolvableSkillFile,
} from '../src/daemon/skill-source-resolution.js';

const cleanupDirs: string[] = [];

describe('curated catalog offline compatibility', () => {
  it('resolves merged historical names and ships citation support code offline', async () => {
    const catalog = join(dirname(fileURLToPath(import.meta.url)), '../../cloud/catalog/skills');
    for (const [old, canonical] of [
      ['skill-builder', 'skill-creator'],
      ['skill-authoring', 'skill-creator'],
      ['document-generation', 'office-artifacts'],
    ]) {
      expect(await resolveBundledSkillDirectory(catalog, old!)).toBe(join(catalog, canonical!));
    }
    const root = await tempRoot();
    const targetDir = join(root, 'evidence-citations');
    const result = await resolveSkillSource({
      slug: 'evidence-citations',
      targetDir,
      bundledDir: (await resolveBundledSkillDirectory(catalog, 'evidence-citations'))!,
    });
    expect(result).toMatchObject({ ok: true, source: 'bundled-fallback' });
    expect(await readFile(join(targetDir, 'scripts/sources.py'), 'utf8')).toContain('task-specific');
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function remoteFile(path: string, body: string): ResolvableSkillFile {
  const bytes = Buffer.from(body, 'utf8');
  return {
    path,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    inline: true,
    content: bytes.toString('base64'),
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prismer-skill-resolution-'));
  cleanupDirs.push(root);
  return root;
}

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body, 'utf8');
}

beforeEach(() => {
  __resetSkillResolutionHealth();
});

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('skill source resolution ladder', () => {
  it('resolves a historical bundled slug through canonical metadata aliases', async () => {
    const root = await tempRoot();
    const bundledRoot = join(root, 'bundle');
    const canonicalDir = join(bundledRoot, 'remotion');
    await writeSkill(
      canonicalDir,
      [
        '---',
        'name: remotion',
        'metadata:',
        '  aliases:',
        '    - remotion-create',
        '    - remotion-render',
        '---',
        '# Remotion',
        '',
      ].join('\n'),
    );

    expect(await resolveBundledSkillDirectory(bundledRoot, 'remotion-create')).toBe(canonicalDir);
    expect(await resolveBundledSkillDirectory(bundledRoot, 'remotion')).toBe(canonicalDir);
    expect(await resolveBundledSkillDirectory(bundledRoot, 'not-a-skill')).toBeNull();
  });

  it('fails closed when multiple bundled skills claim the same historical slug', async () => {
    const root = await tempRoot();
    const bundledRoot = join(root, 'bundle');
    await writeSkill(
      join(bundledRoot, 'remotion'),
      ['---', 'name: remotion', 'metadata:', '  aliases: [remotion-render]', '---', '# Remotion'].join('\n'),
    );
    await writeSkill(
      join(bundledRoot, 'video-editing'),
      ['---', 'name: video-editing', 'metadata:', '  aliases: [remotion-render]', '---', '# Video'].join('\n'),
    );

    expect(await resolveBundledSkillDirectory(bundledRoot, 'remotion-render')).toBeNull();
  });

  it('resolves historical pkf-visual through the checked-out canonical pkf-svg bundle', async () => {
    const bundledRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'built-in-skills');
    const canonicalDir = join(bundledRoot, 'pkf-svg');

    expect(await resolveBundledSkillDirectory(bundledRoot, 'pkf-visual')).toBe(canonicalDir);
    expect(await resolveBundledSkillDirectory(bundledRoot, 'pkf-svg')).toBe(canonicalDir);

    const root = await tempRoot();
    const targetDir = join(root, 'live', 'pkf-visual');
    const result = await resolveSkillSource({ slug: 'pkf-visual', targetDir, bundledDir: canonicalDir });
    expect(result).toMatchObject({ ok: true, source: 'bundled-fallback' });
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf8')).toMatch(/^name:\s*pkf-svg$/m);
  });

  it('installs a verified remote snapshot transactionally', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live', 'probe');
    const files = [remoteFile('SKILL.md', '# remote\n'), remoteFile('scripts/run.sh', 'echo remote\n')];

    const result = await resolveSkillSource({ slug: 'probe', targetDir, remote: { files } });

    expect(result).toMatchObject({ ok: true, source: 'remote', changed: true, staleReason: null });
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf8')).toBe('# remote\n');
    expect(await readFile(join(targetDir, 'scripts/run.sh'), 'utf8')).toBe('echo remote\n');
    expect(snapshotSkillResolutionHealth().counts).toEqual({
      remote: 1,
      lkg: 0,
      bundledFallback: 0,
      failed: 0,
    });
  });

  it('keeps the LKG when a remote download fails', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live', 'probe');
    await resolveSkillSource({ slug: 'probe', targetDir, remote: { files: [remoteFile('SKILL.md', '# lkg\n')] } });
    const bytes = Buffer.from('# remote\n');

    const result = await resolveSkillSource({
      slug: 'probe',
      targetDir,
      remote: {
        files: [
          {
            path: 'SKILL.md',
            size: bytes.byteLength,
            sha256: sha256(bytes),
            inline: false,
            url: 'https://invalid.test/skill',
          },
        ],
      },
      fetchUrl: async () => {
        throw new Error('network offline');
      },
    });

    expect(result).toMatchObject({ ok: true, source: 'lkg', changed: false });
    expect(result.staleReason).toContain('network offline');
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf8')).toBe('# lkg\n');
  });

  it('uses the bundled fallback when remote and LKG are unavailable', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live', 'probe');
    const bundledDir = join(root, 'bundle', 'probe');
    await writeSkill(bundledDir, '# bundled\n');

    const result = await resolveSkillSource({ slug: 'probe', targetDir, bundledDir });

    expect(result).toMatchObject({
      ok: true,
      source: 'bundled-fallback',
      changed: true,
      staleReason: 'remote manifest unavailable',
    });
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf8')).toBe('# bundled\n');
  });

  it('fails closed when none of the three sources is usable', async () => {
    const root = await tempRoot();
    const result = await resolveSkillSource({
      slug: 'missing',
      targetDir: join(root, 'live', 'missing'),
      bundledDir: join(root, 'bundle', 'missing'),
    });

    expect(result).toMatchObject({
      ok: false,
      revision: null,
      contentHash: null,
      staleReason: 'remote manifest unavailable',
      changed: false,
    });
    expect(result.error).toContain('skill_resolution_failed: missing');
    expect(snapshotSkillResolutionHealth().counts.failed).toBe(1);
  });

  it('rejects tampered remote bytes without mutating the LKG', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live', 'probe');
    await resolveSkillSource({ slug: 'probe', targetDir, remote: { files: [remoteFile('SKILL.md', '# trusted lkg\n')] } });
    const before = await stat(join(targetDir, 'SKILL.md'));
    const tampered = remoteFile('SKILL.md', '# tampered\n');
    tampered.sha256 = '0'.repeat(64);

    const result = await resolveSkillSource({
      slug: 'probe',
      targetDir,
      remote: { files: [tampered] },
    });

    expect(result).toMatchObject({ ok: true, source: 'lkg', changed: false });
    expect(result.staleReason).toContain('hash mismatch');
    expect(await readFile(join(targetDir, 'SKILL.md'), 'utf8')).toBe('# trusted lkg\n');
    expect((await stat(join(targetDir, 'SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('does not replace an unchanged verified remote snapshot', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live', 'probe');
    const files = [remoteFile('SKILL.md', '# stable\n')];
    await resolveSkillSource({ slug: 'probe', targetDir, remote: { files } });
    const before = await stat(join(targetDir, 'SKILL.md'));

    const result = await resolveSkillSource({ slug: 'probe', targetDir, remote: { files } });

    expect(result).toMatchObject({ ok: true, source: 'remote', changed: false });
    expect((await stat(join(targetDir, 'SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('does not promote a legacy directory without a trusted receipt to LKG', async () => {
    const root = await tempRoot();
    const targetDir = join(root, 'live');
    await writeSkill(targetDir, '# Use scripts/run.py');
    expect(await resolveSkillSource({ slug: 'probe', targetDir })).toMatchObject({ ok: false });
  });

  it.each(['missing', 'changed', 'extra', 'symlink'] as const)('rejects %s resources in an installed snapshot', async (damage) => {
    const root = await tempRoot();
    const targetDir = join(root, 'live');
    const bundledDir = join(root, 'bundle');
    await writeSkill(bundledDir, '# bundled');
    await mkdir(join(bundledDir, 'scripts'));
    await writeFile(join(bundledDir, 'scripts/run.py'), 'print(1)');
    const files = [remoteFile('SKILL.md', '# remote'), remoteFile('scripts/run.py', 'print(1)')];
    await resolveSkillSource({ slug: 'probe', targetDir, remote: { files } });
    if (damage === 'missing') await rm(join(targetDir, 'scripts/run.py'));
    if (damage === 'changed') await writeFile(join(targetDir, 'scripts/run.py'), 'print(2)');
    if (damage === 'extra') await writeFile(join(targetDir, 'untrusted.py'), 'print(3)');
    if (damage === 'symlink') {
      const { symlink } = await import('node:fs/promises');
      await rm(join(targetDir, 'scripts/run.py'));
      await symlink(join(bundledDir, 'scripts/run.py'), join(targetDir, 'scripts/run.py'));
    }
    expect(await resolveSkillSource({ slug: 'probe', targetDir, bundledDir })).toMatchObject({ ok: true, source: 'bundled-fallback' });
    expect(await readFile(join(targetDir, 'scripts/run.py'), 'utf8')).toBe('print(1)');
    expect(await resolveSkillSource({ slug: 'probe', targetDir })).toMatchObject({ ok: true, source: 'lkg' });
  });

  it('rejects a remote attempt to supply the local trust receipt', async () => {
    const root = await tempRoot();
    expect(await resolveSkillSource({ slug: 'probe', targetDir: join(root, 'live'), remote: {
      files: [remoteFile('SKILL.md', '# skill'), remoteFile('.prismer-skill-receipt.json', '{}')],
    } })).toMatchObject({ ok: false });
  });
});
