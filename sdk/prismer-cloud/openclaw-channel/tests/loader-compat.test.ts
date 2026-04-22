/**
 * OpenClaw setup-entry loader-compat regression tests
 *
 * Protects against the v1.9.21 regression (commit 5f08062) where the
 * OpenClaw 2026.4.15 plugin loader picks `setup-entry.ts` over
 * `extensions[0] = "./index.ts"` and then expects `register` to be a
 * top-level named export (not just `default.register`). That fix has been
 * re-landed twice (N2 and N2.v2); this test makes sure the contract doesn't
 * drift again.
 *
 * We also cover the pre-2026.4.15 loader shape (calls `activate`) and the
 * default-object shape (calls `default.register`) in the same file so a
 * loader behaviour change on either side gets caught.
 */

import { describe, it, expect, vi } from 'vitest';
import setupPlugin, { register as topLevelRegister, activate as topLevelActivate } from '../setup-entry.js';
import mainPlugin from '../index.js';

describe('setup-entry loader compatibility (v1.9.21 regression)', () => {
  it('exports top-level `register` — required by openclaw 2026.4.15 loader', () => {
    expect(typeof topLevelRegister).toBe('function');
  });

  it('exports top-level `activate` alias — required by pre-2026.4 loaders', () => {
    expect(typeof topLevelActivate).toBe('function');
  });

  it('top-level register and activate are the same function reference', () => {
    // Same reference, not a wrapper — ensures lifecycle guards in mainPlugin
    // aren't dropped by a wrapper forgetting to forward args.
    expect(topLevelActivate).toBe(topLevelRegister);
  });

  it('default export also exposes register (for loaders that look on default)', () => {
    expect(typeof setupPlugin.register).toBe('function');
  });

  it('setup-entry.register === index.register — single source of truth', () => {
    // If someone ever accidentally inlined register instead of re-exporting
    // mainPlugin.register, the two would drift.  This catches it.
    expect(setupPlugin.register).toBe(mainPlugin.register);
    expect(topLevelRegister).toBe(mainPlugin.register);
  });

  it('default export identity fields are the loader-expected shape', () => {
    expect(setupPlugin.id).toBe('prismer');
    expect(typeof setupPlugin.name).toBe('string');
    expect(typeof setupPlugin.description).toBe('string');
    expect(setupPlugin.setup).toBeDefined();
    expect(setupPlugin.setup.configSchema).toBeDefined();
  });

  it('register(api) invokes api.registerChannel exactly once', () => {
    const registerChannel = vi.fn();
    const fakeApi = { registerChannel } as any;
    topLevelRegister(fakeApi);
    expect(registerChannel).toHaveBeenCalledTimes(1);
  });

  it('calling register twice registers twice (idempotency is the caller\'s job)', () => {
    // Document current behaviour: the plugin does NOT guard against re-registration.
    // Loader compat fix did not change this contract.  If we ever want guard,
    // flip this to .toHaveBeenCalledTimes(1) and add the guard.
    const registerChannel = vi.fn();
    const fakeApi = { registerChannel } as any;
    topLevelRegister(fakeApi);
    topLevelRegister(fakeApi);
    expect(registerChannel).toHaveBeenCalledTimes(2);
  });
});

describe('setup.configSchema contract — loader reads this for config UI', () => {
  it('apiKey is required', () => {
    const schema = setupPlugin.setup.configSchema;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('apiKey');
    expect(schema.properties.apiKey.type).toBe('string');
  });

  it('baseUrl default points at prismer.cloud', () => {
    expect(setupPlugin.setup.configSchema.properties.baseUrl.default).toBe('https://prismer.cloud');
  });

  it('additionalProperties is explicitly false — loader forbids unknown keys', () => {
    expect(setupPlugin.setup.configSchema.additionalProperties).toBe(false);
  });

  it('every required key has a matching property definition', () => {
    const schema = setupPlugin.setup.configSchema;
    const required: string[] = schema.required || [];
    for (const key of required) {
      expect(schema.properties[key]).toBeDefined();
    }
  });
});

describe('Plugin manifest alignment — openclaw.plugin.json vs exports', () => {
  it('default export id matches the hardcoded "prismer" — catches rename regressions', () => {
    // The openclaw.plugin.json manifest and the plugin default export must
    // agree on `id` — the loader uses one to locate config and the other to
    // namespace events. If they diverge, account lookup breaks silently.
    expect(setupPlugin.id).toBe('prismer');
    expect(mainPlugin.id).toBe('prismer');
  });
});
