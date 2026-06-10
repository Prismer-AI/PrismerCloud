// Upload Runner — consumes OriginOutbox rows and posts to cloud.
//
// Generic over OriginAdapter: the worker doesn't know about drop-folder vs
// other producers. It looks up the adapter by `originKind`, calls
// `fetch(obs)` to materialize bytes, and POSTs to cloud
// `POST /api/im/assets` via an injected `CloudUploadClient` (real one wraps
// CloudClient + FormData; tests use a fake).
//
// Success/failure delegate back to the adapter via the optional
// onUploadSuccess / onUploadFailure hooks — that's where drop-folder moves
// its files into `uploaded/` and `upload-failed/`.
//
// Restart resume: pending rows persisted in SQLite outbox survive process
// death; on next runner construction, `resetClaimed()` re-promotes any
// orphaned 'claimed' rows back to 'pending' (Phase-0 single-worker
// assumption — no lease/heartbeat sweeper yet).

import type { OriginAdapter, OriginKind, SourceBytes, SourceObservation } from './spi.js';
import type { OriginOutbox, OutboxRow } from './outbox.js';
import { createHash } from 'node:crypto';

export interface CloudUploadRequest {
  workspaceId: string;
  filename: string;
  bytes: Buffer;
  mime: string | null;
  size: number;
  /** Cloud asset kind. Defaults to `file`. */
  kind?: string;
  /** Cloud-side metadata JSON (sourceRef / sourceKind / sourceAgentImUserId etc.). */
  metadata: Record<string, unknown>;
  /** Optional cloud `folderPath` column (drives library grouping in UI). */
  folderPath?: string;
  /** Optional cloud `description` column. */
  description?: string;
  /** Optional cloud `sourceTaskId` column. */
  sourceTaskId?: string;
  /** Optional cloud `sourceAgentImUserId` column. */
  sourceAgentImUserId?: string;
}

export interface CloudUploadResponse {
  assetId: string;
  contentHash: string;
}

export interface CloudUploadClient {
  uploadAsset(req: CloudUploadRequest): Promise<CloudUploadResponse>;
}

export interface DaemonAssetUploadClientOptions {
  cloudApiBase: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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

type DirectUploadInitResponse = DirectUploadPlan & {
  contentHash?: string;
  sizeBytes?: number;
  mime?: string | null;
};

export interface UploadRunnerOptions {
  outbox: OriginOutbox;
  cloud: CloudUploadClient;
  adapters: Partial<Record<OriginKind, OriginAdapter>>;
  /** Maximum attempts before moving the row to dead-letter. */
  maxAttempts: number;
}

interface AdapterHooks {
  onUploadSuccess?(obs: SourceObservation): Promise<void> | void;
  onUploadFailure?(obs: SourceObservation, err: unknown): Promise<void> | void;
}

export class UploadRunner {
  constructor(private readonly opts: UploadRunnerOptions) {
    // Restart-resume invariant: any row left in 'claimed' state from a
    // previous process death is, by Phase-0 single-worker assumption, an
    // orphan that needs re-attempting. Promote them all back to 'pending'
    // before we start draining so they get picked up by claimNext().
    opts.outbox.resetClaimed();
  }

  /**
   * Process every currently-pending outbox row exactly once. Failed rows
   * stay 'pending' (with attempts+1) for the next drainOnce call; rows
   * that hit maxAttempts spill to dead-letter and trigger onUploadFailure.
   *
   * Returns the count of rows processed (success + failure).
   */
  async drainOnce(): Promise<number> {
    let count = 0;
    while (true) {
      const claim = this.opts.outbox.claimNext();
      if (!claim) break;
      count += 1;
      const row = claim.row;
      const adapter = this.opts.adapters[row.originKind as OriginKind];
      if (!adapter) {
        this.opts.outbox.recordFailure(claim.id, `no adapter registered for kind=${row.originKind}`, {
          maxAttempts: 1, // unrecoverable — fast-fail to dead-letter
        });
        continue;
      }
      try {
        const obs = rowToObservation(row);
        const bytes = await adapter.fetch(obs);
        const id = await adapter.identifySource(obs);
        const filename = id.hints?.filename ?? path.basename(row.sourceRef);
        const metadata: Record<string, unknown> = {
          sourceRef: row.sourceRef,
          sourceKind: row.originKind,
        };
        if (id.hints?.description) metadata.description = id.hints.description;
        if (id.hints?.sourceAgentImUserId) {
          metadata.sourceAgentImUserId = id.hints.sourceAgentImUserId;
        }
        const folderPath = id.hints?.folderPath || undefined;
        const description = id.hints?.description || undefined;
        const sourceAgentImUserId = id.hints?.sourceAgentImUserId || undefined;
        const result = await this.opts.cloud.uploadAsset({
          workspaceId: row.workspaceId,
          filename,
          bytes: bytes.bytes,
          mime: bytes.mime,
          size: bytes.size,
          metadata,
          folderPath,
          description,
          sourceAgentImUserId,
        });
        this.opts.outbox.markUploaded(claim.id, result);
        await (adapter as AdapterHooks).onUploadSuccess?.(obs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const before = this.opts.outbox.deadLetterCount();
        this.opts.outbox.recordFailure(claim.id, message, { maxAttempts: this.opts.maxAttempts });
        const after = this.opts.outbox.deadLetterCount();
        if (after > before) {
          // Spilled to dead-letter — give the adapter a chance to mark the
          // source as terminally failed (drop-folder moves to upload-failed/).
          const obs = rowToObservation(row);
          await (adapter as AdapterHooks).onUploadFailure?.(obs, err);
        }
      }
    }
    return count;
  }
}

export class DaemonAssetUploadClient implements CloudUploadClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DaemonAssetUploadClientOptions) {
    this.baseUrl = opts.cloudApiBase.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async uploadAsset(req: CloudUploadRequest): Promise<CloudUploadResponse> {
    const contentSha256 = sha256Hex(req.bytes);
    const direct = await this.tryDirectUpload(req, contentSha256);
    if (direct) return direct;
    return this.uploadMultipart(req, contentSha256);
  }

  private async tryDirectUpload(req: CloudUploadRequest, contentSha256: string): Promise<CloudUploadResponse | null> {
    try {
      const init = await this.requestJson<DirectUploadInitResponse>('/api/im/assets/direct-upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: req.workspaceId,
          filename: req.filename,
          mime: mimeForRequest(req),
          sizeBytes: req.size,
          contentHash: contentSha256,
        }),
      });
      if (!isDirectUploadPlan(init)) return null;

      const completedParts = await this.putSignedObject(init, req.bytes);
      const completed = await this.requestRaw('/api/im/assets/direct-upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: req.workspaceId,
          filename: req.filename,
          mime: mimeForRequest(req),
          sizeBytes: req.size,
          contentHash: contentSha256,
          kind: req.kind ?? 'file',
          metadata: req.metadata,
          folderPath: req.folderPath,
          description: req.description ?? stringMetadata(req.metadata, 'description'),
          sourceTaskId: req.sourceTaskId ?? stringMetadata(req.metadata, 'taskId') ?? stringMetadata(req.metadata, 'sourceTaskId'),
          sourceAgentImUserId: req.sourceAgentImUserId ?? stringMetadata(req.metadata, 'sourceAgentImUserId'),
          sourceRef: stringMetadata(req.metadata, 'sourceRef'),
          sourceKind: stringMetadata(req.metadata, 'sourceKind'),
          bucket: init.bucket,
          key: init.key,
          ...(init.mode === 'multipart' ? { uploadId: init.uploadId, parts: completedParts ?? [] } : {}),
        }),
      });
      return cloudUploadResponseFromBody(completed);
    } catch {
      return null;
    }
  }

  private async putSignedObject(
    plan: DirectUploadPlan,
    bytes: Buffer,
  ): Promise<Array<{ partNumber: number; etag: string }> | null> {
    if (plan.mode === 'single') {
      const res = await this.fetchImpl(plan.uploadUrl, {
        method: plan.method ?? 'PUT',
        headers: plan.headers,
        body: new Uint8Array(bytes),
      });
      if (!res.ok) throw new Error(`signed PUT failed (${res.status})`);
      return null;
    }

    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    for (const part of plan.parts) {
      const start = (part.partNumber - 1) * plan.partSizeBytes;
      const end = Math.min(start + plan.partSizeBytes, bytes.length);
      const res = await this.fetchImpl(part.url, {
        method: 'PUT',
        body: new Uint8Array(bytes.subarray(start, end)),
      });
      if (!res.ok) throw new Error(`signed multipart PUT failed for part ${part.partNumber} (${res.status})`);
      const etag = res.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!etag) throw new Error(`signed multipart PUT missing ETag for part ${part.partNumber}`);
      completedParts.push({ partNumber: part.partNumber, etag });
    }
    return completedParts;
  }

  private async uploadMultipart(req: CloudUploadRequest, contentSha256: string): Promise<CloudUploadResponse> {
    const form = new FormData();
    form.set('workspaceId', req.workspaceId);
    form.set('kind', req.kind ?? 'file');
    form.set('metadata', JSON.stringify(req.metadata));
    form.set('contentSha256', contentSha256);
    if (req.folderPath !== undefined) form.set('folderPath', req.folderPath);
    const description = req.description ?? stringMetadata(req.metadata, 'description');
    if (description !== undefined) form.set('description', description);
    const sourceTaskId = req.sourceTaskId ?? stringMetadata(req.metadata, 'taskId') ?? stringMetadata(req.metadata, 'sourceTaskId');
    if (sourceTaskId !== undefined) form.set('sourceTaskId', sourceTaskId);
    const sourceAgentImUserId = req.sourceAgentImUserId ?? stringMetadata(req.metadata, 'sourceAgentImUserId');
    if (sourceAgentImUserId !== undefined) form.set('sourceAgentImUserId', sourceAgentImUserId);
    form.set('file', new Blob([new Uint8Array(req.bytes)], { type: mimeForRequest(req) }), req.filename);

    const body = await this.requestRaw('/api/im/assets', {
      method: 'POST',
      headers: { 'X-Content-Sha256': contentSha256 },
      body: form,
    });
    return cloudUploadResponseFromBody(body);
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const body = await this.requestRaw(path, init);
    return unwrapCloudData(body) as T;
  }

  private async requestRaw(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...init.headers },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new Error(`asset upload timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok || isCloudErrorEnvelope(body)) {
      throw new Error(`asset upload failed (${res.status}): ${cloudUploadErrorMessage(body)}`);
    }
    return body;
  }
}

function rowToObservation(row: OutboxRow): SourceObservation {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    if (parsed && typeof parsed === 'object') detail = parsed as Record<string, unknown>;
  } catch {
    // payloadJson was somehow malformed — leave detail empty; adapter.fetch
    // will likely error out and the row will retry/dead-letter.
  }
  return {
    workspaceId: row.workspaceId,
    detail,
    observedAt: row.observedAt,
  };
}

// Lightweight path basename without importing node:path at module scope —
// kept here so this module stays platform-agnostic if ever bundled for
// edge runtimes. Falls back to '/' separator for `folder://` URIs.
const path = {
  basename(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx === -1 ? p : p.slice(idx + 1);
  },
};

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mimeForRequest(req: CloudUploadRequest): string {
  return req.mime ?? 'application/octet-stream';
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isDirectUploadPlan(value: unknown): value is DirectUploadInitResponse {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  if (plan.mode === 'single') {
    return typeof plan.uploadUrl === 'string' && typeof plan.bucket === 'string' && typeof plan.key === 'string';
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

function cloudUploadResponseFromBody(raw: unknown): CloudUploadResponse {
  const data = unwrapCloudData(raw);
  const assetId = stringValue(data, 'id');
  const contentHash = stringValue(data, 'contentHash');
  if (!assetId || !contentHash) {
    throw new Error('asset upload response missing id/contentHash');
  }
  return { assetId, contentHash };
}

function isCloudErrorEnvelope(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && 'ok' in raw && (raw as { ok?: unknown }).ok === false);
}

function cloudUploadErrorMessage(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const error = (raw as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return typeof raw === 'string' ? raw : 'request failed';
}

function unwrapCloudData(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const data = (raw as { data?: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  }
  return {};
}

function stringValue(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
