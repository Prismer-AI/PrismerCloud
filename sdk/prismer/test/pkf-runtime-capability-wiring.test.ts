import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '../src/adapters/contract.js';
import { Runner } from '../src/daemon/runner.js';
import type { PkfRuntimeCapabilityReport } from '../src/daemon/pkf-runtime-capability.js';

const PROFILE_ID = 'profile-pkf-capability';

interface TestableRunner {
  paths: unknown;
  config: Record<string, unknown>;
  cloud: unknown;
  pkfCoreAvailable: boolean;
  cloudCliAvailable: boolean;
  loadAllProfiles: () => AgentProfile[];
  servicePool: unknown;
  syncProfileFromCloud: () => Promise<void>;
  db: unknown;
  wsConnected: boolean;
  pkfRuntimeCapabilities: Map<string, PkfRuntimeCapabilityReport>;
  syncAllSkillsBackground: (trigger: 'startup') => Promise<void>;
  onAgentProfileChanged: (payload: { profileId: string }) => Promise<void>;
  resolvePkfRuntimeCapability: (profile: AgentProfile) => PkfRuntimeCapabilityReport;
}

function installSkill(root: string, slug: string): void {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, 'SKILL.md'), `---\nname: ${slug}\n---\n`);
}

function profileRow(skillsDir: string) {
  return {
    id: PROFILE_ID,
    workspace_id: 'ws-pkf',
    agent_im_user_id: 'agent-pkf',
    adapter_name: 'hermes',
    name: 'PKF Writer',
    config: JSON.stringify({ skillsDir }),
    version: 1,
    synced_at: Date.now(),
  };
}

describe('Runner PKF capability production wiring', () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('audits startup and profile-change paths; deleting one installed skill makes the next dispatch receipt unavailable', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'prismer-pkf-runner-cap-'));
    cleanup.push(skillsDir);
    installSkill(skillsDir, 'pkf-writing');
    installSkill(skillsDir, 'pkf-svg');

    const runner = new Runner() as unknown as TestableRunner;
    const row = profileRow(skillsDir);
    const profile: AgentProfile = {
      id: row.id,
      workspaceId: row.workspace_id,
      agentImUserId: row.agent_im_user_id,
      adapterName: row.adapter_name,
      name: row.name,
      config: JSON.parse(row.config),
      version: row.version,
      createdAt: new Date(row.synced_at),
      updatedAt: new Date(row.synced_at),
    };
    runner.paths = {};
    runner.config = {};
    runner.cloud = {
      get: vi.fn(async () => {
        throw new Error('TAMPER: cloud skill catalog unavailable');
      }),
      request: vi.fn(async () => ({ ok: false, status: 503 })),
    };
    runner.pkfCoreAvailable = true;
    runner.cloudCliAvailable = true;
    runner.loadAllProfiles = vi.fn(() => [profile]);
    runner.servicePool = { drop: vi.fn(async () => undefined) };
    runner.syncProfileFromCloud = vi.fn(async () => undefined);
    runner.db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => row) })),
    };
    runner.wsConnected = false;

    await runner.syncAllSkillsBackground('startup');
    const startup = runner.pkfRuntimeCapabilities.get(PROFILE_ID);
    expect(startup).toMatchObject({
      trigger: 'startup',
      status: 'available',
      nativeTools: { missing: [] },
      skills: { missing: [] },
    });

    rmSync(join(skillsDir, 'pkf-svg'), { recursive: true, force: true });
    await runner.onAgentProfileChanged({ profileId: PROFILE_ID });
    const changed = runner.pkfRuntimeCapabilities.get(PROFILE_ID);
    expect(changed).toMatchObject({
      trigger: 'profile-changed',
      status: 'unavailable',
      skills: { missing: ['pkf-svg'] },
    });
    expect(runner.resolvePkfRuntimeCapability(profile)).toBe(changed);
  });
});
