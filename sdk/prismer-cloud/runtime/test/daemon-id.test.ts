// F14 (2026-05-20) — daemon-id stability tests.
//
// Same (hostname, apiKey) → same daemonId → cloud-side host.declare upsert
// dedupes the IMContainer row instead of accumulating one per fresh setup.
// This is the root-cause fix for the "Devices page shows 25+ rows for one
// physical Mac" symptom.

import { describe, expect, it } from 'vitest';
import { isDaemonId, newDaemonId } from '../src/daemon-id.js';

describe('newDaemonId', () => {
  it('isDaemonId recognises the daemon- prefix', () => {
    expect(isDaemonId('daemon-MyMac-abc123def456')).toBe(true);
    expect(isDaemonId('something-else')).toBe(false);
    expect(isDaemonId('daemon-')).toBe(false); // prefix only — no suffix
  });

  describe('stable mode (apiKey provided)', () => {
    it('same (hostname, apiKey) yields identical daemonId every call', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test-1', hostnameOverride: 'MyMac' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test-1', hostnameOverride: 'MyMac' });
      expect(a).toBe(b);
      expect(a).toMatch(/^daemon-MyMac-[a-f0-9]{12}$/);
    });

    it('different apiKey yields different daemonId on the same host', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test-A', hostnameOverride: 'MyMac' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test-B', hostnameOverride: 'MyMac' });
      expect(a).not.toBe(b);
    });

    it('different hostname yields different daemonId with the same key', () => {
      const a = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'MacA' });
      const b = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'MacB' });
      expect(a).not.toBe(b);
    });

    it('embeds the host segment so the id stays readable', () => {
      const id = newDaemonId({ apiKey: 'sk-prismer-test', hostnameOverride: 'Prismer-de-Studio' });
      expect(id).toMatch(/^daemon-Prismer-de-Studio-[a-f0-9]{12}$/);
    });
  });

  describe('legacy random mode (no apiKey)', () => {
    it('yields a fresh random suffix every call when apiKey is absent', () => {
      const a = newDaemonId();
      const b = newDaemonId();
      expect(a).not.toBe(b); // random — should differ with overwhelming probability
      expect(a).toMatch(/^daemon-.+-[a-f0-9]{12}$/);
    });
  });
});
