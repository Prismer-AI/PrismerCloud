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
 *   - "filesystem" (default): writes to ASSET_STORAGE_DIR (default ./prisma/data/assets),
 *      sharded as <dir>/<hash[0..2]>/<hash[2..4]>/<hash>. storageUri = file://<abs path>.
 *   - "s3": writes to bucket from getBucket(); key assets/<hash[0..2]>/<hash[2..4]>/<hash>.
 *      storageUri = s3://<bucket>/<key>. GET returns 302 to a 5-minute presigned URL.
 *
 * Asset cap (1.9.x): 100 MB per upload. Larger files will be re-evaluated in 1.10+.
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
  isS3Available,
  getS3Client,
  getBucket,
  PutObjectCommand,
  GetObjectCommand,
  getSignedUrl,
} from '../services/s3.client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiResponse } from '../types/index';
import { renderAssetManifestMarkdown } from './asset-manifest';
import { PHOTO_MEMORY_SEGMENT_KIND, upsertPhotoMemorySegmentMemoryFile } from '../services/asset-memory-bridge.service';
import { MemoryPageService, type MemoryPageSummary } from '../services/memory-page.service';

const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const PRESIGNED_THRESHOLD_BYTES = 50 * 1024 * 1024;
const PRESIGNED_TTL_SECONDS = 300;
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
  metadata: Record<string, unknown>;
  parentAssetId: string | null;
  derivationKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  ingestError: string | null;
  assetIndexSeq: number;
  cdnUrl: string | null;
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
  updatedAt: string;
  createdAt: string;
  deletedAt: string | null;
  memoryPages?: MemoryPageSummary[];
  derivedAssets?: AssetDTO[];
  parentAsset?: AssetDTO | null;
  previewAsset?: AssetDTO | null;
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
  metadata: string;
  parentAssetId: string | null;
  derivationKind: string | null;
  ingestStatus: string;
  ingestVersion: number;
  ingestError: string | null;
  assetIndexSeq: bigint;
  cdnUrl: string | null;
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

type AssetIndexTx = {
  iMAssetIndexCounter: typeof prisma.iMAssetIndexCounter;
};

type AssetWriteTx = AssetIndexTx & {
  iMAsset: typeof prisma.iMAsset;
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
    metadata,
    parentAssetId: row.parentAssetId,
    derivationKind: row.derivationKind,
    ingestStatus: row.ingestStatus,
    ingestVersion: row.ingestVersion,
    ingestError: row.ingestError,
    assetIndexSeq: Number(row.assetIndexSeq ?? BigInt(0)),
    cdnUrl: row.cdnUrl,
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

function getBackend(): 'filesystem' | 's3' {
  return process.env.ASSET_STORAGE_BACKEND === 's3' ? 's3' : 'filesystem';
}

function getStorageDir(): string {
  return path.resolve(process.env.ASSET_STORAGE_DIR || './prisma/data/assets');
}

function shardedKey(hash: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
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

  return rows.map((row) => toDTO(row, pagesByAsset.get(row.id) ?? []));
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

async function extractPdfTextContent(buffer: Buffer): Promise<string | null> {
  // Lazy import: pdf-parse → pdfjs-dist references DOMMatrix at module top.
  // Loading it eagerly crashes the IM bootstrap on Node (no DOM globals,
  // @napi-rs/canvas not installed). Defer until a PDF actually arrives.
  const { PDFParse } = await import('pdf-parse');
  if (!pdfParseWorkerConfigured) {
    PDFParse.setWorker(path.join(process.cwd(), 'node_modules/pdf-parse/dist/worker/pdf.worker.mjs'));
    pdfParseWorkerConfigured = true;
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: 80, parseHyperlinks: true });
    const text = result.text.trim();
    const semanticText = text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gim, '').trim();
    if (semanticText.length < 20) return null;
    return text.slice(0, 180_000);
  } catch (err) {
    console.log('[AssetsAPI] PDF text extraction failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await parser.destroy().catch(() => undefined);
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
  const isPdf = mime.includes('pdf') || /\.pdf$/.test(filename);
  if (isPdf) return extractPdfTextContent(input.buffer);
  const textLike =
    mime.startsWith('text/') ||
    mime.includes('markdown') ||
    mime.includes('json') ||
    mime.includes('csv') ||
    input.kind.includes('code') ||
    input.kind === PHOTO_MEMORY_SEGMENT_KIND ||
    /\.(md|markdown|txt|json|csv|tsv|ndjson|js|jsx|ts|tsx|py|go|rs|java|kt|swift|rb|php|css|html|sql|yaml|yml|toml)$/.test(
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

async function writeFilesystem(hash: string, bytes: Buffer): Promise<string> {
  const dir = getStorageDir();
  const subdir = path.join(dir, hash.slice(0, 2), hash.slice(2, 4));
  await fs.promises.mkdir(subdir, { recursive: true });
  const filePath = path.join(subdir, hash);
  // Idempotent: if file already exists with matching size, skip rewrite.
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === bytes.length) {
      return `file://${filePath}`;
    }
  } catch {
    // not present, write below
  }
  await fs.promises.writeFile(filePath, bytes);
  return `file://${filePath}`;
}

async function writeS3(hash: string, bytes: Buffer, mime: string | null): Promise<string> {
  const bucket = getBucket();
  const key = `assets/${shardedKey(hash)}`;
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: mime ?? 'application/octet-stream',
    ContentLength: bytes.length,
    ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
  });
  await getS3Client().send(cmd);
  return `s3://${bucket}/${key}`;
}

async function streamFilesystem(
  storageUri: string,
  mime: string | null,
  sizeBytes: number | null,
  rangeHeader: string | null = null,
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
        const handle = await fs.promises.open(filePath, 'r');
        try {
          const length = end - start + 1;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, start);
          const headers: Record<string, string> = {
            'Content-Type': mime ?? 'application/octet-stream',
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=300',
          };
          if (sizeBytes != null) headers['X-Original-Size'] = String(sizeBytes);
          return new Response(buffer, { status: 206, headers });
        } finally {
          await handle.close();
        }
      }
    }

    const buffer = await fs.promises.readFile(filePath);
    const headers: Record<string, string> = {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    };
    if (sizeBytes != null) headers['X-Original-Size'] = String(sizeBytes);
    return new Response(buffer, { headers });
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
    await tx.iMAsset.update({
      where: { id: asset.id },
      data: { ingestStatus: 'memory-ready', assetIndexSeq, revision: { increment: 1 } },
    });
  });

  return [page];
}

async function presignS3(storageUri: string): Promise<string> {
  // s3://bucket/key
  const m = storageUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`Invalid s3 URI: ${storageUri}`);
  const [, bucket, key] = m;
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: PRESIGNED_TTL_SECONDS });
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

export function createAssetsRouter() {
  const router = new Hono();
  const memoryPages = new MemoryPageService();

  router.use('*', authMiddleware);

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

    const taskId = c.req.query('taskId');
    const kind = c.req.query('kind');
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);

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

    const rows = await prisma.iMAsset.findMany({
      where: {
        workspaceId: wsId,
        deletedAt: null,
        ...(taskId ? { sourceTaskId: taskId } : {}),
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
      if (fileEntry.size > PRESIGNED_THRESHOLD_BYTES) {
        return c.json<ApiResponse>(
          {
            ok: false,
            error: {
              code: 'USE_PRESIGNED',
              message: `File ${fileEntry.size} bytes exceeds direct-upload threshold (${PRESIGNED_THRESHOLD_BYTES}). Presigned URL flow is planned for v5.5; not yet available.`,
            },
            meta: { presignedUrl: null, threshold: PRESIGNED_THRESHOLD_BYTES, hardCap: MAX_ASSET_BYTES },
          },
          413,
        );
      }
      if (fileEntry.size > MAX_ASSET_BYTES) {
        return c.json<ApiResponse>({ ok: false, error: `file exceeds ${MAX_ASSET_BYTES} bytes (1.9.x limit)` }, 413);
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
      const mime = fileEntry.type || null;
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
      const textContent = await textContentForMemoryPage({
        mime,
        kind,
        metadata: { ...metadata, filename: fileEntry.name },
        buffer,
      });

      // Same-workspace dedup: hash already present → return existing row.
      // Wave-54 B2 follow-up: re-uploads that supply a different description
      // get the description updated in place (otherwise the request body is
      // semantically asserted but silently ignored). filename/folderPath etc.
      // continue to be PATCH-only — description is the one field we expect
      // to be re-asserted by every producer.
      const existing = await prisma.iMAsset.findFirst({
        where: { workspaceId, contentHash, deletedAt: null },
      });
      if (existing) {
        await bridgePhotoMemorySegmentAsset(user.imUserId, workspaceId, kind, metadata, buffer, fileEntry.name);
        let linkedPages: MemoryPageSummary[] = [];
        let assetRow = existing;
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
            return tx.iMAsset.update({
              where: { id: existing.id },
              data: {
                ingestStatus: 'memory-ready',
                assetIndexSeq,
                revision: { increment: 1 },
                ...(descriptionDelta ?? {}),
              },
            });
          });
        } else if (descriptionDelta) {
          // No text-content side-effect, but description still needs to land.
          assetRow = await prisma.$transaction(async (tx: AssetWriteTx) => {
            const assetIndexSeq = await allocateAssetIndexSeq(tx, workspaceId);
            return tx.iMAsset.update({
              where: { id: existing.id },
              data: { ...descriptionDelta, assetIndexSeq, revision: { increment: 1 } },
            });
          });
        }
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
        return tx.iMAsset.create({
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
          },
        });
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
        });
      }

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
      return c.json<ApiResponse>({ ok: false, error: `file exceeds ${MAX_ASSET_BYTES} bytes (1.9.x limit)` }, 413);
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
      await maybeHydratePdfMemoryPage(existing as AssetRow, user.imUserId, memoryPages);
      const hydrated = await prisma.iMAsset.findUnique({ where: { id: existing.id } });
      const [dto] = await enrichAssetDTOs([(hydrated ?? existing) as unknown as AssetRow]);
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
      return tx.iMAsset.create({
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
      });
    }

    return c.json<ApiResponse<AssetDTO>>({ ok: true, data: toDTO(created as AssetRow, linkedPages) }, 201);
  });

  // GET /assets/:id/detail — JSON metadata + freshly-signed s3Url + reverse-lookup
  router.get('/:id/detail', async (c) => {
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

    let s3Url: string | null = null;
    if (row.storageUri.startsWith('s3://')) {
      try {
        s3Url = await presignS3(row.storageUri);
      } catch {
        s3Url = null;
      }
    }

    let metadata: Record<string, unknown> = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      /* keep empty */
    }

    const photoRefs =
      (row.kind === PHOTO_MEMORY_SEGMENT_KIND || metadata.kind === PHOTO_MEMORY_SEGMENT_KIND) &&
      Array.isArray(metadata.photoRefs)
        ? (metadata.photoRefs as Array<Record<string, unknown>>)
        : null;

    await maybeHydratePdfMemoryPage(row as AssetRow, user.imUserId, memoryPages);
    const hydratedRow = await prisma.iMAsset.findUnique({ where: { id } });
    const [dto] = await enrichAssetDTOs([(hydratedRow ?? row) as unknown as AssetRow]);

    return c.json<ApiResponse>({
      ok: true,
      data: {
        ...(await enrichAssetRelations(dto)),
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
    const headers: Record<string, string> = {
      'Content-Type': row.mime ?? 'application/octet-stream',
      'X-Asset-Hash': row.contentHash,
      'X-Asset-Kind': row.kind,
    };
    if (row.sizeBytes != null) headers['Content-Length'] = String(Number(row.sizeBytes));
    return new Response(null, { status: 200, headers });
  });

  // GET /assets/:id — bytes
  router.get('/:id', async (c) => {
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

    if (row.storageUri.startsWith('file://')) {
      const rangeHeader = c.req.header('range') ?? c.req.header('Range') ?? null;
      return streamFilesystem(
        row.storageUri,
        row.mime,
        row.sizeBytes != null ? Number(row.sizeBytes) : null,
        rangeHeader,
      );
    }
    if (row.storageUri.startsWith('s3://')) {
      try {
        const url = await presignS3(row.storageUri);
        return c.redirect(url, 302);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json<ApiResponse>({ ok: false, error: { code: 'asset_storage_unavailable', message: msg } }, 503);
      }
    }
    return c.json<ApiResponse>({ ok: false, error: `Unsupported storageUri scheme: ${row.storageUri}` }, 500);
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

    let body: {
      filename?: unknown;
      title?: unknown;
      folderPath?: unknown;
      sourceRef?: unknown;
      sourceKind?: unknown;
      metadata?: unknown;
      description?: unknown;
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
      return tx.iMAsset.update({ where: { id }, data: { ...data, assetIndexSeq } });
    });
    const [dto] = await enrichAssetDTOs([updated as unknown as AssetRow]);
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
    await prisma.$transaction(async (tx: AssetWriteTx) => {
      const assetIndexSeq = await allocateAssetIndexSeq(tx, row.workspaceId);
      await tx.iMAsset.update({
        where: { id },
        data: { deletedAt: new Date(), assetIndexSeq, revision: { increment: 1 } },
      });
    });
    return c.json<ApiResponse>({ ok: true });
  });

  return router;
}

