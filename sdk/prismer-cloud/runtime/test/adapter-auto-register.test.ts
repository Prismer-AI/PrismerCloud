/**
 * autoRegisterAdapters tests (Sprint C1/C2).
 *
 * Drives the catalog → registry pipeline with synthetic catalog entries
 * and asserts the wiring matches the expected per-adapter quirks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterRegistry, type AdapterImpl } from '../src/adapter-registry';
import {
  autoRegisterAdapters,
  type HermesModeBResolver,
} from '../src/adapters/auto-register';
import type { AgentCatalogEntry } from '../src/agents/registry';

function entry(
  name: string,
  detect: () => Promise<{ found: boolean; binaryPath?: string }>,
  capabilityTags = ['code'],
  tiersSupported = [1, 2, 3],
): AgentCatalogEntry {
  return {
    name,
    displayName: name,
    packPackage: '@prismer/x',
    packVersionRange: '^1',
    hookConfigPath: '~/.x/hooks.json',
    upstreamBinary: name,
    tiersSupported,
    capabilityTags,
    detect,
  };
}

describe('autoRegisterAdapters', () => {
  let reg: AdapterRegistry;
  beforeEach(() => {
    reg = new AdapterRegistry();
  });

  it('registers only catalog entries that detect() finds installed', async () => {
    const catalog = [
      entry('claude-code', async () => ({ found: true, binaryPath: '/usr/local/bin/claude' })),
      entry('codex', async () => ({ found: false })),
      entry('hermes', async () => ({ found: true, binaryPath: '/opt/hermes/hermes' })),
    ];
    const result = await autoRegisterAdapters(reg, { catalog });
    expect(result.registered.map((r) => r.name).sort()).toEqual(['claude-code', 'hermes']);
    expect(result.skipped.map((s) => s.name)).toEqual(['codex']);
    expect(reg.size()).toBe(2);
    expect(reg.has('claude-code')).toBe(true);
    expect(reg.has('hermes')).toBe(true);
    expect(reg.has('codex')).toBe(false);
  });

  it('skips an adapter whose detect() throws (does not crash registration)', async () => {
    const catalog = [
      entry('claude-code', async () => ({ found: true, binaryPath: '/x' })),
      entry('boom', async () => {
        throw new Error('child died');
      }),
    ];
    const result = await autoRegisterAdapters(reg, { catalog });
    expect(reg.has('claude-code')).toBe(true);
    expect(result.skipped.find((s) => s.name === 'boom')?.reason).toMatch(/detect_failed/);
  });

  it('does not replace an already-registered adapter (yields to user code)', async () => {
    const userImpl: AdapterImpl = {
      name: 'claude-code',
      tiersSupported: [99],
      capabilityTags: ['custom'],
      dispatch: async () => ({ ok: true, output: 'user' }),
    };
    reg.register(userImpl);

    const catalog = [
      entry('claude-code', async () => ({ found: true, binaryPath: '/x' })),
    ];
    const result = await autoRegisterAdapters(reg, { catalog });
    expect(result.skipped.find((s) => s.name === 'claude-code')?.reason).toBe('already_registered');
    expect(reg.get('claude-code')?.tiersSupported).toEqual([99]);
  });

  it('skipDetection bypasses detect() (used in tests + CI)', async () => {
    const detectSpy = vi.fn(async () => ({ found: false }));
    const catalog = [entry('claude-code', detectSpy)];
    const result = await autoRegisterAdapters(reg, { catalog, skipDetection: true });
    expect(detectSpy).not.toHaveBeenCalled();
    expect(result.registered.map((r) => r.name)).toEqual(['claude-code']);
  });

  it('forceBinaryFor overrides detection (per-adapter)', async () => {
    const catalog = [
      entry('claude-code', async () => ({ found: false })),
      entry('codex', async () => ({ found: false })),
    ];
    const result = await autoRegisterAdapters(reg, {
      catalog,
      forceBinaryFor: { 'claude-code': '/test/claude' },
    });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0].name).toBe('claude-code');
    expect(result.skipped.find((s) => s.name === 'codex')?.reason).toBe('not_installed');
  });

  it('configOverrides forwards into the CLI adapter', async () => {
    const catalog = [entry('claude-code', async () => ({ found: true, binaryPath: '/x' }))];
    const result = await autoRegisterAdapters(reg, {
      catalog,
      configOverrides: {
        'claude-code': { baseArgs: ['--non-interactive', '--json'], timeoutMs: 1000 },
      },
    });
    expect(result.registered).toHaveLength(1);
    // Adapters expose their config indirectly via metadata; the test only
    // asserts the registration succeeded — full dispatch behavior is
    // covered by the cli-adapter unit tests.
    expect(reg.get('claude-code')).toBeDefined();
  });

  it('CLI-shim adapters expose reset() as stateless_noop (v1.9.27+ agent_restart contract)', async () => {
    const catalog = [entry('claude-code', async () => ({ found: true, binaryPath: '/x' }))];
    await autoRegisterAdapters(reg, { catalog });
    const adapter = reg.get('claude-code')!;
    expect(typeof adapter.reset).toBe('function');
    const r = await adapter.reset!('claude-code');
    expect(r.ok).toBe(true);
    expect(r.state).toBe('stateless_noop');
  });

  it('hermes adapter receives stdin promptVia by default (catalog quirk)', async () => {
    // We can't easily inspect promptVia without firing a dispatch, but the
    // registration path itself must succeed without throwing. The actual
    // stdin behavior is exercised in cli-adapter integration tests.
    const catalog = [entry('hermes', async () => ({ found: true, binaryPath: '/opt/hermes' }))];
    const result = await autoRegisterAdapters(reg, { catalog });
    expect(result.registered.map((r) => r.name)).toEqual(['hermes']);
  });

  it('all four AGENT_CATALOG entries route through registration when forced installed', async () => {
    const result = await autoRegisterAdapters(reg, { skipDetection: true });
    // The default catalog has claude-code, codex, hermes, openclaw.
    expect(result.registered.map((r) => r.name).sort()).toEqual([
      'claude-code',
      'codex',
      'hermes',
      'openclaw',
    ]);
  });

  it('CLI-shim registrations tag source="cli_shim" by default', async () => {
    const catalog = [
      entry('claude-code', async () => ({ found: true, binaryPath: '/x' })),
    ];
    const result = await autoRegisterAdapters(reg, {
      catalog,
      // Claude Code doesn't touch the Hermes path but set the guard
      // anyway to make the assertion about source origin crisp.
      skipHermesModeB: true,
    });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0].source).toBe('cli_shim');
  });

  // --- Hermes Mode B upgrade probe --------------------------------
  describe('Hermes Mode B upgrade', () => {
    const hermesCatalog = [
      entry('hermes', async () => ({ found: true, binaryPath: '/opt/hermes/hermes' })),
    ];

    it('Mode B reachable → Hermes entry tagged source="mode_b"', async () => {
      const resolveHermesModeB: HermesModeBResolver = vi.fn(async () => ({
        installed: true,
        loopbackUrl: 'http://127.0.0.1:47321',
      }));
      const result = await autoRegisterAdapters(reg, {
        catalog: hermesCatalog,
        resolveHermesModeB,
      });
      expect(resolveHermesModeB).toHaveBeenCalledTimes(1);
      expect(result.registered).toHaveLength(1);
      expect(result.registered[0]).toMatchObject({
        name: 'hermes',
        source: 'mode_b',
      });
    });

    it('Mode B unreachable → CLI shim stays, source="cli_shim"', async () => {
      const resolveHermesModeB: HermesModeBResolver = vi.fn(async () => ({
        installed: false,
        loopbackUrl: 'http://127.0.0.1:47321',
        reason: 'not_found:connection_refused',
      }));
      const result = await autoRegisterAdapters(reg, {
        catalog: hermesCatalog,
        resolveHermesModeB,
      });
      expect(resolveHermesModeB).toHaveBeenCalledTimes(1);
      expect(result.registered).toHaveLength(1);
      expect(result.registered[0]).toMatchObject({
        name: 'hermes',
        source: 'cli_shim',
      });
      // CLI shim is still the one in the registry (no swap happened).
      expect(reg.has('hermes')).toBe(true);
    });

    it('@prismer/adapter-hermes not installed → falls through to CLI shim silently', async () => {
      // Resolver returns null to signal "module not found".
      const resolveHermesModeB: HermesModeBResolver = vi.fn(async () => null);
      const result = await autoRegisterAdapters(reg, {
        catalog: hermesCatalog,
        resolveHermesModeB,
      });
      expect(resolveHermesModeB).toHaveBeenCalledTimes(1);
      expect(result.registered).toHaveLength(1);
      expect(result.registered[0].source).toBe('cli_shim');
      expect(reg.has('hermes')).toBe(true);
    });

    it('skipHermesModeB=true bypasses the probe entirely', async () => {
      const resolveHermesModeB: HermesModeBResolver = vi.fn();
      const result = await autoRegisterAdapters(reg, {
        catalog: hermesCatalog,
        skipHermesModeB: true,
        resolveHermesModeB,
      });
      expect(resolveHermesModeB).not.toHaveBeenCalled();
      expect(result.registered[0].source).toBe('cli_shim');
    });

    it('probe throws → CLI shim stays, registration does not fail', async () => {
      const resolveHermesModeB: HermesModeBResolver = vi.fn(async () => {
        throw new Error('surprise boom');
      });
      const result = await autoRegisterAdapters(reg, {
        catalog: hermesCatalog,
        resolveHermesModeB,
      });
      expect(result.registered).toHaveLength(1);
      expect(result.registered[0].source).toBe('cli_shim');
      expect(reg.has('hermes')).toBe(true);
    });

    it('Hermes not in catalog → probe never runs', async () => {
      const resolveHermesModeB: HermesModeBResolver = vi.fn();
      const catalog = [
        entry('claude-code', async () => ({ found: true, binaryPath: '/x' })),
      ];
      await autoRegisterAdapters(reg, { catalog, resolveHermesModeB });
      expect(resolveHermesModeB).not.toHaveBeenCalled();
    });
  });
});
