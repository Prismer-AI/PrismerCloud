/**
 * Prismer IM — Assets API (v1.9.x Track A m1)
 *
 * Asset = content-addressed immutable blob (sha256). Same hash + same workspace
 * is deduplicated to a single row. See docs/refactor/10-asset-network-drive.md.
 *
 * Endpoints:
 *   GET  /assets?workspaceId=...&taskId=...&kind=...&limit=... — list assets in workspace
 *   POST /assets              — multipart upload (form fields: file, workspaceId)
 *   GET  /assets/by-hash/:hash?wsId=...
 *   HEAD /assets/:id          — metadata only (size, mime)
 *   GET  /assets/:id          — download bytes (filesystem stream | S3 302 presigned)
 *
 * Storage backend selected at runtime via process.env.ASSET_STORAGE_BACKEND:
 *   - "filesystem" (default): writes to ASSET_STORAGE_DIR (default OS temp dir),
 *      sharded as <dir>/<hash[0..2]>/<hash[2..4]>/<hash>. storageUri = file://<abs path>.
 *   - "s3": writes to bucket from getBucket(); key assets/<hash[0..2]>/<hash[2..4]>/<hash>.
 *      storageUri = s3://<bucket>/<key>. GET returns 302 to a 5-minute presigned URL.
 *
 * Asset cap: 1 GB per upload. S3 writes above 50 MB use multipart upload.
 */

/**
 * Asset metadata conventions (caller-supplied via the `metadata` form field):
 *
 *   { "kind": "photo-memory-segment",
 *     "segmentId": "<uuid>",
 *     "dateRangeStart": "2026-04-01T00:00:00Z",
 *     "dateRangeEnd": "2026-04-30T23:59:59Z",
 *     "photoCount": 100,
 *     "photoRefs": [{ "localId": "PHAsset-...", "sourceHash": "<sha256>" }],
 *     "bidirectional": true }
 *
 * The `kind` form field (separate from metadata.kind) is the row-level kind.
 * For photo-memory-segment, callers pass kind=photo-memory-segment in both.
 * The detail endpoint reads metadata to surface photoRefs reverse-lookup.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware';
import prisma from '../db';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  isS3Available,
  getS3Client,
  getBucket,
  GetObjectCommand,
  PutObjectCommand,
  getSignedUrl,
  UploadPartCommand,
  S3_MULTIPART_PART_SIZE_BYTES,
  S3_MULTIPART_THRESHOLD_BYTES,
} from '../services/s3.client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { config } from '../config';
import {
  MAX_ASSET_BYTES,
  assetCdnUrlForS3Key,
  assetCdnUrlForStorageUri,
  assetS3KeyForContentHash,
  getBackend,
  writeFilesystem,
  writeS3,
} from '../services/asset-blob-store';
import type { ApiResponse } from '../types/index';
import type { AssetChangedPayload } from '../types/index';
import { ServerEvents } from '../ws/events';
import type { RoomManager } from '../ws/rooms';
import type { SyncService } from '../services/sync.service';
import { renderAssetManifestMarkdown } from './asset-manifest';
import { PHOTO_MEMORY_SEGMENT_KIND, upsertPhotoMemorySegmentMemoryFile } from '../services/asset-memory-bridge.service';
import { MemoryPageService, type MemoryPageSummary } from '../services/memory-page.service';
import { validateAgentOutputAsset } from '../services/agent-output-policy';
import { detectMagicBytes, mimeMismatchReason } from '../services/magic-bytes';
import {
  computeThumbHashForImage,
  createImageThumbnailForPreview,
  createPdfFirstPageThumbnailForPreview,
  isPdfAsset,
  isRasterImageAsset,
  linearizePdfForPreview,
} from '../services/asset-preview-derivatives.service';

// MAX_ASSET_BYTES + storage write primitives now live in
// ../services/asset-blob-store (api → service, the allowed layer direction)
// so the task layer can share them. Re-exported here for existing importers
// (e.g. acp-assets-upload.test.ts) and the s3 key/cdn helpers stay re-exported
// below where their original definitions used to be.
export { MAX_ASSET_BYTES } from '../services/asset-blob-store';
const MAX_ASSET_BYTES_LABEL = '1 GB';
const PRESIGNED_TTL_SECONDS = 300;
const MAX_TEXT_INLINE_PREVIEW_BYTES = 1024 * 1024;
const MAX_TABLE_INLINE_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_INLINE_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_MEMORY_PAGE_EXTRACT_BYTES = MAX_TEXT_INLINE_PREVIEW_BYTES;
const LOCAL_ASSET_ENDPOINT_PREFIX = '/api/im/assets';
const DIRECT_UPLOAD_TTL_SECONDS = 900;
let pdfParseWorkerConfigured = false;

interface AssetDTO {
  id: string;
  workspaceId: string;
  ownerImUserId: string;
  contentHash: string;
  storageUri: string;
  sizeBytes: number | null;
  mime: string | null;
  kind: string;
  sourceAgentImUserId: string | null;
  sourceTaskId: string | null;
  /** release201/09 §9.4a.2 — 'task-bound' | 'workspace-file' | null (legacy). */
  boundKind: string | null;
  metadata: Record<string, unknown>;
  parentAssetId: string | null;
  derivationKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  ingestError: string | null;
  assetIndexSeq: number;
  cdnUrl: string | null;
  thumbnailUrl: string | null;
  previewUrls: AssetPreviewUrls | null;
  /** release202/13 §3b① — base64 thumbHash for an instant blurred placeholder (image rows only). */
  blurHash: string | null;
  previewAssetId: string | null;
  folderPath: string | null;
  filename: string | null;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceMetadata: Record<string, unknown> | null;
  revision: number;
  visibility: string;
  aclJson: Record<string, unknown> | null;
  description: string | null;
  /** release202/13 §L1 — short text excerpt for the card (derived at serialization, not stored). */
  previewText?: string | null;
  updatedAt: string;
  createdAt: string;
  deletedAt: string | null;
  memoryPages?: MemoryPageSummary[];
  derivedAssets?: AssetDTO[];
  parentAsset?: AssetDTO | null;
  previewAsset?: AssetDTO | null;
  preview?: AssetPreviewContract;
}

interface AssetRevisionDTO {
  id: string;
  assetId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
  sizeBytes: number | null;
  mime: string | null;
  kind: string;
  filename: string | null;
  folderPath: string | null;
  sourceRef: string | null;
  sourceKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  deletedAt: string | null;
  createdByImUserId: string | null;
  reason: string | null;
  createdAt: string;
}

interface AssetPreviewUrls {
  small?: string;
  medium?: string;
  large?: string;
}

type AssetPreviewKind =
  | 'image'
  | 'pdf'
  | 'media'
  | 'text'
  | 'html'
  | 'table'
  | 'document'
  | 'code'
  | 'archive'
  | 'download-only';

type AssetPreviewStatus = 'ready' | 'processing' | 'partial' | 'unsupported' | 'too_large' | 'failed';

interface AssetPreviewContract {
  kind: AssetPreviewKind;
  status: AssetPreviewStatus;
  maxInlineBytes: number;
  contentLength?: number;
  byteRangeSupported?: boolean;
  preferredRenderer?:
    | 'native'
    | 'monaco'
    | 'markdown'
    | 'iframe-safe-html'
    | 'table-sample'
    | 'page-viewer'
    | 'video-js';
  inlinePolicy?: 'allow' | 'sample-only' | 'metadata-only' | 'download-only';
  pageCount?: number;
  rowCountApprox?: number;
  sheetCount?: number;
  extractorVersion?: string;
  etag?: string;
  derivatives: Array<{
    type:
      | 'thumbnail'
      | 'text'
      | 'html_safe'
      | 'table_sample'
      | 'schema'
      | 'page_text'
      | 'archive_listing'
      | 'pdf_linearized'
      | 'hls_manifest';
    assetId?: string;
    url?: string;
    endpoint?: string;
    metadata?: Record<string, unknown>;
  }>;
  warnings?: Array<{ code: string; message: string }>;
  securityWarnings?: Array<{ code: string; message: string }>;
}

interface AssetRow {
  id: string;
  workspaceId: string;
  ownerImUserId: string;
  contentHash: string;
  storageUri: string;
  sizeBytes: bigint | null;
  mime: string | null;
  kind: string;
  sourceAgentImUserId: string | null;
  sourceTaskId: string | null;
  /** release201/09 §9.4a.2 — see DTO. */
  boundKind: string | null;
  metadata: string;
  parentAssetId: string | null;
  derivationKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  ingestError: string | null;
  assetIndexSeq: bigint;
  cdnUrl: string | null;
  thumbnailUrl: string | null;
  previewUrls: unknown;
  /** release202/13 §3b① — base64 thumbHash (image rows only). */
  blurHash: string | null;
  previewAssetId: string | null;
  folderPath: string | null;
  filename: string | null;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceMetadata: string | null;
  revision: number;
  visibility: string;
  aclJson: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface AssetRevisionRow {
  id: string;
  assetId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
  storageUri: string;
  sizeBytes: bigint | null;
  mime: string | null;
  kind: string;
  ownerImUserId: string;
  sourceAgentImUserId: string | null;
  sourceTaskId: string | null;
  metadata: string;
  parentAssetId: string | null;
  derivationKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  ingestError: string | null;
  cdnUrl: string | null;
  thumbnailUrl: string | null;
  previewUrls: unknown;
  previewAssetId: string | null;
  folderPath: string | null;
  filename: string | null;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceMetadata: string | null;
  visibility: string;
  aclJson: string | null;
  description: string | null;
  deletedAt: Date | null;
  createdByImUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

type AssetIndexTx = {
  iMAssetIndexCounter: typeof prisma.iMAssetIndexCounter;
};

type AssetWriteTx = AssetIndexTx & {
  iMAsset: typeof prisma.iMAsset;
  iMAssetRevision: typeof prisma.iMAssetRevision;
};

type AssetRevisionSnapshotTx = Pick<AssetWriteTx, 'iMAssetRevision'> & {
  iMAssetRevision: Pick<AssetWriteTx['iMAssetRevision'], 'upsert'>;
};

type MemoryPageSelectedRow = {
  id: string;
  workspaceId: string;
  path: string;
  title: string | null;
  pageType: string;
  sourceRef: string | null;
  sourceKind: string | null;
  sourceAssetId: string | null;
  version: number;
  stale: boolean;
  contentHash: string;
  updatedAt: Date;
};

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readExpectedUploadSha256(
  headerValue: string | undefined,
  formValue: FormDataEntryValue | null,
): string | null {
  const raw = headerValue ?? (typeof formValue === 'string' && formValue.trim().length > 0 ? formValue : null);
  if (!raw) return null;

  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^sha256[:=]/, '');
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('X-Content-Sha256 must be a 64-character hex SHA-256 digest');
  }
  return value;
}

function uploadHashMismatchResponse(expected: string, actual: string, bytes: number) {
  return {
    ok: false,
    error: {
      code: 'upload_hash_mismatch',
      message: 'Uploaded bytes do not match the declared SHA-256 digest. Please retry the upload.',
    },
    meta: { expected, actual, bytes },
  } satisfies ApiResponse;
}

export function assetTooLargeResponse(bytes: number) {
  return {
    ok: false,
    error: `file exceeds ${MAX_ASSET_BYTES} bytes (${MAX_ASSET_BYTES_LABEL} limit)`,
    meta: { bytes, hardCap: MAX_ASSET_BYTES },
  } satisfies ApiResponse;
}

function normalizePreviewUrls(raw: unknown): AssetPreviewUrls | null {
  const parsed = typeof raw === 'string' ? parsePreviewUrlsString(raw) : raw;
  if (!parsed) return null;

  if (Array.isArray(parsed)) {
    const urls = parsed.filter((url): url is string => typeof url === 'string' && url.trim().length > 0);
    if (urls.length === 0) return null;
    return {
      ...(urls[0] ? { small: urls[0] } : {}),
      ...(urls[1] ? { medium: urls[1] } : {}),
      ...(urls[2] ? { large: urls[2] } : {}),
    };
  }

  if (typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: AssetPreviewUrls = {};
  for (const key of ['small', 'medium', 'large'] as const) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parsePreviewUrlsString(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function assetHttpEtag(asset: Pick<AssetRow, 'contentHash' | 'revision'>): string {
  return `"${asset.contentHash}:${asset.revision ?? 0}"`;
}

// release202/13 L0 — cache-control for the byte route.
//
// Derivatives (thumbnails / previews — `parentAssetId` + `derivationKind` set)
// are content-addressed and never mutated in place: a regenerated derivative is
// a NEW row, never an edit of the existing one. So their bytes are immutable and
// can be cached for a year. The `:id` URL of a top-level asset, by contrast, maps
// to the *current revision* and can change (markdown editable via
// POST /:id/revisions), so it must revalidate every time — a cheap 304 instead of
// a full body. `private` keeps both out of shared/CDN caches (ACL-scoped), but the
// browser still caches per-origin (mirrors the avatar route's structure, but private).
const IMMUTABLE_BYTES_CACHE = 'private, max-age=31536000, immutable';
const MUTABLE_BYTES_CACHE = 'private, max-age=0, must-revalidate';

function isImmutableDerivative(asset: Pick<AssetRow, 'parentAssetId' | 'derivationKind'>): boolean {
  return Boolean(asset.parentAssetId) && Boolean(asset.derivationKind);
}

function byteRouteCacheControl(asset: Pick<AssetRow, 'parentAssetId' | 'derivationKind'>): string {
  return isImmutableDerivative(asset) ? IMMUTABLE_BYTES_CACHE : MUTABLE_BYTES_CACHE;
}

// release202/13 L0: normalize an entity-tag for comparison — drop the weak
// `W/` validator prefix and the surrounding double-quotes so we compare the
// inner opaque value. RFC 7232 mandates quoted ETags on the wire, but some
// clients/tools send the bare `sha256:rev` (e.g. copied from `X-Asset-Hash`),
// which used to slip past a strict `item === etag` check and return 200 instead
// of 304. Comparing the unquoted core makes the 304 fire either way.
function normalizeEtagToken(raw: string): string {
  const noWeak = raw.replace(/^W\//, '');
  const m = /^"(.*)"$/.exec(noWeak);
  return m ? m[1] : noWeak;
}

function requestHasFreshEtag(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const target = normalizeEtagToken(etag);
  return ifNoneMatch
    .split(',')
    .map((item) => item.trim())
    .some((item) => item === '*' || normalizeEtagToken(item) === target);
}

function toDTO(row: AssetRow, memoryPages?: MemoryPageSummary[]): AssetDTO {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerImUserId: row.ownerImUserId,
    contentHash: row.contentHash,
    storageUri: row.storageUri,
    sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
    mime: row.mime,
    kind: row.kind,
    sourceAgentImUserId: row.sourceAgentImUserId,
    sourceTaskId: row.sourceTaskId,
    boundKind: row.boundKind ?? null,
    metadata,
    parentAssetId: row.parentAssetId,
    derivationKind: row.derivationKind,
    ingestStatus: row.ingestStatus,
    ingestVersion: row.ingestVersion,
    ingestError: row.ingestError,
    assetIndexSeq: Number(row.assetIndexSeq ?? BigInt(0)),
    cdnUrl: row.cdnUrl,
    thumbnailUrl: row.thumbnailUrl,
    previewUrls: normalizePreviewUrls(row.previewUrls),
    blurHash: row.blurHash ?? null,
    previewAssetId: row.previewAssetId,
    folderPath: row.folderPath,
    filename: row.filename,
    sourceRef: row.sourceRef,
    sourceKind: row.sourceKind,
    sourceMetadata: parseObject(row.sourceMetadata),
    revision: row.revision,
    visibility: row.visibility,
    aclJson: parseObject(row.aclJson),
    description: row.description,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    ...(memoryPages ? { memoryPages } : {}),
  };
}

function toRevisionDTO(row: AssetRevisionRow): AssetRevisionDTO {
  return {
    id: row.id,
    assetId: row.assetId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes != null ? Number(row.sizeBytes) : null,
    mime: row.mime,
    kind: row.kind,
    filename: row.filename,
    folderPath: row.folderPath,
    sourceRef: row.sourceRef,
    sourceKind: row.sourceKind,
    ingestStatus: row.ingestStatus,
    ingestVersion: row.ingestVersion,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdByImUserId: row.createdByImUserId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function assetRowFromRevision(asset: AssetRow, revision: AssetRevisionRow): AssetRow {
  return {
    id: asset.id,
    workspaceId: revision.workspaceId,
    ownerImUserId: revision.ownerImUserId,
    contentHash: revision.contentHash,
    storageUri: revision.storageUri,
    sizeBytes: revision.sizeBytes,
    mime: revision.mime,
    kind: revision.kind,
    sourceAgentImUserId: revision.sourceAgentImUserId,
    sourceTaskId: revision.sourceTaskId,
    metadata: revision.metadata,
    parentAssetId: revision.parentAssetId,
    derivationKind: revision.derivationKind,
    ingestStatus: revision.ingestStatus,
    ingestVersion: revision.ingestVersion,
    ingestError: revision.ingestError,
    assetIndexSeq: asset.assetIndexSeq,
    cdnUrl: revision.cdnUrl,
    thumbnailUrl: revision.thumbnailUrl,
    previewUrls: revision.previewUrls,
    // release202/13 §3b① — blurHash isn't snapshotted per-revision (it's a
    // current-state derivative field, like boundKind). Mirror from the parent.
    blurHash: asset.blurHash ?? null,
    previewAssetId: revision.previewAssetId,
    folderPath: revision.folderPath,
    filename: revision.filename,
    sourceRef: revision.sourceRef,
    sourceKind: revision.sourceKind,
    sourceMetadata: revision.sourceMetadata,
    revision: revision.revision,
    visibility: revision.visibility,
    aclJson: revision.aclJson,
    description: revision.description,
    // release201/09 §9.4a.2 — revisions don't snapshot boundKind (it's a
    // current-state field, not historical). Mirror from the parent asset
    // so the rebuilt AssetRow stays type-complete.
    boundKind: asset.boundKind ?? null,
    createdAt: asset.createdAt,
    updatedAt: revision.createdAt,
    deletedAt: revision.deletedAt,
  };
}

async function createAssetRevisionSnapshot(
  tx: AssetRevisionSnapshotTx,
  asset: AssetRow,
  createdByImUserId: string | null,
  reason: string,
): Promise<void> {
  const data = {
    assetId: asset.id,
    workspaceId: asset.workspaceId,
    revision: asset.revision,
    contentHash: asset.contentHash,
    storageUri: asset.storageUri,
    sizeBytes: asset.sizeBytes,
    mime: asset.mime,
    kind: asset.kind,
    ownerImUserId: asset.ownerImUserId,
    sourceAgentImUserId: asset.sourceAgentImUserId,
    sourceTaskId: asset.sourceTaskId,
    metadata: asset.metadata,
    parentAssetId: asset.parentAssetId,
    derivationKind: asset.derivationKind,
    ingestStatus: asset.ingestStatus,
    ingestVersion: asset.ingestVersion,
    ingestError: asset.ingestError,
    cdnUrl: asset.cdnUrl,
    thumbnailUrl: asset.thumbnailUrl,
    previewUrls: asset.previewUrls == null ? undefined : asset.previewUrls,
    previewAssetId: asset.previewAssetId,
    folderPath: asset.folderPath,
    filename: asset.filename,
    sourceRef: asset.sourceRef,
    sourceKind: asset.sourceKind,
    sourceMetadata: asset.sourceMetadata,
    visibility: asset.visibility,
    aclJson: asset.aclJson,
    description: asset.description,
    deletedAt: asset.deletedAt,
    createdByImUserId,
    reason,
  };

  await tx.iMAssetRevision.upsert({
    where: { assetId_revision: { assetId: asset.id, revision: asset.revision } },
    create: data,
    update: {},
  });
}

async function ensureAssetRevisionSnapshot(
  asset: AssetRow,
  createdByImUserId: string | null,
  reason = 'backfill-current',
): Promise<void> {
  await createAssetRevisionSnapshot(prisma as unknown as AssetRevisionSnapshotTx, asset, createdByImUserId, reason);
}

async function loadAssetRevisionOrCurrent(
  asset: AssetRow,
  revisionRaw: string | null | undefined,
  createdByImUserId: string | null,
): Promise<AssetRevisionRow | null> {
  if (!revisionRaw) return null;
  const revision = Number(revisionRaw);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
  if (revision === asset.revision) {
    await ensureAssetRevisionSnapshot(asset, createdByImUserId);
  }
  return (await prisma.iMAssetRevision.findUnique({
    where: { assetId_revision: { assetId: asset.id, revision } },
  })) as unknown as AssetRevisionRow | null;
}

function assetPreviewName(asset: Pick<AssetDTO, 'filename' | 'metadata' | 'storageUri'>): string {
  const title = asset.metadata?.title;
  const filename = asset.filename;
  if (typeof filename === 'string' && filename.trim()) return filename.trim().toLowerCase();
  if (typeof title === 'string' && title.trim()) return title.trim().toLowerCase();
  return asset.storageUri.toLowerCase();
}

function isHtmlAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('html') || /\.(html|htm|xhtml)$/i.test(name);
}

function isMarkdownAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return mime.includes('markdown') || /\.(md|markdown|mdown|mkdn)$/i.test(name);
}

function isTextAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.startsWith('text/') ||
    mime.includes('markdown') ||
    mime.includes('xml') ||
    /^(application|text)\/(x-)?(yaml|toml)$/.test(mime) ||
    /\.(yaml|yml|toml|txt|log|ini|conf|env|properties|rst)$/i.test(name) ||
    (mime === 'application/octet-stream' && /\.(md|markdown|txt|log|ini|conf|env|properties|rst)$/i.test(name))
  );
}

function isCodeAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('python') ||
    mime.includes('json') ||
    asset.kind.includes('code') ||
    /\.(js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|html|htm|xhtml|sh|sql|yaml|yml|toml)$/.test(name)
  );
}

function isDataAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('json') ||
    mime.includes('csv') ||
    mime.includes('parquet') ||
    asset.kind.includes('dataset') ||
    /\.(json|csv|tsv|ndjson|parquet)$/.test(name)
  );
}

function isTabularDataAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('csv') ||
    mime.includes('tab-separated-values') ||
    mime.includes('parquet') ||
    /\.(csv|tsv|parquet)$/.test(name)
  );
}

function isSpreadsheetAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('spreadsheetml') ||
    mime.includes('ms-excel') ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet' ||
    /\.(xlsx|xls|ods)$/.test(name)
  );
}

function isDocumentAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime.includes('wordprocessingml') ||
    mime.includes('presentationml') ||
    mime.includes('msword') ||
    mime.includes('ms-powerpoint') ||
    mime === 'application/vnd.oasis.opendocument.text' ||
    mime === 'application/vnd.oasis.opendocument.presentation' ||
    /\.(docx|doc|pptx|ppt|odt|odp)$/.test(name)
  );
}

function isArchiveAsset(asset: AssetDTO): boolean {
  const mime = asset.mime ?? '';
  const name = assetPreviewName(asset);
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    mime === 'application/x-bzip2' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/x-rar-compressed' ||
    mime === 'application/vnd.rar' ||
    /\.(zip|tar|tgz|tar\.gz|gz|bz2|xz|7z|rar)$/.test(name)
  );
}

function previewUrlEntries(previewUrls: AssetPreviewUrls | null): Array<{ size: keyof AssetPreviewUrls; url: string }> {
  if (!previewUrls) return [];
  return (['small', 'medium', 'large'] as const)
    .map((size) => ({ size, url: previewUrls[size] }))
    .filter(
      (entry): entry is { size: keyof AssetPreviewUrls; url: string } =>
        typeof entry.url === 'string' && entry.url.trim().length > 0,
    );
}

function previewDerivativeEndpointFromMetadata(asset: AssetDTO, kind: string): string | null {
  const previewDerivatives = asset.metadata.previewDerivatives;
  if (!previewDerivatives || typeof previewDerivatives !== 'object' || Array.isArray(previewDerivatives)) return null;
  const entry = (previewDerivatives as Record<string, unknown>)[kind];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const endpoint = (entry as Record<string, unknown>).endpoint;
  return typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : null;
}

function buildAssetPreviewContract(asset: AssetDTO): AssetPreviewContract {
  const mime = asset.mime ?? '';
  const size = asset.sizeBytes ?? undefined;
  const warnings: AssetPreviewContract['warnings'] = [];
  const securityWarnings: AssetPreviewContract['securityWarnings'] = [];
  const base = {
    contentLength: size,
    byteRangeSupported: !asset.storageUri.startsWith('s3://'),
    extractorVersion: `asset-preview-v${asset.ingestVersion ?? 1}`,
    etag: `${asset.contentHash}:${asset.revision ?? 0}`,
    derivatives: [] as AssetPreviewContract['derivatives'],
    warnings,
    securityWarnings,
  };
  const seenDerivativeUrls = new Set<string>();
  if (asset.thumbnailUrl) {
    seenDerivativeUrls.add(asset.thumbnailUrl);
    base.derivatives.push({ type: 'thumbnail', url: asset.thumbnailUrl, metadata: { source: 'thumbnailUrl' } });
  }
  for (const entry of previewUrlEntries(asset.previewUrls)) {
    if (seenDerivativeUrls.has(entry.url)) continue;
    seenDerivativeUrls.add(entry.url);
    base.derivatives.push({ type: 'thumbnail', url: entry.url, metadata: { source: 'previewUrls', size: entry.size } });
  }

  if (mime.startsWith('image/')) {
    return {
      ...base,
      kind: 'image',
      status: 'ready',
      maxInlineBytes: MAX_ASSET_BYTES,
      preferredRenderer: 'native',
      inlinePolicy: 'allow',
    };
  }
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    let hlsEndpoint: string | null = null;
    if (asset.previewAsset?.derivationKind === 'hls-manifest') {
      hlsEndpoint =
        previewDerivativeEndpointFromMetadata(asset, 'hls-manifest') ??
        asset.previewAsset.cdnUrl ??
        `/api/im/assets/${asset.previewAsset.id}`;
      base.derivatives.push({
        type: 'hls_manifest',
        assetId: asset.previewAsset.id,
        endpoint: hlsEndpoint,
        metadata: {
          contentHash: asset.previewAsset.contentHash,
          sizeBytes: asset.previewAsset.sizeBytes,
          ...(asset.previewAsset.metadata.previewDerivative &&
          typeof asset.previewAsset.metadata.previewDerivative === 'object'
            ? { previewDerivative: asset.previewAsset.metadata.previewDerivative }
            : {}),
        },
      });
    }
    return {
      ...base,
      kind: 'media',
      status: 'ready',
      maxInlineBytes: MAX_ASSET_BYTES,
      preferredRenderer: hlsEndpoint ? 'video-js' : 'native',
      inlinePolicy: 'allow',
    };
  }
  if (mime.includes('pdf') || /\.pdf$/i.test(assetPreviewName(asset))) {
    if (asset.memoryPages?.length) {
      base.derivatives.push({ type: 'page_text', metadata: { memoryPageCount: asset.memoryPages.length } });
    }
    if (asset.previewAsset?.derivationKind === 'pdf-linearized') {
      base.derivatives.push({
        type: 'pdf_linearized',
        assetId: asset.previewAsset.id,
        endpoint: `/api/im/assets/${asset.previewAsset.id}`,
        metadata: {
          contentHash: asset.previewAsset.contentHash,
          sizeBytes: asset.previewAsset.sizeBytes,
        },
      });
    }
    const tooLarge = size != null && size > MAX_DOCUMENT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'pdf',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_DOCUMENT_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'page-viewer',
      inlinePolicy: tooLarge ? 'metadata-only' : 'allow',
    };
  }
  if (isArchiveAsset(asset)) {
    securityWarnings.push({
      code: 'archive_not_auto_extracted',
      message: 'Archive contents are not extracted inline to avoid zip bombs and path traversal.',
    });
    return {
      ...base,
      kind: 'archive',
      status: 'unsupported',
      maxInlineBytes: 0,
      preferredRenderer: 'native',
      inlinePolicy: 'download-only',
    };
  }
  if (isSpreadsheetAsset(asset)) {
    const tooLarge = size != null && size > MAX_TABLE_INLINE_PREVIEW_BYTES;
    if (tooLarge) {
      warnings.push({
        code: 'spreadsheet_inline_limit',
        message: `Spreadsheet inline preview is limited to ${MAX_TABLE_INLINE_PREVIEW_BYTES} bytes.`,
      });
    }
    return {
      ...base,
      kind: 'table',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TABLE_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'table-sample',
      inlinePolicy: tooLarge ? 'metadata-only' : 'sample-only',
    };
  }
  if (isHtmlAsset(asset)) {
    securityWarnings.push({
      code: 'safe_html_preview',
      message: 'HTML render preview is sanitized and sandboxed; scripts, forms, and remote resources are disabled.',
    });
    const tooLarge = size != null && size > MAX_TEXT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'html',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TEXT_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'iframe-safe-html',
      inlinePolicy: tooLarge ? 'metadata-only' : 'allow',
    };
  }
  if (isTabularDataAsset(asset)) {
    const tooLarge = size != null && size > MAX_TABLE_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'table',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TABLE_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'table-sample',
      inlinePolicy: tooLarge ? 'metadata-only' : 'sample-only',
    };
  }
  if (isDataAsset(asset)) {
    const tooLarge = size != null && size > MAX_TEXT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'table',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TEXT_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'table-sample',
      inlinePolicy: tooLarge ? 'metadata-only' : 'sample-only',
    };
  }
  if (isCodeAsset(asset)) {
    const tooLarge = size != null && size > MAX_TEXT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'code',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TEXT_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'monaco',
      inlinePolicy: tooLarge ? 'metadata-only' : 'allow',
    };
  }
  if (isTextAsset(asset)) {
    const tooLarge = size != null && size > MAX_TEXT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'text',
      status: tooLarge ? 'too_large' : 'ready',
      maxInlineBytes: MAX_TEXT_INLINE_PREVIEW_BYTES,
      preferredRenderer: isMarkdownAsset(asset) ? 'markdown' : 'monaco',
      inlinePolicy: tooLarge ? 'metadata-only' : 'allow',
    };
  }
  if (isDocumentAsset(asset)) {
    const tooLarge = size != null && size > MAX_DOCUMENT_INLINE_PREVIEW_BYTES;
    return {
      ...base,
      kind: 'document',
      status: tooLarge ? 'too_large' : asset.previewAssetId || asset.memoryPages?.length ? 'partial' : 'ready',
      maxInlineBytes: MAX_DOCUMENT_INLINE_PREVIEW_BYTES,
      preferredRenderer: 'page-viewer',
      inlinePolicy: tooLarge ? 'metadata-only' : 'allow',
    };
  }

  return {
    ...base,
    kind: 'download-only',
    status: 'unsupported',
    maxInlineBytes: 0,
    preferredRenderer: 'native',
    inlinePolicy: 'download-only',
  };
}

// getBackend / writeFilesystem / writeS3 / assetS3KeyForContentHash /
// assetCdnUrlForS3Key / assetCdnUrlForStorageUri now live in
// ../services/asset-blob-store (imported at the top of this file). The s3
// key + cdn helpers are part of this module's public surface, so re-export
// them here to keep existing import sites stable.
export { assetCdnUrlForS3Key, assetCdnUrlForStorageUri, assetS3KeyForContentHash };

function internalDerivativeCallbackSecret(): string {
  return (
    process.env.ASSET_DERIVATIVE_CALLBACK_SECRET ||
    process.env.INTERNAL_API_SECRET ||
    process.env.WEBHOOK_SECRET ||
    ''
  ).trim();
}

function hasValidInternalDerivativeSecret(headerValue: string | undefined): boolean {
  const expected = internalDerivativeCallbackSecret();
  if (!expected || !headerValue) return false;
  const actual = headerValue.replace(/^Bearer\s+/i, '').trim();
  if (!actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function loadOwnedWorkspace(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws || ws.ownerImUserId !== callerImUserId) return null;
  return ws;
}

async function loadWorkspaceForAssetAccess(workspaceId: string, callerImUserId: string) {
  const ws = await prisma.iMWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, ownerImUserId: true },
  });
  if (!ws) return null;
  if (ws.ownerImUserId === callerImUserId) return ws;
  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: callerImUserId },
    select: { workspaceId: true },
  });
  return card?.workspaceId === workspaceId ? ws : null;
}

async function allocateAssetIndexSeq(tx: AssetIndexTx, workspaceId: string): Promise<bigint> {
  const counter = await tx.iMAssetIndexCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, nextSeq: BigInt(2) },
    update: { nextSeq: { increment: 1 } },
  });
  return counter.nextSeq - BigInt(1);
}

function assetChangedPayload(
  row: Pick<AssetRow, 'id' | 'workspaceId' | 'contentHash' | 'assetIndexSeq' | 'revision'>,
  operation: AssetChangedPayload['operation'],
): AssetChangedPayload {
  return {
    workspaceId: row.workspaceId,
    assetId: row.id,
    operation,
    contentHash: row.contentHash,
    assetIndexSeq: Number(row.assetIndexSeq),
    revision: row.revision,
  };
}

/**
 * Resolve every HUMAN recipient that should hear about an asset.changed in a
 * workspace: the workspace owner + every IMWorkspaceMember. This is the fix for
 * the "publishAssetChanged only reaches the asset owner agent, not the human"
 * gap (page.tsx:982) — for agent/cli-delivered assets the asset's
 * ownerImUserId is the AGENT, so targeting only that id never reaches the human
 * who is watching the chat. We fan out the WS event to all workspace members so
 * the frontend can reactively patch the card once the thumbnail derivative is
 * ready.
 *
 * Best-effort: returns the asset owner alone if the membership lookup fails, so
 * the event is never dropped entirely.
 */
async function resolveWorkspaceAssetRecipients(workspaceId: string, ownerImUserId: string): Promise<string[]> {
  const recipients = new Set<string>([ownerImUserId]);
  try {
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: workspaceId },
      select: { ownerImUserId: true },
    });
    if (ws?.ownerImUserId) recipients.add(ws.ownerImUserId);
    const members = await prisma.iMWorkspaceMember.findMany({
      where: { workspaceId },
      select: { memberImUserId: true },
    });
    for (const m of members) recipients.add(m.memberImUserId);
  } catch (err) {
    console.error('[AssetsAPI] resolveWorkspaceAssetRecipients failed', {
      workspaceId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return Array.from(recipients);
}

async function publishAssetChanged(input: {
  rooms?: RoomManager;
  syncService?: SyncService;
  ownerImUserId: string;
  row: Pick<AssetRow, 'id' | 'workspaceId' | 'contentHash' | 'assetIndexSeq' | 'revision'>;
  operation: AssetChangedPayload['operation'];
}): Promise<void> {
  const payload = assetChangedPayload(input.row, input.operation);
  // Fan out the WS event to every human in the workspace (owner + members), not
  // just the asset's ownerImUserId. For agent/cli-delivered assets the owner is
  // the agent — the human watching the chat would otherwise never get the
  // reactive thumbnail-ready signal.
  const recipients = await resolveWorkspaceAssetRecipients(payload.workspaceId, input.ownerImUserId);
  for (const recipientId of recipients) {
    try {
      input.rooms?.sendToUser(recipientId, ServerEvents.assetChanged(payload));
    } catch (err) {
      console.error('[AssetsAPI] WS asset.changed publish failed', {
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        operation: payload.operation,
        recipientId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await input.syncService?.writeEvent('asset.changed', { ...payload }, null, input.ownerImUserId).catch((err) => {
    console.error('[AssetsAPI] sync asset.changed publish failed', {
      workspaceId: payload.workspaceId,
      assetId: payload.assetId,
      operation: payload.operation,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * 2026-05-22 — outbox→kanban attachment chip helper.
 *
 * Appends `assetId` to `IMTask.metadata.outputAssetIds` (an array of
 * IMAsset IDs). Idempotent: skip if the ID is already present. Best-effort
 * — caller wraps in catch so a failure here never rolls back the upload.
 *
 * Why metadata.outputAssetIds (denormalised) when im_assets.sourceTaskId
 * already exists:
 *  - The IMAsset.sourceTaskId column powers the live kanban chip via
 *    task-board.tsx assetsByTaskId index (workspace pulls all assets,
 *    groups by sourceTaskId at render time).
 *  - This denormalisation gives completeTask a cheap lookup to roll into
 *    `task.result.assetIds` so mobile / search / external readers can
 *    list a task's deliverables off the result payload alone.
 *  - Storing IDs (not full asset rows) keeps the column small and avoids
 *    cache-coherency headaches if assets are renamed / re-described later.
 */
/**
 * release202/09 P1 — derive the owning conversationId for a watcher-path
 * (sandbox-output / agent-output) upload so the session right sidebar
 * (page.tsx:1330 filters assets by `metadata.conversationId === selected`)
 * shows auto-delivered files. The upload carries `metadata.taskId`, which —
 * because run and task ids are the same shape (both VarChar(30) cuid) — may
 * point at either an `im_tasks` row or an `im_task_runs` row. We probe both:
 * task first, then run, returning the first conversationId we find. Best-effort
 * — a miss just leaves conversationId unstamped (status quo), never throws.
 */
async function resolveConversationIdForTaskOrRun(taskOrRunId: string): Promise<string | null> {
  try {
    const task = await prisma.iMTask.findUnique({
      where: { id: taskOrRunId },
      select: { conversationId: true },
    });
    if (task?.conversationId) return task.conversationId;
  } catch {
    // fall through to run probe
  }
  try {
    const run = await prisma.iMTaskRun.findUnique({
      where: { id: taskOrRunId },
      select: { conversationId: true },
    });
    if (run?.conversationId) return run.conversationId;
  } catch {
    // best-effort
  }
  return null;
}

async function appendOutputAssetIdToTask(taskId: string, assetId: string): Promise<boolean> {
  const task = await prisma.iMTask.findUnique({
    where: { id: taskId },
    select: { metadata: true },
  });
  if (!task) return false;

  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(task.metadata || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed metadata — treat as empty so we don't lose the new ID.
  }

  const existing = Array.isArray(meta.outputAssetIds)
    ? (meta.outputAssetIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  if (existing.includes(assetId)) return false; // idempotent — no change

  const next = [...existing, assetId];
  await prisma.iMTask.update({
    where: { id: taskId },
    data: { metadata: JSON.stringify({ ...meta, outputAssetIds: next }) },
  });
  return true; // outputAssetIds actually grew
}

/**
 * WS2 (release201/3x) — narrow port the assets router uses to nudge the task
 * layer into re-emitting a closed task's completion digest after a
 * late-arriving deliverable asset rolled into `metadata.outputAssetIds`.
 *
 * Deliberately a one-method interface (not the full TaskService) so this api/
 * module never imports the heavy `task.service` graph — keeping the existing
 * api → services edge thin and side-stepping a circular import. routes.ts
 * already holds the concrete TaskService and passes it straight through; it
 * structurally satisfies this shape.
 */
export interface TaskDigestReemitter {
  reemitTerminalDigestForAssetArrival(taskId: string): Promise<void>;
}

/**
 * WS2 — best-effort: if appending `assetId` actually changed the task's
 * `metadata.outputAssetIds` AND the task is already in a terminal state,
 * re-upsert its rolling completion digest so the chat card's
 * `resultAssetCount` / `resultAssets` catch up with the drawer (final
 * consistency for daemon "uploaded but unflushed" assets). The task layer
 * owns the terminal-status gate + live-asset count derivation; here we only
 * decide *whether to nudge*. Never throws into the upload path.
 */
async function rollupAndReemitDigest(
  taskId: string,
  assetId: string,
  taskService: TaskDigestReemitter | undefined,
  context: 'dedup' | 'fresh',
): Promise<void> {
  let appended = false;
  try {
    appended = await appendOutputAssetIdToTask(taskId, assetId);
  } catch (err) {
    console.warn(`[AssetsAPI] outputAssetIds rollup failed (${context})`, {
      taskId,
      assetId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!appended || !taskService) return;
  // Re-emit is itself idempotent (task layer no-ops for non-terminal tasks and
  // re-derives an identical payload when nothing changed), so a redundant call
  // is cheap; we still gate on `appended` to avoid hammering the digest upsert
  // for the common already-listed case.
  await taskService.reemitTerminalDigestForAssetArrival(taskId).catch((err) => {
    console.warn(`[AssetsAPI] terminal digest re-emit failed (${context})`, {
      taskId,
      assetId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

type DerivativeCallbackKind = 'thumbnail' | 'pdf-linearized' | 'hls-manifest';

interface AssetDerivativeCallbackBody {
  assetId?: unknown;
  workspaceId?: unknown;
  derivationKind?: unknown;
  derivedAssetId?: unknown;
  contentHash?: unknown;
  storageUri?: unknown;
  cdnUrl?: unknown;
  endpoint?: unknown;
  sizeBytes?: unknown;
  mime?: unknown;
  kind?: unknown;
  filename?: unknown;
  metadata?: unknown;
  previewSize?: unknown;
  // release202/13 §3b① — base64 thumbHash of the parent image (thumbnail kind).
  blurHash?: unknown;
}

function parseDerivativeCallbackKind(value: unknown): DerivativeCallbackKind | null {
  if (value !== 'thumbnail' && value !== 'pdf-linearized' && value !== 'hls-manifest') return null;
  return value;
}

function parseCallbackMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata must be an object');
  return parsed as Record<string, unknown>;
}

function parsePositiveSizeBytes(raw: unknown): bigint | null {
  if (raw == null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error('sizeBytes must be a non-negative number');
  return BigInt(Math.floor(value));
}

/**
 * Inline `<img>`/preview serving endpoint for a derivative (thumbnail/preview).
 *
 * ALWAYS the relative bytes route `/api/im/assets/:id` — NEVER a direct `cdnUrl`.
 * The IM asset store lives in a PRIVATE bucket (`pro-prismer-slide`); the public
 * CDN (`cdn.prismer.app` / CloudFront) has no `GetObject` grant on the `assets/`
 * prefix, so a direct `cdnUrl` 403s in the browser (CloudFront → S3 AccessDenied).
 * The bytes route is the source-of-truth serving path: it streams on filesystem
 * and 302→presigned on S3, and enforces workspace ACL. The frontend
 * `useAuthedAssetSrc` fetches relative `/api/im/assets/*` WITH the workspace
 * token → blob — which is exactly why filesystem (local) rendered fine while S3
 * (test) 403'd on the direct CDN url. The row still stores `cdnUrl` as metadata;
 * we just never serve inline previews through it. A caller may pass an explicit
 * RELATIVE `/api/im/assets/...` override, but an absolute (CDN) endpoint is
 * ignored. — 2026-06-06
 */
function publicDerivativeEndpoint(input: { id: string; endpoint?: unknown }): string {
  if (typeof input.endpoint === 'string' && input.endpoint.startsWith('/api/im/assets/')) {
    return input.endpoint.trim();
  }
  return assetBytesEndpoint(input.id);
}

function mergeParentDerivativeMetadata(input: {
  existing: string;
  kind: DerivativeCallbackKind;
  derivedAssetId: string;
  endpoint: string;
  metadata: Record<string, unknown>;
}): string {
  const existing = parseObject(input.existing) ?? {};
  const previewDerivatives =
    existing.previewDerivatives &&
    typeof existing.previewDerivatives === 'object' &&
    !Array.isArray(existing.previewDerivatives)
      ? (existing.previewDerivatives as Record<string, unknown>)
      : {};
  return JSON.stringify({
    ...existing,
    previewDerivatives: {
      ...previewDerivatives,
      [input.kind]: {
        assetId: input.derivedAssetId,
        endpoint: input.endpoint,
        metadata: input.metadata,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

async function completeAssetDerivativeCallback(input: {
  body: AssetDerivativeCallbackBody;
  rooms?: RoomManager;
  syncService?: SyncService;
}): Promise<{ status: number; response: ApiResponse<{ parent: AssetDTO; derivative: AssetDTO }> }> {
  const parentId = typeof input.body.assetId === 'string' ? input.body.assetId.trim() : '';
  const workspaceId = typeof input.body.workspaceId === 'string' ? input.body.workspaceId.trim() : '';
  const derivationKind = parseDerivativeCallbackKind(input.body.derivationKind);
  if (!parentId) return { status: 400, response: { ok: false, error: 'assetId is required' } };
  if (!derivationKind) {
    return {
      status: 400,
      response: { ok: false, error: 'derivationKind must be thumbnail, pdf-linearized, or hls-manifest' },
    };
  }

  const parent = (await prisma.iMAsset.findUnique({
    where: { id: parentId },
    include: { workspace: { select: { ownerImUserId: true } } },
  })) as (AssetRow & { workspace?: { ownerImUserId: string } }) | null;
  if (!parent || parent.deletedAt || (workspaceId && parent.workspaceId !== workspaceId)) {
    return { status: 404, response: { ok: false, error: 'Asset not found' } };
  }

  const metadata = parseCallbackMetadata(input.body.metadata);
  const derivedAssetId = typeof input.body.derivedAssetId === 'string' ? input.body.derivedAssetId.trim() : '';
  const contentHash =
    typeof input.body.contentHash === 'string'
      ? input.body.contentHash
          .trim()
          .toLowerCase()
          .replace(/^sha256[:=]/, '')
      : '';
  const storageUri = typeof input.body.storageUri === 'string' ? input.body.storageUri.trim() : '';
  if (!derivedAssetId && !/^[a-f0-9]{64}$/.test(contentHash)) {
    return { status: 400, response: { ok: false, error: 'contentHash must be a 64-character SHA-256 hex digest' } };
  }
  if (!derivedAssetId && !storageUri) {
    return {
      status: 400,
      response: { ok: false, error: 'storageUri is required when derivedAssetId is not provided' },
    };
  }

  const sizeBytes = parsePositiveSizeBytes(input.body.sizeBytes);
  const mime =
    typeof input.body.mime === 'string' && input.body.mime.trim()
      ? input.body.mime.trim()
      : derivationKind === 'thumbnail'
        ? 'image/webp'
        : derivationKind === 'pdf-linearized'
          ? 'application/pdf'
          : 'application/vnd.apple.mpegurl';
  const kind = typeof input.body.kind === 'string' && input.body.kind.trim() ? input.body.kind.trim() : 'preview';
  const filename =
    typeof input.body.filename === 'string' && input.body.filename.trim()
      ? input.body.filename.trim()
      : `${parent.contentHash.slice(0, 16)}.${derivationKind}`;
  const bodyCdnUrl =
    typeof input.body.cdnUrl === 'string' && input.body.cdnUrl.trim() ? input.body.cdnUrl.trim() : null;
  const derivedCdnUrl = bodyCdnUrl ?? (storageUri ? assetCdnUrlForStorageUri(storageUri) : null);
  const previewSize =
    input.body.previewSize === 'small' || input.body.previewSize === 'large' || input.body.previewSize === 'medium'
      ? input.body.previewSize
      : 'medium';
  // release202/13 §3b① — thumbHash for an instant blurred placeholder on the
  // parent image row. Best-effort: trimmed base64, capped to the VARCHAR(64).
  const blurHash =
    typeof input.body.blurHash === 'string' && input.body.blurHash.trim()
      ? input.body.blurHash.trim().slice(0, 64)
      : null;

  const { parent: updatedParent, derivative } = await prisma.$transaction(async (tx: AssetWriteTx) => {
    let derived: AssetRow | null = null;
    if (derivedAssetId) {
      const existing = (await tx.iMAsset.findUnique({ where: { id: derivedAssetId } })) as unknown as AssetRow | null;
      if (!existing || existing.workspaceId !== parent.workspaceId || existing.deletedAt) {
        throw new Error('derivedAssetId not found in parent workspace');
      }
      derived = existing;
    } else {
      const existing = (await tx.iMAsset.findFirst({
        where: {
          workspaceId: parent.workspaceId,
          parentAssetId: parent.id,
          derivationKind,
          contentHash,
          deletedAt: null,
        },
      })) as unknown as AssetRow | null;
      if (existing) {
        derived = existing;
      } else {
        const derivedSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
        derived = (await tx.iMAsset.create({
          data: {
            workspaceId: parent.workspaceId,
            ownerImUserId: parent.ownerImUserId,
            contentHash,
            storageUri,
            sizeBytes,
            mime,
            kind,
            metadata: JSON.stringify({
              ...metadata,
              filename,
              previewDerivative: {
                type: derivationKind,
                sourceAssetId: parent.id,
                sourceContentHash: parent.contentHash,
              },
            }),
            parentAssetId: parent.id,
            derivationKind,
            ingestStatus: 'asset-only',
            assetIndexSeq: derivedSeq,
            cdnUrl: derivedCdnUrl,
            filename,
            sourceRef: `asset://${parent.id}#${derivationKind}`,
            sourceKind: 'asset-derived-callback',
            sourceMetadata: JSON.stringify({ parentAssetId: parent.id, derivationKind, callback: true }),
            visibility: parent.visibility,
            aclJson: parent.aclJson,
          },
        })) as unknown as AssetRow;
        await createAssetRevisionSnapshot(tx, derived, null, 'created-derivative-callback');
      }
    }

    const endpoint = publicDerivativeEndpoint({
      id: derived.id,
      endpoint: input.body.endpoint,
    });
    const currentPreviewUrls = normalizePreviewUrls(parent.previewUrls) ?? {};
    const parentSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const data: Record<string, unknown> = {
      assetIndexSeq: parentSeq,
      revision: { increment: 1 },
      metadata: mergeParentDerivativeMetadata({
        existing: parent.metadata,
        kind: derivationKind,
        derivedAssetId: derived.id,
        endpoint,
        metadata,
      }),
    };
    if (derivationKind === 'thumbnail') {
      data.thumbnailUrl = endpoint;
      data.previewUrls = { ...currentPreviewUrls, [previewSize]: endpoint };
      // Only stamp blurHash for image parents (thumbHash is image-pixel based);
      // a PDF-first-page thumbnail callback omits it. Don't overwrite an
      // existing value with null on a re-run.
      if (blurHash) data.blurHash = blurHash;
    } else if (derivationKind === 'pdf-linearized') {
      data.previewAssetId = derived.id;
    } else {
      data.previewAssetId = derived.id;
    }

    const updated = (await tx.iMAsset.update({ where: { id: parent.id }, data })) as unknown as AssetRow;
    await createAssetRevisionSnapshot(tx, updated, null, `${derivationKind}-callback-ready`);
    return { parent: updated, derivative: derived };
  });

  await publishAssetChanged({
    rooms: input.rooms,
    syncService: input.syncService,
    ownerImUserId: parent.workspace?.ownerImUserId ?? parent.ownerImUserId,
    row: updatedParent,
    operation: 'update',
  });

  return {
    status: 200,
    response: { ok: true, data: { parent: toDTO(updatedParent), derivative: toDTO(derivative) } },
  };
}

async function enrichAssetDTOs(rows: AssetRow[]): Promise<AssetDTO[]> {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const links = await prisma.iMKnowledgeLink.findMany({
    where: {
      workspaceId: rows[0].workspaceId,
      sourceType: 'asset',
      sourceId: { in: ids },
      targetType: 'memory_page',
      linkType: 'derived_from',
    },
  });
  const pageIds = Array.from(new Set(links.map((link: { targetId: string }) => link.targetId)));
  const pages: MemoryPageSelectedRow[] =
    pageIds.length > 0
      ? await prisma.iMMemoryPage.findMany({
          where: { id: { in: pageIds }, archivedAt: null },
          select: {
            id: true,
            workspaceId: true,
            path: true,
            title: true,
            pageType: true,
            sourceRef: true,
            sourceKind: true,
            sourceAssetId: true,
            version: true,
            stale: true,
            contentHash: true,
            updatedAt: true,
          },
        })
      : [];
  const pageById = new Map<string, MemoryPageSummary>(
    pages.map((page) => [
      page.id,
      {
        ...page,
        updatedAt: page.updatedAt.toISOString(),
      } satisfies MemoryPageSummary,
    ]),
  );
  const pagesByAsset = new Map<string, MemoryPageSummary[]>();
  for (const link of links) {
    const page = pageById.get(link.targetId);
    if (!page) continue;
    const arr = pagesByAsset.get(link.sourceId) ?? [];
    arr.push(page);
    pagesByAsset.set(link.sourceId, arr);
  }

  const dtos = rows.map((row) => toDTO(row, pagesByAsset.get(row.id) ?? []));

  // release202/13 §L1 — derive a SHORT text excerpt (`previewText`) for small
  // md/txt assets so the card can show text immediately without a byte fetch.
  // Derived at serialization (NOT stored — it would bloat replay), capped hard,
  // and only for small text-like rows. Best-effort: a read failure leaves it
  // unset and the card falls back to the existing byte-route path.
  //
  // Scoped to SMALL batches only (single-asset /detail + attachment enrich,
  // always ≤ a handful) — large Library list endpoints must NOT pay N byte
  // reads just to inline excerpts nobody renders in the list grid.
  if (dtos.length <= PREVIEW_TEXT_MAX_BATCH) {
    await Promise.all(
      dtos.map(async (dto) => {
        const text = await derivePreviewTextForAsset(dto);
        if (text) dto.previewText = text;
      }),
    );
  }

  return dtos;
}

// release202/13 §L1 — only inline previewText for small enrich batches
// (single-asset / attachment paths); skip bulk list responses.
const PREVIEW_TEXT_MAX_BATCH = 8;

// release202/13 §L1 — cap excerpt at ~280 chars (card-visible range only).
const PREVIEW_TEXT_MAX_CHARS = 280;
// Only read bytes for genuinely small text assets — never a multi-MB file.
const PREVIEW_TEXT_MAX_SOURCE_BYTES = 64 * 1024;

function isPreviewTextEligible(dto: AssetDTO): boolean {
  const mime = (dto.mime ?? '').toLowerCase();
  const filename = (dto.filename ?? '').toLowerCase();
  if (dto.derivationKind === 'thumbnail') return false;
  const textLike = mime.startsWith('text/') || mime.includes('markdown') || /\.(md|markdown|mdx|txt)$/.test(filename);
  if (!textLike) return false;
  return dto.sizeBytes == null || dto.sizeBytes <= PREVIEW_TEXT_MAX_SOURCE_BYTES;
}

async function derivePreviewTextForAsset(dto: AssetDTO): Promise<string | null> {
  if (!isPreviewTextEligible(dto)) return null;
  try {
    const bytes = await readStoredAssetBytes(dto.storageUri);
    if (!bytes || bytes.length === 0 || bytes.length > PREVIEW_TEXT_MAX_SOURCE_BYTES) return null;
    // Binary guard — a NUL byte means this isn't real text (mirrors
    // textContentForMemoryPage). Use a char-code check rather than embedding a
    // literal control char in source.
    if (bytes.includes(0)) return null;
    const text = bytes.toString('utf8');
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > PREVIEW_TEXT_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_TEXT_MAX_CHARS)}…` : trimmed;
  } catch {
    return null;
  }
}

async function enrichAssetRelations(asset: AssetDTO): Promise<AssetDTO> {
  const workspaceId = asset.workspaceId;
  const derivedRows = await prisma.iMAsset.findMany({
    where: {
      workspaceId,
      OR: [{ parentAssetId: asset.id }, { previewAssetId: asset.id }],
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  const parentRow = asset.parentAssetId
    ? await prisma.iMAsset.findUnique({
        where: { id: asset.parentAssetId },
      })
    : null;
  const previewRow = asset.previewAssetId
    ? await prisma.iMAsset.findUnique({
        where: { id: asset.previewAssetId },
      })
    : null;
  const [derived, parent, preview] = await Promise.all([
    enrichAssetDTOs(derivedRows as unknown as AssetRow[]),
    parentRow ? enrichAssetDTOs([parentRow as unknown as AssetRow]) : Promise.resolve([]),
    previewRow ? enrichAssetDTOs([previewRow as unknown as AssetRow]) : Promise.resolve([]),
  ]);
  return {
    ...asset,
    derivedAssets: derived.filter((row) => row.id !== asset.id),
    parentAsset: parent[0] ?? null,
    previewAsset: preview[0] ?? null,
  };
}

async function resolveAssetSourceTaskIds(taskId: string, workspaceId: string): Promise<string[]> {
  const ids = new Set<string>([taskId]);

  const runs = await prisma.iMTaskRun.findMany({
    where: {
      workspaceId,
      OR: [{ taskId }, { metadata: { contains: taskId } }],
    },
    select: { id: true },
    take: 100,
  });
  for (const run of runs) ids.add(run.id);

  return Array.from(ids);
}

async function extractPdfTextContent(buffer: Buffer): Promise<string | null> {
  // pdf-parse → pdfjs-dist needs the browser globals DOMMatrix / Path2D /
  // ImageData. They are polyfilled once per pod in src/instrumentation.ts (from
  // @napi-rs/canvas, now an explicit dep + serverExternalPackage) BEFORE any PDF
  // arrives. The ENTIRE body — including the dynamic import, worker setup and
  // constructor — is wrapped so that if the polyfill is somehow unavailable on a
  // pod, extraction degrades to `null` (asset still delivered, just no indexed
  // text) instead of throwing up the upload/delivery critical path. This is the
  // fix for "PDF delivery worked locally but crashed on the prod pods".
  let parser: {
    getText(o: { first: number; parseHyperlinks: boolean }): Promise<{ text: string }>;
    destroy(): Promise<unknown>;
  } | null = null;
  try {
    const { PDFParse } = await import('pdf-parse');
    if (!pdfParseWorkerConfigured) {
      PDFParse.setWorker(path.join(process.cwd(), 'node_modules/pdf-parse/dist/worker/pdf.worker.mjs'));
      pdfParseWorkerConfigured = true;
    }
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText({ first: 80, parseHyperlinks: true });
    const text = result.text.trim();
    const semanticText = text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gim, '').trim();
    if (semanticText.length < 20) return null;
    return text.slice(0, 180_000);
  } catch (err) {
    console.log('[AssetsAPI] PDF text extraction failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function textContentForMemoryPage(input: {
  mime: string | null;
  kind: string;
  metadata: Record<string, unknown>;
  buffer: Buffer;
}): Promise<string | null> {
  const mime = input.mime ?? '';
  const filename = String(
    input.metadata.filename ?? input.metadata.fileName ?? input.metadata.title ?? '',
  ).toLowerCase();
  if (input.buffer.length > MAX_MEMORY_PAGE_EXTRACT_BYTES) return null;
  const isPdf = mime.includes('pdf') || /\.pdf$/.test(filename);
  if (isPdf) return extractPdfTextContent(input.buffer);
  const textLike =
    mime.startsWith('text/') ||
    mime.includes('markdown') ||
    mime.includes('json') ||
    mime.includes('csv') ||
    input.kind.includes('code') ||
    input.kind === PHOTO_MEMORY_SEGMENT_KIND ||
    /\.(md|markdown|txt|json|csv|tsv|ndjson|js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|html|htm|xhtml|sql|yaml|yml|toml)$/.test(
      filename,
    );
  if (!textLike) return null;
  const text = input.buffer.toString('utf8');
  if (!text.trim()) return null;
  if (text.includes('\u0000')) return null;
  return text;
}

function assetTitleFromUpload(fileName: string, metadata: Record<string, unknown>, contentHash: string) {
  const metaTitle = metadata.title;
  if (typeof metaTitle === 'string' && metaTitle.trim()) return metaTitle.trim();
  if (fileName.trim()) return fileName.trim();
  return contentHash.slice(0, 16);
}

// writeFilesystem / writeS3 moved to ../services/asset-blob-store (imported
// at top). They are unchanged byte-for-byte; behavior is identical.

function assetBytesEndpoint(assetId: string): string {
  return `${LOCAL_ASSET_ENDPOINT_PREFIX}/${encodeURIComponent(assetId)}`;
}

function thumbnailFilename(filename: string | null | undefined, contentHash: string): string {
  const base = filename?.trim() || contentHash.slice(0, 16);
  const withoutExt = base.replace(/\.[^.]+$/, '');
  return `${withoutExt}.thumb.webp`;
}

async function streamFilesystem(
  storageUri: string,
  mime: string | null,
  sizeBytes: number | null,
  rangeHeader: string | null = null,
  etag: string | null = null,
  cacheControl: string = MUTABLE_BYTES_CACHE,
): Promise<Response> {
  if (!storageUri.startsWith('file://')) {
    return new Response('Bad storageUri', { status: 500 });
  }
  const filePath = storageUri.slice('file://'.length);
  try {
    // Wave-8 W6: Range support for video/audio scrubbing. Browsers' native
    // <video>/<audio> elements emit `Range: bytes=start-end` requests when
    // the server advertises `Accept-Ranges: bytes`. Without this, seek bars
    // cannot be dragged forward in some Chrome/Safari combinations.
    const stat = await fs.promises.stat(filePath);
    const totalSize = stat.size;

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const startRaw = match[1];
        const endRaw = match[2];
        let start: number;
        let end: number;
        if (startRaw === '' && endRaw !== '') {
          // suffix range "bytes=-N" → last N bytes
          const suffixLen = Math.min(parseInt(endRaw, 10) || 0, totalSize);
          start = totalSize - suffixLen;
          end = totalSize - 1;
        } else if (startRaw !== '') {
          start = parseInt(startRaw, 10) || 0;
          end = endRaw !== '' ? Math.min(parseInt(endRaw, 10), totalSize - 1) : totalSize - 1;
        } else {
          start = 0;
          end = totalSize - 1;
        }
        if (start < 0 || start >= totalSize || end < start) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }
        const length = end - start + 1;
        const headers: Record<string, string> = {
          'Content-Type': mime ?? 'application/octet-stream',
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cacheControl,
        };
        if (etag) headers['ETag'] = etag;
        if (sizeBytes != null) headers['X-Original-Size'] = String(sizeBytes);
        return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream, {
          status: 206,
          headers,
        });
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    };
    if (etag) headers['ETag'] = etag;
    if (sizeBytes != null) headers['X-Original-Size'] = String(sizeBytes);
    return new Response(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream, { headers });
  } catch {
    return new Response('Asset bytes missing', { status: 410 });
  }
}

async function readStoredAssetBytes(storageUri: string): Promise<Buffer | null> {
  if (storageUri.startsWith('file://')) {
    try {
      return await fs.promises.readFile(storageUri.slice('file://'.length));
    } catch {
      return null;
    }
  }

  const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;

  try {
    const [, bucket, key] = match;
    const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Read the head (first 4 KiB) of a stored asset so the magic-bytes sniffer
 * can inspect the file format without pulling the whole object.
 *
 * Used by direct-upload/complete where the file is already on S3 — we
 * don't want to pay the full GetObject cost just to peek at 4 KiB. Falls
 * back to the full read for filesystem mode (cheap).
 */
async function readStoredAssetHead(storageUri: string, maxBytes = 4096): Promise<Buffer | null> {
  if (storageUri.startsWith('file://')) {
    try {
      const fh = await fs.promises.open(storageUri.slice('file://'.length), 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }
  const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  try {
    const [, bucket, key] = match;
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }),
    );
    const body = res.Body;
    if (!body) return null;
    if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Best-effort delete of an asset object that was already persisted to storage
 * but is being rejected before the IMAsset row is created (e.g. MIME_MISMATCH
 * on the direct-upload completion path — the S3 PutObject already happened
 * because the client uploaded directly to the presigned URL).
 *
 * Without this cleanup, every rejected upload leaves an orphan in S3 / on
 * disk. Agents retrying their MIME_MISMATCH failure would compound the leak.
 *
 * Best-effort by design: a delete failure must not block the rejection
 * response — the caller is already on an error path and needs to return the
 * 400 to the client. Failures get logged for ops to follow up on.
 *
 * Dispatches by URI scheme:
 *   - `s3://<bucket>/<key>` → DeleteObjectCommand
 *   - `file://<abs-path>`   → fs.unlink
 *   - anything else         → no-op (best-effort contract)
 */
async function safeDeleteAssetObject(storageUri: string | null | undefined): Promise<void> {
  if (!storageUri) return;
  try {
    if (storageUri.startsWith('s3://')) {
      const match = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!match) return;
      const [, bucket, key] = match;
      if (!isS3Available()) return;
      await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return;
    }
    if (storageUri.startsWith('file://')) {
      const filePath = storageUri.slice('file://'.length);
      await fs.promises.unlink(filePath).catch(() => undefined);
      return;
    }
  } catch (err) {
    // Best-effort — failure here must not block the rejection path. Log it
    // so ops can sweep orphans later (alarm thresholds belong on the bucket
    // lifecycle policy / fs janitor, not on the request hot path).
    console.warn(`[Assets] safeDeleteAssetObject(${storageUri}) failed: ${(err as Error).message}`);
  }
}

async function maybeHydratePdfMemoryPage(
  asset: AssetRow,
  actorImUserId: string,
  memoryPages: MemoryPageService,
): Promise<MemoryPageSummary[]> {
  const mime = asset.mime ?? '';
  const filename = String(asset.filename ?? asset.metadata ?? '').toLowerCase();
  if (!mime.includes('pdf') && !filename.endsWith('.pdf')) return [];

  const existing = await memoryPages.listPages({
    workspaceId: asset.workspaceId,
    sourceAssetId: asset.id,
    limit: 1,
  });
  if (existing.length > 0) return existing;

  const bytes = await readStoredAssetBytes(asset.storageUri);
  if (!bytes) return [];

  let metadata: Record<string, unknown> = {};
  try {
    metadata = asset.metadata ? JSON.parse(asset.metadata) : {};
  } catch {
    metadata = {};
  }

  const textContent = await textContentForMemoryPage({
    mime: asset.mime,
    kind: asset.kind,
    metadata: { ...metadata, filename: asset.filename ?? metadata.filename ?? '' },
    buffer: bytes,
  });
  if (!textContent) return [];

  const page = await memoryPages.upsertFromAsset({
    workspaceId: asset.workspaceId,
    actorImUserId,
    assetId: asset.id,
    sourceRef: `asset://${asset.id}`,
    sourceKind: 'asset-hook',
    title: assetTitleFromUpload(asset.filename ?? '', metadata, asset.contentHash),
    content: textContent,
    ingestVersion: asset.ingestVersion,
  });

  await prisma.$transaction(async (tx: AssetWriteTx) => {
    const assetIndexSeq = await allocateAssetIndexSeq(tx, asset.workspaceId);
    const updated = await tx.iMAsset.update({
      where: { id: asset.id },
      data: { ingestStatus: 'memory-ready', assetIndexSeq, revision: { increment: 1 } },
    });
    await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, actorImUserId, 'memory-ready');
  });

  return [page];
}

async function maybeCreateImageThumbnailPreviewAsset(input: {
  parent: AssetRow;
  actorImUserId: string;
  bytes: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { parent, actorImUserId, bytes, filename, metadata } = input;
  if (!isRasterImageAsset({ mime: parent.mime, filename })) return;
  if (parent.derivationKind === 'thumbnail') return;
  if (parent.thumbnailUrl || normalizePreviewUrls(parent.previewUrls)?.medium) return;

  const existing = await prisma.iMAsset.findFirst({
    where: {
      workspaceId: parent.workspaceId,
      parentAssetId: parent.id,
      derivationKind: 'thumbnail',
      deletedAt: null,
    },
  });
  if (existing) {
    const endpoint = assetBytesEndpoint(existing.id);
    // release202/13 §3b① — derivative row already exists but the parent was
    // linked before blurHash landed; backfill it from the original bytes.
    const linkBlurHash = parent.blurHash
      ? null
      : await computeThumbHashForImage({ buffer: bytes, mime: parent.mime, filename });
    await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
      const updated = await tx.iMAsset.update({
        where: { id: parent.id },
        data: {
          thumbnailUrl: endpoint,
          previewUrls: { medium: endpoint },
          ...(linkBlurHash ? { blurHash: linkBlurHash } : {}),
          assetIndexSeq,
          revision: { increment: 1 },
        },
      });
      await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, actorImUserId, 'thumbnail-linked');
    });
    return;
  }

  const result = await createImageThumbnailForPreview({ buffer: bytes, mime: parent.mime, filename });
  if (result.status !== 'success' || !result.buffer || !result.contentHash || !result.mime) {
    const reason = result.reason ?? result.status;
    const detail = result.error ? `: ${result.error}` : '';
    console.log(
      `[AssetsAPI] Image thumbnail skipped assetId=${parent.id} status=${result.status} reason=${reason}${detail}`,
    );
    return;
  }

  const thumbnailBuffer = result.buffer;
  const thumbnailHash = result.contentHash;
  const thumbnailMime = result.mime;

  // release202/13 §3b① — filesystem/local parity for the thumbHash placeholder.
  // The S3/Lambda worker computes it and ships it via the derivative callback;
  // this in-process path (filesystem backend has no S3 event) must compute it
  // too, from the SAME original bytes already in memory. Best-effort: null on
  // failure → the client falls back to the existing spinner.
  const blurHash = await computeThumbHashForImage({ buffer: bytes, mime: parent.mime, filename });

  let storageUri: string;
  try {
    storageUri =
      getBackend() === 's3'
        ? await writeS3(thumbnailHash, thumbnailBuffer, thumbnailMime)
        : await writeFilesystem(thumbnailHash, thumbnailBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[AssetsAPI] Image thumbnail storage failed assetId=${parent.id}: ${msg}`);
    return;
  }

  const created = await prisma.$transaction(async (tx: AssetWriteTx) => {
    const derivedSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const derivedCdnUrl = assetCdnUrlForStorageUri(storageUri);
    const derived = await tx.iMAsset.create({
      data: {
        workspaceId: parent.workspaceId,
        ownerImUserId: actorImUserId,
        contentHash: thumbnailHash,
        storageUri,
        sizeBytes: BigInt(thumbnailBuffer.length),
        mime: thumbnailMime,
        kind: 'preview',
        metadata: JSON.stringify({
          ...metadata,
          filename: thumbnailFilename(filename, parent.contentHash),
          previewDerivative: {
            type: 'thumbnail',
            sourceAssetId: parent.id,
            sourceContentHash: parent.contentHash,
            width: result.width,
            height: result.height,
          },
        }),
        parentAssetId: parent.id,
        derivationKind: 'thumbnail',
        ingestStatus: 'asset-only',
        assetIndexSeq: derivedSeq,
        cdnUrl: derivedCdnUrl,
        filename: thumbnailFilename(filename, parent.contentHash),
        sourceRef: `asset://${parent.id}#thumbnail`,
        sourceKind: 'asset-derived',
        sourceMetadata: JSON.stringify({ parentAssetId: parent.id, derivationKind: 'thumbnail' }),
        visibility: parent.visibility,
        aclJson: parent.aclJson,
      },
    });
    const endpoint = publicDerivativeEndpoint({ id: derived.id });
    const parentSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const updated = await tx.iMAsset.update({
      where: { id: parent.id },
      data: {
        thumbnailUrl: endpoint,
        previewUrls: { medium: endpoint },
        ...(blurHash ? { blurHash } : {}),
        assetIndexSeq: parentSeq,
        revision: { increment: 1 },
      },
    });
    await createAssetRevisionSnapshot(tx, derived as unknown as AssetRow, actorImUserId, 'created');
    await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, actorImUserId, 'thumbnail-ready');
    return derived;
  });

  console.log(`[AssetsAPI] Image thumbnail created assetId=${parent.id} thumbnailAssetId=${created.id}`);
}

function pdfThumbnailFilename(filename: string | null | undefined, contentHash: string): string {
  const base = filename?.trim() || contentHash.slice(0, 16);
  const withoutExt = base.replace(/\.pdf$/i, '').replace(/\.[^.]+$/, '');
  return `${withoutExt}.page1.webp`;
}

async function maybeCreatePdfFirstPageThumbnailAsset(input: {
  parent: AssetRow;
  actorImUserId: string;
  bytes: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { parent, actorImUserId, bytes, filename, metadata } = input;
  if (!isPdfAsset({ mime: parent.mime, filename })) return;
  if (parent.derivationKind === 'thumbnail') return;
  if (parent.thumbnailUrl || normalizePreviewUrls(parent.previewUrls)?.medium) return;

  const existing = await prisma.iMAsset.findFirst({
    where: {
      workspaceId: parent.workspaceId,
      parentAssetId: parent.id,
      derivationKind: 'thumbnail',
      deletedAt: null,
    },
  });
  if (existing) {
    const endpoint = publicDerivativeEndpoint({ id: existing.id });
    await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
      const updated = await tx.iMAsset.update({
        where: { id: parent.id },
        data: {
          thumbnailUrl: endpoint,
          previewUrls: { medium: endpoint },
          assetIndexSeq,
          revision: { increment: 1 },
        },
      });
      await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, actorImUserId, 'pdf-thumbnail-linked');
    });
    return;
  }

  const result = await createPdfFirstPageThumbnailForPreview({ buffer: bytes, mime: parent.mime, filename });
  if (result.status !== 'success' || !result.buffer || !result.contentHash || !result.mime) {
    const reason = result.reason ?? result.status;
    const detail = result.error ? `: ${result.error}` : '';
    console.log(
      `[AssetsAPI] PDF thumbnail skipped assetId=${parent.id} status=${result.status} reason=${reason}${detail}`,
    );
    return;
  }

  const thumbnailBuffer = result.buffer;
  const thumbnailHash = result.contentHash;
  const thumbnailMime = result.mime;
  let storageUri: string;
  try {
    storageUri =
      getBackend() === 's3'
        ? await writeS3(thumbnailHash, thumbnailBuffer, thumbnailMime)
        : await writeFilesystem(thumbnailHash, thumbnailBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[AssetsAPI] PDF thumbnail storage failed assetId=${parent.id}: ${msg}`);
    return;
  }

  const created = await prisma.$transaction(async (tx: AssetWriteTx) => {
    const derivedSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const derivedCdnUrl = assetCdnUrlForStorageUri(storageUri);
    const derived = await tx.iMAsset.create({
      data: {
        workspaceId: parent.workspaceId,
        ownerImUserId: actorImUserId,
        contentHash: thumbnailHash,
        storageUri,
        sizeBytes: BigInt(thumbnailBuffer.length),
        mime: thumbnailMime,
        kind: 'preview',
        metadata: JSON.stringify({
          ...metadata,
          filename: pdfThumbnailFilename(filename, parent.contentHash),
          previewDerivative: {
            type: 'pdf-first-page-thumbnail',
            sourceAssetId: parent.id,
            sourceContentHash: parent.contentHash,
            page: result.page ?? 1,
            width: result.width,
            height: result.height,
            tool: result.tool,
            toolVersion: result.toolVersion,
          },
        }),
        parentAssetId: parent.id,
        derivationKind: 'thumbnail',
        ingestStatus: 'asset-only',
        assetIndexSeq: derivedSeq,
        cdnUrl: derivedCdnUrl,
        filename: pdfThumbnailFilename(filename, parent.contentHash),
        sourceRef: `asset://${parent.id}#pdf-page-1-thumbnail`,
        sourceKind: 'asset-derived',
        sourceMetadata: JSON.stringify({ parentAssetId: parent.id, derivationKind: 'thumbnail', page: 1 }),
        visibility: parent.visibility,
        aclJson: parent.aclJson,
      },
    });
    const endpoint = publicDerivativeEndpoint({ id: derived.id });
    const parentSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const updated = await tx.iMAsset.update({
      where: { id: parent.id },
      data: {
        thumbnailUrl: endpoint,
        previewUrls: { medium: endpoint },
        assetIndexSeq: parentSeq,
        revision: { increment: 1 },
      },
    });
    await createAssetRevisionSnapshot(tx, derived as unknown as AssetRow, actorImUserId, 'created');
    await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, actorImUserId, 'pdf-thumbnail-ready');
    return derived;
  });

  console.log(`[AssetsAPI] PDF thumbnail created assetId=${parent.id} thumbnailAssetId=${created.id}`);
}

async function presignS3(storageUri: string): Promise<string> {
  // s3://bucket/key
  const m = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`Invalid s3 URI: ${storageUri}`);
  const [, bucket, key] = m;
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: PRESIGNED_TTL_SECONDS });
}

async function presignAssetS3Put(input: {
  bucket: string;
  key: string;
  mime: string | null;
  sizeBytes: number;
  contentHash: string;
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ContentType: input.mime ?? 'application/octet-stream',
    ContentLength: input.sizeBytes,
    Metadata: { sha256: input.contentHash },
  });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: DIRECT_UPLOAD_TTL_SECONDS });
}

async function computeS3ObjectSha256(bucket: string, key: string, sizeBytes: number): Promise<string> {
  const hash = crypto.createHash('sha256');
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
    const end = Math.min(offset + chunkSize - 1, sizeBytes - 1);
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${offset}-${end}` }),
    );
    const body = res.Body;
    if (!body) throw new Error('S3 object response missing body');
    if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      hash.update(Buffer.from(bytes));
      continue;
    }
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      hash.update(Buffer.from(chunk));
    }
  }
  return hash.digest('hex');
}

async function bridgePhotoMemorySegmentAsset(
  ownerId: string,
  workspaceId: string,
  kind: string,
  metadata: Record<string, unknown>,
  buffer: Buffer,
  fileName?: string,
) {
  if (kind !== PHOTO_MEMORY_SEGMENT_KIND && metadata.kind !== PHOTO_MEMORY_SEGMENT_KIND) return;
  await upsertPhotoMemorySegmentMemoryFile({
    ownerId,
    workspaceId,
    metadata,
    content: buffer.toString('utf8'),
    fileName,
  });
}

async function maybeCreatePdfLinearizedPreviewAsset(input: {
  parent: AssetRow;
  actorImUserId: string;
  bytes: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { parent, actorImUserId, bytes, filename, metadata } = input;
  if (!isPdfAsset({ mime: parent.mime, filename })) return;
  if (parent.previewAssetId) return;

  const existing = await prisma.iMAsset.findFirst({
    where: {
      workspaceId: parent.workspaceId,
      parentAssetId: parent.id,
      derivationKind: 'pdf-linearized',
      deletedAt: null,
    },
  });
  if (existing) {
    await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
      await tx.iMAsset.update({
        where: { id: parent.id },
        data: { previewAssetId: existing.id, assetIndexSeq, revision: { increment: 1 } },
      });
    });
    return;
  }

  const result = await linearizePdfForPreview({ buffer: bytes, mime: parent.mime, filename });
  if (result.status !== 'success' || !result.buffer || !result.contentHash) {
    const reason = result.reason ?? result.status;
    const detail = result.error ? `: ${result.error}` : '';
    console.log(
      `[AssetsAPI] PDF linearize skipped assetId=${parent.id} status=${result.status} reason=${reason}${detail}`,
    );
    return;
  }
  const linearizedBuffer = result.buffer;
  const linearizedHash = result.contentHash;
  if (linearizedHash === parent.contentHash) {
    console.log(`[AssetsAPI] PDF linearize produced identical bytes assetId=${parent.id}`);
    return;
  }

  let storageUri: string;
  try {
    storageUri =
      getBackend() === 's3'
        ? await writeS3(linearizedHash, linearizedBuffer, 'application/pdf')
        : await writeFilesystem(linearizedHash, linearizedBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[AssetsAPI] PDF linearize storage failed assetId=${parent.id}: ${msg}`);
    return;
  }

  const linearizedFilename = filename.replace(/\.pdf$/i, '.linearized.pdf');
  const derivedMetadata = {
    ...metadata,
    filename: linearizedFilename,
    previewDerivative: {
      type: 'pdf-linearized',
      sourceAssetId: parent.id,
      sourceContentHash: parent.contentHash,
      tool: result.tool,
      toolVersion: result.toolVersion,
    },
  };

  const created = await prisma.$transaction(async (tx: AssetWriteTx) => {
    const derivedSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    const derived = await tx.iMAsset.create({
      data: {
        workspaceId: parent.workspaceId,
        ownerImUserId: actorImUserId,
        contentHash: linearizedHash,
        storageUri,
        sizeBytes: BigInt(linearizedBuffer.length),
        mime: 'application/pdf',
        kind: 'preview',
        metadata: JSON.stringify(derivedMetadata),
        parentAssetId: parent.id,
        derivationKind: 'pdf-linearized',
        ingestStatus: 'asset-only',
        assetIndexSeq: derivedSeq,
        filename: linearizedFilename,
        sourceRef: `asset://${parent.id}#pdf-linearized`,
        sourceKind: 'asset-derived',
        sourceMetadata: JSON.stringify({ parentAssetId: parent.id, derivationKind: 'pdf-linearized' }),
        visibility: parent.visibility,
        aclJson: parent.aclJson,
      },
    });
    const parentSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
    await tx.iMAsset.update({
      where: { id: parent.id },
      data: { previewAssetId: derived.id, assetIndexSeq: parentSeq, revision: { increment: 1 } },
    });
    return derived;
  });

  console.log(`[AssetsAPI] PDF linearized assetId=${parent.id} previewAssetId=${created.id}`);
}

/**
 * Shared, best-effort THUMBNAIL trigger for an already-persisted asset row.
 *
 * Generalizes the inline trigger that previously only ran on the upload routes
 * (POST /assets multipart fresh + dedup, POST /assets/direct-upload/complete).
 * Any path that creates an im_assets row WITHOUT going through those routes —
 * notably the message file-attach path (MessageService.deriveFileMessageAttachment,
 * deliveryPath:'cli-send') — can call this so agent-delivered PDFs / images get
 * an inline thumbnail too.
 *
 * Behaviour:
 *  - Loads the asset row by id; no-ops if it's missing/deleted or already has a
 *    thumbnail.
 *  - For raster image/* (svg excluded by isRasterImageAsset) and application/pdf
 *    (first page), renders a small thumbnail via the LOCAL tooling
 *    (createImageThumbnailForPreview / detectPdfThumbnailTool→pdftoppm|mutool +
 *    sharp) — works in dev with NO Lambda / NO S3.
 *  - Reuses the existing maybeCreate*ThumbnailAsset write path: it populates the
 *    derived row + sets parent.thumbnailUrl + previewUrls.medium and bumps
 *    revision / assetIndexSeq.
 *  - Emits a workspace-targeted asset.changed (owner + all members) so the
 *    human's chat card can refresh reactively.
 *
 * Fully best-effort: every failure is swallowed + logged. Callers should invoke
 * it fire-and-forget so it NEVER blocks the message send / upload response.
 */
export async function generateThumbnailDerivativesForAsset(input: {
  assetId: string;
  rooms?: RoomManager;
  syncService?: SyncService;
  /** Override the WS recipient owner; defaults to the asset row's ownerImUserId. */
  actorImUserId?: string;
}): Promise<void> {
  try {
    const row = (await prisma.iMAsset.findFirst({
      where: { id: input.assetId, deletedAt: null },
    })) as unknown as AssetRow | null;
    if (!row) return;

    // Only image/* (raster) + application/pdf are thumbnailable. Cheap gate so
    // we don't read bytes for non-thumbnailable mimes.
    const filename = row.filename ?? '';
    const isThumbnailable =
      isRasterImageAsset({ mime: row.mime, filename }) || isPdfAsset({ mime: row.mime, filename });
    if (!isThumbnailable) return;

    // Already has a thumbnail → nothing to do (both helpers also guard on this,
    // but short-circuit before the byte read).
    if (row.thumbnailUrl || normalizePreviewUrls(row.previewUrls)?.medium) return;

    // Guard on size — mirror the upload-route threshold so we never pull a huge
    // blob into memory just for a thumbnail.
    const sizeBytes = row.sizeBytes != null ? Number(row.sizeBytes) : 0;
    if (sizeBytes > S3_MULTIPART_THRESHOLD_BYTES) {
      console.log(`[AssetsAPI] thumbnail derivative skipped assetId=${row.id} reason=too_large size=${sizeBytes}`);
      return;
    }

    const bytes = await readStoredAssetBytes(row.storageUri);
    if (!bytes) {
      console.log(`[AssetsAPI] thumbnail derivative skipped assetId=${row.id} reason=bytes_unavailable`);
      return;
    }

    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }

    const actorImUserId = input.actorImUserId ?? row.ownerImUserId;

    // PDF first-page + raster-image thumbnail share the same write path. Each is
    // a no-op for the wrong mime.
    await maybeCreatePdfFirstPageThumbnailAsset({ parent: row, actorImUserId, bytes, filename, metadata });
    await maybeCreateImageThumbnailPreviewAsset({ parent: row, actorImUserId, bytes, filename, metadata });

    const updated = (await prisma.iMAsset.findUnique({ where: { id: row.id } })) as unknown as AssetRow | null;
    if (!updated) return;

    // Only emit when a thumbnail was actually produced (avoid a no-op refresh).
    if (!updated.thumbnailUrl && !normalizePreviewUrls(updated.previewUrls)?.medium) return;

    await publishAssetChanged({
      rooms: input.rooms,
      syncService: input.syncService,
      ownerImUserId: actorImUserId,
      row: updated,
      operation: 'update',
    });
  } catch (err) {
    console.error('[AssetsAPI] generateThumbnailDerivativesForAsset failed', {
      assetId: input.assetId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createAssetsRouter(rooms?: RoomManager, syncService?: SyncService, taskService?: TaskDigestReemitter) {
  const router = new Hono();
  const memoryPages = new MemoryPageService();

  // POST /assets/internal/derivatives/complete — protected worker/Lambda callback.
  router.post('/internal/derivatives/complete', async (c) => {
    if (
      !hasValidInternalDerivativeSecret(
        c.req.header('x-prismer-internal-secret') || c.req.header('x-internal-secret') || c.req.header('authorization'),
      )
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: { code: 'asset_derivative_callback_unauthorized', message: 'Unauthorized derivative callback' },
        },
        401,
      );
    }

    let body: AssetDerivativeCallbackBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }

    try {
      const result = await completeAssetDerivativeCallback({ body, rooms, syncService });
      if (result.response.ok) c.header('X-Asset-Sync', '1');
      return c.json(result.response, result.status as never);
    } catch (err) {
      return c.json<ApiResponse>(
        { ok: false, error: err instanceof Error ? err.message : 'asset derivative callback failed' },
        400,
      );
    }
  });

  // GET /assets/:id/avatar — PUBLIC, no-auth image byte server for avatars.
  //
  // Registered BEFORE `router.use('*', authMiddleware)` below, so the auth
  // middleware (which only applies to routes registered AFTER it in Hono)
  // does NOT gate this route — same public-route pattern as
  // `POST /internal/derivatives/complete` above (which self-authenticates via
  // an internal secret). This route needs to be browser-fetchable WITHOUT an
  // Authorization header because `im_users.avatarUrl` is rendered through a
  // bare `<img src=...>`.
  //
  // SECURITY (strict — this is unauthenticated, so it is a deliberately narrow
  // hole): only serve when the asset is a small image. We refuse (404) any
  // non-`image/*` mime or any asset larger than the cap, and never leak
  // metadata — only the raw bytes (or a 302 to a presigned image URL for S3).
  // No directory listing, no workspace/ACL info, no derivative traversal.
  const PUBLIC_AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  router.get('/:id/avatar', async (c) => {
    const id = c.req.param('id');
    const row = (await prisma.iMAsset.findUnique({ where: { id } })) as unknown as AssetRow | null;
    // Uniform 404 for every reject reason (missing / deleted / non-image /
    // too-large) so this endpoint never confirms existence of a non-image or
    // oversized asset to an unauthenticated caller.
    if (!row || row.deletedAt) {
      return new Response(null, { status: 404 });
    }
    const mime = row.mime ?? '';
    if (!mime.toLowerCase().startsWith('image/')) {
      return new Response(null, { status: 404 });
    }
    const size = row.sizeBytes != null ? Number(row.sizeBytes) : null;
    if (size == null || size > PUBLIC_AVATAR_MAX_BYTES) {
      return new Response(null, { status: 404 });
    }
    // Scope the public hole to assets EXPLICITLY uploaded as a profile avatar
    // (the Settings upload tags `metadata.source='settings_profile_avatar'`).
    // A private workspace image — even a small one — is never exposed by id
    // unless it was intentionally uploaded as a public avatar.
    const meta = parseObject(row.metadata) ?? {};
    if (meta.source !== 'settings_profile_avatar') {
      return new Response(null, { status: 404 });
    }

    const etag = assetHttpEtag(row);
    const publicCache = 'public, max-age=86400, immutable';
    if (requestHasFreshEtag(c.req.header('if-none-match') ?? c.req.header('If-None-Match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': publicCache } });
    }

    if (row.storageUri.startsWith('file://')) {
      // No Range — avatars are tiny; stream the whole file with public cache.
      const resp = await streamFilesystem(row.storageUri, row.mime, size, null, etag);
      // Bytes missing on disk → uniform 404 (don't surface the internal 410).
      if (resp.status !== 200) {
        return new Response(null, { status: 404 });
      }
      // streamFilesystem stamps a `private` Cache-Control; override to public.
      const headers = new Headers(resp.headers);
      headers.set('Cache-Control', publicCache);
      return new Response(resp.body, { status: resp.status, headers });
    }
    if (row.storageUri.startsWith('s3://')) {
      try {
        const url = await presignS3(row.storageUri);
        return new Response(null, {
          status: 302,
          headers: { Location: url, ETag: etag, 'Cache-Control': publicCache },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return new Response(null, { status: 404 });
  });

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- mounted at /assets in routes.ts; wildcard scoped to that prefix
  router.use('*', async (c, next) => {
    // Public avatar bytes route (`GET /assets/:id/avatar`) must be reachable by
    // a bare `<img src>` with NO Authorization header. Registering that route
    // BEFORE this middleware does NOT exempt it in this Hono setup — the
    // wildcard auth still runs and 401s the no-token <img> request — so we
    // exempt it EXPLICITLY here. The handler itself enforces a strict gate
    // (image mime + ≤2MB + metadata.source==='settings_profile_avatar'), so
    // skipping auth here does not widen any other asset operation.
    if (c.req.method === 'GET' && /\/[^/]+\/avatar$/.test(c.req.path)) {
      return next();
    }
    return authMiddleware(c, next);
  });

  // GET /assets/index?workspaceId=...&since=...
  router.get('/index', async (c) => {
    const user = c.get('user');
    const wsId = c.req.query('workspaceId');
    if (!wsId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId query param is required' }, 400);

    const ws = await loadWorkspaceForAssetAccess(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const sinceRaw = c.req.query('since');
    const since = sinceRaw ? BigInt(Math.max(parseInt(sinceRaw, 10) || 0, 0)) : BigInt(0);
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '200', 10) || 200, 1), 500);

    const rows = await prisma.iMAsset.findMany({
      where: { workspaceId: wsId, assetIndexSeq: { gt: since } },
      orderBy: { assetIndexSeq: 'asc' },
      take: limit,
    });
    const items = await enrichAssetDTOs(rows as unknown as AssetRow[]);
    const cursor = items.length > 0 ? items[items.length - 1].assetIndexSeq : Number(since);
    return c.json<ApiResponse<{ items: AssetDTO[]; cursor: number }>>({ ok: true, data: { items, cursor } });
  });

  // GET /assets?workspaceId=...&taskId=...&kind=...&folderPath=...&folderPathPrefix=...&limit=...
  router.get('/', async (c) => {
    const user = c.get('user');
    const wsId = c.req.query('workspaceId');
    if (!wsId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId query param is required' }, 400);

    const ws = await loadWorkspaceForAssetAccess(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const q = c.req.query('q');
    const taskId = c.req.query('taskId');
    const kind = c.req.query('kind');
    const limitRaw = c.req.query('limit');
    const defaultLimit = q ? 8 : 50;
    const maxLimit = q ? 20 : 200;
    const limit = Math.min(Math.max(parseInt(limitRaw ?? String(defaultLimit), 10) || defaultLimit, 1), maxLimit);

    // Wave-9 Phase 2.3: folderPath filtering.
    //   ?folderPath=/tasks/abc          → exact match (single folder)
    //   ?folderPath=__root__            → folderPath IS NULL (root listing)
    //   ?folderPathPrefix=/tasks/       → starts-with (folder + descendants)
    // The two are mutually exclusive; folderPath wins if both supplied.
    const folderPath = c.req.query('folderPath');
    const folderPathPrefix = c.req.query('folderPathPrefix');
    let folderClause: Record<string, unknown> | null = null;
    if (folderPath !== undefined) {
      folderClause = folderPath === '__root__' ? { folderPath: null } : { folderPath };
    } else if (folderPathPrefix !== undefined) {
      folderClause = { folderPath: { startsWith: folderPathPrefix } };
    }

    if (q && q.trim()) {
      // Autocomplete mode — lightweight response, no S3 enrichment
      const pattern = q.trim().replace(/[%_]/g, '\\$&');
      const rows = await prisma.iMAsset.findMany({
        where: {
          workspaceId: wsId,
          deletedAt: null,
          // Hide internal profile-avatar assets from the library (see main query).
          NOT: { metadata: { contains: 'settings_profile_avatar' } },
          OR: [{ filename: { contains: pattern } }, { description: { contains: pattern } }],
          ...(kind ? { kind } : {}),
          ...(folderClause ?? {}),
        },
        select: {
          id: true,
          contentHash: true,
          filename: true,
          folderPath: true,
          mime: true,
          kind: true,
          sizeBytes: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      const data = rows.map((row: (typeof rows)[number]) => ({
        ...row,
        sizeBytes: Number(row.sizeBytes ?? BigInt(0)),
      }));
      return c.json<ApiResponse<typeof data>>({ ok: true, data });
    }

    const taskSourceIds = taskId ? await resolveAssetSourceTaskIds(taskId, wsId) : [];
    const rows = await prisma.iMAsset.findMany({
      where: {
        workspaceId: wsId,
        deletedAt: null,
        // Profile avatars are uploaded through the asset pipeline but are
        // internal (rendered via the public /avatar route), not workspace
        // deliverables — keep them out of the asset library list.
        NOT: { metadata: { contains: 'settings_profile_avatar' } },
        ...(taskSourceIds.length > 0 ? { sourceTaskId: { in: taskSourceIds } } : {}),
        ...(kind ? { kind } : {}),
        ...(folderClause ?? {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return c.json<ApiResponse<AssetDTO[]>>({
      ok: true,
      data: await enrichAssetDTOs(rows as unknown as AssetRow[]),
    });
  });

  /**
   * GET /assets/folders?workspaceId=... — folder aggregate.
   *
   * Returns `[{ folderPath, assetCount }]` ordered by folderPath asc with
   * `null` (root) coalesced to `__root__` so the client can key by string.
   * This is the data the upcoming Phase 3 library tree drives off — listing
   * every distinct folderPath in the workspace plus the asset count per
   * folder so the UI can render counts next to folder names.
   */
  router.get('/folders', async (c) => {
    const user = c.get('user');
    const wsId = c.req.query('workspaceId');
    if (!wsId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId query param is required' }, 400);

    const ws = await loadWorkspaceForAssetAccess(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const grouped = await prisma.iMAsset.groupBy({
      by: ['folderPath'],
      where: { workspaceId: wsId, deletedAt: null },
      _count: { _all: true },
    });
    type FolderRow = { folderPath: string | null; _count: { _all: number } };
    const folders = (grouped as FolderRow[])
      .map((row) => ({
        folderPath: row.folderPath ?? '__root__',
        assetCount: row._count._all,
      }))
      .sort((a, b) => a.folderPath.localeCompare(b.folderPath));

    return c.json<ApiResponse<Array<{ folderPath: string; assetCount: number }>>>({
      ok: true,
      data: folders,
    });
  });

  /**
   * GET /assets/manifest?workspaceId=... — markdown asset manifest.
   *
   * Doc 27 rev 5 §3 / §6: light-weight indexer. Returns a markdown view of
   * every (non-deleted) asset in the workspace, grouped by folderPath then
   * by mime, with metadata (filename / mime / size / description /
   * createdAt) but **no content** and **no HQCC**. The agent reads this
   * to know what files exist; if it actually wants the content it follows
   * the prismer:// URI to fetch / open.
   *
   * Acceptance: doc 27 §7 MA-S1 (50 burst → 50 manifest entries; 0 memory
   * pages; 0 session token spend by daemon).
   */
  router.get('/manifest', async (c) => {
    const user = c.get('user');
    const wsId = c.req.query('workspaceId');
    if (!wsId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId query param is required' }, 400);

    const ws = await loadWorkspaceForAssetAccess(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const rows = (await prisma.iMAsset.findMany({
      where: { workspaceId: wsId, deletedAt: null },
      orderBy: [{ folderPath: 'asc' }, { mime: 'asc' }, { createdAt: 'desc' }],
    })) as Array<{
      filename: string | null;
      folderPath: string | null;
      mime: string | null;
      sizeBytes: bigint | null;
      contentHash: string;
      createdAt: Date;
      // description is added by Line B Phase 1; tolerate its absence.
      description?: string | null;
    }>;

    const markdown = renderAssetManifestMarkdown(wsId, rows);
    return c.json<ApiResponse<{ workspaceId: string; assetCount: number; markdown: string }>>({
      ok: true,
      data: { workspaceId: wsId, assetCount: rows.length, markdown },
    });
  });

  // POST /assets/direct-upload/init — direct-to-S3 upload plan for large assets.
  router.post('/direct-upload/init', async (c) => {
    const user = c.get('user');
    let body: {
      workspaceId?: unknown;
      filename?: unknown;
      mime?: unknown;
      sizeBytes?: unknown;
      contentHash?: unknown;
      multipart?: unknown;
      partSizeBytes?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }

    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : 'asset.bin';
    const mime = typeof body.mime === 'string' && body.mime.trim() ? body.mime.trim() : 'application/octet-stream';
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : Number(body.sizeBytes);
    const contentHash =
      typeof body.contentHash === 'string'
        ? body.contentHash
            .trim()
            .toLowerCase()
            .replace(/^sha256[:=]/, '')
        : '';
    if (!workspaceId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId is required' }, 400);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return c.json<ApiResponse>({ ok: false, error: 'sizeBytes must be a positive number' }, 400);
    }
    if (sizeBytes > MAX_ASSET_BYTES) return c.json<ApiResponse>(assetTooLargeResponse(sizeBytes), 413);
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      return c.json<ApiResponse>({ ok: false, error: 'contentHash must be a 64-character SHA-256 hex digest' }, 400);
    }

    const ws = await loadWorkspaceForAssetAccess(workspaceId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    if (!isS3Available()) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'asset_direct_upload_unavailable',
            message:
              'Direct asset upload requires S3 credentials; use multipart POST /assets in local filesystem mode.',
          },
        },
        503,
      );
    }

    const bucket = getBucket();
    const key = assetS3KeyForContentHash(contentHash);
    const storageUri = `s3://${bucket}/${key}`;
    const cdnUrl = assetCdnUrlForS3Key(key);
    const expiresAt = new Date(Date.now() + DIRECT_UPLOAD_TTL_SECONDS * 1000).toISOString();
    const shouldMultipart = body.multipart === true || sizeBytes > S3_MULTIPART_THRESHOLD_BYTES;
    if (!shouldMultipart) {
      const uploadUrl = await presignAssetS3Put({ bucket, key, mime, sizeBytes, contentHash });
      return c.json<ApiResponse>({
        ok: true,
        data: {
          mode: 'single',
          workspaceId,
          filename,
          bucket,
          key,
          storageUri,
          cdnUrl,
          contentHash,
          sizeBytes,
          mime,
          uploadUrl,
          method: 'PUT',
          // 2026-05-20 — Removed `x-amz-meta-sha256` from client headers.
          // The presigner already encodes it as a URL query param
          // (`?x-amz-meta-sha256=<hash>` — see presignAssetS3Put which
          // passes `Metadata: { sha256: contentHash }` to PutObjectCommand).
          // Sending it again as a request header at PUT time is observed
          // (2026-05-19 test env, Word .docx upload) to produce 403 Forbidden
          // on `pro-prismer-slide`: S3's V4 sig validator sees a metadata
          // value via header AND via URL query and treats the combination as
          // inconsistent. Single-source: keep it in the URL only. Browser
          // does NOT need to send it as a header — S3 attaches it to the
          // resulting object based on the URL alone. Content-Type is
          // separately required because PutObjectCommand was signed with a
          // ContentType field; the browser PUT must echo it back so S3
          // stores the correct MIME on the object.
          headers: { 'Content-Type': mime ?? 'application/octet-stream' },
          expiresAt,
          expiresIn: DIRECT_UPLOAD_TTL_SECONDS,
        },
      });
    }

    const requestedPartSize =
      typeof body.partSizeBytes === 'number' && body.partSizeBytes > 0
        ? body.partSizeBytes
        : S3_MULTIPART_PART_SIZE_BYTES;
    const partSizeBytes = Math.max(requestedPartSize, 5 * 1024 * 1024);
    const partCount = Math.ceil(sizeBytes / partSizeBytes);
    if (partCount > 10_000) {
      return c.json<ApiResponse>({ ok: false, error: 'Direct upload would exceed S3 multipart part limit' }, 400);
    }
    const created = await getS3Client().send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: mime,
        Metadata: { sha256: contentHash, workspaceId },
      }),
    );
    if (!created.UploadId) {
      return c.json<ApiResponse>({ ok: false, error: 'S3 multipart upload did not return an uploadId' }, 503);
    }
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, idx) => {
        const partNumber = idx + 1;
        const url = await getSignedUrl(
          getS3Client(),
          new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId, PartNumber: partNumber }),
          { expiresIn: DIRECT_UPLOAD_TTL_SECONDS },
        );
        return { partNumber, url };
      }),
    );
    return c.json<ApiResponse>({
      ok: true,
      data: {
        mode: 'multipart',
        workspaceId,
        filename,
        bucket,
        key,
        storageUri,
        cdnUrl,
        contentHash,
        sizeBytes,
        mime,
        uploadId: created.UploadId,
        partSizeBytes,
        partCount,
        parts,
        expiresAt,
        expiresIn: DIRECT_UPLOAD_TTL_SECONDS,
      },
    });
  });

  // POST /assets/direct-upload/complete — validate direct-to-S3 bytes and create IMAsset.
  router.post('/direct-upload/complete', async (c) => {
    const user = c.get('user');
    let body: {
      workspaceId?: unknown;
      filename?: unknown;
      mime?: unknown;
      sizeBytes?: unknown;
      contentHash?: unknown;
      kind?: unknown;
      metadata?: unknown;
      folderPath?: unknown;
      description?: unknown;
      sourceTaskId?: unknown;
      sourceAgentImUserId?: unknown;
      sourceRef?: unknown;
      sourceKind?: unknown;
      bucket?: unknown;
      key?: unknown;
      uploadId?: unknown;
      parts?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }

    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : 'asset.bin';
    let mime = typeof body.mime === 'string' && body.mime.trim() ? body.mime.trim() : null;
    const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'file';
    const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : Number(body.sizeBytes);
    const contentHash =
      typeof body.contentHash === 'string'
        ? body.contentHash
            .trim()
            .toLowerCase()
            .replace(/^sha256[:=]/, '')
        : '';
    if (!workspaceId) return c.json<ApiResponse>({ ok: false, error: 'workspaceId is required' }, 400);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return c.json<ApiResponse>({ ok: false, error: 'sizeBytes must be a positive number' }, 400);
    }
    if (sizeBytes > MAX_ASSET_BYTES) return c.json<ApiResponse>(assetTooLargeResponse(sizeBytes), 413);
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      return c.json<ApiResponse>({ ok: false, error: 'contentHash must be a 64-character SHA-256 hex digest' }, 400);
    }
    if (!isS3Available()) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'asset_direct_upload_unavailable',
            message: 'Direct asset upload requires S3 credentials.',
          },
        },
        503,
      );
    }

    const ws = await loadWorkspaceForAssetAccess(workspaceId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);
    const bucket = typeof body.bucket === 'string' && body.bucket ? body.bucket : getBucket();
    const key = typeof body.key === 'string' && body.key ? body.key : assetS3KeyForContentHash(contentHash);
    const expectedKey = assetS3KeyForContentHash(contentHash);
    if (bucket !== getBucket() || key !== expectedKey) {
      return c.json<ApiResponse>({ ok: false, error: 'bucket/key must match the declared contentHash' }, 400);
    }

    if (typeof body.uploadId === 'string' && body.uploadId) {
      const rawParts = Array.isArray(body.parts) ? body.parts : [];
      if (rawParts.length === 0) return c.json<ApiResponse>({ ok: false, error: 'parts are required' }, 400);
      const parts = rawParts.map((part) => {
        const item = part as Record<string, unknown>;
        return { PartNumber: Number(item.partNumber), ETag: String(item.etag ?? item.ETag ?? '') };
      });
      if (parts.some((part) => !Number.isInteger(part.PartNumber) || part.PartNumber <= 0 || !part.ETag)) {
        return c.json<ApiResponse>({ ok: false, error: 'Each part must include partNumber and etag' }, 400);
      }
      await getS3Client().send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: body.uploadId,
          MultipartUpload: { Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber) },
        }),
      );
    }

    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const actualSize = Number(head.ContentLength ?? 0);
    if (actualSize !== sizeBytes) {
      return c.json<ApiResponse>({ ok: false, error: 'Uploaded object size does not match declared sizeBytes' }, 422);
    }
    const actualHash = await computeS3ObjectSha256(bucket, key, sizeBytes);
    if (actualHash !== contentHash) {
      return c.json<ApiResponse>(uploadHashMismatchResponse(contentHash, actualHash, sizeBytes), 422);
    }

    let metadata: Record<string, unknown> = {};
    if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
      metadata = body.metadata as Record<string, unknown>;
    } else if (typeof body.metadata === 'string' && body.metadata) {
      try {
        metadata = JSON.parse(body.metadata);
      } catch {
        return c.json<ApiResponse>({ ok: false, error: 'metadata must be valid JSON' }, 400);
      }
    }

    const sourceAgentImUserId =
      typeof body.sourceAgentImUserId === 'string' && body.sourceAgentImUserId ? body.sourceAgentImUserId : null;
    const isAgentProducedAsset =
      kind === 'agent-output' ||
      kind === 'sandbox-output' ||
      sourceAgentImUserId != null ||
      metadata.sourceKind === 'agent-gen' ||
      metadata.sourceAgentImUserId != null;
    if (isAgentProducedAsset) {
      const policy = validateAgentOutputAsset({ filename, mime, sizeBytes });
      if (!policy.ok) {
        return c.json<ApiResponse>(
          { ok: false, error: { code: 'agent_output_asset_rejected', message: policy.reason } },
          422,
        );
      }
      mime = policy.mime;
    }

    // 2026-05-22 — magic-bytes content vs declared-mime cross-check on the
    // direct-upload path. The bytes already live on S3 by this point; we
    // do a 4 KiB Range read so the sniff doesn't pull the whole object.
    // Symmetric with the multipart POST handler — see that branch for the
    // rationale (agent .pdf-but-actually-md fraud, evidence/v20-acceptance/10).
    {
      const headStorageUri = `s3://${bucket}/${key}`;
      const head = await readStoredAssetHead(headStorageUri, 4096);
      if (head) {
        const detection = detectMagicBytes(head);
        const reason = mimeMismatchReason(detection, mime);
        if (reason) {
          // 2026-05-22 (F2A) — direct-upload bytes are already in S3 by the
          // time we run the magic-bytes sniff (client PUT-uploaded straight
          // to the presigned URL). Reject without deleting would leave an
          // orphan that every retry compounds, so best-effort sweep before
          // returning the 400.
          await safeDeleteAssetObject(headStorageUri);
          return c.json<ApiResponse>(
            {
              ok: false,
              error: {
                code: 'MIME_MISMATCH',
                message: `MIME_MISMATCH: ${reason}. Filename: ${filename}.`,
              },
            },
            400,
          );
        }
      }
    }

    const storageUri = `s3://${bucket}/${key}`;
    const cdnUrl = assetCdnUrlForS3Key(key);
    const title = assetTitleFromUpload(filename, metadata, contentHash);
    const sourceRef =
      typeof body.sourceRef === 'string' && body.sourceRef
        ? body.sourceRef
        : typeof metadata.sourceRef === 'string' && metadata.sourceRef
          ? metadata.sourceRef
          : `upload://${workspaceId}/${contentHash}`;
    const sourceKind =
      typeof body.sourceKind === 'string' && body.sourceKind
        ? body.sourceKind
        : typeof metadata.sourceKind === 'string' && metadata.sourceKind
          ? metadata.sourceKind
          : 'direct-upload';
    const folderPathInput =
      typeof body.folderPath === 'string' ? (body.folderPath.trim() ? body.folderPath.trim() : null) : undefined;
    const descriptionInput =
      typeof body.description === 'string'
        ? body.description.trim()
          ? body.description.trim().slice(0, 500)
          : null
        : undefined;
    const sourceTaskId =
      typeof body.sourceTaskId === 'string' && body.sourceTaskId
        ? body.sourceTaskId
        : typeof metadata.taskId === 'string' && metadata.taskId
          ? metadata.taskId
          : null;

    const existing = await prisma.iMAsset.findFirst({ where: { workspaceId, contentHash, deletedAt: null } });
    if (existing) {
      await ensureAssetRevisionSnapshot(existing as unknown as AssetRow, user.imUserId);
      await publishAssetChanged({
        rooms,
        syncService,
        ownerImUserId: ws.ownerImUserId,
        row: existing as unknown as AssetRow,
        operation: 'update',
      });
      // release202/09 P5#2 — symmetry with the multipart dedup path (~3435).
      // direct-upload/complete is the daemon's PRIMARY upload path (the
      // `cloud task attach` proxy lands here), so without this rollup a
      // task-bound deliverable sets the `sourceTaskId` column but never
      // appends to `metadata.outputAssetIds` / re-emits the terminal digest —
      // and the kanban card derives its deliverable list from outputAssetIds
      // (task.service.ts reemitTerminalDigestForAssetArrival), so the product
      // would silently miss the card. Best-effort, idempotent.
      if (sourceTaskId) {
        await rollupAndReemitDigest(sourceTaskId, existing.id, taskService, 'dedup');
      }
      c.header('X-Asset-Sync', '1');
      return c.json<ApiResponse<AssetDTO>>({
        ok: true,
        data: toDTO(existing as unknown as AssetRow),
        meta: { dedup: true },
      });
    }

    const inlineBytes = sizeBytes <= MAX_TEXT_INLINE_PREVIEW_BYTES ? await readStoredAssetBytes(storageUri) : null;
    const textContent = inlineBytes
      ? await textContentForMemoryPage({
          mime,
          kind,
          metadata: { ...metadata, filename },
          buffer: inlineBytes,
        })
      : null;

    let created = await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
      const asset = await tx.iMAsset.create({
        data: {
          workspaceId,
          ownerImUserId: user.imUserId,
          contentHash,
          storageUri,
          sizeBytes: BigInt(sizeBytes),
          mime,
          kind,
          sourceAgentImUserId,
          sourceTaskId,
          metadata: JSON.stringify({ ...metadata, filename, directUpload: true }),
          assetIndexSeq,
          cdnUrl,
          filename,
          sourceRef,
          sourceKind,
          sourceMetadata: JSON.stringify(metadata),
          ingestStatus: textContent ? 'indexed' : 'asset-only',
          ...(folderPathInput !== undefined ? { folderPath: folderPathInput } : {}),
          ...(descriptionInput !== undefined ? { description: descriptionInput } : {}),
        },
      });
      await createAssetRevisionSnapshot(tx, asset as unknown as AssetRow, user.imUserId, 'created-direct-upload');
      return asset;
    });

    let linkedPages: MemoryPageSummary[] = [];
    if (textContent) {
      const page = await memoryPages.upsertFromAsset({
        workspaceId,
        actorImUserId: user.imUserId,
        assetId: created.id,
        sourceRef: `asset://${created.id}`,
        sourceKind: 'asset-hook',
        title,
        content: textContent,
        ingestVersion: created.ingestVersion,
      });
      linkedPages = [page];
      await prisma.$transaction(async (tx: AssetWriteTx) => {
        const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
        created = await tx.iMAsset.update({
          where: { id: created.id },
          data: { ingestStatus: 'memory-ready', assetIndexSeq, revision: { increment: 1 } },
        });
        await createAssetRevisionSnapshot(tx, created as unknown as AssetRow, user.imUserId, 'memory-ready');
      });
    }

    const bytesForDerivatives =
      actualSize <= S3_MULTIPART_THRESHOLD_BYTES ? await readStoredAssetBytes(storageUri) : null;
    if (bytesForDerivatives) {
      await maybeCreatePdfLinearizedPreviewAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: bytesForDerivatives,
        filename,
        metadata,
      });
      await maybeCreatePdfFirstPageThumbnailAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: bytesForDerivatives,
        filename,
        metadata,
      });
      await maybeCreateImageThumbnailPreviewAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: bytesForDerivatives,
        filename,
        metadata,
      });
      created = (await prisma.iMAsset.findUnique({ where: { id: created.id } })) ?? created;
    }

    await publishAssetChanged({
      rooms,
      syncService,
      ownerImUserId: ws.ownerImUserId,
      row: created as unknown as AssetRow,
      operation: 'create',
    });
    // release202/09 P5#2 — symmetry with the multipart fresh path (~3581).
    // The daemon's `cloud task attach` proxy uploads via direct-upload, so a
    // task-bound deliverable must append to the task's outputAssetIds + re-emit
    // the terminal digest here too, else it sets the sourceTaskId column but
    // never surfaces on the kanban card. Best-effort, idempotent.
    if (sourceTaskId) {
      await rollupAndReemitDigest(sourceTaskId, created.id, taskService, 'fresh');
    }
    c.header('X-Asset-Sync', '1');
    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: toDTO(created as unknown as AssetRow, linkedPages) }, 201);
  });

  // POST /assets — multipart upload.
  //
  // Origin Adapter SPI realization (doc 26 §4 Phase 2): this route is the
  // cloud-side `'upload'` kind. The daemon-side declaration lives at
  // `sdk/prismer-cloud/runtime/src/daemon/asset/origin/web-upload.ts`
  // (WebUploadAdapter — marker only; observe/identify/fetch happen here,
  // not in the daemon). drop-folder and agent-gen are the other two
  // OriginAdapter kinds; both run inside the daemon and produce uploads
  // that ultimately call this same handler over HTTP.
  router.post('/', async (c) => {
    try {
      const user = c.get('user');

      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json<ApiResponse>({ ok: false, error: 'Expected multipart/form-data' }, 400);
      }

      const workspaceId = form.get('workspaceId');
      const fileEntry = form.get('file');
      const kindRaw = form.get('kind');
      const sourceAgentImUserId = form.get('sourceAgentImUserId');
      const sourceTaskId = form.get('sourceTaskId');
      const metadataRaw = form.get('metadata');
      let expectedContentHash: string | null;
      try {
        expectedContentHash = readExpectedUploadSha256(
          c.req.header('x-content-sha256'),
          form.get('contentSha256') ?? form.get('sha256'),
        );
      } catch (err) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: {
              code: 'invalid_upload_hash',
              message: err instanceof Error ? err.message : 'Invalid upload SHA-256 digest',
            },
          },
          400,
        );
      }
      // Wave-9 Phase 2.1: POST accepts folderPath as a form field. Mirrors the
      // PATCH validation contract (string or null, trimmed). The watcher and
      // any other producer can now park new assets directly under
      // `/tasks/{taskId}` / `/sandbox/{taskId}` etc. without a follow-up PATCH.
      const folderPathRaw = form.get('folderPath');
      let folderPathInput: string | null | undefined = undefined;
      if (folderPathRaw !== null) {
        if (typeof folderPathRaw !== 'string') {
          return c.json<ApiResponse>({ ok: false, error: 'folderPath must be a string' }, 400);
        }
        const trimmed = folderPathRaw.trim();
        // Empty string ⇒ explicit "root" (NULL). Stays consistent with PATCH.
        folderPathInput = trimmed.length > 0 ? trimmed : null;
      }

      // Wave-54 B2: description is a 500-char hint surfaced to other agents.
      // Empty/whitespace input collapses to NULL — mirrors folderPath above.
      const descriptionRaw = form.get('description');
      let descriptionInput: string | null | undefined = undefined;
      if (descriptionRaw !== null) {
        if (typeof descriptionRaw !== 'string') {
          return c.json<ApiResponse>({ ok: false, error: 'description must be a string' }, 400);
        }
        const trimmed = descriptionRaw.trim();
        descriptionInput = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
      }

      if (typeof workspaceId !== 'string' || !workspaceId) {
        return c.json<ApiResponse>({ ok: false, error: 'workspaceId field is required' }, 400);
      }
      if (!(fileEntry instanceof File)) {
        return c.json<ApiResponse>({ ok: false, error: 'file field must be a multipart file' }, 400);
      }
      if (fileEntry.size > MAX_ASSET_BYTES) {
        return c.json<ApiResponse>(assetTooLargeResponse(fileEntry.size), 413);
      }

      // Wave-54 B1: writes are bound-agent-friendly. Agent whose IMAgentCard.workspaceId
      // matches the target ws may upload on behalf of the owner. DELETE stays owner-only
      // (see DELETE handler below). Spec source: docs/54release/26-asset-multi-tier-sync.md
      // (bound-agent write semantics) + docs/54release/19-workspace-memory-ingest-module.md
      // "Hard rules in v0" rule #1 (bound-agent predicate).
      const ws = await loadWorkspaceForAssetAccess(workspaceId, user.imUserId);
      if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

      const buffer = Buffer.from(await fileEntry.arrayBuffer());
      const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (expectedContentHash && expectedContentHash !== contentHash) {
        return c.json<ApiResponse>(uploadHashMismatchResponse(expectedContentHash, contentHash, buffer.length), 422);
      }
      let mime = fileEntry.type || null;
      const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'file';

      let metadata: Record<string, unknown> = {};
      if (typeof metadataRaw === 'string' && metadataRaw) {
        try {
          metadata = JSON.parse(metadataRaw);
        } catch {
          return c.json<ApiResponse>({ ok: false, error: 'metadata must be valid JSON' }, 400);
        }
      }

      // Cloud 3 / S3: kind=sandbox-output contract.
      // Daemon-first sandbox uploads (see docs/54release/13) post artifacts
      // with kind=sandbox-output and require taskId + containerId in metadata
      // for proper task → asset linkage. Reject upload if either is missing.
      if (kind === 'sandbox-output') {
        if (typeof metadata.taskId !== 'string' || !metadata.taskId) {
          return c.json<ApiResponse>({ ok: false, error: 'kind=sandbox-output requires metadata.taskId' }, 400);
        }
        if (typeof metadata.containerId !== 'string' || !metadata.containerId) {
          return c.json<ApiResponse>({ ok: false, error: 'kind=sandbox-output requires metadata.containerId' }, 400);
        }
      }

      const title = assetTitleFromUpload(fileEntry.name, metadata, contentHash);
      const sourceRef =
        typeof metadata.sourceRef === 'string' && metadata.sourceRef
          ? metadata.sourceRef
          : `upload://${workspaceId}/${contentHash}`;
      const sourceKind =
        typeof metadata.sourceKind === 'string' && metadata.sourceKind ? metadata.sourceKind : 'upload';
      const isAgentProducedAsset =
        sourceKind === 'agent-gen' ||
        kind === 'agent-output' ||
        kind === 'sandbox-output' ||
        typeof sourceAgentImUserId === 'string' ||
        typeof metadata.sourceAgentImUserId === 'string';

      // release202/09 P1 — sidebar sync for the watcher path. The
      // artifacts-watcher posts sandbox-output / agent-output uploads with only
      // `metadata.taskId` (the owning run/task id) and never stamps
      // `metadata.conversationId`, so the session right sidebar
      // (page.tsx:1330 `metadata.conversationId === selectedConversationId`)
      // can't see auto-delivered files. Derive it here from the task/run that
      // owns the upload (probe-both since run/task ids are the same shape) and
      // stamp it into metadata before dedup + create so BOTH paths persist it.
      // Honour an explicit metadata.conversationId if the producer already set
      // one; only backfill when absent. Best-effort — a miss leaves it unset.
      if (
        (kind === 'sandbox-output' || kind === 'agent-output') &&
        !(typeof metadata.conversationId === 'string' && metadata.conversationId) &&
        typeof metadata.taskId === 'string' &&
        metadata.taskId
      ) {
        const derivedConversationId = await resolveConversationIdForTaskOrRun(metadata.taskId);
        if (derivedConversationId) {
          metadata = { ...metadata, conversationId: derivedConversationId };
        }
      }

      if (isAgentProducedAsset) {
        const policy = validateAgentOutputAsset({ filename: fileEntry.name, mime, sizeBytes: buffer.length });
        if (!policy.ok) {
          return c.json<ApiResponse>(
            {
              ok: false,
              error: {
                code: 'agent_output_asset_rejected',
                message: policy.reason,
              },
            },
            422,
          );
        }
        mime = policy.mime;
      }
      // 2026-05-22 — magic-bytes content vs declared-mime cross-check.
      // The policy above validates by FILENAME (extension+mime string); it
      // doesn't peek at the bytes. An agent that names markdown
      // `report.pdf` with mime `application/pdf` slips through unless we
      // also sniff the head. The daemon side has a first-pass guard at
      // outbox-watcher.ts that catches the same fraud before upload —
      // this is the cloud-side defense-in-depth (D34 evidence/v20-acceptance/10).
      // We apply it to ALL uploads, not just agent-produced, so a
      // human-driven web upload that mislabels a file also gets caught.
      {
        const detection = detectMagicBytes(buffer);
        const reason = mimeMismatchReason(detection, mime);
        if (reason) {
          // 2026-05-22 (F2A) — no storage cleanup needed on this branch.
          // Multipart bytes live in `buffer` (in-memory) until the explicit
          // writeS3 / writeFilesystem call further down — magic-bytes is
          // checked BEFORE that write, so a rejection here never produces
          // an orphan. (Contrast with direct-upload/complete, where the
          // client PUT to a presigned URL has already populated S3 by the
          // time we sniff and we MUST call safeDeleteAssetObject.)
          return c.json<ApiResponse>(
            {
              ok: false,
              error: {
                code: 'MIME_MISMATCH',
                message: `MIME_MISMATCH: ${reason}. Filename: ${fileEntry.name}.`,
              },
            },
            400,
          );
        }
      }
      const textContent = await textContentForMemoryPage({
        mime,
        kind,
        metadata: { ...metadata, filename: fileEntry.name },
        buffer,
      });

      // release201/09 §9.4a.5 — `cloud task attach` declare-first path
      // signals boundKind='task-bound' via metadata. The same file
      // attached to two different tasks must produce two IMAsset rows
      // (each task wants its own attachment chip / Artifacts tab row),
      // so we widen dedup to (workspaceId, contentHash, sourceTaskId).
      // For uploads without a task scope, behavior stays as before.
      const incomingBoundKind =
        typeof metadata.boundKind === 'string' &&
        (metadata.boundKind === 'task-bound' || metadata.boundKind === 'workspace-file')
          ? (metadata.boundKind as 'task-bound' | 'workspace-file')
          : undefined;
      const formSourceTaskIdForDedup = typeof sourceTaskId === 'string' && sourceTaskId ? sourceTaskId : null;
      const metaTaskIdForDedup = typeof metadata.taskId === 'string' && metadata.taskId ? metadata.taskId : null;
      const dedupTaskScope = formSourceTaskIdForDedup ?? metaTaskIdForDedup;

      // Same-workspace dedup: hash already present → return existing row.
      // drop-folder is path-specific: the same bytes dropped into two
      // different folders must appear twice in the library tree, so it dedupes
      // only an exact sourceRef replay. Generic uploads keep hash-level dedup.
      // Wave-54 B2 follow-up: re-uploads that supply a different description
      // get the description updated in place (otherwise the request body is
      // semantically asserted but silently ignored). filename/folderPath etc.
      // continue to be PATCH-only — description is the one field we expect
      // to be re-asserted by every producer.
      // release201/09 task-attach dedup: when caller declares a task scope
      // (`sourceTaskId` form field or metadata.taskId), narrow dedup to that
      // tuple so attaching the same bytes to a different task creates a new
      // attachment row.
      const existingWhere: Record<string, unknown> =
        sourceKind === 'drop-folder'
          ? { workspaceId, contentHash, sourceRef, deletedAt: null }
          : dedupTaskScope
            ? { workspaceId, contentHash, sourceTaskId: dedupTaskScope, deletedAt: null }
            : { workspaceId, contentHash, deletedAt: null };
      const existing = await prisma.iMAsset.findFirst({ where: existingWhere });
      if (existing) {
        await bridgePhotoMemorySegmentAsset(user.imUserId, workspaceId, kind, metadata, buffer, fileEntry.name);
        let linkedPages: MemoryPageSummary[] = [];
        let assetRow = existing;
        await ensureAssetRevisionSnapshot(existing as unknown as AssetRow, user.imUserId);
        const descriptionDelta =
          descriptionInput !== undefined && descriptionInput !== existing.description
            ? { description: descriptionInput }
            : null;
        if (textContent) {
          const page = await memoryPages.upsertFromAsset({
            workspaceId,
            actorImUserId: user.imUserId,
            assetId: existing.id,
            sourceRef: `asset://${existing.id}`,
            sourceKind: 'asset-hook',
            title,
            content: textContent,
            ingestVersion: existing.ingestVersion,
          });
          linkedPages = [page];
          assetRow = await prisma.$transaction(async (tx: AssetWriteTx) => {
            const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
            const updated = await tx.iMAsset.update({
              where: { id: existing.id },
              data: {
                ingestStatus: 'memory-ready',
                assetIndexSeq,
                revision: { increment: 1 },
                ...(descriptionDelta ?? {}),
              },
            });
            await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, user.imUserId, 'memory-ready');
            return updated;
          });
        } else if (descriptionDelta) {
          // No text-content side-effect, but description still needs to land.
          assetRow = await prisma.$transaction(async (tx: AssetWriteTx) => {
            const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
            const updated = await tx.iMAsset.update({
              where: { id: existing.id },
              data: { ...descriptionDelta, assetIndexSeq, revision: { increment: 1 } },
            });
            await createAssetRevisionSnapshot(tx, updated as unknown as AssetRow, user.imUserId, 'metadata-update');
            return updated;
          });
        }
        await maybeCreatePdfLinearizedPreviewAsset({
          parent: assetRow as unknown as AssetRow,
          actorImUserId: user.imUserId,
          bytes: buffer,
          filename: fileEntry.name,
          metadata,
        });
        await maybeCreatePdfFirstPageThumbnailAsset({
          parent: assetRow as unknown as AssetRow,
          actorImUserId: user.imUserId,
          bytes: buffer,
          filename: fileEntry.name,
          metadata,
        });
        await maybeCreateImageThumbnailPreviewAsset({
          parent: assetRow as unknown as AssetRow,
          actorImUserId: user.imUserId,
          bytes: buffer,
          filename: fileEntry.name,
          metadata,
        });
        assetRow = (await prisma.iMAsset.findUnique({ where: { id: existing.id } })) ?? assetRow;
        await publishAssetChanged({
          rooms,
          syncService,
          ownerImUserId: ws.ownerImUserId,
          row: assetRow as unknown as AssetRow,
          operation: 'update',
        });
        // 2026-05-22 — same outputAssetIds rollup as the fresh-upload path
        // below. Daemon may re-upload the same content for a different task
        // (e.g. CEO copies a previously-generated report into a new task);
        // the dedup branch shares the same IMAsset row but each task gets
        // the asset listed in its own metadata.outputAssetIds.
        const dedupFormSourceTaskId = typeof sourceTaskId === 'string' && sourceTaskId ? sourceTaskId : null;
        const dedupMetaTaskId = typeof metadata.taskId === 'string' && metadata.taskId ? metadata.taskId : null;
        const dedupTaskId = dedupFormSourceTaskId ?? dedupMetaTaskId;
        if (dedupTaskId) {
          // WS2 — append + (if the task already closed) re-emit its digest so
          // late-arriving deliverables update the chat card, not just the
          // drawer. Best-effort: never rolls back the upload.
          await rollupAndReemitDigest(dedupTaskId, existing.id, taskService, 'dedup');
        }
        c.header('X-Asset-Sync', '1');
        return c.json<ApiResponse<AssetDTO>>({
          ok: true,
          data: toDTO(assetRow as AssetRow, linkedPages),
          ...(descriptionDelta ? { meta: { dedup: true, descriptionUpdated: true } } : { meta: { dedup: true } }),
        });
      }

      const backend = getBackend();
      let storageUri: string;
      try {
        if (backend === 's3') {
          if (!isS3Available()) {
            return c.json<ApiResponse>(
              {
                ok: false,
                error: {
                  code: 'asset_storage_unavailable',
                  message: 'ASSET_STORAGE_BACKEND=s3 but S3 credentials are not configured',
                },
              },
              503,
            );
          }
          storageUri = await writeS3(contentHash, buffer, mime);
        } else {
          storageUri = await writeFilesystem(contentHash, buffer);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json<ApiResponse>({ ok: false, error: { code: 'asset_storage_unavailable', message: msg } }, 503);
      }
      const cdnUrl = assetCdnUrlForStorageUri(storageUri);

      // Wave-8 W1 A3: sandbox-output (and any kind that supplies
      // `metadata.taskId`) must populate the `sourceTaskId` column so the
      // task-detail drawer's `?taskId=` filter (`prisma.iMAsset.findMany({
      // where: { sourceTaskId } })`) actually finds them. Earlier the form
      // field `sourceTaskId` was the only path; sandbox uploads only set
      // `metadata.taskId`, leaving the column NULL and orphaning the asset
      // from the task it was generated for.
      const formSourceTaskId = typeof sourceTaskId === 'string' && sourceTaskId ? sourceTaskId : null;
      const metaTaskId = typeof metadata.taskId === 'string' && metadata.taskId ? metadata.taskId : null;
      const resolvedSourceTaskId = formSourceTaskId ?? metaTaskId;

      let created = await prisma.$transaction(async (tx: AssetWriteTx) => {
        const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
        const asset = await tx.iMAsset.create({
          data: {
            workspaceId,
            ownerImUserId: user.imUserId,
            contentHash,
            storageUri,
            sizeBytes: BigInt(buffer.length),
            mime,
            kind,
            sourceAgentImUserId: typeof sourceAgentImUserId === 'string' ? sourceAgentImUserId : null,
            sourceTaskId: resolvedSourceTaskId,
            metadata: JSON.stringify({ ...metadata, filename: fileEntry.name }),
            assetIndexSeq,
            cdnUrl,
            filename: fileEntry.name,
            sourceRef,
            sourceKind,
            sourceMetadata: JSON.stringify(metadata),
            ingestStatus: textContent ? 'indexed' : 'asset-only',
            // Wave-9 Phase 2: explicit folderPath wins over the auto-tag
            // fallback below; producers (OutboxWatcher) post the form field
            // directly. See dedup branch above for the same merge.
            ...(folderPathInput !== undefined ? { folderPath: folderPathInput } : {}),
            ...(descriptionInput !== undefined ? { description: descriptionInput } : {}),
            // release201/09 §9.4a.2: stamp boundKind on create. Honors
            // metadata.boundKind when declared (declare-first attach via
            // `cloud task attach`); otherwise infers — sourceTaskId present
            // (or sandbox-output kind) → task-bound, else workspace-file.
            boundKind:
              incomingBoundKind ??
              (resolvedSourceTaskId || kind === 'sandbox-output' || kind === 'agent-output'
                ? 'task-bound'
                : 'workspace-file'),
          },
        });
        await createAssetRevisionSnapshot(tx, asset as unknown as AssetRow, user.imUserId, 'created');
        return asset;
      });

      await bridgePhotoMemorySegmentAsset(user.imUserId, workspaceId, kind, metadata, buffer, fileEntry.name);
      let linkedPages: MemoryPageSummary[] = [];
      if (textContent) {
        const page = await memoryPages.upsertFromAsset({
          workspaceId,
          actorImUserId: user.imUserId,
          assetId: created.id,
          sourceRef: `asset://${created.id}`,
          sourceKind: 'asset-hook',
          title,
          content: textContent,
          ingestVersion: created.ingestVersion,
        });
        linkedPages = [page];
        await prisma.$transaction(async (tx: AssetWriteTx) => {
          const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
          created = await tx.iMAsset.update({
            where: { id: created.id },
            data: { ingestStatus: 'memory-ready', assetIndexSeq, revision: { increment: 1 } },
          });
          await createAssetRevisionSnapshot(tx, created as unknown as AssetRow, user.imUserId, 'memory-ready');
        });
      }

      await maybeCreatePdfLinearizedPreviewAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: buffer,
        filename: fileEntry.name,
        metadata,
      });
      await maybeCreatePdfFirstPageThumbnailAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: buffer,
        filename: fileEntry.name,
        metadata,
      });
      await maybeCreateImageThumbnailPreviewAsset({
        parent: created as unknown as AssetRow,
        actorImUserId: user.imUserId,
        bytes: buffer,
        filename: fileEntry.name,
        metadata,
      });
      created = (await prisma.iMAsset.findUnique({ where: { id: created.id } })) ?? created;

      // 2026-05-22 — kanban attachment chip. When a daemon outbox upload
      // names a sourceTaskId, denormalise the assetId into
      // `task.metadata.outputAssetIds` so completeTask can roll it into
      // `task.result.assetIds`. The `sourceTaskId` column already powers
      // the live kanban chip (task-board.tsx assetsByTaskId index), so
      // this is purely the completion-side rollup path. Best-effort —
      // a failure here must not roll back the upload.
      if (resolvedSourceTaskId) {
        // WS2 — append + (if the task already closed) re-emit its digest so a
        // daemon outbox flush that lands after completion catches the chat
        // card up to the drawer. Best-effort: never rolls back the upload.
        await rollupAndReemitDigest(resolvedSourceTaskId, created.id, taskService, 'fresh');
      }

      await publishAssetChanged({
        rooms,
        syncService,
        ownerImUserId: ws.ownerImUserId,
        row: created as unknown as AssetRow,
        operation: 'create',
      });
      c.header('X-Asset-Sync', '1');
      return c.json<ApiResponse<AssetDTO>>({ ok: true, data: toDTO(created as AssetRow, linkedPages) }, 201);
    } catch (err) {
      console.error('[AssetsAPI] POST /assets failed:', err instanceof Error ? err.stack : err);
      return c.json<ApiResponse>({ ok: false, error: err instanceof Error ? err.message : 'asset upload failed' }, 500);
    }
  });

  // GET /assets/by-hash/:hash?wsId=...
  router.get('/by-hash/:hash', async (c) => {
    const user = c.get('user');
    const hash = c.req.param('hash');
    const wsId = c.req.query('wsId');
    if (!wsId) return c.json<ApiResponse>({ ok: false, error: 'wsId query param is required' }, 400);

    const ws = await loadWorkspaceForAssetAccess(wsId, user.imUserId);
    if (!ws) return c.json<ApiResponse>({ ok: false, error: 'Workspace not found' }, 404);

    const row = await prisma.iMAsset.findFirst({
      where: { workspaceId: wsId, contentHash: hash, deletedAt: null },
    });
    if (!row) return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);

    const [dto] = await enrichAssetDTOs([row as unknown as AssetRow]);
    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: await enrichAssetRelations(dto) });
  });

  // POST /assets/:id/derived — attach a parsed/preview/data artifact to a raw asset
  router.post('/:id/derived', async (c) => {
    const user = c.get('user');
    const parentId = c.req.param('id');
    const parent = await prisma.iMAsset.findUnique({
      where: { id: parentId },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!parent || !(await loadWorkspaceForAssetAccess(parent.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if (parent.deletedAt) return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected multipart/form-data' }, 400);
    }

    const fileEntry = form.get('file');
    const derivationKindRaw = form.get('derivationKind');
    const kindRaw = form.get('kind');
    const metadataRaw = form.get('metadata');
    let expectedContentHash: string | null;
    try {
      expectedContentHash = readExpectedUploadSha256(
        c.req.header('x-content-sha256'),
        form.get('contentSha256') ?? form.get('sha256'),
      );
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: {
            code: 'invalid_upload_hash',
            message: err instanceof Error ? err.message : 'Invalid upload SHA-256 digest',
          },
        },
        400,
      );
    }
    // Wave-54 B2: derived uploads inherit the same description form field as POST /assets.
    const descriptionRaw = form.get('description');
    let descriptionInput: string | null | undefined = undefined;
    if (descriptionRaw !== null) {
      if (typeof descriptionRaw !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'description must be a string' }, 400);
      }
      const trimmed = descriptionRaw.trim();
      descriptionInput = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
    }
    if (!(fileEntry instanceof File)) {
      return c.json<ApiResponse>({ ok: false, error: 'file field must be a multipart file' }, 400);
    }
    if (typeof derivationKindRaw !== 'string' || !derivationKindRaw.trim()) {
      return c.json<ApiResponse>({ ok: false, error: 'derivationKind is required' }, 400);
    }
    if (fileEntry.size > MAX_ASSET_BYTES) {
      return c.json<ApiResponse>(assetTooLargeResponse(fileEntry.size), 413);
    }

    let metadata: Record<string, unknown> = {};
    if (typeof metadataRaw === 'string' && metadataRaw) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        return c.json<ApiResponse>({ ok: false, error: 'metadata must be valid JSON' }, 400);
      }
    }

    const buffer = Buffer.from(await fileEntry.arrayBuffer());
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (expectedContentHash && expectedContentHash !== contentHash) {
      return c.json<ApiResponse>(uploadHashMismatchResponse(expectedContentHash, contentHash, buffer.length), 422);
    }
    const mime = fileEntry.type || null;
    const derivationKind = derivationKindRaw.trim();
    const kind = typeof kindRaw === 'string' && kindRaw.trim() ? kindRaw.trim() : derivationKind;
    const title = assetTitleFromUpload(fileEntry.name, metadata, contentHash);
    const textContent = await textContentForMemoryPage({
      mime,
      kind,
      metadata: { ...metadata, filename: fileEntry.name },
      buffer,
    });

    const existing = await prisma.iMAsset.findFirst({
      where: { workspaceId: parent.workspaceId, contentHash, deletedAt: null },
    });
    if (existing) {
      await ensureAssetRevisionSnapshot(existing as unknown as AssetRow, user.imUserId);
      await maybeHydratePdfMemoryPage(existing as AssetRow, user.imUserId, memoryPages);
      const hydrated = await prisma.iMAsset.findUnique({ where: { id: existing.id } });
      const [dto] = await enrichAssetDTOs([(hydrated ?? existing) as unknown as AssetRow]);
      await publishAssetChanged({
        rooms,
        syncService,
        ownerImUserId: parent.workspace.ownerImUserId,
        row: (hydrated ?? existing) as unknown as AssetRow,
        operation: 'update',
      });
      c.header('X-Asset-Sync', '1');
      return c.json<ApiResponse<AssetDTO>>({ ok: true, data: dto });
    }

    let storageUri: string;
    try {
      storageUri =
        getBackend() === 's3' ? await writeS3(contentHash, buffer, mime) : await writeFilesystem(contentHash, buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json<ApiResponse>({ ok: false, error: { code: 'asset_storage_unavailable', message: msg } }, 503);
    }

    let created = await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
      const asset = await tx.iMAsset.create({
        data: {
          workspaceId: parent.workspaceId,
          ownerImUserId: user.imUserId,
          contentHash,
          storageUri,
          sizeBytes: BigInt(buffer.length),
          mime,
          kind,
          metadata: JSON.stringify({ ...metadata, filename: fileEntry.name }),
          parentAssetId: parent.id,
          derivationKind,
          ingestStatus: textContent ? 'indexed' : 'asset-only',
          assetIndexSeq,
          filename: fileEntry.name,
          sourceRef: `asset://${parent.id}`,
          sourceKind: 'asset-derived',
          sourceMetadata: JSON.stringify({ ...metadata, parentAssetId: parent.id }),
          visibility: parent.visibility,
          aclJson: parent.aclJson,
          ...(descriptionInput !== undefined ? { description: descriptionInput } : {}),
        },
      });
      await createAssetRevisionSnapshot(tx, asset as unknown as AssetRow, user.imUserId, 'created');
      return asset;
    });

    let linkedPages: MemoryPageSummary[] = [];
    if (textContent && derivationKind === 'parsed-md') {
      const page = await memoryPages.upsertFromAsset({
        workspaceId: parent.workspaceId,
        actorImUserId: user.imUserId,
        assetId: created.id,
        sourceRef: `asset://${parent.id}`,
        sourceKind: 'asset-derived',
        title,
        content: textContent,
        ingestVersion: parent.ingestVersion,
      });
      linkedPages = [page];
      await prisma.$transaction(async (tx: AssetWriteTx) => {
        const assetIndexSeq = await allocateAssetIndexSeq(tx, parent.workspaceId);
        created = await tx.iMAsset.update({
          where: { id: created.id },
          data: { ingestStatus: 'memory-ready', assetIndexSeq, revision: { increment: 1 } },
        });
        await createAssetRevisionSnapshot(tx, created as unknown as AssetRow, user.imUserId, 'memory-ready');
      });
    }

    await publishAssetChanged({
      rooms,
      syncService,
      ownerImUserId: parent.workspace.ownerImUserId,
      row: created as unknown as AssetRow,
      operation: 'create',
    });
    c.header('X-Asset-Sync', '1');
    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: toDTO(created as AssetRow, linkedPages) }, 201);
  });

  // GET /assets/:id/revisions — append-only metadata/storage snapshots
  router.get('/:id/revisions', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);
    }

    await ensureAssetRevisionSnapshot(row as unknown as AssetRow, user.imUserId);
    const revisions = (await prisma.iMAssetRevision.findMany({
      where: { assetId: id },
      orderBy: { revision: 'asc' },
    })) as unknown as AssetRevisionRow[];

    return c.json<ApiResponse<{ assetId: string; currentRevision: number; items: AssetRevisionDTO[] }>>({
      ok: true,
      data: {
        assetId: id,
        currentRevision: row.revision,
        items: revisions.map(toRevisionDTO),
      },
    });
  });

  // POST /assets/:id/revisions — write edited content back as a NEW revision.
  //
  // Content-addressed assets are immutable per (contentHash, storageUri): an
  // edit therefore produces a brand-new blob (its own sha256 / storageUri /
  // sizeBytes) and advances the SAME logical asset's `revision`. We:
  //   1. hash + write the new bytes via the SAME writeFilesystem/writeS3
  //      helpers the upload path uses (no bespoke storage path),
  //   2. in one tx: bump revision, repoint current contentHash/storageUri/
  //      sizeBytes/cdnUrl/ingestStatus, allocate a fresh assetIndexSeq (so the
  //      sync delta cursor advances exactly like every other write path),
  //   3. snapshot the new current state into IMAssetRevision (reason='edit'),
  //      mirroring createAssetRevisionSnapshot semantics in the upload/PATCH paths.
  // RBAC: workspace owner OR bound agent (loadWorkspaceForAssetAccess) — same
  // write predicate as POST /assets and PATCH /:id.
  router.post('/:id/revisions', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);
    }

    let body: { content?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }
    if (typeof body.content !== 'string') {
      return c.json<ApiResponse>({ ok: false, error: 'content must be a string' }, 400);
    }
    const buffer = Buffer.from(body.content, 'utf-8');
    if (buffer.length > MAX_ASSET_BYTES) {
      return c.json<ApiResponse>(assetTooLargeResponse(buffer.length), 413);
    }

    // Mime guard: this endpoint overwrites the blob with UTF-8 text. Applying it
    // to a binary asset (image/pdf/…) would corrupt the bytes while keeping the
    // original mime. Only allow text-class assets (text/*), or a null mime
    // (treated as an editable markdown asset — the default for this endpoint).
    const rowMime = row.mime ?? null;
    const isEditableMime = rowMime === null || rowMime.startsWith('text/');
    if (!isEditableMime) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: { code: 'unsupported_asset_type', message: 'only text/markdown assets are editable' },
        },
        415,
      );
    }

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    // Preserve the logical asset's mime (markdown editor target). If the row
    // never had one, default to text/markdown — this endpoint only edits text.
    const mime = row.mime ?? 'text/markdown';

    // No-op short-circuit: identical content means no new blob, no revision bump,
    // no snapshot. Return the current asset DTO with 200 (vs 201 for a real edit).
    if (contentHash === row.contentHash) {
      const [dto] = await enrichAssetDTOs([row as unknown as AssetRow]);
      return c.json<ApiResponse<AssetDTO>>({ ok: true, data: dto }, 200);
    }

    // Snapshot the current state BEFORE mutating, so revision history keeps the
    // pre-edit blob (matches PATCH/upload, which ensure the current snapshot first).
    await ensureAssetRevisionSnapshot(row as unknown as AssetRow, user.imUserId);

    const backend = getBackend();
    let storageUri: string;
    try {
      if (backend === 's3') {
        if (!isS3Available()) {
          return c.json<ApiResponse>(
            {
              ok: false,
              error: {
                code: 'asset_storage_unavailable',
                message: 'ASSET_STORAGE_BACKEND=s3 but S3 credentials are not configured',
              },
            },
            503,
          );
        }
        storageUri = await writeS3(contentHash, buffer, mime);
      } else {
        storageUri = await writeFilesystem(contentHash, buffer);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json<ApiResponse>({ ok: false, error: { code: 'asset_storage_unavailable', message: msg } }, 503);
    }
    const cdnUrl = assetCdnUrlForStorageUri(storageUri);

    const updated = await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, row.workspaceId);
      const next = await tx.iMAsset.update({
        where: { id },
        data: {
          contentHash,
          storageUri,
          sizeBytes: BigInt(buffer.length),
          mime,
          cdnUrl,
          // Editing the bytes invalidates any derived ingest (memory page /
          // extracted text). Reset to asset-only; a re-ingest hook can re-run.
          ingestStatus: 'asset-only',
          assetIndexSeq,
          revision: { increment: 1 },
        },
      });
      await createAssetRevisionSnapshot(tx, next as unknown as AssetRow, user.imUserId, 'edit');
      return next;
    });

    await publishAssetChanged({
      rooms,
      syncService,
      ownerImUserId: row.workspace.ownerImUserId,
      row: updated as unknown as AssetRow,
      operation: 'update',
    });
    c.header('X-Asset-Sync', '1');
    const [dto] = await enrichAssetDTOs([updated as unknown as AssetRow]);
    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: dto }, 201);
  });

  // GET /assets/:id/detail — JSON metadata + freshly-signed s3Url + reverse-lookup
  router.get('/:id/detail', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const revisionRaw = c.req.query('revision');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);
    }

    let detailRow = row as unknown as AssetRow;
    if (revisionRaw) {
      let revision: AssetRevisionRow | null;
      try {
        revision = await loadAssetRevisionOrCurrent(row as unknown as AssetRow, revisionRaw, user.imUserId);
      } catch (err) {
        return c.json<ApiResponse>({ ok: false, error: err instanceof Error ? err.message : 'Invalid revision' }, 400);
      }
      if (!revision) {
        return c.json<ApiResponse>({ ok: false, error: 'Asset revision not found' }, 404);
      }
      detailRow = assetRowFromRevision(row as unknown as AssetRow, revision);
    }

    let s3Url: string | null = null;
    if (detailRow.storageUri.startsWith('s3://')) {
      try {
        s3Url = await presignS3(detailRow.storageUri);
      } catch {
        s3Url = null;
      }
    }

    let metadata: Record<string, unknown> = {};
    try {
      metadata = detailRow.metadata ? JSON.parse(detailRow.metadata) : {};
    } catch {
      /* keep empty */
    }

    const photoRefs =
      (detailRow.kind === PHOTO_MEMORY_SEGMENT_KIND || metadata.kind === PHOTO_MEMORY_SEGMENT_KIND) &&
      Array.isArray(metadata.photoRefs)
        ? (metadata.photoRefs as Array<Record<string, unknown>>)
        : null;

    if (!revisionRaw) {
      await maybeHydratePdfMemoryPage(row as unknown as AssetRow, user.imUserId, memoryPages);
      const hydratedRow = await prisma.iMAsset.findUnique({ where: { id } });
      detailRow = (hydratedRow ?? row) as unknown as AssetRow;
    }

    const [dto] = await enrichAssetDTOs([detailRow]);
    const enriched = await enrichAssetRelations(dto);
    enriched.preview = buildAssetPreviewContract(enriched);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        ...enriched,
        s3Url,
        s3UrlExpiresIn: s3Url ? PRESIGNED_TTL_SECONDS : null,
        photoRefs,
      },
    });
  });

  // HEAD /assets/:id — metadata only
  router.on('HEAD', '/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return new Response(null, { status: 404 });
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return new Response(null, { status: 410 });
    }
    const etag = assetHttpEtag(row as unknown as AssetRow);
    const cacheControl = byteRouteCacheControl(row as unknown as AssetRow);
    if (requestHasFreshEtag(c.req.header('if-none-match') ?? c.req.header('If-None-Match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });
    }
    const headers: Record<string, string> = {
      'Content-Type': row.mime ?? 'application/octet-stream',
      'X-Asset-Hash': row.contentHash,
      'X-Asset-Kind': row.kind,
      ETag: etag,
      'Cache-Control': cacheControl,
    };
    if (row.sizeBytes != null) headers['Content-Length'] = String(Number(row.sizeBytes));
    return new Response(null, { status: 200, headers });
  });

  // GET /assets/:id — bytes
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const revisionRaw = c.req.query('revision');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);
    }

    let bytesRow = row as unknown as AssetRow;
    if (revisionRaw) {
      let revision: AssetRevisionRow | null;
      try {
        revision = await loadAssetRevisionOrCurrent(row as unknown as AssetRow, revisionRaw, user.imUserId);
      } catch (err) {
        return c.json<ApiResponse>({ ok: false, error: err instanceof Error ? err.message : 'Invalid revision' }, 400);
      }
      if (!revision) {
        return c.json<ApiResponse>({ ok: false, error: 'Asset revision not found' }, 404);
      }
      bytesRow = assetRowFromRevision(row as unknown as AssetRow, revision);
    }

    const etag = assetHttpEtag(bytesRow);
    // release202/13 L0: derivatives (thumbnails/previews) are content-addressed
    // and immutable → 1y immutable cache. The mutable :id (current revision of an
    // editable asset) must revalidate, so the browser sends If-None-Match and we
    // answer with a cheap 304 instead of a full body.
    const cacheControl = byteRouteCacheControl(bytesRow);
    if (requestHasFreshEtag(c.req.header('if-none-match') ?? c.req.header('If-None-Match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });
    }

    if (bytesRow.storageUri.startsWith('file://')) {
      const rangeHeader = c.req.header('range') ?? c.req.header('Range') ?? null;
      return streamFilesystem(
        bytesRow.storageUri,
        bytesRow.mime,
        bytesRow.sizeBytes != null ? Number(bytesRow.sizeBytes) : null,
        rangeHeader,
        etag,
        cacheControl,
      );
    }
    if (bytesRow.storageUri.startsWith('s3://')) {
      try {
        const url = await presignS3(bytesRow.storageUri);
        return new Response(null, {
          status: 302,
          headers: { Location: url, ETag: etag, 'Cache-Control': cacheControl },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json<ApiResponse>({ ok: false, error: { code: 'asset_storage_unavailable', message: msg } }, 503);
      }
    }
    return c.json<ApiResponse>({ ok: false, error: `Unsupported storageUri scheme: ${bytesRow.storageUri}` }, 500);
  });

  // PATCH /assets/:id — metadata update for card-level CRUD (rename, folder, source tags)
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadWorkspaceForAssetAccess(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset deleted' }, 410);
    }
    await ensureAssetRevisionSnapshot(row as unknown as AssetRow, user.imUserId);

    let body: {
      filename?: unknown;
      title?: unknown;
      folderPath?: unknown;
      sourceRef?: unknown;
      sourceKind?: unknown;
      metadata?: unknown;
      description?: unknown;
      /** release201/09 §9.4a.4 — Promote ↑ flips this to 'workspace-file' + clears sourceTaskId. */
      boundKind?: unknown;
      sourceTaskId?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json<ApiResponse>({ ok: false, error: 'Expected JSON body' }, 400);
    }

    let metadata: Record<string, unknown> = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      metadata = {};
    }
    if (body.metadata !== undefined) {
      if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
        return c.json<ApiResponse>({ ok: false, error: 'metadata must be an object' }, 400);
      }
      metadata = { ...metadata, ...(body.metadata as Record<string, unknown>) };
    }

    const data: {
      filename?: string | null;
      folderPath?: string | null;
      sourceRef?: string | null;
      sourceKind?: string | null;
      description?: string | null;
      /** release201/09 §9.4a.4. */
      boundKind?: string | null;
      sourceTaskId?: string | null;
      metadata: string;
      revision: { increment: number };
    } = {
      metadata: JSON.stringify(metadata),
      revision: { increment: 1 },
    };

    if (body.filename !== undefined || body.title !== undefined) {
      const rawName = body.filename ?? body.title;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return c.json<ApiResponse>({ ok: false, error: 'filename must be a non-empty string' }, 400);
      }
      const filename = rawName.trim().slice(0, 240);
      data.filename = filename;
      metadata.title = filename;
      data.metadata = JSON.stringify(metadata);
    }
    if (body.folderPath !== undefined) {
      if (body.folderPath !== null && typeof body.folderPath !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'folderPath must be a string or null' }, 400);
      }
      data.folderPath = typeof body.folderPath === 'string' && body.folderPath.trim() ? body.folderPath.trim() : null;
    }
    if (body.sourceRef !== undefined) {
      if (body.sourceRef !== null && typeof body.sourceRef !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'sourceRef must be a string or null' }, 400);
      }
      data.sourceRef = typeof body.sourceRef === 'string' && body.sourceRef.trim() ? body.sourceRef.trim() : null;
    }
    if (body.sourceKind !== undefined) {
      if (body.sourceKind !== null && typeof body.sourceKind !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'sourceKind must be a string or null' }, 400);
      }
      data.sourceKind = typeof body.sourceKind === 'string' && body.sourceKind.trim() ? body.sourceKind.trim() : null;
    }
    // release201/09 §9.4a.4 — boundKind editable on PATCH; restricted to
    // the two-value enum. Promote ↑ (task drawer → Library Root) sets
    // boundKind='workspace-file' + sourceTaskId=null + folderPath=null
    // in a single PATCH call.
    if (body.boundKind !== undefined) {
      if (body.boundKind !== null && body.boundKind !== 'task-bound' && body.boundKind !== 'workspace-file') {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: { code: 'invalid_bound_kind', message: 'boundKind must be task-bound | workspace-file | null' },
          },
          400,
        );
      }
      data.boundKind = body.boundKind as 'task-bound' | 'workspace-file' | null;
    }
    if (body.sourceTaskId !== undefined) {
      if (body.sourceTaskId !== null && typeof body.sourceTaskId !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'sourceTaskId must be a string or null' }, 400);
      }
      data.sourceTaskId =
        typeof body.sourceTaskId === 'string' && body.sourceTaskId.trim() ? body.sourceTaskId.trim() : null;
    }
    // Wave-54 B2: description editable on PATCH; explicit null clears it.
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'description must be a string or null' }, 400);
      }
      if (typeof body.description === 'string') {
        const trimmed = body.description.trim();
        data.description = trimmed.length > 0 ? trimmed.slice(0, 500) : null;
      } else {
        data.description = null;
      }
    }

    const updated = await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, row.workspaceId);
      const next = await tx.iMAsset.update({ where: { id }, data: { ...data, assetIndexSeq } });
      await createAssetRevisionSnapshot(tx, next as unknown as AssetRow, user.imUserId, 'metadata-update');
      return next;
    });
    const [dto] = await enrichAssetDTOs([updated as unknown as AssetRow]);
    await publishAssetChanged({
      rooms,
      syncService,
      ownerImUserId: row.workspace.ownerImUserId,
      row: updated as unknown as AssetRow,
      operation: 'update',
    });
    c.header('X-Asset-Sync', '1');
    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: await enrichAssetRelations(dto) });
  });

  // DELETE /assets/:id — soft-delete (sets deletedAt; S3 object retained)
  // Wave-54 B1: DELETE stays owner-only — bound agents must not be able to
  // remove rows they didn't create — tighter than POST/PATCH. See
  // docs/54release/26-asset-multi-tier-sync.md "asymmetric write/delete" rule.
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await prisma.iMAsset.findUnique({
      where: { id },
      include: { workspace: { select: { ownerImUserId: true } } },
    });
    if (!row || !(await loadOwnedWorkspace(row.workspaceId, user.imUserId))) {
      return c.json<ApiResponse>({ ok: false, error: 'Asset not found' }, 404);
    }
    if ((row as { deletedAt?: Date | null }).deletedAt) {
      // Idempotent — already deleted
      return c.json<ApiResponse>({ ok: true });
    }
    await ensureAssetRevisionSnapshot(row as unknown as AssetRow, user.imUserId);
    const deleted = await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, row.workspaceId);
      const deleted = await tx.iMAsset.update({
        where: { id },
        data: { deletedAt: new Date(), assetIndexSeq, revision: { increment: 1 } },
      });
      await createAssetRevisionSnapshot(tx, deleted as unknown as AssetRow, user.imUserId, 'deleted');
      return deleted;
    });
    await publishAssetChanged({
      rooms,
      syncService,
      ownerImUserId: row.workspace.ownerImUserId,
      row: deleted as unknown as AssetRow,
      operation: 'delete',
    });
    c.header('X-Asset-Sync', '1');
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}
