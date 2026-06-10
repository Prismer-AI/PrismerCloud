import prisma from '../db';
import {
  assetDerivativeWorkerCallbackSecret,
  processAssetDerivatives,
  s3ObjectRecordsFromCreatedEvent,
  type AssetDerivativeWorkerAsset,
  type AssetDerivativeWorkerOptions,
  type ProcessAssetDerivativeResult,
  type S3ObjectCreatedEvent,
} from './asset-derivative-worker.service';

interface PrismaAssetRow {
  id: string;
  workspaceId: string;
  contentHash: string;
  storageUri: string;
  mime: string | null;
  sizeBytes: bigint | number | null;
  filename: string | null;
  parentAssetId?: string | null;
  derivationKind?: string | null;
  deletedAt?: Date | null;
}

type PrismaLike = {
  iMAsset: {
    findMany(input: unknown): Promise<PrismaAssetRow[]>;
  };
};

export interface AssetDerivativeLambdaOptions extends Pick<
  AssetDerivativeWorkerOptions,
  | 's3Client'
  | 'putObject'
  | 'fetchImpl'
  | 'hlsMinSizeBytes'
  | 'createImageThumbnail'
  | 'createPdfFirstPageThumbnail'
  | 'linearizePdf'
  | 'createHlsDerivative'
> {
  prisma?: PrismaLike;
  apiBaseUrl?: string;
  callbackSecret?: string;
  limit?: number;
  processOne?: typeof processAssetDerivatives;
}

export interface AssetDerivativeLambdaRecordResult {
  assetId: string;
  storageUri: string;
  result?: ProcessAssetDerivativeResult;
  error?: string;
}

export interface AssetDerivativeLambdaResult {
  ok: boolean;
  receivedRecords: number;
  matchedAssets: number;
  processed: number;
  failed: number;
  skippedStorageUris: string[];
  records: AssetDerivativeLambdaRecordResult[];
}

export async function assetDerivativeS3EventHandler(
  event: S3ObjectCreatedEvent,
  options: AssetDerivativeLambdaOptions = {},
): Promise<AssetDerivativeLambdaResult> {
  const objectRecords = s3ObjectRecordsFromCreatedEvent(event);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
  const storageUris = Array.from(new Set(objectRecords.map((record) => record.storageUri))).slice(0, limit);
  if (storageUris.length === 0) {
    return {
      ok: true,
      receivedRecords: objectRecords.length,
      matchedAssets: 0,
      processed: 0,
      failed: 0,
      skippedStorageUris: [],
      records: [],
    };
  }

  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  const callbackSecret = options.callbackSecret ?? assetDerivativeWorkerCallbackSecret();
  if (!callbackSecret) {
    throw new Error(
      'Asset derivative Lambda requires ASSET_DERIVATIVE_CALLBACK_SECRET, INTERNAL_API_SECRET, WEBHOOK_SECRET, or options.callbackSecret',
    );
  }

  const db: PrismaLike = options.prisma ?? (prisma as unknown as PrismaLike);
  const rows = await db.iMAsset.findMany({
    where: { storageUri: { in: storageUris }, deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      contentHash: true,
      storageUri: true,
      mime: true,
      sizeBytes: true,
      filename: true,
      parentAssetId: true,
      derivationKind: true,
      deletedAt: true,
    },
  });
  const byStorageUri = new Map(rows.map((row) => [row.storageUri, row]));
  const assets = storageUris
    .map((storageUri) => toWorkerAsset(byStorageUri.get(storageUri) ?? null))
    .filter((asset): asset is AssetDerivativeWorkerAsset => !!asset);
  const matchedUris = new Set(assets.map((asset) => asset.storageUri));
  const skippedStorageUris = storageUris.filter((storageUri) => !matchedUris.has(storageUri));

  const processOne = options.processOne ?? processAssetDerivatives;
  const recordResults: AssetDerivativeLambdaRecordResult[] = [];
  let processed = 0;
  let failed = 0;
  for (const asset of assets) {
    try {
      const result = await processOne(asset, {
        apiBaseUrl,
        callbackSecret,
        ...(options.s3Client ? { s3Client: options.s3Client } : {}),
        ...(options.putObject ? { putObject: options.putObject } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.hlsMinSizeBytes != null ? { hlsMinSizeBytes: options.hlsMinSizeBytes } : {}),
        ...(options.createImageThumbnail ? { createImageThumbnail: options.createImageThumbnail } : {}),
        ...(options.createPdfFirstPageThumbnail
          ? { createPdfFirstPageThumbnail: options.createPdfFirstPageThumbnail }
          : {}),
        ...(options.linearizePdf ? { linearizePdf: options.linearizePdf } : {}),
        ...(options.createHlsDerivative ? { createHlsDerivative: options.createHlsDerivative } : {}),
      });
      processed += 1;
      recordResults.push({ assetId: asset.id, storageUri: asset.storageUri, result });
    } catch (err) {
      failed += 1;
      recordResults.push({
        assetId: asset.id,
        storageUri: asset.storageUri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: failed === 0,
    receivedRecords: objectRecords.length,
    matchedAssets: assets.length,
    processed,
    failed,
    skippedStorageUris,
    records: recordResults,
  };
}

export async function handler(event: S3ObjectCreatedEvent): Promise<AssetDerivativeLambdaResult> {
  return assetDerivativeS3EventHandler(event);
}

function resolveApiBaseUrl(value: string | undefined): string {
  const resolved =
    value ??
    process.env.ASSET_DERIVATIVE_API_BASE_URL ??
    process.env.PRISMER_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    '';
  if (!resolved) {
    throw new Error('Asset derivative Lambda requires ASSET_DERIVATIVE_API_BASE_URL or PRISMER_BASE_URL');
  }
  return resolved.replace(/\/+$/, '');
}

function toWorkerAsset(row: PrismaAssetRow | null): AssetDerivativeWorkerAsset | null {
  if (!row || row.deletedAt || row.parentAssetId || row.derivationKind) return null;
  if (!row.storageUri.startsWith('s3://')) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contentHash: row.contentHash,
    storageUri: row.storageUri,
    mime: row.mime,
    sizeBytes: Number(row.sizeBytes ?? 0),
    filename: row.filename,
  };
}
