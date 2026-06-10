/**
 * @vitest-environment jsdom
 *
 * release201/30 Phase 2 — MessageAssetViewerModal smoke tests.
 *
 * Covers the surface that doesn't require the pdfjs worker:
 *   - open / close round-trip (dialog mounts / unmounts on `open`)
 *   - image mime renders the image viewer body
 *   - text mime renders the text body (fetch stubbed)
 *   - unsupported mime renders the fallback block
 *
 * The pdf branch is NOT exercised here because react-pdf wires
 * pdfjs.GlobalWorkerOptions.workerSrc to `/api/pdf-worker?...`, which jsdom
 * won't serve. Real pdf rendering is covered by the asset-viewer
 * cookbook / playwright path.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageAssetViewerModal } from '../message-asset-viewer-modal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  try {
    window.localStorage.setItem(
      'prismer_auth',
      JSON.stringify({ token: 'test-jwt-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
    );
  } catch {
    /* jsdom */
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['hello text body'], { type: 'text/plain' }),
      text: async () => 'hello text body',
    }) as unknown as Response),
  );
  // jsdom doesn't implement URL.createObjectURL/revokeObjectURL — provide stubs.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:stub'),
    });
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
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

async function renderInto(node: React.ReactNode): Promise<{ root: Root; cleanup: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<>{node}</>);
  });
  return {
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('MessageAssetViewerModal — mount / close', () => {
  it('does not render any dialog body when closed', async () => {
    const { cleanup } = await renderInto(
      <MessageAssetViewerModal
        asset={{ id: 'a1', mime: 'image/png', filename: 'p.png', source: 'attachment' }}
        open={false}
        onClose={() => {}}
      />,
    );
    // Radix dialog content portals to body when open; when closed, no
    // dialog element is in the doc.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await cleanup();
  });

  it('invokes onClose when openOpenChange fires false (we trigger via close button)', async () => {
    const onClose = vi.fn();
    const { cleanup } = await renderInto(
      <MessageAssetViewerModal
        asset={{ id: 'a1', mime: 'text/markdown', filename: 'a.md', source: 'attachment' }}
        open={true}
        onClose={onClose}
      />,
    );
    // Radix renders a "Close" button (XIcon, sr-only "Close" label) inside content.
    const closeBtn = document.querySelector('[role="dialog"] [data-slot="dialog-close"]') as HTMLButtonElement | null;
    expect(closeBtn).not.toBeNull();
    await act(async () => {
      closeBtn!.click();
    });
    expect(onClose).toHaveBeenCalled();
    await cleanup();
  });
});

describe('MessageAssetViewerModal — mime body dispatch', () => {
  it('renders an <img> for image/*', async () => {
    const { cleanup } = await renderInto(
      <MessageAssetViewerModal
        asset={{ id: 'img-1', mime: 'image/jpeg', filename: 'a.jpg', sizeBytes: 1024, source: 'attachment' }}
        open={true}
        onClose={() => {}}
      />,
    );
    // Wait one tick for the blob-url effect to set the src.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const img = document.querySelector('[role="dialog"] img');
    expect(img).not.toBeNull();
    await cleanup();
  });

  it('renders a <pre> for text/*', async () => {
    const { cleanup } = await renderInto(
      <MessageAssetViewerModal
        asset={{ id: 'txt-1', mime: 'text/plain', filename: 't.txt', source: 'attachment' }}
        open={true}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"] pre')).not.toBeNull();
    await cleanup();
  });

  it('renders the unsupported fallback for arbitrary mime', async () => {
    const { cleanup } = await renderInto(
      <MessageAssetViewerModal
        asset={{ id: 'zip-1', mime: 'application/zip', filename: 'a.zip', source: 'attachment' }}
        open={true}
        onClose={() => {}}
      />,
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/Preview not available/i);
    await cleanup();
  });
});
