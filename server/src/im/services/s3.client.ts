/**
 * Prismer IM — S3 Client Singleton
 *
 * Lazy-initialized S3 client with presigned URL helpers.
 * When S3 credentials are not configured (local dev), isS3Available() returns false
 * and callers should use the local filesystem fallback.
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

let client: S3Client | null = null;

export const S3_MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const S3_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
const S3_MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const S3_MAX_MULTIPART_PARTS = 10_000;

type S3SendClient = Pick<S3Client, 'send'>;

export interface PutS3ObjectInput {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string | null;
  contentHashSha256Hex?: string | null;
  multipartThresholdBytes?: number;
  partSizeBytes?: number;
  client?: S3SendClient;
}

export interface PutS3ObjectResult {
  bucket: string;
  key: string;
  mode: 'single' | 'multipart';
  partCount: number;
}

/**
 * Check if S3 is configured. False in local dev without AWS credentials.
 */
export function isS3Available(): boolean {
  return !!config.s3.accessKeyId && !!config.s3.secretAccessKey;
}

/**
 * Get or create the singleton S3 client.
 * Throws if S3 is not configured.
 */
export function getS3Client(): S3Client {
  if (!isS3Available()) {
    throw new Error('[S3] S3 credentials not configured — use isS3Available() to check first');
  }
  if (!client) {
    client = new S3Client({
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
      // 2026-05-20 — disable AWS SDK v3's auto-CRC32 checksum on PUT.
      // The default ("WHEN_SUPPORTED" since v3.729) injects an
      // `x-amz-checksum-crc32=<crc-of-empty>` query param into presigned PUT
      // URLs (because body is empty at signing time). Browsers then upload the
      // file body and the SDK middleware also adds the real `x-amz-checksum-
      // crc32` header — S3 sees URL-vs-header mismatch and rejects with 403.
      // Observed in 2026-05-19 test env: direct-to-S3 asset PUT fails 403
      // against pro-prismer-slide. Setting WHEN_REQUIRED reverts to pre-v3.729
      // behavior where checksums are only sent when the operation contract
      // requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
    });
    console.log(`[S3] Client initialized (region=${config.s3.region}, bucket=${config.s3.bucket})`);
  }
  return client;
}

export function getBucket(): string {
  return config.s3.bucket;
}

function toBase64Sha256(hex: string): string | undefined {
  return /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('base64') : undefined;
}

function normalizeBody(body: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function resolveMultipartPartSize(contentLength: number, requestedPartSize: number | undefined): number {
  const basePartSize = Math.max(requestedPartSize ?? S3_MULTIPART_PART_SIZE_BYTES, S3_MIN_MULTIPART_PART_SIZE_BYTES);
  const minPartSizeForLimit = Math.ceil(contentLength / S3_MAX_MULTIPART_PARTS);
  return Math.max(basePartSize, minPartSizeForLimit);
}

export async function putS3Object(input: PutS3ObjectInput): Promise<PutS3ObjectResult> {
  const s3 = input.client ?? getS3Client();
  const bytes = normalizeBody(input.body);
  const contentType = input.contentType ?? 'application/octet-stream';
  const checksum = input.contentHashSha256Hex ? toBase64Sha256(input.contentHashSha256Hex) : undefined;
  const metadata = input.contentHashSha256Hex ? { sha256: input.contentHashSha256Hex.toLowerCase() } : undefined;
  const threshold = input.multipartThresholdBytes ?? S3_MULTIPART_THRESHOLD_BYTES;

  if (bytes.length <= threshold) {
    await s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.length,
        ...(checksum ? { ChecksumSHA256: checksum } : {}),
        ...(metadata ? { Metadata: metadata } : {}),
      }),
    );
    return { bucket: input.bucket, key: input.key, mode: 'single', partCount: 1 };
  }

  const partSize = resolveMultipartPartSize(bytes.length, input.partSizeBytes);
  const createResult = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: contentType,
      ...(metadata ? { Metadata: metadata } : {}),
    }),
  );
  const uploadId = createResult.UploadId;
  if (!uploadId) {
    throw new Error('S3 multipart upload did not return an UploadId');
  }

  const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
  try {
    for (let offset = 0, partNumber = 1; offset < bytes.length; offset += partSize, partNumber += 1) {
      const part = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
      const uploaded = await s3.send(
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: part,
          ContentLength: part.byteLength,
        }),
      );
      if (!uploaded.ETag) {
        throw new Error(`S3 multipart upload part ${partNumber} did not return an ETag`);
      }
      completedParts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
    return { bucket: input.bucket, key: input.key, mode: 'multipart', partCount: completedParts.length };
  } catch (err) {
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: uploadId }))
      .catch(() => undefined);
    throw err;
  }
}

// Re-export for clean imports
export {
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  createPresignedPost,
  getSignedUrl,
};
export type { PresignedPost };
