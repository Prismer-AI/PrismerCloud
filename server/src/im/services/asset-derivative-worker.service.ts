import * as crypto from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  computeThumbHashForImage,
  createHlsDerivativeForPreview,
  createImageThumbnailForPreview,
  createPdfFirstPageThumbnailForPreview,
  linearizePdfForPreview,
  type HlsDerivativeFile,
} from './asset-preview-derivatives.service';
import { getS3Client, putS3Object, type PutS3ObjectResult } from './s3.client';

type S3LikeClient = {
  send(command: unknown): Promise<unknown>;
};

type PutS3ObjectLike = (input: {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string | null;
  contentHashSha256Hex?: string | null;
  client?: S3LikeClient;
}) => Promise<PutS3ObjectResult>;

export interface AssetDerivativeWorkerAsset {
  id: string;
  workspaceId: string;
  contentHash: string;
  storageUri: string;
  mime: string | null;
  sizeBytes: number;
  filename?: string | null;
}

export interface AssetDerivativeCallbackPayload {
  assetId: string;
  workspaceId: string;
  derivationKind: 'thumbnail' | 'pdf-linearized' | 'hls-manifest';
  contentHash: string;
  storageUri: string;
  sizeBytes: number;
  mime: string;
  filename: string;
  metadata: Record<string, unknown>;
  cdnUrl?: string | null;
  endpoint?: string;
  previewSize?: 'small' | 'medium' | 'large';
  // release202/13 §3b① — base64 thumbHash of the ORIGINAL image, computed once
  // alongside the image thumbnail. Best-effort: absent when not an image or on
  // encode failure. The callback writes it onto the parent asset row.
  blurHash?: string | null;
}

export interface AssetDerivativeWorkerOptions {
  apiBaseUrl: string;
  callbackSecret: string;
  s3Client?: S3LikeClient;
  putObject?: PutS3ObjectLike;
  fetchImpl?: typeof fetch;
  hlsMinSizeBytes?: number;
  createImageThumbnail?: typeof createImageThumbnailForPreview;
  createPdfFirstPageThumbnail?: typeof createPdfFirstPageThumbnailForPreview;
  linearizePdf?: typeof linearizePdfForPreview;
  createHlsDerivative?: typeof createHlsDerivativeForPreview;
}

export interface ProcessAssetDerivativeResult {
  callbacks: AssetDerivativeCallbackPayload[];
  skipped: Array<{ kind: string; reason: string }>;
  errors: Array<{ kind: string; error: string }>;
}

export interface S3ObjectCreatedEvent {
  Records?: Array<{
    s3?: {
      bucket?: { name?: string };
      object?: { key?: string; size?: number };
    };
  }>;
}

export async function processAssetDerivatives(
  asset: AssetDerivativeWorkerAsset,
  options: AssetDerivativeWorkerOptions,
): Promise<ProcessAssetDerivativeResult> {
  const s3 = options.s3Client ?? getS3Client();
  const putObject = options.putObject ?? putS3Object;
  const bytes = await readAssetBytesFromStorageUri(asset.storageUri, s3);
  const callbacks: AssetDerivativeCallbackPayload[] = [];
  const skipped: ProcessAssetDerivativeResult['skipped'] = [];
  const errors: ProcessAssetDerivativeResult['errors'] = [];

  const image = await (options.createImageThumbnail ?? createImageThumbnailForPreview)({
    buffer: bytes,
    mime: asset.mime,
    filename: asset.filename,
  });
  if (image.status === 'success' && image.buffer && image.contentHash && image.mime) {
    const key = derivativeKey('asset-previews/thumb', image.contentHash, thumbnailExtension(image.mime));
    await putObject({
      bucket: bucketFromStorageUri(asset.storageUri),
      key,
      body: image.buffer,
      contentType: image.mime,
      contentHashSha256Hex: image.contentHash,
      client: s3,
    });
    // Best-effort thumbHash from the ORIGINAL image bytes (already in memory).
    // Failure must NOT fail the derivative job — computeThumbHashForImage
    // swallows internally and returns null.
    const blurHash = await computeThumbHashForImage({
      buffer: bytes,
      mime: asset.mime,
      filename: asset.filename,
    });
    callbacks.push({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      derivationKind: 'thumbnail',
      contentHash: image.contentHash,
      storageUri: `s3://${bucketFromStorageUri(asset.storageUri)}/${key}`,
      sizeBytes: image.buffer.length,
      mime: image.mime,
      filename: `${filenameStem(asset.filename, asset.contentHash)}.thumb.webp`,
      previewSize: 'medium',
      ...(blurHash ? { blurHash } : {}),
      metadata: { width: image.width, height: image.height, worker: 'asset-derivative-worker' },
    });
  } else if (image.status === 'skipped') {
    skipped.push({ kind: 'thumbnail', reason: image.reason ?? 'skipped' });
  } else {
    errors.push({ kind: 'thumbnail', error: image.error ?? image.reason ?? 'failed' });
  }

  const pdfThumbnail = await (options.createPdfFirstPageThumbnail ?? createPdfFirstPageThumbnailForPreview)({
    buffer: bytes,
    mime: asset.mime,
    filename: asset.filename,
  });
  if (pdfThumbnail.status === 'success' && pdfThumbnail.buffer && pdfThumbnail.contentHash && pdfThumbnail.mime) {
    const key = derivativeKey('asset-previews/pdf-thumb', pdfThumbnail.contentHash, '.webp');
    await putObject({
      bucket: bucketFromStorageUri(asset.storageUri),
      key,
      body: pdfThumbnail.buffer,
      contentType: pdfThumbnail.mime,
      contentHashSha256Hex: pdfThumbnail.contentHash,
      client: s3,
    });
    callbacks.push({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      derivationKind: 'thumbnail',
      contentHash: pdfThumbnail.contentHash,
      storageUri: `s3://${bucketFromStorageUri(asset.storageUri)}/${key}`,
      sizeBytes: pdfThumbnail.buffer.length,
      mime: pdfThumbnail.mime,
      filename: `${filenameStem(asset.filename, asset.contentHash)}.page1.webp`,
      previewSize: 'medium',
      metadata: {
        type: 'pdf-first-page-thumbnail',
        page: pdfThumbnail.page ?? 1,
        width: pdfThumbnail.width,
        height: pdfThumbnail.height,
        tool: pdfThumbnail.tool,
        toolVersion: pdfThumbnail.toolVersion,
        worker: 'asset-derivative-worker',
      },
    });
  } else if (pdfThumbnail.status === 'skipped') {
    skipped.push({ kind: 'pdf-thumbnail', reason: pdfThumbnail.reason ?? 'skipped' });
  } else {
    errors.push({ kind: 'pdf-thumbnail', error: pdfThumbnail.error ?? pdfThumbnail.reason ?? 'failed' });
  }

  const linearized = await (options.linearizePdf ?? linearizePdfForPreview)({
    buffer: bytes,
    mime: asset.mime,
    filename: asset.filename,
  });
  if (linearized.status === 'success' && linearized.buffer && linearized.contentHash) {
    const key = derivativeKey('asset-previews/pdf-linearized', linearized.contentHash, '.pdf');
    await putObject({
      bucket: bucketFromStorageUri(asset.storageUri),
      key,
      body: linearized.buffer,
      contentType: 'application/pdf',
      contentHashSha256Hex: linearized.contentHash,
      client: s3,
    });
    callbacks.push({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      derivationKind: 'pdf-linearized',
      contentHash: linearized.contentHash,
      storageUri: `s3://${bucketFromStorageUri(asset.storageUri)}/${key}`,
      sizeBytes: linearized.buffer.length,
      mime: 'application/pdf',
      filename: `${filenameStem(asset.filename, asset.contentHash)}.linearized.pdf`,
      metadata: {
        tool: linearized.tool,
        toolVersion: linearized.toolVersion,
        worker: 'asset-derivative-worker',
      },
    });
  } else if (linearized.status === 'skipped') {
    skipped.push({ kind: 'pdf-linearized', reason: linearized.reason ?? 'skipped' });
  } else {
    errors.push({ kind: 'pdf-linearized', error: linearized.error ?? linearized.reason ?? 'failed' });
  }

  const hls = await (options.createHlsDerivative ?? createHlsDerivativeForPreview)({
    buffer: bytes,
    contentHash: asset.contentHash,
    mime: asset.mime,
    filename: asset.filename,
    sizeBytes: asset.sizeBytes,
    minSizeBytes: options.hlsMinSizeBytes,
    keyPrefix: 'asset-previews',
  });
  if (hls.status === 'success' && hls.manifest && hls.files && hls.metadata) {
    for (const file of hls.files) {
      await putHlsDerivativeFile({
        file,
        bucket: bucketFromStorageUri(asset.storageUri),
        putObject,
        s3,
      });
    }
    callbacks.push({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      derivationKind: 'hls-manifest',
      contentHash: hls.manifest.contentHash,
      storageUri: `s3://${bucketFromStorageUri(asset.storageUri)}/${hls.manifest.key}`,
      sizeBytes: hls.manifest.buffer.length,
      mime: hls.manifest.mime,
      filename: 'master.m3u8',
      metadata: hls.metadata,
    });
  } else if (hls.status === 'skipped') {
    skipped.push({ kind: 'hls-manifest', reason: hls.reason ?? 'skipped' });
  } else {
    errors.push({ kind: 'hls-manifest', error: hls.error ?? hls.reason ?? 'failed' });
  }

  for (const callback of callbacks) {
    await postDerivativeCallback(callback, options);
  }

  return { callbacks, skipped, errors };
}

export function assetsFromS3ObjectCreatedEvent(
  event: S3ObjectCreatedEvent,
  lookup: (record: { bucket: string; key: string; sizeBytes: number | null }) => AssetDerivativeWorkerAsset | null,
): AssetDerivativeWorkerAsset[] {
  const out: AssetDerivativeWorkerAsset[] = [];
  for (const record of s3ObjectRecordsFromCreatedEvent(event)) {
    const asset = lookup({ bucket: record.bucket, key: record.key, sizeBytes: record.sizeBytes });
    if (asset) out.push(asset);
  }
  return out;
}

export function s3ObjectRecordsFromCreatedEvent(
  event: S3ObjectCreatedEvent,
): Array<{ bucket: string; key: string; sizeBytes: number | null; storageUri: string }> {
  const out: Array<{ bucket: string; key: string; sizeBytes: number | null; storageUri: string }> = [];
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const encodedKey = record.s3?.object?.key;
    if (!bucket || !encodedKey) continue;
    const key = decodeS3EventKey(encodedKey);
    out.push({ bucket, key, sizeBytes: record.s3?.object?.size ?? null, storageUri: `s3://${bucket}/${key}` });
  }
  return out;
}

async function readAssetBytesFromStorageUri(storageUri: string, s3: S3LikeClient): Promise<Buffer> {
  const parsed = parseS3Uri(storageUri);
  const result = (await s3.send(new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }))) as {
    Body?: { transformToByteArray?: () => Promise<Uint8Array> };
  };
  if (!result.Body?.transformToByteArray) throw new Error('S3 GetObject did not return a byte body');
  return Buffer.from(await result.Body.transformToByteArray());
}

async function putHlsDerivativeFile(input: {
  file: HlsDerivativeFile;
  bucket: string;
  putObject: PutS3ObjectLike;
  s3: S3LikeClient;
}): Promise<void> {
  await input.putObject({
    bucket: input.bucket,
    key: input.file.key,
    body: input.file.buffer,
    contentType: input.file.mime,
    contentHashSha256Hex: input.file.contentHash,
    client: input.s3,
  });
}

async function postDerivativeCallback(
  payload: AssetDerivativeCallbackPayload,
  options: AssetDerivativeWorkerOptions,
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(
    `${options.apiBaseUrl.replace(/\/$/, '')}/api/im/assets/internal/derivatives/complete`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-prismer-internal-secret': options.callbackSecret,
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`derivative callback failed (${response.status}): ${await response.text()}`);
  }
}

function parseS3Uri(storageUri: string): { bucket: string; key: string } {
  const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 storageUri: ${storageUri}`);
  return { bucket: match[1]!, key: match[2]! };
}

function bucketFromStorageUri(storageUri: string): string {
  return parseS3Uri(storageUri).bucket;
}

function derivativeKey(prefix: string, contentHash: string, extension: string): string {
  return `${prefix}/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}${extension}`;
}

function filenameStem(filename: string | null | undefined, fallbackHash: string): string {
  const base = filename?.trim() || fallbackHash.slice(0, 16);
  return base.replace(/\.[^.]+$/, '');
}

function thumbnailExtension(mime: string): string {
  return mime === 'image/webp' ? '.webp' : '.bin';
}

function decodeS3EventKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

export function assetDerivativeWorkerCallbackSecret(): string {
  return (
    process.env.ASSET_DERIVATIVE_CALLBACK_SECRET || process.env.INTERNAL_API_SECRET || process.env.WEBHOOK_SECRET || ''
  );
}

export function sha256HexForDerivativeWorker(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
