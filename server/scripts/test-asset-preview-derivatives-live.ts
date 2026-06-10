#!/usr/bin/env tsx
/**
 * Release200/07 live preview-derivative gate.
 *
 * Requires an already-running app (default http://127.0.0.1:3000). The script
 * verifies the closeable local subset:
 *
 *   - direct-upload init behavior is explicit (available in S3 mode or 503
 *     fallback in local filesystem mode)
 *   - raster image upload produces a private WebP thumbnail derivative
 *   - PDF upload either produces a first-page thumbnail when local renderer
 *     tools exist, or fails open with a PDF preview contract
 *   - HLS helper can execute ffmpeg locally when ffmpeg is installed
 *
 * Required env:
 *   PRISMER_ASSET_PREVIEW_TOKEN or PRISMER_JWT
 *   PRISMER_WORKSPACE_ID
 *
 * Optional env:
 *   PRISMER_BASE_URL (default http://127.0.0.1:3000)
 *   PRISMER_ASSET_PREVIEW_HLS=0 to skip the ffmpeg helper gate
 */

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as process from 'node:process';
import { promisify } from 'node:util';
import { createHlsDerivativeForPreview } from '../src/im/services/asset-preview-derivatives.service';

const execFile = promisify(execFileCallback);

interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: string | { code?: string; message?: string };
  message?: string;
  meta?: unknown;
}

interface AssetDTO {
  id: string;
  contentHash: string;
  mime: string | null;
  sizeBytes: number | null;
  filename?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: { small?: string; medium?: string; large?: string } | null;
  previewAssetId?: string | null;
  preview?: {
    kind?: string;
    status?: string;
    derivatives?: Array<{ type?: string; url?: string; endpoint?: string; assetId?: string }>;
  };
  derivedAssets?: Array<{ id: string; derivationKind?: string | null; mime?: string | null }>;
}

interface UploadResult {
  asset: AssetDTO;
  detail: AssetDTO;
}

const baseUrl = (process.env.PRISMER_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = process.env.PRISMER_ASSET_PREVIEW_TOKEN ?? process.env.PRISMER_JWT ?? '';
const workspaceId = process.env.PRISMER_WORKSPACE_ID ?? '';
const runHls = process.env.PRISMER_ASSET_PREVIEW_HLS !== '0';

function required(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function api<T>(
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<{ status: number; envelope: ApiEnvelope<T> | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const envelope = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  return { status: res.status, envelope };
}

async function apiData<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const { status, envelope } = await api<T>(pathOrUrl, init);
  if (status < 200 || status >= 300 || envelope?.ok === false) {
    const err = envelope?.error;
    const code = typeof err === 'string' ? err : err?.code;
    const message = typeof err === 'string' ? err : (err?.message ?? envelope?.message ?? `HTTP ${status}`);
    throw new Error(`${code ?? 'request_failed'}: ${message}`);
  }
  return envelope?.data as T;
}

async function checkTool(name: string, args: string[]): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await execFile(name, args, { timeout: 5000, maxBuffer: 256 * 1024 });
    const version = String(result.stdout || result.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    return { available: true, version: version ?? null };
  } catch {
    return { available: false, version: null };
  }
}

async function uploadAsset(input: {
  bytes: Buffer;
  filename: string;
  mime: string;
  kind?: string;
}): Promise<UploadResult> {
  const digest = sha256(input.bytes);
  const form = new FormData();
  form.set('workspaceId', workspaceId);
  form.set('kind', input.kind ?? (input.mime.startsWith('image/') ? 'image' : 'file'));
  form.set('contentSha256', digest);
  form.set('metadata', JSON.stringify({ title: input.filename, smoke: 'release200-asset-preview-derivatives-live' }));
  const blobBytes = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength);
  form.set('file', new Blob([blobBytes], { type: input.mime }), input.filename);
  const asset = await apiData<AssetDTO>('/api/im/assets', {
    method: 'POST',
    headers: { 'X-Content-Sha256': digest },
    body: form,
  });
  if (asset.contentHash !== digest) {
    throw new Error(
      `uploaded contentHash mismatch for ${input.filename}: expected ${digest}, got ${asset.contentHash}`,
    );
  }
  const detail = await apiData<AssetDTO>(`/api/im/assets/${encodeURIComponent(asset.id)}/detail`);
  return { asset, detail };
}

async function testDirectUploadInit(): Promise<Record<string, unknown>> {
  const bytes = Buffer.from('release200 direct upload init probe\n', 'utf8');
  const contentHash = sha256(bytes);
  const { status, envelope } = await api('/api/im/assets/direct-upload/init', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      filename: `direct-upload-probe-${Date.now()}.txt`,
      mime: 'text/plain',
      sizeBytes: bytes.length,
      contentHash,
    }),
  });
  const code = typeof envelope?.error === 'object' ? envelope.error.code : envelope?.error;
  if (status === 503 && code === 'asset_direct_upload_unavailable') {
    return { status: 'fallback-expected', httpStatus: status, code };
  }
  if (status >= 200 && status < 300 && envelope?.ok !== false) {
    return { status: 'available', mode: (envelope?.data as { mode?: unknown } | undefined)?.mode ?? null };
  }
  throw new Error(`direct-upload init returned unexpected status=${status} body=${JSON.stringify(envelope)}`);
}

function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMAABBgAFe8CAVlQh1wAAAAASUVORK5CYII=',
    'base64',
  );
}

function pdfFixture(): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      '4 0 obj << /Length 44 >> stream',
      'BT /F1 18 Tf 30 120 Td (Release200 PDF) Tj ET',
      'endstream endobj',
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      '0000000241 00000 n ',
      '0000000334 00000 n ',
      'trailer << /Root 1 0 R /Size 6 >>',
      'startxref',
      '404',
      '%%EOF',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function fetchThumbnail(url: string): Promise<{ contentType: string | null; bytes: number }> {
  const res = await fetch(url.startsWith('http') ? url : `${baseUrl}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`thumbnail fetch failed ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { contentType: res.headers.get('content-type'), bytes: bytes.length };
}

async function testImageThumbnail(): Promise<Record<string, unknown>> {
  const { asset, detail } = await uploadAsset({
    bytes: pngFixture(),
    filename: `release200-preview-image-${Date.now()}.png`,
    mime: 'image/png',
    kind: 'image',
  });
  const thumbnailUrl = detail.thumbnailUrl ?? detail.previewUrls?.medium ?? null;
  if (!thumbnailUrl) throw new Error(`image asset ${asset.id} did not receive thumbnailUrl/previewUrls.medium`);
  const thumbnail = await fetchThumbnail(thumbnailUrl);
  if (thumbnail.contentType !== 'image/webp') {
    throw new Error(`image thumbnail content-type expected image/webp, got ${thumbnail.contentType}`);
  }
  return {
    status: 'ok',
    assetId: asset.id,
    thumbnailUrl,
    previewMedium: detail.previewUrls?.medium ?? null,
    thumbnailContentType: thumbnail.contentType,
    thumbnailBytes: thumbnail.bytes,
  };
}

async function testPdfThumbnailOrFailOpen(
  toolchain: Record<string, { available: boolean }>,
): Promise<Record<string, unknown>> {
  const { asset, detail } = await uploadAsset({
    bytes: pdfFixture(),
    filename: `release200-preview-pdf-${Date.now()}.pdf`,
    mime: 'application/pdf',
  });
  const thumbnailUrl = detail.thumbnailUrl ?? detail.previewUrls?.medium ?? null;
  if (thumbnailUrl) {
    const thumbnail = await fetchThumbnail(thumbnailUrl);
    if (thumbnail.contentType !== 'image/webp') {
      throw new Error(`pdf thumbnail content-type expected image/webp, got ${thumbnail.contentType}`);
    }
    return {
      status: 'thumbnail-ok',
      assetId: asset.id,
      thumbnailUrl,
      thumbnailContentType: thumbnail.contentType,
      thumbnailBytes: thumbnail.bytes,
    };
  }
  const rendererAvailable = toolchain.pdftoppm?.available || toolchain.mutool?.available;
  if (rendererAvailable) {
    throw new Error(`pdf asset ${asset.id} did not receive thumbnail despite local PDF renderer being available`);
  }
  if (detail.preview?.kind !== 'pdf' || detail.preview?.status !== 'ready') {
    throw new Error(`pdf asset ${asset.id} did not fail open to ready pdf preview contract`);
  }
  return {
    status: 'fail-open',
    assetId: asset.id,
    thumbnailUrl: null,
    previewKind: detail.preview.kind,
    previewStatus: detail.preview.status,
    reason: 'pdftoppm/mutool unavailable',
  };
}

async function makeTinyMp4(): Promise<Buffer> {
  const outputPath = `/tmp/prismer-preview-hls-${process.pid}-${Date.now()}.mp4`;
  await execFile(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x90:rate=10:duration=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      outputPath,
    ],
    { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

async function testHlsHelper(toolchain: Record<string, { available: boolean }>): Promise<Record<string, unknown>> {
  if (!runHls) return { status: 'skipped', reason: 'PRISMER_ASSET_PREVIEW_HLS=0' };
  if (!toolchain.ffmpeg?.available) return { status: 'skipped', reason: 'ffmpeg unavailable' };
  const bytes = await makeTinyMp4();
  const contentHash = sha256(bytes);
  const result = await createHlsDerivativeForPreview({
    buffer: bytes,
    contentHash,
    mime: 'video/mp4',
    filename: 'release200-preview-hls.mp4',
    sizeBytes: bytes.length,
    minSizeBytes: 1,
    keyPrefix: 'asset-previews',
    timeoutMs: 60_000,
  });
  if (result.status !== 'success' || !result.manifest || !result.files) {
    throw new Error(`HLS helper did not produce manifest: ${JSON.stringify(result)}`);
  }
  return {
    status: 'ok',
    manifestKey: result.manifest.key,
    fileCount: result.files.length,
    tool: result.tool,
    toolVersion: result.toolVersion,
  };
}

async function main(): Promise<void> {
  required('PRISMER_ASSET_PREVIEW_TOKEN or PRISMER_JWT', token);
  required('PRISMER_WORKSPACE_ID', workspaceId);

  const toolchain = {
    qpdf: await checkTool('qpdf', ['--version']),
    pdftoppm: await checkTool('pdftoppm', ['-v']),
    mutool: await checkTool('mutool', ['-v']),
    ffmpeg: await checkTool('ffmpeg', ['-version']),
  };

  const result = {
    ok: true,
    baseUrl,
    workspaceId,
    toolchain,
    directUploadInit: await testDirectUploadInit(),
    imageThumbnail: await testImageThumbnail(),
    pdf: await testPdfThumbnailOrFailOpen(toolchain),
    hlsHelper: await testHlsHelper(toolchain),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
