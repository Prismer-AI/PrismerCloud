/**
 * Prismer Runtime — Artifact Uploader (v1.9.x Task 2).
 *
 * After an adapter returns from `task.dispatch` with `artifacts: [{path, …}]`,
 * the daemon calls `ArtifactUploader.upload(taskId, path)` for each artifact.
 *
 * The uploader is intentionally defensive — failures at any step return a
 * structured `{ ok:false, error }` rather than throwing, so they never block
 * the rpc.response back to the cloud. The cloud already sees the artifact
 * paths in the dispatch result; the upload is best-effort enrichment that
 * lets iOS Library show downloadable files instead of agent-local paths.
 *
 * Three-step flow:
 *   1. POST /api/im/artifacts/presign  → { uploadId, url, fields }
 *   2. POST <url> (multipart form)     → S3 (or dev-upload) accepts bytes
 *   3. POST /api/im/artifacts/confirm  → { uploadId, cdnUrl, … }
 *
 * The presign envelope includes both a presigned-POST `url` (S3) AND a set
 * of form fields that must be sent verbatim. We post them as multipart/form-data
 * with `file` last (S3 spec requirement).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cloud-side simple-upload limit (`FileService.presign` enforces 10 MiB). We
 * mirror it client-side so the daemon doesn't buffer hundreds of MB into
 * memory just to be rejected by presign — a 500MB log dump from an adapter
 * would OOM the daemon long before the cloud got a chance to say no.
 */
const MAX_SIMPLE_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ArtifactUploaderOptions {
  /** Cloud API key (sk-prismer-…) for the calling user/agent. */
  apiKey: string;
  /** Cloud API base URL, e.g. "https://prismer.cloud" or "https://cloud.prismer.dev". */
  cloudApiBase: string;
  /** Optional fetch impl override — useful for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface ArtifactUploadOptions {
  /** Override the file name sent in the presign request. Defaults to basename(path). */
  fileName?: string;
  /** Override the MIME type. Defaults to application/octet-stream when unknown. */
  mimeType?: string;
}

export type ArtifactUploadResult =
  | { ok: true; uploadId: string; cdnUrl: string }
  | { ok: false; error: string };

interface PresignResponse {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
  taskId: string;
}

interface ConfirmResponse {
  uploadId: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string | null;
  cost: number;
}

export class ArtifactUploader {
  private readonly apiKey: string;
  private readonly cloudApiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArtifactUploaderOptions) {
    if (!opts.apiKey) throw new Error('ArtifactUploader: apiKey required');
    if (!opts.cloudApiBase) throw new Error('ArtifactUploader: cloudApiBase required');
    this.apiKey = opts.apiKey;
    this.cloudApiBase = opts.cloudApiBase.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ArtifactUploader: fetch is not available — pass fetchImpl');
    }
  }

  /**
   * Upload one artifact for the given task. Returns:
   *   - `{ ok:true, uploadId, cdnUrl }` on success.
   *   - `{ ok:false, error }` on any failure — never throws.
   */
  async upload(
    taskId: string,
    artifactPath: string,
    options: ArtifactUploadOptions = {},
  ): Promise<ArtifactUploadResult> {
    if (!taskId) return { ok: false, error: 'taskId required' };
    if (!artifactPath) return { ok: false, error: 'artifactPath required' };

    // 0. Stat the file (and read into memory — artifacts in v1.9 are <= 10MB
    //    per the simple-upload limit; multipart streaming is Sprint C+).
    //
    //    We stat FIRST and refuse oversized files before the read, so a 500MB
    //    adapter dump can't OOM the daemon. The cloud presign enforces the
    //    same limit, but only after we've buffered the whole file.
    let buffer: Buffer;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(artifactPath);
      if (!stat.isFile()) {
        return { ok: false, error: `artifact is not a file: ${artifactPath}` };
      }
      if (stat.size > MAX_SIMPLE_UPLOAD_BYTES) {
        return { ok: false, error: `artifact_too_large:${stat.size}` };
      }
      // Async read to keep the event loop responsive for other tasks the
      // daemon is concurrently dispatching.
      buffer = await fs.promises.readFile(artifactPath);
    } catch (err) {
      return { ok: false, error: `read_failed: ${(err as Error).message}` };
    }

    const fileName = options.fileName ?? path.basename(artifactPath);
    const mimeType = options.mimeType ?? guessMime(fileName);

    // 1. Presign.
    let presigned: PresignResponse;
    try {
      const res = await this.fetchImpl(`${this.cloudApiBase}/api/im/artifacts/presign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          taskId,
          fileName,
          fileSize: stat.size,
          mimeType,
        }),
      });
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: false, error: `presign_${res.status}: ${text}` };
      }
      const body = (await res.json()) as { ok?: boolean; data?: PresignResponse; error?: string };
      if (!body.ok || !body.data) {
        return { ok: false, error: `presign_invalid_response: ${body.error ?? 'no data'}` };
      }
      presigned = body.data;
    } catch (err) {
      return { ok: false, error: `presign_threw: ${(err as Error).message}` };
    }

    // 2. POST the file to the presigned URL. The fields object is sent first
    //    as form fields, then `file` last (S3 presigned-POST requirement).
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(presigned.fields ?? {})) {
        form.append(k, v);
      }
      // Resolve the upload URL: presign returns a relative path in dev mode
      // (e.g. `/api/im/files/dev-upload/<id>`). Make it absolute against
      // cloudApiBase so the same flow works for dev + S3.
      const uploadUrl = presigned.url.startsWith('http')
        ? presigned.url
        : `${this.cloudApiBase}${presigned.url}`;

      // `Buffer` is BodyInit-compatible via Blob (works on Node 20+).
      const blob = new Blob([buffer], { type: mimeType });
      form.append('file', blob, fileName);

      // Dev-upload route requires an Authorization header. S3 presigned POST
      // does NOT — including it is harmless because S3 ignores unknown
      // headers, but we omit the auth header for non-relative URLs to avoid
      // accidental signature interference.
      const headers: Record<string, string> = {};
      if (!presigned.url.startsWith('http')) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await this.fetchImpl(uploadUrl, {
        method: 'POST',
        headers,
        body: form,
      });
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: false, error: `upload_${res.status}: ${text}` };
      }
    } catch (err) {
      return { ok: false, error: `upload_threw: ${(err as Error).message}` };
    }

    // 3. Confirm.
    try {
      const res = await this.fetchImpl(`${this.cloudApiBase}/api/im/artifacts/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ uploadId: presigned.uploadId }),
      });
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: false, error: `confirm_${res.status}: ${text}` };
      }
      const body = (await res.json()) as { ok?: boolean; data?: ConfirmResponse; error?: string };
      if (!body.ok || !body.data) {
        return { ok: false, error: `confirm_invalid_response: ${body.error ?? 'no data'}` };
      }
      return { ok: true, uploadId: body.data.uploadId, cdnUrl: body.data.cdnUrl };
    } catch (err) {
      return { ok: false, error: `confirm_threw: ${(err as Error).message}` };
    }
  }
}

// ─── Helpers ────────────────────────────────────────────

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/** Minimal MIME guess — covers the common artifact extensions. */
function guessMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    case '.md':
      return 'text/markdown';
    case '.zip':
      return 'application/zip';
    case '.html':
      return 'text/html';
    case '.csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}
