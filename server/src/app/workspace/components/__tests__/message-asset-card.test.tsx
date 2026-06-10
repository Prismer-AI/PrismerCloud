/**
 * @vitest-environment jsdom
 *
 * release201/30 Phase 2 — MessageAssetCard mime-driven dispatch.
 *
 * Covers:
 *   - bucketForMime() classifier (image/video/audio/pdf/text/other)
 *   - legacyFileUrlToAsset() — synthesises an asset from old `metadata.fileUrl`
 *   - MessageAssetCard mime branches: image (inline), oversize image
 *     (fallback chip), pdf (file row + optional thumbnail), text, generic
 *   - missing payload renders the "[file missing — trace: ...]" stub and
 *     console.warns the trace id
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MessageAssetCard,
  bucketForMime,
  formatBytes,
  legacyFileUrlToAsset,
  MAX_INLINE_IMAGE_BYTES,
} from '../message-asset-card';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  try {
    window.localStorage.setItem(
      'prismer_auth',
      JSON.stringify({ token: 'test-jwt-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
    );
  } catch {
    /* jsdom localStorage available */
  }
  // Stub fetch so the inline auth-fetch in image cards doesn't crash jsdom.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['stub'], { type: 'text/plain' }),
      text: async () => 'stub',
    }) as unknown as Response),
  );
});

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderInto(node: React.ReactNode): Promise<{ host: HTMLDivElement; root: Root; cleanup: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<>{node}</>);
  });
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('bucketForMime', () => {
  it('classifies image types', () => {
    expect(bucketForMime('image/png')).toBe('image');
    expect(bucketForMime('image/jpeg')).toBe('image');
    expect(bucketForMime('IMAGE/WEBP')).toBe('image');
  });

  it('classifies video / audio', () => {
    expect(bucketForMime('video/mp4')).toBe('video');
    expect(bucketForMime('audio/mpeg')).toBe('audio');
  });

  it('classifies pdf (vendor + plain)', () => {
    expect(bucketForMime('application/pdf')).toBe('pdf');
    expect(bucketForMime('application/x-foo/pdf')).toBe('pdf');
  });

  it('classifies text', () => {
    expect(bucketForMime('text/markdown')).toBe('text');
    expect(bucketForMime('text/csv')).toBe('text');
  });

  it('falls through to other', () => {
    expect(bucketForMime('application/zip')).toBe('other');
    expect(bucketForMime(null)).toBe('other');
    expect(bucketForMime(undefined)).toBe('other');
  });
});

describe('formatBytes', () => {
  it('falls back to empty string on missing input', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });
  it('formats B / KB / MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('legacyFileUrlToAsset', () => {
  it('returns null when fileUrl missing', () => {
    expect(legacyFileUrlToAsset({ messageId: 'm1', meta: {} })).toBeNull();
  });

  it('synthesises an asset from fileUrl + fileName + mimeType', () => {
    const asset = legacyFileUrlToAsset({
      messageId: 'msg-1',
      meta: {
        fileUrl: 'https://cdn.example.com/foo.pdf',
        fileName: 'foo.pdf',
        mimeType: 'application/pdf',
        fileSize: 12345,
        uploadId: 'up-9',
      },
    });
    expect(asset).not.toBeNull();
    expect(asset!.id).toBe('up-9');
    expect(asset!.cdnUrl).toBe('https://cdn.example.com/foo.pdf');
    expect(asset!.filename).toBe('foo.pdf');
    expect(asset!.mime).toBe('application/pdf');
    expect(asset!.sizeBytes).toBe(12345);
    expect(asset!.source).toBe('legacy-file-url');
  });

  it('falls back to legacy-{messageId} id when uploadId missing', () => {
    const asset = legacyFileUrlToAsset({
      messageId: 'abc',
      meta: { fileUrl: 'https://x/y' },
    });
    expect(asset!.id).toBe('legacy-abc');
  });
});

describe('MessageAssetCard — mime branches', () => {
  it('renders an inline image card for image/* under the size cap', async () => {
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{
          id: 'a1',
          mime: 'image/png',
          sizeBytes: 50_000,
          filename: 'photo.png',
          source: 'attachment',
        }}
      />,
    );
    const card = host.querySelector('[data-testid="chat-asset-image-a1"]');
    expect(card).not.toBeNull();
    await cleanup();
  });

  it('renders the oversize fallback for image/* > 20MB', async () => {
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{
          id: 'a2',
          mime: 'image/jpeg',
          sizeBytes: MAX_INLINE_IMAGE_BYTES + 1,
          filename: 'huge.jpg',
          source: 'attachment',
        }}
      />,
    );
    expect(host.querySelector('[data-testid="chat-asset-image-oversize-a2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-asset-image-a2"]')).toBeNull();
    await cleanup();
  });

  it('renders a generic file row for pdf', async () => {
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{
          id: 'a3',
          mime: 'application/pdf',
          sizeBytes: 100_000,
          filename: 'doc.pdf',
          source: 'attachment',
        }}
      />,
    );
    expect(host.querySelector('[data-testid="chat-asset-file-a3"]')).not.toBeNull();
    await cleanup();
  });

  it('renders a generic file row for unknown mime', async () => {
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{
          id: 'a4',
          mime: 'application/zip',
          sizeBytes: 200_000,
          filename: 'bundle.zip',
          source: 'attachment',
        }}
      />,
    );
    expect(host.querySelector('[data-testid="chat-asset-file-a4"]')).not.toBeNull();
    await cleanup();
  });

  it('renders the missing-payload stub when neither mime nor url is known', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{ id: 'a5', traceId: 't-99' }}
      />,
    );
    expect(host.querySelector('[data-testid="chat-asset-missing-a5"]')).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    await cleanup();
  });

  it('honours the filename — no [file] / [asset] placeholder in the rendered title', async () => {
    const { host, cleanup } = await renderInto(
      <MessageAssetCard
        isDark={false}
        asset={{
          id: 'a6',
          mime: 'application/octet-stream',
          sizeBytes: 5000,
          filename: 'specific.bin',
          source: 'attachment',
        }}
      />,
    );
    const card = host.querySelector('[data-testid="chat-asset-file-a6"]');
    expect(card?.textContent).toContain('specific.bin');
    expect(card?.textContent).not.toContain('[file]');
    expect(card?.textContent).not.toContain('[asset]');
    await cleanup();
  });
});

describe('MessageAssetCard — click contract', () => {
  it('fires onPreview when the card is clicked', async () => {
    const onPreview = vi.fn();
    const asset = {
      id: 'a7',
      mime: 'application/pdf',
      sizeBytes: 1000,
      filename: 'x.pdf',
      source: 'attachment' as const,
    };
    const { host, cleanup } = await renderInto(
      <MessageAssetCard isDark={false} asset={asset} onPreview={onPreview} />,
    );
    const card = host.querySelector('[data-testid="chat-asset-file-a7"]') as HTMLButtonElement | null;
    expect(card).not.toBeNull();
    await act(async () => {
      card!.click();
    });
    expect(onPreview).toHaveBeenCalledWith(asset);
    await cleanup();
  });
});
