// memory203/13 — DAEMON-SIDE (in-pod) automatic CONVERSATION COMPACTION.
//
// The exact SIBLING of the memory `extract` leg (extract.ts). GOVERNING RULE is
// identical: the LLM call runs in the AGENT's own runtime — the daemon inside
// the agent's pod, using the agent's own gateway credentials
// (`${cloud.baseUrl}/api/v1/messages`, Anthropic wire, `Bearer cloud.apiKey`).
// The cloud does ZERO LLM for compaction; it only (a) tells the daemon WHICH
// slice aged past the recent window (GET .../compaction-candidate) and (b)
// persists the produced segment (POST .../segments). We NEVER route the
// compaction LLM through a cloud endpoint — the gateway is only a proxy for the
// agent-initiated call.
//
// Where extract.ts turns a completed turn into durable PKF wiki pages, this leg
// turns an AGING conversation slice into a session PROJECTION: a thin ephemeral
// digest + POINTERS to the memory pages that already cover the durable facts.
// The two legs are orthogonal — extract owns durable capture, compaction owns
// the session view — and they share ONLY this module's gateway-call machinery
// (`callGatewayOnce`), imported from extract.ts so the
// in-pod call path cannot drift between them.

import type { CloudClient } from '../../auth.js';
import { callGatewayOnce } from './extract.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('memory-compaction');

// ── gateway call tuning (mirror extract.ts) ─────────────────────────────────
/** Bounded retry on transient gateway failure (status 0 / 5xx). 1 retry → 2 attempts. */
const MAX_GATEWAY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One attributed message in the aging slice (mirrors cloud AttributedMsg). */
export interface CompactionSliceMsg {
  messageId: string;
  /** Pre-rendered `@username (role): text` (the cloud stamps this). */
  line: string;
}

/** salientFacts shape the compaction skill returns (SESSION PROJECTION residue). */
export interface CompactionSalientFacts {
  /** One POINTER per memory page recall matched to a durable fact in the slice. */
  memoryRefs?: Array<{ path: string; note?: string }>;
  /** Ephemeral open threads (only matter to keep THIS thread coherent). */
  openThreads?: string[];
  /** Ephemeral abandoned directions (tried-and-dropped). */
  abandonedDirections?: string[];
}

/** A memory page surfaced by DEVICE-LOCAL recall over the slice content. */
export interface RecallPageRef {
  path: string;
  snippet: string;
}

/** What the in-pod compactor needs to run ONE gateway call over a slice. */
export interface CompactionInput {
  slice: CompactionSliceMsg[];
  /**
   * memory203 — pages found by DEVICE-LOCAL recall (daemon FTS5, same
   * `slot.search.hybrid` path handlePreLlmCall uses) over the slice content.
   * These MAY already hold durable facts from this slice; the skill should emit
   * `memoryRefs` POINTERS to them instead of INLINING those facts into `summary`.
   * Recall is a fuzzy match, so the model still decides which facts a page covers.
   */
  recallContext?: RecallPageRef[];
  conversationType: 'group' | 'direct';
  /** Model stamped by the completed turn/profile authority; empty is terminal. */
  model: string;
  /** memory203/18 R8.1 — trace id threaded from the post_llm_call body (optional). */
  traceId?: string;
  /** Run id for logs (optional). */
  runId?: string;
}

/**
 * Structured outcome of `compactSlice`:
 *   - `error: null`  → a produced projection (`summary` + `salientFacts`).
 *   - `error: '...'` → a gateway/LLM failure (empty summary). NOT "nothing to
 *                      compact" — a pipeline failure the caller surfaces (logged).
 *                      Never blocks the turn.
 */
export interface CompactionResult {
  summary: string;
  salientFacts: CompactionSalientFacts;
  error: string | null;
  /** HTTP status of the final failed gateway attempt when `error` is set (0 = transport). */
  errorStatus?: number;
  /** Gateway `stop_reason === 'max_tokens'` (payload truncated). */
  truncated?: boolean;
  /** Recorded (never budgeted) gateway token usage. */
  promptTokens?: number;
  completionTokens?: number;
}

/** What compactSlice needs: the agent's gateway client. */
export interface CompactionDependencies {
  /**
   * The daemon's CloudClient — `cloud.baseUrl` is the agent's gateway base and
   * `cloud.apiKey` is the agent's sk-prismer token. We call `${baseUrl}/api/v1/messages`
   * (Anthropic wire) authed with that token: the IN-POD, agent-credentialed path.
   * The cloud does NOT compact — it only proxies this LLM call.
   */
  cloud: CloudClient;
}

// ── compaction prompt ───────────────────────────────────────────────────────
/**
 * The distilled `built-in-skills/conversation-compaction/SKILL.md`. It differs
 * from that skill in ONE deliberate way: the daemon runs this as a SINGLE
 * gateway call WITHOUT memory tools, so it cannot browse/write memory pages for
 * residual durable facts. Per SKILL.md §"Failure / degradation", when memory
 * tools are unavailable the durable facts are INLINED into `summary` (degraded
 * faithful) — the extract hook (extract.ts) handles durable CAPTURE separately,
 * so this leg does not lose them, it just does not re-home them.
 *
 * ⚠️ keep in sync with built-in-skills/conversation-compaction/SKILL.md
 */
export const COMPACTION_SYSTEM_PROMPT = [
  'You produce the SESSION PROJECTION of memory for an AGING slice of a conversation',
  '(messages that scrolled past the recent verbatim window). The projection REPLACES the raw',
  'slice in future agent context. This is NOT a faithful summary and NOT a transcript — it is a',
  'thin projection: current thread state + pointers to the memory pages that hold the durable facts.',
  '',
  'THE MODEL — sync by POINTER, not by re-summary. Durable knowledge lives in the memory wiki. A',
  'session projection does NOT re-summarize durable facts — it POINTS at the memory pages that',
  'hold them, by emitting memory:<path> pointers.',
  '',
  'INPUT you receive:',
  '  - the aging slice: raw messages oldest-first, each `[msgId] @username (role): text`.',
  '  - conversationType: group | direct.',
  '  - <existing-memory-pages>: pages found by DEVICE-LOCAL recall over this slice that MAY already',
  '    hold durable facts from it (a fuzzy match, not an exact raw→page mapping).',
  '',
  'POINTER-FIRST RULE — you are given <existing-memory-pages> (pages recall thinks already hold durable',
  'facts from this slice). For a durable fact in the slice that MATCHES an existing page, emit a',
  '`memoryRefs` pointer { path, note } — do NOT restate the fact in `summary`. Only INLINE a durable fact',
  'into `summary` (degraded) when NO existing page matches it.',
  '',
  'FLOW — triage each slice message:',
  '  - DURABLE ("would this matter in a DIFFERENT conversation next week?"): if an <existing-memory-pages>',
  '    page already holds it, emit a memoryRefs POINTER to that page (path + note) — do NOT inline it.',
  '    Only when NO existing page matches, INLINE it briefly into `summary` (a degraded faithful capture —',
  '    you run as a SINGLE call WITHOUT memory tools, so you cannot write a new page). Durable CAPTURE is',
  '    handled separately by the extract hook; you are only keeping the thread coherent, so keep it terse.',
  '  - EPHEMERAL ("only matters to keep THIS thread coherent?"): carry THIN — an openThreads or',
  '    abandonedDirections line. It ages out; never promote it to memory.',
  '  - NOISE ("lose it, nothing changes?"): DROP.',
  'Then compose the output: the thin ephemeral residue + the pointer list (any page you matched by memory:<path>).',
  '',
  'SPEAKER ATTRIBUTION: for group slices, WHO decided / WHO objected IS content — preserve it on every',
  'decision (e.g. "@ceo decided X, @eng dissented"), in the memoryRef note or the summary line.',
  '',
  'OUTPUT — return ONLY this JSON (no prose, no code fence):',
  '{"summary":"<3-8 short lines: current thread state, referencing durable parts by memory:<path>; NOT a re-statement of the slice>",',
  ' "salientFacts":{',
  '   "memoryRefs":[{"path":"decisions/vendor.pkf","note":"vendor B (compliance); @ceo decided, @eng dissented"}],',
  '   "openThreads":["awaiting @ceo sign-off on A4 vs Letter page size"],',
  '   "abandonedDirections":["tried gpt-4o for compaction — too slow, dropped"]}}',
  '  - memoryRefs: one POINTER per matched page.',
  '  - openThreads / abandonedDirections: the ephemeral residue ONLY. OMIT an array when it is empty.',
  '  - NO decisions/entities/preferences/commitments fields — those are durable; they live in memoryRefs.',
  '',
  'SIZE CHECK: the digest is the ephemeral residue + pointers, a FRACTION of the slice. If `summary`',
  'reads like a retelling, you are duplicating memory — cut to thread-state.',
  'Pure-noise slice → {"summary":"(no substantive content)","salientFacts":{}}.',
].join('\n');

/** Render the DEVICE-LOCAL recall pages into a labelled block ('' when none). */
function renderRecallContext(pages: RecallPageRef[] | undefined): string {
  if (!pages || pages.length === 0) return '';
  const lines = pages.map((p) => `- ${p.path}: ${p.snippet}`);
  return ['<existing-memory-pages>', ...lines, '</existing-memory-pages>'].join('\n');
}

/** Render the aging slice into the prompt as `[msgId] @username (role): text` lines. */
function renderSlice(slice: CompactionSliceMsg[]): string {
  if (slice.length === 0) return '(empty slice)';
  return slice.map((m) => `[${m.messageId}] ${m.line}`).join('\n');
}

/** Parse the model's JSON (tolerating a stray ```json fence) into summary + salientFacts. */
export function parseCompactionResult(raw: string): {
  summary: string;
  salientFacts: CompactionSalientFacts;
} {
  let json = raw.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1]!.trim();
  if (!json.startsWith('{')) {
    const objStart = json.indexOf('{');
    if (objStart >= 0) json = json.slice(objStart);
  }
  let parsed: { summary?: unknown; salientFacts?: unknown };
  try {
    parsed = JSON.parse(json) as { summary?: unknown; salientFacts?: unknown };
  } catch {
    return { summary: '', salientFacts: {} };
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const sf =
    parsed.salientFacts && typeof parsed.salientFacts === 'object'
      ? (parsed.salientFacts as Record<string, unknown>)
      : {};
  const salientFacts: CompactionSalientFacts = {};
  if (Array.isArray(sf.memoryRefs)) {
    salientFacts.memoryRefs = (sf.memoryRefs as unknown[])
      .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
      .map((v) => ({
        path: typeof v.path === 'string' ? v.path : '',
        ...(typeof v.note === 'string' ? { note: v.note } : {}),
      }))
      .filter((r) => r.path.trim().length > 0);
  }
  if (Array.isArray(sf.openThreads)) {
    salientFacts.openThreads = (sf.openThreads as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(sf.abandonedDirections)) {
    salientFacts.abandonedDirections = (sf.abandonedDirections as unknown[]).filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return { summary, salientFacts };
}

/**
 * Run ONE in-pod gateway compaction call over an aging slice, using the agent's
 * credentials. Builds the prompt (slice + recall pages) → calls
 * `${cloud.baseUrl}/api/v1/messages` (Anthropic wire, agent token) with bounded
 * retry → parses the projection JSON. The caller (hook-server) POSTs the result
 * to the cloud `.../segments` endpoint.
 *
 * Non-blocking: invoked fire-and-forget from the post-turn hook; failure is
 * surfaced in `error` (logged) but never stalls the turn. NO cloud LLM — the
 * gateway is only a proxy for this agent-initiated call.
 */
export async function compactSlice(input: CompactionInput, deps: CompactionDependencies): Promise<CompactionResult> {
  const recallBlock = renderRecallContext(input.recallContext);
  const userPrompt = [
    '## Conversation type',
    input.conversationType,
    ...(recallBlock
      ? [
          '',
          '## Existing memory pages that may already hold durable facts from this slice',
          '(device-local recall — for a slice fact that matches one of these, emit a memoryRefs',
          'pointer instead of inlining it into summary)',
          recallBlock,
        ]
      : []),
    '',
    '## Aging slice to project (oldest first)',
    renderSlice(input.slice),
  ].join('\n');

  const model = input.model?.trim();
  if (!model) {
    return { summary: '', salientFacts: {}, error: 'non_extractable:no_execution_model' };
  }

  // memory203/18 R8.2 — standardized stage log so the trace chain can tell "LLM
  // was reached" apart from "skipped upstream".
  process.stdout.write(
    `[memory-trace] stage=compact_llm_called traceId=${input.traceId ?? ''} run=${input.runId ?? ''} model=${model}\n`,
  );

  // In-pod gateway LLM call (agent credentials). Bounded retry on transient failure —
  // reuses extract.ts's callGatewayOnce so the in-pod call path cannot drift.
  let text: string | null = null;
  let lastError: string | null = null;
  let lastStatus = 0;
  let truncated = false;
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  for (let attempt = 1; attempt <= MAX_GATEWAY_ATTEMPTS; attempt++) {
    const r = await callGatewayOnce(deps.cloud, model, COMPACTION_SYSTEM_PROMPT, userPrompt);
    if (!r.error) {
      text = r.text;
      truncated = r.truncated;
      usage = r.usage;
      lastError = null;
      break;
    }
    lastError = r.error;
    lastStatus = r.status;
    if (r.transient && attempt < MAX_GATEWAY_ATTEMPTS) {
      log.warn(`gateway compact transient failure, retrying (${attempt}/${MAX_GATEWAY_ATTEMPTS})`, {
        run: input.runId,
        error: r.error,
      });
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }

  if (lastError) {
    process.stdout.write(
      `[memory-trace] stage=compact_llm_failed(status=${lastStatus}) traceId=${input.traceId ?? ''} run=${input.runId ?? ''}\n`,
    );
    log.error('in-pod gateway compact failed (surfaced, not swallowed)', {
      run: input.runId,
      error: lastError,
    });
    return { summary: '', salientFacts: {}, error: lastError, errorStatus: lastStatus };
  }

  const promptTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
  const completionTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
  const { summary, salientFacts } = parseCompactionResult(text ?? '');
  return { summary, salientFacts, error: null, truncated, promptTokens, completionTokens };
}
