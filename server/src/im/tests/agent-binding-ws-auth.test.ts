import { describe, expect, it } from 'vitest';

import { isDaemonAuthorizedForAgentBinding } from '../ws/handler';

type MockPrisma = Parameters<typeof isDaemonAuthorizedForAgentBinding>[0];

function mockPrisma(input: {
  binding?: { boundDaemonId: string | null } | null;
  bindingError?: Error;
  metadataDaemonId?: string;
}): MockPrisma {
  return {
    iMAgentBinding: {
      findUnique: async () => {
        if (input.bindingError) throw input.bindingError;
        return input.binding ?? null;
      },
    },
    iMAgentCard: {
      findUnique: async () => ({
        metadata: JSON.stringify({ daemonId: input.metadataDaemonId }),
      }),
    },
  };
}

describe('WS daemon authorization honors im_agent_bindings', () => {
  it('rejects a daemon when binding row points elsewhere, even if metadata matches', async () => {
    const authorized = await isDaemonAuthorizedForAgentBinding(
      mockPrisma({
        binding: { boundDaemonId: 'daemon-owner' },
        metadataDaemonId: 'daemon-attacker',
      }),
      'agent-1',
      'daemon-attacker',
    );

    expect(authorized).toBe(false);
  });

  it('accepts a daemon when binding row matches, even if metadata is stale', async () => {
    const authorized = await isDaemonAuthorizedForAgentBinding(
      mockPrisma({
        binding: { boundDaemonId: 'daemon-owner' },
        metadataDaemonId: 'daemon-stale',
      }),
      'agent-1',
      'daemon-owner',
    );

    expect(authorized).toBe(true);
  });

  it('falls back to metadata only when binding row is missing', async () => {
    const authorized = await isDaemonAuthorizedForAgentBinding(
      mockPrisma({
        binding: null,
        metadataDaemonId: 'daemon-legacy',
      }),
      'agent-legacy',
      'daemon-legacy',
    );

    expect(authorized).toBe(true);
  });

  it('falls back to metadata when binding lookup fails', async () => {
    const authorized = await isDaemonAuthorizedForAgentBinding(
      mockPrisma({
        bindingError: new Error('migration missing'),
        metadataDaemonId: 'daemon-legacy',
      }),
      'agent-legacy',
      'daemon-legacy',
    );

    expect(authorized).toBe(true);
  });
});
