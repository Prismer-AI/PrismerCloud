import * as crypto from 'crypto';
import { Hono, type Context, type Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

type S3CommandLike = {
  input: Record<string, unknown>;
  constructor: { name: string };
};

type PutS3ObjectClient = NonNullable<Parameters<typeof putS3Object>[0]['client']>;

const mocks = vi.hoisted(() => ({
  user: { imUserId: 'owner-1', role: 'human' },
  s3Available: false,
  signedUrlCounter: 0,
  s3Client: {
    send: vi.fn(),
  },
  memoryUpsertFromAsset: vi.fn(),
  prisma: {
    iMWorkspace: { findFirst: vi.fn() },
    iMAgentCard: { findUnique: vi.fn() },
    iMAsset: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    iMAssetRevision: { create: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    iMAssetIndexCounter: { upsert: vi.fn() },
    iMKnowledgeLink: { findMany: vi.fn() },
    iMMemoryPage: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../db', () => ({ default: mocks.prisma }));
vi.mock('../auth/middleware', () => ({
  authMiddleware: async (c: Context, next: Next) => {
    c.set('user', mocks.user);
    await next();
  },
}));
vi.mock('../services/asset-memory-bridge.service', () => ({
  PHOTO_MEMORY_SEGMENT_KIND: 'photo-memory-segment',
  upsertPhotoMemorySegmentMemoryFile: vi.fn(),
}));
vi.mock('../services/memory-page.service', () => ({
  MemoryPageService: class {
    listPages = vi.fn().mockResolvedValue([]);
    upsertFromAsset = mocks.memoryUpsertFromAsset;
  },
}));
vi.mock('../services/asset-preview-derivatives.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/asset-preview-derivatives.service')>();
  return {
    ...actual,
    createPdfFirstPageThumbnailForPreview: vi.fn(async () => ({
      status: 'skipped',
      reason: 'renderer_unavailable',
    })),
  };
});
vi.mock('../config', () => ({
  config: {
    s3: {
      region: 'us-east-1',
      bucket: 'asset-bucket',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      endpoint: undefined,
    },
    cdn: { domain: 'https://cdn.example.test' },
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => `https://signed.example.test/${++mocks.signedUrlCounter}`),
}));
vi.mock('../services/s3.client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3.client')>();
  return {
    ...actual,
    isS3Available: () => mocks.s3Available,
    getS3Client: () => mocks.s3Client,
    getBucket: () => 'asset-bucket',
  };
});

import { assetTooLargeResponse, createAssetsRouter, MAX_ASSET_BYTES } from '../api/assets';
import { createPdfFirstPageThumbnailForPreview } from '../services/asset-preview-derivatives.service';
import { putS3Object } from '../services/s3.client';

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeAssetRow(data: Record<string, unknown> = {}) {
  const now = new Date('2026-05-18T00:00:00.000Z');
  return {
    id: (data.id as string | undefined) ?? 'asset-1',
    workspaceId: (data.workspaceId as string | undefined) ?? 'ws-1',
    ownerImUserId: (data.ownerImUserId as string | undefined) ?? 'owner-1',
    contentHash: (data.contentHash as string | undefined) ?? sha256('asset bytes'),
    storageUri: (data.storageUri as string | undefined) ?? 'file:///tmp/asset',
    sizeBytes: (data.sizeBytes as bigint | undefined) ?? BigInt(11),
    mime: (data.mime as string | null | undefined) ?? 'application/octet-stream',
    kind: (data.kind as string | undefined) ?? 'file',
    sourceAgentImUserId: (data.sourceAgentImUserId as string | null | undefined) ?? null,
    sourceTaskId: (data.sourceTaskId as string | null | undefined) ?? null,
    metadata: (data.metadata as string | undefined) ?? '{}',
    parentAssetId: (data.parentAssetId as string | null | undefined) ?? null,
    derivationKind: (data.derivationKind as string | null | undefined) ?? null,
    ingestStatus: (data.ingestStatus as string | undefined) ?? 'asset-only',
    ingestVersion: (data.ingestVersion as number | undefined) ?? 1,
    ingestError: (data.ingestError as string | null | undefined) ?? null,
    assetIndexSeq: (data.assetIndexSeq as bigint | undefined) ?? BigInt(1),
    cdnUrl: (data.cdnUrl as string | null | undefined) ?? null,
    thumbnailUrl: (data.thumbnailUrl as string | null | undefined) ?? null,
    previewUrls: (data.previewUrls as unknown) ?? null,
    previewAssetId: (data.previewAssetId as string | null | undefined) ?? null,
    folderPath: (data.folderPath as string | null | undefined) ?? null,
    filename: (data.filename as string | null | undefined) ?? 'asset.bin',
    sourceRef: (data.sourceRef as string | null | undefined) ?? null,
    sourceKind: (data.sourceKind as string | null | undefined) ?? 'upload',
    sourceMetadata: (data.sourceMetadata as string | null | undefined) ?? null,
    revision: (data.revision as number | undefined) ?? 1,
    visibility: (data.visibility as string | undefined) ?? 'private',
    aclJson: (data.aclJson as string | null | undefined) ?? null,
    description: (data.description as string | null | undefined) ?? null,
    createdAt: (data.createdAt as Date | undefined) ?? now,
    updatedAt: (data.updatedAt as Date | undefined) ?? now,
    deletedAt: (data.deletedAt as Date | null | undefined) ?? null,
  };
}

describe('asset upload limits and integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.s3Available = false;
    mocks.signedUrlCounter = 0;
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
  });

  it('uses a 1 GB hard cap without legacy 1.9.x wording', () => {
    expect(MAX_ASSET_BYTES).toBe(1024 * 1024 * 1024);
    const payload = assetTooLargeResponse(MAX_ASSET_BYTES + 1);

    expect(payload.error).toContain('1 GB limit');
    expect(payload.error).not.toContain('1.9');
    expect(payload.meta).toMatchObject({ hardCap: MAX_ASSET_BYTES });
  });

  it('keeps upload_hash_mismatch as a 422 before storage writes', async () => {
    const app = new Hono().route('/assets', createAssetsRouter());
    const form = new FormData();
    form.set('workspaceId', 'ws-1');
    form.set('file', new File(['actual bytes'], 'note.txt', { type: 'text/plain' }));

    const res = await app.request('/assets', {
      method: 'POST',
      headers: { 'x-content-sha256': sha256('different bytes') },
      body: form,
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'upload_hash_mismatch' },
      meta: { expected: sha256('different bytes'), actual: sha256('actual bytes'), bytes: 12 },
    });
    expect(mocks.prisma.iMAsset.findFirst).not.toHaveBeenCalled();
  });
});

describe('asset.changed publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.s3Available = false;
    mocks.signedUrlCounter = 0;
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMAssetIndexCounter.upsert.mockResolvedValue({ workspaceId: 'ws-1', nextSeq: BigInt(2) });
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue({});
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) =>
      fn(mocks.prisma),
    );
  });

  it('publishes asset.changed to websocket and sync log after upload create', async () => {
    let createdRow = makeAssetRow();
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdRow = makeAssetRow({ id: 'asset-create-1', ...data });
      return createdRow;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => createdRow);

    const rooms = { sendToUser: vi.fn() };
    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(rooms as never, syncService as never));
    const form = new FormData();
    form.set('workspaceId', 'ws-1');
    form.set('file', new File(['asset bytes'], 'asset.bin', { type: 'application/octet-stream' }));

    const res = await app.request('/assets', { method: 'POST', body: form });

    expect(res.status).toBe(201);
    expect(rooms.sendToUser).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        type: 'asset.changed',
        payload: expect.objectContaining({
          workspaceId: 'ws-1',
          assetId: 'asset-create-1',
          operation: 'create',
          contentHash: sha256('asset bytes'),
          assetIndexSeq: 1,
          revision: 1,
        }),
      }),
    );
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'asset.changed',
      expect.objectContaining({ workspaceId: 'ws-1', assetId: 'asset-create-1', operation: 'create' }),
      null,
      'owner-1',
    );
  });

  it('does not block large table uploads on synchronous memory-page ingest', async () => {
    const csv = Buffer.alloc(1024 * 1024 + 1, 0x61);
    csv.write('col_a,col_b\n');
    let createdRow = makeAssetRow();
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdRow = makeAssetRow({ id: 'asset-large-csv-1', ...data });
      return createdRow;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => createdRow);

    const app = new Hono().route('/assets', createAssetsRouter());
    const form = new FormData();
    form.set('workspaceId', 'ws-1');
    form.set('file', new File([csv], 'large.csv', { type: 'text/csv' }));

    const res = await app.request('/assets', { method: 'POST', body: form });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      id: 'asset-large-csv-1',
      mime: 'text/csv',
      ingestStatus: 'asset-only',
    });
    expect(mocks.memoryUpsertFromAsset).not.toHaveBeenCalled();
  });

  it('creates a thumbnail derivative and fills preview URLs for raster image uploads', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: {
        width: 640,
        height: 320,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const pngHash = sha256(png);
    let currentParent = makeAssetRow({
      id: 'asset-image-1',
      contentHash: pngHash,
      sizeBytes: BigInt(png.length),
      mime: 'image/png',
      filename: 'image.png',
    });
    let createdThumbnail: ReturnType<typeof makeAssetRow> | null = null;
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.derivationKind === 'thumbnail') {
        createdThumbnail = makeAssetRow({ id: 'asset-thumb-1', ...data });
        return createdThumbnail;
      }
      currentParent = makeAssetRow({ id: 'asset-image-1', ...data });
      return currentParent;
    });
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      currentParent = makeAssetRow({
        ...currentParent,
        ...data,
        assetIndexSeq: data.assetIndexSeq ?? currentParent.assetIndexSeq,
        revision:
          data.revision && typeof data.revision === 'object' && 'increment' in data.revision
            ? currentParent.revision + Number(data.revision.increment)
            : currentParent.revision,
      });
      return currentParent;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => currentParent);

    const rooms = { sendToUser: vi.fn() };
    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(rooms as never, syncService as never));
    const form = new FormData();
    form.set('workspaceId', 'ws-1');
    form.set('file', new File([png], 'image.png', { type: 'image/png' }));

    const res = await app.request('/assets', { method: 'POST', body: form });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(createdThumbnail).toMatchObject({
      parentAssetId: 'asset-image-1',
      derivationKind: 'thumbnail',
      mime: 'image/webp',
      kind: 'preview',
    });
    expect(body.data).toMatchObject({
      id: 'asset-image-1',
      thumbnailUrl: '/api/im/assets/asset-thumb-1',
      previewUrls: { medium: '/api/im/assets/asset-thumb-1' },
      revision: 2,
    });
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'asset.changed',
      expect.objectContaining({ assetId: 'asset-image-1', revision: 2 }),
      null,
      'owner-1',
    );
  });

  it('creates a PDF first-page thumbnail derivative when the local renderer succeeds', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
    const pdfHash = sha256(pdfBytes);
    const thumbBytes = Buffer.from('pdf thumbnail webp bytes');
    const thumbHash = sha256(thumbBytes);
    vi.mocked(createPdfFirstPageThumbnailForPreview).mockResolvedValueOnce({
      status: 'success',
      buffer: thumbBytes,
      contentHash: thumbHash,
      mime: 'image/webp',
      width: 300,
      height: 420,
      page: 1,
      tool: 'pdftoppm',
      toolVersion: 'pdftoppm version test',
    });
    let currentParent = makeAssetRow({
      id: 'asset-pdf-1',
      contentHash: pdfHash,
      sizeBytes: BigInt(pdfBytes.length),
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
    let createdThumbnail: ReturnType<typeof makeAssetRow> | null = null;
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.derivationKind === 'thumbnail') {
        createdThumbnail = makeAssetRow({ id: 'asset-pdf-thumb-1', ...data });
        return createdThumbnail;
      }
      currentParent = makeAssetRow({ id: 'asset-pdf-1', ...data });
      return currentParent;
    });
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      currentParent = makeAssetRow({
        ...currentParent,
        ...data,
        assetIndexSeq: data.assetIndexSeq ?? currentParent.assetIndexSeq,
        revision:
          data.revision && typeof data.revision === 'object' && 'increment' in data.revision
            ? currentParent.revision + Number(data.revision.increment)
            : currentParent.revision,
      });
      return currentParent;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => currentParent);

    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(undefined, syncService as never));
    const form = new FormData();
    form.set('workspaceId', 'ws-1');
    form.set('file', new File([pdfBytes], 'report.pdf', { type: 'application/pdf' }));

    const res = await app.request('/assets', { method: 'POST', body: form });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(createdThumbnail).toMatchObject({
      parentAssetId: 'asset-pdf-1',
      derivationKind: 'thumbnail',
      mime: 'image/webp',
      filename: 'report.page1.webp',
    });
    expect(body.data).toMatchObject({
      id: 'asset-pdf-1',
      thumbnailUrl: '/api/im/assets/asset-pdf-thumb-1',
      previewUrls: { medium: '/api/im/assets/asset-pdf-thumb-1' },
      revision: 2,
    });
  });
});

describe('asset direct upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.s3Available = true;
    mocks.signedUrlCounter = 0;
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMAssetIndexCounter.upsert.mockResolvedValue({ workspaceId: 'ws-1', nextSeq: BigInt(2) });
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue({});
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) =>
      fn(mocks.prisma),
    );
  });

  it('creates a single-part direct upload plan with a CDN URL', async () => {
    const app = new Hono().route('/assets', createAssetsRouter());
    const bytes = Buffer.from('direct upload body');
    const hash = sha256(bytes);

    const res = await app.request('/assets/direct-upload/init', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        filename: 'direct.txt',
        mime: 'text/plain',
        sizeBytes: bytes.length,
        contentHash: hash,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        mode: 'single',
        bucket: 'asset-bucket',
        key: `assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
        storageUri: `s3://asset-bucket/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
        cdnUrl: `https://cdn.example.test/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
        uploadUrl: 'https://signed.example.test/1',
        method: 'PUT',
        // S50b — server intentionally dropped `x-amz-meta-sha256` from the
        // returned header set on 2026-05-20 (see assets.ts §direct-upload/init
        // comment). The presigner encodes the sha256 into the URL query, and
        // duplicating it as a PUT header caused S3 V4 sig validator to 403.
        headers: { 'Content-Type': 'text/plain' },
      },
    });
  });

  it('completes a direct upload, validates streamed hash, stores cdnUrl, and publishes asset.changed', async () => {
    const bytes = Buffer.from('direct upload body');
    const hash = sha256(bytes);
    let createdRow = makeAssetRow();
    mocks.s3Client.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length };
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
      }
      return {};
    });
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdRow = makeAssetRow({ id: 'asset-direct-1', ...data });
      return createdRow;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => createdRow);

    const rooms = { sendToUser: vi.fn() };
    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(rooms as never, syncService as never));
    const res = await app.request('/assets/direct-upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        filename: 'direct.bin',
        mime: 'application/octet-stream',
        sizeBytes: bytes.length,
        contentHash: hash,
        key: `assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
        bucket: 'asset-bucket',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      id: 'asset-direct-1',
      contentHash: hash,
      storageUri: `s3://asset-bucket/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
      cdnUrl: `https://cdn.example.test/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
      filename: 'direct.bin',
      sourceKind: 'direct-upload',
    });
    expect(mocks.s3Client.send).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
    expect(mocks.s3Client.send).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'asset.changed',
      expect.objectContaining({ assetId: 'asset-direct-1', operation: 'create', revision: 1 }),
      null,
      'owner-1',
    );
  });

  it('creates local preview derivatives after direct-upload completion for eligible image bytes', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 4,
        background: { r: 80, g: 40, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const hash = sha256(png);
    let currentParent = makeAssetRow({
      id: 'asset-direct-image-1',
      contentHash: hash,
      storageUri: `s3://asset-bucket/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
      sizeBytes: BigInt(png.length),
      mime: 'image/png',
      filename: 'direct-image.png',
      cdnUrl: `https://cdn.example.test/assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
    });
    let createdThumbnail: ReturnType<typeof makeAssetRow> | null = null;
    mocks.s3Client.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: png.length };
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(png) } };
      }
      return {};
    });
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.derivationKind === 'thumbnail') {
        createdThumbnail = makeAssetRow({ id: 'asset-direct-thumb-1', ...data });
        return createdThumbnail;
      }
      currentParent = makeAssetRow({ id: 'asset-direct-image-1', ...data });
      return currentParent;
    });
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      currentParent = makeAssetRow({
        ...currentParent,
        ...data,
        assetIndexSeq: data.assetIndexSeq ?? currentParent.assetIndexSeq,
        revision:
          data.revision && typeof data.revision === 'object' && 'increment' in data.revision
            ? currentParent.revision + Number(data.revision.increment)
            : currentParent.revision,
      });
      return currentParent;
    });
    mocks.prisma.iMAsset.findUnique.mockImplementation(async () => currentParent);

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/direct-upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        filename: 'direct-image.png',
        mime: 'image/png',
        sizeBytes: png.length,
        contentHash: hash,
        key: `assets/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
        bucket: 'asset-bucket',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(createdThumbnail).toMatchObject({
      parentAssetId: 'asset-direct-image-1',
      derivationKind: 'thumbnail',
      mime: 'image/webp',
      kind: 'preview',
      cdnUrl: null,
    });
    expect(body.data).toMatchObject({
      id: 'asset-direct-image-1',
      thumbnailUrl: '/api/im/assets/asset-direct-thumb-1',
      previewUrls: { medium: '/api/im/assets/asset-direct-thumb-1' },
      revision: 2,
    });
  });

  it('rejects direct upload completion when streamed SHA-256 mismatches', async () => {
    const expectedHash = sha256('expected body');
    const actual = Buffer.from('actual body');
    mocks.s3Client.send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: actual.length };
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(actual) } };
      }
      return {};
    });

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/direct-upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: 'ws-1',
        filename: 'direct.txt',
        mime: 'text/plain',
        sizeBytes: actual.length,
        contentHash: expectedHash,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'upload_hash_mismatch' },
      meta: { expected: expectedHash, actual: sha256(actual), bytes: actual.length },
    });
    expect(mocks.prisma.iMAsset.create).not.toHaveBeenCalled();
  });
});

describe('putS3Object multipart helper', () => {
  it('uses PutObject with a SHA-256 checksum below the multipart threshold', async () => {
    const sent: S3CommandLike[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command as S3CommandLike);
        return {};
      }),
    };
    const bytes = Buffer.from('small object');
    const hash = sha256(bytes);

    const result = await putS3Object({
      bucket: 'bucket',
      key: 'assets/hash',
      body: bytes,
      contentType: 'text/plain',
      contentHashSha256Hex: hash,
      multipartThresholdBytes: bytes.length + 1,
      client: client as unknown as PutS3ObjectClient,
    });

    expect(result).toEqual({ bucket: 'bucket', key: 'assets/hash', mode: 'single', partCount: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'assets/hash',
      ContentType: 'text/plain',
      ContentLength: bytes.length,
      ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
      Metadata: { sha256: hash },
    });
  });

  it('uses multipart upload above the multipart threshold', async () => {
    const sent: S3CommandLike[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        const recorded = command as S3CommandLike;
        sent.push(recorded);
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
        if (command instanceof UploadPartCommand) return { ETag: `"etag-${recorded.input.PartNumber}"` };
        return {};
      }),
    };
    const partSize = 5 * 1024 * 1024;
    const bytes = Buffer.alloc(partSize + 3, 7);
    const hash = sha256(bytes);

    const result = await putS3Object({
      bucket: 'bucket',
      key: 'assets/hash',
      body: bytes,
      contentType: 'application/octet-stream',
      contentHashSha256Hex: hash,
      multipartThresholdBytes: 1,
      partSizeBytes: partSize,
      client: client as unknown as PutS3ObjectClient,
    });

    expect(result).toEqual({ bucket: 'bucket', key: 'assets/hash', mode: 'multipart', partCount: 2 });
    expect(sent.map((command) => command.constructor.name)).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ]);
    expect(sent[0].input.Metadata).toEqual({ sha256: hash });
    expect(sent[1].input).toMatchObject({ UploadId: 'upload-1', PartNumber: 1, ContentLength: partSize });
    expect(sent[2].input).toMatchObject({ UploadId: 'upload-1', PartNumber: 2, ContentLength: 3 });
    expect(sent[3]).toBeInstanceOf(CompleteMultipartUploadCommand);
    const completeInput = sent[3].input as { MultipartUpload: { Parts: Array<{ ETag: string; PartNumber: number }> } };
    expect(completeInput.MultipartUpload.Parts).toEqual([
      { ETag: '"etag-1"', PartNumber: 1 },
      { ETag: '"etag-2"', PartNumber: 2 },
    ]);
  });

  it('aborts multipart upload when any part fails', async () => {
    const sent: S3CommandLike[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        const recorded = command as S3CommandLike;
        sent.push(recorded);
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' };
        if (command instanceof UploadPartCommand && recorded.input.PartNumber === 2) {
          throw new Error('part failed');
        }
        if (command instanceof UploadPartCommand) return { ETag: `"etag-${recorded.input.PartNumber}"` };
        return {};
      }),
    };
    const partSize = 5 * 1024 * 1024;

    await expect(
      putS3Object({
        bucket: 'bucket',
        key: 'assets/hash',
        body: Buffer.alloc(partSize + 1, 3),
        multipartThresholdBytes: 1,
        partSizeBytes: partSize,
        client: client as unknown as PutS3ObjectClient,
      }),
    ).rejects.toThrow('part failed');

    const last = sent.at(-1);
    expect(last).toBeInstanceOf(AbortMultipartUploadCommand);
    expect((last as S3CommandLike).input).toMatchObject({ Bucket: 'bucket', Key: 'assets/hash', UploadId: 'upload-1' });
  });
});
