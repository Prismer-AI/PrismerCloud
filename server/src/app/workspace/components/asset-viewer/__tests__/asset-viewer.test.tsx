/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetImageGallery, filterImageGalleryCandidates, imageGalleryCandidates } from '../asset-image-gallery';
import { AssetViewer } from '../asset-viewer';
import type { AssetDTO } from '../../../lib/types';

vi.mock('../../../lib/im-api', () => ({
  getWorkspaceToken: vi.fn(() => 'workspace-token'),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createObjectURL = vi.fn(() => 'blob:asset-preview');
const revokeObjectURL = vi.fn();

function asset(overrides: Partial<AssetDTO> = {}): AssetDTO {
  return {
    id: 'asset-1',
    workspaceId: 'ws-1',
    ownerImUserId: 'owner-1',
    contentHash: 'a'.repeat(64),
    storageUri: 'file:///tmp/asset',
    sizeBytes: 128,
    mime: 'image/png',
    kind: 'file',
    sourceAgentImUserId: null,
    sourceTaskId: null,
    metadata: { title: 'Preview asset' },
    cdnUrl: null,
    thumbnailUrl: null,
    previewUrls: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('AssetViewer private image fallback', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(['png'], { type: 'image/png' }),
      })),
    );
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches a small private image with auth when previewUrls is empty', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(<AssetViewer asset={asset()} isDark={false} compact />);
    });
    await waitFor(() => createObjectURL.mock.calls.length > 0);

    expect(fetch).toHaveBeenCalledWith(
      '/api/im/assets/asset-1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer workspace-token' },
      }),
    );
    expect(createObjectURL).toHaveBeenCalled();
    expect(rootEl.querySelector('[data-testid="asset-viewer-private-image"] img')?.getAttribute('src')).toBe(
      'blob:asset-preview',
    );

    await act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });

  it('uses explicit previewUrls without private fetch', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(
        <AssetViewer
          asset={asset({ previewUrls: { medium: 'https://cdn.example/asset.png' } })}
          isDark={false}
          compact
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(rootEl.querySelector('[data-testid="asset-viewer-image"] img')?.getAttribute('src')).toBe(
      'https://cdn.example/asset.png',
    );

    await act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });

  it('fetches same-origin previewUrls with auth before rendering', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(
        <AssetViewer asset={asset({ previewUrls: { medium: '/api/im/assets/thumb-1' } })} isDark={false} compact />,
      );
    });
    await waitFor(() => createObjectURL.mock.calls.length > 0);

    expect(fetch).toHaveBeenCalledWith(
      '/api/im/assets/thumb-1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer workspace-token' },
      }),
    );
    expect(rootEl.querySelector('[data-testid="asset-viewer-image"] img')?.getAttribute('src')).toBe(
      'blob:asset-preview',
    );

    await act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });
});

describe('AssetImageGallery', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(['png'], { type: 'image/png' }),
      })),
    );
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds image candidates from preview, thumbnail, cdn, and small private assets only', () => {
    const candidates = imageGalleryCandidates([
      asset({ id: 'preview', previewUrls: { medium: 'https://cdn.example/preview.png' } }),
      asset({ id: 'thumb', previewUrls: null, thumbnailUrl: 'https://cdn.example/thumb.png' }),
      asset({ id: 'cdn', previewUrls: null, cdnUrl: 'https://cdn.example/cdn.png' }),
      asset({ id: 'private', previewUrls: null, sizeBytes: 512 }),
      asset({ id: 'pdf', mime: 'application/pdf', previewUrls: { medium: 'https://cdn.example/doc.pdf' } }),
      asset({ id: 'svg', mime: 'image/svg+xml', previewUrls: { medium: 'https://cdn.example/icon.svg' } }),
      asset({ id: 'large', previewUrls: null, sizeBytes: 20 * 1024 * 1024 }),
    ]);

    expect(candidates.map((candidate) => [candidate.asset.id, candidate.previewUrl, candidate.needsAuth])).toEqual([
      ['preview', 'https://cdn.example/preview.png', false],
      ['thumb', 'https://cdn.example/thumb.png', false],
      ['cdn', 'https://cdn.example/cdn.png', false],
      ['private', '/api/im/assets/private', true],
    ]);
  });

  it('filters gallery candidates by title, filename, and mime', () => {
    const candidates = imageGalleryCandidates([
      asset({
        id: 'chart',
        filename: 'q2-chart.png',
        metadata: { title: 'Revenue Chart' },
        previewUrls: { medium: 'https://cdn.example/chart.png' },
      }),
      asset({
        id: 'photo',
        filename: 'launch-photo.jpg',
        mime: 'image/jpeg',
        metadata: { title: 'Launch Event' },
        previewUrls: { medium: 'https://cdn.example/photo.jpg' },
      }),
    ]);

    expect(filterImageGalleryCandidates(candidates, 'revenue').map((candidate) => candidate.asset.id)).toEqual([
      'chart',
    ]);
    expect(filterImageGalleryCandidates(candidates, 'photo').map((candidate) => candidate.asset.id)).toEqual(['photo']);
    expect(filterImageGalleryCandidates(candidates, 'jpeg').map((candidate) => candidate.asset.id)).toEqual(['photo']);
    expect(filterImageGalleryCandidates(candidates, '  ').map((candidate) => candidate.asset.id)).toEqual([
      'chart',
      'photo',
    ]);
  });

  it('searches the rendered gallery and clears the search', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(
        <AssetImageGallery
          assets={[
            asset({
              id: 'chart',
              metadata: { title: 'Revenue Chart' },
              previewUrls: { medium: 'https://cdn.example/chart.png' },
            }),
            asset({
              id: 'photo',
              metadata: { title: 'Launch Photo' },
              previewUrls: { medium: 'https://cdn.example/photo.png' },
            }),
          ]}
          activeAssetId="chart"
          isDark={false}
        />,
      );
    });

    expect(rootEl.querySelectorAll('img')).toHaveLength(2);
    const input = rootEl.querySelector('input[aria-label="Search images"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'launch');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(rootEl.querySelectorAll('img')).toHaveLength(1);
    expect(rootEl.textContent).toContain('1/2');

    const clear = rootEl.querySelector('button[aria-label="Clear image search"]') as HTMLButtonElement;
    await act(async () => {
      clear.click();
    });

    expect(rootEl.querySelectorAll('img')).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });

  it('opens the lightbox and navigates with arrow keys', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(
        <AssetImageGallery
          assets={[
            asset({
              id: 'one',
              metadata: { title: 'First Image' },
              previewUrls: { medium: 'https://cdn.example/one.png' },
            }),
            asset({
              id: 'two',
              metadata: { title: 'Second Image' },
              previewUrls: { medium: 'https://cdn.example/two.png' },
            }),
          ]}
          activeAssetId="one"
          isDark={false}
        />,
      );
    });

    const firstTile = rootEl.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      firstTile.click();
    });

    expect(document.body.querySelector('[data-testid="asset-image-gallery-lightbox"]')?.textContent).toContain(
      'First Image',
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(document.body.querySelector('[data-testid="asset-image-gallery-lightbox"]')?.textContent).toContain(
      'Second Image',
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await waitFor(() => document.body.querySelector('[data-testid="asset-image-gallery-lightbox"]') === null);
    expect(document.body.querySelector('[data-testid="asset-image-gallery-lightbox"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });
});

async function waitFor(assertion: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (assertion()) return;
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
