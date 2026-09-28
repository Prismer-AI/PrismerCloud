import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillResolutionSource = 'remote' | 'lkg' | 'bundled-fallback';

export interface ResolvableSkillFile {
  path: string;
  size: number;
  sha256: string;
  inline?: boolean;
  content?: string;
  url?: string;
}

export interface SkillResolutionResult {
  ok: boolean;
  slug: string;
  source?: SkillResolutionSource;
  revision: string | null;
  contentHash: string | null;
  staleReason: string | null;
  changed: boolean;
  error?: string;
}

export interface SkillResolutionHealth {
  counts: {
    remote: number;
    lkg: number;
    bundledFallback: number;
    failed: number;
  };
  last?: {
    slug: string;
    source: SkillResolutionSource;
    revision: string | null;
    contentHash: string | null;
    staleReason: string | null;
  };
  sampledAt: number;
}

export interface ResolveSkillSourceOptions {
  slug: string;
  targetDir: string;
  remote?: {
    files: ResolvableSkillFile[];
    declaredRevision?: string | null;
  };
  bundledDir?: string | null;
  signal?: AbortSignal;
  fetchUrl?: (url: string, signal?: AbortSignal) => Promise<Buffer>;
}

const counts = { remote: 0, lkg: 0, bundledFallback: 0, failed: 0 };
export const SKILL_SOURCE_RECEIPT = '.prismer-skill-receipt.json';
const RECEIPT = SKILL_SOURCE_RECEIPT;
let last: SkillResolutionHealth['last'];
let sampledAt = Date.now();

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || path.startsWith('/') || path.startsWith('\\')) return false;
  if (path.length > 512) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]+/).some((part) => part === '..' || part === '.' || part === '');
}

function merkle(files: Array<{ path: string; sha256: string }>): string {
  const canonical = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path.replaceAll('\\', '/')}:${file.sha256}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

async function walk(root: string, current = root): Promise<Array<{ path: string; sha256: string }>> {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  const result: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (current === root && entry.name === RECEIPT) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(root, absolute)));
    else if (entry.isFile()) {
      result.push({
        path: relative(root, absolute).split(sep).join('/'),
        sha256: sha256(await fsp.readFile(absolute)),
      });
    } else throw new Error(`unsupported skill resource: ${absolute}`);
  }
  return result;
}

async function snapshot(dir: string): Promise<{ revision: string; files: Array<{ path: string; sha256: string }> } | null> {
  try {
    if (!(await fsp.lstat(dir)).isDirectory()) return null;
    const files = await walk(dir);
    if (!files.some((file) => file.path === 'SKILL.md')) return null;
    return { revision: merkle(files), files };
  } catch {
    return null;
  }
}

export async function verifiedLocalSnapshot(dir: string): Promise<{ revision: string } | null> {
  try {
    const receiptPath = join(dir, RECEIPT);
    if (!(await fsp.lstat(receiptPath)).isFile()) return null;
    const receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8'));
    if (receipt.version !== 1 || !Array.isArray(receipt.files) || typeof receipt.revision !== 'string') return null;
    const current = await snapshot(dir);
    if (!current || current.revision !== receipt.revision) return null;
    // Compare the full installation inventory, not a new hash promoted from current disk contents.
    if (JSON.stringify(current.files) !== JSON.stringify(receipt.files)) return null;
    return { revision: receipt.revision };
  } catch {
    return null;
  }
}

async function sealSnapshot(dir: string, expectedRevision: string): Promise<void> {
  const current = await snapshot(dir);
  if (!current || current.revision !== expectedRevision) throw new Error('staged skill snapshot changed before installation');
  await fsp.writeFile(join(dir, RECEIPT), JSON.stringify({ version: 1, ...current }), { mode: 0o600 });
}

/**
 * Resolve a bundled skill directory by canonical slug or by a canonical
 * SKILL.md's `metadata.aliases` compatibility list.
 *
 * The direct directory always wins. Alias discovery only scans when the old
 * slug has no directory, keeping the common path cheap while allowing the
 * package to ship one consolidated skill instead of a dozen duplicate trees.
 */
export async function resolveBundledSkillDirectory(root: string, slug: string): Promise<string | null> {
  const direct = join(root, slug);
  if (await snapshot(direct)) return direct;

  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const aliasClaimants: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    let content: string;
    try {
      content = await fsp.readFile(join(candidate, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
    if (!frontmatter) continue;
    try {
      const parsed = parseYaml(frontmatter) as { metadata?: { aliases?: unknown } } | null;
      const aliases = parsed?.metadata?.aliases;
      if (Array.isArray(aliases) && aliases.some((value) => value === slug)) aliasClaimants.push(candidate);
    } catch {
      // A malformed unrelated skill must not block the rest of the bundle.
    }
  }
  return aliasClaimants.length === 1 ? aliasClaimants[0]! : null;
}

async function atomicReplace(sourceDir: string, targetDir: string): Promise<void> {
  const backup = `${targetDir}.previous-${process.pid}-${randomBytes(4).toString('hex')}`;
  let hadTarget = false;
  try {
    await fsp.access(targetDir);
    hadTarget = true;
    await fsp.rename(targetDir, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    await fsp.rename(sourceDir, targetDir);
    if (hadTarget) await fsp.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget) {
      await fsp.rm(targetDir, { recursive: true, force: true });
      await fsp.rename(backup, targetDir);
    }
    throw error;
  }
}

async function stageRemote(options: ResolveSkillSourceOptions): Promise<{ revision: string; stagedDir: string }> {
  const remote = options.remote;
  if (!remote || remote.files.length === 0) throw new Error('remote manifest has no files');
  const stagedDir = `${options.targetDir}.next-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.rm(stagedDir, { recursive: true, force: true });
  await fsp.mkdir(stagedDir, { recursive: true });

  try {
    const verified: Array<{ path: string; sha256: string }> = [];
    const seenPaths = new Set<string>();
    for (const file of remote.files) {
      if (!safeRelativePath(file.path)) throw new Error(`unsafe manifest path: ${file.path}`);
      if (file.path.split(/[\\/]/)[0] === RECEIPT) throw new Error('manifest contains reserved local receipt path');
      if (seenPaths.has(file.path)) throw new Error(`duplicate manifest path: ${file.path}`);
      seenPaths.add(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error(`${file.path} has invalid size: ${file.size}`);
      }
      if (!/^[a-f0-9]{64}$/i.test(file.sha256)) {
        throw new Error(`${file.path} has invalid sha256`);
      }
      let bytes: Buffer;
      if (file.inline !== false && typeof file.content === 'string') {
        bytes = Buffer.from(file.content, 'base64');
      } else if (file.url && options.fetchUrl) {
        bytes = await options.fetchUrl(file.url, options.signal);
      } else {
        throw new Error(`${file.path} has neither inline content nor a fetchable url`);
      }
      if (bytes.byteLength !== file.size) {
        throw new Error(`${file.path} size mismatch (expected ${file.size}, got ${bytes.byteLength})`);
      }
      const actual = sha256(bytes);
      if (actual !== file.sha256) {
        throw new Error(`${file.path} hash mismatch (expected ${file.sha256}, got ${actual})`);
      }
      const target = join(stagedDir, file.path);
      if (target !== stagedDir && !target.startsWith(`${stagedDir}${sep}`)) {
        throw new Error(`manifest path escapes target: ${file.path}`);
      }
      await fsp.mkdir(dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      verified.push({ path: file.path, sha256: actual });
    }

    if (!verified.some((file) => file.path === 'SKILL.md')) {
      throw new Error('remote manifest is missing SKILL.md');
    }
    const revision = merkle(verified);
    if (remote.declaredRevision && remote.declaredRevision !== revision) {
      throw new Error(`declared revision ${remote.declaredRevision} does not match verified revision ${revision}`);
    }
    await sealSnapshot(stagedDir, revision);
    return { revision, stagedDir };
  } catch (error) {
    await fsp.rm(stagedDir, { recursive: true, force: true });
    throw error;
  }
}

function record(result: SkillResolutionResult): SkillResolutionResult {
  sampledAt = Date.now();
  if (!result.ok || !result.source) {
    counts.failed += 1;
    return result;
  }
  if (result.source === 'bundled-fallback') counts.bundledFallback += 1;
  else counts[result.source] += 1;
  last = {
    slug: result.slug,
    source: result.source,
    revision: result.revision,
    contentHash: result.contentHash,
    staleReason: result.staleReason,
  };
  return result;
}

export async function resolveSkillSource(options: ResolveSkillSourceOptions): Promise<SkillResolutionResult> {
  let staleReason: string | null = null;
  if (options.remote) {
    try {
      const staged = await stageRemote(options);
      const current = await verifiedLocalSnapshot(options.targetDir);
      const changed = current?.revision !== staged.revision;
      if (!changed) {
        await fsp.rm(staged.stagedDir, { recursive: true, force: true });
        return record({
          ok: true,
          slug: options.slug,
          source: 'remote',
          revision: staged.revision,
          contentHash: staged.revision,
          staleReason: null,
          changed: false,
        });
      }
      await fsp.mkdir(dirname(options.targetDir), { recursive: true });
      await atomicReplace(staged.stagedDir, options.targetDir);
      return record({
        ok: true,
        slug: options.slug,
        source: 'remote',
        revision: staged.revision,
        contentHash: staged.revision,
        staleReason: null,
        changed: true,
      });
    } catch (error) {
      staleReason = error instanceof Error ? error.message : String(error);
    }
  } else {
    staleReason = 'remote manifest unavailable';
  }

  const lkg = await verifiedLocalSnapshot(options.targetDir);
  if (lkg) {
    return record({
      ok: true,
      slug: options.slug,
      source: 'lkg',
      revision: lkg.revision,
      contentHash: lkg.revision,
      staleReason,
      changed: false,
    });
  }

  if (options.bundledDir) {
    const bundled = await snapshot(options.bundledDir);
    if (bundled) {
      const stagedDir = `${options.targetDir}.next-${process.pid}-${randomBytes(4).toString('hex')}`;
      await fsp.rm(stagedDir, { recursive: true, force: true });
      await fsp.mkdir(dirname(stagedDir), { recursive: true });
      await fsp.cp(options.bundledDir, stagedDir, { recursive: true });
      await sealSnapshot(stagedDir, bundled.revision);
      await fsp.mkdir(dirname(options.targetDir), { recursive: true });
      await atomicReplace(stagedDir, options.targetDir);
      return record({
        ok: true,
        slug: options.slug,
        source: 'bundled-fallback',
        revision: bundled.revision,
        contentHash: bundled.revision,
        staleReason,
        changed: true,
      });
    }
  }

  return record({
    ok: false,
    slug: options.slug,
    revision: null,
    contentHash: null,
    staleReason,
    changed: false,
    error: `skill_resolution_failed: ${options.slug}: ${staleReason}`,
  });
}

export function snapshotSkillResolutionHealth(): SkillResolutionHealth {
  return {
    counts: { ...counts },
    ...(last ? { last: { ...last } } : {}),
    sampledAt,
  };
}

export function __resetSkillResolutionHealth(): void {
  counts.remote = 0;
  counts.lkg = 0;
  counts.bundledFallback = 0;
  counts.failed = 0;
  last = undefined;
  sampledAt = Date.now();
}
