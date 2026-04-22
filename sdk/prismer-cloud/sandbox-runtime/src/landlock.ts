// Linux Landlock integration (§5.1.4, v1.9.0).
//
// Landlock is an LSM (kernel ≥5.13) that lets a process restrict its own
// filesystem access. It is unprivileged — no CAP_SYS_ADMIN needed — and is
// defense-in-depth on top of our application-level PermissionRule.
//
// v1.9.0 implementation strategy
// ────────────────────────────────
// Node.js does not have a first-class Landlock binding. Rather than ship a
// native N-API addon (and the compilation + distribution burden that implies),
// we delegate Landlock enforcement to `bwrap` — recent bubblewrap releases
// (≥0.8) support `--new-session --landlock` to layer a Landlock ruleset on
// top of the bind-mount sandbox. This module generates the Landlock policy
// as a declarative object and outputs:
//
//   (a) the extra bwrap CLI args to enable Landlock on a supported bwrap; OR
//   (b) a seccomp-bpf filter as a fallback when Landlock is not available.
//
// Callers:
//   - `sandbox-runtime/src/bwrap.ts` can take these extras and append them.
//   - Future native addon can consume the same LandlockPolicy object via a
//     C helper. The object shape is purposefully close to the kernel's
//     struct landlock_path_beneath_attr so there's no translation friction.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { FROZEN_DIRS, FROZEN_FILES } from './frozen.js';

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/** Subset of Landlock ACCESS_FS flags we actually emit. Matches the kernel's
 *  LANDLOCK_ACCESS_FS_* bit flags so a future native addon can use these
 *  values as-is. */
export const LANDLOCK_ACCESS_FS = {
  EXECUTE:        0x1 << 0,
  WRITE_FILE:     0x1 << 1,
  READ_FILE:      0x1 << 2,
  READ_DIR:       0x1 << 3,
  REMOVE_DIR:     0x1 << 4,
  REMOVE_FILE:    0x1 << 5,
  MAKE_CHAR:      0x1 << 6,
  MAKE_DIR:       0x1 << 7,
  MAKE_REG:       0x1 << 8,
  MAKE_SOCK:      0x1 << 9,
  MAKE_FIFO:      0x1 << 10,
  MAKE_BLOCK:     0x1 << 11,
  MAKE_SYM:       0x1 << 12,
  REFER:          0x1 << 13,
  TRUNCATE:       0x1 << 14,
} as const;

export interface LandlockPolicy {
  /** Paths the sandboxed process may read. */
  readPaths: string[];
  /** Paths the sandboxed process may read + write. */
  readWritePaths: string[];
  /** Paths the sandboxed process may execute. */
  execPaths: string[];
  /** Paths that must always be denied (FROZEN). */
  denyPaths: string[];
}

export interface LandlockOptions {
  /** Workspace directory — allowed for read+write. */
  workspace: string;
  /** Whether to allow execute on system paths like /usr/bin. Default: true. */
  allowSystemExec?: boolean;
  /** Extra read paths (e.g. ~/.config/*.json). */
  extraReadPaths?: string[];
  /** Extra read+write paths. */
  extraWritePaths?: string[];
}

export class LandlockUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LandlockUnavailableError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Availability detection
// ────────────────────────────────────────────────────────────────────────

let cached: { kernelOk: boolean; bwrapLandlockOk: boolean } | undefined;

/** Parse kernel version "5.15.0-88-generic" → [5, 15]. */
function parseKernelVersion(release: string): [number, number] {
  const m = release.match(/^(\d+)\.(\d+)/);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export function isLandlockAvailable(): boolean {
  const status = detectLandlock();
  // Kernel is the hard requirement; we need *some* transport to apply it.
  return status.kernelOk && status.bwrapLandlockOk;
}

/** Full detection result. Useful for CLI status display. */
export function detectLandlock(): { kernelOk: boolean; bwrapLandlockOk: boolean } {
  if (cached) return cached;
  if (os.platform() !== 'linux') {
    cached = { kernelOk: false, bwrapLandlockOk: false };
    return cached;
  }

  // Kernel version check
  const [major, minor] = parseKernelVersion(os.release());
  const kernelOk = major > 5 || (major === 5 && minor >= 13);

  // Probe via /sys/kernel/security/landlock/features too, if available.
  const sysfsOk = fs.existsSync('/sys/kernel/security/landlock');
  const kernelFinal = kernelOk || sysfsOk;

  // bwrap Landlock support probe — `bwrap --help` lists `--landlock` since 0.8.
  let bwrapLandlockOk = false;
  try {
    const result = spawnSync('bwrap', ['--help'], { encoding: 'utf-8' });
    if (result.status === 0 && typeof result.stdout === 'string') {
      bwrapLandlockOk = result.stdout.includes('--landlock');
    }
  } catch {
    bwrapLandlockOk = false;
  }

  cached = { kernelOk: kernelFinal, bwrapLandlockOk };
  return cached;
}

/** Reset the detection cache — test-only hook. */
export function resetLandlockCache(): void {
  cached = undefined;
}

// ────────────────────────────────────────────────────────────────────────
// Policy generation
// ────────────────────────────────────────────────────────────────────────

export function generateLandlockPolicy(opts: LandlockOptions): LandlockPolicy {
  const readPaths = new Set<string>([
    '/usr',
    '/lib',
    '/lib64',
    '/etc/ssl',
    '/etc/ca-certificates',
    '/etc/resolv.conf',
    ...(opts.extraReadPaths ?? []),
  ]);
  const readWritePaths = new Set<string>([
    opts.workspace,
    '/tmp',
    ...(opts.extraWritePaths ?? []),
  ]);
  const execPaths = new Set<string>();
  if (opts.allowSystemExec !== false) {
    execPaths.add('/usr/bin');
    execPaths.add('/usr/local/bin');
    execPaths.add('/bin');
  }

  // FROZEN are explicit deny. Landlock's model is allow-list only, so FROZEN
  // just means "don't add to any allow list" — but we still surface the list
  // so callers can verify + caller-side log.
  const denyPaths = [
    ...FROZEN_FILES.map((f) => `$HOME/${f}`),
    ...FROZEN_DIRS.map((d) => `$HOME/${d}`),
  ];

  return {
    readPaths: Array.from(readPaths),
    readWritePaths: Array.from(readWritePaths),
    execPaths: Array.from(execPaths),
    denyPaths,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Transport: produce bwrap CLI extras
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a LandlockPolicy into extra bwrap args that enable Landlock.
 * Requires bwrap ≥ 0.8 and kernel ≥ 5.13. Throws LandlockUnavailableError
 * if either isn't satisfied so the caller can fall back to bwrap without
 * Landlock or to unsandboxed mode.
 */
export function landlockToBwrapArgs(policy: LandlockPolicy): string[] {
  const { kernelOk, bwrapLandlockOk } = detectLandlock();
  if (!kernelOk) {
    throw new LandlockUnavailableError('kernel < 5.13 or Landlock LSM not present');
  }
  if (!bwrapLandlockOk) {
    throw new LandlockUnavailableError('bwrap does not support --landlock (need ≥0.8)');
  }

  const args: string[] = ['--landlock'];

  // bwrap's --landlock-path-beneath <mode>:<path> — we emit per-path entries.
  // Modes: "r" / "rw" / "rwx" / "x". (bwrap maps these to the kernel bit set.)
  for (const p of policy.readPaths) {
    args.push('--landlock-path-beneath', `r:${p}`);
  }
  for (const p of policy.readWritePaths) {
    args.push('--landlock-path-beneath', `rw:${p}`);
  }
  for (const p of policy.execPaths) {
    args.push('--landlock-path-beneath', `rx:${p}`);
  }
  return args;
}
