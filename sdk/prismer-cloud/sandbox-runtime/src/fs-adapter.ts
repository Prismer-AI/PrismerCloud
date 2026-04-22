import * as fsSync from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { evaluate, isFrozenPath } from './permission-engine.js';
import { safeResolvePath, UncPathError } from './safe-resolve.js';
import { getAuditWriter } from './audit.js';
import { matchGlob } from './glob.js';
import type { AuditEntry } from './audit.js';
import type { PermissionMode, PermissionRule } from './types.js';

// ============================================================
// Public types
// ============================================================

export interface FsContext {
  agentId: string;
  workspace: string;
  mode: PermissionMode;
  rules: PermissionRule[];
  requestId?: string;
  /**
   * G2: call origin — defaults to 'native' (in-process).
   * HTTP daemon handlers set this to 'http' so audit.jsonl entries reflect actual origin.
   */
  callPath?: 'native' | 'http' | 'relay';
  approvalGate?: (req: { toolName: string; path: string; reason: string }) => Promise<boolean>;
}

export class PermissionDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PermissionDeniedError';
  }
}

export class OutsideSandboxError extends Error {
  constructor(p: string, reason?: string) {
    super(reason !== undefined ? `Path outside sandbox: ${p} (${reason})` : `Path outside sandbox: ${p}`);
    this.name = 'OutsideSandboxError';
  }
}

// ============================================================
// Tool-name mapping: CC-style names for known ops
// ============================================================

const OP_TOOL: Record<string, string> = {
  read:   'Read',
  write:  'Write',
  delete: 'Delete',
  edit:   'Edit',
  list:   'List',
  search: 'Grep',
};

// ============================================================
// Audit helper
// ============================================================

function writeAudit(
  ctx: FsContext,
  operation: AuditEntry['operation'],
  realPath: string | undefined,
  decision: AuditEntry['decision'],
  extras: Partial<AuditEntry>,
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    agentId: ctx.agentId,
    operation,
    decision,
    callPath: ctx.callPath ?? 'native',
    ...(realPath !== undefined ? { path: realPath } : {}),
    ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...extras,
  };
  getAuditWriter().append(entry);
}

// ============================================================
// Path resolution for write targets that may not yet exist.
// safeResolvePath requires the path to exist (realpathSync).
// For new files, we resolve the nearest existing ancestor and
// reconstruct the final absolute path by appending the remaining
// segments — this preserves the workspace boundary check without
// requiring the target to be present on disk.
// ============================================================

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return os.homedir() + p.slice(1);
  }
  // Expand $VAR / ${VAR} the same way safeResolvePath does
  return p.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, b, bare) => {
    return process.env[b ?? bare] ?? '';
  });
}

interface WriteResolveResult {
  resolvedPath: string;
  inSandbox: boolean;
}

function resolveWritePath(inputPath: string, workspace: string): WriteResolveResult {
  // Reject UNC paths (same as safeResolvePath)
  if (inputPath.startsWith('//') || inputPath.startsWith('\\\\')) {
    throw new UncPathError(inputPath);
  }

  const expanded = expandTilde(inputPath);
  const abs = path.isAbsolute(expanded)
    ? expanded
    : path.join(workspace, expanded);

  // Walk up the path until we find an existing ancestor we can realpathSync
  const segments: string[] = [];
  let cur = abs;
  while (true) {
    try {
      const real = fsSync.realpathSync(cur);
      // Reconstruct the final path from the real ancestor + remaining segments
      const fullReal = segments.length > 0
        ? path.join(real, ...segments.reverse())
        : real;

      // Resolve workspace to its real path for boundary check
      let realWs: string;
      try {
        realWs = fsSync.realpathSync(workspace);
      } catch {
        realWs = workspace;
      }
      const inSandbox = fullReal === realWs || fullReal.startsWith(realWs + path.sep);
      return { resolvedPath: fullReal, inSandbox };
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached filesystem root with no existing ancestor — give up
        const resolved = path.normalize(abs);
        const inSandbox = resolved.startsWith(workspace + path.sep) || resolved === workspace;
        return { resolvedPath: resolved, inSandbox };
      }
      segments.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ============================================================
// Permission gate — shared across all ops
// Returns the resolved real path; throws on deny/error.
// For writes/deletes/edits, also throws OutsideSandboxError
// when the resolved path is outside the workspace.
// ============================================================

type OpKind = 'read' | 'write' | 'delete' | 'edit' | 'list' | 'search';
const WRITE_OPS = new Set<OpKind>(['write', 'delete', 'edit']);

async function checkPermission(
  ctx: FsContext,
  op: OpKind,
  inputPath: string,
): Promise<string> {
  let result: { resolvedPath: string; inSandbox: boolean };

  if (op === 'write') {
    // For writes, the target file may not exist yet — use ancestor-walking resolution
    // UncPathError propagates from resolveWritePath
    result = resolveWritePath(inputPath, ctx.workspace);
  } else {
    // safeResolvePath throws UncPathError for UNC paths — propagate without audit
    result = safeResolvePath(inputPath, ctx.workspace);
  }
  const realPath = result.resolvedPath;
  const toolName = OP_TOOL[op];

  // Write/delete/edit strictly require in-sandbox paths.
  if (WRITE_OPS.has(op) && !result.inSandbox) {
    writeAudit(ctx, op, realPath, 'deny', {
      toolName,
      reason: 'outside-sandbox',
    });
    throw new OutsideSandboxError(realPath);
  }

  const evalResult = evaluate(ctx.rules, ctx.mode, {
    toolName,
    filePath: realPath,
    args: realPath,
  });

  if (evalResult.decision === 'deny') {
    writeAudit(ctx, op, realPath, 'deny', {
      toolName,
      reason: evalResult.reason,
    });
    throw new PermissionDeniedError(evalResult.reason);
  }

  if (!WRITE_OPS.has(op) && !result.inSandbox) {
    const hasExplicitAllow = evalResult.decision === 'allow' && evalResult.matchedRule?.behavior === 'allow';
    if (ctx.mode !== 'bypassPermissions' && !hasExplicitAllow) {
      writeAudit(ctx, op, realPath, 'deny', {
        toolName,
        reason: 'outside-sandbox',
      });
      throw new OutsideSandboxError(realPath);
    }
  }

  if (evalResult.decision === 'ask') {
    if (ctx.approvalGate === undefined) {
      const reason = `approval gate not configured; cannot perform ${toolName} without explicit approval`;
      writeAudit(ctx, op, realPath, 'deny', { toolName, reason });
      throw new PermissionDeniedError(reason);
    }
    let approved: boolean;
    try {
      approved = await ctx.approvalGate({ toolName, path: realPath, reason: evalResult.reason });
    } catch (err) {
      const reason = `approval-gate-error: ${String(err)}`;
      writeAudit(ctx, op, realPath, 'deny', { toolName, reason });
      throw new PermissionDeniedError(reason);
    }
    if (!approved) {
      writeAudit(ctx, op, realPath, 'deny', {
        toolName,
        reason: 'approval gate denied',
      });
      throw new PermissionDeniedError('approval gate denied');
    }
  }

  // decision === 'allow' (or ask + gate approved) — proceed
  return realPath;
}

// ============================================================
// Binary detection: check for a null byte in the first 8KB
// ============================================================

function isBinary(buf: Buffer): boolean {
  const sample = buf.slice(0, 8192);
  return sample.includes(0);
}

// ============================================================
// fsRead
// ============================================================

export async function fsRead(
  ctx: FsContext,
  args: { path: string; offset?: number; limit?: number },
): Promise<{ content: string; bytes: number; encoding: 'utf8' | 'base64' }> {
  const start = Date.now();
  const realPath = await checkPermission(ctx, 'read', args.path);

  let buf: Buffer;
  try {
    if (args.offset !== undefined || args.limit !== undefined) {
      const offset = args.offset ?? 0;
      const fh = await fs.open(realPath, 'r');
      try {
        const stat = await fh.stat();
        const size = stat.size - offset;
        const length = args.limit !== undefined ? Math.min(args.limit, size) : size;
        if (length <= 0) {
          buf = Buffer.alloc(0);
        } else {
          const tmp = Buffer.alloc(length);
          const { bytesRead } = await fh.read(tmp, 0, length, offset);
          buf = tmp.slice(0, bytesRead);
        }
      } finally {
        await fh.close();
      }
    } else {
      buf = await fs.readFile(realPath);
    }
  } catch (err) {
    writeAudit(ctx, 'read', realPath, 'failed', {
      toolName: 'Read',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  const encoding: 'utf8' | 'base64' = isBinary(buf) ? 'base64' : 'utf8';
  const content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');

  writeAudit(ctx, 'read', realPath, 'executed', {
    toolName: 'Read',
    bytes: buf.length,
    durationMs: Date.now() - start,
  });

  return { content, bytes: buf.length, encoding };
}

// ============================================================
// fsWrite
// ============================================================

export async function fsWrite(
  ctx: FsContext,
  args: { path: string; content: string; encoding?: 'utf8' | 'base64' },
): Promise<{ bytes: number }> {
  const start = Date.now();
  const realPath = await checkPermission(ctx, 'write', args.path);

  let data: Buffer;
  try {
    if (args.encoding === 'base64') {
      data = Buffer.from(args.content, 'base64');
    } else {
      data = Buffer.from(args.content, 'utf8');
    }
    await fs.mkdir(path.dirname(realPath), { recursive: true });
    // I3: open with O_NOFOLLOW so that if the leaf path is a symlink, open()
    // fails with ELOOP instead of following the link to a potentially out-of-sandbox target.
    const fh = await fs.open(
      realPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  } catch (err) {
    // I3: translate ELOOP (kernel refused to follow symlink) → OutsideSandboxError.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      const symlinkErr = new OutsideSandboxError(
        realPath,
        'path is a symlink (refused to follow; possible escape attempt)',
      );
      writeAudit(ctx, 'write', realPath, 'deny', {
        toolName: 'Write',
        reason: 'symlink-refused',
        durationMs: Date.now() - start,
      });
      throw symlinkErr;
    }
    writeAudit(ctx, 'write', realPath, 'failed', {
      toolName: 'Write',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  writeAudit(ctx, 'write', realPath, 'executed', {
    toolName: 'Write',
    bytes: data.length,
    durationMs: Date.now() - start,
  });

  return { bytes: data.length };
}

// ============================================================
// fsDelete
// ============================================================

export async function fsDelete(
  ctx: FsContext,
  args: { path: string },
): Promise<{ deleted: boolean }> {
  const start = Date.now();
  const realPath = await checkPermission(ctx, 'delete', args.path);

  try {
    // Use stat to determine whether the target is a directory
    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      await fs.rm(realPath, { recursive: true });
    } else {
      await fs.rm(realPath, { force: false });
    }
  } catch (err) {
    writeAudit(ctx, 'delete', realPath, 'failed', {
      toolName: 'Delete',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  writeAudit(ctx, 'delete', realPath, 'executed', {
    toolName: 'Delete',
    durationMs: Date.now() - start,
  });

  return { deleted: true };
}

// ============================================================
// fsEdit
// ============================================================

export async function fsEdit(
  ctx: FsContext,
  args: { path: string; oldString: string; newString: string; replaceAll?: boolean },
): Promise<{ bytes: number; replaced: number }> {
  const start = Date.now();
  const realPath = await checkPermission(ctx, 'edit', args.path);

  let original: string;
  try {
    // I3: open for reading with O_NOFOLLOW — refuse to follow a symlink at the leaf.
    const rfh = await fs.open(
      realPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      original = await rfh.readFile({ encoding: 'utf8' });
    } finally {
      await rfh.close();
    }
  } catch (err) {
    // I3: translate ELOOP → OutsideSandboxError for the read phase.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      const symlinkErr = new OutsideSandboxError(
        realPath,
        'path is a symlink (refused to follow; possible escape attempt)',
      );
      writeAudit(ctx, 'edit', realPath, 'deny', {
        toolName: 'Edit',
        reason: 'symlink-refused',
        durationMs: Date.now() - start,
      });
      throw symlinkErr;
    }
    writeAudit(ctx, 'edit', realPath, 'failed', {
      toolName: 'Edit',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  if (!original.includes(args.oldString)) {
    writeAudit(ctx, 'edit', realPath, 'failed', {
      toolName: 'Edit',
      error: 'oldString not found',
      durationMs: Date.now() - start,
    });
    throw new Error('oldString not found');
  }

  let replaced = 0;
  let result: string;
  if (args.replaceAll === true) {
    // Count occurrences before replacing for the audit field
    let pos = 0;
    while ((pos = original.indexOf(args.oldString, pos)) !== -1) {
      replaced++;
      pos += args.oldString.length;
    }
    result = original.split(args.oldString).join(args.newString);
  } else {
    result = original.replace(args.oldString, args.newString);
    replaced = 1;
  }

  const data = Buffer.from(result, 'utf8');
  try {
    // I3: open for writing with O_NOFOLLOW — refuse to follow a symlink at the leaf.
    const wfh = await fs.open(
      realPath,
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      await wfh.writeFile(data);
    } finally {
      await wfh.close();
    }
  } catch (err) {
    // I3: translate ELOOP → OutsideSandboxError for the write phase.
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      const symlinkErr = new OutsideSandboxError(
        realPath,
        'path is a symlink (refused to follow; possible escape attempt)',
      );
      writeAudit(ctx, 'edit', realPath, 'deny', {
        toolName: 'Edit',
        reason: 'symlink-refused',
        durationMs: Date.now() - start,
      });
      throw symlinkErr;
    }
    writeAudit(ctx, 'edit', realPath, 'failed', {
      toolName: 'Edit',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  writeAudit(ctx, 'edit', realPath, 'executed', {
    toolName: 'Edit',
    bytes: data.length,
    durationMs: Date.now() - start,
  });

  return { bytes: data.length, replaced };
}

// ============================================================
// fsList
// ============================================================

interface ListEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
}

async function collectEntries(
  dir: string,
  baseDir: string,
  maxDepth: number,
  depth: number,
  entries: ListEntry[],
): Promise<void> {
  // Include hidden files (dotfiles) — caller filters if needed
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const abs = path.join(dir, item.name);
    // Relative to the list root, POSIX-style
    const rel = path.posix.join(path.relative(baseDir, abs).split(path.sep).join('/'));

    if (item.isSymbolicLink()) {
      entries.push({ path: rel, type: 'symlink' });
    } else if (item.isDirectory()) {
      entries.push({ path: rel, type: 'directory' });
      if (depth < maxDepth) {
        await collectEntries(abs, baseDir, maxDepth, depth + 1, entries);
      }
    } else {
      let size: number | undefined;
      try {
        const stat = await fs.stat(abs);
        size = stat.size;
      } catch {
        // best-effort — if stat fails, omit size
      }
      entries.push({ path: rel, type: 'file', size });
    }
  }
}

export async function fsList(
  ctx: FsContext,
  args: { path: string; maxDepth?: number },
): Promise<{ entries: ListEntry[] }> {
  const start = Date.now();
  const realPath = await checkPermission(ctx, 'list', args.path);
  const maxDepth = args.maxDepth ?? 1;

  const entries: ListEntry[] = [];
  try {
    await collectEntries(realPath, realPath, maxDepth, 1, entries);
  } catch (err) {
    writeAudit(ctx, 'list', realPath, 'failed', {
      toolName: 'List',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  writeAudit(ctx, 'list', realPath, 'executed', {
    toolName: 'List',
    durationMs: Date.now() - start,
  });

  return { entries };
}

// ============================================================
// fsSearch
// grep-style content search. Does NOT spawn ripgrep or any shell.
// `glob` filters file paths only — not content.
// `query` filters content lines (case-insensitive literal match).
// ============================================================

interface SearchMatch {
  path: string;
  line?: number;
  snippet?: string;
}

async function collectSearchFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory() && !item.isSymbolicLink()) {
      const sub = await collectSearchFiles(abs);
      results.push(...sub);
    } else if (item.isFile()) {
      results.push(abs);
    }
  }
  return results;
}

export async function fsSearch(
  ctx: FsContext,
  args: { query: string; path?: string; glob?: string },
): Promise<{ matches: SearchMatch[] }> {
  const start = Date.now();

  // For search, we run the permission check on the search root
  const searchRoot = args.path ?? ctx.workspace;
  let realRoot: string;
  try {
    // UncPathError propagates without audit
    realRoot = await checkPermission(ctx, 'search', searchRoot);
  } catch (err) {
    if ((err as Error).name === 'UncPathError') throw err;
    // PermissionDeniedError etc. already audited
    throw err;
  }

  const queryLower = args.query.toLowerCase();
  const matches: SearchMatch[] = [];

  let files: string[];
  try {
    const stat = fsSync.statSync(realRoot);
    if (stat.isFile()) {
      files = [realRoot];
    } else {
      files = await collectSearchFiles(realRoot);
    }
  } catch (err) {
    writeAudit(ctx, 'search', realRoot, 'failed', {
      toolName: 'Grep',
      error: String(err),
      durationMs: Date.now() - start,
    });
    throw err;
  }

  for (const file of files) {
    // `glob` filters on path only — not content
    if (args.glob !== undefined && !matchGlob(args.glob, file)) continue;

    // I2: check FROZEN rules on every individual file before reading its content.
    // The root-level permission check only covers the search root, not each discovered file.
    const frozenCheck = isFrozenPath(file);
    if (frozenCheck.frozen) {
      writeAudit(ctx, 'search', file, 'deny', {
        toolName: 'Grep',
        reason: `skipped-frozen: ${frozenCheck.reason ?? file}`,
      });
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      // Skip files that can't be read as text (binary, permission denied, etc.)
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        matches.push({
          path: file,
          line: i + 1,
          snippet: lines[i].trim(),
        });
      }
    }
  }

  writeAudit(ctx, 'search', realRoot, 'executed', {
    toolName: 'Grep',
    durationMs: Date.now() - start,
  });

  return { matches };
}

// Re-export UncPathError so callers can catch it directly from this module
export { UncPathError };
