// desktop202/17 Phase 9 — local mirror RPC route attacher.
//
// Wires the mirror operations onto the daemon local HTTP server (127.0.0.1) so
// electron main can drive Materialize / edit-check / upload-revision / reveal
// without re-implementing the byte/hardlink/index logic. The renderer never
// reaches these directly — electron is the only caller (preload `asset.*`).
//
// Endpoints (all POST, 127.0.0.1-only, capability-gated by MirrorManager
// presence — absent on CLI/K8s daemons → routes 404 / fall through):
//   POST /local/mirror/materialize     { workspaceId, assetId? , contentHash?, reveal?, pin? }
//   POST /local/mirror/pin-folder      { workspaceId, folderPath }
//   POST /local/mirror/unpin           { assetId }
//   POST /local/mirror/check-edits     { workspaceId? }
//   POST /local/mirror/read-edit       { assetId }  → bytes (base64) + hash for upload
//   POST /local/mirror/mark-uploaded   { assetId, revision, contentHash }
//   POST /local/mirror/register-import { workspaceId, assetId, contentHash, filename?, folderPath?, sourcePath, revision? }
//   POST /local/mirror/clear-conflict  { assetId }
//   POST /local/mirror/reclaim         { budgetBytes }
//   GET  /local/mirror/status          → { root, entries[], reclaimableBytes }

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetMetadataIndex } from './metadata-index.js';
import type { MirrorAssetDescriptor, MirrorManager } from './mirror-manager.js';

export interface AttachMirrorRpcOptions {
  mirror: MirrorManager;
  /** Resolve (or lazily sync) the asset metadata index for a workspace so a
   *  materialize-by-assetId can find filename/folderPath/contentHash. */
  resolveIndex: (workspaceId: string) => AssetMetadataIndex | undefined;
  ensureIndex?: (workspaceId: string) => Promise<AssetMetadataIndex | undefined>;
}

const MIRROR_PREFIX = '/local/mirror/';

export function attachMirrorRpc(
  opts: AttachMirrorRpcOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(MIRROR_PREFIX) && url !== '/local/mirror/status') return false;
    const [pathOnly = ''] = url.split('?', 2);
    const subpath = pathOnly.slice(MIRROR_PREFIX.length);
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && subpath === 'status') return handleStatus(opts, res);
      if (method !== 'POST') return false;
      const body = (await readJson(req)) as Record<string, unknown>;
      switch (subpath) {
        case 'materialize':
          return await handleMaterialize(opts, body, res);
        case 'pin-folder':
          return await handlePinFolder(opts, body, res);
        case 'unpin':
          return handleUnpin(opts, body, res);
        case 'check-edits':
          return handleCheckEdits(opts, body, res);
        case 'read-edit':
          return handleReadEdit(opts, body, res);
        case 'mark-uploaded':
          return handleMarkUploaded(opts, body, res);
        case 'register-import':
          return handleRegisterImport(opts, body, res);
        case 'clear-conflict':
          return handleClearConflict(opts, body, res);
        case 'reclaim':
          return handleReclaim(opts, body, res);
        default:
          return false;
      }
    } catch (err) {
      respond(res, 500, { error: 'mirror_rpc_failed', message: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };
}

async function resolveDescriptor(
  opts: AttachMirrorRpcOptions,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<MirrorAssetDescriptor | { error: string }> {
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  // Caller may pass filename/folderPath inline (Library already has them).
  const inlineName = typeof body.filename === 'string' ? body.filename : undefined;
  const inlineFolder = typeof body.folderPath === 'string' ? body.folderPath : undefined;
  const inlineRev = typeof body.revision === 'number' ? body.revision : undefined;

  if (assetId && contentHash && inlineName !== undefined) {
    return {
      assetId,
      contentHash,
      filename: inlineName,
      folderPath: inlineFolder ?? null,
      ...(inlineRev !== undefined ? { revision: inlineRev } : {}),
    };
  }

  // Otherwise resolve from the local metadata index.
  let index = opts.resolveIndex(workspaceId);
  if (!index) index = await opts.ensureIndex?.(workspaceId);
  if (!index) return { error: 'workspace asset index not synced' };
  let row = assetId ? index.resolveByAssetId(assetId) : contentHash ? index.resolveByContentHash(contentHash) : undefined;
  if (!row && opts.ensureIndex) {
    index = await opts.ensureIndex(workspaceId);
    row = assetId ? index?.resolveByAssetId(assetId) : contentHash ? index?.resolveByContentHash(contentHash) : undefined;
  }
  if (!row) return { error: 'asset not found in local metadata index' };
  return {
    assetId: row.assetId,
    contentHash: row.contentHash,
    filename: row.filename,
    folderPath: row.folderPath,
    ...(inlineRev !== undefined ? { revision: inlineRev } : {}),
  };
}

async function handleMaterialize(
  opts: AttachMirrorRpcOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<boolean> {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  if (!workspaceId) return respond400(res, 'workspaceId is required');
  const desc = await resolveDescriptor(opts, workspaceId, body);
  if ('error' in desc) return respond400(res, desc.error);
  const result = await opts.mirror.materialize(desc, {
    workspaceId,
    pin: body.pin === true,
    reveal: body.reveal === true,
  });
  respond(res, 200, { ok: true, ...result });
  return true;
}

async function handlePinFolder(
  opts: AttachMirrorRpcOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<boolean> {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const folderPath = typeof body.folderPath === 'string' ? body.folderPath : '';
  if (!workspaceId) return respond400(res, 'workspaceId is required');
  let index = opts.resolveIndex(workspaceId);
  if (!index) index = await opts.ensureIndex?.(workspaceId);
  if (!index) return respond400(res, 'workspace asset index not synced');
  // Members = workspace-file assets whose folderPath is the folder or below it.
  const prefix = folderPath.replace(/\/+$/, '');
  const members = index
    .search('', 1000)
    .filter((r) => {
      const fp = (r.folderPath ?? '').replace(/\/+$/, '');
      return prefix === '' ? true : fp === prefix || fp.startsWith(prefix + '/');
    })
    .map((r) => ({ assetId: r.assetId, contentHash: r.contentHash, filename: r.filename, folderPath: r.folderPath }));
  const result = await opts.mirror.pinFolder(members, { workspaceId });
  respond(res, 200, { ok: true, ...result });
  return true;
}

function handleUnpin(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (!assetId) return respond400(res, 'assetId is required');
  opts.mirror.unpin(assetId);
  respond(res, 200, { ok: true });
  return true;
}

function handleCheckEdits(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const results = opts.mirror.checkLocalEdits(workspaceId);
  respond(res, 200, { ok: true, edits: results });
  return true;
}

function handleReadEdit(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (!assetId) return respond400(res, 'assetId is required');
  const { bytes, contentHash, localPath } = opts.mirror.readLocalEdit(assetId);
  respond(res, 200, { ok: true, contentHash, localPath, base64: bytes.toString('base64') });
  return true;
}

function handleMarkUploaded(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  const revision = typeof body.revision === 'number' ? body.revision : 0;
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  if (!assetId || !contentHash) return respond400(res, 'assetId and contentHash are required');
  opts.mirror.markUploaded(assetId, revision, contentHash);
  respond(res, 200, { ok: true });
  return true;
}

function handleRegisterImport(
  opts: AttachMirrorRpcOptions,
  body: Record<string, unknown>,
  res: ServerResponse,
): boolean {
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath : '';
  if (!workspaceId || !assetId || !contentHash || !sourcePath) {
    return respond400(res, 'workspaceId, assetId, contentHash, sourcePath are required');
  }
  const registered = opts.mirror.registerImported({
    workspaceId,
    assetId,
    contentHash,
    sourcePath,
    filename: typeof body.filename === 'string' ? body.filename : null,
    folderPath: typeof body.folderPath === 'string' ? body.folderPath : null,
    ...(typeof body.revision === 'number' ? { revision: body.revision } : {}),
  });
  respond(res, 200, { ok: true, registered });
  return true;
}

function handleClearConflict(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const assetId = typeof body.assetId === 'string' ? body.assetId : '';
  if (!assetId) return respond400(res, 'assetId is required');
  opts.mirror.clearConflict(assetId);
  respond(res, 200, { ok: true });
  return true;
}

function handleReclaim(opts: AttachMirrorRpcOptions, body: Record<string, unknown>, res: ServerResponse): boolean {
  const budgetBytes = typeof body.budgetBytes === 'number' && body.budgetBytes >= 0 ? body.budgetBytes : 0;
  const result = opts.mirror.reclaim(budgetBytes);
  respond(res, 200, { ok: true, ...result });
  return true;
}

function handleStatus(opts: AttachMirrorRpcOptions, res: ServerResponse): boolean {
  respond(res, 200, {
    ok: true,
    root: opts.mirror.root,
    entries: opts.mirror.listEntries(),
    reclaimableBytes: opts.mirror.reclaimableBytes(),
  });
  return true;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function respond400(res: ServerResponse, message: string): boolean {
  respond(res, 400, { ok: false, error: 'invalid_request', message });
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk as string;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}
