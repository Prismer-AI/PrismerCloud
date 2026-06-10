/**
 * @vitest-environment jsdom
 *
 * Wave 4 E5 — v2.0 §4.6 ContentBlock rendering dispatcher.
 *
 * Verifies the per-kind components and the `<MessageContentBlocks>`
 * switch render the correct sub-component for each of the 8 ContentBlock
 * variants and that tool_result recurses through the dispatcher (nested
 * blocks must surface their kind-specific UI, not just a JSON dump).
 *
 * No fetch mocks are needed for the markup-shape checks (TextLine /
 * ToolUseCard / ReasoningCollapse / ToolResultBlock / FileCard / unknown
 * fallback). The image / audio / video cards do issue a Bearer-token
 * `/api/im/assets/{id}` fetch on mount — we let them mount and stub
 * `globalThis.fetch` for those few tests to avoid hammering a real
 * endpoint from a unit test (the real-endpoint integration check lives in
 * `cookbook` + the e5 evidence MD, not here).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AudioCard,
  FileCard,
  ImageCard,
  MessageContentBlocks,
  ReasoningCollapse,
  TextLine,
  ToolResultBlock,
  ToolUseCard,
  isContentBlock,
  parseContentBlocks,
  type ContentBlock,
} from '../content-blocks';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `usePrivateImage` reads localStorage / sessionStorage via getIMClientToken.
// Stub a token so the auth-fetch branch runs (we still don't issue a real
// network call — the fetch stub below intercepts).
beforeEach(() => {
  try {
    // getIMClientToken() requires `expiresAt > Date.now()`; without it the
    // token resolves to null, the auth fetch is skipped, and image / audio /
    // video cards stay in "loading…" forever.
    window.localStorage.setItem(
      'prismer_auth',
      JSON.stringify({ token: 'test-jwt-token', expiresAt: Date.now() + 60 * 60 * 1000 }),
    );
  } catch {
    /* jsdom localStorage available */
  }
});

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

async function renderHook(
  node: React.ReactNode,
): Promise<{ host: HTMLDivElement; root: Root; cleanup: () => Promise<void> }> {
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

describe('content-blocks/types — parser + guard', () => {
  it('parseContentBlocks accepts an array passthrough', () => {
    const arr: ContentBlock[] = [{ kind: 'text', text: 'hello' }];
    expect(parseContentBlocks(arr)).toEqual(arr);
  });

  it('parseContentBlocks accepts a JSON-encoded string', () => {
    const json = JSON.stringify([
      { kind: 'text', text: 'hi' },
      { kind: 'reasoning', text: 'thinking…' },
    ]);
    const parsed = parseContentBlocks(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(2);
    expect(parsed![0].kind).toBe('text');
  });

  it('parseContentBlocks rejects garbage / null', () => {
    expect(parseContentBlocks(null)).toBeNull();
    expect(parseContentBlocks(undefined)).toBeNull();
    expect(parseContentBlocks('not-json')).toBeNull();
    expect(parseContentBlocks(42)).toBeNull();
    expect(parseContentBlocks([{ no_kind: true }])).toBeNull();
  });

  it('isContentBlock narrows the union', () => {
    expect(isContentBlock({ kind: 'text', text: 'x' })).toBe(true);
    expect(isContentBlock({ kind: 'image', assetId: 'a' })).toBe(true);
    expect(isContentBlock({ kind: 'unknown' })).toBe(false);
    expect(isContentBlock(null)).toBe(false);
  });
});

describe('TextLine — kind=text', () => {
  it('renders the text body inside data-testid="content-block-text"', async () => {
    const { host, cleanup } = await renderHook(<TextLine block={{ kind: 'text', text: 'Hello **world**' }} />);
    const node = host.querySelector('[data-testid="content-block-text"]') as HTMLElement;
    expect(node).toBeTruthy();
    // react-markdown wraps "Hello **world**" → <strong>world</strong>
    expect(node.querySelector('strong')?.textContent).toBe('world');
    await cleanup();
  });
});

describe('ImageCard — kind=image (auth-gated thumbnail + lightbox)', () => {
  beforeEach(() => {
    // Stub fetch to return a tiny PNG-shaped blob so usePrivateImage mints
    // an object URL (otherwise the card sits in its "loading…" branch).
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(pngBytes, {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          }),
      ),
    );
    // jsdom does not implement createObjectURL by default.
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    }
  });

  it('renders an inline <img> after fetch resolves', async () => {
    const { host, cleanup } = await renderHook(
      <ImageCard block={{ kind: 'image', assetId: 'asset_e5_image_1', mediaType: 'image/png', alt: 'demo' }} />,
    );
    // Let the effect microtask flush.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const card = host.querySelector('[data-testid="content-block-image"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.getAttribute('data-asset-id')).toBe('asset_e5_image_1');
    await cleanup();
  });

  it('opens a lightbox on click after the image loads', async () => {
    const { host, cleanup } = await renderHook(
      <ImageCard block={{ kind: 'image', assetId: 'asset_e5_image_2', mediaType: 'image/png' }} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const card = host.querySelector('[data-testid="content-block-image"]') as HTMLButtonElement;
    expect(card).toBeTruthy();
    await act(async () => {
      card.click();
    });
    // After click, lightbox appears.
    const lightbox = document.querySelector('[data-testid="content-block-image-lightbox"]');
    expect(lightbox).toBeTruthy();
    // Click close button.
    const closeBtn = document.querySelector('[data-testid="content-block-image-lightbox-close"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn.click();
    });
    expect(document.querySelector('[data-testid="content-block-image-lightbox"]')).toBeNull();
    await cleanup();
  });
});

describe('FileCard — kind=file', () => {
  it('renders the filename + media-type subline', async () => {
    const { host, cleanup } = await renderHook(
      <FileCard
        block={{
          kind: 'file',
          assetId: 'asset_e5_file_1',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
        }}
      />,
    );
    const card = host.querySelector('[data-testid="content-block-file"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('report.pdf');
    expect(card.textContent).toContain('application/pdf');
    await cleanup();
  });
});

describe('ToolUseCard — kind=tool_use (folded → expanded)', () => {
  it('folded by default; clicking expands to pretty JSON', async () => {
    const { host, cleanup } = await renderHook(
      <ToolUseCard
        block={{
          kind: 'tool_use',
          toolCallId: 'tc_1',
          toolName: 'image_generate',
          inputJson: { prompt: 'a unicorn', width: 512 },
        }}
      />,
    );
    const card = host.querySelector('[data-testid="content-block-tool-use"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('image_generate');
    // Default folded: no <pre>.
    expect(host.querySelector('[data-testid="content-block-tool-use-pretty"]')).toBeNull();
    const toggle = card.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    const pretty = host.querySelector('[data-testid="content-block-tool-use-pretty"]') as HTMLElement;
    expect(pretty).toBeTruthy();
    expect(pretty.textContent).toContain('a unicorn');
    await cleanup();
  });
});

describe('ReasoningCollapse — kind=reasoning (folded by default)', () => {
  it('default folded; click reveals markdown body', async () => {
    const { host, cleanup } = await renderHook(
      <ReasoningCollapse block={{ kind: 'reasoning', text: 'Step 1 — analyse.\nStep 2 — answer.' }} />,
    );
    const wrap = host.querySelector('[data-testid="content-block-reasoning"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.getAttribute('data-reasoning-open')).toBe('false');
    expect(host.querySelector('[data-testid="content-block-reasoning-body"]')).toBeNull();
    const toggle = host.querySelector('[data-testid="content-block-reasoning-toggle"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    expect(wrap.getAttribute('data-reasoning-open')).toBe('true');
    const body = host.querySelector('[data-testid="content-block-reasoning-body"]') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.textContent).toContain('Step 1');
    await cleanup();
  });

  it('redacted reasoning renders a disabled chip with no body', async () => {
    const { host, cleanup } = await renderHook(
      <ReasoningCollapse block={{ kind: 'reasoning', text: 'should not show', redacted: true }} />,
    );
    const wrap = host.querySelector('[data-testid="content-block-reasoning"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.getAttribute('data-redacted')).toBe('true');
    expect(host.querySelector('[data-testid="content-block-reasoning-body"]')).toBeNull();
    expect(wrap.textContent).not.toContain('should not show');
    await cleanup();
  });
});

describe('ToolResultBlock — kind=tool_result (recurses through dispatcher)', () => {
  it('renders inner blocks through MessageContentBlocks (text + image)', async () => {
    // Stub fetch so the inner ImageCard's auth fetch resolves.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } })),
    );
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    }
    const { host, cleanup } = await renderHook(
      <ToolResultBlock
        block={{
          kind: 'tool_result',
          toolCallId: 'tc_1',
          output: [
            { kind: 'text', text: 'Generated image:' },
            { kind: 'image', assetId: 'asset_tool_result_1', mediaType: 'image/png' },
          ],
        }}
        renderBlocks={MessageContentBlocks}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const wrap = host.querySelector('[data-testid="content-block-tool-result"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.getAttribute('data-inner-count')).toBe('2');
    // Default open — inner text + image render.
    expect(host.querySelector('[data-testid="content-block-text"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="content-block-image"]')).toBeTruthy();
    await cleanup();
  });
});

describe('MessageContentBlocks — dispatcher routes each kind to its component', () => {
  it('renders all 6 simple kinds in one pass', async () => {
    // Stub fetch for image / audio / video so they don't hang in "loading…"
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } })),
    );
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    }
    const blocks: ContentBlock[] = [
      { kind: 'text', text: 'caption' },
      { kind: 'image', assetId: 'a_img', mediaType: 'image/png' },
      { kind: 'audio', assetId: 'a_aud', mediaType: 'audio/mpeg', durationMs: 45_000 },
      { kind: 'video', assetId: 'a_vid', mediaType: 'video/mp4' },
      { kind: 'file', assetId: 'a_file', mediaType: 'application/pdf', filename: 'doc.pdf' },
      { kind: 'tool_use', toolCallId: 'tc1', toolName: 'search', inputJson: { q: 'foo' } },
      { kind: 'reasoning', text: 'thinking' },
    ];
    const { host, cleanup } = await renderHook(<MessageContentBlocks blocks={blocks} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="content-blocks-root"]')!.getAttribute('data-block-count')).toBe('7');
    for (const kind of ['text', 'image', 'audio', 'video', 'file', 'tool-use', 'reasoning']) {
      expect(host.querySelector(`[data-testid="content-block-${kind}"]`)).toBeTruthy();
    }
    await cleanup();
  });

  it('unknown kinds fall through to a placeholder (forward-compat)', async () => {
    // Cast to bypass discriminated union — simulates a future kind the
    // server sends to a stale FE bundle.
    const blocks = [{ kind: 'future_unknown', foo: 'bar' } as unknown as ContentBlock];
    const { host, cleanup } = await renderHook(<MessageContentBlocks blocks={blocks} />);
    expect(host.querySelector('[data-testid="content-block-unknown"]')).toBeTruthy();
    await cleanup();
  });

  it('renders nothing for an empty blocks array', async () => {
    const { host, cleanup } = await renderHook(<MessageContentBlocks blocks={[]} />);
    expect(host.querySelector('[data-testid="content-blocks-root"]')).toBeNull();
    await cleanup();
  });

  it('caps recursion depth so a pathological self-reference does not stack overflow', async () => {
    // Build a 6-deep tool_result chain — beyond MAX_NESTING_DEPTH=4.
    let inner: ContentBlock[] = [{ kind: 'text', text: 'leaf' }];
    for (let i = 0; i < 6; i += 1) {
      inner = [{ kind: 'tool_result', toolCallId: `tc_${i}`, output: inner }];
    }
    const { host, cleanup } = await renderHook(<MessageContentBlocks blocks={inner} />);
    expect(host.querySelector('[data-testid="content-block-depth-overflow"]')).toBeTruthy();
    await cleanup();
  });
});

describe('AudioCard — basic mount sanity', () => {
  beforeEach(() => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(audioBytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })),
    );
    if (!URL.createObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    }
  });

  it('renders an <audio controls> element after fetch resolves', async () => {
    const { host, cleanup } = await renderHook(
      <AudioCard block={{ kind: 'audio', assetId: 'asset_audio_1', mediaType: 'audio/mpeg', durationMs: 12_345 }} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const card = host.querySelector('[data-testid="content-block-audio"]') as HTMLElement;
    expect(card).toBeTruthy();
    const player = host.querySelector('[data-testid="content-block-audio-player"]');
    expect(player).toBeTruthy();
    // 12_345 ms → "0:12"
    expect(card.textContent).toContain('0:12');
    await cleanup();
  });
});
