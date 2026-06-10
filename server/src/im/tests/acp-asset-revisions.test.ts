import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono, type Context, type Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { imUserId: 'owner-1', role: 'human' },
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
    iMAssetRevision: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    iMAssetIndexCounter: { upsert: vi.fn() },
    iMKnowledgeLink: { findMany: vi.fn() },
    iMMemoryPage: { findMany: vi.fn() },
    iMTaskRun: { findMany: vi.fn() },
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
    upsertFromAsset = vi.fn();
  },
}));

import { createAssetsRouter } from '../api/assets';

const now = new Date('2026-05-18T00:00:00.000Z');

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    workspaceId: 'ws-1',
    ownerImUserId: 'owner-1',
    contentHash: 'a'.repeat(64),
    storageUri: 'file:///tmp/current-asset',
    sizeBytes: BigInt(7),
    mime: 'text/plain',
    kind: 'file',
    sourceAgentImUserId: null,
    sourceTaskId: null,
    metadata: JSON.stringify({ filename: 'current.txt' }),
    parentAssetId: null,
    derivationKind: null,
    ingestStatus: 'asset-only',
    ingestVersion: 1,
    ingestError: null,
    assetIndexSeq: BigInt(1),
    cdnUrl: null,
    thumbnailUrl: null,
    previewUrls: null,
    previewAssetId: null,
    folderPath: null,
    filename: 'current.txt',
    sourceRef: 'upload://ws-1/current',
    sourceKind: 'upload',
    sourceMetadata: '{}',
    revision: 2,
    visibility: 'workspace',
    aclJson: null,
    description: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    workspace: { ownerImUserId: 'owner-1' },
    ...overrides,
  };
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    assetId: 'asset-1',
    workspaceId: 'ws-1',
    revision: 1,
    contentHash: 'b'.repeat(64),
    storageUri: 'file:///tmp/revision-asset',
    sizeBytes: BigInt(11),
    mime: 'text/plain',
    kind: 'file',
    ownerImUserId: 'owner-1',
    sourceAgentImUserId: null,
    sourceTaskId: null,
    metadata: JSON.stringify({ filename: 'revision-one.txt', title: 'Revision One' }),
    parentAssetId: null,
    derivationKind: null,
    ingestStatus: 'asset-only',
    ingestVersion: 1,
    ingestError: null,
    cdnUrl: null,
    thumbnailUrl: null,
    previewUrls: null,
    previewAssetId: null,
    folderPath: null,
    filename: 'revision-one.txt',
    sourceRef: 'upload://ws-1/revision-one',
    sourceKind: 'upload',
    sourceMetadata: '{}',
    visibility: 'workspace',
    aclJson: null,
    description: null,
    deletedAt: null,
    createdByImUserId: 'owner-1',
    reason: 'created',
    createdAt: now,
    ...overrides,
  };
}

describe('asset revision snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMAsset.findMany.mockResolvedValue([]);
    mocks.prisma.iMKnowledgeLink.findMany.mockResolvedValue([]);
    mocks.prisma.iMMemoryPage.findMany.mockResolvedValue([]);
  });

  it('lists revisions and backfills the current snapshot for immutable assets', async () => {
    const current = assetRow({ revision: 1 });
    const currentRevision = revisionRow({
      revision: 1,
      contentHash: current.contentHash,
      storageUri: current.storageUri,
      sizeBytes: current.sizeBytes,
      filename: current.filename,
    });
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(current);
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue(currentRevision);
    mocks.prisma.iMAssetRevision.findMany.mockResolvedValue([currentRevision]);

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions');

    expect(res.status).toBe(200);
    expect(mocks.prisma.iMAssetRevision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assetId_revision: { assetId: 'asset-1', revision: 1 } },
        create: expect.objectContaining({ assetId: 'asset-1', revision: 1, reason: 'backfill-current' }),
        update: {},
      }),
    );
    const body = await res.json();
    expect(body.data).toMatchObject({
      assetId: 'asset-1',
      currentRevision: 1,
      items: [{ revision: 1, filename: 'current.txt' }],
    });
  });

  it('skips duplicate current snapshot backfill without creating a noisy unique violation', async () => {
    const current = assetRow({ revision: 1 });
    const currentRevision = revisionRow({
      revision: 1,
      contentHash: current.contentHash,
      storageUri: current.storageUri,
      sizeBytes: current.sizeBytes,
      filename: current.filename,
    });
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(current);
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue(currentRevision);
    mocks.prisma.iMAssetRevision.findMany.mockResolvedValue([currentRevision]);

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions');

    expect(res.status).toBe(200);
    expect(mocks.prisma.iMAssetRevision.create).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assetId_revision: { assetId: 'asset-1', revision: 1 } },
        update: {},
      }),
    );
    const body = await res.json();
    expect(body.data.items).toEqual([expect.objectContaining({ revision: 1 })]);
  });

  it('serves detail metadata for a requested revision', async () => {
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(assetRow());
    mocks.prisma.iMAssetRevision.findUnique.mockResolvedValue(revisionRow());

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/detail?revision=1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: 'asset-1',
      revision: 1,
      filename: 'revision-one.txt',
      contentHash: 'b'.repeat(64),
      metadata: { filename: 'revision-one.txt', title: 'Revision One' },
    });
  });

  it('serves bytes for a requested filesystem revision', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asset-revision-test-'));
    const filePath = path.join(dir, 'rev1.txt');
    await fs.promises.writeFile(filePath, 'rev1 bytes');
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(assetRow());
    mocks.prisma.iMAssetRevision.findUnique.mockResolvedValue(
      revisionRow({ storageUri: `file://${filePath}`, sizeBytes: BigInt(10) }),
    );

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1?revision=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${'b'.repeat(64)}:1"`);
    expect(await res.text()).toBe('rev1 bytes');
  });
});

describe('POST /assets/:id/revisions — edit content as a new revision', () => {
  let storageDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.user.imUserId = 'owner-1';
    mocks.user.role = 'human';
    storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asset-edit-test-'));
    process.env.ASSET_STORAGE_DIR = storageDir;
    delete process.env.ASSET_STORAGE_BACKEND; // filesystem
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMKnowledgeLink.findMany.mockResolvedValue([]);
    mocks.prisma.iMMemoryPage.findMany.mockResolvedValue([]);
    // $transaction runs the callback with the same prisma mock.
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => unknown) =>
      fn(mocks.prisma),
    );
    mocks.prisma.iMAssetIndexCounter.upsert.mockResolvedValue({ workspaceId: 'ws-1', nextSeq: BigInt(8) });
  });

  function setupOwnedAsset(overrides: Record<string, unknown> = {}) {
    const current = assetRow({ revision: 2, mime: 'text/markdown', filename: 'note.md', ...overrides });
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(current);
    // snapshot-current backfill + new-revision snapshot both go through upsert/create
    mocks.prisma.iMAssetRevision.upsert.mockResolvedValue(revisionRow({ revision: 2 }));
    mocks.prisma.iMAssetRevision.create.mockResolvedValue(revisionRow({ revision: 3 }));
    return current;
  }

  it('writes edited markdown to a new immutable blob and bumps the revision', async () => {
    setupOwnedAsset();
    let updatedData: Record<string, unknown> = {};
    mocks.prisma.iMAsset.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      updatedData = data;
      return assetRow({ ...data, revision: 3, mime: 'text/markdown', filename: 'note.md' });
    });

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# edited body\n' }),
    });

    expect(res.status).toBe(201);
    // revision bumped via increment, fresh assetIndexSeq allocated
    expect(updatedData.revision).toEqual({ increment: 1 });
    expect(updatedData.assetIndexSeq).toEqual(BigInt(7));
    expect(updatedData.mime).toBe('text/markdown');
    expect(updatedData.ingestStatus).toBe('asset-only');

    // new blob: distinct sha256 of the edited bytes, distinct storageUri
    const expectedHash = crypto.createHash('sha256').update('# edited body\n').digest('hex');
    expect(updatedData.contentHash).toBe(expectedHash);
    expect(String(updatedData.storageUri)).toMatch(/^file:\/\//);
    expect(updatedData.contentHash).not.toBe('a'.repeat(64)); // not the prior contentHash
    expect(updatedData.sizeBytes).toEqual(BigInt(Buffer.from('# edited body\n', 'utf-8').length));

    // content actually landed on disk at the content-addressed path
    const onDisk = await fs.promises.readFile(String(updatedData.storageUri).slice('file://'.length), 'utf-8');
    expect(onDisk).toBe('# edited body\n');

    // a new revision snapshot row was upserted (immutability: prior revision untouched)
    expect(mocks.prisma.iMAssetRevision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ reason: 'edit' }) }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('asset-1');
  });

  it('rejects a non-owner / non-bound caller with 404', async () => {
    mocks.user.imUserId = 'stranger';
    mocks.prisma.iMWorkspace.findFirst.mockResolvedValue({ id: 'ws-1', ownerImUserId: 'owner-1' });
    mocks.prisma.iMAgentCard.findUnique.mockResolvedValue(null);
    setupOwnedAsset();

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });

    expect(res.status).toBe(404);
    expect(mocks.prisma.iMAsset.update).not.toHaveBeenCalled();
  });

  it('rejects a non-string content body with 400', async () => {
    setupOwnedAsset();
    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(400);
    expect(mocks.prisma.iMAsset.update).not.toHaveBeenCalled();
  });

  it('returns 410 for a soft-deleted asset', async () => {
    mocks.prisma.iMAsset.findUnique.mockResolvedValue(assetRow({ deletedAt: now }));
    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(410);
  });

  it('rejects a non-text asset (image/png) with 415 and does not touch storage/db', async () => {
    setupOwnedAsset({ mime: 'image/png', filename: 'pic.png' });

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'not really an image' }),
    });

    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'unsupported_asset_type', message: 'only text/markdown assets are editable' },
    });
    expect(mocks.prisma.iMAsset.update).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.create).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.upsert).not.toHaveBeenCalled();
  });

  it('short-circuits identical content: no new revision, returns 200 with current DTO', async () => {
    const unchanged = '# already saved\n';
    const contentHash = crypto.createHash('sha256').update(unchanged).digest('hex');
    setupOwnedAsset({ contentHash, mime: 'text/markdown', filename: 'note.md' });

    const app = new Hono().route('/assets', createAssetsRouter());
    const res = await app.request('/assets/asset-1/revisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: unchanged }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('asset-1');
    // revision NOT bumped, no snapshot, no blob write
    expect(mocks.prisma.iMAsset.update).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.create).not.toHaveBeenCalled();
    expect(mocks.prisma.iMAssetRevision.upsert).not.toHaveBeenCalled();
  });
});
