import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { FROZEN_DIRS, FROZEN_FILES } from './frozen.js';

// ============================================================
// Public types
// ============================================================

export interface AppArmorConfig {
  /** Profile name, e.g. 'prismer-claude-code'. Must be a safe identifier. */
  profileName: string;
  /** Paths with read access. */
  allowedReadPaths: string[];
  /** Paths with read+write access. */
  allowedWritePaths: string[];
  /** Paths with execute access (ix — inherit profile). */
  allowedExecPaths: string[];
  /** Allow network access. Default: true. */
  allowNetwork?: boolean;
  /** Allow DNS resolution. Default: true. */
  allowDns?: boolean;
}

export interface AppArmorResult {
  /** Where the profile file was written. */
  profilePath: string;
  /** Whether apparmor_parser loaded the profile successfully. */
  loaded: boolean;
  /** Error message if loading failed. */
  error?: string;
}

export class AppArmorUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AppArmorUnavailableError';
  }
}

// ============================================================
// Input validation — profile name injection guard
// ============================================================

/**
 * Validate that a profile name only contains safe characters.
 * AppArmor profile names should be alphanumeric with hyphens/underscores/dots.
 */
function assertSafeProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new AppArmorUnavailableError(
      `apparmor: profile name contains forbidden chars (must be [a-zA-Z0-9._-]): ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Validate that a path does not contain characters that could break
 * the AppArmor profile syntax. Reject newlines, null bytes, braces,
 * and hash/comma that could alter rule semantics or create alternation.
 */
function assertSafePath(p: string, context: string): void {
  if (/[\n\r\0{}#,]/.test(p)) {
    throw new AppArmorUnavailableError(
      `apparmor: ${context} path contains forbidden chars (newline/null): ${JSON.stringify(p)}`,
    );
  }
}

// ============================================================
// Availability check
// ============================================================

/** Cached result of the AppArmor availability check. */
let appArmorAvailable: boolean | undefined;

/**
 * Check if AppArmor is available on this system.
 * Requires Linux, the AppArmor security filesystem, and apparmor_parser on PATH.
 */
export function isAppArmorAvailable(): boolean {
  if (appArmorAvailable !== undefined) return appArmorAvailable;

  if (os.platform() !== 'linux') {
    appArmorAvailable = false;
    return false;
  }

  // Check for the AppArmor security filesystem
  try {
    fs.accessSync('/sys/kernel/security/apparmor', fs.constants.F_OK);
  } catch {
    appArmorAvailable = false;
    return false;
  }

  // Check for apparmor_parser on PATH
  const result = spawnSync('which', ['apparmor_parser'], { encoding: 'utf8' });
  appArmorAvailable = result.status === 0 && result.stdout.trim().length > 0;
  return appArmorAvailable;
}

// ============================================================
// Profile generation
// ============================================================

/**
 * Generate an AppArmor profile file content from the given config.
 *
 * The profile uses enforce mode and includes the base abstraction.
 * FROZEN_DIRS and FROZEN_FILES from the shared frozen list are denied
 * write access, matching the seatbelt approach.
 */
export function generateProfile(config: AppArmorConfig): string {
  const {
    profileName,
    allowedReadPaths,
    allowedWritePaths,
    allowedExecPaths,
    allowNetwork = true,
    allowDns = true,
  } = config;

  assertSafeProfileName(profileName);

  // Validate all paths before generating the profile.
  for (const p of allowedReadPaths) assertSafePath(p, 'allowedReadPaths');
  for (const p of allowedWritePaths) assertSafePath(p, 'allowedWritePaths');
  for (const p of allowedExecPaths) assertSafePath(p, 'allowedExecPaths');

  const lines: string[] = [];

  lines.push('#include <tunables/global>');
  lines.push('');
  lines.push(`profile ${profileName} flags=(enforce) {`);
  lines.push('  #include <abstractions/base>');
  lines.push('');

  // ---- Read access ----
  if (allowedReadPaths.length > 0) {
    lines.push('  # Read access');
    for (const p of allowedReadPaths) {
      lines.push(`  ${p}/** r,`);
    }
    lines.push('');
  }

  // ---- Write access ----
  if (allowedWritePaths.length > 0) {
    lines.push('  # Write access');
    for (const p of allowedWritePaths) {
      lines.push(`  ${p}/** rw,`);
    }
    lines.push('');
  }

  // ---- Execute access ----
  if (allowedExecPaths.length > 0) {
    lines.push('  # Execute access');
    for (const p of allowedExecPaths) {
      lines.push(`  ${p} ix,`);
    }
    lines.push('');
  }

  // ---- Network ----
  if (allowNetwork) {
    lines.push('  # Network access');
    lines.push('  network inet stream,');
    lines.push('  network inet dgram,');
    lines.push('  network inet6 stream,');
    lines.push('  network inet6 dgram,');
    if (allowDns) {
      lines.push('  network netlink raw,');
    }
    lines.push('');
  } else if (allowDns) {
    // DNS only — needed for resolution even when general networking is off.
    lines.push('  # DNS resolution only');
    lines.push('  network inet dgram,');
    lines.push('  network inet6 dgram,');
    lines.push('  network netlink raw,');
    lines.push('');
  }

  // ---- Deny dangerous capabilities ----
  lines.push('  # Deny dangerous capabilities');
  lines.push('  deny capability sys_admin,');
  lines.push('  deny capability sys_rawio,');
  lines.push('  deny capability net_raw,');
  lines.push('  deny capability sys_module,');
  lines.push('  deny capability sys_ptrace,');
  lines.push('  deny capability sys_boot,');
  lines.push('  deny capability mknod,');
  lines.push('');

  // ---- Deny sensitive system paths ----
  lines.push('  # Deny sensitive system paths');
  lines.push('  deny /etc/shadow r,');
  lines.push('  deny /etc/passwd w,');
  lines.push('  deny /etc/sudoers* rw,');
  lines.push('  deny /proc/*/mem rw,');
  lines.push('  deny /proc/kcore r,');
  lines.push('  deny /sys/firmware/** rw,');
  lines.push('');

  // ---- Deny FROZEN paths ----
  // Build deny rules from FROZEN_DIRS and FROZEN_FILES, matching the seatbelt
  // approach (D20: .git is included here since AppArmor CAN express sub-path deny
  // unlike seatbelt, but we skip it to stay consistent with the PermissionRule layer).
  const home = process.env['HOME'] ?? os.homedir();
  const frozenDenyLines: string[] = [];

  for (const dir of FROZEN_DIRS) {
    // D20: skip .git — enforcement at the PermissionRule layer only.
    if (dir === '.git') {
      frozenDenyLines.push(`  # .git skipped (D20): enforced at PermissionRule layer`);
      continue;
    }
    const fullPath = path.join(home, dir);
    assertSafePath(fullPath, `FROZEN_DIRS entry "${dir}"`);
    frozenDenyLines.push(`  deny ${fullPath}/** rw,`);
  }

  for (const file of FROZEN_FILES) {
    const fullPath = path.join(home, file);
    assertSafePath(fullPath, `FROZEN_FILES entry "${file}"`);
    frozenDenyLines.push(`  deny ${fullPath} rw,`);
  }

  if (frozenDenyLines.length > 0) {
    lines.push('  # Deny writes to sensitive $HOME locations (FROZEN_DIRS / FROZEN_FILES)');
    lines.push('  # FROZEN_GLOBS (**/*.pem etc.) not expressible in AppArmor — enforced at PermissionRule layer.');
    lines.push(...frozenDenyLines);
    lines.push('');
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Default agent profile
// ============================================================

/**
 * Create a default agent sandbox profile config.
 *
 * Provides a reasonable default for running an agent inside a workspace:
 * - Read access to system libs, workspace, and home
 * - Write access restricted to the workspace and /tmp/prismer-*
 * - Execute access for node and git
 * - Network enabled
 */
export function defaultAgentProfile(agentName: string, workDir: string): AppArmorConfig {
  assertSafeProfileName(agentName);
  assertSafePath(workDir, 'workDir');

  let resolvedWorkDir: string;
  try {
    resolvedWorkDir = fs.realpathSync(workDir);
  } catch {
    resolvedWorkDir = workDir;
  }

  return {
    profileName: `prismer-${agentName}`,
    allowedReadPaths: [
      '/usr/lib',
      '/usr/share',
      '/usr/local/lib',
      '/usr/local/share',
      resolvedWorkDir,
      process.env['HOME'] ?? os.homedir(),
    ],
    allowedWritePaths: [
      resolvedWorkDir,
      `/tmp/prismer-${agentName}`,
    ],
    allowedExecPaths: [
      '/usr/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/git',
      '/usr/bin/env',
      '/bin/sh',
      '/usr/bin/sh',
    ],
    allowNetwork: true,
    allowDns: true,
  };
}

// ============================================================
// Profile writer & loader
// ============================================================

/**
 * Write profile to ~/.prismer/sandbox/<profileName>.apparmor.
 * Returns the absolute path to the written file.
 */
export function writeProfile(config: AppArmorConfig): string {
  const dir = path.join(os.homedir(), '.prismer', 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${config.profileName}.apparmor`);
  const content = generateProfile(config);
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  return filePath;
}

/**
 * Write profile to /etc/apparmor.d/ and load it via apparmor_parser.
 *
 * Requires sudo/root for writing to /etc/apparmor.d/ and running apparmor_parser.
 * Returns result with loaded=false and an error message if permissions are insufficient.
 */
export async function installProfile(config: AppArmorConfig): Promise<AppArmorResult> {
  if (os.platform() !== 'linux') {
    return {
      profilePath: '',
      loaded: false,
      error: 'AppArmor requires Linux',
    };
  }

  if (!isAppArmorAvailable()) {
    return {
      profilePath: '',
      loaded: false,
      error: 'AppArmor is not available on this system',
    };
  }

  const profilePath = `/etc/apparmor.d/prismer.${config.profileName}`;
  const content = generateProfile(config);

  // Write the profile file
  try {
    fs.writeFileSync(profilePath, content, { mode: 0o644 });
  } catch (err: unknown) {
    // Cannot write to /etc/apparmor.d/ — likely not root.
    // Fall back to writing in user dir.
    const fallbackPath = writeProfile(config);
    return {
      profilePath: fallbackPath,
      loaded: false,
      error: `Cannot write to /etc/apparmor.d/ (${(err as Error).message}). Profile written to ${fallbackPath} instead. Load manually with: sudo apparmor_parser -r ${fallbackPath}`,
    };
  }

  // Load the profile via apparmor_parser
  const result = spawnSync('apparmor_parser', ['-r', profilePath], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (result.status !== 0) {
    return {
      profilePath,
      loaded: false,
      error: `apparmor_parser failed (exit ${result.status}): ${(result.stderr || '').trim()}`,
    };
  }

  return {
    profilePath,
    loaded: true,
  };
}

// ============================================================
// Sandbox runner
// ============================================================

/**
 * Spawn a command confined by an AppArmor profile.
 *
 * The profile must already be loaded into the kernel (via installProfile
 * or manual `apparmor_parser -r`). This function uses `aa-exec` to confine
 * the child process under the named profile.
 *
 * Throws AppArmorUnavailableError on non-Linux or if aa-exec is absent.
 */
export function spawnInAppArmor(
  profileName: string,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  if (os.platform() !== 'linux') {
    throw new AppArmorUnavailableError('AppArmor requires Linux');
  }
  if (!isAppArmorAvailable()) {
    throw new AppArmorUnavailableError('AppArmor is not available on this system');
  }

  // Check for aa-exec
  const which = spawnSync('which', ['aa-exec'], { encoding: 'utf8' });
  if (which.status !== 0) {
    throw new AppArmorUnavailableError('aa-exec binary not found (install apparmor-utils)');
  }

  assertSafeProfileName(profileName);

  return spawn('aa-exec', ['-p', profileName, '--', command, ...args], {
    cwd: options?.cwd,
    env: options?.env,
    stdio: 'inherit',
  });
}
