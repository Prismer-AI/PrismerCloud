// release201/25 §7 / release201/26 §7.4 — OpenClaw adapter envelope renderer.
//
// Smoke verification:
//   - empty envelope produces a single user `input_text` item carrying the prompt
//   - recent[] become message items in oldest-first order with mapped roles
//   - image inputs become `input_image` blocks on the CURRENT-turn item
//   - archives are NOT in the input[] (text-only descriptors per decision D)

import { describe, it, expect } from 'vitest';
import { renderContextEnvelope } from '../src/adapters/openclaw/context-render.js';
import type { ConversationContextEnvelope } from '../src/types/conversation-envelope.js';

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

describe('openclaw/context-render — renderContextEnvelope', () => {
  it('empty envelope → single user message with the prompt', () => {
    const out = renderContextEnvelope(baseEnvelope(), { currentPrompt: 'do the thing' });
    expect(out.input).toHaveLength(1);
    expect(out.input[0]!.role).toBe('user');
    expect(out.input[0]!.content[0]).toEqual({ type: 'input_text', text: 'do the thing' });
  });

  it('recent[] map to message items in oldest-first order with role mapping', () => {
    const env = baseEnvelope({
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'first', createdAt: '2026-05-31T09:00:00Z' },
        { messageId: 'm2', role: 'agent', sender: 'ceo', content: 'reply', createdAt: '2026-05-31T09:01:00Z' },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'continue' });
    // recent ×2 + currentPrompt = 3 items.
    expect(out.input).toHaveLength(3);
    expect(out.input[0]!.role).toBe('user');     // human → user
    expect(out.input[1]!.role).toBe('assistant'); // agent → assistant
    expect(out.input[2]!.role).toBe('user');     // currentPrompt
  });

  it('attaches assets.inputs to the CURRENT-turn item as input_image / input_file', () => {
    const env = baseEnvelope({
      assets: {
        inputs: [
          {
            assetId: 'ast-img',
            contentHash: 'h1',
            mime: 'image/png',
            sizeBytes: 100,
            kind: 'image',
            workspaceId: 'ws-1',
            role: 'attachment',
            cdnUrl: 'https://cdn.example/img.png',
          },
          {
            assetId: 'ast-pdf-input',
            contentHash: 'h2',
            mime: 'application/pdf',
            sizeBytes: 500,
            kind: 'file',
            workspaceId: 'ws-1',
            role: 'attachment',
            cdnUrl: 'https://cdn.example/doc.pdf',
          },
        ],
        archives: [],
      },
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'review' });
    const currentItem = out.input[out.input.length - 1]!;
    const kinds = currentItem.content.map((c) => c.type);
    expect(kinds).toContain('input_text');
    expect(kinds).toContain('input_image');
    expect(kinds).toContain('input_file');
  });

  it('archives are TEXT-ONLY (NOT in input[]) per decision D', () => {
    const env = baseEnvelope({
      assets: {
        inputs: [],
        archives: [
          {
            assetId: 'ast-pdf-archive',
            contentHash: 'h3',
            mime: 'application/pdf',
            sizeBytes: 5000,
            kind: 'file',
            workspaceId: 'ws-1',
            role: 'context',
            filename: 'old-deck.pdf',
          },
        ],
      },
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'ignore the archive' });
    // No image/file block surfaced in input[].
    for (const item of out.input) {
      for (const block of item.content) {
        expect(block.type).not.toBe('input_image');
        expect(block.type).not.toBe('input_file');
      }
    }
    // Archive description surfaces as text in the dedicated channel.
    expect(out.archiveDescriptions).toHaveLength(1);
    expect(out.archiveDescriptions[0]).toContain('old-deck.pdf');
  });
});
