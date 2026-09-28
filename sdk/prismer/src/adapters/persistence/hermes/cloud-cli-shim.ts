import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CloudCliShimResult {
  cloudCliPath: string;
  managedBinDir: string;
  managedShimPath: string;
  shellVisibleShimPath: string;
  shellVisibleShimCreated: boolean;
}

export interface EnsureCloudCliShimOptions {
  homeDir?: string;
  /** Test/embedding override. Production resolves @prismer/sdk from the signed bundle. */
  cloudCliPath?: string;
}

/** Resolve the Cloud CLI beside the staged @prismer/sdk entry point.
 *
 * Do not use node_modules/.bin/cloud here: zip commonly dereferences npm's
 * symlink into a copied JS file. That copy resolves imports from `.bin/` and
 * cannot find @prismer/sdk's nested @prismer/aip-sdk dependency.
 *
 * In a REPO CHECKOUT (local CLI-daemon mode: `node sdk/prismer/dist/cli.js
 * daemon start` or tsx on src), @prismer/sdk is the unlinked sibling package
 * `sdk/cloud` — invisible to Node module resolution (no node_modules entry
 * anywhere on the chain), so `require.resolve` throws MODULE_NOT_FOUND and
 * the shim used to report `cloudCli: unavailable`. Fall back to explicit
 * sibling-path candidates, mirroring the resolver pattern used for the
 * bundled plugins and the MCP server (hermes/index.ts). Candidate depths:
 *   dist flat bundle  <sdk>/prismer/dist/cli.js                    → up 2
 *   dev via tsx       <sdk>/prismer/src/adapters/persistence/hermes → up 5
 *   tree dist         <sdk>/prismer/dist/adapters/persistence/hermes → up 5
 * The signed OTA bundle never reaches the fallback: its staged node_modules
 * makes `require.resolve` succeed first.
 */
export function resolveBundledCloudCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve('@prismer/sdk');
    const cli = join(dirname(sdkEntry), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    // fall through to sibling-checkout candidates below
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '../../cloud/dist/cli.js'),
      join(here, '../../../../../cloud/dist/cli.js'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Install a direct managed symlink and, when safe, a ~/.local/bin alias.
 *
 * ~/.local/bin is important in hosted sandboxes: interactive/login shells can
 * rebuild PATH and discard the manager's bundle node_modules/.bin prefix, but
 * retain ~/.local/bin. An unrelated user-owned alias is never overwritten.
 */
export function ensureCloudCliShim(opts: EnsureCloudCliShimOptions = {}): CloudCliShimResult {
  const homeDir = opts.homeDir ?? homedir();
  const cloudCliPath = resolve(opts.cloudCliPath ?? resolveBundledCloudCli() ?? '');
  if (!cloudCliPath || cloudCliPath === resolve('') || !existsSync(cloudCliPath)) {
    throw new Error('signed Runtime bundle does not contain a resolvable @prismer/sdk Cloud CLI');
  }

  const managedBinDir = join(homeDir, '.prismer', 'bin');
  const managedShimPath = join(managedBinDir, 'cloud');
  mkdirSync(managedBinDir, { recursive: true });
  ensureManagedSymlink(managedShimPath, cloudCliPath);

  const shellVisibleBinDir = join(homeDir, '.local', 'bin');
  const shellVisibleShimPath = join(shellVisibleBinDir, 'cloud');
  mkdirSync(shellVisibleBinDir, { recursive: true });
  let shellVisibleShimCreated = false;
  if (!existsOrSymlink(shellVisibleShimPath)) {
    // Point the login-shell alias at the stable managed path, not at a
    // versioned bundle. OTA only has to rotate the managed target and cannot
    // strand ~/.local/bin/cloud on an older bundle.
    symlinkSync(managedShimPath, shellVisibleShimPath, 'file');
    shellVisibleShimCreated = true;
  } else if (isSymlinkTo(shellVisibleShimPath, managedShimPath)) {
    shellVisibleShimCreated = true;
  }

  return {
    cloudCliPath,
    managedBinDir,
    managedShimPath,
    shellVisibleShimPath,
    shellVisibleShimCreated,
  };
}

function ensureManagedSymlink(linkPath: string, target: string): void {
  if (isSymlinkTo(linkPath, target)) return;
  if (existsOrSymlink(linkPath)) rmSync(linkPath, { force: true });
  symlinkSync(target, linkPath, 'file');
}

function existsOrSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target);
  } catch {
    return false;
  }
}
