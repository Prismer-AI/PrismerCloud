// release201/25 §7 / release201/26 §7.4 — CLI adapter envelope renderer.
//
// Covers both claude-code and codex (codex re-exports claude-code). Markdown-
// flat output for CLI agents that have no structured history API.

import { describe, it, expect } from 'vitest';
import { renderContextEnvelope as renderClaudeCode } from '../src/adapters/claude-code/context-render.js';
import { renderContextEnvelope as renderCodex } from '../src/adapters/codex/context-render.js';
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

describe('claude-code/context-render — renderContextEnvelope', () => {
  it('renders header + current message in markdown for an empty envelope', () => {
    const out = renderClaudeCode(baseEnvelope(), { currentPrompt: 'do the thing' });
    expect(out.promptText).toContain('# Conversation Context');
    expect(out.promptText).toContain('## Current message');
    expect(out.promptText).toContain('do the thing');
  });

  it('lists participants and renders recent messages with role labels', () => {
    const env = baseEnvelope({
      participants: [
        { imUserId: 'u_a', username: 'alice', displayName: 'Alice', role: 'human', agentType: null },
      ],
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'first', createdAt: '2026-05-31T09:00:00Z' },
        { messageId: 'm2', role: 'agent', sender: 'ceo', content: 'reply', createdAt: '2026-05-31T09:01:00Z' },
      ],
    });
    const out = renderClaudeCode(env, { currentPrompt: 'continue' });
    expect(out.promptText).toContain('Participants: alice (human)');
    expect(out.promptText).toContain('## Recent messages');
    expect(out.promptText).toContain('**alice** (human');
    expect(out.promptText).toContain('**ceo** (agent');
  });

  it('renders archive references as text-only (decision D)', () => {
    const env = baseEnvelope({
      assets: {
        inputs: [
          {
            assetId: 'ast-i',
            contentHash: 'h1',
            mime: 'image/png',
            sizeBytes: 1,
            kind: 'image',
            workspaceId: 'ws-1',
            role: 'attachment',
            cdnUrl: 'https://cdn.example/i.png',
            filename: 'shot.png',
          },
        ],
        archives: [
          {
            assetId: 'ast-a',
            contentHash: 'h2',
            mime: 'application/pdf',
            sizeBytes: 1000,
            kind: 'file',
            workspaceId: 'ws-1',
            role: 'context',
            filename: 'old.pdf',
          },
        ],
      },
    });
    const out = renderClaudeCode(env, { currentPrompt: 'q' });
    expect(out.promptText).toContain('## Attached assets (input)');
    expect(out.promptText).toContain('shot.png');
    expect(out.promptText).toContain('https://cdn.example/i.png');
    expect(out.promptText).toContain('## Archive references');
    expect(out.archiveDescriptions[0]).toContain('old.pdf');
  });
});

describe('codex/context-render — re-export sanity', () => {
  it('produces identical output to claude-code (shared implementation)', () => {
    const env = baseEnvelope({
      recent: [
        { messageId: 'm1', role: 'human', sender: 'alice', content: 'hi', createdAt: '2026-05-31T09:00:00Z' },
      ],
    });
    const a = renderClaudeCode(env, { currentPrompt: 'go' });
    const b = renderCodex(env, { currentPrompt: 'go' });
    expect(b.promptText).toEqual(a.promptText);
  });
});
