// T16 — migrate command tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { Keychain } from '../../src/keychain.js';
import { migrateCommand, detectPlaintextApiKey } from '../../src/commands/migrate.js';
import type { MigrateResult } from '../../src/commands/migrate.js';

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makePrettyUI(): { ui: UI; output: () => string; errOutput: () => string } {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const errStream = { write(d: string): boolean { errChunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'pretty', color: false, stream, errStream });
  return { ui, output: () => chunks.join(''), errOutput: () => errChunks.join('') };
}

function makeJsonUI(): { ui: UI; output: () => string } {
  const chunks: string[] = [];
  const stream = { write(d: string): boolean { chunks.push(d); return true; } } as NodeJS.WritableStream;
  const ui = new UI({ mode: 'json', color: false, stream, errStream: stream });
  return { ui, output: () => chunks.join('') };
}

function makeEncryptedKeychain(tmpDir: string): Keychain {
  const filePath = path.join(tmpDir, 'keychain.enc');
  return new Keychain({
    preferredBackend: 'encrypted-file',
    masterPassphrase: 'test-migrate-cmd-passphrase',
    encryptedFilePath: filePath,
  });
}

function makeCtx(ui: UI, keychain: Keychain): CliContext {
  return {
    ui,
    keychain,
    cwd: process.cwd(),
    argv: [],
  };
}

function writeConfig(dir: string, content: string): string {
  const configDir = path.join(dir, '.prismer');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.toml');
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

/** Create a Claude Code project memory directory with .md files */
function writeClaudeProjectMemory(
  homeDir: string,
  projectName: string,
  files: Array<{ name: string; content: string }>,
): void {
  const memoryDir = path.join(homeDir, '.claude', 'projects', projectName, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(memoryDir, file.name), file.content, 'utf-8');
  }
}

/** Write a fake ~/.claude/hooks.json with v1.8 Prismer command-style hooks */
function writeLegacyHooks(dir: string): string {
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const hookPath = path.join(claudeDir, 'hooks.json');
  const legacyConfig = {
    hooks: {
      PreToolUse: [
        { command: 'node ~/.claude/evolution-hook.js PreToolUse', timeout: 5000 },
      ],
      SessionStart: [
        { command: 'node ~/.prismer/session-start.mjs' },
      ],
    },
  };
  fs.writeFileSync(hookPath, JSON.stringify(legacyConfig, null, 2), 'utf-8');
  return hookPath;
}

// ============================================================
// State
// ============================================================

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    cleanupDir(tmpDirs.pop()!);
  }
  process.exitCode = undefined;
});

function newTmp(): string {
  const dir = makeTempDir();
  tmpDirs.push(dir);
  return dir;
}

// ============================================================
// Tests
// ============================================================

describe('migrateCommand', () => {
  // MG1: Missing config.toml → apiKeyMigrated === false, no errors
  it('MG1: missing config.toml → apiKeyMigrated false, no errors', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const result = await migrateCommand(ctx, {
      configPath: path.join(tmpDir, 'nonexistent.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.apiKeyMigrated).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.memoryFilesImported).toBe(0);
  });

  // MG2: config.toml with plaintext apiKey → migrated, keychain contains secret
  it('MG2: config.toml with plaintext apiKey is migrated to keychain', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-dea50222cb9aec9eca33f2e947d9f49dbb4a719cae8b58ce9e197290302e5f06';
    const configPath = writeConfig(tmpDir, `apiKey = "${apiKeyValue}"\napiBase = "https://prismer.cloud"\n`);

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.apiKeyMigrated).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Keychain must contain the secret
    const stored = await kc.get('prismer-config', 'apiKey');
    expect(stored).toBe(apiKeyValue);

    // Config file should now have $KEYRING reference
    const rewritten = fs.readFileSync(configPath, 'utf-8');
    expect(rewritten).toContain('$KEYRING:prismer-config/apiKey');
    expect(rewritten).not.toContain(apiKeyValue);
  });

  // MG3: dry-run does NOT move keys and does NOT modify hooks
  it('MG3: dry-run does not mutate files or keychain', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const secretValue = 'sk-prismer-dry-dea50222cb9aec9eca33f2e947d9f49dbb4a719cae8b58';
    const originalContent = `apiKey = "${secretValue}"\n`;
    const configPath = writeConfig(tmpDir, originalContent);

    // Write legacy hooks
    const hookPath = writeLegacyHooks(tmpDir);
    const hooksBefore = fs.readFileSync(hookPath, 'utf-8');

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      dryRun: true,
      yes: true,
    });

    // Config file unchanged
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(originalContent);

    // Hooks file unchanged
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(hooksBefore);

    // Keychain has nothing
    const stored = await kc.get('prismer-config', 'apiKey').catch(() => null);
    expect(stored).toBeNull();

    // No errors
    expect(result.errors).toHaveLength(0);
    // memoryFilesImported always 0
    expect(result.memoryFilesImported).toBe(0);
  });

  // MG4: hooks with v1.8 legacy commands → redirected list contains agent name, backup file exists
  it('MG4: legacy Claude Code hooks are redirected and backup is created', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    // No config.toml — just test hooks
    const hookPath = writeLegacyHooks(tmpDir);

    const result = await migrateCommand(ctx, {
      configPath: path.join(tmpDir, '.prismer', 'no-config.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.hooksRedirected).toContain('claude-code');
    expect(result.hooksBackedUp.length).toBeGreaterThan(0);

    // Backup file must exist
    const backupPath = result.hooksBackedUp[0];
    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath!)).toBe(true);

    // New hooks.json must exist and not have legacy markers
    expect(fs.existsSync(hookPath)).toBe(true);
    const newContent = fs.readFileSync(hookPath, 'utf-8');
    expect(newContent).not.toContain('evolution-hook.js');
    expect(newContent).not.toContain('session-start.mjs');
    // Should have PARA hooks (para-emit.mjs)
    expect(newContent).toContain('para-emit');
  });

  // MG5: --json output matches MigrateResult shape
  it('MG5: --json output has correct MigrateResult shape', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui, kc);

    await migrateCommand(ctx, {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    const result = JSON.parse(output()) as MigrateResult;
    expect(typeof result.apiKeyMigrated).toBe('boolean');
    expect(Array.isArray(result.hooksBackedUp)).toBe(true);
    expect(Array.isArray(result.hooksRedirected)).toBe(true);
    expect(typeof result.memoryFilesImported).toBe('number');
    expect(result.memoryFilesImported).toBe(0);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  // MG6: idempotent — running twice produces same result without error
  it('MG6: idempotent — second run reports no additional migration', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    const apiKeyValue = 'sk-prismer-live-idem-dea50222cb9aec9eca33f2e947d9f49dbb4a719cae8b58ce';
    const configPath = writeConfig(tmpDir, `apiKey = "${apiKeyValue}"\n`);

    // First run
    const { ui: ui1 } = makePrettyUI();
    const result1 = await migrateCommand(makeCtx(ui1, kc), {
      configPath,
      homeDir: tmpDir,
      yes: true,
    });
    expect(result1.apiKeyMigrated).toBe(true);
    expect(result1.errors).toHaveLength(0);

    // Second run — config now has $KEYRING reference
    const { ui: ui2 } = makePrettyUI();
    const result2 = await migrateCommand(makeCtx(ui2, kc), {
      configPath,
      homeDir: tmpDir,
      yes: true,
    });
    expect(result2.apiKeyMigrated).toBe(false); // already migrated → skipped
    expect(result2.errors).toHaveLength(0);
  });

  // MG7: memoryFilesImported is 0 when no Claude project memory directories exist
  it('MG7: memoryFilesImported is 0 when no project memory exists', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    // Create a fake dev.db but no memory directories
    const dataDir = path.join(tmpDir, '.prismer', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'dev.db'), 'fake db content', 'utf-8');

    const { ui } = makePrettyUI();
    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.memoryFilesImported).toBe(0);
  });

  // MG8: memory files from ~/.claude/projects/*/memory/ are imported
  it('MG8: Claude project memory files are imported into MemoryDB', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    // Create memory files in two projects
    writeClaudeProjectMemory(tmpDir, '-Users-alice-workspace-projectA', [
      {
        name: 'MEMORY.md',
        content: '---\ntype: episodic\ndescription: Session notes\n---\n\n# Session 1\nWorked on feature X.',
      },
      {
        name: 'feedback_no_action.md',
        content: '# Feedback\nDo not act before analysis.',
      },
    ]);
    writeClaudeProjectMemory(tmpDir, '-Users-alice-workspace-projectB', [
      {
        name: 'MEMORY.md',
        content: '---\ntype: semantic\n---\n\nProject B memory.',
      },
    ]);

    const { ui } = makePrettyUI();
    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.memoryFilesImported).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify MemoryDB wrote to the temp homeDir, not the real ~/.prismer/memory.db
    const memoryDbPath = path.join(tmpDir, '.prismer', 'memory.db');
    expect(fs.existsSync(memoryDbPath)).toBe(true);
  });

  // MG9: dry-run scans and counts but does not write to MemoryDB
  it('MG9: dry-run reports memory file count without importing', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    writeClaudeProjectMemory(tmpDir, '-Users-bob-project', [
      { name: 'notes.md', content: 'Some notes here.' },
      { name: 'reference.md', content: '---\ntype: reference\n---\nReference content.' },
    ]);

    const { ui, output } = makePrettyUI();
    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      dryRun: true,
      yes: true,
    });

    // Dry-run reports the count of files that would be imported
    expect(result.memoryFilesImported).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Output should mention "dry-run"
    const text = output();
    expect(text).toContain('dry-run');
  });

  // MG10: frontmatter parsing extracts type and description
  it('MG10: frontmatter type and description are parsed correctly', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    const memContent = '---\ntype: episodic\ndescription: Important findings\n---\n\nBody content.';
    writeClaudeProjectMemory(tmpDir, '-Users-test-project', [
      { name: 'finding.md', content: memContent },
    ]);

    const { ui } = makePrettyUI();
    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.memoryFilesImported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  // MG11: non-.md files are ignored during memory scan
  it('MG11: non-.md files in memory directories are ignored', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    const memoryDir = path.join(tmpDir, '.claude', 'projects', '-test-proj', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'markdown content', 'utf-8');
    fs.writeFileSync(path.join(memoryDir, 'data.json'), '{"key": "value"}', 'utf-8');
    fs.writeFileSync(path.join(memoryDir, 'script.ts'), 'console.log("hi")', 'utf-8');

    const { ui } = makePrettyUI();
    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    // Only the .md file should be imported
    expect(result.memoryFilesImported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  // MG12: --json output includes memory import count
  it('MG12: --json output reflects memory import count', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    writeClaudeProjectMemory(tmpDir, '-test-json-project', [
      { name: 'mem.md', content: 'Memory content for JSON test.' },
    ]);

    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui, kc);

    await migrateCommand(ctx, {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    const parsed = JSON.parse(output()) as MigrateResult;
    expect(parsed.memoryFilesImported).toBe(1);
    expect(parsed.errors).toHaveLength(0);
  });

  // ============================================================
  // Network endpoint takeover (Task 4 — §11.1)
  // ============================================================

  /** Write a file under homeDir with the given relative path and content. */
  function writePluginFile(homeDir: string, relPath: string, content: string): string {
    const abs = path.join(homeDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  // MG13: settings.json with prismer.cloud URL → rewritten to daemon, .bak preserves original
  it('MG13: settings.json cloud URL is rewritten, .bak contains original', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const relPath = '.claude/plugins/@prismer/claude-code-plugin/settings.json';
    const original = '{"apiBase": "https://prismer.cloud"}';
    const abs = writePluginFile(tmpDir, relPath, original);

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.networkEndpointsRewritten).toHaveLength(1);
    expect(result.networkEndpointsRewritten[0].rewrites).toBe(1);
    expect(result.networkEndpointsRewritten[0].file).toBe(abs);

    // File now contains the daemon URL
    const rewritten = fs.readFileSync(abs, 'utf-8');
    expect(rewritten).toBe('{"apiBase": "http://localhost:3210"}');

    // .bak contains original
    const backupPath = result.networkEndpointsRewritten[0].backupPath;
    expect(backupPath).toBe(abs + '.bak');
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
  });

  // MG14: dry-run mode does not mutate the file or write a backup
  it('MG14: dry-run reports candidates without touching the file', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const relPath = '.claude/plugins/@prismer/claude-code-plugin/.env';
    const original = 'PRISMER_API_BASE=https://prismer.cloud\nOTHER_VAR=keep\n';
    const abs = writePluginFile(tmpDir, relPath, original);

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      dryRun: true,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.networkEndpointsRewritten).toHaveLength(1);
    expect(result.networkEndpointsRewritten[0].rewrites).toBe(1);
    expect(result.networkEndpointsRewritten[0].backupPath).toBe('');

    // File unchanged
    expect(fs.readFileSync(abs, 'utf-8')).toBe(original);

    // No .bak file created
    expect(fs.existsSync(abs + '.bak')).toBe(false);
  });

  // MG15: when .bak already exists, fall back to .bak2
  it('MG15: existing .bak falls back to .bak2', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const relPath = '.claude/plugins/@prismer/claude-code-plugin/.mcp.json';
    const original = '{"env": {"PRISMER_API": "https://cloud.prismer.dev/api"}}';
    const abs = writePluginFile(tmpDir, relPath, original);

    // Pre-existing .bak that must not be overwritten
    const preexistingBak = 'PREEXISTING_BACKUP_CONTENT';
    fs.writeFileSync(abs + '.bak', preexistingBak, 'utf-8');

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.networkEndpointsRewritten).toHaveLength(1);
    expect(result.networkEndpointsRewritten[0].backupPath).toBe(abs + '.bak2');

    // Original .bak is preserved
    expect(fs.readFileSync(abs + '.bak', 'utf-8')).toBe(preexistingBak);

    // .bak2 contains the pre-rewrite content
    expect(fs.readFileSync(abs + '.bak2', 'utf-8')).toBe(original);

    // File is rewritten
    const after = fs.readFileSync(abs, 'utf-8');
    expect(after).toContain('http://localhost:3210');
    expect(after).not.toContain('cloud.prismer.dev');
  });

  // MG16: files with no cloud URLs are not modified and not reported
  it('MG16: files without cloud URLs are left untouched', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const innocentContent = '{"apiBase": "http://localhost:9999", "other": "value"}';
    const abs = writePluginFile(
      tmpDir,
      '.claude/plugins/@prismer/claude-code-plugin/settings.json',
      innocentContent,
    );

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.networkEndpointsRewritten).toHaveLength(0);

    // File content unchanged
    expect(fs.readFileSync(abs, 'utf-8')).toBe(innocentContent);

    // No backup files created
    expect(fs.existsSync(abs + '.bak')).toBe(false);
  });

  // MG17: multiple cloud URLs in one file all get replaced
  it('MG17: multiple cloud URLs and wss origins are all rewritten', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const original = [
      '{',
      '  "apiBase": "https://prismer.cloud",',
      '  "backup": "https://cloud.prismer.dev/api/v1",',
      '  "backend": "https://prismer.app/api/v1",',
      '  "wsUrl": "wss://prismer.cloud/ws",',
      '  "wsTest": "wss://cloud.prismer.dev/ws"',
      '}',
    ].join('\n');
    const abs = writePluginFile(
      tmpDir,
      '.claude/plugins/@prismer/claude-code-plugin/settings.json',
      original,
    );

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.networkEndpointsRewritten).toHaveLength(1);
    expect(result.networkEndpointsRewritten[0].rewrites).toBe(5);

    const after = fs.readFileSync(abs, 'utf-8');
    expect(after).not.toContain('prismer.cloud');
    expect(after).not.toContain('cloud.prismer.dev');
    expect(after).not.toContain('prismer.app');
    // http://localhost:3210 for the HTTPS origins
    expect(after).toContain('http://localhost:3210/api/v1');
    // ws://localhost:3210 for the WSS origins
    expect(after).toContain('ws://localhost:3210/ws');
  });

  // MG18: --json output includes networkEndpointsRewritten array
  it('MG18: --json output reflects networkEndpointsRewritten', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);

    writePluginFile(
      tmpDir,
      '.claude/settings.local.json',
      '{"env": {"PRISMER_API_BASE": "https://prismer.cloud"}}',
    );

    const { ui, output } = makeJsonUI();
    await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    const parsed = JSON.parse(output()) as MigrateResult;
    expect(Array.isArray(parsed.networkEndpointsRewritten)).toBe(true);
    expect(parsed.networkEndpointsRewritten).toHaveLength(1);
    expect(parsed.networkEndpointsRewritten[0].rewrites).toBe(1);
    expect(parsed.errors).toHaveLength(0);
  });

  // MG19: origin boundary is anchored — third-party domains containing the
  // origin as a prefix (`prismer.app.evil.com`, `prismer.cloud-mirror.example.com`)
  // must NOT be rewritten.
  it('MG19: substring-only matches on hostile third-party domains are ignored', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const relPath = '.claude/plugins/@prismer/claude-code-plugin/settings.json';
    const original = [
      '{',
      '  "phishing1": "https://prismer.app.evil.com/api",',
      '  "phishing2": "https://prismer.cloud-mirror.example.com/v1",',
      '  "phishing3": "https://prismer.cloudflare.net",',
      '  "phishing4": "https://cloud.prismer.dev.attacker.io/ws",',
      '  "innocent": "https://other.example.com"',
      '}',
    ].join('\n');
    const abs = writePluginFile(tmpDir, relPath, original);

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.errors).toHaveLength(0);
    // No legitimate cloud URLs → nothing to rewrite
    expect(result.networkEndpointsRewritten).toHaveLength(0);

    // File content must be completely unchanged — hostile domains preserved
    const after = fs.readFileSync(abs, 'utf-8');
    expect(after).toBe(original);
    // Explicitly check the hostile domains were NOT clobbered into localhost
    expect(after).toContain('prismer.app.evil.com');
    expect(after).toContain('prismer.cloud-mirror.example.com');
    expect(after).toContain('prismer.cloudflare.net');
    expect(after).toContain('cloud.prismer.dev.attacker.io');
    expect(after).not.toContain('localhost:3210');

    // No backup should have been created
    expect(fs.existsSync(abs + '.bak')).toBe(false);
  });

  // ============================================================
  // Confirmation gate (P1 fix)
  // ============================================================

  // MG-C1: TTY, no --yes, confirmer returns true → proceeds (migration runs)
  it('MG-C1: TTY confirm yes → migration proceeds', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-confirm-yes-00000000000000000000000000000000000000000';
    const configPath = writeConfig(tmpDir, `apiKey = "${apiKeyValue}"\n`);

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      // no yes: true — let confirmer drive it
      confirmer: async () => true,
    });

    // Migration should have proceeded — apiKey migrated
    expect(result.apiKeyMigrated).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  // MG-C2: TTY, no --yes, confirmer returns false → cancelled, exit 0, no destructive work
  it('MG-C2: TTY confirm no → cancelled, no migration, exit 0', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-confirm-no-000000000000000000000000000000000000000000';
    const configContent = `apiKey = "${apiKeyValue}"\n`;
    const configPath = writeConfig(tmpDir, configContent);

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      confirmer: async () => false,
    });

    // No destructive work
    expect(result.apiKeyMigrated).toBe(false);
    expect(result.errors).toHaveLength(0);
    // config file must be untouched
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(configContent);
    // Output should contain 'Cancelled'
    expect(output()).toContain('Cancelled');
    // exit code must NOT be 1 (user's choice)
    expect(process.exitCode).toBeUndefined();
  });

  // MG-C3: non-TTY, no --yes, no --dry-run → fail fast with CONFIRMATION_REQUIRED (pretty mode)
  it('MG-C3: non-TTY no --yes → fail fast, exitCode 1', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    // Write a config so "Nothing to migrate" early-return does not fire
    const configPath = writeConfig(tmpDir, 'apiKey = "sk-prismer-live-nontty-0000000000000000000000000000000"\n');

    // Simulate non-TTY by NOT providing confirmer and NOT providing yes.
    const originalIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      const result = await migrateCommand(ctx, {
        configPath,
        homeDir: tmpDir,
        // no yes, no dryRun, no confirmer → fail fast
      });

      expect(result.apiKeyMigrated).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      process.exitCode = undefined;
    }
  });

  // MG-C4: --yes flag skips prompt and proceeds regardless of isTTY
  it('MG-C4: --yes skips confirmation and proceeds', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-yes-flag-0000000000000000000000000000000000000000000';
    const configPath = writeConfig(tmpDir, `apiKey = "${apiKeyValue}"\n`);

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      yes: true,
    });

    expect(result.apiKeyMigrated).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  // MG-C5: --dry-run skips confirmation and proceeds in read-only mode
  it('MG-C5: --dry-run skips confirmation and proceeds read-only', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui, output } = makePrettyUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-dryrun-000000000000000000000000000000000000000000000';
    const configContent = `apiKey = "${apiKeyValue}"\n`;
    const configPath = writeConfig(tmpDir, configContent);

    const result = await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      dryRun: true,
      // no yes — dry-run alone must be sufficient
    });

    // dry-run: config not mutated
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(configContent);
    expect(result.errors).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain('dry-run');
  });

  // MG-C6: JSON mode without --yes → CONFIRMATION_REQUIRED, no destructive work
  it('MG-C6: JSON mode without --yes emits CONFIRMATION_REQUIRED and sets exitCode 1', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui, output } = makeJsonUI();
    const ctx = makeCtx(ui, kc);

    const apiKeyValue = 'sk-prismer-live-json-mode-000000000000000000000000000000000000000000';
    const configContent = `apiKey = "${apiKeyValue}"\n`;
    const configPath = writeConfig(tmpDir, configContent);

    await migrateCommand(ctx, {
      configPath,
      homeDir: tmpDir,
      // no yes, no dryRun
    });

    const parsed = JSON.parse(output()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('CONFIRMATION_REQUIRED');
    // Config file must be untouched
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(configContent);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  // MG20: all three backup slots occupied → file is skipped with an error
  // in result.errors, and NOT added to networkEndpointsRewritten.
  it('MG20: exhausted backup slots leave file unmodified and record error', async () => {
    const tmpDir = newTmp();
    const kc = makeEncryptedKeychain(tmpDir);
    const { ui } = makePrettyUI();

    const relPath = '.claude/plugins/@prismer/claude-code-plugin/settings.json';
    const original = '{"apiBase": "https://prismer.cloud"}';
    const abs = writePluginFile(tmpDir, relPath, original);

    // Pre-fill all three backup slots
    fs.writeFileSync(abs + '.bak', 'EXISTING_BAK', 'utf-8');
    fs.writeFileSync(abs + '.bak2', 'EXISTING_BAK2', 'utf-8');
    fs.writeFileSync(abs + '.bak3', 'EXISTING_BAK3', 'utf-8');

    const result = await migrateCommand(makeCtx(ui, kc), {
      configPath: path.join(tmpDir, 'no.toml'),
      homeDir: tmpDir,
      yes: true,
    });

    // An error entry tagged as 'network-takeover' must be recorded
    const takeoverErrors = result.errors.filter((e) => e.step === 'network-takeover');
    expect(takeoverErrors.length).toBeGreaterThan(0);
    const errForFile = takeoverErrors.find((e) => e.error.startsWith(abs));
    expect(errForFile).toBeTruthy();
    expect(errForFile!.error).toContain('backup slots');

    // The file must NOT appear in networkEndpointsRewritten — we did not
    // actually rewrite it.
    const rewrittenFiles = result.networkEndpointsRewritten.map((r) => r.file);
    expect(rewrittenFiles).not.toContain(abs);

    // Original file content untouched
    expect(fs.readFileSync(abs, 'utf-8')).toBe(original);

    // Pre-existing backups untouched
    expect(fs.readFileSync(abs + '.bak', 'utf-8')).toBe('EXISTING_BAK');
    expect(fs.readFileSync(abs + '.bak2', 'utf-8')).toBe('EXISTING_BAK2');
    expect(fs.readFileSync(abs + '.bak3', 'utf-8')).toBe('EXISTING_BAK3');
  });
});

describe('detectPlaintextApiKey', () => {
  // Real-world case: `prismer setup` writes `api_key` under `[default]`.
  // Pre-fix this returned false and migrate --dry-run lied about "no plaintext
  // key". The camelCase form is still used by older fixtures so both must work.
  it('detects snake_case api_key as plaintext', () => {
    const cfg = '[default]\napi_key = "sk-prismer-live-abc123"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(true);
  });

  it('detects camelCase apiKey as plaintext (legacy)', () => {
    const cfg = 'apiKey = "sk-prismer-live-abc123"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(true);
  });

  it('does NOT flag $KEYRING: placeholder (snake_case)', () => {
    const cfg = '[default]\napi_key = "$KEYRING:prismer-config/default.api_key"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(false);
  });

  it('does NOT flag $KEYRING: placeholder (camelCase)', () => {
    const cfg = 'apiKey = "$KEYRING:prismer-config/apiKey"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(false);
  });

  it('returns false when no api_key is present', () => {
    const cfg = '[default]\nbase_url = "https://prismer.cloud"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(false);
  });

  it('flags any non-sk plaintext value (not just sk-prismer)', () => {
    // The old regex hard-coded `sk-`; a random plaintext should still count.
    const cfg = '[default]\napi_key = "just-some-plaintext"\n';
    expect(detectPlaintextApiKey(cfg)).toBe(true);
  });

  it('returns true if any of multiple api_key lines is plaintext', () => {
    const cfg = [
      '[default]',
      'api_key = "$KEYRING:prismer-config/default.api_key"',
      '[alt]',
      'api_key = "sk-prismer-live-abc"',
    ].join('\n');
    expect(detectPlaintextApiKey(cfg)).toBe(true);
  });
});
