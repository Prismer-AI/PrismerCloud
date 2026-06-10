export interface AssetPreviewUrls {
  small?: string | null;
  medium?: string | null;
  large?: string | null;
}

export interface AssetViewerAsset {
  id: string;
  contentHash: string;
  kind?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  filename?: string | null;
  metadata?: Record<string, unknown> | null;
  cdnUrl?: string | null;
  thumbnailUrl?: string | null;
  previewUrls?: AssetPreviewUrls | string[] | null;
}

export type AssetViewerKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'presentation'
  | 'code'
  | 'markdown'
  | 'html'
  | 'text'
  | 'archive'
  | 'binary';

export type AssetPreviewSourceKind = 'preview' | 'thumbnail' | 'cdn' | 'private-asset';

export interface AssetPreviewSource {
  url: string;
  kind: AssetPreviewSourceKind;
  needsAuth: boolean;
}

export const DEFAULT_PRIVATE_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES = 16 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'css',
  'go',
  'h',
  'html',
  'java',
  'js',
  'jsx',
  'json',
  'kt',
  'lua',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);

export function classifyAssetViewer(asset: AssetViewerAsset): AssetViewerKind {
  const mime = (asset.mime ?? '').toLowerCase();
  const kind = (asset.kind ?? '').toLowerCase();
  const ext = extensionOf(asset.filename);

  if (mime.startsWith('image/') || kind === 'image') return 'image';
  if (mime.startsWith('video/') || kind === 'video') return 'video';
  if (mime.startsWith('audio/') || kind === 'audio') return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (isWordMime(mime) || ext === 'docx') return 'word';
  if (isSheetMime(mime) || ['csv', 'tsv', 'xls', 'xlsx', 'parquet'].includes(ext)) return 'sheet';
  if (isPresentationMime(mime) || ext === 'pptx') return 'presentation';
  if (mime === 'text/markdown' || ['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (mime === 'text/html' || ext === 'html') return 'html';
  if (mime.startsWith('text/x-') || CODE_EXTENSIONS.has(ext)) return 'code';
  if (mime.startsWith('text/') || ext === 'log' || ext === 'txt') return 'text';
  if (isArchiveMime(mime) || ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return 'archive';
  return 'binary';
}

export function firstPreviewUrl(asset: AssetViewerAsset): string | null {
  const previewUrls = asset.previewUrls;
  if (Array.isArray(previewUrls)) {
    return previewUrls.map(nonEmpty).find((url): url is string => Boolean(url)) ?? null;
  }
  if (previewUrls && typeof previewUrls === 'object') {
    for (const key of ['medium', 'large', 'small'] as const) {
      const url = nonEmpty(previewUrls[key]);
      if (url) return url;
    }
  }
  return null;
}

export function selectAssetPreviewSource(
  asset: AssetViewerAsset,
  options: {
    includeThumbnail?: boolean;
    includeCdn?: boolean;
    allowPrivateImage?: boolean;
    maxPrivateImageBytes?: number;
  } = {},
): AssetPreviewSource | null {
  const preview = firstPreviewUrl(asset);
  if (preview) {
    return {
      url: preview,
      kind: 'preview',
      needsAuth: isAuthenticatedAssetUrl(preview),
    };
  }

  if (options.includeThumbnail !== false) {
    const thumbnail = nonEmpty(asset.thumbnailUrl);
    if (thumbnail) {
      return {
        url: thumbnail,
        kind: 'thumbnail',
        needsAuth: isAuthenticatedAssetUrl(thumbnail),
      };
    }
  }

  if (options.includeCdn !== false) {
    const cdn = nonEmpty(asset.cdnUrl);
    if (cdn) {
      return {
        url: cdn,
        kind: 'cdn',
        needsAuth: isAuthenticatedAssetUrl(cdn),
      };
    }
  }

  if (
    options.allowPrivateImage &&
    canFetchPrivateImage(asset, options.maxPrivateImageBytes ?? DEFAULT_PRIVATE_IMAGE_BYTES)
  ) {
    return {
      url: `/api/im/assets/${encodeURIComponent(asset.id)}`,
      kind: 'private-asset',
      needsAuth: true,
    };
  }

  return null;
}

export function isGalleryImageAsset(asset: AssetViewerAsset): boolean {
  const mime = (asset.mime ?? '').toLowerCase();
  return classifyAssetViewer(asset) === 'image' && mime !== 'image/svg+xml';
}

export function isAuthenticatedAssetUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith('/api/im/assets/')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.startsWith('/api/im/assets/');
  } catch {
    return false;
  }
}

export function assetTitle(asset: AssetViewerAsset): string {
  const metaTitle = asset.metadata?.title;
  if (typeof metaTitle === 'string' && metaTitle.trim()) return metaTitle.trim();
  if (asset.filename?.trim()) return asset.filename.trim();
  return asset.contentHash ? asset.contentHash.slice(0, 16) : asset.id.slice(-12);
}

function canFetchPrivateImage(asset: AssetViewerAsset, maxBytes: number): boolean {
  if (!isGalleryImageAsset(asset)) return false;
  const size = asset.sizeBytes ?? 0;
  return size > 0 && size <= maxBytes;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extensionOf(filename: string | null | undefined): string {
  const trimmed = filename?.trim().toLowerCase() ?? '';
  const dot = trimmed.lastIndexOf('.');
  return dot >= 0 ? trimmed.slice(dot + 1) : '';
}

function isWordMime(mime: string): boolean {
  return (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword'
  );
}

function isSheetMime(mime: string): boolean {
  return (
    mime === 'text/csv' ||
    mime === 'text/tab-separated-values' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.apache.parquet'
  );
}

function isPresentationMime(mime: string): boolean {
  return (
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
}

function isArchiveMime(mime: string): boolean {
  return [
    'application/zip',
    'application/gzip',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/x-tar',
  ].includes(mime);
}
