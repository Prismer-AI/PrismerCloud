/**
 * BP-2 repro — content-update propagation to a RUNNING agent's device dir.
 *
 * Mimics R5-S3 exactly: a 2-file bundle (SKILL.md + scripts/run.sh) carrying a
 * version `marker`. v1 already on disk (agent installed + ran once). Cloud now
 * serves the v2 manifest (owner PATCHed content). Assert:
 *   - device dir SKILL.md + run.sh rewritten to v2 bytes
 *   - result.synced === 1 (the ONLY signal dispatch.ts uses to kill+respawn the
 *     warm hermes gateway so the live process re-reads the catalog)
 *
 * This isolates the DAEMON leg of the propagation chain from cloud + gateway.
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncInstalledSkillsForDispatch, computeMerkle } from '../src/daemon/skill-sync.js';
import type { AgentProfile } from '../src/adapters/contract.js';

const oldHermesHome = process.env.HERMES_HOME;
const cleanupDirs: string[] = [];

afterEach(async () => {
  process.env.HERMES_HOME = oldHermesHome;
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

function bundle(marker: string) {
  const skillMd = `---\nname: r5probe\n---\n\n# r5probe\n\nMARKER=${marker}\n`;
  const runSh = `#!/usr/bin/env bash\necho "MARKER=${marker}" > marker.txt\n`;
  const files = [
    { path: 'SKILL.md', body: skillMd },
    { path: 'scripts/run.sh', body: runSh },
  ].map((f) => {
    const buf = Buffer.from(f.body, 'utf8');
    return { path: f.path, size: buf.byteLength, sha256: sha256(f.body), inline: true, content: buf.toString('base64') };
  });
  return { files, revision: computeMerkle(files), skillMd, runSh };
}

function profileFor(): AgentProfile {
  return {
    id: 'profile-bp2',
    workspaceId: 'ws-1',
    agentImUserId: 'agent-1',
    agentUsername: 'agent-user',
    adapterName: 'hermes',
    name: 'Agent',
    config: { hermesProfileName: 'ceo' },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AgentProfile;
}

function cloudServing(manifest: string, revision: string) {
  return {
    get: vi.fn(async () => ({
      ok: true,
      data: [{ skill: { id: 's1', slug: 'r5probe', contentManifest: manifest, contentManifestRevision: revision } }],
    })),
    request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } })),
  };
}

describe('BP-2 · content update reaches a running agent device dir', () => {
  it('rewrites v1 files to v2 and reports synced=1 (respawn trigger)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bp2-'));
    cleanupDirs.push(root);
    process.env.HERMES_HOME = join(root, 'hermes');
    const profile = profileFor();

    const v1 = bundle('MARKER_V1');
    const v2 = bundle('MARKER_V2');
    const base = join(process.env.HERMES_HOME!, 'profiles', 'ceo', 'skills', 'r5probe');

    // ── v1 already installed on disk (agent ran once at v1) ──
    const cloudV1 = cloudServing(JSON.stringify(v1.files), v1.revision);
    const r1 = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloudV1 as any);
    expect(r1.synced).toBe(1);
    expect(await readFile(join(base, 'SKILL.md'), 'utf8')).toContain('MARKER_V1');
    expect(await readFile(join(base, 'scripts', 'run.sh'), 'utf8')).toContain('MARKER_V1');

    // ── steady state: same v1 served again → no rewrite, no respawn ──
    const r1b = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloudServing(JSON.stringify(v1.files), v1.revision) as any);
    expect(r1b.synced).toBe(0);
    expect(r1b.unchanged).toBe(1);

    // ── owner PATCHed content → cloud now serves v2 → next dispatch ──
    const cloudV2 = cloudServing(JSON.stringify(v2.files), v2.revision);
    const r2 = await syncInstalledSkillsForDispatch(profile, 'agent-1', cloudV2 as any);

    // Oracle: device dir bytes flipped to v2, and synced=1 (respawn signal).
    expect(await readFile(join(base, 'SKILL.md'), 'utf8')).toContain('MARKER_V2');
    expect(await readFile(join(base, 'SKILL.md'), 'utf8')).not.toContain('MARKER_V1');
    expect(await readFile(join(base, 'scripts', 'run.sh'), 'utf8')).toContain('MARKER_V2');
    expect(r2.synced).toBe(1);
  });
});
