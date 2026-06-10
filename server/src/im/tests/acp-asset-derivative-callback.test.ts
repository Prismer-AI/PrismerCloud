import * as crypto from 'crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    iMAsset: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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
  authMiddleware: vi.fn(async () => {
    throw new Error('authMiddleware should not run for internal derivative callback');
  }),
}));
vi.mock('../services/asset-memory-bridge.service', () => ({
  PHOTO_MEMORY_SEGMENT_KIND: 'photo-memory-segment',
  upsertPhotoMemorySegmentMemoryFile: vi.fn(),
}));
vi.mock('../services/memory-page.service', () => ({
  MemoryPageService: class {
    listPages = vi.fn().mockResolvedValue([]);
    upsertFromAsset = vi.fn();
  },
}));
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
  getSignedUrl: vi.fn(),
}));

import { createAssetsRouter } from '../api/assets';

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assetRow(data: Record<string, unknown> = {}) {
  const now = new Date('2026-05-18T00:00:00.000Z');
  return {
    id: (data.id as string | undefined) ?? 'asset-parent-1',
    workspaceId: (data.workspaceId as string | undefined) ?? 'ws-1',
    ownerImUserId: (data.ownerImUserId as string | undefined) ?? 'owner-1',
    contentHash: (data.contentHash as string | undefined) ?? sha256('parent bytes'),
    storageUri: (data.storageUri as string | undefined) ?? 's3://asset-bucket/assets/parent',
    sizeBytes: (data.sizeBytes as bigint | undefined) ?? BigInt(12),
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
    workspace: (data.workspace as { ownerImUserId: string } | undefined) ?? { ownerImUserId: 'owner-1' },
  };
}

describe('asset derivative callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSET_DERIVATIVE_CALLBACK_SECRET = 'internal-secret';
    mocks.prisma.iMAsset.findFirst.mockResolvedValue(null);
    mocks.prisma.iMAssetRevision.create.mockResolvedValue({});
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue({});
    mocks.prisma.iMAssetIndexCounter.upsert
      .mockResolvedValueOnce({ workspaceId: 'ws-1', nextSeq: BigInt(2) })
      .mockResolvedValueOnce({ workspaceId: 'ws-1', nextSeq: BigInt(3) });
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) =>
      fn(mocks.prisma),
    );
  });

  it('rejects missing or invalid internal secret before auth middleware', async () => {
    const app = new Hono().route('/assets', createAssetsRouter());

    const res = await app.request('/assets/internal/derivatives/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset-parent-1', derivationKind: 'thumbnail' }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'asset_derivative_callback_unauthorized' },
    });
    expect(mocks.prisma.iMAsset.findUnique).not.toHaveBeenCalled();
  });

  it('attaches a thumbnail derivative and updates parent preview fields', async () => {
    const parent = assetRow({ id: 'asset-image-1', mime: 'image/png', filename: 'image.png' });
    const thumbHash = sha256('thumbnail bytes');
    let createdDerivative = assetRow();
    let updatedParent = parent;
    mocks.prisma.iMAsset.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === parent.id ? parent : null,
    );
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdDerivative = assetRow({ id: 'asset-thumb-1', ...data });
      return createdDerivative;
    });
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      updatedParent = assetRow({
        ...parent,
        ...data,
        assetIndexSeq: data.assetIndexSeq,
        revision: parent.revision + 1,
      });
      return updatedParent;
    });
    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(undefined, syncService as never));

    const res = await app.request('/assets/internal/derivatives/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-prismer-internal-secret': 'internal-secret' },
      body: JSON.stringify({
        assetId: parent.id,
        workspaceId: 'ws-1',
        derivationKind: 'thumbnail',
        contentHash: thumbHash,
        storageUri: `s3://asset-bucket/asset-previews/thumb/${thumbHash}.webp`,
        sizeBytes: 1234,
        mime: 'image/webp',
        filename: 'image.thumb.webp',
        metadata: { width: 512, height: 320 },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(createdDerivative).toMatchObject({
      parentAssetId: parent.id,
      derivationKind: 'thumbnail',
      cdnUrl: `https://cdn.example.test/asset-previews/thumb/${thumbHash}.webp`,
    });
    expect(body.data.parent).toMatchObject({
      id: parent.id,
      thumbnailUrl: `https://cdn.example.test/asset-previews/thumb/${thumbHash}.webp`,
      previewUrls: { medium: `https://cdn.example.test/asset-previews/thumb/${thumbHash}.webp` },
      revision: 2,
    });
    expect(mocks.prisma.iMAssetRevision.upsert).toHaveBeenCalledTimes(2);
  });

  it('attaches an HLS manifest derivative, updates parent contract fields, and publishes asset.changed', async () => {
    const parent = assetRow({
      id: 'asset-video-1',
      mime: 'video/mp4',
      filename: 'clip.mp4',
      contentHash: sha256('video bytes'),
      metadata: JSON.stringify({ filename: 'clip.mp4' }),
    });
    const manifestHash = sha256('#EXTM3U\n');
    const manifestUrl = 'https://cdn.example.test/asset-previews/hls/master.m3u8';
    let createdDerivative = assetRow();
    let updatedParent = parent;
    mocks.prisma.iMAsset.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === parent.id ? parent : null,
    );
    mocks.prisma.iMAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      createdDerivative = assetRow({ id: 'asset-hls-1', ...data });
      return createdDerivative;
    });
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      updatedParent = assetRow({
        ...parent,
        ...data,
        assetIndexSeq: data.assetIndexSeq,
        revision: parent.revision + 1,
      });
      return updatedParent;
    });
    const rooms = { sendToUser: vi.fn() };
    const syncService = { writeEvent: vi.fn().mockResolvedValue(undefined) };
    const app = new Hono().route('/assets', createAssetsRouter(rooms as never, syncService as never));

    const res = await app.request('/assets/internal/derivatives/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer internal-secret' },
      body: JSON.stringify({
        assetId: parent.id,
        derivationKind: 'hls-manifest',
        contentHash: manifestHash,
        storageUri: 's3://asset-bucket/asset-previews/hls/master.m3u8',
        cdnUrl: manifestUrl,
        mime: 'application/vnd.apple.mpegurl',
        filename: 'master.m3u8',
        metadata: {
          plannerVersion: 1,
          variants: ['720p'],
          outputKeys: { manifestKey: 'asset-previews/hls/master.m3u8' },
        },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(createdDerivative).toMatchObject({
      id: 'asset-hls-1',
      derivationKind: 'hls-manifest',
      mime: 'application/vnd.apple.mpegurl',
    });
    expect(body.data.parent).toMatchObject({
      id: parent.id,
      previewAssetId: 'asset-hls-1',
      revision: 2,
    });
    expect(body.data.parent.cdnUrl).toBeNull();
    expect(rooms.sendToUser).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        type: 'asset.changed',
        payload: expect.objectContaining({
          workspaceId: 'ws-1',
          assetId: parent.id,
          operation: 'update',
          assetIndexSeq: 2,
          revision: 2,
        }),
      }),
    );
    expect(syncService.writeEvent).toHaveBeenCalledWith(
      'asset.changed',
      expect.objectContaining({ assetId: parent.id, operation: 'update', revision: 2 }),
      null,
      'owner-1',
    );
  });
});
