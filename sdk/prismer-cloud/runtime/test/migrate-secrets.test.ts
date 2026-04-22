import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrateSecrets } from '../src/commands/migrate-secrets.js';
import { Keychain } from '../src/keychain.js';
import type { MigrateStep } from '../src/commands/migrate-secrets.js';

// ============================================================
// Helpers
// ============================================================

function tmpToml(): string {
  return path.join(os.tmpdir(), `prismer-ms-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
}

function makeEncryptedKeychain(): { kc: Keychain; filePath: string } {
  const filePath = path.join(
    os.tmpdir(),
    `prismer-ms-kc-${Date.now()}-${Math.random().toString(36).slice(2)}.enc`,
  );
  const kc = new Keychain({
    preferredBackend: 'encrypted-file',
    masterPassphrase: 'test-migrate-passphrase',
    encryptedFilePath: filePath,
  });
  return { kc, filePath };
}

function cleanupFiles(...files: string[]): void {
  for (const f of files) {
    for (const suffix of ['', '.tmp', '.bak', '.index.json', '.index.json.tmp']) {
      try { fs.unlinkSync(f + suffix); } catch { /* ignore */ }
    }
    // Also clean up timestamped bak files
    const dir = path.dirname(f);
    const base = path.basename(f);
    try {
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        if (e.startsWith(base + '.bak.')) {
          try { fs.unlinkSync(path.join(dir, e)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

function collectSteps(): { steps: MigrateStep[]; onStep: (s: MigrateStep) => void } {
  const steps: MigrateStep[] = [];
  return { steps, onStep: (s) => steps.push(s) };
}

// ============================================================
// Tests
// ============================================================

describe('migrateSecrets', () => {
  let configPath: string;
  let kcFilePath: string;
  let kc: Keychain;

  beforeEach(() => {
    configPath = tmpToml();
    const result = makeEncryptedKeychain();
    kc = result.kc;
    kcFilePath = result.filePath;
  });

  afterEach(() => {
    cleanupFiles(configPath, kcFilePath);
  });

  // M1: plaintext apiKey matching known key name
  it('M1: apiKey with plaintext sk-prismer-* value is migrated to keychain and config rewritten', async () => {
    const apiKeyValue = 'sk-prismer-live-dea50222cb9aec9eca33f2e947d9f49dbb4a719cae8b58ce9e197290302e5f06';
    fs.writeFileSync(configPath, `apiKey = "${apiKeyValue}"\napiBase = "https://prismer.cloud"\n`, 'utf-8');

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: kc, onStep });

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('apiKey');
    expect(result.migrated[0].service).toBe('prismer-config');
    expect(result.migrated[0].account).toBe('apiKey');
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    // Keychain should have the value
    const stored = await kc.get('prismer-config', 'apiKey');
    expect(stored).toBe(apiKeyValue);

    // Config file should be rewritten with $KEYRING reference
    const rewritten = fs.readFileSync(configPath, 'utf-8');
    expect(rewritten).toContain('$KEYRING:prismer-config/apiKey');
    expect(rewritten).not.toContain(apiKeyValue);

    // Non-secret field preserved
    expect(rewritten).toContain('https://prismer.cloud');
  });

  // M2: already a $KEYRING reference → skipped
  it('M2: $KEYRING placeholder value is skipped', async () => {
    fs.writeFileSync(configPath, `apiKey = "$KEYRING:prismer-config/apiKey"\n`, 'utf-8');

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: kc, onStep });

    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe('apiKey');
    expect(result.skipped[0].reason).toContain('$KEYRING');

    const rewritten = fs.readFileSync(configPath, 'utf-8');
    expect(rewritten).toContain('$KEYRING:prismer-config/apiKey');
  });

  // M3: value matches sk-* pattern but key name is unrelated → still migrated
  it('M3: sk-* value under unrelated key name is migrated by value pattern heuristic', async () => {
    const secretValue = 'sk-openai-abcdefghijklmnopqrst12345';
    fs.writeFileSync(configPath, `modelCredential = "${secretValue}"\n`, 'utf-8');

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: kc, onStep });

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('modelCredential');

    const stored = await kc.get('prismer-config', 'modelCredential');
    expect(stored).toBe(secretValue);
  });

  // M4: nested agent config → slug uses dotted key path converted to underscores
  it('M4: nested agents.claude.token is migrated with slug agents_claude_token', async () => {
    const tokenValue = 'sk-anthropic-testtoken1234567890abcdefgh';
    fs.writeFileSync(
      configPath,
      `[agents.claude]\ntoken = "${tokenValue}"\nenabled = true\n`,
      'utf-8',
    );

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: kc, onStep });

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('agents.claude.token');
    expect(result.migrated[0].account).toBe('agents_claude_token');

    const stored = await kc.get('prismer-config', 'agents_claude_token');
    expect(stored).toBe(tokenValue);

    const rewritten = fs.readFileSync(configPath, 'utf-8');
    expect(rewritten).toContain('$KEYRING:prismer-config/agents_claude_token');
    expect(rewritten).not.toContain(tokenValue);
  });

  // M5: dry-run → no file changes, no keychain.set called
  it('M5: dry-run does not modify file or keychain', async () => {
    const secretValue = 'sk-prismer-dryrun-abcdefghijklmnopqrst';
    const originalContent = `apiKey = "${secretValue}"\n`;
    fs.writeFileSync(configPath, originalContent, 'utf-8');

    const setMock = vi.fn();
    const mockKc = {
      get: vi.fn(async () => null),
      set: setMock,
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      backend: vi.fn(),
    } as unknown as Keychain;

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: mockKc, dryRun: true, onStep });

    // Still reports as migrated (would-be)
    expect(result.migrated).toHaveLength(1);

    // keychain.set NOT called
    expect(setMock).not.toHaveBeenCalled();

    // File unchanged
    const currentContent = fs.readFileSync(configPath, 'utf-8');
    expect(currentContent).toBe(originalContent);

    // No .bak file created
    expect(fs.existsSync(configPath + '.bak')).toBe(false);
  });

  // M6: missing config file → empty result, no errors
  it('M6: missing config file returns empty result with no errors', async () => {
    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({
      configPath: '/tmp/does-not-exist-prismer-ms-xyz.toml',
      keychain: kc,
      onStep,
    });

    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const infoMsgs = steps.filter((s) => s.level === 'info').map((s) => s.message);
    expect(infoMsgs.some((m) => m.includes('no config to migrate'))).toBe(true);
  });

  // M7: backup — original saved as config.toml.bak
  it('M7: original config is backed up to config.toml.bak before rewrite', async () => {
    const secretValue = 'sk-prismer-backup-abcdefghijklmnopqrstu';
    const originalContent = `apiKey = "${secretValue}"\n`;
    fs.writeFileSync(configPath, originalContent, 'utf-8');

    const { steps, onStep } = collectSteps();
    await migrateSecrets({ configPath, keychain: kc, onStep });

    const bakPath = configPath + '.bak';
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakContent = fs.readFileSync(bakPath, 'utf-8');
    expect(bakContent).toContain(secretValue);
  });

  // M7b: second backup doesn't overwrite the first — uses timestamp suffix
  it('M7b: if .bak already exists, new backup uses timestamp suffix', async () => {
    const secretValue = 'sk-prismer-ts-bak-abcdefghijklmnopqrstu';
    const originalContent = `apiKey = "${secretValue}"\n`;
    fs.writeFileSync(configPath, originalContent, 'utf-8');

    // Pre-create a .bak file
    const bakPath = configPath + '.bak';
    fs.writeFileSync(bakPath, 'original backup content');

    await migrateSecrets({ configPath, keychain: kc });

    // The pre-existing .bak should be untouched
    expect(fs.readFileSync(bakPath, 'utf-8')).toBe('original backup content');

    // A timestamped .bak.<ts> file should exist
    const dir = path.dirname(configPath);
    const base = path.basename(configPath);
    const entries = fs.readdirSync(dir);
    const timestamped = entries.filter((e) => e.startsWith(base + '.bak.') && /\.\d+$/.test(e));
    expect(timestamped.length).toBeGreaterThanOrEqual(1);
  });

  // M8: idempotency — second run reports all as skipped
  it('M8: running migrate-secrets twice is idempotent — second run skips all', async () => {
    const secretValue = 'sk-prismer-idem-abcdefghijklmnopqrstuvw';
    fs.writeFileSync(configPath, `apiKey = "${secretValue}"\n`, 'utf-8');

    // First run
    const result1 = await migrateSecrets({ configPath, keychain: kc });
    expect(result1.migrated).toHaveLength(1);

    // Second run — config now has $KEYRING references
    const result2 = await migrateSecrets({ configPath, keychain: kc });
    expect(result2.migrated).toHaveLength(0);
    expect(result2.skipped).toHaveLength(1);
    expect(result2.skipped[0].reason).toContain('$KEYRING');
  });

  // M9: special TOML chars in secret value survive round-trip
  it('M9: special characters in secret value are stored and config round-trips correctly', async () => {
    const specialSecret = 'sk-prismer-spec-ab12345678901234567890';
    fs.writeFileSync(configPath, `apiKey = "${specialSecret}"\n`, 'utf-8');

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(1);

    const stored = await kc.get('prismer-config', 'apiKey');
    expect(stored).toBe(specialSecret);
  });

  // M10: key-name heuristic — 'password' field is migrated
  it('M10: field named "password" is migrated by key-name heuristic', async () => {
    const pw = 'my-super-secret-password-1234567890';
    fs.writeFileSync(configPath, `password = "${pw}"\n`, 'utf-8');

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('password');

    const stored = await kc.get('prismer-config', 'password');
    expect(stored).toBe(pw);
  });

  // I6: .bak file must have mode 0600
  it('I6: backup file has mode 0600 after migrateSecrets', async () => {
    const secretValue = 'sk-prismer-i6chmod-abcdefghijklmnopqrstuvwx';
    fs.writeFileSync(configPath, `apiKey = "${secretValue}"\n`, 'utf-8');

    await migrateSecrets({ configPath, keychain: kc });

    const bakPath = configPath + '.bak';
    expect(fs.existsSync(bakPath)).toBe(true);
    const mode = fs.statSync(bakPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // I7: Slack xoxb-* token is auto-migrated by value pattern
  it('I7-a: Slack xoxb-* token is migrated by value pattern', async () => {
    const slackToken = ['xoxb', '12345678901', '12345678901', 'abcdefghijklmnopqrstu'].join('-');
    fs.writeFileSync(configPath, `slackBot = "${slackToken}"\n`, 'utf-8');

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('slackBot');
    const stored = await kc.get('prismer-config', 'slackBot');
    expect(stored).toBe(slackToken);
  });

  // I7: GitHub ghp_* token is auto-migrated by value pattern
  it('I7-b: GitHub ghp_* token is migrated by value pattern', async () => {
    const ghToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456789012'].join('_');
    fs.writeFileSync(configPath, `githubToken = "${ghToken}"\n`, 'utf-8');

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('githubToken');
    const stored = await kc.get('prismer-config', 'githubToken');
    expect(stored).toBe(ghToken);
  });

  // I7: AWS AKIA* key is auto-migrated by value pattern
  it('I7-c: AWS AKIA access key ID is migrated by value pattern', async () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    fs.writeFileSync(configPath, `awsKeyId = "${awsKey}"\n`, 'utf-8');

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].path).toBe('awsKeyId');
    const stored = await kc.get('prismer-config', 'awsKeyId');
    expect(stored).toBe(awsKey);
  });

  // I7: high-entropy string emits warn step but is NOT auto-migrated
  it('I7-d: unrecognized long high-entropy string emits warn but is not migrated', async () => {
    const longString = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd'; // 40 chars, no vendor prefix
    fs.writeFileSync(configPath, `someField = "${longString}"\n`, 'utf-8');

    const { steps, onStep } = collectSteps();
    const result = await migrateSecrets({ configPath, keychain: kc, onStep });

    // Not auto-migrated
    expect(result.migrated).toHaveLength(0);
    // Warning was emitted
    const warnSteps = steps.filter((s) => s.level === 'warn');
    expect(warnSteps.length).toBeGreaterThanOrEqual(1);
    expect(warnSteps[0].message).toContain('someField');
    expect(warnSteps[0].message).toContain('migrate manually');
  });

  // M11: non-secret fields are not touched
  it('M11: non-secret scalar fields (e.g. apiBase, port) are not migrated', async () => {
    fs.writeFileSync(
      configPath,
      `apiBase = "https://prismer.cloud"\n[daemon]\nhost = "localhost"\nport = 3000\n`,
      'utf-8',
    );

    const result = await migrateSecrets({ configPath, keychain: kc });
    expect(result.migrated).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    // No rewrite since nothing was migrated (file unchanged)
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('https://prismer.cloud');
    expect(content).not.toContain('$KEYRING');
  });

  // M12: onStep receives structured events
  it('M12: onStep callback receives ok step for each migrated secret', async () => {
    const secretValue = 'sk-prismer-step-abcdefghijklmnopqrstu';
    fs.writeFileSync(configPath, `apiKey = "${secretValue}"\n`, 'utf-8');

    const { steps, onStep } = collectSteps();
    await migrateSecrets({ configPath, keychain: kc, onStep });

    const okSteps = steps.filter((s) => s.level === 'ok');
    expect(okSteps.length).toBeGreaterThanOrEqual(1);
    const migrationStep = okSteps.find((s) => s.message.includes('apiKey'));
    expect(migrationStep).toBeDefined();
  });
});
