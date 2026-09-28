// release203/08 WS-E — daemon-side control-frame handler unit tests.
//
// Verifies the pure handler calls the RIGHT AdapterService method for each
// control kind, echoes `_rpcId`, and degrades cleanly (unsupported / no live
// session / errors) without throwing. End-to-end live-session control (cloud
// → WS → daemon → live CodeAgentService → real provider) is NOT exercised
// here — see the report's "coverage" note for what a live harness requires.

import { describe, expect, it, vi } from 'vitest';
import type { AdapterService } from '../src/adapters/contract.js';
import { handleAgentSessionControl } from '../src/daemon/agent-session-control.js';

function fakeService(over: Partial<AdapterService> = {}): AdapterService {
  return {
    id: 'code-agent:fake',
    dispatch: vi.fn(),
    healthy: vi.fn().mockResolvedValue(true),
    ...over,
  } as unknown as AdapterService;
}

describe('handleAgentSessionControl', () => {
  it('set_model calls service.setModel and echoes _rpcId', async () => {
    const setModel = vi.fn().mockResolvedValue(undefined);
    const svc = fakeService({ setModel });
    const reply = await handleAgentSessionControl(
      'set_model',
      { agentImUserId: 'agent1', modelId: 'claude-opus-4', _rpcId: 'rpc-1' },
      () => svc,
    );
    expect(setModel).toHaveBeenCalledWith('claude-opus-4');
    expect(reply).toMatchObject({ _rpcId: 'rpc-1', ok: true });
  });

  it('list_commands returns the service command list', async () => {
    const commands = [{ name: 'compact', description: 'compact ctx', argumentHint: '' }];
    const listCommands = vi.fn().mockResolvedValue(commands);
    const svc = fakeService({ listCommands });
    const reply = await handleAgentSessionControl(
      'list_commands',
      { agentImUserId: 'agent1', _rpcId: 'rpc-2' },
      () => svc,
    );
    expect(listCommands).toHaveBeenCalled();
    expect(reply.ok).toBe(true);
    expect((reply.data as { commands: unknown[] }).commands).toEqual(commands);
  });

  it('rewind calls service.revert with messageId + scope', async () => {
    const revert = vi.fn().mockResolvedValue(undefined);
    const svc = fakeService({ revert });
    const reply = await handleAgentSessionControl(
      'rewind',
      { agentImUserId: 'agent1', messageId: 'm-9', scope: 'both', _rpcId: 'rpc-3' },
      () => svc,
    );
    expect(revert).toHaveBeenCalledWith({ messageId: 'm-9', scope: 'both' });
    expect(reply.ok).toBe(true);
  });

  it('returns unsupported when the adapter lacks the member (non-engine)', async () => {
    const svc = fakeService(); // no setModel/listCommands/revert
    const reply = await handleAgentSessionControl(
      'set_model',
      { agentImUserId: 'agent1', modelId: 'x', _rpcId: 'rpc-4' },
      () => svc,
    );
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('unsupported');
  });

  it('returns no_live_session when resolver finds nothing', async () => {
    const reply = await handleAgentSessionControl(
      'list_commands',
      { agentImUserId: 'agent1', _rpcId: 'rpc-5' },
      () => undefined,
    );
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('no_live_session');
  });

  it('catches a throwing service method as control_failed', async () => {
    const svc = fakeService({ setModel: vi.fn().mockRejectedValue(new Error('boom')) });
    const reply = await handleAgentSessionControl(
      'set_model',
      { agentImUserId: 'agent1', modelId: 'x', _rpcId: 'rpc-6' },
      () => svc,
    );
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('control_failed');
    expect(reply.error?.message).toBe('boom');
  });

  it('validates required fields', async () => {
    const reply = await handleAgentSessionControl(
      'set_model',
      { _rpcId: 'rpc-7' },
      () => fakeService({ setModel: vi.fn() }),
    );
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('bad_request');
  });
});
