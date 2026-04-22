/**
 * AdapterRegistry + DispatchMux tests (Sprint A3, D4).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterRegistry, type AdapterImpl, type AdapterDispatchResult } from '../src/adapter-registry';
import { DispatchMux } from '../src/dispatch-mux';

function makeAdapter(
  name: string,
  capabilityTags: string[],
  dispatch?: (req: any) => Promise<AdapterDispatchResult>,
  tiers: number[] = [1, 2, 3, 4],
): AdapterImpl {
  return {
    name,
    tiersSupported: tiers,
    capabilityTags,
    dispatch:
      dispatch ??
      (async () => ({ ok: true, output: `handled by ${name}` })),
  };
}

describe('AdapterRegistry', () => {
  let reg: AdapterRegistry;

  beforeEach(() => {
    reg = new AdapterRegistry();
  });

  it('register / has / get / size', () => {
    expect(reg.size()).toBe(0);
    reg.register(makeAdapter('claude-code', ['code.write']));
    expect(reg.size()).toBe(1);
    expect(reg.has('claude-code')).toBe(true);
    expect(reg.get('claude-code')?.name).toBe('claude-code');
  });

  it('register replaces on name collision', () => {
    reg.register(makeAdapter('cc', ['code.write']));
    reg.register(makeAdapter('cc', ['code.review']));
    expect(reg.size()).toBe(1);
    expect(reg.get('cc')?.capabilityTags).toEqual(['code.review']);
  });

  it('register rejects empty name', () => {
    expect(() => reg.register({ ...makeAdapter('x', []), name: '' as any })).toThrow();
  });

  it('register rejects missing dispatch', () => {
    expect(() =>
      reg.register({
        name: 'x',
        tiersSupported: [],
        capabilityTags: [],
        dispatch: undefined as any,
      }),
    ).toThrow();
  });

  it('unregister returns true on success, false otherwise', () => {
    reg.register(makeAdapter('a', []));
    expect(reg.unregister('a')).toBe(true);
    expect(reg.unregister('a')).toBe(false);
  });

  it('list returns descriptors only (no dispatch / health)', () => {
    reg.register(makeAdapter('a', ['x']));
    const list = reg.list();
    expect(list).toEqual([
      { name: 'a', tiersSupported: [1, 2, 3, 4], capabilityTags: ['x'] },
    ]);
    expect((list[0] as any).dispatch).toBeUndefined();
  });

  it('findByCapability literal match', () => {
    reg.register(makeAdapter('a', ['code.write']));
    reg.register(makeAdapter('b', ['code.review']));
    const matchesList = reg.findByCapability('code.write');
    expect(matchesList.map((m) => m.name)).toEqual(['a']);
  });

  it('findByCapability wildcard match (xxx.*)', () => {
    reg.register(makeAdapter('a', ['code.*']));
    reg.register(makeAdapter('b', ['docs.*']));
    expect(reg.findByCapability('code.review').map((m) => m.name)).toEqual(['a']);
    expect(reg.findByCapability('code.write').map((m) => m.name)).toEqual(['a']);
    expect(reg.findByCapability('docs.search').map((m) => m.name)).toEqual(['b']);
    expect(reg.findByCapability('unrelated').map((m) => m.name)).toEqual([]);
  });

  it('findByCapability returns name-sorted (deterministic)', () => {
    reg.register(makeAdapter('zeta', ['x']));
    reg.register(makeAdapter('alpha', ['x']));
    reg.register(makeAdapter('mid', ['x']));
    expect(reg.findByCapability('x').map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('findByTier filters correctly', () => {
    reg.register(makeAdapter('low', [], undefined, [1, 2]));
    reg.register(makeAdapter('high', [], undefined, [5, 6, 7]));
    reg.register(makeAdapter('all', [], undefined, [1, 2, 3, 4, 5, 6, 7]));
    expect(reg.findByTier(2).map((m) => m.name).sort()).toEqual(['all', 'low']);
    expect(reg.findByTier(7).map((m) => m.name).sort()).toEqual(['all', 'high']);
    expect(reg.findByTier(99).map((m) => m.name)).toEqual([]);
  });
});

describe('DispatchMux', () => {
  let reg: AdapterRegistry;
  let mux: DispatchMux;

  beforeEach(() => {
    reg = new AdapterRegistry();
    mux = new DispatchMux(reg);
  });

  it('returns no_adapter when no adapter matches', async () => {
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'do something',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_adapter_for_capability:code.write');
    expect(result.adapter).toBeUndefined();
  });

  it('returns error when capability missing', async () => {
    const result = await mux.dispatch({
      taskId: 't1',
      capability: '' as any,
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('capability required');
  });

  it('dispatches to single matching adapter', async () => {
    reg.register(makeAdapter('cc', ['code.write']));
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(true);
    expect(result.adapter).toBe('cc');
    expect(result.output).toBe('handled by cc');
  });

  it('preferAdapter wins when registered AND can satisfy capability', async () => {
    reg.register(makeAdapter('cc', ['code.write']));
    reg.register(makeAdapter('codex', ['code.write']));
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
      preferAdapter: 'codex',
    });
    expect(result.adapter).toBe('codex');
  });

  it('preferAdapter ignored if it cannot satisfy capability', async () => {
    reg.register(makeAdapter('cc', ['code.write']));
    reg.register(makeAdapter('hermes', ['research.*']));
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
      preferAdapter: 'hermes', // cannot do code.write
    });
    expect(result.adapter).toBe('cc');
  });

  it('preferAdapter ignored if not registered', async () => {
    reg.register(makeAdapter('cc', ['code.write']));
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
      preferAdapter: 'doesnt-exist',
    });
    expect(result.adapter).toBe('cc');
  });

  it('multiple matches → name-sorted first wins (deterministic)', async () => {
    reg.register(makeAdapter('zeta', ['code.write']));
    reg.register(makeAdapter('alpha', ['code.write']));
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.adapter).toBe('alpha');
  });

  it('adapter throwing is caught and reported as adapter_threw', async () => {
    reg.register({
      ...makeAdapter('boom', ['code.write']),
      dispatch: async () => {
        throw new Error('kapow');
      },
    });
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('adapter_threw:kapow');
    expect(result.adapter).toBe('boom');
  });

  it('adapter returning ok=false is propagated unchanged + tagged', async () => {
    reg.register({
      ...makeAdapter('cc', ['code.write']),
      dispatch: async () => ({ ok: false, error: 'sandbox_denied' }),
    });
    const result = await mux.dispatch({
      taskId: 't1',
      capability: 'code.write',
      prompt: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('sandbox_denied');
    expect(result.adapter).toBe('cc');
  });

  it('passes through artifacts + metadata', async () => {
    const dispatchSpy = vi.fn(async () => ({
      ok: true,
      output: 'done',
      artifacts: [{ path: 'out.txt', bytes: 12 }],
      metadata: { tokens: 100 },
    }));
    reg.register({ ...makeAdapter('cc', ['code.write']), dispatch: dispatchSpy });
    const result = await mux.dispatch({
      taskId: 't1',
      stepIdx: 2,
      capability: 'code.write',
      prompt: 'x',
      metadata: { caller: 'test' },
      deadlineAt: 999,
    });
    expect(result.artifacts).toEqual([{ path: 'out.txt', bytes: 12 }]);
    expect(result.metadata).toEqual({ tokens: 100 });
    // Dispatch input passed through verbatim.
    expect(dispatchSpy).toHaveBeenCalledWith({
      taskId: 't1',
      stepIdx: 2,
      capability: 'code.write',
      prompt: 'x',
      metadata: { caller: 'test' },
      deadlineAt: 999,
    });
  });

  it('resolve() returns adapter name without dispatching', async () => {
    const dispatchSpy = vi.fn(async () => ({ ok: true }));
    reg.register({ ...makeAdapter('cc', ['code.write']), dispatch: dispatchSpy });
    const r = mux.resolve({ capability: 'code.write' });
    expect(r?.adapter).toBe('cc');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('resolve() returns undefined when no match', () => {
    expect(mux.resolve({ capability: 'nothing' })).toBeUndefined();
  });

  it('resolve() honors preferAdapter when capable', () => {
    reg.register(makeAdapter('a', ['code.write']));
    reg.register(makeAdapter('b', ['code.write']));
    const r = mux.resolve({ capability: 'code.write', preferAdapter: 'b' });
    expect(r?.adapter).toBe('b');
  });
});
