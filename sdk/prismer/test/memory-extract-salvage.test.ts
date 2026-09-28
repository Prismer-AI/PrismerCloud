// memory203/18 W2 — the W1-gate 0-yield root fix (extract.ts).
//
// Live-diagnosed root cause (2026-07-03, pod prismer-agent-rt-r3tv6kp-q1myi26n):
// kimi's multi-page extraction JSON stochastically exceeds max_tokens=2048
// (`stop_reason=max_tokens`, output cut mid-object) → JSON.parse fails →
// parseExtractedPages returned a SILENT [] indistinguishable from "nothing
// durable" — the gate's `llm_called 3/3 → extracted 0/3`.
//
// What this proves:
//   1. A TRUNCATED `{"pages":[…` payload salvages every COMPLETE page object
//      (string-aware brace scan — braces inside content strings don't fool it)
//      and drops only the incomplete tail; `truncated=true` + rawTextChars are
//      surfaced for the hook-server's `stage=llm_response(pages, chars,
//      truncated)` terminal log.
//   2. NEGATIVE CONTROL — a well-formed payload parses exactly as before
//      (truncated=false, all pages, byte-identical fields).
//   3. A truncated payload whose FIRST object is already incomplete salvages
//      nothing → pages=[] with error=null (genuine-zero shape) — but now
//      loudly flagged truncated, never silent.
//
// The LLM seam is the in-pod gateway `/api/v1/messages` stubbed via
// CloudClient.fetchImpl — extract.ts runs verbatim.

import { describe, expect, it } from 'vitest';
import { CloudClient } from '../src/auth.js';
import { extractFromTurn, type ExtractInput } from '../src/daemon/memory/extract.js';

function input(): ExtractInput {
  return {
    userMessage:
      'Please read the attached desktop-update design document and remember the durable ' +
      'decisions it contains for the team, including rollout gates and signing rules.',
    assistantResponse:
      'I read the desktop update design document. Durable takeaways: staged rollout 5/50/100 ' +
      'with a 24h canary; macOS builds signed and notarized in CI; the updater feed is served ' +
      'per-channel; cold-launch p95 must stay under 1.8s after an update; crash-free sessions ' +
      'gate at 99.5% or the rollout halts automatically.',
    conversationHistory: [],
    agentImUserId: 'im_agent_x',
    workspaceId: 'ws_salvage',
    roleSlug: null,
    conversationId: 'conv_1',
    runId: 'run_1',
    sessionMetadata: { model: 'test-model', platform: 'unit' },
    traceId: 'tr_salvage01',
  };
}

/** Gateway stub returning an Anthropic-wire envelope with the given text + stop_reason. */
function gateway(text: string, stopReason: string): CloudClient {
  return new CloudClient({
    baseUrl: 'http://cloud.test',
    apiKey: 'sk-test',
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).includes('/api/v1/messages')) {
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stopReason }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
}

const PAGE_1 =
  '{"path":"docs/desktop.pkf","title":"Desktop 技术文档","placement":"hub","kind":"project",' +
  '"content":"<h1>Desktop</h1><p>hub — note the braces {inside a string} stay harmless</p>"}';
const PAGE_2 =
  '{"path":"docs/desktop/update-strategy.pkf","title":"更新策略","placement":"attach",' +
  '"parentHubPath":"docs/desktop.pkf","kind":"project","content":"<h1>Update strategy</h1><p>5/50/100</p>"}';

describe('extract salvage — truncated max_tokens payload (W1-gate 0-yield root fix)', () => {
  it('salvages the complete pages out of a mid-object truncation and flags truncated', async () => {
    // Page 1 + page 2 complete; page 3 cut mid-content-string (max_tokens).
    const truncatedText =
      `{"pages":[${PAGE_1},${PAGE_2},{"path":"docs/desktop/signing.pkf","title":"签名","placement":"attach","parentHubPath":"docs/desktop.pkf","kind":"project","content":"<h1>Signing</h1><p>Team ID QGV`;
    const result = await extractFromTurn(input(), {
      cloud: gateway(truncatedText, 'max_tokens'),
      recallPages: [],
    });
    expect(result.error).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.rawTextChars).toBe(truncatedText.length);
    // The two COMPLETE pages survived; the cut tail page was dropped.
    expect(result.pages.map((p) => p.path)).toEqual([
      'docs/desktop.pkf',
      'docs/desktop/update-strategy.pkf',
    ]);
    expect(result.pages[0]!.pageType).toBe('hub');
    expect(result.pages[1]!.placement).toBe('attach');
    expect(result.pages[1]!.parentHubPath).toBe('docs/desktop.pkf');
  });

  it('NEGATIVE CONTROL — a well-formed payload parses exactly as before (truncated=false)', async () => {
    const wellFormed = `{"pages":[${PAGE_1},${PAGE_2}]}`;
    const result = await extractFromTurn(input(), {
      cloud: gateway(wellFormed, 'end_turn'),
      recallPages: [],
    });
    expect(result.error).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]!.title).toBe('Desktop 技术文档');
  });

  it('truncation before ANY complete object yields pages=[] (genuine-zero shape) but flagged truncated', async () => {
    const cutEarly = '{"pages":[{"path":"docs/x.pkf","title":"cut mid';
    const result = await extractFromTurn(input(), {
      cloud: gateway(cutEarly, 'max_tokens'),
      recallPages: [],
    });
    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it('a model {"pages":[]} verdict stays a clean zero (no salvage side effects)', async () => {
    const result = await extractFromTurn(input(), {
      cloud: gateway('{"pages":[]}', 'end_turn'),
      recallPages: [],
    });
    expect(result.error).toBeNull();
    expect(result.pages).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });
});
