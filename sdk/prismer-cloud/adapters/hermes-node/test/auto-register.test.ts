import { describe, expect, it, vi } from 'vitest';
import {
  autoRegisterHermes,
  type MinimalAdapterRegistry,
} from '../src/auto-register.js';

function mockRegistry(): MinimalAdapterRegistry & {
  adapters: Map<string, unknown>;
  registerCount: number;
  unregisterCount: number;
} {
  const adapters = new Map<string, unknown>();
  return {
    adapters,
    registerCount: 0,
    unregisterCount: 0,
    register(adapter: unknown) {
      this.registerCount++;
      const name = (adapter as { name: string }).name;
      adapters.set(name, adapter);
    },
    unregister(name: string) {
      this.unregisterCount++;
      adapters.delete(name);
    },
    has(name: string) {
      return adapters.has(name);
    },
  };
}

describe('autoRegisterHermes', () => {
  it('installs Mode B when /health is reachable', async () => {
    const registry = mockRegistry();
    const fakeFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const result = await autoRegisterHermes(registry, { fetchImpl: fakeFetch });

    expect(result.installed).toBe(true);
    expect(result.loopbackUrl).toBe('http://127.0.0.1:8765');
    expect(registry.adapters.has('hermes')).toBe(true);
    expect(registry.registerCount).toBe(1);
  });

  it('no-ops when /health is unreachable', async () => {
    const registry = mockRegistry();
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await autoRegisterHermes(registry, { fetchImpl: fakeFetch });

    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/^not_found:/);
    expect(registry.adapters.has('hermes')).toBe(false);
    expect(registry.registerCount).toBe(0);
  });

  it('replaces an existing "hermes" adapter (CLI shim) when reachable', async () => {
    const registry = mockRegistry();
    // Seed a fake CLI shim
    registry.register({ name: 'hermes', kind: 'cli-shim' });
    expect(registry.adapters.size).toBe(1);

    const fakeFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await autoRegisterHermes(registry, { fetchImpl: fakeFetch });

    expect(result.installed).toBe(true);
    expect(registry.unregisterCount).toBe(1);
    const installed = registry.adapters.get('hermes') as { metadata?: { transport: string } };
    expect(installed.metadata?.transport).toBe('mode_b_http_loopback');
  });

  it('respects replaceExisting=false', async () => {
    const registry = mockRegistry();
    registry.register({ name: 'hermes', kind: 'cli-shim' });

    const fakeFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await autoRegisterHermes(registry, {
      fetchImpl: fakeFetch,
      replaceExisting: false,
    });

    expect(result.installed).toBe(false);
    expect(result.reason).toBe('already_registered');
    expect(registry.unregisterCount).toBe(0);
  });

  it('reports register_failed on registry exception', async () => {
    const registry: MinimalAdapterRegistry = {
      register() {
        throw new Error('boom');
      },
      has: () => false,
    };
    const fakeFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const result = await autoRegisterHermes(registry, { fetchImpl: fakeFetch });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe('register_failed:boom');
  });

  it('honors a custom port through detect + build', async () => {
    const registry = mockRegistry();
    let probedUrl = '';
    const fakeFetch = (async (url: string) => {
      probedUrl = url;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await autoRegisterHermes(registry, {
      port: 19876,
      fetchImpl: fakeFetch,
    });

    expect(probedUrl).toBe('http://127.0.0.1:19876/health');
    expect(result.loopbackUrl).toBe('http://127.0.0.1:19876');
    const adapter = registry.adapters.get('hermes') as { metadata?: { loopbackUrl: string } };
    expect(adapter.metadata?.loopbackUrl).toBe('http://127.0.0.1:19876');
  });

  // vi import kept for future use (mock timers if we add retry logic)
  void vi;
});
