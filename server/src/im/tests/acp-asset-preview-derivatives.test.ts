import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createImageThumbnailForPreview,
  createHlsDerivativeForPreview,
  createPdfFirstPageThumbnailForPreview,
  isHlsAsset,
  isPdfAsset,
  isRasterImageAsset,
  isVideoAsset,
  linearizePdfForPreview,
  planHlsDerivativeForPreview,
} from '../services/asset-preview-derivatives.service';

describe('asset preview derivatives', () => {
  let tmpdir: string;

  beforeEach(async () => {
    tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asset-preview-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpdir, { recursive: true, force: true });
  });

  it('detects PDFs by MIME or filename', () => {
    expect(isPdfAsset({ mime: 'application/pdf', filename: 'report.bin' })).toBe(true);
    expect(isPdfAsset({ mime: null, filename: 'report.pdf' })).toBe(true);
    expect(isPdfAsset({ mime: 'text/plain', filename: 'report.txt' })).toBe(false);
  });

  it('skips when qpdf is unavailable', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('spawn qpdf ENOENT');
    });

    const result = await linearizePdfForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'qpdf_unavailable', tool: 'qpdf' });
  });

  it('fails open when qpdf linearization fails', async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === '--version') return { stdout: 'qpdf version 11.0.0\n', stderr: '' };
      throw new Error('damaged PDF');
    });

    const result = await linearizePdfForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'qpdf_failed',
      tool: 'qpdf',
      toolVersion: 'qpdf version 11.0.0',
    });
    expect(result.error).toContain('damaged PDF');
  });

  it('returns linearized bytes and content hash on success', async () => {
    const linearized = Buffer.from('%PDF-1.7\n% linearized\n');
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === '--version') return { stdout: 'qpdf version 11.0.0\n', stderr: '' };
      const outputPath = args[2];
      if (!outputPath) throw new Error('missing qpdf output path');
      await fs.promises.writeFile(outputPath, linearized);
      return { stdout: '', stderr: '' };
    });

    const result = await linearizePdfForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
    });

    expect(result.status).toBe('success');
    expect(result.buffer).toEqual(linearized);
    expect(result.contentHash).toBe(crypto.createHash('sha256').update(linearized).digest('hex'));
  });

  it('detects raster images but skips SVG', () => {
    expect(isRasterImageAsset({ mime: 'image/png', filename: 'image.bin' })).toBe(true);
    expect(isRasterImageAsset({ mime: null, filename: 'photo.jpg' })).toBe(true);
    expect(isRasterImageAsset({ mime: 'image/svg+xml', filename: 'icon.svg' })).toBe(false);
    expect(isRasterImageAsset({ mime: 'application/pdf', filename: 'report.pdf' })).toBe(false);
  });

  it('creates webp image thumbnail bytes with a content hash', async () => {
    const sharp = (await import('sharp')).default;
    const source = await sharp({
      create: {
        width: 640,
        height: 320,
        channels: 4,
        background: { r: 120, g: 40, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const result = await createImageThumbnailForPreview({
      buffer: source,
      mime: 'image/png',
      filename: 'sample.png',
    });

    expect(result.status).toBe('success');
    expect(result.mime).toBe('image/webp');
    expect(result.buffer?.length).toBeGreaterThan(0);
    expect(result.contentHash).toBe(crypto.createHash('sha256').update(result.buffer!).digest('hex'));
    expect(result.width).toBeLessThanOrEqual(512);
    expect(result.height).toBeLessThanOrEqual(512);
  });

  it('skips PDF first-page thumbnails when no local renderer is available', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });

    const result = await createPdfFirstPageThumbnailForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'renderer_unavailable' });
    expect(execFile).toHaveBeenCalledWith('pdftoppm', ['-v'], expect.any(Object));
    expect(execFile).toHaveBeenCalledWith('mutool', ['-v'], expect.any(Object));
  });

  it('creates a PDF first-page webp thumbnail using pdftoppm output', async () => {
    const sharp = (await import('sharp')).default;
    const rendered = await sharp({
      create: {
        width: 300,
        height: 600,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === '-v') return { stdout: '', stderr: 'pdftoppm version 24.02.0\n' };
      const prefix = args[args.length - 1];
      if (!prefix) throw new Error('missing pdftoppm output prefix');
      await fs.promises.writeFile(`${prefix}.png`, rendered);
      return { stdout: '', stderr: '' };
    });

    const result = await createPdfFirstPageThumbnailForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
      sizePx: 256,
    });

    expect(result.status).toBe('success');
    expect(result.tool).toBe('pdftoppm');
    expect(result.toolVersion).toBe('pdftoppm version 24.02.0');
    expect(result.mime).toBe('image/webp');
    expect(result.buffer?.length).toBeGreaterThan(0);
    expect(result.contentHash).toBe(crypto.createHash('sha256').update(result.buffer!).digest('hex'));
    expect(result.width).toBeLessThanOrEqual(256);
    expect(result.height).toBeLessThanOrEqual(256);
  });

  it('falls back to mutool for PDF first-page thumbnails when pdftoppm is unavailable', async () => {
    const sharp = (await import('sharp')).default;
    const rendered = await sharp({
      create: {
        width: 500,
        height: 250,
        channels: 4,
        background: { r: 30, g: 80, b: 140, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'pdftoppm') throw new Error('spawn pdftoppm ENOENT');
      if (file === 'mutool' && args[0] === '-v') return { stdout: 'mutool 1.24.0\n', stderr: '' };
      const outputIndex = args.indexOf('-o') + 1;
      const outputPath = args[outputIndex];
      if (!outputPath) throw new Error('missing mutool output path');
      await fs.promises.writeFile(outputPath, rendered);
      return { stdout: '', stderr: '' };
    });

    const result = await createPdfFirstPageThumbnailForPreview({
      buffer: Buffer.from('%PDF-1.7\n'),
      mime: 'application/pdf',
      filename: 'report.pdf',
      execFile,
      tmpdir,
    });

    expect(result.status).toBe('success');
    expect(result.tool).toBe('mutool');
    expect(result.mime).toBe('image/webp');
  });

  it('detects video and existing HLS assets', () => {
    expect(isVideoAsset({ mime: 'video/mp4', filename: 'clip.bin' })).toBe(true);
    expect(isVideoAsset({ mime: null, filename: 'clip.mov' })).toBe(true);
    expect(isVideoAsset({ mime: 'application/vnd.apple.mpegurl', filename: 'index.m3u8' })).toBe(false);
    expect(isHlsAsset({ mime: 'application/vnd.apple.mpegurl', filename: 'index.txt' })).toBe(true);
    expect(isHlsAsset({ mime: null, filename: 'index.m3u8' })).toBe(true);
  });

  it('plans deterministic HLS derivative output metadata without running ffmpeg', () => {
    const contentHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const result = planHlsDerivativeForPreview({
      contentHash,
      mime: 'video/mp4',
      filename: 'clip.mp4',
      sizeBytes: 150 * 1024 * 1024,
      keyPrefix: '/asset-previews/',
      variants: ['480p', '720p'],
    });

    expect(result.status).toBe('eligible');
    expect(result.outputMime).toBe('application/vnd.apple.mpegurl');
    expect(result.outputKeys).toEqual({
      rootPrefix: `asset-previews/hls/ab/cd/${contentHash}`,
      manifestKey: `asset-previews/hls/ab/cd/${contentHash}/master.m3u8`,
      variantManifestKeys: {
        '480p': `asset-previews/hls/ab/cd/${contentHash}/480p/index.m3u8`,
        '720p': `asset-previews/hls/ab/cd/${contentHash}/720p/index.m3u8`,
      },
      segmentPrefix: `asset-previews/hls/ab/cd/${contentHash}/segments`,
    });
    expect(result.metadata).toMatchObject({
      type: 'hls',
      plannerVersion: 1,
      sourceContentHash: contentHash,
      sourceMime: 'video/mp4',
      sourceSizeBytes: 150 * 1024 * 1024,
    });
  });

  it('skips HLS planning for small, non-video, disabled, or existing HLS inputs', () => {
    const contentHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    expect(
      planHlsDerivativeForPreview({
        contentHash,
        mime: 'video/mp4',
        filename: 'clip.mp4',
        sizeBytes: 10 * 1024 * 1024,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'too_small' });
    expect(
      planHlsDerivativeForPreview({
        contentHash,
        mime: 'application/pdf',
        filename: 'report.pdf',
        sizeBytes: 150 * 1024 * 1024,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'not_video' });
    expect(
      planHlsDerivativeForPreview({
        contentHash,
        mime: 'video/mp4',
        filename: 'clip.mp4',
        sizeBytes: 150 * 1024 * 1024,
        enabled: false,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(
      planHlsDerivativeForPreview({
        contentHash,
        mime: 'application/vnd.apple.mpegurl',
        filename: 'index.m3u8',
        sizeBytes: 150 * 1024 * 1024,
      }),
    ).toMatchObject({ status: 'skipped', reason: 'already_hls' });
  });

  it('skips local HLS creation when ffmpeg is unavailable', async () => {
    const contentHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const execFile = vi.fn(async () => {
      throw new Error('spawn ffmpeg ENOENT');
    });

    const result = await createHlsDerivativeForPreview({
      buffer: Buffer.from('video bytes'),
      contentHash,
      mime: 'video/mp4',
      filename: 'clip.mp4',
      sizeBytes: 150 * 1024 * 1024,
      execFile,
      tmpdir,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'ffmpeg_unavailable',
      tool: 'ffmpeg',
      plan: { status: 'eligible' },
    });
  });

  it('creates local HLS manifests and segment descriptors from ffmpeg output', async () => {
    const contentHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[0] === '-version') return { stdout: 'ffmpeg version 7.0 test\n', stderr: '' };
      const outputManifest = args[args.length - 1];
      const segmentPattern = args[args.indexOf('-hls_segment_filename') + 1];
      if (!outputManifest || !segmentPattern) throw new Error('missing HLS output args');
      await fs.promises.mkdir(path.dirname(outputManifest), { recursive: true });
      await fs.promises.writeFile(outputManifest, '#EXTM3U\n#EXTINF:6,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
      await fs.promises.writeFile(segmentPattern.replace('%05d', '00000'), Buffer.from('segment bytes'));
      return { stdout: '', stderr: '' };
    });

    const result = await createHlsDerivativeForPreview({
      buffer: Buffer.from('video bytes'),
      contentHash,
      mime: 'video/mp4',
      filename: 'clip.mp4',
      sizeBytes: 150 * 1024 * 1024,
      keyPrefix: '/asset-previews/',
      variants: ['720p'],
      execFile,
      tmpdir,
    });

    expect(result.status).toBe('success');
    expect(result.toolVersion).toBe('ffmpeg version 7.0 test');
    expect(result.manifest).toMatchObject({
      key: `asset-previews/hls/ab/cd/${contentHash}/master.m3u8`,
      mime: 'application/vnd.apple.mpegurl',
    });
    expect(result.manifest?.contentHash).toBe(
      crypto.createHash('sha256').update(result.manifest!.buffer).digest('hex'),
    );
    expect(result.files?.map((file) => file.key).sort()).toEqual([
      `asset-previews/hls/ab/cd/${contentHash}/720p/index.m3u8`,
      `asset-previews/hls/ab/cd/${contentHash}/720p/segment-00000.ts`,
      `asset-previews/hls/ab/cd/${contentHash}/master.m3u8`,
    ]);
    expect(result.metadata).toMatchObject({
      type: 'hls',
      plannerVersion: 1,
      workerVersion: 1,
      sourceContentHash: contentHash,
      tool: 'ffmpeg',
      variants: ['720p'],
    });
  });
});
