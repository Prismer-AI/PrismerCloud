// release202/17 — daemon-side vision gating for image context.
//
// Verifies the DEFENSIVE double-gate in the Hermes envelope renderer:
//   (a) `assets.imageReferences` (cloud already gated) render as one-line
//       `[image: …]` reference tokens in the XML body.
//   (b) when the recipient model is NOT vision-capable (`supportsVision:false`),
//       any image left in `assets.inputs` (a cloud gating miss) is DEGRADED to
//       the same reference line and dropped from the returned `imageRefs` — a
//       non-vision model never receives pixels.
//   (c) when vision-capable / unknown, images stay in `imageRefs` (no
//       degradation, no reference lines) — regression guard.

import { describe, it, expect } from 'vitest';
import { renderContextEnvelope } from '../src/adapters/persistence/hermes/context-render.js';
import { formatImageReferenceLine } from '../src/adapters/shared/image-reference.js';
import type { ConversationContextEnvelope } from '../src/types/conversation-envelope.js';
import type { AssetRef } from '../src/types/im-events.js';

function imageRef(overrides: Partial<AssetRef> = {}): AssetRef {
  return {
    assetId: 'ast-img-1',
    contentHash: 'sha256-abc',
    mime: 'image/png',
    sizeBytes: 100,
    kind: 'image',
    workspaceId: 'ws-1',
    role: 'attachment',
    cdnUrl: 'https://cdn.example.com/img.png',
    filename: 'screenshot.png',
    ...overrides,
  };
}

function baseEnvelope(overrides: Partial<ConversationContextEnvelope> = {}): ConversationContextEnvelope {
  return {
    envelopeVersion: 1,
    conversationId: 'conv-1',
    conversationType: 'group',
    participants: [],
    recent: [],
    compressedSegments: [],
    quotes: [],
    assets: { inputs: [], archives: [] },
    budget: {
      totalTokens: 8000,
      floors: { recent: 2000, compressedSegments: 800, quotes: 300, identifierIndex: 200, recentTaskTrace: 300 },
    },
    ...overrides,
  };
}

describe('formatImageReferenceLine', () => {
  it('formats filename + asset id + dims and appends caption', () => {
    expect(
      formatImageReferenceLine({
        assetId: 'ast-9',
        filename: 'shot.png',
        mime: 'image/png',
        width: 800,
        height: 600,
        caption: 'a chart',
      }),
    ).toBe('[image: shot.png · asset ast-9 · 800×600] — a chart');
  });

  it('omits dims when unknown', () => {
    expect(
      formatImageReferenceLine({ assetId: 'ast-9', filename: 'shot.png', mime: 'image/png' }),
    ).toBe('[image: shot.png · asset ast-9]');
  });
});

describe('hermes/context-render — vision gating (release202/17)', () => {
  it('renders assets.imageReferences as text lines for a non-vision recipient', () => {
    const env = baseEnvelope({
      assets: {
        inputs: [],
        archives: [],
        imageReferences: [
          { assetId: 'ast-ref-1', filename: 'diagram.png', mime: 'image/png', width: 640, height: 480 },
        ],
      },
    });
    const out = renderContextEnvelope(env, {
      currentPrompt: 'describe it',
      youUsername: 'engineer',
      supportsVision: false,
    });
    expect(out.body).toContain('[image: diagram.png · asset ast-ref-1 · 640×480]');
    expect(out.imageRefs).toHaveLength(0); // no pixels for a non-vision model
  });

  it('DEFENSIVELY degrades inputs images to reference lines when supportsVision=false', () => {
    const env = baseEnvelope({
      assets: { inputs: [imageRef()], archives: [] },
    });
    const out = renderContextEnvelope(env, {
      currentPrompt: 'look',
      youUsername: 'engineer',
      supportsVision: false,
    });
    // image pulled OUT of imageRefs (no image_url lift) ...
    expect(out.imageRefs.map((r) => r.assetId)).not.toContain('ast-img-1');
    expect(out.imageRefs).toHaveLength(0);
    // ... and rendered as a reference line instead
    expect(out.body).toContain('[image: screenshot.png · asset ast-img-1]');
  });

  it('keeps inputs images as vision refs when supportsVision=true (regression)', () => {
    const env = baseEnvelope({
      assets: { inputs: [imageRef()], archives: [] },
    });
    const out = renderContextEnvelope(env, {
      currentPrompt: 'look',
      youUsername: 'engineer',
      supportsVision: true,
    });
    expect(out.imageRefs.map((r) => r.assetId)).toContain('ast-img-1');
    expect(out.body).not.toContain('[image: screenshot.png');
  });

  it('keeps inputs images as vision refs when supportsVision is undefined (trust cloud)', () => {
    const env = baseEnvelope({
      assets: { inputs: [imageRef()], archives: [] },
    });
    const out = renderContextEnvelope(env, {
      currentPrompt: 'look',
      youUsername: 'engineer',
    });
    expect(out.imageRefs.map((r) => r.assetId)).toContain('ast-img-1');
    expect(out.body).not.toContain('[image: screenshot.png');
  });
});
