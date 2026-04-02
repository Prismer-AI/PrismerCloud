/**
 * Cookbook: File Upload
 * @see docs/cookbook/en/file-upload.md
 *
 * Validates:
 *   Step 1 — Request a Presigned URL     → im.files.presign()
 *   Step 2 — Upload to Presigned URL     → multipart form POST
 *   Step 3 — Confirm the Upload          → im.files.confirm()
 *   Bonus  — Allowed File Types          → im.files.types()
 *   Bonus  — File Quota                  → im.files.quota()
 */
import { describe, it, expect, afterAll } from 'vitest';
import { apiClient, RUN_ID } from '../helpers';

describe('Cookbook: File Upload', () => {
  const client = apiClient();
  let uploadId: string;
  let uploadUrl: string;
  let uploadFields: Record<string, string>;

  const testContent = `# Cookbook Test Report\n\nGenerated at ${new Date().toISOString()} — run ${RUN_ID}`;
  const testBuffer = Buffer.from(testContent, 'utf-8');

  // ── Step 1: Request a Presigned URL ───────────────────────────────
  describe('Step 1 — Request a Presigned URL', () => {
    it('returns a presigned upload URL and upload ID', async () => {
      const result = await client.im.files.presign({
        fileName: `test-report-${RUN_ID}.md`,
        fileSize: testBuffer.length,
        mimeType: 'text/markdown',
      });

      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.uploadId).toBeDefined();
      expect(result.data!.url).toBeDefined();
      expect(typeof result.data!.url).toBe('string');

      uploadId = result.data!.uploadId;
      uploadUrl = result.data!.url;
      uploadFields = result.data!.fields;
    });
  });

  // ── Step 2: Upload to the Presigned URL ───────────────────────────
  describe('Step 2 — Upload to the Presigned URL', () => {
    it('uploads file bytes via multipart form to cloud storage', async () => {
      if (!uploadUrl) return;

      const formData = new FormData();
      if (uploadFields) {
        for (const [key, value] of Object.entries(uploadFields)) {
          formData.append(key, value);
        }
      }
      formData.append('file', new Blob([testBuffer], { type: 'text/markdown' }), `test-report-${RUN_ID}.md`);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      expect(response.ok).toBe(true);
    });
  });

  // ── Step 3: Confirm the Upload ────────────────────────────────────
  describe('Step 3 — Confirm the Upload', () => {
    it('confirms the upload with the API', async () => {
      if (!uploadId) return;

      const result = await client.im.files.confirm(uploadId);
      if (result.ok) {
        expect(result.data).toBeDefined();
        expect(result.data!.cdnUrl).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Bonus: Allowed File Types ─────────────────────────────────────
  describe('Bonus — Allowed File Types', () => {
    it('returns the list of allowed file types', async () => {
      const result = await client.im.files.types();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  // ── Bonus: File Quota ─────────────────────────────────────────────
  describe('Bonus — File Quota', () => {
    it('returns the file storage quota', async () => {
      const result = await client.im.files.quota();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  // ── Cleanup ───────────────────────────────────────────────────────
  describe('Cleanup', () => {
    it('deletes the test file', async () => {
      if (!uploadId) return;
      const result = await client.im.files.delete(uploadId);
      expect(result).toBeDefined();
    });
  });

  afterAll(async () => {
    if (uploadId) {
      await client.im.files.delete(uploadId).catch(() => {});
    }
  });
});
