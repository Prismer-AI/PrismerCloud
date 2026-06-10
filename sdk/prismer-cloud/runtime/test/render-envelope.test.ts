// release201/26 §6 / §7 — shared envelope → neutral message rendering.
//
// Verifies the cache-stable prefix ordering (compressedSegments → quotes →
// recent → currentPrompt), that archive assets stay TEXT-ONLY (never become
// vision inputs), and that an empty envelope renders to an empty body.

import { describe, expect, it } from 'vitest';
import { renderEnvelopeToMessages, type RenderEnvelopeOptions } from '../src/adapters/shared/render-envelope.js';
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

describe('renderEnvelopeToMessages', () => {
  it('orders body stable → volatile: compressedSegments → quotes → recent → currentPrompt (§6)', () => {
    const envelope = baseEnvelope({
      compressedSegments: [
        {
          segmentSeq: 2,
          coversFromAt: '2026-05-02T00:00:00Z',
          coversToAt: '2026-05-03T00:00:00Z',
          summary: 'second summary',
          salientFacts: {},
          sourceCount: 5,
          tokenCountCl100k: 100,
        },
        {
          segmentSeq: 1,
          coversFromAt: '2026-05-01T00:00:00Z',
          coversToAt: '2026-05-02T00:00:00Z',
          summary: 'first summary',
          salientFacts: { decisions: ['ship it'] },
          sourceCount: 8,
          tokenCountCl100k: 120,
        },
      ],
      quotes: [
        {
          quotedMessageId: 'm-9',
          snippet: 'the layout we agreed on',
          quotedSender: 'alice',
          quotedAt: '2026-05-04T00:00:00Z',
        },
      ],
      recent: [
        { messageId: 'm-10', role: 'human', sender: 'alice', content: 'hello', createdAt: '2026-05-05T00:00:00Z' },
        { messageId: 'm-11', role: 'agent', sender: 'ceo', content: 'hi there', createdAt: '2026-05-05T00:01:00Z' },
      ],
    });

    const { messages } = renderEnvelopeToMessages(envelope, { currentPrompt: 'what next?' });

    // Order check by origin.
    expect(messages.map((m) => m.origin)).toEqual([
      'compressedSegment', // seq 1 (sorted ascending)
      'compressedSegment', // seq 2
      'quote',
      'recent', // alice
      'recent', // ceo
      'currentPrompt',
    ]);

    // segments sorted ascending by segmentSeq regardless of input order.
    expect(messages[0]!.content).toContain('summary #1');
    expect(messages[0]!.content).toContain('first summary');
    expect(messages[0]!.content).toContain('Decisions: ship it');
    expect(messages[1]!.content).toContain('summary #2');

    // quote carries sender + snippet.
    expect(messages[2]!.content).toContain('@alice');
    expect(messages[2]!.content).toContain('the layout we agreed on');

    // recent role mapping: human → user, agent → assistant.
    expect(messages[3]!.role).toBe('user');
    expect(messages[4]!.role).toBe('assistant');

    // currentPrompt is the volatile tail.
    expect(messages[5]!.role).toBe('user');
    expect(messages[5]!.content).toBe('what next?');
  });

  it('keeps archive assets TEXT-ONLY and out of vision inputs (decision D)', () => {
    const envelope = baseEnvelope({
      assets: {
        inputs: [
          {
            assetId: 'ast-input',
            contentHash: 'h1',
            mime: 'image/png',
            sizeBytes: 100,
            kind: 'image',
            workspaceId: 'ws-1',
            role: 'attachment',
          },
        ],
        archives: [
          {
            assetId: 'ast-archive',
            contentHash: 'h2',
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

    const { assetInputs, archiveDescriptions } = renderEnvelopeToMessages(envelope);

    // The input image is surfaced as a vision input.
    expect(assetInputs).toHaveLength(1);
    expect(assetInputs[0]!.assetId).toBe('ast-input');

    // The archive is a TEXT descriptor only — not in assetInputs.
    expect(assetInputs.some((a) => a.assetId === 'ast-archive')).toBe(false);
    expect(archiveDescriptions).toHaveLength(1);
    expect(archiveDescriptions[0]).toContain('old-deck.pdf');
    expect(archiveDescriptions[0]).toContain('reference only');
  });

  it('renders an empty envelope to an empty body (no spurious messages)', () => {
    const { messages, assetInputs, archiveDescriptions } = renderEnvelopeToMessages(baseEnvelope());
    expect(messages).toEqual([]);
    expect(assetInputs).toEqual([]);
    expect(archiveDescriptions).toEqual([]);
  });

  it('omits currentPrompt message when not provided (stateful-upstream mode)', () => {
    const envelope = baseEnvelope({
      recent: [{ messageId: 'm-1', role: 'human', sender: 'a', content: 'hi', createdAt: '2026-05-05T00:00:00Z' }],
    });
    const { messages } = renderEnvelopeToMessages(envelope);
    expect(messages.map((m) => m.origin)).toEqual(['recent']);
    expect(messages.some((m) => m.origin === 'currentPrompt')).toBe(false);
  });

  it('renders Phase-3 identifierIndex + recentTaskTrace when present', () => {
    const envelope = baseEnvelope({
      identifierIndex: [{ kind: 'project', canonicalId: 'p-1', displayLabel: 'Acme', lastSeenAt: '2026-05-05T00:00:00Z' }],
      recentTaskTrace: { taskId: 't-1', toolsUsed: ['shell'], outputs: ['done'], decisions: ['used X'] },
    });
    const { messages } = renderEnvelopeToMessages(envelope);
    const origins = messages.map((m) => m.origin);
    // identifierIndex comes after segments (none here) and before recentTaskTrace.
    expect(origins).toEqual(['identifierIndex', 'recentTaskTrace']);
    expect(messages[0]!.content).toContain('Acme');
    expect(messages[1]!.content).toContain('t-1');
  });

  // release201/26 §13.2/§13.3 #1 — adapter-capability-aware rendering.
  describe('adapter-capability-aware rendering (§13.2/§13.3 #1)', () => {
    // A rich envelope exercising every category so we can assert exactly which
    // ones survive in each scenario.
    function richEnvelope(): ConversationContextEnvelope {
      return baseEnvelope({
        compressedSegments: [
          {
            segmentSeq: 1,
            coversFromAt: '2026-05-01T00:00:00Z',
            coversToAt: '2026-05-02T00:00:00Z',
            summary: 'older summary',
            salientFacts: { decisions: ['ship it'] },
            sourceCount: 8,
            tokenCountCl100k: 120,
          },
        ],
        quotes: [
          {
            quotedMessageId: 'm-9',
            snippet: 'the layout we agreed on',
            quotedSender: 'alice',
            quotedAt: '2026-05-04T00:00:00Z',
          },
        ],
        identifierIndex: [
          { kind: 'project', canonicalId: 'p-1', displayLabel: 'Acme', lastSeenAt: '2026-05-05T00:00:00Z' },
        ],
        recentTaskTrace: { taskId: 't-1', toolsUsed: ['shell'], outputs: ['done'], decisions: ['used X'] },
        recent: [
          { messageId: 'm-10', role: 'human', sender: 'alice', content: 'hello', createdAt: '2026-05-05T00:00:00Z' },
          { messageId: 'm-11', role: 'agent', sender: 'ceo', content: 'hi there', createdAt: '2026-05-05T00:01:00Z' },
        ],
      });
    }

    it('(a) stateful + sessionIsNew=true → FULL body (seed)', () => {
      const { messages } = renderEnvelopeToMessages(richEnvelope(), {
        adapterCapability: 'stateful',
        sessionIsNew: true,
        currentPrompt: 'what next?',
      });
      // Full §6 body: compressedSegment + identifierIndex + recentTaskTrace +
      // quote + recent×2 + currentPrompt.
      expect(messages.map((m) => m.origin)).toEqual([
        'compressedSegment',
        'identifierIndex',
        'recentTaskTrace',
        'quote',
        'recent',
        'recent',
        'currentPrompt',
      ]);
    });

    it('(b) stateful + sessionIsNew=false → THIN body (no recent / no compressed; keeps IM delta)', () => {
      const { messages } = renderEnvelopeToMessages(richEnvelope(), {
        adapterCapability: 'stateful',
        sessionIsNew: false,
        currentPrompt: 'what next?',
      });
      const origins = messages.map((m) => m.origin);
      // Replayable body (Hermes already holds it) is dropped …
      expect(origins).not.toContain('recent');
      expect(origins).not.toContain('compressedSegment');
      // … but the IM-domain delta Hermes can't know is kept, plus currentPrompt.
      expect(origins).toEqual(['identifierIndex', 'recentTaskTrace', 'quote', 'currentPrompt']);
      // quote snippet + entity still present.
      expect(messages.find((m) => m.origin === 'quote')!.content).toContain('the layout we agreed on');
      expect(messages.find((m) => m.origin === 'identifierIndex')!.content).toContain('Acme');
    });

    it('(c) stateless → FULL body regardless of sessionIsNew', () => {
      const full = ['compressedSegment', 'identifierIndex', 'recentTaskTrace', 'quote', 'recent', 'recent', 'currentPrompt'];
      // Explicit stateless.
      const a = renderEnvelopeToMessages(richEnvelope(), {
        adapterCapability: 'stateless',
        sessionIsNew: false, // ignored for stateless
        currentPrompt: 'what next?',
      });
      expect(a.messages.map((m) => m.origin)).toEqual(full);
      // Default (no adapterCapability) is stateless → same full body. This is
      // the zero-behaviour-change guarantee for pre-§13 callers.
      const b = renderEnvelopeToMessages(richEnvelope(), { currentPrompt: 'what next?' });
      expect(b.messages.map((m) => m.origin)).toEqual(full);
    });

    it('(d) image quote / asset-input url is preserved in EVERY scenario (P2)', () => {
      const withImage = baseEnvelope({
        recent: [
          { messageId: 'm-10', role: 'human', sender: 'alice', content: 'hello', createdAt: '2026-05-05T00:00:00Z' },
        ],
        assets: {
          inputs: [
            {
              assetId: 'ast-input',
              contentHash: 'h1',
              mime: 'image/png',
              sizeBytes: 100,
              kind: 'image',
              workspaceId: 'ws-1',
              role: 'attachment',
              cdnUrl: 'https://cdn.example/ast-input.png',
            },
          ],
          archives: [],
        },
      });
      const scenarios: RenderEnvelopeOptions[] = [
        { adapterCapability: 'stateless' },
        { adapterCapability: 'stateful', sessionIsNew: true },
        { adapterCapability: 'stateful', sessionIsNew: false },
      ];
      for (const opts of scenarios) {
        const { assetInputs } = renderEnvelopeToMessages(withImage, opts);
        expect(assetInputs).toHaveLength(1);
        expect(assetInputs[0]!.cdnUrl).toBe('https://cdn.example/ast-input.png');
      }
    });

    it('(f) image-bearing quote → imageAssetRefs folded into assetInputs (P2 re-injection)', () => {
      const quoteImage = {
        assetId: 'ast-quoted-img',
        contentHash: 'qh1',
        mime: 'image/png',
        sizeBytes: 222,
        kind: 'image',
        workspaceId: 'ws-1',
        role: 'attachment' as const,
        cdnUrl: 'https://cdn.example/quoted.png',
      };
      const envelope = baseEnvelope({
        quotes: [
          {
            quotedMessageId: 'm-9',
            snippet: 'the chart from earlier',
            quotedSender: 'alice',
            quotedAt: '2026-05-04T00:00:00Z',
            imageAssetRefs: [quoteImage],
          },
        ],
      });
      // Done in ALL scenarios (stateful + stateless) — both need the agent to
      // re-perceive the cross-turn image.
      const scenarios: RenderEnvelopeOptions[] = [
        { adapterCapability: 'stateless' },
        { adapterCapability: 'stateful', sessionIsNew: true },
        { adapterCapability: 'stateful', sessionIsNew: false },
      ];
      for (const opts of scenarios) {
        const { messages, assetInputs } = renderEnvelopeToMessages(envelope, opts);
        // The quoted image is re-injected as a vision input …
        expect(assetInputs.map((a) => a.assetId)).toContain('ast-quoted-img');
        expect(assetInputs.find((a) => a.assetId === 'ast-quoted-img')!.cdnUrl).toBe(
          'https://cdn.example/quoted.png',
        );
        // … AND the text quote reference line is still rendered (stateful-thin
        // keeps quotes; stateless keeps them too).
        expect(messages.find((m) => m.origin === 'quote')!.content).toContain(
          'the chart from earlier',
        );
      }
    });

    it('(g) quoted image that is ALSO a current-turn attachment is NOT injected twice (dedup)', () => {
      const shared = {
        assetId: 'ast-shared',
        contentHash: 'sh1',
        mime: 'image/png',
        sizeBytes: 100,
        kind: 'image',
        workspaceId: 'ws-1',
        role: 'attachment' as const,
        cdnUrl: 'https://cdn.example/shared.png',
      };
      const envelope = baseEnvelope({
        assets: { inputs: [shared], archives: [] },
        quotes: [
          {
            quotedMessageId: 'm-9',
            snippet: 'see attached',
            quotedSender: 'alice',
            quotedAt: '2026-05-04T00:00:00Z',
            // Same asset already present as a current-turn input.
            imageAssetRefs: [shared],
          },
        ],
      });
      const { assetInputs } = renderEnvelopeToMessages(envelope, { adapterCapability: 'stateless' });
      expect(assetInputs.filter((a) => a.assetId === 'ast-shared')).toHaveLength(1);
    });

    it('(e) §6 stable→volatile ordering does NOT apply to a reused stateful session', () => {
      // For the thin path there is no recent/compressed to order; the only
      // "body" categories are the IM delta. Assert the §6 replayable prefix is
      // structurally absent (not merely re-ordered), proving §6 is N/A here.
      const { messages } = renderEnvelopeToMessages(richEnvelope(), {
        adapterCapability: 'stateful',
        sessionIsNew: false,
      });
      // No currentPrompt provided here → body is delta-only.
      expect(messages.every((m) => m.origin !== 'recent' && m.origin !== 'compressedSegment')).toBe(true);
      // The full §6 path (stateless) would have emitted them — contrast:
      const fullBody = renderEnvelopeToMessages(richEnvelope(), { adapterCapability: 'stateless' });
      expect(fullBody.messages.some((m) => m.origin === 'recent')).toBe(true);
      expect(fullBody.messages.some((m) => m.origin === 'compressedSegment')).toBe(true);
    });
  });
});
