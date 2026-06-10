/**
 * release201/24 §Phase1a — skill-authoring-chat service unit tests.
 *
 * Verifies the conversational spec-gathering brain (Path B): spec
 * normalization, the `ready` gate (model claim AND isSpecReady must agree),
 * structured decision extraction, and graceful degradation on bad JSON. The
 * LLM is injected so turns are deterministic — no network.
 *
 * Run: npx vitest run src/im/tests/acp-skill-authoring-chat.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  type AuthoringChatLLM,
  type AuthoringSpec,
  isSpecReady,
  runAuthoringChat,
} from '../services/skill-authoring-chat.service';

const READY_SPEC: AuthoringSpec = {
  slug: 'call-example-api',
  name: 'Call Example API',
  triggers: ['call the example api'],
  sourceKind: 'doc-url',
  sourceRefs: ['https://docs.example.com/openapi.json'],
  scope: 'workspace',
  sampleTasks: [{ input: 'fetch a report', acceptanceCriteria: ['"status":\\s*200'] }],
};

function llmReturning(payload: unknown): AuthoringChatLLM {
  return async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
}

describe('isSpecReady', () => {
  it('is true only when slug/name/triggers/sourceKind/scope + concrete acceptance all present', () => {
    expect(isSpecReady(READY_SPEC)).toBe(true);
  });

  it('is false when a required field is missing', () => {
    expect(isSpecReady({ ...READY_SPEC, slug: undefined })).toBe(false);
    expect(isSpecReady({ ...READY_SPEC, triggers: [] })).toBe(false);
    expect(isSpecReady({ ...READY_SPEC, scope: undefined })).toBe(false);
  });

  it('is false when no acceptance criteria exist anywhere', () => {
    expect(isSpecReady({ ...READY_SPEC, sampleTasks: [{ input: 'x', acceptanceCriteria: [] }] })).toBe(false);
  });

  it('accepts top-level acceptanceCriteria without sampleTasks', () => {
    const spec: AuthoringSpec = { ...READY_SPEC, sampleTasks: undefined, acceptanceCriteria: ['results'] };
    expect(isSpecReady(spec)).toBe(true);
  });
});

describe('runAuthoringChat', () => {
  const base = { messages: [{ role: 'user' as const, content: 'make a skill from this api' }], workspaceId: 'ws-1' };

  it('parses reply, spec and decisions from a valid model turn', async () => {
    const turn = await runAuthoringChat(base, {
      llm: llmReturning({
        reply: 'Which source?',
        spec: { slug: 'x', name: 'X' },
        decisions: [
          {
            key: 'sourceKind',
            label: 'Where from?',
            options: [{ value: 'doc-url', label: 'API doc / URL', hint: 'OpenAPI' }],
          },
        ],
        ready: false,
      }),
    });
    expect(turn.reply).toBe('Which source?');
    expect(turn.spec.slug).toBe('x');
    expect(turn.decisions).toHaveLength(1);
    expect(turn.decisions[0].options[0].value).toBe('doc-url');
    expect(turn.ready).toBe(false);
  });

  it('honors ready=true ONLY when the spec is actually complete', async () => {
    const incomplete = await runAuthoringChat(base, {
      llm: llmReturning({ reply: 'done!', spec: { slug: 'x' }, decisions: [], ready: true }),
    });
    expect(incomplete.ready).toBe(false); // model lied — isSpecReady gate catches it

    const complete = await runAuthoringChat(base, {
      llm: llmReturning({ reply: 'ready', spec: READY_SPEC, decisions: [], ready: true }),
    });
    expect(complete.ready).toBe(true);
  });

  it('drops malformed decision options and coerces unknown enum values', async () => {
    const turn = await runAuthoringChat(base, {
      llm: llmReturning({
        reply: 'ok',
        spec: { slug: 'x', name: 'X', sourceKind: 'bogus', scope: 'galaxy', triggers: 'not-an-array' },
        decisions: [{ key: 'k', label: 'l', options: [{ value: 'v' }] }], // option missing label → dropped
        ready: false,
      }),
    });
    expect(turn.spec.sourceKind).toBeUndefined();
    expect(turn.spec.scope).toBeUndefined();
    expect(turn.spec.triggers).toBeUndefined();
    expect(turn.decisions).toHaveLength(0);
  });

  it('extracts a JSON object even when wrapped in prose / fences', async () => {
    const turn = await runAuthoringChat(base, {
      llm: llmReturning('Sure!\n```json\n{"reply":"hi","spec":{"slug":"y"},"decisions":[],"ready":false}\n```'),
    });
    expect(turn.reply).toBe('hi');
    expect(turn.spec.slug).toBe('y');
  });

  it('degrades gracefully when the model returns no JSON', async () => {
    const turn = await runAuthoringChat(
      { ...base, specSoFar: { slug: 'keep' } },
      { llm: llmReturning('no json here, just chatter') },
    );
    expect(turn.ready).toBe(false);
    expect(turn.spec.slug).toBe('keep'); // falls back to specSoFar
    expect(turn.reply).toContain('no json here');
  });
});
