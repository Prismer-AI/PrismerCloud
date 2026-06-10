// `prismer asset (list|get|by-hash|upload|download)` — asset smoke + artifact inspection.

import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { AssetCache } from '../../asset-cache.js';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { AssetMetadataIndex } from '../../daemon/asset/metadata-index.js';
import { WorkspaceMirror } from '../../daemon/asset/mirror.js';
import { openLocalDb, type LocalDb } from '../../sync/store.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string } | string;
  nextCursor?: string | null;
};

type AssetRow = {
  id: string;
  workspaceId?: string;
  taskId?: string | null;
  sourceTaskId?: string | null;
  mimeType?: string | null;
  mime?: string | null;
  size?: number | null;
  sizeBytes?: number | null;
  createdAt?: string;
  url?: string;
  meta?: Record<string, unknown>;
  kind?: string;
  metadata?: Record<string, unknown>;
  s3Url?: string | null;
  s3UrlExpiresIn?: number | null;
  photoRefs?: unknown[] | null;
  contentHash?: string;
  storageUri?: string;
};

type PrefetchRow = {
  asset_id: string;
  content_hash: string;
  mime: string | null;
  size_bytes: number;
};

type DirectUploadPlan =
  | {
      mode: 'single';
      bucket: string;
      key: string;
      uploadUrl: string;
      method?: string;
      headers?: Record<string, string>;
    }
  | {
      mode: 'multipart';
      bucket: string;
      key: string;
      uploadId: string;
      partSizeBytes: number;
      parts: Array<{ partNumber: number; url: string }>;
    };

type DirectUploadInitEnvelope = ApiEnvelope<DirectUploadPlan>;

export function buildAssetCommand(): Command {
  const cmd = new Command('asset').description('Inspect IM assets');

  cmd
    .command('sync')
    .description('Sync remote asset indexes into the local daemon DB; optionally prefetch bytes')
    .requiredOption('--workspace-id <id>', 'Workspace id')
    .option('--bytes', 'Also prefetch asset bytes into ~/.prismer/cache')
    .option('--limit <n>', 'Maximum number of assets to prefetch when --bytes is set', parsePositiveInt)
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{ workspaceId: string; bytes?: boolean; limit?: number; json?: boolean }]>(async (opts) => {
      const result = await syncAssets(opts);
      if (opts.json) {
        printJson({ ok: true, data: result });
        return;
      }
      getUI().line(`Synced asset metadata: ${result.metadata.applied} applied (cursor=${result.metadata.cursor})`);
      getUI().line(`Synced workspace files: ${result.workspaceFiles.applied} applied (cursor=${result.workspaceFiles.cursor ?? 'null'})`);
      if (opts.bytes) {
        getUI().line(
          `Prefetched bytes: ${result.prefetch.fetched}/${result.prefetch.considered} assets, ${result.prefetch.bytes} bytes`,
        );
        if (result.prefetch.failed.length > 0) {
          getUI().line(`Prefetch failures: ${result.prefetch.failed.length}`);
        }
      } else {
        getUI().line('Asset bytes were not prefetched; they are downloaded lazily on first use. Run with --bytes to fill ~/.prismer/cache.');
      }
    }, { code: 'asset_sync_failed' }));

  cmd
    .command('list')
    .description('List assets for a workspace, optionally filtered by task')
    .option('--workspace-id <id>', 'Workspace id')
    .option('--task-id <id>', 'Task id filter')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{ workspaceId?: string; taskId?: string; json?: boolean }]>(async (opts) => {
      const cloud = mkCloud();
      const query = new URLSearchParams();
      if (opts.workspaceId) query.set('workspaceId', opts.workspaceId);
      if (opts.taskId) query.set('taskId', opts.taskId);
      const path = `/api/im/assets${query.toString() ? `?${query.toString()}` : ''}`;
      const res = await cloud.request<unknown>('GET', path);
      if (!res.ok) exitWithError(`asset list failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'asset_list_failed' });
      const body = res.data as ApiEnvelope<AssetRow[]> | undefined;
      if (isErrorEnvelope(body)) {
        exitWithError(`asset list failed (${res.status}): ${errorMessage(body)}`, { code: 'asset_list_failed' });
      }
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printAssetList(body);
    }, { code: 'asset_list_failed' }));

  cmd
    .command('upload <path>')
    .description('Upload a local file or directory as IM assets')
    .requiredOption('--workspace-id <id>', 'Workspace id')
    .option('--kind <kind>', 'Asset kind', 'file')
    .option('--folder-path <path>', 'Cloud folderPath prefix for the uploaded file(s)')
    .option('--task-id <id>', 'Source task id')
    .option('--agent-id <id>', 'Source agent IM user id')
    .option('--container-id <id>', 'Container id; also added to metadata for sandbox-output assets')
    .option('--metadata <json>', 'Additional JSON metadata')
    .option('--mime <type>', 'Override file MIME type')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, {
      workspaceId: string;
      kind: string;
      taskId?: string;
      agentId?: string;
      containerId?: string;
      metadata?: string;
      mime?: string;
      folderPath?: string;
      json?: boolean;
    }]>(async (inputPath, opts) => {
      const body = await uploadAssetPath(inputPath, opts);
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      if (isUploadManyResult(body)) {
        getUI().line(`Uploaded ${body.data.count} assets`);
        for (const item of body.data.items) {
          printAssetDetail('Uploaded asset', item.file, item.response as ApiEnvelope<AssetRow> | undefined);
        }
      } else {
        printAssetDetail('Uploaded asset', inputPath, body as ApiEnvelope<AssetRow> | undefined);
      }
    }, { code: 'asset_upload_failed' }));

  cmd
    .command('download <assetId>')
    .description('Download asset bytes')
    .requiredOption('--out <path>', 'Destination file path')
    .action(runAction<[string, { out: string }]>(async (assetId, opts) => {
      await downloadAsset(assetId, opts.out);
      getUI().line(`Downloaded ${assetId} -> ${opts.out}`);
    }, { code: 'asset_download_failed' }));

  cmd
    .command('get <assetId>')
    .description('Fetch asset metadata by id')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (assetId, opts) => {
      const cloud = mkCloud();
      const res = await cloud.request<unknown>('GET', `/api/im/assets/${encodeURIComponent(assetId)}/detail`);
      if (!res.ok) exitWithError(`asset get failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'asset_get_failed' });
      const body = res.data as ApiEnvelope<AssetRow> | undefined;
      if (isErrorEnvelope(body)) {
        exitWithError(`asset get failed (${res.status}): ${errorMessage(body)}`, { code: 'asset_get_failed' });
      }
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printAssetDetail('Asset', assetId, body);
    }, { code: 'asset_get_failed' }));

  cmd
    .command('by-hash <sha256>')
    .description('Fetch asset metadata by content hash')
    .option('--workspace-id <id>', 'Workspace id (required by the cloud API)')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { workspaceId?: string; json?: boolean }]>(async (sha256, opts) => {
      const cloud = mkCloud();
      const query = new URLSearchParams();
      if (opts.workspaceId) query.set('wsId', opts.workspaceId);
      const path = `/api/im/assets/by-hash/${encodeURIComponent(sha256)}${query.toString() ? `?${query.toString()}` : ''}`;
      const res = await cloud.request<unknown>('GET', path);
      if (!res.ok) exitWithError(`asset by-hash failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'asset_by_hash_failed' });
      const body = res.data as ApiEnvelope<AssetRow> | undefined;
      if (isErrorEnvelope(body)) {
        exitWithError(`asset by-hash failed (${res.status}): ${errorMessage(body)}`, { code: 'asset_by_hash_failed' });
      }
      if (opts.json) {
        printJson(body ?? null);
        return;
      }
      printAssetDetail('Asset hash', sha256, body);
    }, { code: 'asset_by_hash_failed' }));

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

async function syncAssets(opts: {
  workspaceId: string;
  bytes?: boolean;
  limit?: number;
}): Promise<{
  workspaceId: string;
  metadata: { applied: number; cursor: number };
  workspaceFiles: { applied: number; cursor: string | null };
  prefetch: { considered: number; fetched: number; bytes: number; failed: Array<{ assetId: string; contentHash: string; error: string }> };
}> {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
  const db = openLocalDb(paths.localDb);
  try {
    const stateDir = `${paths.root}/${opts.workspaceId}`;
    const metadataIndex = new AssetMetadataIndex({
      db,
      cloud,
      workspaceId: opts.workspaceId,
      workspaceStateDir: stateDir,
    });
    const mirror = new WorkspaceMirror({
      db,
      cloud,
      workspaceId: opts.workspaceId,
      workspaceStateDir: stateDir,
    });

    const [metadata, workspaceFiles] = await Promise.all([
      metadataIndex.pullDelta(),
      mirror.pullDelta(),
    ]);

    const prefetch = opts.bytes
      ? await prefetchAssetBytes({
          db,
          cloud,
          workspaceId: opts.workspaceId,
          cacheDir: paths.cacheDir,
          maxBytes: cfg.cache?.max_bytes,
          limit: opts.limit,
        })
      : { considered: 0, fetched: 0, bytes: 0, failed: [] };

    return { workspaceId: opts.workspaceId, metadata, workspaceFiles, prefetch };
  } finally {
    db.close();
  }
}

async function prefetchAssetBytes(opts: {
  db: LocalDb;
  cloud: CloudClient;
  workspaceId: string;
  cacheDir: string;
  maxBytes?: number;
  limit?: number;
}): Promise<{ considered: number; fetched: number; bytes: number; failed: Array<{ assetId: string; contentHash: string; error: string }> }> {
  const limitClause = opts.limit ? ' LIMIT ?' : '';
  const params: unknown[] = [opts.workspaceId];
  if (opts.limit) params.push(opts.limit);
  const rows = opts.db
    .prepare(
      `SELECT asset_id, content_hash, mime, size_bytes
       FROM asset_metadata_index
       WHERE workspace_id = ?
       ORDER BY asset_index_seq DESC${limitClause}`,
    )
    .all(...params) as PrefetchRow[];

  const cache = new AssetCache({
    db: opts.db,
    cloud: opts.cloud,
    cacheDir: opts.cacheDir,
    maxBytes: opts.maxBytes,
  });

  let fetched = 0;
  let bytes = 0;
  const failed: Array<{ assetId: string; contentHash: string; error: string }> = [];
  for (const row of rows) {
    try {
      const cached = await cache.getOrFetch(row.content_hash, {
        workspaceIdHint: opts.workspaceId,
        assetId: row.asset_id,
      });
      fetched += 1;
      bytes += cached.sizeBytes;
    } catch (err) {
      failed.push({
        assetId: row.asset_id,
        contentHash: row.content_hash,
        error: (err as Error).message,
      });
    }
  }

  return { considered: rows.length, fetched, bytes, failed };
}

type UploadAssetOptions = {
  workspaceId: string;
  kind: string;
  taskId?: string;
  agentId?: string;
  containerId?: string;
  metadata?: string;
  mime?: string;
  folderPath?: string;
};

type UploadManyResult = {
  ok: true;
  data: {
    count: number;
    items: Array<{ file: string; folderPath: string | null; response: unknown }>;
  };
};

async function uploadAssetPath(inputPath: string, opts: UploadAssetOptions): Promise<unknown> {
  if (!existsSync(inputPath)) exitWithError(`path not found: ${inputPath}`);
  const stat = lstatSync(inputPath);
  if (stat.isSymbolicLink()) exitWithError(`refusing to upload symlink: ${inputPath}`);
  if (stat.isFile()) {
    return uploadAsset(inputPath, { ...opts, folderPath: normalizeFolderPath(opts.folderPath) });
  }
  if (!stat.isDirectory()) exitWithError(`path is not a file or directory: ${inputPath}`);

  const files = listFilesRecursive(inputPath);
  if (files.length === 0) exitWithError(`directory has no uploadable files: ${inputPath}`);

  const items: UploadManyResult['data']['items'] = [];
  for (const file of files) {
    const relDir = dirname(relative(inputPath, file));
    const folderPath = combineFolderPath(opts.folderPath, relDir === '.' ? '' : relDir);
    const response = await uploadAsset(file, { ...opts, folderPath });
    items.push({ file, folderPath: folderPath ?? null, response });
  }
  return { ok: true, data: { count: items.length, items } } satisfies UploadManyResult;
}

async function uploadAsset(
  file: string,
  opts: UploadAssetOptions,
): Promise<unknown> {
  if (!existsSync(file)) exitWithError(`file not found: ${file}`);
  const cfg = loadConfig(resolvePaths());
  const bytes = readFileSync(file);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const metadata = parseMetadata(opts.metadata);
  if (opts.taskId && metadata.taskId === undefined) metadata.taskId = opts.taskId;
  if (opts.containerId && metadata.containerId === undefined) metadata.containerId = opts.containerId;
  const mime = opts.mime ?? 'application/octet-stream';
  const filename = basename(file);
  const directResult = await tryDirectAssetUpload({
    baseUrl: cfg.cloud_api_base,
    apiKey: cfg.api_key,
    bytes,
    contentHash,
    filename,
    mime,
    metadata,
    opts,
  });
  if (directResult) return directResult;

  const form = new FormData();
  form.set('workspaceId', opts.workspaceId);
  form.set('kind', opts.kind);
  if (opts.agentId) form.set('sourceAgentImUserId', opts.agentId);
  if (opts.taskId) form.set('sourceTaskId', opts.taskId);
  if (opts.folderPath !== undefined) form.set('folderPath', opts.folderPath);
  if (Object.keys(metadata).length > 0) form.set('metadata', JSON.stringify(metadata));
  form.set('contentSha256', contentHash);
  form.set('file', new Blob([bytes], { type: mime }), filename);

  const url = `${cfg.cloud_api_base.replace(/\/$/, '')}/api/im/assets`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.api_key}`, 'X-Content-Sha256': contentHash },
      body: form,
    });
  } catch (err) {
    exitWithError(`asset upload failed: ${(err as Error).message}`);
  }

  const body = await parseResponseBody(res);
  if (!res.ok || isErrorEnvelope(body)) {
    exitWithError(`asset upload failed (${res.status}): ${errorMessage(body as ApiEnvelope<unknown>)}`);
  }
  return body;
}

async function tryDirectAssetUpload(input: {
  baseUrl: string;
  apiKey: string;
  bytes: Buffer;
  contentHash: string;
  filename: string;
  mime: string;
  metadata: Record<string, unknown>;
  opts: UploadAssetOptions;
}): Promise<unknown | null> {
  const baseUrl = input.baseUrl.replace(/\/$/, '');
  let initRes: Response;
  try {
    initRes = await fetch(`${baseUrl}/api/im/assets/direct-upload/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        workspaceId: input.opts.workspaceId,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.bytes.length,
        contentHash: input.contentHash,
      }),
    });
  } catch {
    return null;
  }
  const initBody = (await parseResponseBody(initRes)) as DirectUploadInitEnvelope | undefined;
  if (!initRes.ok || !isDirectUploadPlan(initBody?.data)) {
    return null;
  }

  const plan = initBody.data;
  let completedParts: Array<{ partNumber: number; etag: string }> | null;
  try {
    completedParts = await putDirectAssetBytes(plan, input.bytes, input.mime);
  } catch {
    return null;
  }

  let completeRes: Response;
  try {
    completeRes = await fetch(`${baseUrl}/api/im/assets/direct-upload/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        workspaceId: input.opts.workspaceId,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.bytes.length,
        contentHash: input.contentHash,
        kind: input.opts.kind,
        metadata: input.metadata,
        sourceAgentImUserId: input.opts.agentId,
        sourceTaskId: input.opts.taskId,
        folderPath: input.opts.folderPath,
        bucket: plan.bucket,
        key: plan.key,
        ...(plan.mode === 'multipart' ? { uploadId: plan.uploadId, parts: completedParts ?? [] } : {}),
      }),
    });
  } catch {
    return null;
  }

  const completeBody = await parseResponseBody(completeRes);
  if (!completeRes.ok || isErrorEnvelope(completeBody)) return null;
  return completeBody;
}

async function putDirectAssetBytes(
  plan: DirectUploadPlan,
  bytes: Buffer,
  mime: string,
): Promise<Array<{ partNumber: number; etag: string }> | null> {
  if (plan.mode === 'single') {
    const res = await fetch(plan.uploadUrl, {
      method: plan.method ?? 'PUT',
      headers: plan.headers,
      body: new Blob([bytes], { type: mime }),
    });
    if (!res.ok) throw new Error(`signed PUT failed (${res.status})`);
    return null;
  }

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  for (const part of plan.parts) {
    const start = (part.partNumber - 1) * plan.partSizeBytes;
    const end = Math.min(start + plan.partSizeBytes, bytes.length);
    const res = await fetch(part.url, {
      method: 'PUT',
      body: new Blob([bytes.subarray(start, end)], { type: mime }),
    });
    if (!res.ok) throw new Error(`signed part PUT failed (${res.status})`);
    const etag = res.headers.get('etag')?.replace(/^"|"$/g, '');
    if (!etag) throw new Error(`signed part PUT missing ETag for part ${part.partNumber}`);
    completedParts.push({ partNumber: part.partNumber, etag });
  }
  return completedParts;
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const full = join(root, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

function combineFolderPath(prefix: string | undefined, relDir: string): string | undefined {
  const normalizedPrefix = normalizeFolderPath(prefix);
  const normalizedRel = normalizeFolderPath(relDir);
  if (normalizedPrefix && normalizedRel) return `${normalizedPrefix}/${normalizedRel}`;
  return normalizedPrefix ?? normalizedRel;
}

function normalizeFolderPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : '';
}

function isUploadManyResult(raw: unknown): raw is UploadManyResult {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      (raw as { ok?: unknown }).ok === true &&
      (raw as { data?: { items?: unknown } }).data &&
      Array.isArray((raw as { data: { items?: unknown } }).data.items),
  );
}

async function downloadAsset(assetId: string, outPath: string): Promise<void> {
  const cloud = mkCloud();
  const res = await cloud.fetchRaw(`/api/im/assets/${encodeURIComponent(assetId)}`);
  if (!res.ok) {
    const body = await parseResponseBody(res);
    exitWithError(`asset download failed (${res.status}): ${errorMessage(body as ApiEnvelope<unknown>)}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, bytes);
}

function parseMetadata(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      exitWithError('--metadata must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    exitWithError(`invalid --metadata JSON: ${(err as Error).message}`);
  }
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: text };
  }
}

function isErrorEnvelope(raw: unknown): raw is ApiEnvelope<unknown> {
  return Boolean(raw && typeof raw === 'object' && 'ok' in raw && (raw as { ok?: unknown }).ok === false);
}

function isDirectUploadPlan(raw: unknown): raw is DirectUploadPlan {
  if (!raw || typeof raw !== 'object') return false;
  const plan = raw as Record<string, unknown>;
  if (plan.mode === 'single') {
    return typeof plan.bucket === 'string' && typeof plan.key === 'string' && typeof plan.uploadUrl === 'string';
  }
  if (plan.mode === 'multipart') {
    return (
      typeof plan.bucket === 'string' &&
      typeof plan.key === 'string' &&
      typeof plan.uploadId === 'string' &&
      typeof plan.partSizeBytes === 'number' &&
      Array.isArray(plan.parts)
    );
  }
  return false;
}

function errorMessage(raw: ApiEnvelope<unknown>): string {
  if (typeof raw.error === 'string') return raw.error;
  return raw.error?.message ?? 'request failed';
}

function unwrapData<T>(raw: ApiEnvelope<T> | undefined): T | undefined {
  if (!raw) return undefined;
  return raw.data;
}

function printAssetList(raw: ApiEnvelope<AssetRow[]> | undefined): void {
  const items = unwrapData(raw) ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    getUI().line('No assets found.');
    return;
  }

  getUI().line(`Assets (${items.length})`);
  for (const item of items) {
    const kind = item.mimeType ?? item.mime ?? item.kind ?? stringField(item.meta, 'kind') ?? stringField(item.metadata, 'kind');
    const size = item.size ?? item.sizeBytes;
    const taskId = item.taskId ?? item.sourceTaskId;
    const bits = [
      item.id,
      kind,
      size != null ? `${size} bytes` : undefined,
      item.workspaceId ? `ws=${item.workspaceId}` : undefined,
      taskId ? `task=${taskId}` : undefined,
    ].filter(Boolean);
    getUI().line(`- ${bits.join(' | ')}`);
  }
}

function printAssetDetail(label: string, id: string, raw: ApiEnvelope<AssetRow> | undefined): void {
  const item = unwrapData(raw);
  if (!item) {
    getUI().line(`${label} ${id}`);
    return;
  }

  getUI().line(`${label} ${item.id ?? id}`);
  writeLine('workspace', item.workspaceId);
  writeLine('task', item.taskId ?? item.sourceTaskId);
  writeLine('content hash', item.contentHash);
  writeLine('kind', item.kind ?? stringField(item.meta, 'kind') ?? stringField(item.metadata, 'kind'));
  writeLine('mime', item.mimeType ?? item.mime);
  const size = item.size ?? item.sizeBytes;
  writeLine('size', size != null ? `${size} bytes` : undefined);
  writeLine('storage', item.storageUri);
  writeLine('url', item.url);
  writeLine('s3Url', item.s3Url);
  writeLine('s3UrlExpiresIn', item.s3UrlExpiresIn != null ? `${item.s3UrlExpiresIn}s` : undefined);
  if (Array.isArray(item.photoRefs) && item.photoRefs.length > 0) {
    writeLine('photoRefs', item.photoRefs.length.toString());
  }
}

function writeLine(label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  getUI().line(`  ${label}: ${String(value)}`);
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePositiveInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  return n;
}
