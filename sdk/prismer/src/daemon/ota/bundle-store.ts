// bundle-store.ts — on-disk state for the K8s/CLI runtime-bundle OTA slot
// (product204/08 §2.3, M9-β).
//
// Layout under `<PRISMER_HOME>/bundle/` (K8s: inside the pod's ephemeral
// emptyDir — a REBUILDABLE cache, never a PVC; release202/11 铁律):
//
//   bundle/
//   ├─ <version>/        extracted, verified bundle (dist/ + package.json +
//   │                    pure-JS node_modules; native better-sqlite3 is linked
//   │                    in from the image's built-in runtime at extract time)
//   ├─ current           pointer file: JSON { "version": "X.Y.Z" }
//   ├─ previous          pointer file — the rollback slot (回滚位)
//   ├─ blacklist.json    JSON { "<version>": <failCount> } (≥2 ⇒ blacklisted)
//   └─ boot-attempt.json JSON { "version", "at" } — armed by the boot resolver
//                        every time it hands a BUNDLE exec target to the
//                        entrypoint; cleared by the running daemon once boot
//                        is confirmed. A surviving marker at the NEXT resolve
//                        ⇒ the previous boot crashed before confirming.
//
// Semantics are a deliberately-simplified projection of the desktop
// bundle-manager (staged/current/builtin three-level pointer): K8s does not
// need a staged trial window because "boot-time resolve + kubelet in-place
// container restart" IS the swap (08 §2.3). We keep exactly two levels above
// the image floor: current + previous (回滚位), plus the desktop-compatible
// 2-strike blacklist.

import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import runtimeRequiredEntries from './runtime-required-entries.json';

/** A version is blacklisted after this many consecutive boot failures. */
export const BUNDLE_FAIL_THRESHOLD = 2;

/**
 * Entries a usable runtime bundle must contain.
 *
 * plugins/memory/prismer/__init__.py — the hermes MemoryProvider Python shell.
 * Bundles packed before 2026-07-19 omitted plugins/ entirely, which silently
 * killed the agents' memory layer; a memory-less bundle is NOT usable. Old
 * slots failing this check fall through to previous/builtin — the image's
 * npm-installed runtime carries plugins/ (npm `files`), so the floor is
 * always memory-capable.
 *
 * apc/skills — the APC (platform self-development) skill sources.
 * resolveApcSkillsRoot() walks up from the running module and finds this one
 * hop above dist/. Bundles packed before 2026-07-26 shipped it nowhere, so on
 * every non-repo host installPlatformApcSkills() resolved null and installed
 * NOTHING — the exact same "packing manifest drifted from the real dependency"
 * failure as plugins/ above (desktop205 D8). Falling through to
 * previous/builtin is safe: the npm tarball ships apc/ via `files`, and the
 * desktop's resources/runtime floor stages it in assemble-runtime.sh.
 *
 * Source manifest: runtime-required-entries.json. Desktop's Electron loader
 * keeps a static copy because packaged apps should not read repo source files at
 * runtime; test/apc-skill-distribution.test.ts asserts the static copy stays
 * byte-for-byte aligned with this manifest.
 */
export const BUNDLE_REQUIRED_ENTRIES = [...runtimeRequiredEntries.daemonBundle];

export type PointerName = 'current' | 'previous';

export interface VerifiedRuntimeMetadata {
  schemaVersion: 1;
  version: string;
  current: string;
  previous: string | null;
  sha256: string;
  signatureSha256: string;
  verified: true;
}

export type VerifiedRuntimeMetadataInput = Omit<VerifiedRuntimeMetadata, 'schemaVersion' | 'verified'>;

const VERIFIED_RUNTIME_METADATA_FILE = 'verified-runtime.json';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Root dir for bundle state: `<home>/bundle`. */
export function bundleRoot(home: string): string {
  return join(home, 'bundle');
}

/** Versioned bundle dir (no existence check). */
export function bundleDir(root: string, version: string): string {
  return join(root, version);
}

function isSafeVersion(version: string): boolean {
  return version.length > 0 && !version.includes('/') && !version.includes('..');
}

function verifiedRuntimeMetadataFile(root: string, version: string): string {
  return join(bundleDir(root, version), VERIFIED_RUNTIME_METADATA_FILE);
}

/** Persist proof only after a bundle has passed hash and signature checks. */
export function writeVerifiedRuntimeMetadata(root: string, version: string, input: VerifiedRuntimeMetadataInput): void {
  if (!isSafeVersion(version) || input.version !== version || input.current !== version) {
    throw new Error('verified runtime metadata version/current mismatch');
  }
  if (input.previous !== null && !isSafeVersion(input.previous)) {
    throw new Error('verified runtime metadata previous version is unsafe');
  }
  if (!SHA256_HEX.test(input.sha256) || !SHA256_HEX.test(input.signatureSha256)) {
    throw new Error('verified runtime metadata requires lowercase sha256 hex');
  }

  const target = verifiedRuntimeMetadataFile(root, version);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(
      tmp,
      JSON.stringify({ schemaVersion: 1, ...input, verified: true } satisfies VerifiedRuntimeMetadata),
      { encoding: 'utf8', mode: 0o640 },
    );
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Read proof for the exact version named by its containing slot. */
export function readVerifiedRuntimeMetadata(root: string, version: string): VerifiedRuntimeMetadata | null {
  if (!isSafeVersion(version)) return null;
  try {
    const parsed = JSON.parse(readFileSync(verifiedRuntimeMetadataFile(root, version), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.verified !== true ||
      parsed.version !== version ||
      parsed.current !== version ||
      (parsed.previous !== null && typeof parsed.previous !== 'string') ||
      (typeof parsed.previous === 'string' && !isSafeVersion(parsed.previous)) ||
      typeof parsed.sha256 !== 'string' ||
      typeof parsed.signatureSha256 !== 'string' ||
      !SHA256_HEX.test(parsed.sha256) ||
      !SHA256_HEX.test(parsed.signatureSha256)
    ) {
      return null;
    }
    return parsed as unknown as VerifiedRuntimeMetadata;
  } catch {
    return null;
  }
}

function pointerFile(root: string, name: PointerName): string {
  return join(root, name);
}

function blacklistFile(root: string): string {
  return join(root, 'blacklist.json');
}

function bootMarkerFile(root: string): string {
  return join(root, 'boot-attempt.json');
}

/** Read a pointer file (JSON `{ "version": "..." }`). Null on any failure. */
export function readPointer(root: string, name: PointerName): string | null {
  try {
    const f = pointerFile(root, name);
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as { version?: unknown };
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null;
    // Defensive: a pointer must not be able to escape the bundle root.
    if (parsed.version.includes('/') || parsed.version.includes('..')) return null;
    return parsed.version;
  } catch {
    return null;
  }
}

/** Atomic pointer write (temp + rename — never a torn pointer). */
export function writePointer(root: string, name: PointerName, version: string): void {
  mkdirSync(root, { recursive: true });
  const target = pointerFile(root, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version }), 'utf8');
  renameSync(tmp, target);
}

export function clearPointer(root: string, name: PointerName): void {
  rmSync(pointerFile(root, name), { force: true });
}

/** A bundle dir is usable iff it exists and has every required entry. */
export function isValidBundleDir(dir: string): boolean {
  return existsSync(dir) && BUNDLE_REQUIRED_ENTRIES.every((e) => existsSync(join(dir, e)));
}

// ── blacklist (2-strike, desktop-compatible semantics) ────────────────────────

function readBlacklist(root: string): Record<string, number> {
  try {
    const f = blacklistFile(root);
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeBlacklist(root: string, map: Record<string, number>): void {
  mkdirSync(root, { recursive: true });
  const target = blacklistFile(root);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), 'utf8');
  renameSync(tmp, target);
}

export function isBlacklisted(root: string, version: string): boolean {
  return (readBlacklist(root)[version] ?? 0) >= BUNDLE_FAIL_THRESHOLD;
}

/** Record a boot failure; returns the new count + whether the threshold tripped. */
export function recordBootFailure(root: string, version: string): { count: number; blacklisted: boolean } {
  const map = readBlacklist(root);
  const count = (map[version] ?? 0) + 1;
  map[version] = count;
  writeBlacklist(root, map);
  return { count, blacklisted: count >= BUNDLE_FAIL_THRESHOLD };
}

/** Clear the failure record for a version (on confirmed successful boot). */
export function clearBootFailures(root: string, version: string): void {
  const map = readBlacklist(root);
  if (map[version] === undefined) return;
  delete map[version];
  writeBlacklist(root, map);
}

// ── boot-attempt marker (crash detection across container restarts) ──────────

export interface BootMarker {
  version: string;
  at: string;
}

export function armBootMarker(root: string, version: string): void {
  mkdirSync(root, { recursive: true });
  const target = bootMarkerFile(root);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version, at: new Date().toISOString() } satisfies BootMarker), 'utf8');
  renameSync(tmp, target);
}

export function readBootMarker(root: string): BootMarker | null {
  try {
    const f = bootMarkerFile(root);
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as { version?: unknown; at?: unknown };
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null;
    return { version: parsed.version, at: typeof parsed.at === 'string' ? parsed.at : '' };
  } catch {
    return null;
  }
}

export function clearBootMarker(root: string): void {
  rmSync(bootMarkerFile(root), { force: true });
}

// ── cleanup (08 §2.3 step 1: 防被拉黑的坏 bundle 残留复活) ────────────────────

/**
 * Remove every versioned bundle dir NOT referenced by the current/previous
 * pointers. Keeps the rollback slot (回滚位) intact while guaranteeing that a
 * blacklisted/orphaned extraction can never resurrect across container
 * restarts (emptyDir survives in-place restarts — 08 §1.3 控制器模型).
 */
export function cleanupUnreferenced(root: string): string[] {
  if (!existsSync(root)) return [];
  const keep = new Set<string>([readPointer(root, 'current') ?? '', readPointer(root, 'previous') ?? '']);
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keep.has(entry.name)) continue;
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/** Remove a versioned bundle dir (post-blacklist cleanup; best-effort). */
export function removeBundleDir(root: string, version: string): void {
  try {
    rmSync(bundleDir(root, version), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── native deps borrowed from the image's built-in runtime ───────────────────

/**
 * Native deps the JS-only runtime bundle deliberately ships WITHOUT (the zip is
 * pure JS; the native .node binds the image's Node ABI and lives only in the
 * image's built-in node_modules).
 */
const BORROWED_NATIVE_DEPS = ['better-sqlite3'];

/**
 * Make the built-in runtime's native addons resolvable FROM a freshly-extracted
 * bundle by linking them into the bundle's own node_modules.
 *
 * WHY A LINK AND NOT `NODE_PATH` (desktop bundle-manager.ts, code-verified):
 * NODE_PATH is a CommonJS mechanism. dist/cli.js is ESM (`"type":"module"`),
 * and the ESM resolver does not consult NODE_PATH — it only walks node_modules
 * up the directory tree from the importing file. So the 08 §2.3 "NODE_PATH 借用"
 * intent (native modules resolve from the frozen image layer) is realized by
 * borrowing AT EXTRACT TIME into a place the ESM resolver actually looks:
 * a symlink, falling back to a copy. The wire invariant holds — the zip still
 * carries no native code.
 *
 * The source is resolved from THIS running module (the image's built-in
 * runtime executes the boot resolver, so `createRequire(import.meta.url)`
 * lands in the built-in node_modules).
 */
export function linkBuiltinNativeDeps(dir: string, log?: (line: string) => void): void {
  const bundleModules = join(dir, 'node_modules');
  const require = createRequire(import.meta.url);
  for (const dep of BORROWED_NATIVE_DEPS) {
    let target: string;
    try {
      target = dirname(require.resolve(`${dep}/package.json`));
    } catch {
      log?.(`[bundle-ota] ❌ built-in runtime has no ${dep} — bundle at ${dir} will not load`);
      continue;
    }
    const link = join(bundleModules, dep);
    if (existsSync(link)) continue; // already present (or already linked)
    try {
      mkdirSync(bundleModules, { recursive: true });
      symlinkSync(target, link, 'dir');
      log?.(`[bundle-ota] linked ${dep} → built-in runtime (ESM cannot use NODE_PATH)`);
    } catch {
      // A filesystem that refuses symlinks must not cost us the update.
      try {
        cpSync(target, link, { recursive: true });
        log?.(`[bundle-ota] copied ${dep} from built-in runtime (symlink failed)`);
      } catch (err2) {
        log?.(`[bundle-ota] ❌ could not provide ${dep}: ${(err2 as Error).message}`);
      }
    }
  }
}
