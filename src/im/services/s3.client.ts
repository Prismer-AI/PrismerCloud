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
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint, forcePathStyle: true } : {}),
    });
    console.log(`[S3] Client initialized (region=${config.s3.region}, bucket=${config.s3.bucket})`);
  }
  return client;
}

export function getBucket(): string {
  return config.s3.bucket;
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
