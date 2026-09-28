import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AdapterRegistry } from '../src/adapters/registry.js';
import type { AdapterDef } from '../src/adapters/contract.js';

function makeAdapter(overrides: Partial<AdapterDef> & { name: string }): AdapterDef {
  return {
    kind: 'interactive',
    capabilities: [],
    workspaceSchema: z.object({}),
    validate: () => ({ ok: true }),
    health: async () => ({ available: true }),
    dispatch: async () => ({ ok: true }),
    ...overrides,
  };
}

describe('AdapterRegistry', () => {
  it('register + get + has', () => {
    const r = new AdapterRegistry();
    const a = makeAdapter({ name: 'foo' });
    r.register(a);
    expect(r.has('foo')).toBe(true);
    expect(r.get('foo')).toBe(a);
    expect(r.size()).toBe(1);
  });

  it('rejects adapter without dispatch and without ensureService', () => {
    const r = new AdapterRegistry();
    const bad = {
      name: 'broken',
      kind: 'interactive' as const,
      capabilities: [],
      workspaceSchema: z.object({}),
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    } as unknown as AdapterDef;
    expect(() => r.register(bad)).toThrow(/must implement dispatch/);
  });

  it('register accepts long-running adapter with only ensureService', () => {
    const r = new AdapterRegistry();
    const a: AdapterDef = {
      name: 'long',
      kind: 'long-running',
      capabilities: [],
      workspaceSchema: z.object({}),
      ensureService: async () => ({
        id: 'svc',
        dispatch: async () => ({ ok: true }),
        healthy: async () => true,
      }),
      validate: () => ({ ok: true }),
      health: async () => ({ available: true }),
    };
    expect(() => r.register(a)).not.toThrow();
  });

  it('rejects empty name', () => {
    const r = new AdapterRegistry();
    expect(() => r.register(makeAdapter({ name: '' }))).toThrow(/name required/);
  });

  it('list returns all and unregister removes', () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter({ name: 'a' }));
    r.register(makeAdapter({ name: 'b' }));
    expect(r.list().map((x) => x.name).sort()).toEqual(['a', 'b']);
    expect(r.unregister('a')).toBe(true);
    expect(r.unregister('a')).toBe(false);
    expect(r.size()).toBe(1);
  });

  it('findByCapability exact + wildcard', () => {
    const r = new AdapterRegistry();
    r.register(makeAdapter({ name: 'shell-only', capabilities: ['shell'] }));
    r.register(makeAdapter({ name: 'code-star', capabilities: ['code.*'] }));
    r.register(makeAdapter({ name: 'multi', capabilities: ['shell', 'code'] }));

    const shell = r.findByCapability('shell').map((a) => a.name);
    expect(shell).toEqual(['multi', 'shell-only']);

    const codeWrite = r.findByCapability('code.write').map((a) => a.name);
    expect(codeWrite).toEqual(['code-star']);

    const codeExact = r.findByCapability('code').map((a) => a.name);
    expect(codeExact).toEqual(['multi']);

    expect(r.findByCapability('nonexistent')).toEqual([]);
  });

  it('register replaces previous adapter with same name', () => {
    const r = new AdapterRegistry();
    const v1 = makeAdapter({ name: 'foo', capabilities: ['v1'] });
    const v2 = makeAdapter({ name: 'foo', capabilities: ['v2'] });
    r.register(v1);
    r.register(v2);
    expect(r.get('foo')).toBe(v2);
    expect(r.size()).toBe(1);
  });
});
