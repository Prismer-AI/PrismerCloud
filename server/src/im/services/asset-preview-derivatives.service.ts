import { execFile as execFileCallback } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);
const QPDF_TIMEOUT_MS = 30_000;
const PDF_THUMBNAIL_TIMEOUT_MS = 30_000;
const FFMPEG_HLS_TIMEOUT_MS = 10 * 60_000;
const IMAGE_THUMBNAIL_SIZE_PX = 512;
const IMAGE_THUMBNAIL_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const IMAGE_THUMBNAIL_MAX_PIXELS = 80_000_000;
const VIDEO_HLS_MIN_BYTES = 100 * 1024 * 1024;

export type PdfLinearizeStatus = 'success' | 'skipped' | 'failed';
export type PdfLinearizeReason = 'not_pdf' | 'disabled' | 'qpdf_unavailable' | 'qpdf_failed';

export interface PdfLinearizeResult {
  status: PdfLinearizeStatus;
  reason?: PdfLinearizeReason;
  buffer?: Buffer;
  contentHash?: string;
  tool?: 'qpdf';
  toolVersion?: string | null;
  error?: string;
}

export type ImageThumbnailStatus = 'success' | 'skipped' | 'failed';
export type ImageThumbnailReason = 'not_image' | 'disabled' | 'too_large' | 'sharp_unavailable' | 'sharp_failed';

export interface ImageThumbnailResult {
  status: ImageThumbnailStatus;
  reason?: ImageThumbnailReason;
  buffer?: Buffer;
  contentHash?: string;
  mime?: 'image/webp';
  width?: number;
  height?: number;
  error?: string;
}

export type PdfFirstPageThumbnailStatus = 'success' | 'skipped' | 'failed';
export type PdfFirstPageThumbnailReason =
  | 'not_pdf'
  | 'disabled'
  | 'renderer_unavailable'
  | 'sharp_unavailable'
  | 'render_failed'
  | 'sharp_failed';

export type PdfFirstPageThumbnailTool = 'pdftoppm' | 'mutool';

export interface PdfFirstPageThumbnailResult {
  status: PdfFirstPageThumbnailStatus;
  reason?: PdfFirstPageThumbnailReason;
  buffer?: Buffer;
  contentHash?: string;
  mime?: 'image/webp';
  width?: number;
  height?: number;
  page?: number;
  tool?: PdfFirstPageThumbnailTool;
  toolVersion?: string | null;
  error?: string;
}

export type HlsPlanStatus = 'eligible' | 'skipped';
export type HlsPlanReason = 'not_video' | 'disabled' | 'too_small' | 'already_hls';
export type HlsDerivativeStatus = 'success' | 'skipped' | 'failed';
export type HlsDerivativeReason = HlsPlanReason | 'ffmpeg_unavailable' | 'ffmpeg_failed';

export interface HlsOutputKeys {
  rootPrefix: string;
  manifestKey: string;
  variantManifestKeys: Record<string, string>;
  segmentPrefix: string;
}

export interface HlsDerivativePlan {
  status: HlsPlanStatus;
  reason?: HlsPlanReason;
  contentHash: string;
  sourceMime: string | null;
  sourceSizeBytes: number;
  outputMime?: 'application/vnd.apple.mpegurl';
  outputKeys?: HlsOutputKeys;
  variants?: readonly string[];
  metadata?: {
    type: 'hls';
    plannerVersion: 1;
    sourceContentHash: string;
    sourceMime: string | null;
    sourceSizeBytes: number;
    minSizeBytes: number;
  };
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number; cwd?: string },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

interface LinearizePdfInput {
  buffer: Buffer;
  mime: string | null;
  filename?: string | null;
  enabled?: boolean;
  execFile?: ExecFileLike;
  tmpdir?: string;
}

interface CreateImageThumbnailInput {
  buffer: Buffer;
  mime: string | null;
  filename?: string | null;
  enabled?: boolean;
  maxInputBytes?: number;
}

export interface CreatePdfFirstPageThumbnailInput {
  buffer: Buffer;
  mime: string | null;
  filename?: string | null;
  enabled?: boolean;
  execFile?: ExecFileLike;
  tmpdir?: string;
  sizePx?: number;
  page?: number;
}

export interface PlanHlsDerivativeInput {
  contentHash: string;
  mime: string | null;
  filename?: string | null;
  sizeBytes: number;
  enabled?: boolean;
  minSizeBytes?: number;
  keyPrefix?: string;
  variants?: readonly string[];
}

export interface CreateHlsDerivativeInput extends PlanHlsDerivativeInput {
  buffer: Buffer;
  execFile?: ExecFileLike;
  tmpdir?: string;
  timeoutMs?: number;
}

export interface HlsDerivativeFile {
  key: string;
  relativePath: string;
  buffer: Buffer;
  contentHash: string;
  mime: 'application/vnd.apple.mpegurl' | 'video/mp2t';
}

export interface HlsDerivativeResult {
  status: HlsDerivativeStatus;
  reason?: HlsDerivativeReason;
  plan: HlsDerivativePlan;
  files?: HlsDerivativeFile[];
  manifest?: {
    key: string;
    buffer: Buffer;
    contentHash: string;
    mime: 'application/vnd.apple.mpegurl';
  };
  metadata?: {
    type: 'hls';
    plannerVersion: 1;
    workerVersion: 1;
    sourceContentHash: string;
    sourceMime: string | null;
    sourceSizeBytes: number;
    variants: readonly string[];
    outputKeys: HlsOutputKeys;
    tool: 'ffmpeg';
    toolVersion: string | null;
  };
  tool?: 'ffmpeg';
  toolVersion?: string | null;
  error?: string;
}

// release202/13 §3b① — thumbHash is encoded from a tiny RGBA buffer. The
// `thumbhash` encoder caps both dimensions at 100px, so we downsize hard. A
// non-image / decode failure returns null (best-effort — never blocks a job).
const THUMBHASH_MAX_DIM_PX = 64;

/**
 * Compute a base64 thumbHash (~20-30 chars) from raw image bytes.
 *
 * Decodes to a small RGBA buffer via sharp (already a worker dependency) and
 * encodes with `thumbhash`. Returns `null` on any failure — callers treat
 * blurHash as a best-effort enhancement and must not fail the derivative job.
 */
export async function computeThumbHashForImage(input: {
  buffer: Buffer;
  mime: string | null;
  filename?: string | null;
}): Promise<string | null> {
  if (!isRasterImageAsset({ mime: input.mime, filename: input.filename })) return null;

  let sharp: typeof import('sharp');
  try {
    const sharpModule = await import('sharp');
    sharp = (sharpModule.default ?? sharpModule) as unknown as typeof import('sharp');
  } catch {
    return null;
  }

  try {
    const { data, info } = await sharp(input.buffer, {
      animated: false,
      failOn: 'none',
      limitInputPixels: IMAGE_THUMBNAIL_MAX_PIXELS,
    })
      .rotate()
      .resize({
        width: THUMBHASH_MAX_DIM_PX,
        height: THUMBHASH_MAX_DIM_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width < 1 || info.height < 1) return null;
    const { rgbaToThumbHash } = await import('thumbhash');
    const hash = rgbaToThumbHash(info.width, info.height, new Uint8Array(data));
    return Buffer.from(hash).toString('base64');
  } catch {
    return null;
  }
}

export function isPdfAsset(input: { mime: string | null; filename?: string | null }): boolean {
  const mime = input.mime ?? '';
  const filename = (input.filename ?? '').toLowerCase();
  return mime.includes('pdf') || filename.endsWith('.pdf');
}

export function isRasterImageAsset(input: { mime: string | null; filename?: string | null }): boolean {
  const mime = (input.mime ?? '').toLowerCase();
  const filename = (input.filename ?? '').toLowerCase();
  if (mime === 'image/svg+xml' || filename.endsWith('.svg')) return false;
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|avif|tiff?|bmp)$/i.test(filename);
}

export function isVideoAsset(input: { mime: string | null; filename?: string | null }): boolean {
  const mime = (input.mime ?? '').toLowerCase();
  const filename = (input.filename ?? '').toLowerCase();
  if (mime === 'application/vnd.apple.mpegurl' || filename.endsWith('.m3u8')) return false;
  if (mime.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(filename);
}

export function isHlsAsset(input: { mime: string | null; filename?: string | null }): boolean {
  const mime = (input.mime ?? '').toLowerCase();
  const filename = (input.filename ?? '').toLowerCase();
  return mime === 'application/vnd.apple.mpegurl' || filename.endsWith('.m3u8');
}

function formatExecError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function detectQpdf(execFileImpl: ExecFileLike): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await execFileImpl('qpdf', ['--version'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const version = String(result.stdout || result.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return { available: true, version: version ?? null };
  } catch {
    return { available: false, version: null };
  }
}

async function detectPdfThumbnailTool(
  execFileImpl: ExecFileLike,
): Promise<{ available: true; tool: PdfFirstPageThumbnailTool; version: string | null } | { available: false }> {
  const candidates: Array<{
    tool: PdfFirstPageThumbnailTool;
    args: readonly string[];
  }> = [
    { tool: 'pdftoppm', args: ['-v'] },
    { tool: 'mutool', args: ['-v'] },
  ];

  for (const candidate of candidates) {
    try {
      const result = await execFileImpl(candidate.tool, candidate.args, { timeout: 5_000, maxBuffer: 64 * 1024 });
      const version = String(result.stdout || result.stderr || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return { available: true, tool: candidate.tool, version: version ?? null };
    } catch {
      // Try the next renderer. Some installations only ship one of poppler or mupdf.
    }
  }

  return { available: false };
}

async function detectFfmpeg(execFileImpl: ExecFileLike): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await execFileImpl('ffmpeg', ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const version = String(result.stdout || result.stderr || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return { available: true, version: version ?? null };
  } catch {
    return { available: false, version: null };
  }
}

export async function linearizePdfForPreview(input: LinearizePdfInput): Promise<PdfLinearizeResult> {
  if (!isPdfAsset({ mime: input.mime, filename: input.filename })) {
    return { status: 'skipped', reason: 'not_pdf' };
  }
  if (input.enabled === false || process.env.ASSET_PDF_LINEARIZE === '0') {
    return { status: 'skipped', reason: 'disabled' };
  }

  const execFileImpl = input.execFile ?? execFile;
  const qpdf = await detectQpdf(execFileImpl);
  if (!qpdf.available) {
    return { status: 'skipped', reason: 'qpdf_unavailable', tool: 'qpdf' };
  }

  const dir = await fs.promises.mkdtemp(path.join(input.tmpdir ?? os.tmpdir(), 'prismer-pdf-linearize-'));
  const sourcePath = path.join(dir, 'source.pdf');
  const outputPath = path.join(dir, 'linearized.pdf');

  try {
    await fs.promises.writeFile(sourcePath, input.buffer);
    await execFileImpl('qpdf', ['--linearize', sourcePath, outputPath], {
      timeout: QPDF_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const buffer = await fs.promises.readFile(outputPath);
    return {
      status: 'success',
      buffer,
      contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      tool: 'qpdf',
      toolVersion: qpdf.version,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'qpdf_failed',
      tool: 'qpdf',
      toolVersion: qpdf.version,
      error: formatExecError(err),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function createImageThumbnailForPreview(input: CreateImageThumbnailInput): Promise<ImageThumbnailResult> {
  if (!isRasterImageAsset({ mime: input.mime, filename: input.filename })) {
    return { status: 'skipped', reason: 'not_image' };
  }
  if (input.enabled === false || process.env.ASSET_IMAGE_THUMBNAILS === '0') {
    return { status: 'skipped', reason: 'disabled' };
  }
  const maxInputBytes = input.maxInputBytes ?? IMAGE_THUMBNAIL_MAX_INPUT_BYTES;
  if (input.buffer.length > maxInputBytes) {
    return { status: 'skipped', reason: 'too_large' };
  }

  let sharp: typeof import('sharp');
  try {
    const sharpModule = await import('sharp');
    sharp = (sharpModule.default ?? sharpModule) as unknown as typeof import('sharp');
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'sharp_unavailable',
      error: formatExecError(err),
    };
  }

  try {
    const output = await sharp(input.buffer, {
      animated: false,
      failOn: 'none',
      limitInputPixels: IMAGE_THUMBNAIL_MAX_PIXELS,
    })
      .rotate()
      .resize({
        width: IMAGE_THUMBNAIL_SIZE_PX,
        height: IMAGE_THUMBNAIL_SIZE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      status: 'success',
      buffer: output.data,
      contentHash: crypto.createHash('sha256').update(output.data).digest('hex'),
      mime: 'image/webp',
      width: output.info.width,
      height: output.info.height,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'sharp_failed',
      error: formatExecError(err),
    };
  }
}

export async function createPdfFirstPageThumbnailForPreview(
  input: CreatePdfFirstPageThumbnailInput,
): Promise<PdfFirstPageThumbnailResult> {
  if (!isPdfAsset({ mime: input.mime, filename: input.filename })) {
    return { status: 'skipped', reason: 'not_pdf' };
  }
  if (input.enabled === false || process.env.ASSET_PDF_FIRST_PAGE_THUMBNAILS === '0') {
    return { status: 'skipped', reason: 'disabled' };
  }

  const execFileImpl = input.execFile ?? execFile;
  const renderer = await detectPdfThumbnailTool(execFileImpl);
  if (!renderer.available) {
    return { status: 'skipped', reason: 'renderer_unavailable' };
  }

  let sharp: typeof import('sharp');
  try {
    const sharpModule = await import('sharp');
    sharp = (sharpModule.default ?? sharpModule) as unknown as typeof import('sharp');
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'sharp_unavailable',
      tool: renderer.tool,
      toolVersion: renderer.version,
      error: formatExecError(err),
    };
  }

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const sizePx = Math.max(64, Math.min(2048, Math.floor(input.sizePx ?? IMAGE_THUMBNAIL_SIZE_PX)));
  const dir = await fs.promises.mkdtemp(path.join(input.tmpdir ?? os.tmpdir(), 'prismer-pdf-thumb-'));
  const sourcePath = path.join(dir, 'source.pdf');
  const renderedPath = path.join(dir, 'page.png');

  try {
    await fs.promises.writeFile(sourcePath, input.buffer);
    if (renderer.tool === 'pdftoppm') {
      const prefix = path.join(dir, 'page');
      await execFileImpl(
        'pdftoppm',
        ['-f', String(page), '-singlefile', '-png', '-scale-to', String(sizePx), sourcePath, prefix],
        { timeout: PDF_THUMBNAIL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      await fs.promises.rename(`${prefix}.png`, renderedPath);
    } else {
      await execFileImpl('mutool', ['draw', '-o', renderedPath, '-F', 'png', '-r', '144', sourcePath, String(page)], {
        timeout: PDF_THUMBNAIL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    }
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return {
      status: 'failed',
      reason: 'render_failed',
      tool: renderer.tool,
      toolVersion: renderer.version,
      error: formatExecError(err),
    };
  }

  try {
    const output = await sharp(renderedPath, {
      animated: false,
      failOn: 'none',
      limitInputPixels: IMAGE_THUMBNAIL_MAX_PIXELS,
    })
      .rotate()
      .resize({
        width: sizePx,
        height: sizePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      status: 'success',
      buffer: output.data,
      contentHash: crypto.createHash('sha256').update(output.data).digest('hex'),
      mime: 'image/webp',
      width: output.info.width,
      height: output.info.height,
      page,
      tool: renderer.tool,
      toolVersion: renderer.version,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'sharp_failed',
      tool: renderer.tool,
      toolVersion: renderer.version,
      error: formatExecError(err),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function planHlsDerivativeForPreview(input: PlanHlsDerivativeInput): HlsDerivativePlan {
  const minSizeBytes = input.minSizeBytes ?? VIDEO_HLS_MIN_BYTES;
  const sourceMime = input.mime;
  const base = {
    contentHash: input.contentHash,
    sourceMime,
    sourceSizeBytes: input.sizeBytes,
  };

  if (input.enabled === false || process.env.ASSET_VIDEO_HLS === '0') {
    return { ...base, status: 'skipped', reason: 'disabled' };
  }
  if (isHlsAsset({ mime: input.mime, filename: input.filename })) {
    return { ...base, status: 'skipped', reason: 'already_hls' };
  }
  if (!isVideoAsset({ mime: input.mime, filename: input.filename })) {
    return { ...base, status: 'skipped', reason: 'not_video' };
  }
  if (input.sizeBytes < minSizeBytes) {
    return { ...base, status: 'skipped', reason: 'too_small' };
  }

  const variants = input.variants ?? ['720p'];
  const keyPrefix = (input.keyPrefix ?? 'asset-derivatives').replace(/^\/+|\/+$/g, '');
  const hashPrefix = `${input.contentHash.slice(0, 2)}/${input.contentHash.slice(2, 4)}/${input.contentHash}`;
  const rootPrefix = `${keyPrefix}/hls/${hashPrefix}`;
  const variantManifestKeys = Object.fromEntries(
    variants.map((variant) => [variant, `${rootPrefix}/${variant}/index.m3u8`]),
  );

  return {
    ...base,
    status: 'eligible',
    outputMime: 'application/vnd.apple.mpegurl',
    outputKeys: {
      rootPrefix,
      manifestKey: `${rootPrefix}/master.m3u8`,
      variantManifestKeys,
      segmentPrefix: `${rootPrefix}/segments`,
    },
    variants,
    metadata: {
      type: 'hls',
      plannerVersion: 1,
      sourceContentHash: input.contentHash,
      sourceMime,
      sourceSizeBytes: input.sizeBytes,
      minSizeBytes,
    },
  };
}

export async function createHlsDerivativeForPreview(input: CreateHlsDerivativeInput): Promise<HlsDerivativeResult> {
  const plan = planHlsDerivativeForPreview(input);
  if (plan.status !== 'eligible' || !plan.outputKeys || !plan.variants) {
    return { status: 'skipped', reason: plan.reason, plan };
  }

  const execFileImpl = input.execFile ?? execFile;
  const ffmpeg = await detectFfmpeg(execFileImpl);
  if (!ffmpeg.available) {
    return { status: 'skipped', reason: 'ffmpeg_unavailable', plan, tool: 'ffmpeg' };
  }

  const dir = await fs.promises.mkdtemp(path.join(input.tmpdir ?? os.tmpdir(), 'prismer-hls-'));
  const sourcePath = path.join(dir, `source${hlsSourceExtension(input.mime, input.filename)}`);
  const outputDir = path.join(dir, 'hls');
  const variant = plan.variants[0] ?? '720p';
  const variantDir = path.join(outputDir, variant);

  try {
    await fs.promises.mkdir(variantDir, { recursive: true });
    await fs.promises.writeFile(sourcePath, input.buffer);
    await execFileImpl(
      'ffmpeg',
      [
        '-y',
        '-i',
        sourcePath,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'main',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-hls_time',
        '6',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(variantDir, 'segment-%05d.ts'),
        path.join(variantDir, 'index.m3u8'),
      ],
      { timeout: input.timeoutMs ?? FFMPEG_HLS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );

    const variantManifestKey = plan.outputKeys.variantManifestKeys[variant];
    if (!variantManifestKey) throw new Error(`missing variant manifest key for ${variant}`);
    const masterManifest = renderHlsMasterManifest({ variant, variantManifestKey });
    await fs.promises.writeFile(path.join(outputDir, 'master.m3u8'), masterManifest);

    const files = await collectHlsDerivativeFiles({
      rootDir: outputDir,
      rootPrefix: plan.outputKeys.rootPrefix,
      manifestKey: plan.outputKeys.manifestKey,
      variantManifestKeys: plan.outputKeys.variantManifestKeys,
    });
    const manifest = files.find((file) => file.key === plan.outputKeys?.manifestKey);
    if (!manifest || manifest.mime !== 'application/vnd.apple.mpegurl') {
      throw new Error('HLS master manifest was not produced');
    }

    return {
      status: 'success',
      plan,
      files,
      manifest: {
        key: manifest.key,
        buffer: manifest.buffer,
        contentHash: manifest.contentHash,
        mime: manifest.mime,
      },
      metadata: {
        type: 'hls',
        plannerVersion: 1,
        workerVersion: 1,
        sourceContentHash: input.contentHash,
        sourceMime: input.mime,
        sourceSizeBytes: input.sizeBytes,
        variants: plan.variants,
        outputKeys: plan.outputKeys,
        tool: 'ffmpeg',
        toolVersion: ffmpeg.version,
      },
      tool: 'ffmpeg',
      toolVersion: ffmpeg.version,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'ffmpeg_failed',
      plan,
      tool: 'ffmpeg',
      toolVersion: ffmpeg.version,
      error: formatExecError(err),
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function hlsSourceExtension(mime: string | null, filename?: string | null): string {
  const ext = path.extname(filename ?? '').toLowerCase();
  if (ext && ext.length <= 8) return ext;
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/quicktime') return '.mov';
  return '.mp4';
}

function renderHlsMasterManifest(input: { variant: string; variantManifestKey: string }): string {
  const variantPath = input.variantManifestKey.split('/').slice(-2).join('/');
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=${resolutionForHlsVariant(input.variant)}`,
    variantPath,
    '',
  ].join('\n');
}

function resolutionForHlsVariant(variant: string): string {
  if (variant === '1080p') return '1920x1080';
  if (variant === '480p') return '854x480';
  if (variant === '360p') return '640x360';
  return '1280x720';
}

async function collectHlsDerivativeFiles(input: {
  rootDir: string;
  rootPrefix: string;
  manifestKey: string;
  variantManifestKeys: Record<string, string>;
}): Promise<HlsDerivativeFile[]> {
  const out: HlsDerivativeFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(input.rootDir, full).replace(/\\/g, '/');
      const key = hlsKeyForRelativePath(input, relativePath);
      const buffer = await fs.promises.readFile(full);
      const isManifest = relativePath.endsWith('.m3u8');
      out.push({
        key,
        relativePath,
        buffer,
        contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
        mime: isManifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      });
    }
  };
  await walk(input.rootDir);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function hlsKeyForRelativePath(
  input: { rootPrefix: string; manifestKey: string; variantManifestKeys: Record<string, string> },
  relativePath: string,
): string {
  if (relativePath === 'master.m3u8') return input.manifestKey;
  const variant = relativePath.split('/')[0];
  if (variant && relativePath === `${variant}/index.m3u8` && input.variantManifestKeys[variant]) {
    return input.variantManifestKeys[variant];
  }
  return `${input.rootPrefix}/${relativePath}`;
}
