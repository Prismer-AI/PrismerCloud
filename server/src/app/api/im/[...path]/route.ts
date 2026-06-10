import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordUsageBackground, generateTaskId, PRICING } from '@/lib/usage-recorder';
import { apiGuard, generateIMTokenForUser, generateIMTokenForImUser } from '@/lib/api-guard';
import type { AuthInfo } from '@/lib/api-guard';
import { logger } from '@/lib/logger';

/**
 * IM API Route — In-process integration
 *
 * Calls the Hono IM app directly via app.fetch() — no HTTP proxy, no separate port.
 * All IM APIs are served on the same port 3000 as Next.js.
 *
 * Auth: Uses unified apiGuard for API Key / JWT validation.
 * API Key users get an IM JWT via guard.auth.imToken.
 */

interface ProxyContext {
  request: NextRequest;
  path: string;
  method: string;
  authHeader: string | null;
  originalAuthHeader: string | null;
  allowImAgentHeader?: boolean;
  searchParamOverrides?: Record<string, string>;
  assetUploadBytes?: Buffer;
  assetUploadFilename?: string | null;
  startTime: number;
}

type PreviewUrls = { small?: string; medium?: string; large?: string };

interface ProxyAssetIndexCounterClient {
  upsert(input: {
    where: { workspaceId: string };
    create: { workspaceId: string; nextSeq: bigint };
    update: { nextSeq: { increment: number } };
  }): Promise<{ nextSeq: bigint }>;
}

interface ProxyAssetRevisionClient {
  create(input: { data: ProxyAssetRevisionSnapshotData }): Promise<unknown>;
  upsert(input: {
    where: { assetId_revision: { assetId: string; revision: number } };
    create: ProxyAssetRevisionSnapshotData;
    update: Record<string, never>;
  }): Promise<unknown>;
}

interface ProxyAssetPrismaClient {
  iMAssetIndexCounter: ProxyAssetIndexCounterClient;
  iMAssetRevision: ProxyAssetRevisionClient;
}

interface ProxyAssetSnapshotRow {
  id: string;
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
}

type ProxyAssetRevisionSnapshotData = Omit<ProxyAssetSnapshotRow, 'id'> & {
  assetId: string;
  createdByImUserId: string | null;
  reason: string;
};

function proxyAssetRevisionSnapshotData(
  asset: ProxyAssetSnapshotRow,
  createdByImUserId: string | null,
  reason: string,
): ProxyAssetRevisionSnapshotData {
  return {
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
}

function isTextualContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/xml' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'image/svg+xml' ||
    mediaType.endsWith('+xml')
  );
}

function isAssetUploadPath(ctx: ProxyContext): boolean {
  return (
    ctx.method === 'POST' &&
    (ctx.path === 'assets' || /^assets\/[^/]+\/derived$/.test(ctx.path)) &&
    (ctx.request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')
  );
}

function isWorkspaceFileCreatePath(ctx: ProxyContext): boolean {
  return ctx.method === 'POST' && /^workspaces\/[^/]+\/files$/.test(ctx.path);
}

function isAssetMutationPath(ctx: ProxyContext): boolean {
  if (ctx.method === 'POST' && (ctx.path === 'assets' || /^assets\/[^/]+\/derived$/.test(ctx.path))) return true;
  return (ctx.method === 'PATCH' || ctx.method === 'DELETE') && /^assets\/[^/]+$/.test(ctx.path);
}

function isMessageSendPath(ctx: ProxyContext): boolean {
  return ctx.method === 'POST' && /^messages\/[^/]+$/.test(ctx.path);
}

function readBearerSubject(authHeader: string | null): string | null {
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

function parseExpectedUploadSha256(headerValue: string | null, formValue: FormDataEntryValue | null): string | null {
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

async function prepareAssetUploadForm(
  ctx: ProxyContext,
  headers: Record<string, string>,
): Promise<FormData | Response> {
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Expected multipart/form-data' }, { status: 400 });
  }

  let expected: string | null;
  try {
    expected = parseExpectedUploadSha256(
      ctx.request.headers.get('x-content-sha256'),
      form.get('contentSha256') ?? form.get('sha256'),
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'invalid_upload_hash',
          message: err instanceof Error ? err.message : 'Invalid upload SHA-256 digest',
        },
      },
      { status: 400 },
    );
  }

  const fileEntry = form.get('file');
  if (fileEntry instanceof File) {
    const bytes = Buffer.from(await fileEntry.arrayBuffer());
    ctx.assetUploadBytes = bytes;
    ctx.assetUploadFilename = fileEntry.name;
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (expected && expected !== actual) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'upload_hash_mismatch',
            message: 'Uploaded bytes do not match the declared SHA-256 digest. Please retry the upload.',
          },
          meta: { expected, actual, bytes: bytes.length },
        },
        { status: 422 },
      );
    }
  }

  // Re-forward FormData with a fresh multipart boundary. Keeping the original
  // Content-Type would retain a stale boundary from the consumed request.
  delete headers['Content-Type'];
  return form;
}

function normalizePreviewUrls(raw: unknown): PreviewUrls | null {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: PreviewUrls = {};
  for (const key of ['small', 'medium', 'large'] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isRasterImageAsset(mime: string | null | undefined, filename: string | null | undefined): boolean {
  const normalizedMime = (mime ?? '').toLowerCase();
  const normalizedName = (filename ?? '').toLowerCase();
  if (normalizedMime === 'image/svg+xml' || normalizedName.endsWith('.svg')) return false;
  if (normalizedMime.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|avif|tiff?|bmp)$/i.test(normalizedName);
}

function thumbnailFilename(filename: string | null | undefined, contentHash: string): string {
  const base = filename?.trim() || contentHash.slice(0, 16);
  return `${base.replace(/\.[^.]+$/, '')}.thumb.webp`;
}

function assetEndpoint(assetId: string): string {
  return `/api/im/assets/${encodeURIComponent(assetId)}`;
}

async function writeLocalThumbnailFile(contentHash: string, bytes: Buffer): Promise<string> {
  const dir = process.env.ASSET_STORAGE_DIR
    ? path.resolve(process.env.ASSET_STORAGE_DIR)
    : path.join(os.tmpdir(), 'prismer-cloud-assets');
  const subdir = path.join(dir, contentHash.slice(0, 2), contentHash.slice(2, 4));
  await fs.promises.mkdir(subdir, { recursive: true });
  const filePath = path.join(subdir, contentHash);
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === bytes.length) return `file://${filePath}`;
  } catch {
    /* write below */
  }
  await fs.promises.writeFile(filePath, bytes);
  return `file://${filePath}`;
}

async function allocateAssetIndexSeq(prismaClient: ProxyAssetPrismaClient, workspaceId: string): Promise<bigint> {
  const counter = await prismaClient.iMAssetIndexCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, nextSeq: BigInt(2) },
    update: { nextSeq: { increment: 1 } },
  });
  return counter.nextSeq - BigInt(1);
}

async function createAssetRevisionSnapshot(
  prismaClient: ProxyAssetPrismaClient,
  asset: ProxyAssetSnapshotRow,
  createdByImUserId: string | null,
  reason: string,
): Promise<void> {
  const create = proxyAssetRevisionSnapshotData(asset, createdByImUserId, reason);
  try {
    await prismaClient.iMAssetRevision.upsert({
      where: { assetId_revision: { assetId: asset.id, revision: asset.revision } },
      create,
      update: {},
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') return;
    throw err;
  }
}

async function ensureImageThumbnailProxyFallback(ctx: ProxyContext, responseData: unknown): Promise<unknown> {
  if (ctx.method !== 'POST' || ctx.path !== 'assets') return responseData;
  if (!ctx.assetUploadBytes) return responseData;
  if (!responseData || typeof responseData !== 'object') return responseData;
  const envelope = responseData as { ok?: unknown; data?: Record<string, unknown>; meta?: unknown };
  const data = envelope.data;
  if (envelope.ok !== true || !data || typeof data.id !== 'string') return responseData;

  const assetId = data.id;
  const mime = typeof data.mime === 'string' ? data.mime : null;
  const filename = typeof data.filename === 'string' ? data.filename : ctx.assetUploadFilename;
  if (!isRasterImageAsset(mime, filename)) return responseData;
  if (process.env.ASSET_STORAGE_BACKEND === 's3') return responseData;
  if (typeof data.thumbnailUrl === 'string' && data.thumbnailUrl) return responseData;
  if (normalizePreviewUrls(data.previewUrls)?.medium) return responseData;

  try {
    const sharpModule = await import('sharp');
    const sharp = (sharpModule.default ?? sharpModule) as unknown as typeof import('sharp');
    const output = await sharp(ctx.assetUploadBytes, {
      animated: false,
      failOn: 'none',
      limitInputPixels: 80_000_000,
    })
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumbHash = crypto.createHash('sha256').update(output.data).digest('hex');
    const storageUri = await writeLocalThumbnailFile(thumbHash, output.data);
    const prismaModule = await import('@/lib/prisma');
    const prismaClient = prismaModule.prisma ?? prismaModule.default;
    const parent = await prismaClient.iMAsset.findUnique({ where: { id: assetId } });
    if (!parent || parent.deletedAt) return responseData;

    let thumbnail = await prismaClient.iMAsset.findFirst({
      where: {
        workspaceId: parent.workspaceId,
        parentAssetId: parent.id,
        derivationKind: 'thumbnail',
        deletedAt: null,
      },
    });
    if (!thumbnail) {
      const thumbnailSeq = await allocateAssetIndexSeq(prismaClient, parent.workspaceId);
      thumbnail = await prismaClient.iMAsset.create({
        data: {
          workspaceId: parent.workspaceId,
          ownerImUserId: parent.ownerImUserId,
          contentHash: thumbHash,
          storageUri,
          sizeBytes: BigInt(output.data.length),
          mime: 'image/webp',
          kind: 'preview',
          metadata: JSON.stringify({
            filename: thumbnailFilename(filename, parent.contentHash),
            previewDerivative: {
              type: 'thumbnail',
              sourceAssetId: parent.id,
              sourceContentHash: parent.contentHash,
              width: output.info.width,
              height: output.info.height,
            },
          }),
          parentAssetId: parent.id,
          derivationKind: 'thumbnail',
          ingestStatus: 'asset-only',
          assetIndexSeq: thumbnailSeq,
          filename: thumbnailFilename(filename, parent.contentHash),
          sourceRef: `asset://${parent.id}#thumbnail`,
          sourceKind: 'asset-derived',
          sourceMetadata: JSON.stringify({ parentAssetId: parent.id, derivationKind: 'thumbnail' }),
          visibility: parent.visibility,
          aclJson: parent.aclJson,
        },
      });
      await createAssetRevisionSnapshot(prismaClient, thumbnail, parent.ownerImUserId, 'created');
    }

    const endpoint = assetEndpoint(thumbnail.id);
    const parentSeq = await allocateAssetIndexSeq(prismaClient, parent.workspaceId);
    const updated = await prismaClient.iMAsset.update({
      where: { id: parent.id },
      data: {
        thumbnailUrl: endpoint,
        previewUrls: { medium: endpoint },
        assetIndexSeq: parentSeq,
        revision: { increment: 1 },
      },
    });
    await createAssetRevisionSnapshot(prismaClient, updated, parent.ownerImUserId, 'thumbnail-ready');
    const nextData = {
      ...data,
      thumbnailUrl: endpoint,
      previewUrls: { medium: endpoint },
      previewAssetId: updated.previewAssetId,
      assetIndexSeq: Number(updated.assetIndexSeq),
      revision: updated.revision,
      updatedAt: updated.updatedAt?.toISOString?.() ?? data.updatedAt,
    };
    return { ...envelope, data: nextData };
  } catch (err) {
    logger.warn(
      { module: 'IM Route', err: err instanceof Error ? err.message : String(err), assetId },
      'Asset thumbnail proxy fallback failed',
    );
    return responseData;
  }
}

async function publishWorkspaceFileSyncFallback(
  ctx: ProxyContext,
  responseData: unknown,
  alreadyPublished: boolean,
): Promise<void> {
  if (alreadyPublished || !isWorkspaceFileCreatePath(ctx)) return;
  if (!responseData || typeof responseData !== 'object') return;
  const envelope = responseData as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return;
  const data = envelope.data as {
    workspaceId?: unknown;
    path?: unknown;
    assetId?: unknown;
    contentHash?: unknown;
    version?: unknown;
  };
  if (
    typeof data.workspaceId !== 'string' ||
    typeof data.path !== 'string' ||
    typeof data.assetId !== 'string' ||
    typeof data.version !== 'number'
  ) {
    return;
  }
  const imUserId = readBearerSubject(ctx.authHeader);
  if (!imUserId) return;

  const payload = {
    workspaceId: data.workspaceId,
    path: data.path,
    operation: 'create' as const,
    assetId: data.assetId,
    ...(typeof data.contentHash === 'string' ? { contentHash: data.contentHash } : {}),
    version: data.version,
  };

  try {
    const { getIMServices } = await import('@/im/bootstrap');
    const services = getIMServices();
    if (services?.syncService) {
      await services.syncService.writeEvent('workspace_file.changed', payload, null, imUserId);
      return;
    }

    // Existing dev sessions keep the IM app in globalThis across HMR. Those
    // older service bags may not expose syncService yet, so write the event
    // directly and publish to the same Redis channel SyncService uses.
    const prismaModule = await import('@/lib/prisma');
    const prismaClient = prismaModule.prisma ?? prismaModule.default;
    const record = await prismaClient.iMSyncEvent.create({
      data: {
        type: 'workspace_file.changed',
        data: JSON.stringify(payload),
        conversationId: null,
        imUserId,
      },
    });
    await services?.redis
      ?.publish(
        `im:sync:${imUserId}`,
        JSON.stringify({
          seq: record.id,
          type: 'workspace_file.changed',
          data: payload,
          conversationId: null,
          at: record.createdAt.toISOString(),
        }),
      )
      .catch(() => {
        /* non-fatal: /sync catch-up still sees the DB row */
      });
  } catch (err) {
    logger.warn(
      { module: 'IM Route', err: err instanceof Error ? err.message : String(err), path: data.path },
      'Workspace file sync fallback publish failed',
    );
  }
}

async function publishAssetSyncFallback(
  ctx: ProxyContext,
  responseData: unknown,
  alreadyPublished: boolean,
  responseStatus: number,
): Promise<void> {
  if (alreadyPublished || !isAssetMutationPath(ctx)) return;
  if (!responseData || typeof responseData !== 'object') return;
  const envelope = responseData as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true) return;

  const prismaModule = await import('@/lib/prisma');
  const prismaClient = prismaModule.prisma ?? prismaModule.default;
  const bodyData =
    envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : null;
  const pathAssetId = ctx.path.match(/^assets\/([^/]+)$/)?.[1] ?? null;
  const assetId = typeof bodyData?.id === 'string' ? bodyData.id : pathAssetId;
  if (!assetId) return;

  let workspaceId = typeof bodyData?.workspaceId === 'string' ? bodyData.workspaceId : null;
  let contentHash = typeof bodyData?.contentHash === 'string' ? bodyData.contentHash : undefined;
  let assetIndexSeq = typeof bodyData?.assetIndexSeq === 'number' ? bodyData.assetIndexSeq : undefined;
  let revision = typeof bodyData?.revision === 'number' ? bodyData.revision : undefined;
  let ownerImUserId: string | null = null;

  if (!workspaceId || !contentHash || assetIndexSeq === undefined || revision === undefined) {
    const row = await prismaClient.iMAsset.findUnique({
      where: { id: assetId },
      select: {
        workspaceId: true,
        contentHash: true,
        assetIndexSeq: true,
        revision: true,
        workspace: { select: { ownerImUserId: true } },
      },
    });
    if (!row) return;
    workspaceId = row.workspaceId;
    contentHash = row.contentHash;
    assetIndexSeq = Number(row.assetIndexSeq);
    revision = row.revision;
    ownerImUserId = row.workspace.ownerImUserId;
  }

  if (!ownerImUserId && workspaceId) {
    const ws = await prismaClient.iMWorkspace.findUnique({
      where: { id: workspaceId },
      select: { ownerImUserId: true },
    });
    ownerImUserId = ws?.ownerImUserId ?? null;
  }
  if (!workspaceId || !ownerImUserId) return;

  const operation =
    ctx.method === 'DELETE'
      ? ('delete' as const)
      : ctx.method === 'PATCH'
        ? ('update' as const)
        : responseStatus === 201
          ? ('create' as const)
          : ('update' as const);
  const payload = {
    workspaceId,
    assetId,
    operation,
    ...(contentHash ? { contentHash } : {}),
    ...(assetIndexSeq !== undefined ? { assetIndexSeq } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };

  try {
    const { getIMServices } = await import('@/im/bootstrap');
    const services = getIMServices();
    services?.rooms?.sendToUser(ownerImUserId, {
      type: 'asset.changed',
      payload,
      timestamp: Date.now(),
    });
    if (services?.syncService) {
      await services.syncService.writeEvent('asset.changed', payload, null, ownerImUserId);
      return;
    }

    const record = await prismaClient.iMSyncEvent.create({
      data: {
        type: 'asset.changed',
        data: JSON.stringify(payload),
        conversationId: null,
        imUserId: ownerImUserId,
      },
    });
    await services?.redis
      ?.publish(
        `im:sync:${ownerImUserId}`,
        JSON.stringify({
          seq: record.id,
          type: 'asset.changed',
          data: payload,
          conversationId: null,
          at: record.createdAt.toISOString(),
        }),
      )
      .catch(() => {
        /* non-fatal: /sync catch-up still sees the DB row */
      });
  } catch (err) {
    logger.warn(
      { module: 'IM Route', err: err instanceof Error ? err.message : String(err), assetId },
      'Asset sync fallback publish failed',
    );
  }
}

function parseJsonObjectFromBody(body: ArrayBuffer | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractAttachmentArray(body: ArrayBuffer | null): Array<Record<string, unknown>> {
  const parsed = parseJsonObjectFromBody(body);
  const raw = parsed?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as { assetId?: unknown }).assetId === 'string' &&
      (item as { assetId: string }).assetId.length > 0,
  );
}

async function repairMessageAttachmentsFallback(
  ctx: ProxyContext,
  responseData: unknown,
  requestBody: ArrayBuffer | null,
): Promise<unknown> {
  if (!isMessageSendPath(ctx)) return responseData;
  if (!responseData || typeof responseData !== 'object') return responseData;

  const envelope = responseData as { ok?: unknown; data?: { message?: Record<string, unknown>; routing?: unknown } };
  if (envelope.ok !== true || !envelope.data?.message) return responseData;

  const message = envelope.data.message;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) return responseData;

  const attachments = extractAttachmentArray(requestBody);
  if (attachments.length === 0) return responseData;
  if (typeof message.id !== 'string' || typeof message.conversationId !== 'string') return responseData;

  try {
    const prismaModule = await import('@/lib/prisma');
    const prismaClient = prismaModule.prisma ?? prismaModule.default;
    const updated = await prismaClient.iMMessage.update({
      where: { id: message.id },
      data: { attachments },
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        type: true,
        content: true,
        metadata: true,
        attachments: true,
        parentId: true,
        createdAt: true,
      },
    });

    const { getIMServices } = await import('@/im/bootstrap');
    const services = getIMServices();
    const eventData = {
      id: updated.id,
      conversationId: updated.conversationId,
      senderId: updated.senderId,
      type: updated.type,
      content: updated.content,
      metadata: updated.metadata,
      attachments: updated.attachments,
      parentId: updated.parentId,
      createdAt: updated.createdAt.toISOString(),
    };
    let wroteSyncEvent = false;
    if (services?.syncService) {
      try {
        await services.syncService.writeEvent('message.updated', eventData, updated.conversationId, updated.senderId);
        wroteSyncEvent = true;
      } catch (err) {
        logger.warn(
          {
            module: 'IM Route',
            err: err instanceof Error ? err.message : String(err),
            messageId: updated.id,
          },
          'Message attachment syncService fallback write failed',
        );
      }
    }
    if (!wroteSyncEvent) {
      const record = await prismaClient.iMSyncEvent.create({
        data: {
          type: 'message.updated',
          data: JSON.stringify(eventData),
          conversationId: updated.conversationId,
          imUserId: updated.senderId,
        },
      });
      const participants = await prismaClient.iMParticipant.findMany({
        where: { conversationId: updated.conversationId, leftAt: null },
        select: { imUserId: true },
      });
      const recipients = new Set<string>([
        updated.senderId,
        ...participants.map((p: { imUserId: string }) => p.imUserId),
      ]);
      await Promise.all(
        [...recipients].map((recipientId) =>
          services?.redis
            ?.publish(
              `im:sync:${recipientId}`,
              JSON.stringify({
                seq: record.id,
                type: 'message.updated',
                data: eventData,
                conversationId: updated.conversationId,
                at: record.createdAt.toISOString(),
              }),
            )
            .catch(() => {
              /* non-fatal: /sync catch-up still sees the DB row */
            }),
        ),
      );
    }

    return {
      ...envelope,
      data: {
        ...envelope.data,
        message: {
          ...message,
          attachments: updated.attachments,
        },
      },
    };
  } catch (err) {
    logger.warn(
      {
        module: 'IM Route',
        err: err instanceof Error ? err.message : String(err),
        messageId: message.id,
      },
      'Message attachment persistence fallback failed',
    );
    return responseData;
  }
}

/**
 * Call the Hono IM app directly in-process.
 */
async function callIMApp(ctx: ProxyContext): Promise<Response> {
  // Dynamic import to avoid Edge Runtime issues — bootstrap.ts is Node.js only
  const { getIMApp } = await import('@/im/bootstrap');
  const app = getIMApp();

  if (!app) {
    return NextResponse.json({ ok: false, error: 'IM Server not initialized' }, { status: 503 });
  }

  // Build the internal URL for Hono app (hostname doesn't matter, it's in-process)
  const internalUrl = new URL(`http://localhost/api/${ctx.path}`);
  ctx.request.nextUrl.searchParams.forEach((value, key) => {
    internalUrl.searchParams.set(key, value);
  });
  if (ctx.searchParamOverrides) {
    for (const [key, value] of Object.entries(ctx.searchParamOverrides)) {
      internalUrl.searchParams.set(key, value);
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': ctx.request.headers.get('content-type') || 'application/json',
  };
  if (ctx.authHeader) {
    headers['Authorization'] = ctx.authHeader;
  }
  // Forward X-IM-Agent only for verified API-key proxy calls. Browser JWT
  // traffic must not be able to spoof an agent identity by setting this header.
  const imAgent = ctx.request.headers.get('x-im-agent');
  if (ctx.allowImAgentHeader && imAgent) {
    headers['X-IM-Agent'] = imAgent;
    const imWorkspace = ctx.request.headers.get('x-im-workspace');
    if (imWorkspace) headers['X-IM-Workspace'] = imWorkspace;
  }
  // Wave-8 W6: forward Range header so /assets/:id can serve partial content
  // for native <video>/<audio> scrubbing.
  const range = ctx.request.headers.get('range');
  if (range) {
    headers['Range'] = range;
  }
  // release202/13 L0: forward conditional-request headers so /assets/:id can
  // return 304 (the byte route's ETag revalidation). The proxy builds a
  // header allowlist (same class of silent-drop as the idempotency-key bug
  // below) — without this, If-None-Match never reaches Hono and every
  // revalidation gets a full 200 body, defeating L0's cache.
  const ifNoneMatch = ctx.request.headers.get('if-none-match');
  if (ifNoneMatch) {
    headers['If-None-Match'] = ifNoneMatch;
  }
  const ifModifiedSince = ctx.request.headers.get('if-modified-since');
  if (ifModifiedSince) {
    headers['If-Modified-Since'] = ifModifiedSince;
  }
  const contentSha256 = ctx.request.headers.get('x-content-sha256');
  if (contentSha256) {
    headers['X-Content-Sha256'] = contentSha256;
  }
  // v2.0 §4.1 — forward X-Idempotency-Key so the IM message handler can
  // honor SDK retries. Bug was silent-drop here (proxy built a new headers
  // object that whitelisted only auth/content-type/range/x-content-sha256
  // and X-IM-Agent — idempotency key never reached Hono). Surfaced in
  // v20 acceptance regression evidence/v20-acceptance §D3.
  const idempotencyKey = ctx.request.headers.get('x-idempotency-key');
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  // Build request for Hono
  const init: RequestInit = {
    method: ctx.method,
    headers,
  };
  let forwardedBody: ArrayBuffer | null = null;

  if (!['GET', 'HEAD'].includes(ctx.method)) {
    try {
      if (isAssetUploadPath(ctx)) {
        const prepared = await prepareAssetUploadForm(ctx, headers);
        if (prepared instanceof Response) return prepared;
        init.body = prepared;
      } else {
        const body = await ctx.request.arrayBuffer();
        forwardedBody = body;
        if (body.byteLength > 0) init.body = body;
      }
    } catch {
      // No body
    }
  }

  // Call Hono app directly — in-process, no network
  const honoRequest = new Request(internalUrl.toString(), init);
  const response = await app.fetch(honoRequest);

  // Convert Hono response to NextResponse
  const contentType = response.headers.get('content-type') || '';
  const location = response.headers.get('location');

  // Preserve IM redirects, especially /assets/:id -> S3 presigned URLs.
  // Without forwarding Location, browser preview/download fetches cannot
  // follow object-storage backed assets.
  if (location && response.status >= 300 && response.status < 400) {
    return new NextResponse(null, {
      status: response.status,
      headers: { Location: location },
    });
  }

  // SSE: return the Hono Response directly so the underlying ReadableStream
  // and its initial headers (Content-Type: text/event-stream + Hono's own
  // SSE markers) reach the client without re-buffering. Wrapping in a fresh
  // `new Response(response.body, …)` previously caused header flushing to
  // wait for the first event, which never arrives until a task changes.
  if (contentType.includes('text/event-stream')) {
    return response;
  }

  // Collect Hono response headers to forward (rate limit, cache, custom)
  const forwardHeaders = new Headers();
  response.headers.forEach((value, key) => {
    // Forward rate limit, cache, custom, and Range-related headers (Wave-8 W6).
    if (
      key.startsWith('x-') ||
      key === 'cache-control' ||
      key === 'retry-after' ||
      key === 'deprecation' ||
      key === 'sunset' ||
      key === 'accept-ranges' ||
      key === 'content-range' ||
      key === 'content-length' ||
      key === 'etag'
    ) {
      forwardHeaders.set(key, value);
    }
  });

  // release202/13 L0: 304 Not Modified / 204 No Content have NO body. They
  // are neither a Location redirect nor SSE, so without this they fall into
  // the json/binary handlers below which read the (empty) body → 500. Return
  // them as-is with the validators (ETag/Cache-Control) already collected.
  if (response.status === 304 || response.status === 204) {
    return new NextResponse(null, { status: response.status, headers: forwardHeaders });
  }

  if (contentType.includes('application/json')) {
    let data = await response.json();
    data = await repairMessageAttachmentsFallback(ctx, data, forwardedBody);
    data = await ensureImageThumbnailProxyFallback(ctx, data);
    await publishWorkspaceFileSyncFallback(ctx, data, response.headers.get('x-workspace-file-sync') === '1');
    await publishAssetSyncFallback(ctx, data, response.headers.get('x-asset-sync') === '1', response.status);
    const res = NextResponse.json(data, { status: response.status });
    forwardHeaders.forEach((value, key) => res.headers.set(key, value));
    return res;
  }

  // For binary content (video/audio/pdf/images/Office/etc.) preserve the
  // underlying stream so bytes pass through unchanged. Do not classify
  // application/vnd.openxmlformats-* as text just because the subtype contains
  // "xml"; those are ZIP containers and `response.text()` corrupts them.
  if (contentType && !isTextualContentType(contentType)) {
    forwardHeaders.set('Content-Type', contentType);
    return new NextResponse(response.body, {
      status: response.status,
      headers: forwardHeaders,
    });
  }

  const text = await response.text();
  forwardHeaders.set('Content-Type', contentType);
  return new NextResponse(text, {
    status: response.status,
    headers: forwardHeaders,
  });
}

/**
 * Handle agent registration bonus credits.
 *
 * When a new agent registers (isNew=true), grant 10000 bonus credits to
 * the owning account. Credits go to the API Key owner's pool (human).
 */
async function handleAgentRegistration(responseData: any, auth: AuthInfo | null): Promise<void> {
  if (!auth) return;
  if (!responseData?.ok || !responseData?.data?.isNew) return;
  if (responseData.data.role !== 'agent') return;

  const userId = parseInt(auth.userId, 10);
  if (isNaN(userId)) return;

  try {
    const { addCredits } = await import('@/lib/db-credits');
    const { FEATURE_FLAGS } = await import('@/lib/feature-flags');

    if (!FEATURE_FLAGS.USER_CREDITS_LOCAL) return;

    await addCredits(
      userId,
      10_000,
      'bonus',
      `Agent registration bonus (${responseData.data.username})`,
      'agent_register',
      responseData.data.imUserId,
    );
    logger.info(
      { module: 'IM Route', userId, agent: responseData.data.username },
      'Granted 10000 credits for new agent registration',
    );
  } catch (err) {
    logger.error({ module: 'IM Route', err }, 'Failed to grant agent registration credits');
  }
}

/**
 * Record usage for IM write operations.
 * Includes agent meta (userId, authType) for dashboard tracking.
 *
 * Only records for cloud-authenticated users (API Key or cloud JWT with numeric userId).
 * IM JWT users (with alphanumeric IM User IDs) are billed at the IM credit level, not cloud.
 */
function recordIMUsage(operation: string, ctx: ProxyContext, responseData: any, auth: AuthInfo | null): void {
  if (!responseData?.ok && !responseData?.success) return;

  // Skip recording for non-cloud users (IM JWT with non-numeric userId)
  if (!auth) return;
  const numericUserId = parseInt(auth.userId, 10);
  if (isNaN(numericUserId)) return;

  const processingTime = Date.now() - ctx.startTime;
  const taskType: string = 'send';
  let totalCredits = 0;

  // Credit cost mapping (mirrors IM-layer credit-billing middleware)
  const costMap: Array<[RegExp, string, number]> = [
    [/messages/, 'POST', 0.001],
    [/direct\/.*\/messages/, 'POST', 0.001],
    [/groups\/.*\/messages/, 'POST', 0.001],
    [/workspace\/init/, 'POST', 0.01],
    [/groups$/, 'POST', 0.01],
    [/evolution\/analyze/, 'POST', 0.001],
    [/evolution\/record/, 'POST', 0.001],
    [/evolution\/report/, 'POST', 0.002],
    [/evolution\/genes$/, 'POST', 0.005],
    [/evolution\/sync/, 'POST', 0.001],
    [/memory\/files/, 'POST', 0.001],
    [/recall/, 'GET', 0.001],
    [/skills\/.*\/install/, 'POST', 0.002],
    [/tasks$/, 'POST', 0.001],
    [/reports$/, 'POST', 0.01],
  ];

  for (const [pattern, method, cost] of costMap) {
    if (pattern.test(operation) && ctx.method === method) {
      totalCredits = cost;
      break;
    }
  }
  if (totalCredits === 0) return; // Free operation

  // Build input value with agent meta
  const inputValue = `${ctx.path} [user:${auth.userId}, auth:${auth.authType}]`;

  recordUsageBackground(
    {
      task_id: generateTaskId('im'),
      task_type: taskType as any,
      input: { type: 'content', value: inputValue },
      metrics: { processing_time_ms: processingTime },
      cost: { total_credits: totalCredits },
    },
    ctx.originalAuthHeader,
  );
}

async function handleRequest(request: NextRequest, params: { path: string[] }): Promise<Response> {
  const startTime = Date.now();

  try {
    const path = params.path.join('/');
    const method = request.method;
    const isHealthCheck = path === 'health';
    const isRegister = path === 'register' && method === 'POST';
    // SSE endpoints: EventSource cannot set Authorization headers, so they
    // pass the bearer in `?token=` and verify it inside the Hono handler
    // (against the same JWT_SECRET — see src/im/api/tasks.ts SSE handler).
    // apiGuard would reject these for missing Authorization header.
    const isSyncStream = path === 'sync/stream' && method === 'GET';
    const isTaskEvents = path === 'tasks/events' && method === 'GET';
    const isSSEStream = isSyncStream || isTaskEvents;

    let authHeader = request.headers.get('authorization');
    const originalAuthHeader = authHeader;
    let auth: AuthInfo | null = null;
    let allowImAgentHeader = false;
    let searchParamOverrides: Record<string, string> | undefined;

    // Public endpoints bypass auth (no login required)
    const isPublicEvolution =
      path.startsWith('evolution/public/') ||
      (path.startsWith('evolution/leaderboard/') && method === 'GET' && path !== 'evolution/leaderboard/agents/me') ||
      (path.startsWith('evolution/profile/') && method === 'GET') ||
      (path === 'evolution/benchmark' && method === 'GET') ||
      path === 'evolution/map' ||
      path === 'evolution/stories' ||
      (path === 'evolution/metrics' && method === 'GET') ||
      (path.startsWith('evolution/highlights/') && method === 'GET') ||
      (path === 'evolution/card/render' && method === 'POST');
    // Public skills routes: search, stats, categories, trending, detail, related
    // Auth-required: installed, created, content, install, uninstall, star, import
    const isPublicSkills =
      path.startsWith('skills/') &&
      method === 'GET' &&
      path !== 'skills/installed' &&
      path !== 'skills/created' &&
      !path.endsWith('/content');
    // Public community routes: posts list, post detail, comments, stats, search, tags, hot, boards, suggest, autocomplete
    // Auth-required: create/update/delete post/comment, vote, bookmark, notifications
    const isPublicCommunity =
      method === 'GET' &&
      (path === 'community/posts' ||
        /^community\/posts\/[^/]+$/.test(path) ||
        /^community\/posts\/[^/]+\/comments$/.test(path) ||
        path === 'community/stats' ||
        path === 'community/search' ||
        path.startsWith('community/tags/') ||
        path === 'community/hot' ||
        path === 'community/search/suggest' ||
        path.startsWith('community/boards') ||
        path.startsWith('community/autocomplete/'));

    // Dev-only local file CDN (no S3): /files/dev-download/:uploadId/:fileName
    // is mounted before authMiddleware in src/im/api/files.ts because it
    // simulates a public CDN URL (used as <img src>/<video src>/PDF file=...,
    // which cannot attach an Authorization header). apiGuard would otherwise
    // 401 those requests. Safe: the Hono handler short-circuits when
    // isS3Available() returns true (prod), and path-traversal is rejected at
    // the route level.
    const isPublicDevDownload = method === 'GET' && /^files\/dev-download\/[^/]+\/[^/]+$/.test(path);

    // Public profile avatar bytes: GET /assets/:id/avatar is served by a
    // no-auth Hono route (src/im/api/assets.ts, registered + auth-skipped
    // before authMiddleware) because it's rendered through a bare `<img src>`
    // that cannot attach an Authorization header. apiGuard here would 401 it
    // first, so carve it out. Safe: the Hono handler enforces a strict gate
    // (image mime + ≤2MB + metadata.source==='settings_profile_avatar').
    const isPublicAvatar = method === 'GET' && /^assets\/[^/]+\/avatar$/.test(path);

    // Workspace invite public preview (release201/16 §3.1.4 + §3.3.2):
    // GET /invites/:token must be reachable by anonymous landing pages
    // before the invitee logs in. Hono's invites router intentionally omits
    // authMiddleware on this route (src/im/api/invites.ts:29), but apiGuard
    // here would reject the anon request. Carve the GET out of the auth
    // gate while keeping POST /invites/:token/accept|reject auth-required
    // (those still flow through apiGuard below).
    const isPublicInvitePreview = method === 'GET' && /^invites\/[^/]+$/.test(path);

    // QR-pair bootstrap (v1.9.3 Track C, Cloud 4): the daemon has no API key
    // until pair/poll completes, so /pair/offer and /pair/poll/:nonce must
    // bypass apiGuard. /pair/approve stays auth-required — that's the mobile-
    // user-clicks-Approve step and is enforced inside the Hono router.
    // /pair/local-only-approve (Wave-6 α) replaces /pair/approve in LAN-dev
    // mode and gates itself on `LOCAL_ONLY=1 && NODE_ENV !== 'production'`
    // inside the Hono handler — apiGuard would reject it for missing
    // Authorization, so we bypass apiGuard here and let the route's own
    // gate decide.
    const isPublicPair =
      (path === 'pair/offer' && method === 'POST') ||
      (/^pair\/poll\/[^/]+$/.test(path) && method === 'GET') ||
      (path === 'pair/local-only-approve' && method === 'POST');
    // Daemon async reply callback for external-channel @mention dispatch.
    // Hono validates the payload shape and writes the reply into IM; this
    // proxy bypass is required because the daemon may not have a browser JWT.
    // Wave 3.5 §4.3 — extended to cover the two-phase variants
    // POST /dispatch/:taskId/prepare and POST /dispatch/:taskId/commit.
    // Both validate the daemon-issued replyToken / replyId at the Hono
    // layer, so bypassing apiGuard here is safe and required.
    const isDispatchReply =
      (path === 'dispatch/reply' && method === 'POST') ||
      (/^dispatch\/[^/]+\/(prepare|commit)$/.test(path) && method === 'POST');

    // Health, register, SSE streams, and public read endpoints bypass normal
    // header auth. SSE handlers verify `?token=` themselves; API keys in that
    // query param are translated here because EventSource cannot attach an
    // Authorization header for the usual apiGuard path.
    if (isSSEStream) {
      const queryToken = request.nextUrl.searchParams.get('token');
      if (queryToken?.startsWith('sk-prismer-')) {
        const headers = new Headers(request.headers);
        headers.set('authorization', `Bearer ${queryToken}`);
        const guardRequest = new NextRequest(request.url, { headers, method: request.method });
        const guard = await apiGuard(guardRequest, { tier: 'tracked' });
        if (!guard.ok) return guard.response;
        auth = guard.auth;
        if (guard.auth.imToken) {
          authHeader = `Bearer ${guard.auth.imToken}`;
          allowImAgentHeader = true;
          searchParamOverrides = { token: guard.auth.imToken };
        }
      }
    } else if (
      !isHealthCheck &&
      !isRegister &&
      !isSSEStream &&
      !isPublicEvolution &&
      !isPublicSkills &&
      !isPublicCommunity &&
      !isPublicPair &&
      !isPublicInvitePreview &&
      !isPublicDevDownload &&
      !isPublicAvatar &&
      !isDispatchReply
    ) {
      const guard = await apiGuard(request, { tier: 'tracked' });
      if (!guard.ok) return guard.response;
      auth = guard.auth;

      // Replace auth header with IM JWT for API Key users (translation needed).
      // Platform JWTs may come from the native auth layer with `numericId`.
      // apiGuard accepts those tokens by decoding them, while the downstream
      // IM Hono authMiddleware verifies signatures against the local IM secret.
      // In local/dev stacks those secrets can legitimately differ after a
      // restart, so numericId JWTs must be translated into a short-lived IM
      // proxy token. Do this only when apiGuard resolved a numeric cloud user
      // id; older direct IM JWTs without numericId still pass through as-is so
      // we do not reinterpret an IM cuid as a cloud numeric id.
      //
      // Bug Z2 (v2.0.7) — when the upstream JWT carries a cuid-shape `sub`
      // (IMUser.id), api-guard surfaces it via `imUserSub`. Mint a DIRECT IM
      // token (not `api_key_proxy`) so the IM middleware uses sub as imUserId
      // verbatim. The previous logic (numeric-id translation) made invite
      // accept ensureIMUser-by-numericId miss → mint a phantom IMUser and
      // break ownership identity. Falls through to legacy numeric-id
      // translation when `imUserSub` is absent (no cuid sub in JWT) to
      // preserve compatibility with older clients / api_key proxy flows.
      if (guard.auth.authType === 'jwt' && guard.auth.imUserSub) {
        authHeader = `Bearer ${generateIMTokenForImUser(guard.auth.imUserSub, guard.auth.email)}`;
        allowImAgentHeader = true;
      } else if (guard.auth.authType === 'jwt' && /^\d+$/.test(guard.auth.userId)) {
        authHeader = `Bearer ${generateIMTokenForUser(guard.auth.userId, guard.auth.email)}`;
        allowImAgentHeader = true;
      }
      if (guard.auth.authType === 'api_key' && guard.auth.imToken) {
        authHeader = `Bearer ${guard.auth.imToken}`;
        allowImAgentHeader = true;
      }
    } else if (isRegister && authHeader) {
      // Register with API Key: optional auth for binding agent to human
      try {
        const guard = await apiGuard(request, { tier: 'tracked' });
        if (guard.ok) {
          auth = guard.auth;
          if (guard.auth.authType === 'api_key' && guard.auth.imToken) {
            authHeader = `Bearer ${guard.auth.imToken}`;
            allowImAgentHeader = true;
          }
        }
      } catch {
        // Auth failed — proceed as anonymous registration
      }
    }

    const ctx: ProxyContext = {
      request,
      path,
      method,
      authHeader,
      originalAuthHeader,
      allowImAgentHeader,
      searchParamOverrides,
      startTime,
    };

    const response = await callIMApp(ctx);

    // Post-processing in background (usage recording + agent registration bonus).
    // Skip for SSE streams: `.clone().json()` would hang forever waiting for
    // an end-of-stream that never arrives, and SSE traffic is per-connection
    // (one open stream, not per-message), so usage accounting doesn't apply.
    const responseContentType = response.headers.get('content-type') || '';
    if (!responseContentType.includes('text/event-stream')) {
      try {
        const responseClone = response.clone();
        const data = await responseClone.json();
        recordIMUsage(path, ctx, data, auth);

        // Agent registration → bonus credits
        if (path === 'register' && method === 'POST') {
          handleAgentRegistration(data, auth).catch(() => {});
        }
      } catch {
        // Ignore post-processing errors
      }
    }

    return response;
  } catch (error) {
    logger.error({ module: 'IM Route', err: error }, 'Request handling error');
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'IM_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return handleRequest(request, await params);
}
