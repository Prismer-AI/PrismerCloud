import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { FROZEN_DIRS, FROZEN_FILES } from './frozen.js';

// ============================================================
// Input validation helper — C1 seatbelt injection guard
// ============================================================

/**
 * Throws SeatbeltUnavailableError if the path contains characters that can
 * escape an s-expression string literal: double-quote, newline, carriage-return,
 * or backslash.  realpathSync normally prevents these, but falls back to the raw
 * input when a path does not yet exist, so we validate both raw and resolved forms.
 */
function assertSeatbeltSafePath(p: string, context: string): void {
  if (/["\n\r\\]/.test(p)) {
    throw new SeatbeltUnavailableError(
      `seatbelt: ${context} path contains forbidden chars (" \\n \\r \\\\): ${JSON.stringify(p)}`,
    );
  }
}

// ============================================================
// Public types
// ============================================================

export interface SeatbeltOptions {
  /** Workspace directory. Will be realpath'd before embedding in the profile. */
  workspace: string;
  /** Allow network access inside the sandbox. Default: true. */
  allowNetwork?: boolean;
  /** Allow process-fork inside the sandbox. Default: true. */
  allowProcessFork?: boolean;
  /** Additional subpaths to allow for file-write. Realpath'd if resolvable; skipped if not. */
  extraAllowWrite?: string[];
  /** Additional subpaths/literals to deny for file-write. */
  extraDenyWrite?: string[];
}

export class SeatbeltUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SeatbeltUnavailableError';
  }
}

// ============================================================
// Internal helpers
// ============================================================

/** Cached result of the sandbox-exec availability check. */
let sandboxExecAvailable: boolean | undefined;

function isSandboxExecAvailable(): boolean {
  if (sandboxExecAvailable !== undefined) return sandboxExecAvailable;
  const result = spawnSync('which', ['sandbox-exec'], { encoding: 'utf8' });
  sandboxExecAvailable = result.status === 0 && result.stdout.trim().length > 0;
  return sandboxExecAvailable;
}

/**
 * Resolve HOME: prefer process.env.HOME, fall back to os.homedir().
 * Profile uses literal $HOME text so sandbox-exec evaluates it at runtime,
 * but for generating deny rules we need the actual path at profile-generation time.
 */
function resolvedHome(): string {
  return process.env['HOME'] ?? os.homedir();
}

// ============================================================
// Profile generation
// ============================================================

/**
 * Generate a macOS seatbelt (.sb) profile text for use with sandbox-exec.
 *
 * Design decisions encoded here:
 *
 * D17 (double-barrel workspace): we embed BOTH the symlink path the caller
 * passed AND realpathSync(workspace) as subpath entries. On macOS,
 * /var/folders/... resolves to /private/var/folders/... — without both entries
 * the allow rule would silently miss writes made via the resolved path.
 *
 * D20 (.git exclusion): FROZEN_DIRS includes '.git'. Seatbelt cannot express
 * "deny subpath of X that ends in /.git" without also denying all of X. We
 * skip .git from the seatbelt deny block. Protection for .git inside the
 * workspace is enforced exclusively at the PermissionRule layer (permission-engine.ts).
 *
 * FROZEN_GLOBS (**\/*.pem, **\/credentials.*, etc.) cannot be expressed in
 * seatbelt profile syntax at all — seatbelt only supports subpath and literal
 * predicates, not glob patterns. These are enforced at the PermissionRule layer.
 */
export function generateSeatbeltProfile(opts: SeatbeltOptions): string {
  const {
    workspace,
    allowNetwork = true,
    allowProcessFork = true,
    extraAllowWrite = [],
    extraDenyWrite = [],
  } = opts;

  // C1: validate workspace before any string interpolation.
  assertSeatbeltSafePath(workspace, 'workspace');

  // D17: realpath the workspace to handle macOS /var -> /private/var symlink.
  let realWorkspace: string;
  try {
    realWorkspace = fs.realpathSync(workspace);
  } catch {
    // If the path does not exist yet, fall back to the raw path.
    realWorkspace = workspace;
  }
  // C1: also validate the resolved form (realpath should not produce forbidden chars,
  // but verify defensively in case of unusual filesystem configurations).
  assertSeatbeltSafePath(realWorkspace, 'workspace (resolved)');

  const home = resolvedHome();
  const tmpDir = os.tmpdir();

  // ---- Build extra allow-write entries ----
  const extraAllowLines: string[] = [];
  for (const p of extraAllowWrite) {
    // C1: validate raw path before attempting realpath.
    assertSeatbeltSafePath(p, 'extraAllowWrite');
    let resolved: string;
    try {
      resolved = fs.realpathSync(p);
    } catch {
      // Path does not exist; skip with a comment so profile is self-documenting.
      extraAllowLines.push(`  ; skipped non-existent extraAllowWrite path: ${p}`);
      continue;
    }
    // C1: also validate the resolved path.
    assertSeatbeltSafePath(resolved, 'extraAllowWrite (resolved)');
    extraAllowLines.push(`  (subpath "${resolved}")`);
    if (resolved !== p) {
      extraAllowLines.push(`  (subpath "${p}")`);
    }
  }

  // ---- Build deny entries from FROZEN ----
  //
  // Rules:
  //   FROZEN_DIRS that resolve under $HOME → deny subpath
  //   FROZEN_FILES that resolve under $HOME → deny literal
  //   .git is SKIPPED (D20): seatbelt subpath cannot target a subdirectory within
  //     the allowed workspace. Enforcement is solely at the PermissionRule layer.
  //   FROZEN_GLOBS are SKIPPED: seatbelt has no glob predicate.

  const frozenDenyLines: string[] = [];

  for (const dir of FROZEN_DIRS) {
    // D20: skip .git — see comment above.
    if (dir === '.git') {
      frozenDenyLines.push(`  ; .git skipped (D20): cannot subpath-deny inside workspace via seatbelt`);
      continue;
    }
    const fullPath = path.join(home, dir);
    // C1: defensive check — FROZEN entries should never contain forbidden chars,
    // but validate to catch misconfiguration.
    assertSeatbeltSafePath(fullPath, `FROZEN_DIRS entry "${dir}"`);
    frozenDenyLines.push(`  (subpath "${fullPath}")`);
  }

  for (const file of FROZEN_FILES) {
    const fullPath = path.join(home, file);
    // C1: defensive check.
    assertSeatbeltSafePath(fullPath, `FROZEN_FILES entry "${file}"`);
    frozenDenyLines.push(`  (literal "${fullPath}")`);
  }

  // Extra deny entries provided by caller.
  const extraDenyLines = extraDenyWrite.map((p) => {
    // C1: validate before interpolation.
    assertSeatbeltSafePath(p, 'extraDenyWrite');
    return `  (subpath "${p}")`;
  });

  // ---- Assemble profile ----
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    '; Allow reading everywhere — agents need system libs, node_modules, etc.',
    '(allow file-read*)',
    '',
    '; Allow writing inside workspace (D17: both symlink path and realpath).',
    '(allow file-write*',
    `  (subpath "${workspace}")`,
  ];

  // Only emit realpath entry when it differs from the original path.
  if (realWorkspace !== workspace) {
    lines.push(`  (subpath "${realWorkspace}")`);
  }
  lines.push(')');

  lines.push(
    '',
    '; Allow writing to tmp directories — many tools require this.',
    '(allow file-write*',
    '  (subpath "/private/var/folders")',
    '  (subpath "/private/tmp")',
    '  (subpath "/tmp")',
  );
  if (tmpDir !== '/tmp' && tmpDir !== '/private/tmp') {
    lines.push(`  (subpath "${tmpDir}")`);
  }
  lines.push(')');

  if (extraAllowLines.length > 0) {
    lines.push(
      '',
      '; Extra allow-write paths (caller-supplied).',
      '(allow file-write*',
      ...extraAllowLines,
      ')',
    );
  }

  lines.push(
    '',
    '; Allow process execution.',
    '(allow process-exec)',
  );

  if (allowProcessFork) {
    lines.push('(allow process-fork)');
  }

  if (allowNetwork) {
    lines.push(
      '',
      '; Allow network access.',
      '(allow network*)',
    );
  }

  lines.push(
    '',
    '; Allow sysctl reads — required by Node.js.',
    '(allow sysctl-read)',
    '',
    '; Allow mach IPC — required by Node.js and shell.',
    '(allow mach-lookup)',
    '(allow mach-register)',
    '',
    '; Allow POSIX IPC — required by sh on newer macOS.',
    '(allow ipc-posix*)',
  );

  // Deny block for FROZEN dirs/files and extra deny paths.
  const allDenyLines = [...frozenDenyLines, ...extraDenyLines];
  if (allDenyLines.length > 0) {
    lines.push(
      '',
      '; Deny writes to sensitive $HOME locations (from FROZEN_DIRS / FROZEN_FILES).',
      '; FROZEN_GLOBS (**/*.pem etc.) are not expressible in seatbelt — enforced at PermissionRule layer.',
      '(deny file-write*',
      ...allDenyLines,
      ')',
    );
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================
// Profile writer
// ============================================================

/**
 * Write a seatbelt profile to ~/.prismer/sandbox/<name>.sb.
 * Returns the absolute path to the written file.
 */
export function writeSeatbeltProfile(name: string, opts: SeatbeltOptions): string {
  const dir = path.join(os.homedir(), '.prismer', 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.sb`);
  const content = generateSeatbeltProfile(opts);
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return filePath;
}

// ============================================================
// Sandbox runner
// ============================================================

/**
 * Spawn a command inside a macOS seatbelt sandbox.
 *
 * Returns the ChildProcess handle so the caller can stream stdio,
 * attach listeners, and await exit.
 *
 * Throws SeatbeltUnavailableError on non-macOS or if sandbox-exec is absent.
 */
export function spawnInSandbox(
  profilePath: string,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  if (os.platform() !== 'darwin') {
    throw new SeatbeltUnavailableError('seatbelt requires macOS');
  }
  if (!isSandboxExecAvailable()) {
    throw new SeatbeltUnavailableError('sandbox-exec binary not found');
  }
  return spawn('sandbox-exec', ['-f', profilePath, command, ...args], {
    cwd: options?.cwd,
    env: options?.env,
    stdio: 'inherit',
  });
}
