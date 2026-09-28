/**
 * product209/15 PKF-H5 — native filesystem lane (§7.6.1/§7.6.2).
 *
 * checkout / status / commit / normalize over ordinary UTF-8 `.pkf` files in
 * the task root. The binding lives in the daemon's `PkfCheckoutStore`; the
 * FILE carries no token — document ACL is judged at checkout/commit time only.
 * No watcher auto-commit, no inode/xattr/FUSE dependence: `status` re-hashes
 * the bytes on disk every call; in-place writes and temp+rename are
 * equivalent because the binding keys on the NORMALIZED PATH.
 *
 * Carrier commit goes through the injected `PkfCarrierSource.commitToCloud`
 * operation-plane port with the base CAS — the registry is never Cloud truth.
 * A production adapter for this port belongs under `/api/pkf/*`; the historical
 * `/api/im/pkf/validate` route is compatibility-only and is not this commit lane.
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import * as crypto from 'node:crypto';
import {
  applyPkfNormalization,
  diffPkf,
  parsePkf,
  parsePkfSource,
  planPkfNormalization,
  validatePkf,
} from '@prismer/pkf';
import { PkfCheckoutStore } from './checkout-store';

export interface PkfCarrierSource {
  /** memory pages replicated locally (local-first). */
  getLocalMemorySource?: (documentUri: string, revisionId: string) => Promise<Uint8Array | null>;
  /** full-source commit through the Cloud operation plane. */
  commitToCloud: (input: {
    documentUri: string;
    baseRevisionId: string;
    baseSourceHash: string;
    source: Uint8Array;
    message: string;
  }) => Promise<{ newRevisionId: string; sourceHash: string }>;
}

export type PkfCheckoutReceipt =
  | { ok: true; checkoutId: string; workspaceRelativePath: string; baseRevisionId: string; baseSourceHash: string }
  | { ok: false; code: string; message: string };

export type PkfStatusReceipt =
  | {
      ok: true;
      state: 'clean' | 'dirty' | 'missing';
      sourceHash: string;
      baseSourceHash: string;
      validation: { structureStatus: 'pass' | 'fail' };
      normalizationChanged: boolean;
      diffStat: { linesAdded: number; linesRemoved: number; bytesDelta: number } | null;
    }
  | { ok: false; code: string; message: string };

export type PkfCommitReceipt =
  | { ok: true; newRevisionId: string; sourceHash: string; checkoutId: string }
  | { ok: false; code: string; message: string };

const sha256 = (b: Uint8Array | string): string =>
  crypto.createHash('sha256').update(b).digest('hex');

function deterministicCheckoutId(uri: string, workspaceRelativePath: string, taskId: string): string {
  return `ck_${sha256(`${uri}\0${workspaceRelativePath}\0${taskId}`).slice(0, 24)}`;
}

/** §7.6.1 path policy: normalized regular-file path inside the task root, no symlinks. */
export function assertCheckoutPathSafe(taskRoot: string, workspaceRelativePath: string): { abs: string; ok: true } | { ok: false; code: string; message: string } {
  const root = resolve(taskRoot);
  if (workspaceRelativePath.trim() === '' || workspaceRelativePath.includes('\\')) {
    return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'path must be a relative POSIX path' };
  }
  const abs = resolve(root, normalize(workspaceRelativePath));
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel === '..' || workspaceRelativePath.startsWith('/')) {
    return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'path escapes the task root' };
  }
  // every existing ancestor must be a real directory (no symlink chain)
  let probe = root;
  for (const seg of rel.split('/')) {
    probe = join(probe, seg);
    try {
      const st = lstatSync(probe);
      if (st.isSymbolicLink()) {
        return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'symlink in path chain' };
      }
      if (!st.isDirectory() && probe !== abs) {
        return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'path component is not a directory' };
      }
    } catch {
      // not created yet — the final write creates it
    }
  }
  try {
    if (lstatSync(root).isSymbolicLink()) {
      return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'task root is a symlink' };
    }
  } catch {
    return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'task root missing' };
  }
  return { abs, ok: true };
}

/** Reject symlink/device/absent targets at read time (never follow links). */
function readRegularFile(abs: string): { ok: true; bytes: Buffer } | { ok: false; code: string; message: string } {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { ok: false, code: 'PKF_CHECKOUT_MISSING', message: 'file missing' };
  }
  if (st.isSymbolicLink()) return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'symlink target rejected' };
  if (!st.isFile()) return { ok: false, code: 'PKF_CHECKOUT_PATH_FORBIDDEN', message: 'not a regular file' };
  return { ok: true, bytes: readFileSync(abs) };
}

function detectNormalizationChurn(fileBytes: Buffer): boolean {
  const text = fileBytes.toString('utf8');
  const hasBom = fileBytes.length >= 3 && fileBytes[0] === 0xef && fileBytes[1] === 0xbb && fileBytes[2] === 0xbf;
  if (hasBom) return true;
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf === lf; // whole-file LF→CRLF
}

/** §7.6.2 `pkf_checkout_file` — path-only lifecycle tool. */
export async function checkoutPkfFile(input: {
  uri: string;
  revisionId?: string;
  workspaceRelativePath: string;
  taskRoot: string;
  taskId: string;
  store: PkfCheckoutStore;
  carrier: PkfCarrierSource;
}): Promise<PkfCheckoutReceipt> {
  const pathCheck = assertCheckoutPathSafe(input.taskRoot, input.workspaceRelativePath);
  if (!pathCheck.ok) return pathCheck;

  // resolve the base bytes from the local-first carrier
  let baseBytes: Uint8Array | null = null;
  let baseRevisionId = input.revisionId ?? '';
  let baseHash = '';
  if (input.carrier.getLocalMemorySource) {
    const uri = input.uri;
    if (uri.includes('/memory/')) {
      const local = await input.carrier.getLocalMemorySource(uri, input.revisionId ?? 'head');
      if (local) {
        baseBytes = local;
        baseHash = sha256(local);
        baseRevisionId = input.revisionId ?? `local:${baseHash.slice(0, 16)}`;
      }
    }
  }
  if (!baseBytes) {
    return { ok: false, code: 'PKF_CHECKOUT_NOT_BOUND', message: 'document not available locally — resolve through Cloud first' };
  }

  const checkoutId = deterministicCheckoutId(input.uri, input.workspaceRelativePath, input.taskId);
  mkdirSync(dirname(pathCheck.abs), { recursive: true });
  writeFileSync(pathCheck.abs, Buffer.from(baseBytes));
  input.store.upsert({
    checkoutId,
    workspaceRelativePath: input.workspaceRelativePath,
    taskRoot: resolve(input.taskRoot),
    documentUri: input.uri,
    baseRevisionId,
    baseSourceHash: baseHash,
    taskId: input.taskId,
    state: 'clean',
    checkedOutAt: new Date().toISOString(),
  });
  return {
    ok: true,
    checkoutId,
    workspaceRelativePath: input.workspaceRelativePath,
    baseRevisionId,
    baseSourceHash: baseHash,
  };
}

/** §7.6.2 `pkf_status_file` — re-hash + validate + bounded diff. */
export async function statusPkfFile(input: {
  workspaceRelativePath: string;
  taskRoot: string;
  store: PkfCheckoutStore;
  carrier: PkfCarrierSource;
}): Promise<PkfStatusReceipt> {
  const binding = input.store.getByPath(input.workspaceRelativePath, resolve(input.taskRoot));
  if (!binding) return { ok: false, code: 'PKF_CHECKOUT_NOT_BOUND', message: 'no checkout binding for this path' };
  const pathCheck = assertCheckoutPathSafe(input.taskRoot, input.workspaceRelativePath);
  if (!pathCheck.ok) return pathCheck;
  const read = readRegularFile(pathCheck.abs);
  if (!read.ok) {
    input.store.markState(binding.checkoutId, 'missing');
    return read.code === 'PKF_CHECKOUT_MISSING' ? { ok: true, state: 'missing', sourceHash: '', baseSourceHash: binding.baseSourceHash, validation: { structureStatus: 'fail' }, normalizationChanged: false, diffStat: null } : read;
  }
  const fileHash = sha256(read.bytes);
  const clean = fileHash === binding.baseSourceHash;
  input.store.markState(binding.checkoutId, clean ? 'clean' : 'dirty');
  const parsed = parsePkf(read.bytes.toString('utf8'));
  const validation = validatePkf(parsed);
  const normalizationChanged = detectNormalizationChurn(read.bytes);
  let diffStat: { linesAdded: number; linesRemoved: number; bytesDelta: number } | null = null;
  if (!clean) {
    const baseBytes = input.carrier.getLocalMemorySource
      ? await input.carrier.getLocalMemorySource(binding.documentUri, binding.baseRevisionId)
      : null;
    if (baseBytes) {
      const d = diffPkf(baseBytes.toString(), read.bytes.toString('utf8'));
      diffStat = {
        linesAdded: d.receipt.bytesChanged.added === 0 ? d.source.page.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length : d.receipt.bytesChanged.added,
        linesRemoved: d.source.page.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
        bytesDelta: d.receipt.bytesChanged.added - d.receipt.bytesChanged.removed,
      };
    }
  }
  return {
    ok: true,
    state: clean ? 'clean' : 'dirty',
    sourceHash: fileHash,
    baseSourceHash: binding.baseSourceHash,
    validation: { structureStatus: validation.structureStatus },
    normalizationChanged,
    diffStat,
  };
}

/** §7.6.2 `pkf_commit_file` — candidate = final file bytes → carrier CAS commit. */
export async function commitPkfFile(input: {
  workspaceRelativePath: string;
  taskRoot: string;
  message: string;
  allowSourceNormalization?: boolean;
  store: PkfCheckoutStore;
  carrier: PkfCarrierSource;
}): Promise<PkfCommitReceipt> {
  const binding = input.store.getByPath(input.workspaceRelativePath, resolve(input.taskRoot));
  if (!binding) return { ok: false, code: 'PKF_CHECKOUT_NOT_BOUND', message: 'no checkout binding for this path' };
  const status = await statusPkfFile(input);
  if (!status.ok) return status;
  if (status.state === 'clean') return { ok: false, code: 'PKF_CHECKOUT_NOT_BOUND', message: 'worktree is clean — nothing to commit' };
  if (status.normalizationChanged && !input.allowSourceNormalization) {
    return { ok: false, code: 'PKF_SOURCE_NORMALIZATION_CHANGED', message: 'whole-file BOM/CRLF churn — pass --allow-source-normalization with a dry-run receipt' };
  }
  if (status.validation.structureStatus === 'fail') {
    return { ok: false, code: 'INVALID_PKF', message: 'candidate failed whole-page validation' };
  }
  const pathCheck = assertCheckoutPathSafe(input.taskRoot, input.workspaceRelativePath);
  if (!pathCheck.ok) return pathCheck;
  const read = readRegularFile(pathCheck.abs);
  if (!read.ok) return read;
  const committed = await input.carrier.commitToCloud({
    documentUri: binding.documentUri,
    baseRevisionId: binding.baseRevisionId,
    baseSourceHash: binding.baseSourceHash,
    source: new Uint8Array(read.bytes),
    message: input.message,
  });
  // the binding advances to the committed head — a copied unregistered path
  // never inherits commit authority
  input.store.upsert({
    checkoutId: binding.checkoutId,
    workspaceRelativePath: binding.workspaceRelativePath,
    taskRoot: binding.taskRoot,
    documentUri: binding.documentUri,
    baseRevisionId: committed.newRevisionId,
    baseSourceHash: committed.sourceHash,
    taskId: binding.taskId,
    state: 'clean',
    checkedOutAt: binding.checkedOutAt,
  });
  return { ok: true, newRevisionId: committed.newRevisionId, sourceHash: committed.sourceHash, checkoutId: binding.checkoutId };
}

/** §7.6.2 `pkf_normalize_file` — structural normalization only, no business diffs. */
export async function normalizePkfFile(input: {
  workspaceRelativePath: string;
  taskRoot: string;
  documentUri: string;
  store: PkfCheckoutStore;
  dryRun?: boolean;
}): Promise<PkfCommitReceipt> {
  const binding = input.store.getByPath(input.workspaceRelativePath, resolve(input.taskRoot));
  if (!binding) return { ok: false, code: 'PKF_CHECKOUT_NOT_BOUND', message: 'no checkout binding for this path' };
  const pathCheck = assertCheckoutPathSafe(input.taskRoot, input.workspaceRelativePath);
  if (!pathCheck.ok) return pathCheck;
  const read = readRegularFile(pathCheck.abs);
  if (!read.ok) return read;
  const source = read.bytes.toString('utf8');
  const plan = planPkfNormalization(parsePkfSource(source), { documentId: input.documentUri });
  if (plan.isNoOp) return { ok: true, newRevisionId: binding.baseRevisionId, sourceHash: binding.baseSourceHash, checkoutId: binding.checkoutId };
  const applied = applyPkfNormalization(source, plan);
  if (!applied.ok) return { ok: false, code: 'INVALID_PKF', message: applied.error };
  if (!input.dryRun) {
    writeFileSync(pathCheck.abs, applied.normalizedSource);
    input.store.markState(binding.checkoutId, 'dirty');
  }
  return { ok: true, newRevisionId: binding.baseRevisionId, sourceHash: binding.baseSourceHash, checkoutId: binding.checkoutId };
}
