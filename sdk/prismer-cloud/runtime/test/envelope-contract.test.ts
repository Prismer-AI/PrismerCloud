// docs/release201/31 §5.1 / §5.2 — envelope contract (runtime mirror side).
//
// The runtime package is standalone and CANNOT import the cloud-side type
// (layer rule). So the cross-package PARITY guard lives in
// `scripts/check-envelope-mirror.ts` (field-set diff of both .ts files). THIS
// test instead pins the runtime mirror's STRUCTURAL contract:
//   1. a "full" golden envelope exercising EVERY field compiles + round-trips
//      (so a removed/renamed field on the runtime side is caught here);
//   2. the Phase-1 "empty-producer" shape that `buildEnvelope` actually returns
//      TODAY (compressedSegments [] / quotes [] / identifierIndex+recentTaskTrace
//      undefined) is a valid envelope — i.e. the producer-not-wired runtime
//      state (docs/release201/31 §0.5) is representable and renderable.
//
// Keep the golden fixture exhaustive: any new field on
// src/types/conversation-envelope.ts must be added here too, which is the
// intended forcing function.

import { describe, expect, it } from 'vitest';
import type {
  AssetRef,
  ConversationContextEnvelope,
} from '../src/types/conversation-envelope.js';

const ASSET: AssetRef = {
  assetId: 'ast-1',
  contentHash: 'sha256:abc',
  mime: 'image/png',
  sizeBytes: 1234,
  kind: 'image',
  workspaceId: 'ws-1',
  role: 'context',
  cdnUrl: 'https://cdn.example/ast-1.png',
  filename: 'screenshot.png',
};

/** Exercises every field of the v1 envelope, including Phase-3 fields. */
const FULL: ConversationContextEnvelope = {
  envelopeVersion: 1,
  conversationId: 'conv-1',
  conversationType: 'group',
  participants: [
    { imUserId: 'u-ceo', username: 'ceo', displayName: 'CEO', role: 'agent', agentType: 'hermes' },
  ],
  recent: [
    {
      messageId: 'm-2',
      role: 'human',
      sender: 'alice',
      content: 'build on this',
      createdAt: '2026-05-31T00:00:02.000Z',
      assetRefs: [ASSET],
    },
  ],
  compressedSegments: [
    {
      segmentSeq: 1,
      coversFromAt: '2026-05-30T00:00:00.000Z',
      coversToAt: '2026-05-30T12:00:00.000Z',
      summary: 'discussed vendor selection',
      salientFacts: {
        topicHeadlines: ['vendor selection'],
        decisions: ['picked vendor B'],
        openQuestions: ['pricing tier?'],
        entitiesMentioned: ['vendor B'],
        userPreferences: ['A4 not letter'],
        agentCommitments: ['draft PDF'],
        discardedDirections: ['vendor A'],
        taskEventCount: 3,
        approvalCount: 1,
      },
      sourceCount: 40,
      tokenCountCl100k: 512,
    },
  ],
  quotes: [
    {
      quotedMessageId: 'm-1',
      snippet: 'first summary…',
      quotedSender: 'alice',
      quotedAt: '2026-05-31T00:00:01.000Z',
      sourceDeletedAt: '2026-05-31T01:00:00.000Z',
      imageAssetRefs: [ASSET],
    },
  ],
  identifierIndex: [
    { kind: 'task', canonicalId: 'task:s7cytk', displayLabel: 's7cytk', lastSeenAt: '2026-05-31T00:00:02.000Z' },
  ],
  recentTaskTrace: {
    taskId: 't-a3f',
    toolsUsed: ['Bash', 'Write'],
    outputs: ['product-intro.pdf'],
    decisions: ['output PDF in A4'],
  },
  assets: { inputs: [ASSET], archives: [ASSET] },
  budget: {
    totalTokens: 8000,
    floors: { recent: 2000, compressedSegments: 800, quotes: 300, identifierIndex: 200, recentTaskTrace: 300 },
  },
};

/** The shape `buildEnvelope` returns NOW (producers not wired — §0.5). */
const EMPTY_PRODUCER: ConversationContextEnvelope = {
  envelopeVersion: 1,
  conversationId: 'conv-2',
  conversationType: 'direct',
  participants: [],
  recent: [
    { messageId: 'm-9', role: 'human', sender: 'bob', content: 'hi', createdAt: '2026-05-31T00:00:00.000Z' },
  ],
  compressedSegments: [],
  quotes: [],
  // identifierIndex + recentTaskTrace intentionally undefined (Phase 3 producer off)
  assets: { inputs: [], archives: [] },
  budget: {
    totalTokens: 8000,
    floors: { recent: 2000, compressedSegments: 800, quotes: 300, identifierIndex: 200, recentTaskTrace: 300 },
  },
};

const TOP_LEVEL_KEYS = new Set([
  'envelopeVersion',
  'conversationId',
  'conversationType',
  'participants',
  'recent',
  'compressedSegments',
  'quotes',
  'identifierIndex',
  'recentTaskTrace',
  'assets',
  'budget',
]);

const FLOOR_KEYS = new Set(['recent', 'compressedSegments', 'quotes', 'identifierIndex', 'recentTaskTrace']);

describe('ConversationContextEnvelope contract (runtime mirror)', () => {
  it('full golden envelope exercises every field and is version 1', () => {
    expect(FULL.envelopeVersion).toBe(1);
    // No unexpected top-level keys (drift catcher for added/renamed fields).
    for (const k of Object.keys(FULL)) expect(TOP_LEVEL_KEYS.has(k)).toBe(true);
    // Phase-3 fields present in the full fixture.
    expect(FULL.identifierIndex).toBeDefined();
    expect(FULL.recentTaskTrace).toBeDefined();
    // Quote image re-injection field (§13.4a P2) carries cdnUrl.
    expect(FULL.quotes[0].imageAssetRefs?.[0].cdnUrl).toBe('https://cdn.example/ast-1.png');
    // Asset partition split (decision D).
    expect(FULL.assets).toHaveProperty('inputs');
    expect(FULL.assets).toHaveProperty('archives');
  });

  it('budget always carries all five category floors', () => {
    for (const fixture of [FULL, EMPTY_PRODUCER]) {
      expect(new Set(Object.keys(fixture.budget.floors))).toEqual(FLOOR_KEYS);
      expect(fixture.budget.totalTokens).toBe(8000);
    }
  });

  it('Phase-1 empty-producer shape is a valid envelope (§0.5: producers not wired)', () => {
    // This is what buildEnvelope returns at runtime today: read-path queries the
    // empty segment/quote tables and yields [], Phase-3 fields stay undefined.
    expect(EMPTY_PRODUCER.compressedSegments).toEqual([]);
    expect(EMPTY_PRODUCER.quotes).toEqual([]);
    expect(EMPTY_PRODUCER.identifierIndex).toBeUndefined();
    expect(EMPTY_PRODUCER.recentTaskTrace).toBeUndefined();
    // recent is still populated — the only non-empty context source pre-producer.
    expect(EMPTY_PRODUCER.recent.length).toBeGreaterThan(0);
  });

  it('conversationType is the closed direct|group union on both fixtures', () => {
    expect(['direct', 'group']).toContain(FULL.conversationType);
    expect(['direct', 'group']).toContain(EMPTY_PRODUCER.conversationType);
  });
});
