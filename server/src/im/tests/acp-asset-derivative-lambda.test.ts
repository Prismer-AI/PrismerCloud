import { describe, expect, it, vi } from 'vitest';
import {
  assetDerivativeS3EventHandler,
  type AssetDerivativeLambdaResult,
} from '../services/asset-derivative-lambda.service';
import type { AssetDerivativeWorkerAsset } from '../services/asset-derivative-worker.service';

describe('asset derivative Lambda handler', () => {
  it('looks up root S3 assets from object-created events and processes matched assets only', async () => {
    const rootAsset = {
      id: 'asset-root-1',
      workspaceId: 'ws-1',
      contentHash: 'a'.repeat(64),
      storageUri: 's3://asset-bucket/assets/aa/aa/' + 'a'.repeat(64),
      mime: 'image/png',
      sizeBytes: BigInt(42),
      filename: 'image.png',
      parentAssetId: null,
      derivationKind: null,
      deletedAt: null,
    };
    const derivedAsset = {
      ...rootAsset,
      id: 'asset-derived-1',
      storageUri: 's3://asset-bucket/asset-previews/thumb/thumb.webp',
      parentAssetId: 'asset-root-1',
      derivationKind: 'thumbnail',
    };
    const prisma = {
      iMAsset: {
        findMany: vi.fn(async () => [rootAsset, derivedAsset]),
      },
    };
    const processOne = vi.fn(async () => ({
      callbacks: [],
      skipped: [{ kind: 'thumbnail', reason: 'not_image' }],
      errors: [],
    }));

    const result = await assetDerivativeS3EventHandler(
      {
        Records: [
          {
            s3: {
              bucket: { name: 'asset-bucket' },
              object: { key: `assets%2Faa%2Faa%2F${'a'.repeat(64)}`, size: 42 },
            },
          },
          {
            s3: {
              bucket: { name: 'asset-bucket' },
              object: { key: 'asset-previews%2Fthumb%2Fthumb.webp', size: 12 },
            },
          },
        ],
      },
      {
        prisma,
        processOne,
        apiBaseUrl: 'https://api.example.test',
        callbackSecret: 'secret',
      },
    );

    expect(result).toMatchObject<AssetDerivativeLambdaResult>({
      ok: true,
      receivedRecords: 2,
      matchedAssets: 1,
      processed: 1,
      failed: 0,
      skippedStorageUris: ['s3://asset-bucket/asset-previews/thumb/thumb.webp'],
      records: [
        {
          assetId: 'asset-root-1',
          storageUri: rootAsset.storageUri,
          result: {
            callbacks: [],
            skipped: [{ kind: 'thumbnail', reason: 'not_image' }],
            errors: [],
          },
        },
      ],
    });
    expect(processOne).toHaveBeenCalledWith(
      expect.objectContaining<Partial<AssetDerivativeWorkerAsset>>({
        id: 'asset-root-1',
        workspaceId: 'ws-1',
        storageUri: rootAsset.storageUri,
        sizeBytes: 42,
      }),
      expect.objectContaining({ apiBaseUrl: 'https://api.example.test', callbackSecret: 'secret' }),
    );
  });
});
