/**
 * dispatch-rpc tests (Sprint C0).
 *
 * Drives the cloud-relay dispatch path end-to-end through a fake
 * RelayClient sink, with a real AdapterRegistry + DispatchMux on the
 * daemon side. Verifies the wire-level contract that cloud's TaskRouter
 * can rely on.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterRegistry, type AdapterImpl } from '../src/adapter-registry';
import { DispatchMux } from '../src/dispatch-mux';
import { registerDispatchRpcHandlers } from '../src/dispatch-rpc';

class FakeRelay {
  handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.handlers.set(method, handler);
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`unknown method: ${method}`);
    return await h(params);
  }
}

function adapter(
  name: string,
  capabilityTags: string[],
  dispatch?: AdapterImpl['dispatch'],
): AdapterImpl {
  return {
    name,
    tiersSupported: [1, 2, 3, 4],
    capabilityTags,
    dispatch:
      dispatch ??
      (async () => ({ ok: true, output: `handled by ${name}` })),
  };
}

describe('registerDispatchRpcHandlers', () => {
  let registry: AdapterRegistry;
  let mux: DispatchMux;
  let relay: FakeRelay;

  beforeEach(() => {
    registry = new AdapterRegistry();
    mux = new DispatchMux(registry);
    relay = new FakeRelay();
    registerDispatchRpcHandlers(relay, { mux, registry });
  });

  it('registers task.dispatch / task.list-adapters / task.resolve', () => {
    expect(relay.handlers.has('task.dispatch')).toBe(true);
    expect(relay.handlers.has('task.list-adapters')).toBe(true);
    expect(relay.handlers.has('task.resolve')).toBe(true);
  });

  describe('task.dispatch', () => {
    it('happy path: dispatches to the selected adapter', async () => {
      const dispatch = vi.fn(async () => ({ ok: true, output: 'done' }));
      registry.register(adapter('cc', ['code.write'], dispatch));

      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'code.write',
        prompt: 'hello',
      })) as any;

      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('cc');
      expect(result.output).toBe('done');
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 't-1', capability: 'code.write', prompt: 'hello' }),
      );
    });

    it('missing taskId → ok:false (does not call adapter)', async () => {
      const dispatch = vi.fn();
      registry.register(adapter('cc', ['code.write'], dispatch));
      const result = (await relay.invoke('task.dispatch', {
        capability: 'code.write',
        prompt: 'x',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/taskId/);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('missing capability → ok:false', async () => {
      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        prompt: 'x',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/capability/);
    });

    it('missing prompt → ok:false', async () => {
      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'code.write',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/prompt/);
    });

    it('non-object params → ok:false', async () => {
      const r1 = (await relay.invoke('task.dispatch', null)) as any;
      const r2 = (await relay.invoke('task.dispatch', 'string')) as any;
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
    });

    it('no adapter matches → ok:false (does not throw)', async () => {
      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'unsupported.cap',
        prompt: 'x',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('no_adapter_for_capability:unsupported.cap');
    });

    it('preferAdapter wins when capable', async () => {
      registry.register(adapter('a', ['code.write']));
      registry.register(adapter('b', ['code.write']));
      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'code.write',
        prompt: 'x',
        preferAdapter: 'b',
      })) as any;
      expect(result.adapter).toBe('b');
    });

    it('passes stepIdx + deadlineAt + metadata through to dispatch', async () => {
      const dispatch = vi.fn(async () => ({ ok: true }));
      registry.register(adapter('cc', ['code.write'], dispatch));
      await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'code.write',
        prompt: 'x',
        stepIdx: 3,
        deadlineAt: 12345,
        metadata: { foo: 'bar' },
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          stepIdx: 3,
          deadlineAt: 12345,
          metadata: { foo: 'bar' },
        }),
      );
    });

    it('adapter that throws → ok:false (caught by mux)', async () => {
      registry.register(
        adapter('boom', ['code.write'], async () => {
          throw new Error('kapow');
        }),
      );
      const result = (await relay.invoke('task.dispatch', {
        taskId: 't-1',
        capability: 'code.write',
        prompt: 'x',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('adapter_threw:kapow');
      expect(result.adapter).toBe('boom');
    });
  });

  describe('task.list-adapters', () => {
    it('returns descriptors only (no dispatch fn)', async () => {
      registry.register(adapter('cc', ['code.write']));
      registry.register(adapter('hermes', ['research.*']));
      const result = (await relay.invoke('task.list-adapters', {})) as any;
      expect(result.adapters).toHaveLength(2);
      expect((result.adapters[0] as any).dispatch).toBeUndefined();
      expect(result.adapters.map((a: any) => a.name).sort()).toEqual(['cc', 'hermes']);
    });

    it('returns empty array when nothing registered', async () => {
      const result = (await relay.invoke('task.list-adapters', {})) as any;
      expect(result.adapters).toEqual([]);
    });
  });

  describe('task.resolve', () => {
    it('returns adapter name without dispatching', async () => {
      const dispatch = vi.fn();
      registry.register(adapter('cc', ['code.write'], dispatch));
      const result = (await relay.invoke('task.resolve', {
        capability: 'code.write',
      })) as any;
      expect(result.ok).toBe(true);
      expect(result.adapter).toBe('cc');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('honors preferAdapter', async () => {
      registry.register(adapter('a', ['code.write']));
      registry.register(adapter('b', ['code.write']));
      const result = (await relay.invoke('task.resolve', {
        capability: 'code.write',
        preferAdapter: 'b',
      })) as any;
      expect(result.adapter).toBe('b');
    });

    it('no match → ok:false', async () => {
      const result = (await relay.invoke('task.resolve', {
        capability: 'nothing',
      })) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('no_adapter_for_capability:nothing');
    });

    it('missing capability → ok:false', async () => {
      const result = (await relay.invoke('task.resolve', {})) as any;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/capability/);
    });
  });
});
