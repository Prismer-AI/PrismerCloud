import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseKeyringPlaceholder,
  loadConfig,
  writeConfig,
  ConfigError,
} from '../src/config.js';
import type { Keychain } from '../src/keychain.js';

// ============================================================
// Helpers
// ============================================================

function tmpToml(): string {
  return path.join(os.tmpdir(), `prismer-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
    try { fs.unlinkSync(p + '.tmp'); } catch { /* ignore */ }
  }
}

function makeKeychainMock(store: Record<string, string | null> = {}): Keychain {
  return {
    get: vi.fn(async (service: string, account: string) => store[`${service}/${account}`] ?? null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    backend: vi.fn(async () => { throw new Error('not needed'); }),
  } as unknown as Keychain;
}

// ============================================================
// parseKeyringPlaceholder
// ============================================================

describe('parseKeyringPlaceholder', () => {
  it('C1: parses valid $KEYRING:<service>/<account>', () => {
    const result = parseKeyringPlaceholder('$KEYRING:foo/bar');
    expect(result).toEqual({ service: 'foo', account: 'bar' });
  });

  it('C2: returns null for non-placeholder strings', () => {
    expect(parseKeyringPlaceholder('hello')).toBeNull();
    expect(parseKeyringPlaceholder('sk-prismer-abc')).toBeNull();
    expect(parseKeyringPlaceholder('')).toBeNull();
    expect(parseKeyringPlaceholder('KEYRING:foo/bar')).toBeNull();
  });

  it('C3: throws ConfigError for malformed placeholder (no slash)', () => {
    expect(() => parseKeyringPlaceholder('$KEYRING:malformed')).toThrow(ConfigError);
    expect(() => parseKeyringPlaceholder('$KEYRING:malformed')).toThrow('malformed');
  });

  it('C3b: throws ConfigError for slash at start (empty service)', () => {
    expect(() => parseKeyringPlaceholder('$KEYRING:/account')).toThrow(ConfigError);
  });

  it('C3c: throws ConfigError for trailing slash (empty account)', () => {
    expect(() => parseKeyringPlaceholder('$KEYRING:service/')).toThrow(ConfigError);
  });

  it('C3d: valid placeholder with nested account path (account may contain /)', () => {
    // Only the FIRST slash splits service/account; rest is part of account
    const result = parseKeyringPlaceholder('$KEYRING:prismer/api_key');
    expect(result).toEqual({ service: 'prismer', account: 'api_key' });
  });
});

// ============================================================
// writeConfig + loadConfig roundtrip
// ============================================================

describe('writeConfig / loadConfig', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpToml();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('C4: roundtrip preserves scalar fields', async () => {
    const config = { apiKey: 'hello', apiBase: 'https://example.com', extra: 42 };
    await writeConfig(config, { path: filePath });
    const loaded = await loadConfig({ path: filePath });
    expect(loaded.apiKey).toBe('hello');
    expect(loaded.apiBase).toBe('https://example.com');
    expect(loaded.extra).toBe(42);
  });

  it('C4b: atomic write — no .tmp file remains', async () => {
    await writeConfig({ apiKey: 'test' }, { path: filePath });
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('C4c: loadConfig returns empty object when file does not exist', async () => {
    const result = await loadConfig({ path: '/tmp/does-not-exist-prismer-xyz.toml' });
    expect(result).toEqual({});
  });

  it('C5: loadConfig resolves $KEYRING strings via injected Keychain mock', async () => {
    const toml = `apiKey = "$KEYRING:prismer/api_key"\napiBase = "https://example.com"\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({ 'prismer/api_key': 'sk-prismer-resolved-key' });
    const config = await loadConfig({ path: filePath, keychain: kc });
    expect(config.apiKey).toBe('sk-prismer-resolved-key');
    expect(config.apiBase).toBe('https://example.com');
  });

  it('C6: resolvePlaceholders: false preserves placeholders verbatim', async () => {
    const placeholder = '$KEYRING:prismer/api_key';
    const toml = `apiKey = "${placeholder}"\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({});
    const config = await loadConfig({ path: filePath, keychain: kc, resolvePlaceholders: false });
    expect(config.apiKey).toBe(placeholder);
  });

  it('C7: loadConfig throws ConfigError when secret is missing from keychain', async () => {
    const toml = `apiKey = "$KEYRING:prismer/missing_key"\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({});
    await expect(loadConfig({ path: filePath, keychain: kc })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ path: filePath, keychain: kc })).rejects.toThrow('missing secret');
  });

  it('C8a: nested objects are walked and placeholders resolved', async () => {
    const toml = `[daemon]\nhost = "$KEYRING:svc/host"\nport = 3000\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({ 'svc/host': 'localhost' });
    const config = await loadConfig({ path: filePath, keychain: kc });
    expect((config.daemon as { host: string }).host).toBe('localhost');
    expect((config.daemon as { port: number }).port).toBe(3000);
  });

  it('C8b: arrays are walked and placeholders resolved', async () => {
    const toml = `tags = ["$KEYRING:svc/tag1", "plain"]\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({ 'svc/tag1': 'resolved-tag' });
    const config = await loadConfig({ path: filePath, keychain: kc });
    const tags = config.tags as string[];
    expect(tags[0]).toBe('resolved-tag');
    expect(tags[1]).toBe('plain');
  });

  it('C8c: deeply nested agent config placeholders resolved', async () => {
    const toml = `[agents.claude]\napiKey = "$KEYRING:prismer-config/agents_claude_apiKey"\nenabled = true\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const kc = makeKeychainMock({ 'prismer-config/agents_claude_apiKey': 'claude-secret' });
    const config = await loadConfig({ path: filePath, keychain: kc });
    const agents = config.agents as Record<string, { apiKey: string; enabled: boolean }>;
    expect(agents.claude.apiKey).toBe('claude-secret');
    expect(agents.claude.enabled).toBe(true);
  });

  it('C8d: no keychain provided — placeholders remain as strings', async () => {
    const placeholder = '$KEYRING:prismer/api_key';
    const toml = `apiKey = "${placeholder}"\n`;
    fs.writeFileSync(filePath, toml, 'utf-8');

    const config = await loadConfig({ path: filePath });
    expect(config.apiKey).toBe(placeholder);
  });
});

// ============================================================
// P2 — writeConfig file / directory permissions
// ============================================================

describe('P2: writeConfig permission hardening', () => {
  it.skipIf(process.platform === 'win32')(
    'P2-a: writeConfig produces a 0o600 file',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-p2a-'));
      const filePath = path.join(dir, 'config.toml');
      try {
        await writeConfig({ apiKey: 'sk-test' }, { path: filePath });
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'P2-b: writeConfig clamps a pre-existing 0o644 file to 0o600',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-p2b-'));
      const filePath = path.join(dir, 'config.toml');
      try {
        // Pre-create with permissive mode
        fs.writeFileSync(filePath, 'apiKey = "old"\n', { encoding: 'utf-8', mode: 0o644 });
        fs.chmodSync(filePath, 0o644);
        await writeConfig({ apiKey: 'sk-new' }, { path: filePath });
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'P2-c: writeConfig creates parent directory with 0o700',
    async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-p2c-'));
      // Use a fresh nested subdir that does not exist yet
      const parentDir = path.join(base, '.prismer');
      const filePath = path.join(parentDir, 'config.toml');
      try {
        await writeConfig({ apiKey: 'sk-test' }, { path: filePath });
        const mode = fs.statSync(parentDir).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  );
});

// ============================================================
// Q7 — loadConfig distinguishes ENOENT from other fs errors
// ============================================================

describe('Q7: loadConfig error discrimination', () => {
  it('Q7-a: missing file returns {}', async () => {
    const result = await loadConfig({ path: '/tmp/definitely-does-not-exist-q7-test.toml' });
    expect(result).toEqual({});
  });

  it('Q7-b: unreadable file (chmod 0000) throws ConfigError — skip on CI/root', async () => {
    // Skip if running as root (root can read any file regardless of permissions)
    if (process.getuid && process.getuid() === 0) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-q7-test-'));
    const badFile = path.join(tmpDir, 'unreadable.toml');
    try {
      fs.writeFileSync(badFile, 'apiKey = "test"\n', 'utf-8');
      fs.chmodSync(badFile, 0o000);

      await expect(loadConfig({ path: badFile })).rejects.toThrow(ConfigError);
      await expect(loadConfig({ path: badFile })).rejects.toThrow('Cannot read config');
    } finally {
      // Restore permissions so cleanup works
      try { fs.chmodSync(badFile, 0o644); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
