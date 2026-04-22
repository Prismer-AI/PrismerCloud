/**
 * `prismer memory key-backup|key-recover|key-fingerprint` subcommands.
 *
 * Split / recombine MEMORY_ENCRYPTION_SECRET via Shamir secret sharing over
 * GF(256), so operators can distribute N shares across geographically and
 * mechanically distinct locations and still recover if the master secret is
 * lost or a subset of share-holders are unavailable.
 *
 * Security posture:
 *   - Never print the secret or any share to stdout unless the user explicitly
 *     asks for --stdin mode during recovery.
 *   - Share files include a header comment describing purpose + threshold.
 *   - Refuse to overwrite a non-empty output directory without --force.
 *   - Fingerprint = SHA-256(secret) hex. Full (64 chars) for CLI output & identity.
 *     Short (16 chars) for share-file headers / at-a-glance comparison.
 *
 * Design reference: docs/version190/14d-memory-infra.md §9.3.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Command } from 'commander';
import type { UI } from '../cli/ui.js';
import { createCliContext } from '../cli/context.js';
import type { CliContext } from '../cli/context.js';
import {
  splitSecret,
  combineShares,
  encodeShareAsMnemonic,
  decodeShareFromMnemonic,
  type ShamirShare,
} from '../shamir.js';

// ============================================================
// Shared helpers
// ============================================================

/**
 * Read the master secret from env, or from a pointed-to file via
 * MEMORY_ENCRYPTION_SECRET_FILE. Direct env var wins if both set.
 * Returns null if neither is configured or the file is missing.
 */
function readMasterSecret(): { value: string; source: 'env' | 'file' } | null {
  const direct = process.env['MEMORY_ENCRYPTION_SECRET'];
  if (typeof direct === 'string' && direct.length > 0) {
    return { value: direct, source: 'env' };
  }
  const filePath = process.env['MEMORY_ENCRYPTION_SECRET_FILE'];
  if (typeof filePath === 'string' && filePath.length > 0) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (raw.length > 0) {
        return { value: raw, source: 'file' };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** SHA-256 hex of the secret (64 chars). Returns null if disabled. */
export function fingerprintOf(secret: string | Buffer): string {
  return crypto
    .createHash('sha256')
    .update(typeof secret === 'string' ? Buffer.from(secret, 'utf-8') : secret)
    .digest('hex');
}

function shortFingerprint(full: string): string {
  return full.slice(0, 16);
}

function buildShareFile(
  shareIndex: number,
  total: number,
  threshold: number,
  mnemonic: string,
  fingerprintShort: string,
): string {
  // Single clear header with purpose, threshold, and the fingerprint of the
  // SECRET (not the share). All operators can compare fingerprints to confirm
  // their shares belong to the same split.
  return [
    `# SHAMIR SHARE ${shareIndex} of ${total} — keep secret — threshold ${threshold} needed for recovery`,
    `# Prismer Cloud — MEMORY_ENCRYPTION_SECRET backup`,
    `# Secret fingerprint (first 16 hex of SHA-256, not the secret itself): ${fingerprintShort}`,
    `# Recover with: prismer memory key-recover --shares <this file> <share-B> <share-C> ...`,
    `#`,
    `# DO NOT COMMIT this file to source control. Distribute shares to`,
    `# geographically and mechanically distinct locations (different people,`,
    `# different devices, different physical locations).`,
    '',
    mnemonic,
    '',
  ].join('\n');
}

function parseMnemonicFromFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Extract mnemonic: discard commented / blank lines.
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(`${filePath}: no mnemonic line found (all lines blank or commented)`);
  }
  // Concatenate residual lines in case the mnemonic wraps.
  return lines.join('');
}

function dirIsEmpty(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    return entries.length === 0;
  } catch {
    return true; // missing dir behaves as empty
  }
}

// ============================================================
// key-backup
// ============================================================

interface KeyBackupOptions {
  out: string;
  shares: number;
  threshold: number;
  force: boolean;
}

async function keyBackup(ctx: CliContext, opts: KeyBackupOptions): Promise<number> {
  const secretInfo = readMasterSecret();
  if (!secretInfo) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({
        ok: false,
        error: 'NO_SECRET',
        message: 'MEMORY_ENCRYPTION_SECRET is not set (and MEMORY_ENCRYPTION_SECRET_FILE is unset or empty)',
      });
    } else {
      ctx.ui.error(
        'MEMORY_ENCRYPTION_SECRET is not set',
        'memory encryption is disabled; nothing to back up',
        'Enable encryption first by setting MEMORY_ENCRYPTION_SECRET, then retry',
      );
    }
    return 1;
  }

  if (opts.threshold < 2 || opts.shares < opts.threshold || opts.shares > 255) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({
        ok: false,
        error: 'INVALID_PARAMS',
        message: 'threshold must be >= 2, shares must be >= threshold and <= 255',
      });
    } else {
      ctx.ui.error(
        'Invalid --shares / --threshold combination',
        `got shares=${opts.shares}, threshold=${opts.threshold}`,
        'Require: 2 <= threshold <= shares <= 255',
      );
    }
    return 1;
  }

  const outDir = path.resolve(opts.out);

  if (fs.existsSync(outDir)) {
    const stat = fs.statSync(outDir);
    if (!stat.isDirectory()) {
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'NOT_A_DIR', message: `${outDir} exists and is not a directory` });
      } else {
        ctx.ui.error(`${outDir} exists and is not a directory`);
      }
      return 1;
    }
    if (!dirIsEmpty(outDir) && !opts.force) {
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({
          ok: false,
          error: 'DIR_NOT_EMPTY',
          message: `${outDir} is not empty; pass --force to overwrite`,
        });
      } else {
        ctx.ui.error(
          `${outDir} is not empty`,
          'refusing to overwrite without --force',
          `Re-run with --force or choose an empty directory`,
        );
      }
      return 1;
    }
  } else {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const fullFp = fingerprintOf(secretInfo.value);
  const shortFp = shortFingerprint(fullFp);

  // Split the secret.
  const secretBuf = Buffer.from(secretInfo.value, 'utf-8');
  const shares = splitSecret(secretBuf, opts.shares, opts.threshold);

  const writtenFiles: string[] = [];
  for (let i = 0; i < shares.length; i++) {
    const mnemonic = encodeShareAsMnemonic(shares[i]);
    const filename = `share-${i + 1}-of-${opts.shares}.txt`;
    const filePath = path.join(outDir, filename);
    const body = buildShareFile(i + 1, opts.shares, opts.threshold, mnemonic, shortFp);
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    writtenFiles.push(filePath);
  }

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({
      ok: true,
      outDir,
      shares: opts.shares,
      threshold: opts.threshold,
      fingerprint: fullFp,
      fingerprintShort: shortFp,
      files: writtenFiles.map((f) => path.basename(f)),
      source: secretInfo.source,
    });
    return 0;
  }

  ctx.ui.header('Prismer Memory · Key Backup');
  ctx.ui.blank();
  ctx.ui.success(`Wrote ${shares.length} shares to ${outDir}`);
  ctx.ui.secondary(`Threshold: ${opts.threshold} of ${opts.shares} required for recovery`);
  ctx.ui.secondary(`Secret source: ${secretInfo.source === 'env' ? 'MEMORY_ENCRYPTION_SECRET (env)' : 'MEMORY_ENCRYPTION_SECRET_FILE'}`);
  ctx.ui.secondary(`Fingerprint: ${shortFp} (SHA-256 prefix)`);
  ctx.ui.blank();
  ctx.ui.line('Share files:');
  for (const f of writtenFiles) {
    ctx.ui.secondary(`  ${path.basename(f)}`);
  }
  ctx.ui.blank();
  ctx.ui.line('Distribution advice:');
  ctx.ui.secondary('  - Move shares to geographically and mechanically distinct locations.');
  ctx.ui.secondary('  - Do NOT keep all shares on the same machine, cloud account, or backup bundle.');
  ctx.ui.secondary('  - Do NOT commit share files to source control.');
  ctx.ui.secondary('  - Verify later with: prismer memory key-fingerprint');
  ctx.ui.blank();
  ctx.ui.tip('prismer memory key-recover --shares <file-A> <file-B> <file-C>');
  return 0;
}

// ============================================================
// key-recover
// ============================================================

interface KeyRecoverOptions {
  shares?: string[];
  out?: string;
  stdin?: boolean;
}

async function readSharesInteractively(ctx: CliContext): Promise<ShamirShare[]> {
  // One share per prompt, re-prompt on CRC failure. Stop when user enters blank.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts go to stderr, not stdout
    terminal: (process.stdin as NodeJS.ReadStream).isTTY === true,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });

  const shares: ShamirShare[] = [];
  try {
    ctx.ui.line('Enter each share mnemonic, one per prompt.');
    ctx.ui.secondary('Blank line when finished. Invalid entries will be re-prompted.');
    ctx.ui.blank();

    let idx = 1;
    // Collect at least 2 shares.
    for (;;) {
      const input = (await ask(`Share ${idx}: `)).trim();
      if (input.length === 0) {
        if (shares.length < 2) {
          ctx.ui.warn('At least 2 shares are required. Continue.');
          continue;
        }
        break;
      }
      try {
        const buf = decodeShareFromMnemonic(input);
        shares.push(buf);
        idx++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.fail(`Invalid share: ${msg}`);
        ctx.ui.secondary('Try again (leave blank when finished).');
      }
    }
  } finally {
    rl.close();
  }
  return shares;
}

async function readSharesFromStdin(): Promise<ShamirShare[]> {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d: string) => chunks.push(d));
    process.stdin.on('end', () => resolve());
    process.stdin.on('error', reject);
  });
  const lines = chunks.join('').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
  const shares: ShamirShare[] = [];
  for (const line of lines) {
    shares.push(decodeShareFromMnemonic(line));
  }
  return shares;
}

async function keyRecover(ctx: CliContext, opts: KeyRecoverOptions): Promise<number> {
  let shares: ShamirShare[] = [];

  if (opts.stdin) {
    try {
      shares = await readSharesFromStdin();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'STDIN_DECODE_FAILED', message: msg });
      } else {
        ctx.ui.error('Failed to decode shares from stdin', msg);
      }
      return 1;
    }
  } else if (opts.shares && opts.shares.length > 0) {
    for (const f of opts.shares) {
      try {
        const mnemonic = parseMnemonicFromFile(f);
        shares.push(decodeShareFromMnemonic(mnemonic));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'SHARE_DECODE_FAILED', file: f, message: msg });
        } else {
          ctx.ui.error(`Failed to decode share ${f}`, msg);
        }
        return 1;
      }
    }
  } else {
    // Interactive mode.
    shares = await readSharesInteractively(ctx);
  }

  if (shares.length < 2) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: false, error: 'INSUFFICIENT_SHARES', count: shares.length });
    } else {
      ctx.ui.error('Need at least 2 shares to recover', `got ${shares.length}`);
    }
    return 1;
  }

  let secret: Buffer;
  try {
    secret = combineShares(shares);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: false, error: 'COMBINE_FAILED', message: msg });
    } else {
      ctx.ui.error('Combine failed', msg, 'verify share mnemonics are from the same split');
    }
    return 1;
  }

  const fp = fingerprintOf(secret);
  const shortFp = shortFingerprint(fp);

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    const outDir = path.dirname(outPath);
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      // best effort
    }
    fs.writeFileSync(outPath, secret, { mode: 0o600 });
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, out: outPath, fingerprint: fp, fingerprintShort: shortFp, sharesUsed: shares.length });
    } else {
      ctx.ui.header('Prismer Memory · Key Recovery');
      ctx.ui.blank();
      ctx.ui.success(`Secret recovered from ${shares.length} shares`);
      ctx.ui.secondary(`Written to: ${outPath} (mode 0600)`);
      ctx.ui.secondary(`Fingerprint: ${shortFp} (SHA-256 prefix)`);
      ctx.ui.tip('Compare with the fingerprint in share file headers.');
    }
    return 0;
  }

  // No --out: print fingerprint only, never the secret itself.
  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, fingerprint: fp, fingerprintShort: shortFp, sharesUsed: shares.length });
  } else {
    ctx.ui.header('Prismer Memory · Key Recovery');
    ctx.ui.blank();
    ctx.ui.success(`Secret recovered from ${shares.length} shares`);
    ctx.ui.secondary(`Fingerprint: ${shortFp} (SHA-256 prefix)`);
    ctx.ui.secondary('(secret not printed; use --out <path> to write it to disk)');
  }
  return 0;
}

// ============================================================
// key-fingerprint
// ============================================================

async function keyFingerprint(ctx: CliContext): Promise<number> {
  const secretInfo = readMasterSecret();
  if (!secretInfo) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, enabled: false, fingerprint: null });
    } else {
      ctx.ui.line('disabled');
    }
    return 0;
  }
  const fp = fingerprintOf(secretInfo.value);
  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, enabled: true, fingerprint: fp, source: secretInfo.source });
  } else {
    ctx.ui.line(fp);
  }
  return 0;
}

// ============================================================
// Register
// ============================================================

export function registerMemoryKeyCommands(program: Command, ui: UI): void {
  void ui; // unused; we create ctx from argv like the other memory subcommands

  const memoryCmd = program.commands.find((c) => c.name() === 'memory');
  if (!memoryCmd) {
    throw new Error('registerMemoryKeyCommands: expected "memory" parent command to exist already');
  }

  memoryCmd
    .command('key-backup')
    .description('Split MEMORY_ENCRYPTION_SECRET into N Shamir shares for recovery')
    .requiredOption('--out <dir>', 'Output directory for share files')
    .option('--shares <n>', 'Total number of shares to generate', '5')
    .option('--threshold <m>', 'Minimum shares needed to recover', '3')
    .option('--force', 'Overwrite output directory if it is non-empty', false)
    .action(
      async (cmdOpts: { out: string; shares?: string; threshold?: string; force?: boolean }) => {
        const ctx = await createCliContext({ argv: process.argv });
        const code = await keyBackup(ctx, {
          out: cmdOpts.out,
          shares: cmdOpts.shares ? parseInt(cmdOpts.shares, 10) : 5,
          threshold: cmdOpts.threshold ? parseInt(cmdOpts.threshold, 10) : 3,
          force: cmdOpts.force === true,
        });
        if (code !== 0) process.exit(code);
      },
    );

  memoryCmd
    .command('key-recover')
    .description('Recombine Shamir shares to recover MEMORY_ENCRYPTION_SECRET')
    .option('--shares <files...>', 'Paths to share files (repeat or space-separate)')
    .option('--out <path>', 'Write recovered secret to file (mode 0600)')
    .option('--stdin', 'Read share mnemonics from stdin (one per line, # lines ignored)', false)
    .action(
      async (cmdOpts: { shares?: string[]; out?: string; stdin?: boolean }) => {
        const ctx = await createCliContext({ argv: process.argv });
        const code = await keyRecover(ctx, {
          shares: cmdOpts.shares,
          out: cmdOpts.out,
          stdin: cmdOpts.stdin === true,
        });
        if (code !== 0) process.exit(code);
      },
    );

  memoryCmd
    .command('key-fingerprint')
    .description('Print SHA-256 fingerprint of MEMORY_ENCRYPTION_SECRET (or "disabled")')
    .action(async () => {
      const ctx = await createCliContext({ argv: process.argv });
      const code = await keyFingerprint(ctx);
      if (code !== 0) process.exit(code);
    });
}
