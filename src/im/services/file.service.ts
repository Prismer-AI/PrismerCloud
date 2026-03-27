/**
 * Prismer IM — File Upload Service
 *
 * Two-phase upload: presign → client uploads to S3 → confirm (validate + CDN activate).
 * Supports simple upload (≤ 10MB) and multipart resumable (10-50MB).
 *
 * Dev mode: when S3 credentials are not configured, uses local filesystem
 * under prisma/data/uploads/ for full end-to-end testability without AWS.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import prisma from '../db';
import {
  isS3Available,
  getS3Client,
  getBucket,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  createPresignedPost,
  getSignedUrl,
} from './s3.client';
import {
  validateUploadRequest,
  validateFileContent,
  sanitizeFileName,
  MIME_WHITELIST,
} from './file-validator';
import type { CreditService } from './credit.service';
import type {
  PresignInput,
  PresignResult,
  ConfirmResult,
  MultipartInitInput,
  MultipartInitResult,
  MultipartCompleteInput,
  FileQuota,
} from '../types';

const LOG = '[FileService]';

// ─── Error Types ────────────────────────────────────────

export class FileServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = 'FileServiceError';
  }
}

// ─── Service ────────────────────────────────────────────

export class FileService {
  constructor(private creditService: CreditService) {}

  // ── Presign (Simple Upload ≤ 10MB) ──────────────────

  async presign(input: PresignInput, imUserId: string): Promise<PresignResult> {
    const { fileName, fileSize, mimeType } = input;

    // 1. Validate request metadata
    const validationError = validateUploadRequest(
      fileName, fileSize, mimeType, config.files.maxSimpleSize,
    );
    if (validationError) {
      throw new FileServiceError(validationError, 'INVALID_INPUT');
    }

    // 2. Check quota
    await this.ensureQuota(imUserId, fileSize);

    // 3. Pre-check credit balance
    const cost = this.calculateCost(fileSize);
    const balance = await this.creditService.getBalance(imUserId);
    if (balance.balance < cost) {
      throw new FileServiceError('Insufficient credits for file upload', 'INSUFFICIENT_CREDITS', 402);
    }

    // 4. Generate upload ID and S3 key
    const uploadId = this.generateUploadId();
    const safeFileName = sanitizeFileName(fileName);
    const s3Key = this.buildS3Key(imUserId, uploadId, safeFileName);
    const expiresAt = new Date(Date.now() + config.files.presignExpiry * 1000);

    // 5. Create DB record (pending)
    await prisma.iMFileUpload.create({
      data: {
        id: uploadId,
        imUserId,
        uploadId,
        fileName: safeFileName,
        fileSize,
        mimeType,
        s3Key,
        status: 'pending',
        expiresAt,
      },
    });

    // 6. Generate presigned URL
    if (isS3Available()) {
      const presigned = await createPresignedPost(getS3Client(), {
        Bucket: getBucket(),
        Key: s3Key,
        Conditions: [
          ['content-length-range', 1, config.files.maxSimpleSize],
          ['starts-with', '$Content-Type', mimeType.split('/')[0]],
        ],
        Fields: {
          'Content-Type': mimeType,
        },
        Expires: config.files.presignExpiry,
      });

      console.log(`${LOG} Presign created: uploadId=${uploadId}, key=${s3Key}, size=${fileSize}`);

      return {
        uploadId,
        url: presigned.url,
        fields: presigned.fields,
        expiresAt: expiresAt.toISOString(),
      };
    }

    // Dev mode: return local upload URL
    console.log(`${LOG} [DEV] Presign created: uploadId=${uploadId}, local mode`);
    return {
      uploadId,
      url: `/api/im/files/dev-upload/${uploadId}`,
      fields: { 'Content-Type': mimeType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ── Confirm Upload ──────────────────────────────────

  async confirm(uploadId: string, imUserId: string): Promise<ConfirmResult> {
    // 1. Find upload record
    const upload = await prisma.iMFileUpload.findUnique({ where: { uploadId } });
    if (!upload) {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404);
    }
    if (upload.imUserId !== imUserId) {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404); // Don't leak existence
    }

    // Idempotent: already confirmed
    if (upload.status === 'confirmed' && upload.cdnUrl) {
      return {
        uploadId: upload.uploadId,
        cdnUrl: upload.cdnUrl,
        fileName: upload.fileName,
        fileSize: upload.fileSize,
        mimeType: upload.mimeType,
        sha256: upload.sha256,
        cost: 0,
      };
    }

    if (upload.status !== 'pending') {
      throw new FileServiceError(`Upload status is "${upload.status}", expected "pending"`, 'INVALID_STATE');
    }

    // Check expiry
    if (upload.expiresAt && upload.expiresAt < new Date()) {
      await prisma.iMFileUpload.update({ where: { uploadId }, data: { status: 'failed' } });
      throw new FileServiceError('Upload has expired', 'EXPIRED');
    }

    // 2. Read file head + verify size
    let headBytes: Buffer;
    let actualSize: number;

    if (isS3Available()) {
      // S3 mode: HEAD to get size, GET Range for head bytes
      const s3 = getS3Client();
      const bucket = getBucket();

      const head = await s3.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: upload.s3Key!,
      })).catch(() => null);

      if (!head || !head.ContentLength) {
        await prisma.iMFileUpload.update({ where: { uploadId }, data: { status: 'failed' } });
        throw new FileServiceError('File not found in storage', 'FILE_NOT_UPLOADED');
      }

      actualSize = head.ContentLength;

      // Get first 8KB for magic bytes validation
      const getResult = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: upload.s3Key!,
        Range: 'bytes=0-8191',
      }));
      headBytes = Buffer.from(await getResult.Body!.transformToByteArray());
    } else {
      // Dev mode: read from local filesystem
      const localPath = this.getLocalPath(upload.uploadId, upload.fileName);
      if (!fs.existsSync(localPath)) {
        await prisma.iMFileUpload.update({ where: { uploadId }, data: { status: 'failed' } });
        throw new FileServiceError('File not found in local storage', 'FILE_NOT_UPLOADED');
      }
      const stat = fs.statSync(localPath);
      actualSize = stat.size;

      const fd = fs.openSync(localPath, 'r');
      headBytes = Buffer.alloc(Math.min(8192, actualSize));
      fs.readSync(fd, headBytes, 0, headBytes.length, 0);
      fs.closeSync(fd);
    }

    // 3. Run content validation pipeline
    const validation = await validateFileContent({
      headBytes,
      fileName: upload.fileName,
      declaredMimeType: upload.mimeType,
      declaredSize: upload.fileSize,
      actualSize,
    });

    if (!validation.valid) {
      console.warn(`${LOG} Validation failed for ${uploadId}: ${validation.error}`);
      await prisma.iMFileUpload.update({ where: { uploadId }, data: { status: 'failed' } });
      throw new FileServiceError(
        validation.error || 'File validation failed',
        validation.errorCode || 'VALIDATION_FAILED',
      );
    }

    // 4. Compute SHA-256 over full file content
    const sha256 = await this.computeFullSha256(upload.s3Key!, upload.uploadId, upload.fileName, actualSize);

    // 5. Deduct credits
    const cost = this.calculateCost(actualSize);
    const deductResult = await this.creditService.deduct(
      imUserId, cost, `file_upload: ${upload.fileName}`, 'file_upload', uploadId,
    );
    if (!deductResult.success) {
      throw new FileServiceError('Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    // 6. Build CDN URL and update record
    const cdnUrl = this.buildCdnUrl(upload.s3Key!, upload.uploadId, upload.fileName);

    await prisma.iMFileUpload.update({
      where: { uploadId },
      data: {
        status: 'confirmed',
        sha256,
        cdnUrl,
        fileSize: actualSize,
      },
    });

    console.log(`${LOG} Confirmed: uploadId=${uploadId}, size=${actualSize}, cost=${cost}`);

    return {
      uploadId: upload.uploadId,
      cdnUrl,
      fileName: upload.fileName,
      fileSize: actualSize,
      mimeType: upload.mimeType,
      sha256,
      cost,
    };
  }

  // ── Multipart Upload Init (10-50MB) ─────────────────

  async initMultipart(input: MultipartInitInput, imUserId: string): Promise<MultipartInitResult> {
    const { fileName, fileSize, mimeType } = input;

    // Validate
    const validationError = validateUploadRequest(
      fileName, fileSize, mimeType, config.files.maxMultipartSize,
    );
    if (validationError) {
      throw new FileServiceError(validationError, 'INVALID_INPUT');
    }
    if (fileSize <= config.files.maxSimpleSize) {
      throw new FileServiceError(
        `File size (${fileSize} bytes) is within simple upload limit. Use /presign instead.`,
        'USE_SIMPLE_UPLOAD',
      );
    }

    await this.ensureQuota(imUserId, fileSize);

    // Pre-check credits
    const cost = this.calculateCost(fileSize);
    const balance = await this.creditService.getBalance(imUserId);
    if (balance.balance < cost) {
      throw new FileServiceError('Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    if (!isS3Available()) {
      throw new FileServiceError(
        'Multipart upload is not available in dev mode',
        'NOT_AVAILABLE',
        501,
      );
    }

    const uploadId = this.generateUploadId();
    const safeFileName = sanitizeFileName(fileName);
    const s3Key = this.buildS3Key(imUserId, uploadId, safeFileName);
    const expiresAt = new Date(Date.now() + config.files.uploadTTL * 1000);

    // Start S3 multipart upload
    const s3 = getS3Client();
    const bucket = getBucket();

    const multipart = await s3.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: mimeType,
    }));

    const s3UploadId = multipart.UploadId!;

    // Create DB record with S3 upload ID stored in uploadId field
    await prisma.iMFileUpload.create({
      data: {
        id: uploadId,
        imUserId,
        uploadId: `${uploadId}::${s3UploadId}`, // Composite: our ID + S3 multipart ID
        fileName: safeFileName,
        fileSize,
        mimeType,
        s3Key,
        status: 'pending',
        expiresAt,
      },
    });

    // Generate presigned URLs for each part
    const partCount = Math.ceil(fileSize / config.files.partSize);
    const parts: Array<{ partNumber: number; url: string }> = [];

    for (let i = 1; i <= partCount; i++) {
      const url = await getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: bucket,
          Key: s3Key,
          UploadId: s3UploadId,
          PartNumber: i,
        }),
        { expiresIn: config.files.uploadTTL },
      );
      parts.push({ partNumber: i, url });
    }

    console.log(`${LOG} Multipart init: uploadId=${uploadId}, parts=${partCount}, size=${fileSize}`);

    return {
      uploadId,
      parts,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ── Multipart Upload Complete ───────────────────────

  async completeMultipart(input: MultipartCompleteInput, imUserId: string): Promise<ConfirmResult> {
    const { uploadId, parts } = input;
    this.assertUploadIdFormat(uploadId);

    // Find by composite uploadId (stored as "ourId::s3UploadId")
    const upload = await prisma.iMFileUpload.findFirst({
      where: { uploadId: { startsWith: `${uploadId}::` }, imUserId },
    });
    if (!upload) {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404);
    }
    if (upload.status !== 'pending') {
      throw new FileServiceError(`Upload status is "${upload.status}"`, 'INVALID_STATE');
    }
    if (!isS3Available()) {
      throw new FileServiceError('Multipart not available in dev mode', 'NOT_AVAILABLE', 501);
    }

    // Extract S3 upload ID from composite
    const s3UploadId = upload.uploadId.split('::')[1];
    if (!s3UploadId) {
      throw new FileServiceError('Invalid multipart upload state', 'INVALID_STATE');
    }

    const s3 = getS3Client();
    const bucket = getBucket();

    // Complete S3 multipart
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: upload.s3Key!,
      UploadId: s3UploadId,
      MultipartUpload: {
        Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }));

    // Now confirm (same pipeline as simple upload confirm)
    // Update the uploadId to just our ID for the confirm lookup
    await prisma.iMFileUpload.update({
      where: { id: upload.id },
      data: { uploadId },
    });

    return this.confirm(uploadId, imUserId);
  }

  // ── Quota ───────────────────────────────────────────

  async getQuota(imUserId: string): Promise<FileQuota> {
    const aggregate = await prisma.iMFileUpload.aggregate({
      where: { imUserId, status: 'confirmed' },
      _sum: { fileSize: true },
      _count: true,
    });

    const used = aggregate._sum.fileSize || 0;
    const fileCount = aggregate._count;

    // TODO: determine tier from user subscription. Default to free.
    const tier: string = 'free';
    const limit = tier === 'pro' ? config.files.quotaPro : config.files.quotaFree;

    return { used, limit, tier, fileCount };
  }

  // ── Delete ──────────────────────────────────────────

  async deleteFile(uploadId: string, imUserId: string): Promise<void> {
    this.assertUploadIdFormat(uploadId);
    // Try exact match first, then composite (multipart: "ourId::s3Id")
    const upload = await prisma.iMFileUpload.findUnique({ where: { uploadId } })
      ?? await prisma.iMFileUpload.findFirst({ where: { uploadId: { startsWith: `${uploadId}::` } } });
    if (!upload) {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404);
    }
    if (upload.imUserId !== imUserId) {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404);
    }

    // Already deleted (status=failed means soft-deleted)
    if (upload.status === 'failed') {
      throw new FileServiceError('Upload not found', 'NOT_FOUND', 404);
    }

    // Delete from storage
    if (upload.s3Key) {
      if (isS3Available()) {
        await getS3Client().send(new DeleteObjectCommand({
          Bucket: getBucket(),
          Key: upload.s3Key,
        })).catch(err => console.warn(`${LOG} S3 delete failed for ${upload.s3Key}:`, err));
      } else {
        // Dev mode: delete local file
        const localPath = this.getLocalPath(upload.uploadId, upload.fileName);
        if (fs.existsSync(localPath)) {
          fs.rmSync(path.dirname(localPath), { recursive: true, force: true });
        }
      }
    }

    await prisma.iMFileUpload.update({
      where: { id: upload.id },
      data: { status: 'failed' }, // Reuse 'failed' status for deleted
    });

    console.log(`${LOG} Deleted: uploadId=${uploadId}`);
  }

  // ── Cleanup Expired Uploads ─────────────────────────

  async cleanupExpired(): Promise<number> {
    const expired = await prisma.iMFileUpload.findMany({
      where: {
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      take: 100,
    });

    if (expired.length === 0) return 0;

    for (const upload of expired) {
      try {
        if (upload.s3Key && isS3Available()) {
          await getS3Client().send(new DeleteObjectCommand({
            Bucket: getBucket(),
            Key: upload.s3Key,
          })).catch(() => {}); // Best-effort S3 cleanup
        }
      } catch {
        // Ignore individual cleanup errors
      }
    }

    await prisma.iMFileUpload.updateMany({
      where: { id: { in: expired.map((e: { id: string }) => e.id) } },
      data: { status: 'failed' },
    });

    console.log(`${LOG} Cleaned up ${expired.length} expired uploads`);
    return expired.length;
  }

  // ── Dev Mode: Save uploaded file locally ────────────

  async saveLocalFile(uploadId: string, buffer: Buffer): Promise<void> {
    const upload = await prisma.iMFileUpload.findUnique({ where: { uploadId } });
    if (!upload || upload.status !== 'pending') {
      throw new FileServiceError('Upload not found or not pending', 'NOT_FOUND', 404);
    }

    const dirPath = this.getLocalDir(uploadId);
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = path.join(dirPath, upload.fileName);
    fs.writeFileSync(filePath, buffer);

    console.log(`${LOG} [DEV] Saved local file: ${filePath} (${buffer.length} bytes)`);
  }

  /**
   * Dev mode: serve a confirmed file from local storage.
   * Returns null if not found.
   */
  getLocalFilePath(uploadId: string, fileName: string): string | null {
    const filePath = this.getLocalPath(uploadId, sanitizeFileName(fileName));
    // Path traversal guard: resolved path must stay within uploads directory
    const uploadsRoot = path.resolve(process.cwd(), 'prisma/data/uploads');
    if (!path.resolve(filePath).startsWith(uploadsRoot)) {
      return null;
    }
    return fs.existsSync(filePath) ? filePath : null;
  }

  // ── Helpers ─────────────────────────────────────────

  /** Reject short/malformed uploadIds that could match unintended records via startsWith */
  private assertUploadIdFormat(uploadId: string): void {
    // Valid format: fu_{base36timestamp}_{16hexchars}  (minimum ~25 chars)
    if (!uploadId || uploadId.length < 20 || !uploadId.startsWith('fu_')) {
      throw new FileServiceError('Invalid upload ID format', 'INVALID_INPUT');
    }
  }

  private generateUploadId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `fu_${timestamp}_${random}`;
  }

  private buildS3Key(imUserId: string, uploadId: string, fileName: string): string {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `${config.files.s3KeyPrefix}/${imUserId}/${month}/${uploadId}/${fileName}`;
  }

  private buildCdnUrl(s3Key: string, uploadId: string, fileName: string): string {
    if (config.cdn.domain) {
      const domain = config.cdn.domain.startsWith('http')
        ? config.cdn.domain
        : `https://${config.cdn.domain}`;
      return `${domain}/${s3Key}`;
    }
    // Dev mode: local download URL
    return `/api/im/files/dev-download/${uploadId}/${encodeURIComponent(fileName)}`;
  }

  private calculateCost(fileSize: number): number {
    const mb = Math.ceil(fileSize / (1024 * 1024));
    return Math.max(mb * config.files.costPerMB, config.files.costPerMB); // Minimum 1 MB charge
  }

  private async ensureQuota(imUserId: string, additionalBytes: number): Promise<void> {
    const quota = await this.getQuota(imUserId);
    if (quota.used + additionalBytes > quota.limit) {
      throw new FileServiceError(
        `Storage quota exceeded. Used: ${formatBytes(quota.used)}, Limit: ${formatBytes(quota.limit)}`,
        'QUOTA_EXCEEDED',
        402,
      );
    }
  }

  private async computeFullSha256(
    s3Key: string, uploadId: string, fileName: string, fileSize: number,
  ): Promise<string> {
    const hash = crypto.createHash('sha256');

    if (isS3Available()) {
      // Stream from S3 in 1MB chunks
      const s3 = getS3Client();
      const bucket = getBucket();
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < fileSize; offset += chunkSize) {
        const end = Math.min(offset + chunkSize - 1, fileSize - 1);
        const res = await s3.send(new GetObjectCommand({
          Bucket: bucket, Key: s3Key, Range: `bytes=${offset}-${end}`,
        }));
        hash.update(Buffer.from(await res.Body!.transformToByteArray()));
      }
    } else {
      // Dev mode: read entire local file
      const localPath = this.getLocalPath(uploadId, fileName);
      const content = await fs.promises.readFile(localPath);
      hash.update(content);
    }

    return hash.digest('hex');
  }

  private getLocalDir(uploadId: string): string {
    return path.resolve(process.cwd(), 'prisma/data/uploads', uploadId);
  }

  private getLocalPath(uploadId: string, fileName: string): string {
    return path.join(this.getLocalDir(uploadId), fileName);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
