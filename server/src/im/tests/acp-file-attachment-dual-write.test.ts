// 2026-05-31 release201/30 §7 — `deriveFileMessageAttachment` dual-write tests.
//
// 验证：cloud message handler 看到 type='file' message 时，从 metadata.uploadId
// 反查 im_file_uploads → lookup-or-create IMAsset → 返回 AssetAttachment。
// SDK 协议（metadata.fileUrl）保留不动，cloud 端补 attachments[]，前端 Phase 2
// 切换渲染时即可看到真 IMAsset 卡片。
//
// 模式抄自 acp-message-attachments.test.ts 的 vitest mock 框架。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  iMFileUpload: {
    findUnique: vi.fn(),
  },
  iMConversation: {
    findUnique: vi.fn(),
  },
  iMAsset: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  // release201/30 §7 fix — derive now allocates an assetIndexSeq so the asset
  // shows in the library + is servable. Default stub returns seq 2 (→ allocated 1).
  iMAssetIndexCounter: {
    upsert: vi.fn(),
  },
  // release202 — deriveFileMessageAttachment stamps metadata.conversationId on
  // every message-attached asset (JSON_SET-when-missing) so conversation-scoped
  // surfaces (sessionAssets) are reliable regardless of creation path.
  $executeRaw: vi.fn().mockResolvedValue(0),
}));

vi.mock('../db', () => ({ default: prisma }));

function resetMocks() {
  vi.clearAllMocks();
  prisma.iMFileUpload.findUnique.mockReset();
  prisma.iMConversation.findUnique.mockReset();
  prisma.iMAsset.findFirst.mockReset();
  prisma.iMAsset.create.mockReset();
  prisma.iMAssetIndexCounter.upsert.mockReset();
  prisma.iMAssetIndexCounter.upsert.mockResolvedValue({ nextSeq: BigInt(2) });
}

type DerivedHelper = (input: unknown) => Promise<unknown>;

async function getHelper(): Promise<DerivedHelper> {
  const { MessageService } = await import('../services/message.service');
  const service = new MessageService({ publish: vi.fn() } as never);
  const helper = (service as unknown as { deriveFileMessageAttachment: DerivedHelper }).deriveFileMessageAttachment;
  // bind to service instance so `this.` works inside
  return helper.bind(service as unknown as Record<string, unknown>) as DerivedHelper;
}

describe('release201/30 §7 — deriveFileMessageAttachment dual-write', () => {
  beforeEach(resetMocks);

  it('returns null for non-file message', async () => {
    const fn = await getHelper();
    const out = await fn({
      type: 'text',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'hi',
      metadata: { uploadId: 'u_1' },
    });
    expect(out).toBeNull();
    expect(prisma.iMFileUpload.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when metadata.uploadId is missing', async () => {
    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'photo.png',
      metadata: { fileUrl: '/api/...' },
    });
    expect(out).toBeNull();
    expect(prisma.iMFileUpload.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when upload is not confirmed', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      id: 'up_1',
      uploadId: 'u_1',
      status: 'pending',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      sha256: 'abc',
      imUserId: 'human_1',
    });
    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'photo.png',
      metadata: { uploadId: 'u_1' },
    });
    expect(out).toBeNull();
  });

  it('returns null when conversation has no workspaceId', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'u_1',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      sha256: 'abc',
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: null });
    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'photo.png',
      metadata: { uploadId: 'u_1' },
    });
    expect(out).toBeNull();
  });

  it('returns null when upload.sha256 is missing (cannot dedupe safely)', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'u_1',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'photo.png',
      fileSize: 1024,
      mimeType: 'image/png',
      sha256: null,
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'photo.png',
      metadata: { uploadId: 'u_1' },
    });
    expect(out).toBeNull();
    expect(prisma.iMAsset.findFirst).not.toHaveBeenCalled();
  });

  it('dedupes to existing IMAsset by contentHash (no create)', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'u_1',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'photo.png',
      fileSize: 2048,
      mimeType: 'image/png',
      sha256: 'hash_abc',
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prisma.iMAsset.findFirst.mockResolvedValue({
      id: 'asset_exist',
      contentHash: 'hash_abc',
      mime: 'image/png',
      sizeBytes: BigInt(2048),
      filename: 'old-name.png',
    });

    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'photo.png',
      metadata: { uploadId: 'u_1', fileUrl: '/api/...', traceId: 'trace_xyz' },
    });

    expect(out).toEqual({
      kind: 'image',
      assetId: 'asset_exist',
      contentHash: 'hash_abc',
      mime: 'image/png',
      sizeBytes: 2048,
      filename: 'old-name.png',
    });
    expect(prisma.iMAsset.create).not.toHaveBeenCalled();
  });

  it('creates new IMAsset with metadata.pipeline strong schema when absent', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'u_1',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'report.pdf',
      fileSize: 1024 * 100,
      mimeType: 'application/pdf',
      sha256: 'hash_new',
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prisma.iMAsset.findFirst.mockResolvedValue(null);
    prisma.iMAsset.create.mockResolvedValue({
      id: 'asset_new',
      contentHash: 'hash_new',
      mime: 'application/pdf',
      sizeBytes: BigInt(102400),
      filename: 'report.pdf',
    });

    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'report.pdf',
      metadata: { uploadId: 'u_1', fileUrl: '/api/...', traceId: 'trace_lol' },
    });

    expect(out).toEqual({
      kind: 'file',
      assetId: 'asset_new',
      contentHash: 'hash_new',
      mime: 'application/pdf',
      sizeBytes: 102400,
      filename: 'report.pdf',
    });
    expect(prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.iMAsset.create.mock.calls[0][0] as {
      data: { metadata: string; boundKind: string; workspaceId: string; contentHash: string };
    };
    const meta = JSON.parse(createArgs.data.metadata);
    expect(meta.pipeline).toEqual({
      version: 1,
      deliveryPath: 'cli-send',
      originatedBy: 'cli-explicit',
      traceId: 'trace_lol',
      sourcePath: 'report.pdf',
    });
    expect(createArgs.data.boundKind).toBe('workspace-file');
    expect(createArgs.data.workspaceId).toBe('ws_1');
    expect(createArgs.data.contentHash).toBe('hash_new');
  });

  it('stores a byte-servable storageUri (file:// in dev), not the display cdnUrl', async () => {
    // release201/30 §7 regression — the asset bytes endpoint only understands
    // file:// and s3:// schemes. Storing upload.cdnUrl (e.g.
    // /api/im/files/dev-download/…) produced "Unsupported storageUri scheme"
    // → 500 → "Asset unavailable". In dev (no S3 creds) we must resolve the
    // local upload path as file://.
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'fu_dev_abc123def456',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/fu_dev_abc123def456/report.pdf',
      s3Key: null,
      fileName: 'report.pdf',
      fileSize: 1024 * 100,
      mimeType: 'application/pdf',
      sha256: 'hash_dev',
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    prisma.iMAsset.findFirst.mockResolvedValue(null);
    prisma.iMAsset.create.mockResolvedValue({
      id: 'asset_dev',
      contentHash: 'hash_dev',
      mime: 'application/pdf',
      sizeBytes: BigInt(102400),
      filename: 'report.pdf',
    });

    const fn = await getHelper();
    await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'report.pdf',
      metadata: { uploadId: 'fu_dev_abc123def456' },
    });

    expect(prisma.iMAsset.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.iMAsset.create.mock.calls[0][0] as {
      data: { storageUri: string; cdnUrl: string | null };
    };
    // storageUri must be a servable scheme — never the display URL.
    expect(createArgs.data.storageUri.startsWith('file://')).toBe(true);
    expect(createArgs.data.storageUri.endsWith('/report.pdf')).toBe(true);
    expect(createArgs.data.storageUri).not.toContain('dev-download');
    // cdnUrl keeps the display URL untouched (frontend territory).
    expect(createArgs.data.cdnUrl).toBe('/api/im/files/dev-download/fu_dev_abc123def456/report.pdf');
  });

  it('falls back to second findFirst when create races (UNIQUE conflict)', async () => {
    prisma.iMFileUpload.findUnique.mockResolvedValue({
      uploadId: 'u_1',
      status: 'confirmed',
      cdnUrl: '/api/im/files/dev-download/u_1',
      fileName: 'race.png',
      fileSize: 4096,
      mimeType: 'image/png',
      sha256: 'hash_race',
      imUserId: 'human_1',
    });
    prisma.iMConversation.findUnique.mockResolvedValue({ workspaceId: 'ws_1' });
    // 第一次 findFirst 没命中
    prisma.iMAsset.findFirst.mockResolvedValueOnce(null);
    // create 因 UNIQUE conflict 抛
    prisma.iMAsset.create.mockRejectedValueOnce(new Error('P2002 unique constraint violation'));
    // race fallback：第二次 findFirst 命中
    prisma.iMAsset.findFirst.mockResolvedValueOnce({
      id: 'asset_race_winner',
      contentHash: 'hash_race',
      mime: 'image/png',
      sizeBytes: BigInt(4096),
      filename: 'race.png',
    });

    const fn = await getHelper();
    const out = await fn({
      type: 'file',
      conversationId: 'conv_1',
      senderId: 'human_1',
      content: 'race.png',
      metadata: { uploadId: 'u_1' },
    });

    expect(out).toEqual({
      kind: 'image',
      assetId: 'asset_race_winner',
      contentHash: 'hash_race',
      mime: 'image/png',
      sizeBytes: 4096,
      filename: 'race.png',
    });
    expect(prisma.iMAsset.findFirst).toHaveBeenCalledTimes(2);
  });
});
