// S5 §3.4-4b (docs/organization/specs/05 Task 6) — skill-sync gateway kill is
// busy-gated.
//
// A hermes gateway scans its skill catalog at SPAWN time (verified against the
// pinned upstream route table: there is no skill reload/rescan endpoint, only a
// read-only GET /v1/skills). So installing a skill means killing the gateway —
// and killing the gateway while a turn is IN FLIGHT vacuates every session on
// that profile (all mapped hermesSessionIds 404 on the next dispatch, for every
// conversation of that agent, not just the current one).
//
// Trade-off taken: defer. The new skill stays invisible for this dispatch
// (acceptable — it is skipped, not lost) while the in-flight run survives.
// The dirty bit is re-armed so the next dispatch (or idle moment) re-consumes
// it. Idle profiles still kill immediately, exactly as before.

import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '../src/adapters/contract.js';
import * as dispatchModule from '../src/daemon/dispatch.js';

const profile: AgentProfile = {
  id: 'profile-skill-defer',
  workspaceId: 'ws-skill-defer',
  agentImUserId: 'agent-skill-defer',
  agentUsername: 'defer',
  adapterName: 'hermes',
  name: 'Hermes',
  config: {},
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

type Respawn = (
  agentProfile: AgentProfile,
  deps: {
    invalidateService?: (profileId: string, disposer: () => void | Promise<void>) => Promise<void>;
    dropService?: (profileId: string) => void | Promise<void>;
    peekServiceBusy?: (profileId: string) => boolean;
    markSkillDirty?: (profileId: string) => void;
  },
  detail: string,
) => Promise<'killed' | 'deferred'>;

function respawn(): Respawn {
  const fn = (dispatchModule as unknown as { respawnHermesGatewayAfterSkillSync?: Respawn })
    .respawnHermesGatewayAfterSkillSync;
  expect(fn).toBeTypeOf('function');
  return fn!;
}

describe('S5 §3.4-4b skill-sync gateway kill is busy-gated', () => {
  it('defers the kill when the profile has an in-flight run, and re-arms the dirty flag', async () => {
    const invalidateService = vi.fn(async (_id: string, disposer: () => Promise<void> | void) => {
      await disposer();
    });
    const markSkillDirty = vi.fn();

    const outcome = await respawn()(
      profile,
      { invalidateService, peekServiceBusy: () => true, markSkillDirty },
      'synced=1 pruned=0',
    );

    expect(outcome).toBe('deferred');
    expect(invalidateService).not.toHaveBeenCalled();
    expect(markSkillDirty).toHaveBeenCalledWith(profile.id);
  });

  it('kills immediately when the profile is idle', async () => {
    const invalidateService = vi.fn(async (_id: string, disposer: () => Promise<void> | void) => {
      await disposer();
    });
    const markSkillDirty = vi.fn();

    const outcome = await respawn()(
      profile,
      { invalidateService, peekServiceBusy: () => false, markSkillDirty },
      'synced=1 pruned=0',
    );

    expect(outcome).toBe('killed');
    expect(invalidateService).toHaveBeenCalledTimes(1);
    expect(markSkillDirty).not.toHaveBeenCalled();
  });

  it('kills when no busy probe is wired (preserves the pre-S5 behaviour)', async () => {
    const invalidateService = vi.fn(async (_id: string, disposer: () => Promise<void> | void) => {
      await disposer();
    });

    const outcome = await respawn()(profile, { invalidateService }, 'synced=1 pruned=0');

    expect(outcome).toBe('killed');
    expect(invalidateService).toHaveBeenCalledTimes(1);
  });
});
