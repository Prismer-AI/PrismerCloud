import type { FetchResult } from './im-api';
import { getWorkspaceToken } from './im-api';
import type { AssetDTO } from './types';

type AssetUploadFetch = <T = unknown>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
) => Promise<FetchResult<T>>;

export interface UploadAssetInput {
  file: File;
  workspaceId: string;
  metadata: Record<string, unknown>;
  sourceTaskId?: string | null;
  imFetch: AssetUploadFetch;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: AssetUploadProgress) => void;
}

export interface AssetUploadProgress {
  phase: 'hashing' | 'requesting-upload' | 'uploading' | 'completing' | 'fallback' | 'done';
  loadedBytes: number;
  totalBytes: number;
  percent: number | null;
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

const DIRECT_UPLOAD_FALLBACK_STATUSES = new Set([404, 501, 503]);

function reportUploadProgress(input: UploadAssetInput, progress: AssetUploadProgress): void {
  input.onProgress?.(progress);
}

function uploadProgressSnapshot(
  phase: AssetUploadProgress['phase'],
  loadedBytes: number,
  totalBytes: number,
): AssetUploadProgress {
  return {
    phase,
    loadedBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : null,
  };
}

export async function sha256FileHex(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isRetryableAssetUploadError(error: string): boolean {
  return error === 'upload_hash_mismatch' || error === 'NETWORK_ERROR';
}

function assetKindForFile(file: File): string {
  return file.type.startsWith('image/') ? 'image' : 'file';
}

function mimeForFile(file: File): string {
  return file.type || 'application/octet-stream';
}

function buildMultipartForm(input: {
  file: File;
  workspaceId: string;
  metadata: Record<string, unknown>;
  contentSha256: string;
  sourceTaskId?: string | null;
}): FormData {
  const form = new FormData();
  form.set('workspaceId', input.workspaceId);
  form.set('file', input.file);
  form.set('kind', assetKindForFile(input.file));
  form.set('contentSha256', input.contentSha256);
  if (input.sourceTaskId) form.set('sourceTaskId', input.sourceTaskId);
  form.set('metadata', JSON.stringify(input.metadata));
  return form;
}

async function uploadAssetMultipart(
  input: UploadAssetInput & { contentSha256: string },
): Promise<FetchResult<AssetDTO>> {
  let res = await uploadAssetMultipartOnce(input);
  for (let retry = 0; !res.ok && retry < 2 && isRetryableAssetUploadError(res.error); retry += 1) {
    res = await uploadAssetMultipartOnce(input);
  }
  return res;
}

async function uploadAssetMultipartOnce(
  input: UploadAssetInput & { contentSha256: string },
): Promise<FetchResult<AssetDTO>> {
  if (typeof XMLHttpRequest !== 'undefined' && !input.fetchImpl) {
    return postAssetMultipartWithProgress(input);
  }
  return input.imFetch<AssetDTO>('/assets', {
    method: 'POST',
    body: buildMultipartForm(input),
    headers: { 'X-Content-Sha256': input.contentSha256 },
  });
}

function postAssetMultipartWithProgress(
  input: UploadAssetInput & { contentSha256: string },
): Promise<FetchResult<AssetDTO>> {
  const token = getWorkspaceToken();
  if (!token) {
    return Promise.resolve({ ok: false, status: 401, error: 'AUTH_MISSING', message: 'No auth token' });
  }

  const body = buildMultipartForm(input);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/im/assets');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('X-Content-Sha256', input.contentSha256);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const loadedBytes = Math.min(input.file.size, Math.round((event.loaded / event.total) * input.file.size));
      reportUploadProgress(input, uploadProgressSnapshot('uploading', loadedBytes, input.file.size));
    };
    xhr.onload = () => {
      reportUploadProgress(input, uploadProgressSnapshot('uploading', input.file.size, input.file.size));
      let parsed: {
        ok?: boolean;
        data?: unknown;
        error?: string | { code?: string; message?: string };
        message?: string;
      } | null = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        parsed = null;
      }
      if (xhr.status < 200 || xhr.status >= 300 || parsed?.ok === false) {
        const errField = parsed?.error;
        const code = typeof errField === 'string' ? errField : (errField?.code ?? `HTTP_${xhr.status}`);
        const message =
          typeof errField === 'string'
            ? errField
            : (errField?.message ?? parsed?.message ?? `Request failed (HTTP ${xhr.status})`);
        resolve({ ok: false, status: xhr.status, error: code, message, raw: parsed });
        return;
      }
      resolve({ ok: true, data: (parsed?.data ?? undefined) as AssetDTO });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: 'NETWORK_ERROR', message: 'Network request failed' });
    xhr.onabort = () => resolve({ ok: false, status: 0, error: 'NETWORK_ERROR', message: 'Upload aborted' });
    xhr.send(body);
  });
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

async function putSignedObject(
  plan: DirectUploadPlan,
  file: File,
  fetchImpl: typeof fetch,
  onProgress?: (loadedBytes: number) => void,
): Promise<Array<{ partNumber: number; etag: string }> | null> {
  if (plan.mode === 'single') {
    const res = await putWithProgress(plan.uploadUrl, {
      method: plan.method ?? 'PUT',
      headers: plan.headers,
      body: file,
      fetchImpl,
      onProgress,
    });
    if (!res.ok) throw new Error(`signed PUT failed (HTTP ${res.status})`);
    return null;
  }

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let committedBytes = 0;
  for (const part of plan.parts) {
    const start = (part.partNumber - 1) * plan.partSizeBytes;
    const end = Math.min(start + plan.partSizeBytes, file.size);
    const res = await putWithProgress(part.url, {
      method: 'PUT',
      body: file.slice(start, end),
      fetchImpl,
      onProgress: (partLoadedBytes) => onProgress?.(committedBytes + partLoadedBytes),
    });
    if (!res.ok) throw new Error(`signed multipart PUT failed for part ${part.partNumber} (HTTP ${res.status})`);
    const etag = res.headers.get('etag')?.replace(/^"|"$/g, '');
    if (!etag) throw new Error(`signed multipart PUT missing ETag for part ${part.partNumber}`);
    completedParts.push({ partNumber: part.partNumber, etag });
    committedBytes += end - start;
    onProgress?.(committedBytes);
  }
  return completedParts;
}

function putWithProgress(
  input: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body: Blob;
    fetchImpl: typeof fetch;
    onProgress?: (loadedBytes: number) => void;
  },
): Promise<Response> {
  if (init.fetchImpl !== fetch || typeof XMLHttpRequest === 'undefined') {
    return init.fetchImpl(input, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method, input);
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        init.onProgress?.(event.loaded);
      }
    };
    xhr.onload = () => {
      init.onProgress?.(init.body.size);
      resolve(
        new Response(null, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseXhrHeaders(xhr.getAllResponseHeaders()),
        }),
      );
    };
    xhr.onerror = () => reject(new Error('signed PUT network error'));
    xhr.onabort = () => reject(new Error('signed PUT aborted'));
    xhr.send(init.body);
  });
}

function parseXhrHeaders(raw: string): Headers {
  const headers = new Headers();
  raw
    .trim()
    .split(/[\r\n]+/)
    .filter(Boolean)
    .forEach((line) => {
      const index = line.indexOf(':');
      if (index <= 0) return;
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    });
  return headers;
}

async function tryDirectUpload(
  input: UploadAssetInput & { contentSha256: string },
): Promise<FetchResult<AssetDTO> | null> {
  const initRes = await input.imFetch<DirectUploadInitResponse>('/assets/direct-upload/init', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: input.workspaceId,
      filename: input.file.name,
      mime: mimeForFile(input.file),
      sizeBytes: input.file.size,
      contentHash: input.contentSha256,
    }),
  });
  if (!initRes.ok) {
    if (DIRECT_UPLOAD_FALLBACK_STATUSES.has(initRes.status)) return null;
    return null;
  }
  if (!isDirectUploadPlan(initRes.data)) return null;

  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    reportUploadProgress(input, uploadProgressSnapshot('uploading', 0, input.file.size));
    const completedParts = await putSignedObject(initRes.data, input.file, fetchImpl, (loadedBytes) => {
      reportUploadProgress(input, uploadProgressSnapshot('uploading', loadedBytes, input.file.size));
    });
    reportUploadProgress(input, uploadProgressSnapshot('completing', input.file.size, input.file.size));
    const completeRes = await input.imFetch<AssetDTO>('/assets/direct-upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        filename: input.file.name,
        mime: mimeForFile(input.file),
        sizeBytes: input.file.size,
        contentHash: input.contentSha256,
        kind: assetKindForFile(input.file),
        metadata: input.metadata,
        sourceTaskId: input.sourceTaskId || undefined,
        bucket: initRes.data.bucket,
        key: initRes.data.key,
        ...(initRes.data.mode === 'multipart' ? { uploadId: initRes.data.uploadId, parts: completedParts ?? [] } : {}),
      }),
    });
    return completeRes.ok ? completeRes : null;
  } catch {
    return null;
  }
}

export async function uploadAssetWithDirectFallback(input: UploadAssetInput): Promise<FetchResult<AssetDTO>> {
  reportUploadProgress(input, uploadProgressSnapshot('hashing', 0, input.file.size));
  const contentSha256 = await sha256FileHex(input.file);
  reportUploadProgress(input, uploadProgressSnapshot('requesting-upload', 0, input.file.size));
  const directRes = await tryDirectUpload({ ...input, contentSha256 });
  if (directRes?.ok) {
    reportUploadProgress(input, uploadProgressSnapshot('done', input.file.size, input.file.size));
    return directRes;
  }
  reportUploadProgress(input, uploadProgressSnapshot('fallback', 0, input.file.size));
  const multipartRes = await uploadAssetMultipart({ ...input, contentSha256 });
  if (multipartRes.ok) reportUploadProgress(input, uploadProgressSnapshot('done', input.file.size, input.file.size));
  return multipartRes;
}
