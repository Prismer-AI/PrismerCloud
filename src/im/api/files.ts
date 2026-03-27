/**
 * Prismer IM — File Upload API Routes
 *
 * Endpoints:
 *   POST /presign          — Simple upload presign (≤ 10MB)
 *   POST /confirm          — Confirm + validate uploaded file
 *   POST /upload/init      — Multipart upload initiate (> 10MB)
 *   POST /upload/complete  — Multipart upload complete + validate
 *   GET  /quota            — User storage quota
 *   DELETE /:uploadId      — Delete file
 *
 * Dev-only (no S3 credentials):
 *   POST /dev-upload/:uploadId    — Accept file upload locally
 *   GET  /dev-download/:uploadId/:fileName — Serve local file
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authMiddleware } from '../auth/middleware';
import { FileService, FileServiceError } from '../services/file.service';
import { config } from '../config';
import { isS3Available } from '../services/s3.client';
import { MIME_WHITELIST } from '../services/file-validator';
import type { ApiResponse } from '../types';
import * as fs from 'fs';

export function createFilesRouter(
  fileService: FileService,
): Hono {
  const router = new Hono();

  // ── Public endpoints (before auth middleware) ───

  // GET /dev-download/:uploadId/:fileName — serve local file (no auth, simulates CDN)
  router.get('/dev-download/:uploadId/:fileName', async (c) => {
    if (isS3Available()) {
      return c.json<ApiResponse>({ ok: false, error: 'Dev download not available when S3 is configured' }, 400);
    }

    const uploadId = c.req.param('uploadId');
    const fileName = decodeURIComponent(c.req.param('fileName'));

    // Block path traversal attempts at route level
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return c.json<ApiResponse>({ ok: false, error: 'Invalid file name' }, 400);
    }

    const filePath = fileService.getLocalFilePath(uploadId, fileName);
    if (!filePath) {
      return c.json<ApiResponse>({ ok: false, error: 'File not found' }, 404);
    }

    const buffer = await fs.promises.readFile(filePath);
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Content-Length': String(buffer.length),
      },
    });
  });

  // All remaining file endpoints require authentication
  router.use('*', authMiddleware);

  // ── POST /presign — Simple upload presign ─────────

  router.post('/presign', async (c) => {
    const user = c.get('user') as { imUserId: string };

    try {
      const body = await c.req.json();
      const { fileName, fileSize, mimeType } = body;

      if (!fileName || typeof fileName !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'fileName is required (string)' }, 400);
      }
      if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0) {
        return c.json<ApiResponse>({ ok: false, error: 'fileSize is required (positive number)' }, 400);
      }
      if (!mimeType || typeof mimeType !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'mimeType is required (string)' }, 400);
      }

      const result = await fileService.presign({ fileName, fileSize, mimeType }, user.imUserId);

      return c.json<ApiResponse>({ ok: true, data: result }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /confirm — Confirm upload ────────────────

  router.post('/confirm', async (c) => {
    const user = c.get('user') as { imUserId: string };

    try {
      const body = await c.req.json();
      const { uploadId } = body;

      if (!uploadId || typeof uploadId !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'uploadId is required (string)' }, 400);
      }

      const result = await fileService.confirm(uploadId, user.imUserId);

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /upload/init — Multipart upload initiate ─

  router.post('/upload/init', async (c) => {
    const user = c.get('user') as { imUserId: string };

    try {
      const body = await c.req.json();
      const { fileName, fileSize, mimeType } = body;

      if (!fileName || typeof fileName !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'fileName is required (string)' }, 400);
      }
      if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0) {
        return c.json<ApiResponse>({ ok: false, error: 'fileSize is required (positive number)' }, 400);
      }
      if (!mimeType || typeof mimeType !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'mimeType is required (string)' }, 400);
      }

      const result = await fileService.initMultipart({ fileName, fileSize, mimeType }, user.imUserId);

      return c.json<ApiResponse>({ ok: true, data: result }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── POST /upload/complete — Multipart complete ────

  router.post('/upload/complete', async (c) => {
    const user = c.get('user') as { imUserId: string };

    try {
      const body = await c.req.json();
      const { uploadId, parts } = body;

      if (!uploadId || typeof uploadId !== 'string') {
        return c.json<ApiResponse>({ ok: false, error: 'uploadId is required (string)' }, 400);
      }
      if (!Array.isArray(parts) || parts.length === 0) {
        return c.json<ApiResponse>({ ok: false, error: 'parts is required (non-empty array)' }, 400);
      }

      // Validate each part has partNumber (number) and etag (string)
      for (const part of parts) {
        if (typeof part.partNumber !== 'number' || typeof part.etag !== 'string') {
          return c.json<ApiResponse>({
            ok: false,
            error: 'Each part must have partNumber (number) and etag (string)',
          }, 400);
        }
      }

      const result = await fileService.completeMultipart(
        { uploadId, parts },
        user.imUserId,
      );

      return c.json<ApiResponse>({ ok: true, data: result });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /quota — User storage quota ───────────────

  router.get('/quota', async (c) => {
    const user = c.get('user') as { imUserId: string };

    try {
      const quota = await fileService.getQuota(user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: quota });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── DELETE /:uploadId — Delete file ───────────────

  router.delete('/:uploadId', async (c) => {
    const user = c.get('user') as { imUserId: string };
    const uploadId = c.req.param('uploadId');

    try {
      await fileService.deleteFile(uploadId, user.imUserId);
      return c.json<ApiResponse>({ ok: true, data: { deleted: true } });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /types — List allowed MIME types ──────────

  router.get('/types', (c) => {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        allowedMimeTypes: Array.from(MIME_WHITELIST),
      },
    });
  });

  // ── Dev-only endpoints (no S3) ────────────────────

  // POST /dev-upload/:uploadId — accept file upload locally
  router.post('/dev-upload/:uploadId', async (c) => {
    if (isS3Available()) {
      return c.json<ApiResponse>({ ok: false, error: 'Dev upload not available when S3 is configured' }, 400);
    }

    const uploadId = c.req.param('uploadId');

    try {
      const body = await c.req.parseBody();
      const file = body['file'];

      if (!file || !(file instanceof File)) {
        return c.json<ApiResponse>({ ok: false, error: 'file field is required (multipart/form-data)' }, 400);
      }

      if (file.size > config.files.maxSimpleSize) {
        return c.json<ApiResponse>({
          ok: false,
          error: `File exceeds maximum size (${Math.round(config.files.maxSimpleSize / 1024 / 1024)}MB)`,
        }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      await fileService.saveLocalFile(uploadId, buffer);

      return c.json<ApiResponse>({ ok: true, data: { uploaded: true, size: buffer.length } });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return router;
}

// ─── Error Handler ──────────────────────────────────

function handleError(c: Context, err: unknown) {
  if (err instanceof FileServiceError) {
    return c.json<ApiResponse>({
      ok: false,
      error: err.message,
      meta: { code: err.code },
    }, err.status as ContentfulStatusCode);
  }

  console.error('[Files API] Unexpected error:', err);
  return c.json<ApiResponse>({
    ok: false,
    error: 'Internal server error',
  }, 500);
}
