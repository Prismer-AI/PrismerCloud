/**
 * bugfix211 G2 — ConfigDelivery container classification.
 *
 * The pre-fix discriminator (`RUNTIME_MODE=container && ALLOW_FAKE=true`)
 * keyed off an IMAGE-level default shared by ACS checkpoints and workspace
 * k8s pods, so workspace pods holding a real cloud-minted key were treated
 * as keyless sandboxes (env-inference blocked, "ACS sandbox detected" log).
 * The authoritative signal is the env key itself.
 */
import { describe, expect, it } from 'vitest';
import { containerEnvIsKeyless } from '../src/daemon/runner.js';

const REAL_KEY = 'sk-prismer-live-' + 'a'.repeat(64); // Format-only fixture, never an issued key.

describe('containerEnvIsKeyless (ConfigDelivery classification, bugfix211 G2)', () => {
  it('workspace k8s pod with a real key + lying image ALLOW_FAKE=true → NOT keyless (env-inference allowed)', () => {
    expect(
      containerEnvIsKeyless({
        PRISMER_RUNTIME_MODE: 'container',
        PRISMER_ALLOW_FAKE_API_KEY: 'true', // image default leaks in
        PRISMER_API_KEY: REAL_KEY,
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('ACS checkpoint boot (container, no key at all) → keyless (strict B1-wait)', () => {
    expect(
      containerEnvIsKeyless({
        PRISMER_RUNTIME_MODE: 'container',
        PRISMER_ALLOW_FAKE_API_KEY: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('container with a legacy placeholder / non-conforming key → keyless (fail toward strict B1)', () => {
    expect(
      containerEnvIsKeyless({
        PRISMER_RUNTIME_MODE: 'container',
        PRISMER_API_KEY: 'dev-placeholder-key',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('non-container (desktop / local daemon) → never keyless, regardless of keys', () => {
    expect(containerEnvIsKeyless({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      containerEnvIsKeyless({ PRISMER_API_KEY: '' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('explicit pod-spec ALLOW_FAKE=false with a real key → not keyless (belt and braces)', () => {
    expect(
      containerEnvIsKeyless({
        PRISMER_RUNTIME_MODE: 'container',
        PRISMER_ALLOW_FAKE_API_KEY: 'false',
        PRISMER_API_KEY: REAL_KEY,
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
