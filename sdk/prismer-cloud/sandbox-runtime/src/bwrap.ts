import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { FROZEN_DIRS, FROZEN_FILES } from './frozen.js';
import {
  detectLandlock,
  generateLandlockPolicy,
  landlockToBwrapArgs,
  LandlockUnavailableError,
} from './landlock.js';

// ============================================================
// Public types
// ============================================================

export interface BwrapOptions {
  /** Workspace directory. Will be realpath'd before embedding in arguments. */
  workspace: string;
  /** Allow network access inside the sandbox. Default: true. */
  allowNetwork?: boolean;
  /** Allow process creation (fork). Default: true. */
  allowProcessFork?: boolean;
  /** Additional subpaths to allow for file-write. Realpath'd if resolvable; skipped if not. */
  extraAllowWrite?: string[];
  /** Additional subpaths to deny for file-write. */
  extraDenyWrite?: string[];
  /** Layer Landlock on top of bwrap when kernel ≥5.13 and bwrap ≥0.8.
   *  Defaults to true — silently no-ops if Landlock isn't available
   *  (bwrap's bind-mount sandbox still applies). */
  enableLandlock?: boolean;
}

export class BwrapUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BwrapUnavailableError';
  }
}

// ============================================================
// Input validation
// ============================================================

/**
 * Validate that a path does not contain characters that could break
 * bwrap argument parsing. Reject newlines, null bytes, and other shell metachars.
 */
function assertSafePath(p: string, context: string): void {
  if (/[\n\r\0\$\`]/.test(p)) {
    throw new BwrapUnavailableError(
      `bwrap: ${context} path contains forbidden chars (shell metachars): ${JSON.stringify(p)}`,
    );
  }
}

// ============================================================
// Availability check
// ============================================================

/** Cached result of bwrap availability check. */
let bwrapAvailable: boolean | undefined;

/**
 * Check if bubblewrap is available on this system.
 * Requires Linux and bwrap on PATH.
 */
export function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== undefined) return bwrapAvailable;

  if (os.platform() !== 'linux') {
    bwrapAvailable = false;
    return false;
  }

  const result = spawnSync('which', ['bwrap'], { encoding: 'utf8' });
  bwrapAvailable = result.status === 0 && result.stdout.trim().length > 0;
  return bwrapAvailable;
}

// ============================================================
// Argument generation
// ============================================================

/**
 * Generate bwrap argument list for creating a sandbox.
 *
 * Design decisions encoded here:
 *
 * D17 (double-barrel workspace): we embed BOTH symlink path caller
 * passed AND realpathSync(workspace) as bind mounts. On systems with
 * symlinks in the path (e.g. /var -> /private/var), this ensures
 * writes made via either path work correctly.
 *
 * D20 (.git exclusion): FROZEN_DIRS includes '.git'. We use
 * `--ro-bind-try` for FROZEN directories to make them read-only,
 * but we skip `.git` inside workspace since bwrap cannot express "deny subpath
 * of X that ends in /.git" without also denying all of X. Protection for
 * .git inside workspace is enforced exclusively at the PermissionRule layer.
 *
 * FROZEN_GLOBS (glob patterns like *.pem, credentials.*, etc.) cannot be expressed
 * in bwrap arguments — bwrap only supports mount paths. These are enforced
 * at the PermissionRule layer.
 */
export function generateBwrapArgs(opts: BwrapOptions): string[] {
  const {
    workspace,
    allowNetwork = true,
    allowProcessFork = true,
    extraAllowWrite = [],
    extraDenyWrite = [],
  } = opts;

  // C1: validate workspace before any string interpolation.
  assertSafePath(workspace, 'workspace');

  // D17: realpath workspace to handle symlinks.
  let realWorkspace: string;
  try {
    realWorkspace = fs.realpathSync(workspace);
  } catch {
    realWorkspace = workspace;
  }
  // C1: also validate resolved form.
  assertSafePath(realWorkspace, 'workspace (resolved)');

  const home = resolvedHome();
  const args: string[] = [];

  // ---- Basic sandbox setup ----
  // Create new process namespace
  args.push('--unshare-all');
  // Create new PID namespace
  args.push('--pid');
  // Create new mount namespace
  args.push('--mount-namespace');

  // ---- Filesystem setup ----
  // Bind /proc read-only
  args.push('--ro-bind', '/proc', '/proc');
  // Bind /dev read-only
  args.push('--dev', '/dev');
  // Bind /tmp
  args.push('--bind', '/tmp', '/tmp');

  // ---- Workspace mount (D17: both symlink and realpath) ----
  args.push('--bind', workspace, workspace);
  if (realWorkspace !== workspace) {
    args.push('--bind', realWorkspace, realWorkspace);
  }

  // ---- Extra allow-write paths ----
  for (const p of extraAllowWrite) {
    assertSafePath(p, 'extraAllowWrite');
    let resolved: string;
    try {
      resolved = fs.realpathSync(p);
    } catch {
      // Path does not exist; skip it
      continue;
    }
    assertSafePath(resolved, 'extraAllowWrite (resolved)');
    args.push('--bind', resolved, resolved);
    if (resolved !== p) {
      args.push('--bind', p, p);
    }
  }

  // ---- FROZEN directories (read-only mount) ----
  // We make FROZEN directories read-only inside the sandbox by mounting
  // them read-only. This prevents writes but does not affect reads.
  const frozenReadOnlyPaths: string[] = [];

  for (const dir of FROZEN_DIRS) {
    // D20: skip .git — see comment above.
    if (dir === '.git') {
      continue;
    }
    const fullPath = path.join(home, dir);
    assertSafePath(fullPath, `FROZEN_DIRS entry "${dir}"`);

    // Only add read-only bind if the path exists
    if (fs.existsSync(fullPath)) {
      frozenReadOnlyPaths.push(fullPath);
    }
  }

  // Add read-only binds for FROZEN directories
  for (const p of frozenReadOnlyPaths) {
    args.push('--ro-bind', p, p);
  }

  // ---- Extra deny-write paths ----
  // bwrap doesn't have a direct "deny" mechanism. We use read-only binds
  // to prevent writes. This is equivalent to "deny" for our purposes.
  for (const p of extraDenyWrite) {
    assertSafePath(p, 'extraDenyWrite');
    if (fs.existsSync(p)) {
      args.push('--ro-bind', p, p);
    }
  }

  // ---- Network ----
  if (!allowNetwork) {
    // Create new network namespace (isolates from host network)
    args.push('--unshare-net');
  }

  // ---- Process isolation ----
  if (!allowProcessFork) {
    // --die-with-parent ensures child dies when parent dies
    args.push('--die-with-parent');
    // --new-session creates new session
    args.push('--new-session');
  }

  // ---- Landlock layer (kernel ≥5.13, bwrap ≥0.8) ----
  // Defense-in-depth on top of the bind-mount sandbox: Landlock enforces
  // the same allow-list at the LSM layer, which traps syscalls even if bwrap
  // somehow failed to unbind something. No-op on older kernels / bwraps.
  if (opts.enableLandlock !== false) {
    const { kernelOk, bwrapLandlockOk } = detectLandlock();
    if (kernelOk && bwrapLandlockOk) {
      try {
        const policy = generateLandlockPolicy({
          workspace: realWorkspace,
          extraWritePaths: extraAllowWrite,
        });
        args.push(...landlockToBwrapArgs(policy));
      } catch (err) {
        if (!(err instanceof LandlockUnavailableError)) throw err;
        // Fall through silently — Landlock is advisory, not required.
      }
    }
  }

  // Add separator before command
  args.push('--');

  return args;
}

/**
 * Resolve HOME: prefer process.env.HOME, fall back to os.homedir().
 */
function resolvedHome(): string {
  return process.env['HOME'] ?? os.homedir();
}

// ============================================================
// Sandbox runner
// ============================================================

/**
 * Spawn a command inside a bwrap sandbox.
 *
 * Returns: ChildProcess handle so caller can stream stdio,
 * attach listeners, and await exit.
 *
 * Throws BwrapUnavailableError on non-Linux or if bwrap is absent.
 */
export function spawnInBwrap(
  opts: BwrapOptions,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  if (os.platform() !== 'linux') {
    throw new BwrapUnavailableError('bwrap requires Linux');
  }
  if (!isBwrapAvailable()) {
    throw new BwrapUnavailableError('bwrap binary not found (install bubblewrap)');
  }

  const bwrapArgs = generateBwrapArgs(opts);
  // Add command and its arguments after the separator
  const fullArgs = [...bwrapArgs, command, ...args];

  return spawn('bwrap', fullArgs, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: 'inherit',
  });
}

/**
 * Synchronous variant of spawnInBwrap for simple use cases.
 *
 * Returns: exit code, stdout, stderr.
 *
 * Throws BwrapUnavailableError on non-Linux or if bwrap is absent.
 */
export function spawnInBwrapSync(
  opts: BwrapOptions,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): { exitCode: number | null; stdout: string; stderr: string } {
  if (os.platform() !== 'linux') {
    throw new BwrapUnavailableError('bwrap requires Linux');
  }
  if (!isBwrapAvailable()) {
    throw new BwrapUnavailableError('bwrap binary not found (install bubblewrap)');
  }

  const bwrapArgs = generateBwrapArgs(opts);
  const fullArgs = [...bwrapArgs, command, ...args];

  const result = spawnSync('bwrap', fullArgs, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: 'utf8',
    timeout: options?.timeout ?? 60_000,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
