import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configExists, deriveWsUrl, loadConfig, resolvePaths, saveConfig, type Config } from '../src/config.js';

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-test-'));
  return dir;
}

describe('config round-trip', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it('configExists returns false on empty home', () => {
    const home = tmpHome();
    cleanup.push(home);
    expect(configExists(resolvePaths(home))).toBe(false);
  });

  it('saveConfig + loadConfig round-trips', () => {
    const home = tmpHome();
    cleanup.push(home);
    const paths = resolvePaths(home);
    const cfg: Config = {
      api_key: 'sk-prismer-test',
      cloud_api_base: 'http://127.0.0.1:3000',
      daemon_id: 'daemon-abc',
    };
    saveConfig(cfg, paths);
    expect(configExists(paths)).toBe(true);
    const loaded = loadConfig(paths);
    expect(loaded).toEqual(cfg);
  });

  it('rejects invalid config (missing api_key)', () => {
    const home = tmpHome();
    cleanup.push(home);
    const paths = resolvePaths(home);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.configFile, 'cloud_api_base = "http://x"\ndaemon_id = "x"\n');
    expect(() => loadConfig(paths)).toThrow(/api_key/);
  });

  it('env vars override file values', () => {
    const home = tmpHome();
    cleanup.push(home);
    const paths = resolvePaths(home);
    saveConfig(
      { api_key: 'old', cloud_api_base: 'http://old', daemon_id: 'd1' },
      paths,
    );
    process.env.PRISMER_API_KEY = 'new';
    process.env.PRISMER_BASE_URL = 'http://new.example';
    try {
      const loaded = loadConfig(paths);
      expect(loaded.api_key).toBe('new');
      expect(loaded.cloud_api_base).toBe('http://new.example');
    } finally {
      delete process.env.PRISMER_API_KEY;
      delete process.env.PRISMER_BASE_URL;
    }
  });
});

describe('deriveWsUrl', () => {
  it('http → ws + /ws', () => {
    expect(deriveWsUrl('http://127.0.0.1:3000')).toBe('ws://127.0.0.1:3000/ws');
  });

  it('https → wss + /ws', () => {
    expect(deriveWsUrl('https://cloud.prismer.dev')).toBe('wss://cloud.prismer.dev/ws');
  });

  it('strips trailing slash', () => {
    expect(deriveWsUrl('http://x:3000/')).toBe('ws://x:3000/ws');
  });
});
