// release201/25 §7 / release201/26 §7.4 — Hermes adapter envelope renderer.
//
// Verifies:
//   - empty envelope produces a well-formed <conversation_context> wrapper
//   - participants land in <participants> with is_you flag
//   - recent[] becomes <prior_message> entries in time order
//   - current message is rendered with the trigger sender's name
//   - quotes become <prior_message> rows
//   - assets.inputs survive into imageRefs (preserves cdnUrl)
//   - on stateful + sessionIsNew=false the recent body collapses (thin path)
//   - compressedSegments render in seq order before recent[]

import { describe, it, expect } from 'vitest';
import { renderContextEnvelope } from '../src/adapters/hermes/context-render.js';
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

describe('hermes/context-render — renderContextEnvelope', () => {
  it('produces a well-formed <conversation_context> wrapper for an empty envelope', () => {
    const out = renderContextEnvelope(baseEnvelope(), {
      currentPrompt: 'hello world',
      youUsername: 'engineer',
    });
    expect(out.body).toContain('<conversation_context');
    expect(out.body).toContain('type="group"');
    expect(out.body).toContain('conversation_id="conv-1"');
    expect(out.body).toContain('</conversation_context>');
    // current message tag carries the prompt text.
    expect(out.body).toContain('<current_message');
    expect(out.body).toContain('hello world');
  });

  it('renders participants with is_you marker on the recipient', () => {
    const env = baseEnvelope({
      participants: [
        { imUserId: 'u_a', username: 'alice', displayName: 'Alice', role: 'human', agentType: null },
        { imUserId: 'u_eng', username: 'engineer', displayName: 'Engineer', role: 'agent', agentType: 'hermes' },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'hi', youUsername: 'engineer' });
    expect(out.body).toContain('<p username="alice" role="human"');
    expect(out.body).toContain('<p username="engineer" role="agent"');
    expect(out.body).toMatch(/<p username="engineer"[^/]*is_you="true"/);
  });

  it('maps recent[] into <prior_message> tags in oldest-first order', () => {
    const env = baseEnvelope({
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'first', createdAt: '2026-05-31T09:00:00Z' },
        { messageId: 'm2', role: 'agent', sender: 'ceo', content: 'second', createdAt: '2026-05-31T09:01:00Z' },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'what now?', youUsername: 'engineer' });
    const firstIdx = out.body.indexOf('first');
    const secondIdx = out.body.indexOf('second');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx); // ordering preserved
    expect(out.body).toContain('<prior_message author="alice"');
    expect(out.body).toContain('<prior_message author="ceo"');
  });

  it('renders compressedSegments BEFORE recent[] in seq order', () => {
    const env = baseEnvelope({
      compressedSegments: [
        {
          segmentSeq: 2,
          coversFromAt: '2026-04-02T00:00:00Z',
          coversToAt: '2026-04-03T00:00:00Z',
          summary: 'second-summary',
          salientFacts: {},
          sourceCount: 3,
          tokenCountCl100k: 50,
        },
        {
          segmentSeq: 1,
          coversFromAt: '2026-04-01T00:00:00Z',
          coversToAt: '2026-04-02T00:00:00Z',
          summary: 'first-summary',
          salientFacts: {},
          sourceCount: 4,
          tokenCountCl100k: 60,
        },
      ],
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'recent-body', createdAt: '2026-05-31T09:00:00Z' },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'next', youUsername: 'engineer' });
    const segOneIdx = out.body.indexOf('first-summary');
    const segTwoIdx = out.body.indexOf('second-summary');
    const recentIdx = out.body.indexOf('recent-body');
    expect(segOneIdx).toBeGreaterThan(0);
    expect(segTwoIdx).toBeGreaterThan(segOneIdx); // seq 1 then 2
    expect(recentIdx).toBeGreaterThan(segTwoIdx); // recent comes after
  });

  it('surfaces quotes as <prior_message> rows with quoted ref', () => {
    const env = baseEnvelope({
      quotes: [
        {
          quotedMessageId: 'q-9',
          snippet: 'the agreed plan',
          quotedSender: 'alice',
          quotedAt: '2026-05-30T12:00:00Z',
        },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'recall?', youUsername: 'engineer' });
    expect(out.body).toContain('[Quote · ref=q-9]');
    expect(out.body).toContain('the agreed plan');
  });

  it('preserves assets.inputs (cdnUrl carries through to imageRefs)', () => {
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
            cdnUrl: 'https://cdn.example/ast-img.png',
          },
        ],
        archives: [],
      },
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'see attached', youUsername: 'engineer' });
    expect(out.imageRefs).toHaveLength(1);
    expect(out.imageRefs[0]!.assetId).toBe('ast-img');
    expect(out.imageRefs[0]!.cdnUrl).toBe('https://cdn.example/ast-img.png');
  });

  it('renders archive assets as TEXT-ONLY descriptions (decision D)', () => {
    const env = baseEnvelope({
      assets: {
        inputs: [],
        archives: [
          {
            assetId: 'ast-pdf',
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
    const out = renderContextEnvelope(env, { currentPrompt: 'q', youUsername: 'engineer' });
    expect(out.imageRefs).toHaveLength(0);
    expect(out.archiveDescriptions).toHaveLength(1);
    expect(out.archiveDescriptions[0]).toContain('old-deck.pdf');
    expect(out.archiveDescriptions[0]).toContain('reference only');
  });

  it('omits compressedSegments + recent on stateful reused session (thin path)', () => {
    // sessionIsNew=false should drop the replayable body but still ship the
    // current message and the conversation_context wrapper.
    const env = baseEnvelope({
      compressedSegments: [
        {
          segmentSeq: 1,
          coversFromAt: '2026-04-01T00:00:00Z',
          coversToAt: '2026-04-02T00:00:00Z',
          summary: 'stale-summary',
          salientFacts: {},
          sourceCount: 1,
          tokenCountCl100k: 30,
        },
      ],
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'stale-recent', createdAt: '2026-05-31T09:00:00Z' },
      ],
    });
    const out = renderContextEnvelope(env, { currentPrompt: 'follow-up', youUsername: 'engineer', sessionIsNew: false });
    expect(out.body).toContain('<current_message');
    expect(out.body).toContain('follow-up');
    expect(out.body).not.toContain('stale-summary');
    expect(out.body).not.toContain('stale-recent');
  });
});
