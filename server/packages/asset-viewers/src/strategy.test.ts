import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES,
  assetTitle,
  classifyAssetViewer,
  firstPreviewUrl,
  isAuthenticatedAssetUrl,
  selectAssetPreviewSource,
  type AssetViewerAsset,
} from './strategy';

function asset(overrides: Partial<AssetViewerAsset> = {}): AssetViewerAsset {
  return {
    id: 'asset-1',
    contentHash: 'a'.repeat(64),
    kind: 'file',
    mime: 'image/png',
    sizeBytes: 128,
    filename: 'preview.png',
    metadata: { title: 'Preview image' },
    cdnUrl: null,
    thumbnailUrl: null,
    previewUrls: null,
    ...overrides,
  };
}

describe('asset viewer strategy', () => {
  it('classifies common release200 viewer families', () => {
    expect(classifyAssetViewer(asset({ mime: 'application/pdf', filename: 'x.bin' }))).toBe('pdf');
    expect(
      classifyAssetViewer(
        asset({
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          filename: 'x.bin',
        }),
      ),
    ).toBe('word');
    expect(classifyAssetViewer(asset({ mime: 'application/octet-stream', filename: 'sheet.xlsx' }))).toBe('sheet');
    expect(classifyAssetViewer(asset({ mime: 'text/markdown', filename: 'notes.txt' }))).toBe('markdown');
    expect(classifyAssetViewer(asset({ mime: 'application/json', filename: 'data.json' }))).toBe('code');
  });

  it('uses preview URL priority medium, large, small', () => {
    expect(
      firstPreviewUrl(
        asset({
          previewUrls: {
            small: 'https://cdn.example/small.webp',
            large: 'https://cdn.example/large.webp',
            medium: 'https://cdn.example/medium.webp',
          },
        }),
      ),
    ).toBe('https://cdn.example/medium.webp');
  });

  it('selects preview, thumbnail, cdn, then private asset URL', () => {
    expect(
      selectAssetPreviewSource(
        asset({
          previewUrls: { medium: '/api/im/assets/thumb-1' },
          thumbnailUrl: 'https://cdn.example/thumb.webp',
          cdnUrl: 'https://cdn.example/original.png',
        }),
        { allowPrivateImage: true },
      ),
    ).toEqual({ url: '/api/im/assets/thumb-1', kind: 'preview', needsAuth: true });

    expect(
      selectAssetPreviewSource(
        asset({
          thumbnailUrl: 'https://cdn.example/thumb.webp',
          cdnUrl: 'https://cdn.example/original.png',
        }),
        { allowPrivateImage: true },
      ),
    ).toEqual({ url: 'https://cdn.example/thumb.webp', kind: 'thumbnail', needsAuth: false });

    expect(
      selectAssetPreviewSource(
        asset({
          cdnUrl: 'https://cdn.example/original.png',
        }),
        { includeThumbnail: false, allowPrivateImage: true },
      ),
    ).toEqual({ url: 'https://cdn.example/original.png', kind: 'cdn', needsAuth: false });

    expect(
      selectAssetPreviewSource(asset({ id: 'private asset', sizeBytes: DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES }), {
        includeThumbnail: false,
        includeCdn: false,
        allowPrivateImage: true,
        maxPrivateImageBytes: DEFAULT_PRIVATE_GALLERY_IMAGE_BYTES,
      }),
    ).toEqual({ url: '/api/im/assets/private%20asset', kind: 'private-asset', needsAuth: true });
  });

  it('does not private-fetch svg or oversized images', () => {
    expect(
      selectAssetPreviewSource(asset({ mime: 'image/svg+xml' }), {
        includeThumbnail: false,
        includeCdn: false,
        allowPrivateImage: true,
      }),
    ).toBeNull();
    expect(
      selectAssetPreviewSource(asset({ sizeBytes: 32 * 1024 * 1024 }), {
        includeThumbnail: false,
        includeCdn: false,
        allowPrivateImage: true,
      }),
    ).toBeNull();
  });

  it('detects same-origin asset endpoints that require bearer auth', () => {
    expect(isAuthenticatedAssetUrl('/api/im/assets/asset-1')).toBe(true);
    expect(isAuthenticatedAssetUrl('http://127.0.0.1:3000/api/im/assets/asset-1')).toBe(true);
    expect(isAuthenticatedAssetUrl('https://cdn.example/assets/asset-1')).toBe(false);
  });

  it('selects stable titles for UI surfaces', () => {
    expect(assetTitle(asset({ metadata: { title: '  Quarterly chart  ' } }))).toBe('Quarterly chart');
    expect(assetTitle(asset({ metadata: {}, filename: 'report.pdf' }))).toBe('report.pdf');
    expect(assetTitle(asset({ metadata: {}, filename: null, contentHash: '1234567890abcdefxxx' }))).toBe(
      '1234567890abcdef',
    );
  });
});
