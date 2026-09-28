// memory203/13 §0.5 — DAEMON-SIDE (in-pod) automatic memory extraction.
//
// GOVERNING RULE (§0.5 + line 101): the LLM call for automatic extraction MUST
// run in the AGENT's own runtime — the daemon inside the agent's pod, using the
// agent's own gateway credentials (PRISMER_BASE_URL + sk-prismer token, already
// injected for the hosted agent). The cloud does ZERO LLM for memory. This is
// the "自动" leg that the cloud `extractMemories` lane (now 410 Gone) used to be;
// it is fundamentally different — the INITIATOR is the agent runtime, the
// gateway is only a proxy. We NEVER route this back through the cloud.
//
// Why daemon-side and not Hermes's native background_review: Hermes spawns the
// review fork with `skip_memory=True`, so our `memory_write` provider tool is
// NOT injected into the review — whatever it "remembers" lands in Hermes's own
// MEMORY.md, never our cloud PKF wiki. So we run the extraction ourselves, here,
// post-turn (fire-and-forget) from `handlePostLlmCall`.
//
// Pipeline (per turn, non-blocking):
//   1. Cheap heuristic filters (skip greetings / tiny turns) so most
//      conversational noise never reaches the LLM extractor.
//   2. Build a RECALL CONTEXT from the LOCAL store — the workspace INDEX
//      (store.loadIndexPage), hub pages, and the nearest pages by search — so
//      the model can decide PLACEMENT against the REAL wiki (extend an existing
//      page / attach under a hub / new leaf).
//   3. Call the LLM gateway DIRECTLY in-pod via the agent's CloudClient
//      (`${cloud.baseUrl}/api/v1/messages`, Anthropic wire, `Bearer cloud.apiKey`)
//      with an extraction prompt → 0-N PKF page(s) with a placement decision.
//   4. Return the pages for the caller (hook-server) to write via the SAME
//      direct-write path `handleWrite` uses (slot.store.write + outbox
//      `memory.page.upsert`), so they sync up and get anti-orphan-anchored on
//      cloud's materialize path.
//
// PKF generation: the daemon is a TS runtime with no cloud `normalizeToPkf`.
// memory203/20 §2.1 (0705-3/4 ruling: record, never limit) — we instruct the
// model to emit RICHNESS-BALANCED PKF: a frontmatter script with a REQUIRED
// one-sentence `description`, `<h2 id>` section anchors, typed `<a rel>`
// links, `<prismer-data>` for tabular data, and asset REFERENCES.
//
// memory211/01 §3 轴A (copy+reference) — the "pointers not copies" doctrine is
// SUPERSEDED. A distilled page is ALLOWED and ENCOURAGED to carry the source's
// near-full content (a reader must be able to work from the page instead of
// re-opening the asset), WITH typed, section-anchored references back to the
// source. Two acceptance rules replace the old volume discipline:
//   • LEXICON COVERAGE — proper nouns, codes/numbers and 中英对照 terms of the
//     source MUST survive into the page (a paraphrase of the source must still
//     be findable by the words the source itself used);
//   • SECTION EDGES — the page's sections relate to each other and to other
//     pages with typed `<a rel>` links anchored at `#section`.
// There is NO length budget — token usage is recorded (usage tokens + truncated
// flag in the stage logs), not constrained; the only token discipline is
// anti-repeat (same-topic pages must extend/attach, never fork a near-duplicate)
// plus the >64K-character sharding trigger the deliverable gate enforces. We run a light
// sanitiser; the cloud materialize path validates/normalises the rest. Markdown
// is also accepted by the daemon store (`handleWrite` normalises), so a model
// that returns markdown still lands a usable page.

import { applyPkfNormalization, detectFormat, parsePkf, parsePkfSource, planPkfNormalization, validatePkf } from '@prismer/pkf';
import type { CloudClient } from '../../auth.js';
import type { MemoryPage } from './types.js';
import { createLogger } from '../../lib/logger.js';
import { filterGatedExtractedPages } from './deliverable-gate.js';

const log = createLogger('memory-extract');

// ── gateway call tuning ─────────────────────────────────────────────────────
/** Bounded retry on transient gateway failure (status 0 / 5xx). 1 retry → 2 attempts total. */
const MAX_GATEWAY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
/**
 * The extraction is a side-channel, but the call must OUTLAST the model's real
 * generation time or it aborts mid-flight and the memory is silently dropped.
 * Measured (test-verified 2026-07-02): a full-doc prompt + max_tokens=4096 on
 * kimi takes 29–44s → the old 30s bound guaranteed abort under real docs.
 * memory203/20 §2.1 raises the generation ceiling to 8192 (record-not-limit),
 * so the timeout scales with it: 120s default keeps the same margin the 60s
 * bound gave 4096 (the abort-drops-memory bug must not silently return with
 * the richer budget). Env-overridable for ops tuning without a daemon rebuild.
 */
const GATEWAY_TIMEOUT_MS = Number(process.env.MEMORY_EXTRACT_TIMEOUT_MS ?? 120_000);
/** Bound on how many candidate PKF pages a single turn may yield. */
// A substantial source document yields a hub + several leaves; 3 was too few and
// forced the model to drop structure. 6 allows one hub + up to 5 organized leaves.
const MAX_PAGES_PER_TURN = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── heuristic filters ───────────────────────────────────────────────────────
const MIN_USER_MSG_CHARS = 80;
const MIN_ASSISTANT_RESP_CHARS = 200;
const GREETING_RE = /^(hi|hello|hey|你好|嗨|谢谢|thanks|thank you|ok|好的|done)[\s.!?。！？]*$/i;
// 2026-08-30（product210/03 同轮遗留）：agent 自我介绍是 role-template 材料，不是
// 会话新知——test 环境 3-agent kickoff（「你们都能干什么？」）让每条自我介绍回复
// 各铸一页角色页。确定性门槛只认「明确的自我介绍形状」（窄匹配，避免误杀正常
// 工作汇报）；用户显式 retention contract（require）仍然放行。
const AGENT_SELF_INTRO_RE = /自我介绍|self[- ]intro/i;
const AGENT_IAM_AT_RE = /(?:我是|this is|i am|i'm)\s*@\S+/i;

/** Narrow "this reply is an agent introducing itself" detector. */
export function isAgentSelfIntro(assistantResponse: string): boolean {
  const head = assistantResponse.slice(0, 160);
  return AGENT_SELF_INTRO_RE.test(head) || AGENT_IAM_AT_RE.test(head);
}

export interface ExtractInput {
  userMessage: string;
  assistantResponse: string;
  conversationHistory: Array<{ role: string; content: string }>;
  agentImUserId: string;
  workspaceId: string;
  roleSlug: string | null;
  conversationId: string | null;
  runId: string;
  sessionMetadata: { model: string; platform: string };
  /**
   * memory203/18 R8.1 — memory-chain trace id, threaded from the post_llm_call
   * body (`extra.trace_id`, stamped by the provider's sync_turn) through
   * extraction into the outbox envelopes. Optional: callers without one get
   * stage logs with an empty traceId rather than a fabricated chain.
   */
  traceId?: string;
  /**
   * memory203/20 §2.1 — asset ids attached to this turn (additive; threaded
   * from the post_llm_call body `extra.attached_asset_ids`, or recovered from
   * the `<attached_assets>` XML in the user message). When present the prompt
   * lists their `prismer://asset/<id>` source URIs so the model can distill the
   * asset INTO the page (copy+reference, memory211/01 轴A) and carry a
   * `rel="derived-from"` reference back to the source. Also drives the
   * `deliverableSource` pairing on the produced pages (轴H gate).
   */
  attachedAssetIds?: string[];
  /**
   * memory211/01 W3 review B1 — source sizes for THIS turn's attached assets, so
   * a produced deliverable page can declare `deliverableSource.sizeBytes` and the
   * G10 sharding trigger actually fires (>64K-character source ⇒ 422
   * sharding_required).
   * Keyed by asset id. Optional: without it the gate still enforces G9, but the
   * sharding leg is unreachable (the exact gap the W2 review flagged).
   */
  attachedAssetSizes?: Record<string, number>;
}

/** A recall page surfaced from the LOCAL store so the model can decide placement. */
export interface RecallContextPage {
  /** Workspace-relative path (the model reuses this to EXTEND an existing page). */
  path: string;
  title: string | null;
  /** 'index' | hub | leaf … — drives the "attach under hub" decision. */
  pageType: string;
  /** A short snippet of the page so the model knows what already exists there. */
  snippet: string;
}

/**
 * Placement decision the model returns for each extracted page. `new` is a
 * legacy ledger value retained for crash-replay compatibility; current model
 * output is normalized to extend/attach/hub before it can be applied.
 */
export type Placement = 'extend' | 'attach' | 'hub' | 'new';

/** A page the in-pod LLM extracted, ready for the caller to write locally. */
export interface ExtractedPage {
  /** Workspace-relative path. For 'extend' this MUST be an existing page's path. */
  path: string;
  title: string;
  /** PKF/markdown body the model authored. */
  content: string;
  /** Placement: extend existing / attach leaf under a hub / new hub. */
  placement: Placement;
  /** 'hub' for placement='hub' (a topic hub); 'leaf' otherwise. */
  pageType: 'leaf' | 'hub';
  /**
   * memory203/16 (audit fix) — for placement='attach', the hub path this leaf nests
   * under. The writer adds a `rel="child-of"` link leaf→hub so the leaf is anchored
   * under its topic hub, not orphaned under INDEX. Absent for hub/new/extend.
   */
  parentHubPath?: string;
  /** Routed visibility: personal preference/feedback → agent-private; project/reference → workspace. */
  visibility: 'workspace' | 'agent:self';
  /**
   * memory211/01 轴H — the deliverable this page was distilled FROM, when the
   * turn carried attached assets and the page references one of them. Derived
   * here (the extraction is the only place that knows the pairing) so the SAME
   * deliverable gate the `memory_write` RPC enforces can run on the main
   * extraction path, and so the `asset:<id>#<hash>` provenance token rides the
   * write. Absent sizeBytes/contentHash today: the daemon knows only the asset
   * id — the >64K-character sharding trigger fires as soon as a caller (W3
   * ingestion pipeline) supplies the source size.
   */
  deliverableSource?: { assetId: string; contentHash?: string; sizeBytes?: number };
}

/**
 * Structured outcome of `extractFromTurn`:
 *   - `error: null`  → genuine outcome (heuristic skip, real zero-extraction, or
 *                      a successful extraction with `pages` populated).
 *   - `error: '...'` → a gateway/LLM failure. `pages` is empty, but this is NOT
 *                      "nothing worth saving" — it is a pipeline failure the
 *                      caller should surface (logged loudly). Never blocks the turn.
 */
export interface ExtractTurnResult {
  pages: ExtractedPage[];
  error: string | null;
  /**
   * memory203/18 W2 — chars of the raw LLM text (0 when the gateway failed).
   * Surfaced by hook-server's `stage=llm_response(pages=N, chars=M)` terminal
   * log so a 0-page outcome is distinguishable from "LLM never answered".
   */
  rawTextChars?: number;
  /**
   * memory203/18 W2 — true when the gateway reported `stop_reason=max_tokens`.
   * THE W1-gate 0-yield root cause: a truncated JSON payload used to
   * JSON.parse-fail into a silent `pages: []`. The parser now salvages the
   * complete page objects out of a truncated array; this flag marks the trace.
   */
  truncated?: boolean;
  /**
   * memory203/18 R9.2 — HTTP status of the FINAL failed gateway attempt when
   * `error` is set (0 = transport failure / cloud_unreachable). The caller
   * (hook-server) classifies limiter-class failures (429 / 504 / 0) into the
   * deferred-retry queue instead of dropping the extraction forever.
   */
  errorStatus?: number;
  /**
   * memory211/01 轴H — deliverable-gate rejection codes for the pages this turn
   * produced and the write path REFUSED (e.g. a distilled page with no
   * derived-from pointer). Present only when ≥1 page was gated out; the kept
   * pages still flow. Surfaced so "LLM answered but the gate refused" is
   * observable instead of a silent under-count.
   */
  gateRejections?: string[];
  /**
   * memory203/20 §2.1 (record, never limit) — gateway-reported usage for the
   * extraction call (`usage.input_tokens` / `usage.output_tokens`). RECORDED in
   * the `llm_response` stage line, never used to constrain the generation.
   */
  /**
   * Wall-clock latency of the extraction call (ms). Surfaced in the
   * llm_response trace so barrier-timeout incidents are self-explanatory.
   */
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** What the in-pod extractor needs: the agent's gateway client + the local recall pages. */
export interface ExtractDependencies {
  /**
   * The daemon's CloudClient — `cloud.baseUrl` is the agent's gateway base
   * (`cloud_api_base`, e.g. https://test.docbrew.cn) and `cloud.apiKey` is the
   * agent's sk-prismer token. We call `${baseUrl}/api/v1/messages` (Anthropic
   * wire) authed with that token: the IN-POD, agent-credentialed gateway path.
   * The cloud does NOT extract — it only proxies this LLM call.
   */
  cloud: CloudClient;
  /** Recall context built from the LOCAL store (INDEX + hubs + nearest pages). */
  recallPages: RecallContextPage[];
  /** Bounded pre-reply cancellation propagated into the gateway request. */
  signal?: AbortSignal;
}

/**
 * Run heuristic filters against the turn. Returns a reason string when the turn
 * should not be extracted; `null` when extraction should proceed.
 */
export function shouldSkipExtraction(input: ExtractInput): string | null {
  const userMsg = input.userMessage?.trim() ?? '';
  const asstMsg = input.assistantResponse?.trim() ?? '';
  if (!userMsg && !asstMsg) return 'empty';
  // product210/03 W2-4 (X4) — a turn carrying attached assets is EXEMPT from
  // the raw-length gates: "传个 pdf 说『记住这个』" is exactly the durable
  // signal the 80/200 gates were eating (the attached document, not the chat
  // prose, is the extraction substrate). Greeting / self-intro / empty gates
  // still apply.
  const hasAttachments = parseAttachedAssetIdsFromTurn(userMsg).length > 0;
  if (!hasAttachments) {
    if (userMsg.length < MIN_USER_MSG_CHARS) return 'too_short_user';
    if (asstMsg.length < MIN_ASSISTANT_RESP_CHARS) return 'too_short_assistant';
  }
  if (GREETING_RE.test(userMsg)) return 'greeting';
  // Agent self-introduction turns (kickoff / "你们都能干什么") are role-template
  // restatements, not durable conversation knowledge — unless the user made an
  // explicit retention contract for this turn.
  if (durabilityIntentFromTurn(userMsg) !== 'require' && isAgentSelfIntro(asstMsg)) {
    return 'agent_self_intro';
  }
  return null;
}

export type DurabilityIntent = 'require' | 'forbid' | 'unspecified';

/**
 * User-authored retention intent is an authority signal, separate from tool
 * routing instructions aimed at the primary agent. Negative intent wins so a
 * phrase such as "durable mechanism, but do not remember this" never writes.
 */
export function durabilityIntentFromTurn(userMessage: string): DurabilityIntent {
  const text = userMessage.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return 'unspecified';
  const forbidden = [
    /\b(?:do not|don't|must not|should not)\s+(?:be\s+)?(?:remember(?:ed)?|retain(?:ed)?|persist(?:ed)?|save(?:d)?(?:\s+(?:to|in)\s+memory)?)/i,
    /\b(?:not|never)\s+(?:for|across|between)\s+(?:future\s+)?sessions?\b/i,
    /(?:不要|不应|无需|不得)(?:被)?(?:记住|记忆|保留|持久化|写入记忆)/,
    /(?:仅限|只用于|只在)本轮/,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) return 'forbid';
  const required = [
    /\b(?:must|should|needs?\s+to)\s+(?:survive|persist)\s+(?:across|between|into|for)?\s*(?:future\s+)?sessions?\b/i,
    /\b(?:remember|retain|persist|save)\b.{0,80}\b(?:across|between|for)\s+(?:future\s+)?sessions?\b/i,
    /\bthis\s+is\s+(?:explicitly\s+)?durable\b/i,
    /(?:跨会话|未来会话|后续会话).{0,32}(?:保留|记住|记忆|持久|复用)|(?:保留|记住|记忆|持久化).{0,32}(?:跨会话|未来会话|后续会话)/,
  ];
  return required.some((pattern) => pattern.test(text)) ? 'require' : 'unspecified';
}

/** Build the turn journal (last few turns + trailing user/assistant) for the prompt. */
function buildJournal(input: ExtractInput): string {
  const lines: string[] = [];
  const history = input.conversationHistory?.slice(-6) ?? [];
  for (const turn of history) {
    if (!turn || typeof turn.content !== 'string') continue;
    const role = turn.role ?? 'user';
    lines.push(`[${role}] ${turn.content}`);
  }
  const last = history[history.length - 1];
  const userAlreadyIn = last && last.role === 'user' && last.content === input.userMessage;
  const asstAlreadyIn = last && last.role === 'assistant' && last.content === input.assistantResponse;
  if (!userAlreadyIn && input.userMessage) lines.push(`[user] ${input.userMessage}`);
  if (!asstAlreadyIn && input.assistantResponse) lines.push(`[assistant] ${input.assistantResponse}`);
  return lines.join('\n\n');
}

/** Render the local recall context (existing wiki shape) into the prompt. */
function renderRecallContext(pages: RecallContextPage[]): string {
  if (pages.length === 0) {
    return '(the workspace memory wiki is currently empty — any new page is a fresh leaf)';
  }
  const lines: string[] = [];
  for (const p of pages) {
    const title = p.title ? ` "${p.title}"` : '';
    lines.push(`- [${p.pageType}] ${p.path}${title}: ${p.snippet}`);
  }
  return lines.join('\n');
}

/**
 * memory203/20 §2.1 — recover attached asset ids from the `<attached_assets>`
 * XML the dispatch composer stamps into the rendered user message
 * (daemon/conversation-context.ts renders `<asset id="…" …/>` children).
 * Fallback for callers that don't thread `extra.attached_asset_ids` explicitly
 * (older provider shells): the ids are already IN the turn text, we just parse
 * them back out. Deduped, order-preserving, bounded.
 */
export function parseAttachedAssetIdsFromTurn(userMessage: string, max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const blockRe = /<attached_assets>([\s\S]*?)<\/attached_assets>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(userMessage)) !== null) {
    const assetRe = /<asset\s[^>]*?\bid="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = assetRe.exec(block[1]!)) !== null) {
      const id = m[1]!.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Render the attached-asset pointer list for the user prompt ('' when none). */
function renderAttachedAssets(assetIds: string[] | undefined): string {
  const ids = (assetIds ?? []).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return '';
  const lines = [
    '',
    '## Attached assets on this turn (SOURCE URIs — carry their knowledge INTO the page, reference the source)',
    ...ids.map((id) => `- prismer://asset/${id}`),
  ];
  return lines.join('\n');
}

/**
 * memory203/20 §2.1 — extraction prompt v2 (richness-balanced PKF).
 * Exported for prompt-shape tests + so the guidance lane (W-C skills) can teach
 * consistently with what the extractor is told.
 */
export const EXTRACTION_SYSTEM_PROMPT = [
  'You maintain a workspace knowledge wiki of durable memory pages in PKF (an HTML superset).',
  'You are given (a) a snippet of an agent conversation turn — which MAY include an attached source',
  'document — and (b) the CURRENT shape of the wiki (its INDEX, the hub pages WITH a note on what each',
  'is about, and the nearest existing pages). Decide whether the input contains DURABLE facts,',
  'decisions, definitions, preferences, or project context worth remembering across sessions. Most',
  'plain chat turns contain NOTHING durable — when in doubt, extract nothing. BUT a substantial source',
  'document usually yields SEVERAL durable pages — extract them and organize them.',
  'AGENT SELF-DESCRIPTIONS ARE NOT DURABLE. An agent introducing itself or restating its',
  'role/capabilities (kickoff turns, "你们都能干什么 / what can you do / who are you",',
  'capability lists, quality habits, deliverable types) is ROLE-TEMPLATE material — the workspace',
  'roster and role templates are the authority for who does what. Do NOT extract a page from an',
  'agent describing itself or another agent\'s role. Only a USER-MADE durable decision about the',
  'team (e.g. "从今以后 engineer 负责所有部署", a hiring/renaming/respawn of responsibilities) is',
  'extractable — and then only THAT decision, never the surrounding capability list.',
  'RETENTION INTENT and TOOL ROUTING are different. A prohibition on the primary agent calling memory tools',
  'is NOT a request to forget: when the user says a rule must survive future sessions, capture that durable',
  'decision through this backstop even if memory_write/memory_curate were forbidden in the primary turn.',
  'Only an explicit user request such as "do not remember this" or "must not be persisted" vetoes retention.',
  '',
  'ORGANIZATION IS THE POINT. The wiki must stay navigable as INDEX → hub → leaf, NEVER a flat pile of',
  'leaves hanging off INDEX. For EACH page pick a PLACEMENT against the real wiki:',
  '  - "extend": the knowledge belongs on an EXISTING page — reuse that page\'s exact path; content is',
  '              the FULL updated page body (you are rewriting it).',
  '  - "attach": a new leaf that belongs under a hub — set "parentHubPath" to that hub\'s path (an',
  '              existing hub, OR a hub you emit in this same batch) and nest your "path" under it',
  '              (e.g. hub "project/desktop" → leaf "project/desktop/sync-protocol").',
  '  - "hub":    a NEW hub page for a topic that has (or will have) multiple leaves. Emit the hub',
  '              FIRST, then "attach" its leaves. When a source document covers one topic, make ONE hub',
  '              for it and attach the extracted facts as leaves under it.',
  '  - A genuinely isolated new topic is still a top-level "hub" page. NEVER emit an unplaced leaf.',
  'BIAS — ONE HUB PER TOPIC, ONE LEAF PER FACET. A topic (e.g. "Project Nimbus") with several DISTINCT',
  'facets (architecture, throughput, security, retention, on-call …) is a HUB with ONE LEAF PER FACET —',
  'NOT one giant page holding every facet, and NOT a separate hub per facet. If a new facet arrives and',
  'the topic so far exists as a lone leaf, promote that topic to a "hub" and "attach" BOTH the existing',
  'facet and the new one as leaves under it. Reuse an existing hub when one fits (that is why you are',
  'shown what each hub is about); never drop related leaves flat under INDEX.',
  'EXTEND vs ATTACH — do NOT confuse them (getting this wrong either forks near-duplicates or crams a',
  'wiki into one page):',
  '  - "extend" ONLY when the incoming content is the SAME fact as an existing page — a restatement,',
  '    correction, or refinement of THAT one fact. Reuse its EXACT path (verbatim from the wiki context,',
  '    never re-derived) and scope the content to the SINGLE <h2 id> section that the new fact refines or',
  '    corrects — the write path splices that one section (append-section / rewrite-section) rather than',
  '    forking a near-dup page; do NOT restate the whole page. Where a link targets one conclusion of',
  '    another page, anchor it at that section: rel-typed href .../<path>.pkf#<section-slug>, not the bare page.',
  '  - "attach" when the incoming content is a DIFFERENT facet of an existing topic — it gets its OWN',
  '    new leaf under the topic hub. NEVER cram a distinct new facet into a sibling leaf via "extend".',
  'ANTI-REPEAT: when the wiki context already shows a page for the incoming fact (especially under the',
  'nearest pages), do NOT emit a near-duplicate new page. But the answer to a DISTINCT new facet of a',
  'known topic is "attach" (its own leaf under the hub) — not "extend" (cram) and not a near-dup. Pages',
  'already shown are known: do not re-extract or restate an existing fact.',
  '',
  'PKF CONTENT — rich, structured pages. Richness is the GOAL: a reader should be able to work from',
  'the memory page INSTEAD of re-reading the raw file or the internet. There is no length budget —',
  'write as much as the source genuinely supports (full tables, exact numbers, definitions, rationale',
  'prose); only repetition is waste.',
  '  - COPY + REFERENCE (the content model): when the input carries a SOURCE DOCUMENT, the page should',
  '    CARRY the source\'s knowledge — its content, tables, numbers, definitions, constraints — not just',
  '    name it. A page that says "see the attached document" is a FAILED extraction: the reader must not',
  '    have to re-open the source to work. Every carried fact keeps a typed, section-anchored reference',
  '    back to where it came from, so the source stays one hop away.',
  '  - LEXICON COVERAGE (self-check before returning): every PROPER NOUN, product/project name, code,',
  '    identifier, version, threshold and NUMBER the source uses must appear VERBATIM in the page — and',
  '    when the source uses a 中英对照 pair (e.g. 金标准 / golden gate, 副本 / replica), keep BOTH forms.',
  '    A reader must be able to reach this page by the words the source itself used, including a Chinese',
  '    term and its English counterpart. If a term is missing from the page, the extraction is incomplete:',
  '    add it, do not paraphrase it away.',
  '  - REQUIRED frontmatter: start each page body with a frontmatter script whose "description" is a',
  '    MANDATORY one-sentence self-summary of the page:',
  '    <script type="application/prismer+json">{"type":"note","title":"<page title>","description":"<one-sentence self-summary>","pkfVersion":"1.1","presentation":{"theme":"knowledge","density":"comfortable","fontProfile":"auto","locale":"<conversation locale>"}}</script>',
  '  - <h1> title, then MULTIPLE semantic <section><h2 id="slug">…</h2>…</section> blocks when the page has distinct facets (context,',
  '    decision, rationale, constraints, metrics …). Sections are the unit of recall — use them.',
  '  - SECTION EDGES (the mesh): author typed cross-links where a REAL relation exists, as',
  '    <a href="prismer://workspace/<ws>/memory/<path>" rel="derived-from|related|supports|contradicts|references">…</a>,',
  '    and ANCHOR them at the section they concern — href ".../<path>.pkf#<section-slug>" — so the edge',
  '    lands on the conclusion, not the whole page. Within one page, relate sibling sections to each',
  '    other when one depends on / supports / contradicts another (same rel vocabulary, anchored href).',
  '    When the input carries a SOURCE DOCUMENT, add a rel="derived-from" link on each page pointing at',
  '    the source. Link related leaves to each other with rel="related". When this fact SUPPORTS or',
  '    CONTRADICTS/supersedes another known page, you MUST author that typed link (rel="supports" /',
  '    rel="contradicts") — those reasoning edges are knowledge, not decoration.',
  '  - HIERARCHY DIRECTION (hard rule): NEVER hand-author rel="child-of" or rel="parent" links in a page',
  '    body. Parent/child membership is expressed SOLELY by placement="attach" + parentHubPath — the',
  '    system then records the leaf→hub edge for you, in the correct direction. A HUB page MUST NOT list,',
  '    link, or point at its children; each child declares ITS hub via parentHubPath and nothing else.',
  '    Authoring child-of yourself — especially on the hub pointing DOWN at its leaves — inverts the tree',
  '    (the edges cycle and EVERY page wrongly becomes a hub). Only the semantic relations above',
  '    (derived-from / related / supports / contradicts / references) may be hand-authored.',
  '  - Tabular / quantitative data MUST stay tabular: emit',
  '    <prismer-data format="csv|json" view="table|bar|line|scatter|area|heatmap">…</prismer-data>',
  '    (pick the view that fits: table for reference data, bar/line/area for trends over a dimension,',
  '    scatter for correlations, heatmap for dense grids). Never flatten a source table into prose.',
  '  - When the turn carries ATTACHED ASSETS (their prismer://asset/<id> source URIs are listed with the',
  '    turn), distill the asset INTO the page (its content, numbers, definitions — see COPY + REFERENCE)',
  '    and reference the source with <a rel="derived-from" href="prismer://asset/<id>">…</a>, anchored at',
  '    the section that carries the material when there is one. When the asset is an IMAGE or CHART,',
  '    reference it INLINE via <figure><img src="prismer://asset/<id>" alt="…"><figcaption>…</figcaption></figure>',
  '    so the renderer shows it in place alongside the prose that interprets it.',
  '  - Factual + durable only; drop ephemeral chatter.',
  '',
  'ONE-SHOT — this is the RICHNESS BAR for a leaf "content" (MATCH it). These forms are FIRST-CLASS and',
  'EXPECTED, not optional: build a page a reader can WORK FROM instead of re-reading the source. Blank',
  'prose with no sections / no data blocks is a FAILED extraction. Example content for a metrics leaf:',
  '<script type="application/prismer+json">{"type":"reference","title":"Service X — Throughput","description":"Service X sustains 50k events/s per shard across 12 shards.","tags":["throughput","capacity"],"pkfVersion":"1.1","presentation":{"theme":"knowledge","density":"comfortable","fontProfile":"auto","locale":"en"}}</script>',
  '<h1>Service X — Throughput</h1>',
  '<section><h2 id="capacity">Capacity</h2>',
  '<p>Each shard sustains <strong>50,000 events/second</strong>; 12 shards peak at ~600k events/s. Related: ',
  '<a href="prismer://workspace/<ws>/memory/service-x/architecture.pkf" rel="related">architecture</a>. ',
  'This measured ceiling ',
  '<a href="prismer://workspace/<ws>/memory/service-x/architecture.pkf#sharding" rel="supports">supports the sharding design throughput target</a> ',
  'and ',
  '<a href="prismer://workspace/<ws>/memory/service-x/capacity-plan-2025.pkf#estimate" rel="contradicts">supersedes the 2025 plan estimate of 30k/s per shard</a>.</p></section>',
  '<section><h2 id="per-shard">Per-shard measurements</h2>',
  '<prismer-data format="csv" view="bar" caption="events/s by shard">shard,events_per_s',
  's1,50000',
  's2,49200',
  's3,51000</prismer-data></section>',
  '<section><h2 id="load-test">Load-test chart</h2>',
  '<figure><img src="prismer://asset/cmxa91k2f000load" alt="throughput vs concurrency load-test chart"><figcaption>Load-test: per-shard throughput plateaus at 50k/s beyond C=200.</figcaption></figure></section>',
  '<section><h2 id="reference">Reference table</h2>',
  '<prismer-data format="csv" view="table">metric,value',
  'sustained_per_shard,50000',
  'shards,12',
  'peak_total,600000</prismer-data></section>',
  'END EXAMPLE. Rules it demonstrates: MULTIPLE <h2 id="slug"> sections (the recall unit); EVERY number',
  'series / table goes in <prismer-data> with a fitting view (table for reference, bar/line/area for',
  'trends) — NEVER prose-flatten a table; a frontmatter description + tags; typed links for REAL',
  'relations — anchored at #<section-slug>, including a #section-anchored rel="supports" and a',
  'rel="contradicts" edge to the pages this fact confirms or supersedes (reasoning edges, not',
  'decoration), and an IMAGE/CHART asset shown inline via <figure><img src="prismer://asset/…"> with a',
  'figcaption that carries the finding. Write as much as the source genuinely supports (no length',
  'budget; only repetition is waste), and keep the source\'s exact terms and numbers (lexicon coverage).',
  '',
  'Return STRICT JSON ONLY (no prose, no code fence):',
  '{"pages":[{"path":"...","title":"...","placement":"extend|attach|hub","parentHubPath":"<hub path, required when placement=attach>","kind":"project|reference|user|feedback","content":"<frontmatter script><h1>...</h1>..."}]}',
  'Emit any "hub" pages BEFORE the "attach" leaves that reference them.',
  'Return {"pages":[]} when nothing is worth saving.',
  'kind: "user"/"feedback" = personal preference / explicit feedback (private to this agent);',
  '"project"/"reference" = project facts / reusable knowledge (shared in the workspace).',
].join('\n');

/**
 * The pre-reply durability lane has a hard 30s budget, so it cannot reuse the
 * open-ended source-document authoring prompt above.  This prompt preserves the
 * minimum useful PKF structure while asking for one high-signal decision page;
 * ordinary asynchronous extraction still uses the full richness prompt and its
 * 8192-token ceiling.
 */
export const REQUIRED_DURABILITY_SYSTEM_PROMPT = [
  'You are the bounded pre-reply durability backstop for a workspace memory wiki.',
  'The user explicitly requires the durable fact or decision in this turn to survive future sessions.',
  'A prohibition on the primary agent calling Memory tools is only a routing constraint, never a retention veto.',
  'Return exactly one durable page. Capture only facts the conversation supports; do not invent detail.',
  'Reuse an existing page path only when the recall context clearly contains the same fact; otherwise create a concise top-level hub path.',
  'The page content must be compact but complete PKF: start with',
  '<script type="application/prismer+json">{"type":"decision","title":"...","description":"one-sentence summary","pkfVersion":"1.1","presentation":{"theme":"knowledge","density":"comfortable","fontProfile":"auto","locale":"<conversation locale>"}}</script>,',
  'then <h1>, at least two <section><h2 id="slug">…</h2>…</section> blocks, and concrete prose covering the decision/fact plus its rationale or constraints.',
  'Use placement="extend" only for the exact same existing fact; otherwise placement="hub".',
  'Use kind="project" for shared project decisions, "reference" for reusable facts, and "user" only for personal preferences.',
  'Never emit executable script/style, Markdown fences, commentary, or a parallel file.',
  'Do not spend tokens explaining or reasoning. Produce the final JSON immediately.',
  'Return STRICT JSON ONLY:',
  '{"pages":[{"path":"...","title":"...","placement":"extend|hub","kind":"project|reference|user","content":"<PKF>"}]}',
].join('\n');

/** Anthropic `/api/v1/messages` request body (Anthropic wire — the gateway translates). */
interface MessagesRequest {
  model: string;
  max_tokens: number;
  thinking?: { type: 'disabled' };
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Anthropic `/api/v1/messages` success envelope (only the fields we read). */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  /** 'end_turn' | 'max_tokens' | … — max_tokens ⇒ the JSON payload is truncated. */
  stop_reason?: string | null;
  /** memory203/20 §2.1 — recorded (never budgeted): gateway token usage. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface RawExtractedPage {
  path?: unknown;
  title?: unknown;
  placement?: unknown;
  parentHubPath?: unknown;
  kind?: unknown;
  content?: unknown;
}

/** True for gateway failures worth a retry: timeout/unreachable (status 0) or 5xx. */
function isTransientGatewayFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * Call the in-pod gateway `${cloud.baseUrl}/api/v1/messages` ONCE (Anthropic wire,
 * agent token). Returns the assistant text or an error. The gateway translates
 * Anthropic-wire → the curated model and proxies on the agent's behalf — the
 * cloud does no extraction, it only relays this agent-initiated LLM call.
 */
export async function callGatewayOnce(
  cloud: CloudClient,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { signal?: AbortSignal; maxTokens?: number; disableThinking?: boolean } = {},
): Promise<{
  text: string | null;
  error: string | null;
  transient: boolean;
  status: number;
  /** memory203/18 W2 — gateway `stop_reason === 'max_tokens'` (payload truncated). */
  truncated: boolean;
  /** memory203/20 §2.1 — recorded token usage (input/output), when the gateway reports it. */
  usage?: { input_tokens?: number; output_tokens?: number };
}> {
  const body: MessagesRequest = {
    model,
    // memory203/20 §2.1 (0705-3/4 ruling: record, never limit) — 8192 default.
    // Richness is the goal; the old 2048 "budget" was the structural scarcity
    // that flattened pages to prose (doc 19 §3.4 ②). Usage tokens + the
    // truncated flag are RECORDED in the llm_response stage line; salvage
    // (parseExtractedPages) stays as the pure fallback for a truncated reply.
    // Env-tunable, paired with MEMORY_EXTRACT_TIMEOUT_MS (120s default) so the
    // longer generation is not aborted mid-flight.
    max_tokens: opts.maxTokens ?? Number(process.env.MEMORY_EXTRACT_MAX_TOKENS ?? 32768),
    ...(opts.disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
  // `/api/v1/messages` is the gateway's Anthropic-wire endpoint (resolveClaudeCode-
  // PrismerProvider confirms the path; CloudClient.urlFor joins baseUrl + path,
  // and request() adds `Authorization: Bearer cloud.apiKey`).
  const res = await cloud.request<MessagesResponse>('POST', '/api/v1/messages', {
    body,
    timeoutMs: GATEWAY_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const msg = `gateway /api/v1/messages failed status=${res.status} code=${res.error?.code ?? '?'} msg=${res.error?.message ?? '?'}`;
    return {
      text: null,
      error: msg,
      transient: isTransientGatewayFailure(res.status),
      status: res.status,
      truncated: false,
    };
  }
  const text = (res.data?.content ?? [])
    .filter((b) => b?.type === 'text' || typeof b?.text === 'string')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  const truncated = res.data?.stop_reason === 'max_tokens';
  const usage = res.data?.usage;
  if (!text)
    return { text: null, error: 'gateway returned no text content', transient: false, status: 200, truncated, usage };
  return { text, error: null, transient: false, status: 200, truncated, usage };
}

/**
 * memory203/18 W2 (0-yield root fix) — salvage complete page objects out of a
 * TRUNCATED `{"pages":[…` payload. When the generation hits `max_tokens` the
 * JSON is cut mid-object and a plain JSON.parse fails — which used to become a
 * silent `[]` ("nothing durable"), the W1-gate's `llm_called 3/3 → extracted
 * 0/3`. We scan the pages array for balanced top-level objects (string-aware,
 * so braces inside `content` strings don't fool the depth counter), parse each
 * individually, and drop only the incomplete tail.
 */
function salvageTruncatedPages(json: string): unknown[] {
  const arrStart = json.search(/"pages"\s*:\s*\[/);
  if (arrStart < 0) return [];
  const start = json.indexOf('[', arrStart);
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < json.length; i++) {
    const ch = json[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(json.slice(objStart, i + 1)));
        } catch {
          /* skip an individually-malformed object */
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break; // array closed cleanly — nothing was truncated after all
    }
  }
  return out;
}

/** Parse the model's JSON (tolerating a stray code fence) into ExtractedPage[]. */
/**
 * memory211/01 W3 review B1 — the declared source carries the source SIZE when
 * the caller could resolve it, which is what arms the G10 sharding trigger. The
 * ingest-task lane gets its size from the upload payload; this is the
 * conversation-driven lane's equivalent (asset metadata index).
 */
function buildDeliverableSource(
  assetId: string,
  sizes: Readonly<Record<string, number>>,
): { assetId: string; sizeBytes?: number } {
  const sizeBytes = sizes[assetId];
  return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
    ? { assetId, sizeBytes }
    : { assetId };
}

function parseExtractedPages(
  raw: string,
  attachedAssetIds: readonly string[],
  attachedAssetSizes: Readonly<Record<string, number>> = {},
): ExtractedPage[] {
  // Strip a leading/trailing ```json … ``` fence if the model added one.
  let json = raw.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1]!.trim();
  // Or grab the first balanced-looking object if the model wrapped it in prose.
  if (!json.startsWith('{')) {
    const objStart = json.indexOf('{');
    if (objStart >= 0) json = json.slice(objStart);
  }
  let parsed: { pages?: unknown };
  try {
    parsed = JSON.parse(json) as { pages?: unknown };
  } catch {
    // Truncated / trailing-garbage payload — salvage the complete page objects
    // instead of silently yielding zero (W2 0-yield fix).
    parsed = { pages: salvageTruncatedPages(json) };
  }
  const rawPages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const out: ExtractedPage[] = [];
  for (const rp of rawPages.slice(0, MAX_PAGES_PER_TURN) as RawExtractedPage[]) {
    const path = typeof rp.path === 'string' ? rp.path.trim() : '';
    const content = typeof rp.content === 'string' ? rp.content : '';
    if (!path || !content.trim()) continue;
    const title = typeof rp.title === 'string' && rp.title.trim() ? rp.title.trim() : path;
    const placement: Placement =
      rp.placement === 'extend' || rp.placement === 'attach' || rp.placement === 'hub' ? rp.placement : 'new';
    const parentHubPath =
      placement === 'attach' && typeof rp.parentHubPath === 'string' && rp.parentHubPath.trim()
        ? rp.parentHubPath.trim()
        : undefined;
    const kind = typeof rp.kind === 'string' ? rp.kind : 'project';
    const visibility: 'workspace' | 'agent:self' = kind === 'user' || kind === 'feedback' ? 'agent:self' : 'workspace';
    out.push({
      path,
      title,
      content: normaliseExtractedPkf(sanitisePkf(content), path),
      placement,
      pageType: placement === 'hub' ? 'hub' : 'leaf',
      parentHubPath,
      visibility,
      // memory211/01 轴H — pair the page with the attached asset it actually
      // references (first match wins; a page referencing none is not a
      // deliverable distillation and stays gate-free).
      ...(attachedAssetIds.find((id) => content.includes(`prismer://asset/${id}`))
        ? {
            deliverableSource: buildDeliverableSource(
              attachedAssetIds.find((id) => content.includes(`prismer://asset/${id}`))!,
              attachedAssetSizes,
            ),
          }
        : {}),
    });
  }
  return out;
}

/**
 * Enforce the wiki's structural contract against the same recall snapshot the
 * model saw. Unknown/legacy `new`, attach-without-a-real-hub, and extend of a
 * path absent from recall all become top-level hubs. This deterministic
 * fallback is intentionally conservative: it preserves the knowledge while
 * preventing a leaf from entering the unclassified bucket.
 */
function enforceExtractedPlacement(
  pages: ExtractedPage[],
  recallPages: RecallContextPage[],
): ExtractedPage[] {
  const knownPaths = new Set(recallPages.map((page) => page.path));
  const hubPaths = new Set([
    ...recallPages.filter((page) => page.pageType === 'hub' || page.pageType === 'index').map((page) => page.path),
    ...pages.filter((page) => page.placement === 'hub' || page.placement === 'new').map((page) => page.path),
  ]);
  return pages.map((page) => {
    if (page.placement === 'hub') return { ...page, pageType: 'hub', parentHubPath: undefined };
    if (page.placement === 'extend' && knownPaths.has(page.path)) return page;
    if (page.placement === 'attach' && page.parentHubPath && hubPaths.has(page.parentHubPath)) return page;
    return { ...page, placement: 'hub', pageType: 'hub', parentHubPath: undefined };
  });
}

/**
 * Light PKF sanitiser. The daemon is a TS runtime with no cloud `normalizeToPkf`,
 * so we only strip the obviously-unsafe constructs (script/style tags) and trim;
 * the cloud materialize path does the authoritative validation/normalisation, and
 * the daemon store accepts markdown too. We DO NOT attempt a full HTML parse here
 * — keeping the daemon output simple and letting cloud validate is the §0.5
 * "daemon emits PKF, cloud materialize validates" contract.
 *
 * memory203/20 §2.1 — PKF's OWN script forms are data, not code, and MUST
 * survive: the frontmatter head `<script type="application/prismer+json">`
 * (now REQUIRED, carries the description) and `<prismer-data>` option children
 * `<script type="application/prismer+data+json">`. Only executable scripts are
 * stripped.
 */
const PKF_DATA_SCRIPT_RE = /^<script[^>]*\btype=["']application\/prismer\+(?:data\+)?json["']/i;

function sanitisePkf(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, (m) => (PKF_DATA_SCRIPT_RE.test(m) ? m : ''))
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim();
}

/**
 * memory211/01 W5 E (F9) — the background leg DETERMINISTICALLY NORMALISES an
 * extracted PKF body whose structure fails validation, instead of landing the
 * raw body and hoping the cloud normalises it later.
 *
 * Why here and not in the write gates: the write gates (`checkDescriptionGate`
 * / `checkPkfProjection`) are deliberately interactive-only — a background leg
 * cannot repair anything, so a 422 would mean silently LOSING the memory (the
 * D4 failure mode). Landing a structurally invalid body is the mirror failure:
 * the page exists but the section anchors / sids it promises are not there. The
 * deterministic normalizer closes both without an LLM and without dropping
 * anything: repair → re-validate → keep the repair only if it actually cured
 * the structure, else keep the sanitised original and LOG LOUDLY (never a
 * silent no-op, and never a dropped page).
 *
 * Markdown bodies short-circuit (the daemon store accepts markdown; the cloud
 * normalizes markdown sources on materialize).
 */
function normaliseExtractedPkf(content: string, path: string): string {
  if (detectFormat(content) !== 'pkf') return content;

  const firstError = (): string | null => {
    try {
      const result = validatePkf(parsePkf(content));
      if (result.structureStatus === 'pass') return null;
      const first = result.diagnostics.find((d) => d.level === 'error');
      return first ? `${first.code}: ${first.message}` : 'structure_fail';
    } catch (err) {
      return `parse_failed: ${(err as Error).message}`;
    }
  };

  const before = firstError();
  if (!before) return content; // already canonical — zero cost for a good body

  try {
    const plan = planPkfNormalization(parsePkfSource(content), { documentId: `memory:${path}` });
    if (plan.isNoOp) {
      log.warn('extracted PKF failed structure validation and has no deterministic repair', { path, before });
      return content;
    }
    const applied = applyPkfNormalization(content, plan);
    if (!applied.ok) {
      log.warn('extracted PKF normalization could not be applied', { path, before, error: applied.error });
      return content;
    }
    const repaired = applied.normalizedSource;
    try {
      const result = validatePkf(parsePkf(repaired));
      if (result.structureStatus === 'pass') {
        log.info('extracted PKF deterministically normalized (background leg, F9)', {
          path,
          before,
          ops: plan.ops.length,
        });
        return repaired;
      }
      const first = result.diagnostics.find((d) => d.level === 'error');
      log.warn('extracted PKF normalization did not cure structure — persisting the sanitised original', {
        path,
        before,
        after: first ? `${first.code}: ${first.message}` : 'structure_fail',
      });
    } catch (err) {
      log.warn('normalized extracted PKF failed to re-parse', { path, error: (err as Error).message });
    }
  } catch (err) {
    log.warn('extracted PKF normalization planning threw', { path, error: (err as Error).message });
  }
  return content;
}

/**
 * Build the recall context the caller passes in: the local INDEX page + hub
 * pages + nearest pages by search. Pure helper so the hook-server (which owns the
 * store handles) can assemble `recallPages` without this module importing the
 * runtime. Returns at most `limit` pages, INDEX/hub first.
 */
export function buildRecallContext(
  indexPage: { path: string; title: string | null; pageType: string } | null,
  indexSnippet: string | null,
  // memory203/16 (audit fix) — hubs carry a `snippet` (what each hub is ABOUT) so
  // the extract model can decide WHICH hub to attach a leaf under. Passing empty
  // snippets (the old behavior) left the model blind to hub topics → it fell back
  // to "new" → orphan leaves under INDEX.
  hubPages: Array<{ path: string; title: string | null; pageType: string; snippet?: string }>,
  nearest: Array<{ path: string; title: string | null; snippet: string }>,
  limit = 12,
): RecallContextPage[] {
  const out: RecallContextPage[] = [];
  const seen = new Set<string>();
  const push = (p: RecallContextPage) => {
    if (seen.has(p.path)) return;
    seen.add(p.path);
    out.push(p);
  };
  if (indexPage) {
    push({
      path: indexPage.path,
      title: indexPage.title,
      pageType: indexPage.pageType,
      snippet: (indexSnippet ?? '').slice(0, 400),
    });
  }
  for (const h of hubPages) {
    push({ path: h.path, title: h.title, pageType: h.pageType, snippet: (h.snippet ?? '').slice(0, 200) });
  }
  for (const n of nearest) {
    push({ path: n.path, title: n.title, pageType: 'leaf', snippet: (n.snippet ?? '').slice(0, 200) });
  }
  return out.slice(0, limit);
}

/**
 * Run automatic extraction for one completed turn, IN-POD via the agent's
 * gateway. Heuristic-skip → build prompt (turn journal + local recall context) →
 * call `${cloud.baseUrl}/api/v1/messages` (agent token) → parse PKF pages. The
 * caller writes the returned pages via the local store + outbox (handleWrite path).
 *
 * Non-blocking: this is invoked fire-and-forget from the post-turn hook; any
 * failure is surfaced in `error` (logged) but never stalls the turn. NO cloud
 * extraction — the LLM call is the agent runtime calling its own gateway.
 */
// ── 轴A · lexicon coverage acceptance (memory211/01 轴A / §6.5 W2 line) ──────
//
// The 轴A acceptance test for a distillation is NOT volume (the old budget) but
// WORD COVERAGE: the page must carry the source's own vocabulary so a paraphrase
// of the source is still findable. Pure + exported: the W2 acceptance gate uses
// it to score the GQ paraphrase questions, and the extractor records the score
// per extraction (RECORDED, never enforced this wave — a hard gate here would
// drop memories, the exact D4 failure this realignment exists to kill).

/** ASCII token with a digit → code / version / measurement (`G10`, `v2`, `400ms`). */
const LEXICON_CODE_RE = /\b[A-Za-z]*\d[A-Za-z0-9]*\b/g;
/** Capitalised word — the proper-noun heuristic (`Kestrel`, `Aurora`, `Verdant`). */
const LEXICON_PROPER_RE = /\b[A-Z][a-zA-Z]{2,}\b/g;
/** ALL-CAPS acronym, ≥2 chars (`PKF`, `ACL`, `SLO`). */
const LEXICON_ACRONYM_RE = /\b[A-Z]{2,}\b/g;
/** CJK run, used bigram-wise so a term is covered by the grams it is made of. */
const LEXICON_CJK_RE = /[㐀-鿿豈-﫿぀-゠ヿ-鿿가-힯]{2,}/g;

/**
 * The vocabulary a distilled page MUST keep: proper nouns, codes/numbers and
 * CJK terms (bigram-granular, matching the retrieval tokenizer). Deterministic
 * and deduplicated, case-insensitively for ASCII.
 */
export function extractLexicon(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (term: string) => {
    const key = term.toLowerCase();
    if (key.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  for (const re of [LEXICON_CODE_RE, LEXICON_PROPER_RE, LEXICON_ACRONYM_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) push(m[0]);
  }
  // CJK: every run contributes its adjacent bigrams, matching the retrieval
  // tokenizer. Deliberately NOT limited to term-shaped runs — a 4-char term is
  // usually embedded in a longer prose run (金门标准 inside
  // 「金门标准是我们的准入规范」), so skipping long runs would drop exactly the
  // terms this metric exists for. The cost is that prose bigrams make the metric
  // STRICTER than a proper-noun-only lexicon; it is recorded, not gated, and the
  // target is read as "the page kept the source's CJK texture".
  for (const run of source.match(LEXICON_CJK_RE) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Fraction of the lexicon present in the page (substring, case-insensitive).
 * 1 when the lexicon is empty — a source with no recoverable vocabulary cannot
 * fail a page.
 */
export function coverage(pageContent: string, lexicon: string[]): number {
  if (lexicon.length === 0) return 1;
  const haystack = pageContent.toLowerCase();
  let hits = 0;
  for (const term of lexicon) if (haystack.includes(term.toLowerCase())) hits += 1;
  return hits / lexicon.length;
}

/** The spec's W2 acceptance line: a distilled page keeps ≥90% of the source lexicon. */
export const LEXICON_COVERAGE_TARGET = 0.9;

export async function extractFromTurn(input: ExtractInput, deps: ExtractDependencies): Promise<ExtractTurnResult> {
  const skip = shouldSkipExtraction(input);
  if (skip) {
    log.debug(`skip: ${skip}`, { run: input.runId });
    return { pages: [], error: null };
  }

  const journal = buildJournal(input);
  if (journal.length < 50) {
    log.debug(`skip: journal too short (${journal.length} chars)`, { run: input.runId });
    return { pages: [], error: null };
  }

  // memory203/20 §2.1 — attached asset POINTERS: explicit ids from the caller,
  // else recovered from the `<attached_assets>` XML already in the turn text.
  const attachedAssetIds =
    input.attachedAssetIds && input.attachedAssetIds.length > 0
      ? input.attachedAssetIds
      : parseAttachedAssetIdsFromTurn(input.userMessage ?? '');

  const assetSection = renderAttachedAssets(attachedAssetIds);
  const durabilityIntent = durabilityIntentFromTurn(input.userMessage ?? '');
  const retentionSection =
    durabilityIntent === 'require'
      ? [
          '## Explicit retention contract: REQUIRED',
          'The user requires this knowledge to survive future sessions. Treat a prohibition on the primary',
          'agent calling Memory tools as a tool-routing constraint, not a retention veto; produce at least one durable page.',
        ]
      : durabilityIntent === 'forbid'
        ? [
            '## Explicit retention contract: FORBIDDEN',
            'The user explicitly forbids retention for this turn; return {"pages":[]} even if durable vocabulary appears.',
          ]
        : [];
  const userPrompt = [
    '## Current workspace memory wiki (decide placement against this)',
    renderRecallContext(deps.recallPages),
    ...(assetSection ? [assetSection] : []),
    ...retentionSection,
    '',
    '## Conversation turn to consider',
    journal,
  ].join('\n');

  const model = input.sessionMetadata?.model?.trim();
  if (!model) {
    return { pages: [], error: 'non_extractable:no_execution_model' };
  }
  const systemPrompt = durabilityIntent === 'require' ? REQUIRED_DURABILITY_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT;
  const maxTokens =
    durabilityIntent === 'require' ? Number(process.env.MEMORY_REQUIRED_EXTRACT_MAX_TOKENS ?? 1536) : undefined;

  // memory203/18 R8.2 — standardized stage log ([memory-trace] prefix + traceId)
  // so the trace chain can tell "LLM was reached" apart from "skipped upstream".
  const extractStartedAt = Date.now();
  process.stdout.write(
    `[memory-trace] stage=llm_called traceId=${input.traceId ?? ''} run=${input.runId} model=${model}\n`,
  );

  // In-pod gateway LLM call (agent credentials). Bounded retry on transient failure.
  let text: string | null = null;
  let lastError: string | null = null;
  let lastStatus = 0;
  let truncated = false;
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  for (let attempt = 1; attempt <= MAX_GATEWAY_ATTEMPTS; attempt++) {
    const r = await callGatewayOnce(deps.cloud, model, systemPrompt, userPrompt, {
      signal: deps.signal,
      ...(maxTokens ? { maxTokens } : {}),
      ...(durabilityIntent === 'require' ? { disableThinking: true } : {}),
    });
    if (deps.signal?.aborted) {
      process.stdout.write(
        `[memory-trace] stage=llm_aborted elapsed_ms=${Date.now() - extractStartedAt} traceId=${input.traceId ?? ''} run=${input.runId}\n`,
      );
      throw deps.signal.reason instanceof Error ? deps.signal.reason : new Error('memory extraction aborted');
    }
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
      log.warn(`gateway extract transient failure, retrying (${attempt}/${MAX_GATEWAY_ATTEMPTS})`, {
        run: input.runId,
        error: r.error,
      });
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }

  if (lastError) {
    // Surface (not swallow) — but this is a side-channel, the turn already completed.
    process.stdout.write(
      `[memory-trace] stage=llm_failed(status=${lastStatus}) traceId=${input.traceId ?? ''} run=${input.runId}\n`,
    );
    log.error('in-pod gateway extract failed (surfaced, not swallowed)', {
      run: input.runId,
      workspace: input.workspaceId,
      error: lastError,
    });
    return { pages: [], error: lastError, errorStatus: lastStatus };
  }

  const extractLatencyMs = Date.now() - extractStartedAt;
  const rawTextChars = (text ?? '').length;
  // memory203/20 §2.1 — record-not-limit: usage tokens surface on the result
  // (hook-server folds them into the llm_response stage line).
  const promptTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
  const completionTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
  if (truncated) {
    // Loud, greppable: the payload was cut at max_tokens — the parser below
    // salvages the complete pages; any incomplete tail page is lost. Root
    // cause of the W1-gate 0-yield (truncation used to parse to a silent []).
    process.stdout.write(
      `[memory-trace] stage=llm_truncated(max_tokens) traceId=${input.traceId ?? ''} run=${input.runId} chars=${rawTextChars}\n`,
    );
  }
  const parsed = parseExtractedPages(text ?? '', attachedAssetIds, input.attachedAssetSizes ?? {});
  const pages = enforceExtractedPlacement(parsed, deps.recallPages);
  // memory211/01 轴H — the SAME deliverable gate the memory_write RPC enforces
  // now runs on the MAIN extraction path (the D3 gap: the pipeline used to be
  // reachable by no gate at all). A page that declares a deliverable source but
  // carries no derived-from pointer to it is dropped LOUDLY (trace + counter)
  // instead of written. Deliberately NOT a retryable error: the model output is
  // deterministic input for this turn, and the page must not silently land.
  const gated = filterGatedExtractedPages(pages);
  for (const rejection of gated.rejected) {
    process.stdout.write(
      `[memory-trace] stage=${rejection.code} extraction path=${rejection.page.path} asset=${rejection.page.deliverableSource?.assetId ?? ''} traceId=${input.traceId ?? ''} run=${input.runId}\n`,
    );
    log.warn('extracted page rejected by the deliverable gate', {
      run: input.runId,
      path: rejection.page.path,
      code: rejection.code,
    });
  }
  if (pages.length > 0 && gated.kept.length === 0) {
    return {
      pages: [],
      error: null,
      rawTextChars,
      truncated,
      promptTokens,
      completionTokens,
      latencyMs: extractLatencyMs,
      gateRejections: gated.rejected.map((r) => r.code),
    };
  }

  // 轴A — record (never gate) the lexicon coverage of what the model produced.
  // The substrate is the turn text itself: that is the only "source" the
  // extractor sees, and its vocabulary is what a later paraphrase must be able
  // to reach.
  const lexicon = extractLexicon(`${input.userMessage ?? ''}\n${input.assistantResponse ?? ''}`);
  if (lexicon.length > 0) {
    const pageText = gated.kept.map((p) => p.content).join('\n');
    const ratio = coverage(pageText, lexicon);
    process.stdout.write(
      `[memory-trace] stage=lexicon_coverage coverage=${ratio.toFixed(2)} terms=${lexicon.length} ` +
        `target=${LEXICON_COVERAGE_TARGET} traceId=${input.traceId ?? ''} run=${input.runId}\n`,
    );
    if (ratio < LEXICON_COVERAGE_TARGET) {
      log.warn('extraction lexicon coverage under target (recorded, not gated)', {
        run: input.runId,
        coverage: Number(ratio.toFixed(3)),
        terms: lexicon.length,
      });
    }
  }

  log.info(`extracted ${gated.kept.length} page(s) in-pod`, {
    run: input.runId,
    workspace: input.workspaceId,
  });
  return {
    pages: gated.kept,
    error: null,
    rawTextChars,
    truncated,
    promptTokens,
    completionTokens,
    latencyMs: extractLatencyMs,
    ...(gated.rejected.length > 0 ? { gateRejections: gated.rejected.map((r) => r.code) } : {}),
  };
}

/** Re-export for callers that surface a written page summary. */
export type { MemoryPage };
