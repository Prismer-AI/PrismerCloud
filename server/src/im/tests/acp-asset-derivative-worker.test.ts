import * as crypto from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  assetsFromS3ObjectCreatedEvent,
  processAssetDerivatives,
  sha256HexForDerivativeWorker,
  s3ObjectRecordsFromCreatedEvent,
  type AssetDerivativeCallbackPayload,
  type AssetDerivativeWorkerAsset,
} from '../services/asset-derivative-worker.service';

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('asset derivative worker', () => {
  it('processes eligible derivatives, writes S3 objects, and calls the internal callback', async () => {
    const source = Buffer.from('source image bytes');
    const sourceHash = sha256(source);
    const thumb = Buffer.from('thumbnail webp');
    const hlsManifest = Buffer.from('#EXTM3U\n');
    const hlsSegment = Buffer.from('segment bytes');
    const s3Client = {
      send: vi.fn(async (command: unknown) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return { Body: { transformToByteArray: async () => new Uint8Array(source) } };
      }),
    };
    const putObject = vi.fn(async (input: { bucket: string; key: string }) => ({
      bucket: input.bucket,
      key: input.key,
      mode: 'single' as const,
      partCount: 1,
    }));
    const callbackPayloads: AssetDerivativeCallbackPayload[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callbackPayloads.push(JSON.parse(String(init?.body)) as AssetDerivativeCallbackPayload);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const asset: AssetDerivativeWorkerAsset = {
      id: 'asset-1',
      workspaceId: 'ws-1',
      contentHash: sourceHash,
      storageUri: `s3://asset-bucket/assets/${sourceHash}`,
      mime: 'video/mp4',
      sizeBytes: source.length,
      filename: 'clip.mp4',
    };

    const result = await processAssetDerivatives(asset, {
      apiBaseUrl: 'https://api.test',
      callbackSecret: 'secret',
      s3Client,
      putObject,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createImageThumbnail: vi.fn(async () => ({
        status: 'success',
        buffer: thumb,
        contentHash: sha256(thumb),
        mime: 'image/webp',
        width: 512,
        height: 288,
      })),
      createPdfFirstPageThumbnail: vi.fn(async () => ({ status: 'skipped', reason: 'not_pdf' })),
      linearizePdf: vi.fn(async () => ({ status: 'skipped', reason: 'not_pdf' })),
      createHlsDerivative: vi.fn(async () => ({
        status: 'success',
        plan: {
          status: 'eligible',
          contentHash: sourceHash,
          sourceMime: 'video/mp4',
          sourceSizeBytes: source.length,
          outputMime: 'application/vnd.apple.mpegurl',
        },
        manifest: {
          key: `asset-previews/hls/${sourceHash}/master.m3u8`,
          buffer: hlsManifest,
          contentHash: sha256(hlsManifest),
          mime: 'application/vnd.apple.mpegurl',
        },
        files: [
          {
            key: `asset-previews/hls/${sourceHash}/master.m3u8`,
            relativePath: 'master.m3u8',
            buffer: hlsManifest,
            contentHash: sha256(hlsManifest),
            mime: 'application/vnd.apple.mpegurl',
          },
          {
            key: `asset-previews/hls/${sourceHash}/720p/segment-00000.ts`,
            relativePath: '720p/segment-00000.ts',
            buffer: hlsSegment,
            contentHash: sha256(hlsSegment),
            mime: 'video/mp2t',
          },
        ],
        metadata: {
          type: 'hls',
          plannerVersion: 1,
          workerVersion: 1,
          sourceContentHash: sourceHash,
          sourceMime: 'video/mp4',
          sourceSizeBytes: source.length,
          variants: ['720p'],
          outputKeys: {
            rootPrefix: `asset-previews/hls/${sourceHash}`,
            manifestKey: `asset-previews/hls/${sourceHash}/master.m3u8`,
            variantManifestKeys: { '720p': `asset-previews/hls/${sourceHash}/720p/index.m3u8` },
            segmentPrefix: `asset-previews/hls/${sourceHash}/segments`,
          },
          tool: 'ffmpeg',
          toolVersion: 'ffmpeg version test',
        },
      })),
    });

    expect(result.errors).toEqual([]);
    expect(result.callbacks.map((payload) => payload.derivationKind)).toEqual(['thumbnail', 'hls-manifest']);
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(putObject.mock.calls.map((call) => call[0].key)).toEqual([
      `asset-previews/thumb/${sha256(thumb).slice(0, 2)}/${sha256(thumb).slice(2, 4)}/${sha256(thumb)}.webp`,
      `asset-previews/hls/${sourceHash}/master.m3u8`,
      `asset-previews/hls/${sourceHash}/720p/segment-00000.ts`,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(callbackPayloads[0]).toMatchObject({
      assetId: 'asset-1',
      workspaceId: 'ws-1',
      derivationKind: 'thumbnail',
      mime: 'image/webp',
      previewSize: 'medium',
    });
    expect(callbackPayloads[1]).toMatchObject({
      assetId: 'asset-1',
      workspaceId: 'ws-1',
      derivationKind: 'hls-manifest',
      mime: 'application/vnd.apple.mpegurl',
      metadata: { type: 'hls', tool: 'ffmpeg' },
    });
  });

  it('extracts assets from S3 object-created events using caller lookup', () => {
    const hash = 'a'.repeat(64);
    const event = {
      Records: [
        {
          s3: {
            bucket: { name: 'asset-bucket' },
            object: { key: `assets%2Faa%2Faa%2F${hash}`, size: 12 },
          },
        },
        {
          s3: {
            bucket: { name: 'asset-bucket' },
            object: { key: 'ignored%20file.txt' },
          },
        },
      ],
    };
    const assets = assetsFromS3ObjectCreatedEvent(event, ({ bucket, key, sizeBytes }) =>
      key.startsWith('assets/')
        ? {
            id: 'asset-from-event',
            workspaceId: 'ws-1',
            contentHash: hash,
            storageUri: `s3://${bucket}/${key}`,
            mime: 'video/mp4',
            sizeBytes: sizeBytes ?? 0,
            filename: 'clip.mp4',
          }
        : null,
    );

    expect(assets).toEqual([
      {
        id: 'asset-from-event',
        workspaceId: 'ws-1',
        contentHash: hash,
        storageUri: `s3://asset-bucket/assets/aa/aa/${hash}`,
        mime: 'video/mp4',
        sizeBytes: 12,
        filename: 'clip.mp4',
      },
    ]);
    expect(s3ObjectRecordsFromCreatedEvent(event)).toEqual([
      {
        bucket: 'asset-bucket',
        key: `assets/aa/aa/${hash}`,
        sizeBytes: 12,
        storageUri: `s3://asset-bucket/assets/aa/aa/${hash}`,
      },
      {
        bucket: 'asset-bucket',
        key: 'ignored file.txt',
        sizeBytes: null,
        storageUri: 's3://asset-bucket/ignored file.txt',
      },
    ]);
  });

  it('exposes SHA-256 helper for local worker callers', () => {
    expect(sha256HexForDerivativeWorker(Buffer.from('bytes'))).toBe(sha256('bytes'));
  });
});
