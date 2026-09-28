// memory203/20 §2.1 — extraction prompt v2 shape + record-not-limit contract.
//
// What this pins (W-B of the four-truths plan; ruling 0705-3/4 "record, never
// limit"):
//   1. PROMPT SHAPE — the system prompt teaches richness-balanced PKF:
//      REQUIRED frontmatter `description`, the FULL <prismer-data> view set
//      (table|bar|line|scatter|area|heatmap), asset POINTER form
//      (prismer://asset/<id> + rel="derived-from"), the ANTI-REPEAT placement
//      rule, and the circular-recall discipline line — and carries NO budget
//      ("BUDGET", "minimal", "1-3 DENSE") language.
//   2. max_tokens default 8192 (was 2048), env-overridable via
//      MEMORY_EXTRACT_MAX_TOKENS — verified at the gateway seam (fetchImpl
//      captures the real request body; extract.ts runs verbatim).
//   3. Attached-asset ids reach the USER prompt as pointer URIs — both when
//      threaded explicitly (ExtractInput.attachedAssetIds, from the shell's
//      `extra.attached_asset_ids`) and via the fallback parse of the
//      `<attached_assets>` XML already in the turn text.
//   4. Usage RECORDING — prompt/completion tokens flow from the gateway
//      `usage` block onto the result, and hook-server's llm_response stage
//      line shape (`pages=N, chars=M[, tokens=in:X/out:Y][, truncated]`).

import { afterEach, describe, expect, it } from 'vitest';
import { CloudClient } from '../src/auth.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  REQUIRED_DURABILITY_SYSTEM_PROMPT,
  durabilityIntentFromTurn,
  extractFromTurn,
  parseAttachedAssetIdsFromTurn,
  type ExtractInput,
} from '../src/daemon/memory/extract.js';
import { formatLlmResponseDetail } from '../src/daemon/memory/hook-server.js';

afterEach(() => {
  delete process.env.MEMORY_EXTRACT_MAX_TOKENS;
});

// ── gateway seam: capture the real /api/v1/messages request body ────────────

interface CapturedCall {
  url: string;
  body: {
    model: string;
    max_tokens: number;
    thinking?: { type: 'disabled' };
    system?: string;
    messages: Array<{ role: string; content: string }>;
  };
}

function gatewayStub(response?: Record<string, unknown>): { cloud: CloudClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as CapturedCall['body'],
    });
    return new Response(
      JSON.stringify(
        response ?? {
          content: [{ type: 'text', text: '{"pages":[]}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 321, output_tokens: 45 },
        },
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const cloud = new CloudClient({ baseUrl: 'http://cloud.test', apiKey: 'sk-prismer-test', fetchImpl });
  return { cloud, calls };
}

/** A turn that clears the heuristic filters (≥80 user / ≥200 assistant chars). */
function substantiveInput(overrides: Partial<ExtractInput> = {}): ExtractInput {
  return {
    userMessage:
      'Please study the attached quarterly report and remember the revenue table, the churn numbers, ' +
      'and the pricing decision we made for the enterprise tier going forward.',
    assistantResponse:
      'I read the report. Revenue grew 12% QoQ with churn at 2.1%; the enterprise tier moves to ' +
      'usage-based pricing next quarter. I have recorded the table and the decision rationale so future ' +
      'sessions can reference them without re-reading the report from scratch.',
    conversationHistory: [],
    agentImUserId: 'im_agent_x',
    workspaceId: 'ws_prompt_test',
    roleSlug: null,
    conversationId: 'conv_1',
    runId: 'run_1',
    sessionMetadata: { model: 'test-model', platform: 'unit' },
    ...overrides,
  };
}

describe('EXTRACTION_SYSTEM_PROMPT v2 shape (memory203/20 §2.1)', () => {
  it('distinguishes a primary-agent tool prohibition from an explicit retention veto', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('A prohibition on the primary agent calling memory tools');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('is NOT a request to forget');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('must survive future sessions');
  });
  it('requires a frontmatter description (one-sentence self-summary)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('REQUIRED frontmatter');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"description" is a');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('MANDATORY one-sentence self-summary');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('<script type="application/prismer+json">');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"presentation":{"theme":"knowledge"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('<section><h2 id="slug">');
  });

  it('never asks the extractor to create an unplaced standalone leaf', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('NEVER emit an unplaced leaf');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('"placement":"extend|attach|hub|new"');
  });

  it('teaches the FULL prismer-data view set, not just table/bar/line', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain(
      '<prismer-data format="csv|json" view="table|bar|line|scatter|area|heatmap">',
    );
    // Tables must survive as data, not prose (doc 19 §3.1: live count was 0).
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Never flatten a source table into prose');
  });

  it('teaches the COPY + REFERENCE content model (memory211/01 轴A supersedes the pointer-only doctrine)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('ATTACHED ASSETS');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('<a rel="derived-from" href="prismer://asset/<id>">');
    // The page must CARRY the source's knowledge, with references back to it.
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('COPY + REFERENCE');
    // 轴A acceptance rule 1: the source's own vocabulary must survive.
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('LEXICON COVERAGE');
    // 轴A acceptance rule 2: section-level typed edges, anchored at #section.
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('SECTION EDGES');
    // The superseded anti-copy wording is gone, not merely accompanied.
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('do NOT copy the asset body');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('never copy the body');
  });

  it('carries the ANTI-REPEAT placement rule + circular-recall discipline', () => {
    // memory203/26 Wave1 — the ANTI-REPEAT block was reworded (F1/F2 extend-vs-attach
    // sharpening); assert on stable substrings the current rule still carries, not the
    // exact prior sentence.
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('ANTI-REPEAT');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('near-duplicate new page');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('do not re-extract');
  });

  it('teaches the full typed-link vocabulary including supports/contradicts', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('rel="derived-from|related|supports|contradicts|references"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('rel="contradicts"');
  });

  it('has NO budget / minimal framing (0705-3/4: record, never limit)', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('BUDGET');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('limited token budget');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('1-3 DENSE');
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/minimal valid PKF/i);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('There is no length budget');
  });
});

describe('gateway request — max_tokens + prompt assembly', () => {
  it('fails traceably without an execution model instead of selecting a hidden fallback', async () => {
    const { cloud, calls } = gatewayStub();
    const result = await extractFromTurn(substantiveInput({ sessionMetadata: { model: '', platform: 'unit' } }), {
      cloud,
      recallPages: [],
    });

    expect(result).toMatchObject({ pages: [], error: 'non_extractable:no_execution_model' });
    expect(calls).toHaveLength(0);
  });

  it('marks an explicit cross-session retention request as required even when the primary agent may not call Memory tools', async () => {
    const { cloud, calls } = gatewayStub();
    const userMessage =
      'Decide a reusable team rule for bounded pre-reply durability failures. This rule must survive future ' +
      'sessions. Do not call memory_write, memory_curate, or any Memory tool in this turn.';
    expect(durabilityIntentFromTurn(userMessage)).toBe('require');

    await extractFromTurn(substantiveInput({ userMessage }), { cloud, recallPages: [] });
    expect(calls[0]!.body.messages[0]!.content).toContain('Explicit retention contract: REQUIRED');
    expect(calls[0]!.body.messages[0]!.content).toContain('produce at least one durable page');
    expect(calls[0]!.body.system).toBe(REQUIRED_DURABILITY_SYSTEM_PROMPT);
    expect(calls[0]!.body.max_tokens).toBe(1536);
    expect(calls[0]!.body.thinking).toEqual({ type: 'disabled' });
  });

  it('NEGATIVE CONTROL — an explicit do-not-remember request wins over incidental durable vocabulary', async () => {
    const { cloud, calls } = gatewayStub();
    const userMessage =
      'Discuss the durable pre-reply mechanism, but this is an ephemeral control and must not be remembered ' +
      'or persisted for future sessions. Reply only for this turn.';
    expect(durabilityIntentFromTurn(userMessage)).toBe('forbid');

    await extractFromTurn(substantiveInput({ userMessage }), { cloud, recallPages: [] });
    expect(calls[0]!.body.messages[0]!.content).toContain('Explicit retention contract: FORBIDDEN');
    expect(calls[0]!.body.messages[0]!.content).toContain('return {"pages":[]}');
  });

  it('defaults max_tokens to 32768 (reasoning budget) and sends the v2 system prompt', async () => {
    const { cloud, calls } = gatewayStub();
    const r = await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(r.error).toBeNull();
    expect(calls).toHaveLength(1);
    // product210/03: 8192 let reasoning models spend the whole budget thinking
    // (observed llm_truncated + 12-char text). Default raised; env still wins.
    expect(calls[0]!.body.max_tokens).toBe(32768);
    expect(calls[0]!.body.system).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(calls[0]!.body.thinking).toBeUndefined();
  });

  it('keeps the bounded required-retention prompt concise but structurally complete', () => {
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('exactly one durable page');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('<script type="application/prismer+json">');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('at least two <section><h2 id="slug">');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('"presentation":{"theme":"knowledge"');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('STRICT JSON ONLY');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT).toContain('Do not spend tokens explaining or reasoning');
    expect(REQUIRED_DURABILITY_SYSTEM_PROMPT.length).toBeLessThan(2400);
  });

  it('MEMORY_EXTRACT_MAX_TOKENS env overrides the default', async () => {
    process.env.MEMORY_EXTRACT_MAX_TOKENS = '1234';
    const { cloud, calls } = gatewayStub();
    await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(calls[0]!.body.max_tokens).toBe(1234);
  });

  it('lists explicit attachedAssetIds as prismer://asset/<id> pointer URIs in the user prompt', async () => {
    const { cloud, calls } = gatewayStub();
    await extractFromTurn(substantiveInput({ attachedAssetIds: ['ast_q3_report', 'ast_pricing'] }), {
      cloud,
      recallPages: [],
    });
    const userPrompt = calls[0]!.body.messages[0]!.content;
    expect(userPrompt).toContain('Attached assets on this turn');
    expect(userPrompt).toContain('- prismer://asset/ast_q3_report');
    expect(userPrompt).toContain('- prismer://asset/ast_pricing');
  });

  it('falls back to parsing <attached_assets> XML from the turn text when ids are not threaded', async () => {
    const { cloud, calls } = gatewayStub();
    const input = substantiveInput({
      userMessage:
        '<current_message><attached_assets><asset id="ast_from_xml" mime="application/pdf" filename="q3.pdf"/>' +
        '</attached_assets>Please study the attached quarterly report and remember the revenue table and the ' +
        'churn numbers for the enterprise tier decision.</current_message>',
    });
    await extractFromTurn(input, { cloud, recallPages: [] });
    expect(calls[0]!.body.messages[0]!.content).toContain('- prismer://asset/ast_from_xml');
  });

  it('omits the asset section entirely when the turn has no attachments', async () => {
    const { cloud, calls } = gatewayStub();
    await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(calls[0]!.body.messages[0]!.content).not.toContain('Attached assets on this turn');
  });
});

describe('usage recording (record-not-limit)', () => {
  it('surfaces gateway usage tokens on the result', async () => {
    const { cloud } = gatewayStub({
      content: [{ type: 'text', text: '{"pages":[]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 777, output_tokens: 88 },
    });
    const r = await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(r.promptTokens).toBe(777);
    expect(r.completionTokens).toBe(88);
    expect(r.truncated).toBe(false);
  });

  it('records the truncated flag alongside usage when stop_reason=max_tokens', async () => {
    const { cloud } = gatewayStub({
      content: [{ type: 'text', text: '{"pages":[' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 8192 },
    });
    const r = await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(r.truncated).toBe(true);
    expect(r.completionTokens).toBe(8192);
  });

  it('missing usage block → tokens undefined (no fabricated numbers)', async () => {
    const { cloud } = gatewayStub({
      content: [{ type: 'text', text: '{"pages":[]}' }],
      stop_reason: 'end_turn',
    });
    const r = await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(r.promptTokens).toBeUndefined();
    expect(r.completionTokens).toBeUndefined();
  });

  it('formatLlmResponseDetail — the llm_response stage-line shape', () => {
    expect(formatLlmResponseDetail({ pages: [1, 2], rawTextChars: 900, promptTokens: 321, completionTokens: 45 })).toBe(
      'pages=2, chars=900, tokens=in:321/out:45',
    );
    expect(
      formatLlmResponseDetail({ pages: [], rawTextChars: 10, latencyMs: 1420 }).startsWith('pages=0, chars=10'),
    ).toBe(true);
    expect(formatLlmResponseDetail({ pages: [], rawTextChars: 10, latencyMs: 1420 })).toContain('latency_ms=1420');
    expect(
      formatLlmResponseDetail({ pages: [], rawTextChars: 10, truncated: true, promptTokens: 5, completionTokens: 7 }),
    ).toBe('pages=0, chars=10, tokens=in:5/out:7, truncated');
    // No usage reported → the tokens segment is absent (legacy line shape intact).
    expect(formatLlmResponseDetail({ pages: [1], rawTextChars: 42 })).toBe('pages=1, chars=42');
  });
});

describe('sanitiser keeps PKF data scripts (frontmatter must survive the write path)', () => {
  it('the REQUIRED frontmatter script + prismer-data option child survive; executable scripts are stripped', async () => {
    const fm = '<script type="application/prismer+json">{"type":"note","title":"T","description":"one line"}</script>';
    const dataChild = '<script type="application/prismer+data+json">{"x":"date"}</script>';
    const content = `${fm}<h1>T</h1><h2 id="a">A</h2><p>body</p>${dataChild}<script>alert(1)</script>`;
    const { cloud } = gatewayStub({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            pages: [{ path: 'topics/t.pkf', title: 'T', placement: 'new', kind: 'project', content }],
          }),
        },
      ],
      stop_reason: 'end_turn',
    });
    const r = await extractFromTurn(substantiveInput(), { cloud, recallPages: [] });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.content).toContain('application/prismer+json');
    expect(r.pages[0]!.content).toContain('"description":"one line"');
    expect(r.pages[0]!.content).toContain('application/prismer+data+json');
    expect(r.pages[0]!.content).not.toContain('alert(1)');
  });
});

describe('parseAttachedAssetIdsFromTurn', () => {
  it('extracts deduped ids from <attached_assets> blocks only', () => {
    const msg =
      '<asset id="outside_block"/>' +
      '<attached_assets><asset id="a1" mime="image/png"/><asset id="a2"/><asset id="a1"/></attached_assets>' +
      '<attached_assets><asset id="a3"/></attached_assets>';
    expect(parseAttachedAssetIdsFromTurn(msg)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns [] for plain text', () => {
    expect(parseAttachedAssetIdsFromTurn('no xml at all')).toEqual([]);
  });
});
