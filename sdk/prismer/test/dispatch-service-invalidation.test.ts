import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopHermesGatewayForProfile = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../src/adapters/persistence/hermes/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/persistence/hermes/index.js')>();
  return { ...actual, stopHermesGatewayForProfile };
});

import type { AgentProfile } from '../src/adapters/contract.js';
import * as dispatchModule from '../src/daemon/dispatch.js';

const profile: AgentProfile = {
  id: 'profile-atomic-restart',
  workspaceId: 'ws-atomic-restart',
  agentImUserId: 'agent-atomic-restart',
  agentUsername: 'atomic-restart',
  adapterName: 'hermes',
  name: 'Hermes',
  config: {},
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Hermes dispatch lifecycle invalidation', () => {
  beforeEach(() => {
    stopHermesGatewayForProfile.mockClear();
  });

  it('runs exact gateway stop through the pool atomic invalidation section', async () => {
    const invalidate = (
      dispatchModule as typeof dispatchModule & {
        invalidateHermesService?: (
          agentProfile: AgentProfile,
          deps: {
            invalidateService?: (profileId: string, disposer: () => void | Promise<void>) => Promise<void>;
            dropService?: (profileId: string) => void | Promise<void>;
          },
        ) => Promise<void>;
      }
    ).invalidateHermesService;
    expect(invalidate).toBeTypeOf('function');
    if (!invalidate) return;

    const order: string[] = [];
    const dropService = vi.fn(async () => {
      order.push('legacy-drop');
    });
    const invalidateService = vi.fn(async (profileId: string, disposer: () => Promise<void> | void) => {
      order.push(`fence:${profileId}`);
      await disposer();
      order.push('release');
    });
    stopHermesGatewayForProfile.mockImplementationOnce(async () => {
      order.push('stop-exact-gateway');
    });

    await invalidate(profile, { invalidateService, dropService });

    expect(invalidateService).toHaveBeenCalledTimes(1);
    expect(dropService).not.toHaveBeenCalled();
    expect(stopHermesGatewayForProfile).toHaveBeenCalledWith(profile);
    expect(order).toEqual(['fence:profile-atomic-restart', 'stop-exact-gateway', 'release']);
  });

  it('uses drop then exact gateway stop for legacy callers without atomic invalidation', async () => {
    const invalidate = (
      dispatchModule as typeof dispatchModule & {
        invalidateHermesService?: (
          agentProfile: AgentProfile,
          deps: { dropService?: (profileId: string) => void | Promise<void> },
        ) => Promise<void>;
      }
    ).invalidateHermesService;
    expect(invalidate).toBeTypeOf('function');
    if (!invalidate) return;

    const order: string[] = [];
    const dropService = vi.fn(async () => {
      order.push('drop');
    });
    stopHermesGatewayForProfile.mockImplementationOnce(async () => {
      order.push('stop');
    });

    await invalidate(profile, { dropService });

    expect(order).toEqual(['drop', 'stop']);
  });
});
