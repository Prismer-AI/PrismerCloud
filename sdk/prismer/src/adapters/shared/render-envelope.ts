// release201/26 §7 — shared envelope → neutral message rendering.
//
// The cloud builds a `ConversationContextEnvelope` (L3 input contract) and
// threads it through `metadata.contextEnvelope`. Each adapter implements
// `renderContextEnvelope(envelope)` to translate it into its native wire
// shape — but the *ordering* and *text projection* of the envelope's
// conversational parts is identical across adapters, so it lives here.
//
// This helper produces a neutral `AdapterRenderedContext`:
//   - `messages[]`  : role-tagged turns, already ordered stable → volatile
//                     per §6 ([compressedSegments][quotes][recent][currentPrompt]).
//                     Adapters map each into their own message wire.
//   - `assetInputs` : image/file-as-input AssetRefs (vision-bearing). The
//                     adapter lifts these into image_url / input_image blocks.
//   - `archiveDescriptions[]` : image/file-as-archive — TEXT-ONLY descriptors
//                     (do NOT consume vision tokens, decision D / §5).
//
// The adapter still owns SOUL/role-template + active-skill prompts (those are
// the most cache-stable prefix and predate this envelope); this helper only
// renders the conversational body that sits AFTER them, in §6 order:
//
//   [SOUL / role template]    ← adapter (system prompt / instructions)
//   [active skill prompts]    ← adapter
//   [compressedSegments]      ← here (oldest-known, cache-stable)
//   [identifierIndex]         ← here (Phase 3; near-stable)
//   [recentTaskTrace]         ← here (Phase 3; changes on task complete)
//   [quotes]                  ← here (changes when this turn quotes)
//   [recent[]]                ← here (changes every turn)
//   [<currentPrompt>]         ← here (current turn)
//
// release201/26 §13.2/§13.3 #1 — ADAPTER-CAPABILITY-AWARE rendering.
//
// The §6 ordering above is the STATELESS contract (openclaw /v1/responses,
// claude-code / codex CLI): those upstreams hold NO server-side memory, so the
// cloud must re-ship the whole conversational body (recent + compressedSegments)
// every turn.
//
// Stateful upstreams (Hermes sessions API) keep history in their own durable
// store (state.db) and run native compression + caching. Re-shipping recent +
// compressedSegments there is REDUNDANT (double tokens, gets re-compressed) —
// see §13.4 P1 (PASS: session_id reused, history accumulates server-side).
// BUT a Hermes session only contains turns WE sent since IT was created; an
// existing IM conversation creating its FIRST Hermes session has NO pre-session
// history on the Hermes side → that first turn MUST seed the full body.
//
// Hence the `adapterCapability` + `sessionIsNew` axes:
//
//   stateless                         → FULL (current §6 contract; unchanged)
//   stateful + sessionIsNew=true      → FULL (one-time backfill / seed)
//   stateful + sessionIsNew=false     → THIN (only the IM-domain delta Hermes
//                                       cannot know: quotes / identifierIndex /
//                                       recentTaskTrace + currentPrompt; NO
//                                       recent, NO compressedSegments)
//
// §6 prefix ordering + cache-control breakpoints are N/A for stateful (Hermes
// `system_and_3` injects its own breakpoints on the full server-side messages);
// we only hand it the delta. Image asset urls (assets.inputs) are preserved in
// ALL scenarios (§13.4 P2: Hermes history stores images as `[screenshot]`
// placeholders, so cross-turn image references MUST carry the cloud url).

import type { AssetRef } from '../../types/im-events.js';
import type {
  ConversationContextEnvelope,
  EnvelopeSalientFacts,
  EnvelopeSegment,
} from '../../types/conversation-envelope.js';

/** Neutral message role; adapters map to their own vocabulary. */
export type RenderedRole = 'user' | 'assistant' | 'system';

export interface RenderedMessage {
  role: RenderedRole;
  content: string;
  /**
   * Provenance tag so adapters / observability can tell where a message came
   * from without re-parsing content. Not part of any wire shape.
   */
  origin: 'compressedSegment' | 'identifierIndex' | 'recentTaskTrace' | 'quote' | 'recent' | 'currentPrompt';
}

export interface AdapterRenderedContext {
  /**
   * Conversational turns ordered stable → volatile (§6). Does NOT include the
   * adapter-owned SOUL/role-template/skill prefix. The final entry is always
   * the current-turn prompt (`origin: 'currentPrompt'`) when `currentPrompt`
   * was provided.
   */
  messages: RenderedMessage[];
  /**
   * Vision-bearing assets the agent should perceive as input. Adapters lift
   * these into their multimodal wire (Hermes image_url / OpenClaw input_image).
   */
  assetInputs: AssetRef[];
  /**
   * Archive assets rendered as TEXT descriptions only (decision D). These are
   * appended to the current-turn message text by the adapter; they never
   * become image blocks.
   */
  archiveDescriptions: string[];
}

/**
 * Upstream memory capability (release201/26 §13.2). Decides whether the
 * conversational body is re-shipped every turn.
 *
 *  - `'stateless'` — no server-side memory (openclaw /v1/responses, CLI
 *    adapters). The cloud must re-ship recent + compressedSegments every turn.
 *  - `'stateful'`  — server-side durable history + native compression (Hermes
 *    sessions API). Re-shipping recent/compressed is redundant on session reuse.
 */
export type AdapterCapability = 'stateful' | 'stateless';

export interface RenderEnvelopeOptions {
  /**
   * The current-turn user prompt (unconcatenated). Appended last as the
   * volatile tail (§6). When omitted, no `currentPrompt` message is emitted —
   * useful for stateful upstreams (Hermes sessions) that only want the body.
   */
  currentPrompt?: string;
  /**
   * Map an envelope sender role onto the neutral rendered role. Defaults to:
   * agent → assistant, system → system, human/admin → user.
   */
  roleMapper?: (role: 'human' | 'agent' | 'admin' | 'system') => RenderedRole;
  /**
   * release201/26 §13.2/§13.3 #1 — upstream memory capability. Defaults to
   * `'stateless'` so envelope-unaware / pre-§13 callers keep the full §6
   * contract (zero behaviour change). Stateful + reused session → thin body.
   */
  adapterCapability?: AdapterCapability;
  /**
   * release201/26 §13.4 — only meaningful when `adapterCapability ==='stateful'`.
   *
   *  - `true`  → the Hermes session is being created THIS turn (first dispatch
   *    for this conversation×agent). The upstream has no pre-session history,
   *    so we SEED the full body (recent + compressedSegments + delta).
   *  - `false` → the session already existed and Hermes is replaying its own
   *    accumulated history. We send only the IM-domain delta (quotes /
   *    identifierIndex / recentTaskTrace) + currentPrompt.
   *
   * Ignored for stateless. Defaults to `true` (conservative: when the caller
   * cannot tell whether the session is new, seeding the full body is the safe
   * choice — it never drops history, only risks redundancy).
   */
  sessionIsNew?: boolean;
}

function defaultRoleMapper(role: 'human' | 'agent' | 'admin' | 'system'): RenderedRole {
  if (role === 'agent') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

/** Render a single compressed segment into a system-role recap message. */
function renderSegment(seg: EnvelopeSegment): string {
  const lines: string[] = [];
  lines.push(
    `[Earlier conversation summary #${seg.segmentSeq} · ${seg.coversFromAt} → ${seg.coversToAt} · ${seg.sourceCount} msgs]`,
  );
  if (seg.summary.trim()) lines.push(seg.summary.trim());
  const facts = renderSalientFacts(seg.salientFacts);
  if (facts.length > 0) lines.push(...facts);
  return lines.join('\n');
}

function renderSalientFacts(facts: EnvelopeSalientFacts): string[] {
  const out: string[] = [];
  const list = (label: string, items?: string[]): void => {
    if (items && items.length > 0) {
      out.push(`${label}: ${items.join('; ')}`);
    }
  };
  list('Topics', facts.topicHeadlines);
  list('Decisions', facts.decisions);
  list('Open questions', facts.openQuestions);
  list('Entities', facts.entitiesMentioned);
  list('User preferences', facts.userPreferences);
  list('Agent commitments', facts.agentCommitments);
  list('Discarded directions', facts.discardedDirections);
  // metric-only counts (§5.1) — surfaced as a single compact line so the
  // model knows lifecycle activity happened without inlining event text.
  const metricBits: string[] = [];
  if (typeof facts.taskEventCount === 'number' && facts.taskEventCount > 0) {
    metricBits.push(`${facts.taskEventCount} task events`);
  }
  if (typeof facts.approvalCount === 'number' && facts.approvalCount > 0) {
    metricBits.push(`${facts.approvalCount} approvals`);
  }
  if (metricBits.length > 0) out.push(`Activity: ${metricBits.join(', ')}`);
  return out;
}

/** Render one archive asset into a single text descriptor line (decision D). */
function renderArchiveDescription(ref: AssetRef): string {
  const label = ref.filename ? ` ${ref.filename}` : '';
  const size = typeof ref.sizeBytes === 'number' ? ` ${ref.sizeBytes}B` : '';
  return `[Archived attachment${label} · id=${ref.assetId} · ${ref.mime ?? 'unknown'}${size} · reference only, not loaded into context]`;
}

/**
 * Render an envelope into the neutral {@link AdapterRenderedContext}.
 *
 * Ordering follows §6 strictly (stable → volatile). Empty categories are
 * skipped (no empty messages). Phase-3 categories (identifierIndex /
 * recentTaskTrace) are rendered when present but are undefined in Phase 1.
 *
 * release201/26 §13.2/§13.3 #1 — capability-aware: when `adapterCapability`
 * is `'stateful'` AND `sessionIsNew` is `false`, the recent + compressedSegments
 * bodies are OMITTED (Hermes already holds them server-side); only the IM-domain
 * delta (quotes / identifierIndex / recentTaskTrace) + currentPrompt are
 * rendered. All other combinations render the full §6 body (default behaviour).
 */
export function renderEnvelopeToMessages(
  envelope: ConversationContextEnvelope,
  options: RenderEnvelopeOptions = {},
): AdapterRenderedContext {
  const roleMapper = options.roleMapper ?? defaultRoleMapper;
  const messages: RenderedMessage[] = [];

  // release201/26 §13.2 — decide whether to ship the re-playable body (recent +
  // compressedSegments). Stateful upstreams that are REUSING an existing session
  // already hold this history, so we omit it. Everything else (stateless, or a
  // brand-new stateful session needing a one-time seed) gets the full body.
  //
  // Default `adapterCapability='stateless'` keeps envelope-unaware / pre-§13
  // callers (and the flag-off path, which never reaches here) on the full §6
  // contract — zero behaviour change.
  const capability: AdapterCapability = options.adapterCapability ?? 'stateless';
  // sessionIsNew is only consulted for stateful; default true = conservative
  // seed (never drop history, only risk redundancy — §13.4 landing judgement).
  const sessionIsNew = options.sessionIsNew ?? true;
  const includeReplayableBody = capability === 'stateless' || sessionIsNew;

  // 1. compressedSegments (oldest-known, cache-stable) — each its own system msg
  //    in ascending segmentSeq order.
  //    OMITTED on a reused stateful session: Hermes holds the equivalent history
  //    in state.db and runs its own compression; re-shipping double-charges
  //    tokens and gets compressed again (§13.2 偏差·压缩冲突).
  if (includeReplayableBody) {
    const segments = [...(envelope.compressedSegments ?? [])].sort(
      (a, b) => a.segmentSeq - b.segmentSeq,
    );
    for (const seg of segments) {
      messages.push({ role: 'system', content: renderSegment(seg), origin: 'compressedSegment' });
    }
  }

  // 2. identifierIndex (Phase 3) — near-stable canonical entity table.
  //    IM-domain delta: ALWAYS rendered (Hermes has no message/entity ref
  //    semantics — context_references.py only knows @file/@folder/@git/@url).
  if (envelope.identifierIndex && envelope.identifierIndex.length > 0) {
    const rows = envelope.identifierIndex.map(
      (id) => `- ${id.displayLabel} (${id.kind}) → ${id.canonicalId} (last seen ${id.lastSeenAt})`,
    );
    messages.push({
      role: 'system',
      content: `[Known entities]\n${rows.join('\n')}`,
      origin: 'identifierIndex',
    });
  }

  // 3. recentTaskTrace (Phase 3) — last task's tools/outputs/decisions.
  if (envelope.recentTaskTrace) {
    const t = envelope.recentTaskTrace;
    const parts: string[] = [`[Recent task ${t.taskId}]`];
    if (t.toolsUsed.length > 0) parts.push(`Tools: ${t.toolsUsed.join(', ')}`);
    if (t.outputs.length > 0) parts.push(`Outputs: ${t.outputs.join('; ')}`);
    if (t.decisions.length > 0) parts.push(`Decisions: ${t.decisions.join('; ')}`);
    messages.push({ role: 'system', content: parts.join('\n'), origin: 'recentTaskTrace' });
  }

  // 4. quotes — changes when this turn quotes prior messages.
  for (const q of envelope.quotes ?? []) {
    const deleted = q.sourceDeletedAt ? ` (source deleted at ${q.sourceDeletedAt})` : '';
    messages.push({
      role: 'system',
      content: `[Quoted message from @${q.quotedSender} at ${q.quotedAt}${deleted}]\n${q.snippet}`,
      origin: 'quote',
    });
  }

  // 5. recent[] — oldest first; each raw message is its own role-tagged turn.
  //    OMITTED on a reused stateful session for the same reason as
  //    compressedSegments — Hermes replays its own server-side transcript
  //    (§13.4 P1 PASS: history monotonically accumulates across turns).
  //
  // §13.4 P3 / §13.4a P3C (二跑, 2026-05-30 — CONFIRMED, closed): Hermes
  // compaction (>~50% ctx) rotates its INTERNAL SessionDB id, but that rotation
  // is TRANSPARENT to the api_server client — the SSE `session_id` and the
  // `X-Hermes-Session-Id` header keep reporting the original id we POSTed, and
  // reusing that original id still continues the conversation (anchor recall
  // verified post-compaction). So omitting `recent` on a reused stateful
  // session stays SAFE across a compaction rotation; there is NO need for a
  // "rotation detected → fall back to seed" branch, and none exists here. (The
  // first-turn seed still needs the full body, but that is pre-session history,
  // unrelated to compaction — see `sessionIsNew`, whose semantics are
  // unchanged.)
  if (includeReplayableBody) {
    for (const r of envelope.recent ?? []) {
      messages.push({
        role: roleMapper(r.role),
        content: r.content,
        origin: 'recent',
      });
    }
  }

  // 6. currentPrompt — volatile tail (§6). Only when provided.
  if (typeof options.currentPrompt === 'string' && options.currentPrompt.length > 0) {
    messages.push({ role: 'user', content: options.currentPrompt, origin: 'currentPrompt' });
  }

  // Asset partition (decision D): inputs are vision-bearing; archives are
  // text-only descriptors that NEVER become image blocks.
  //
  // §13.4 P2 — `inputs` (AssetRef) carry their `cdnUrl` here UNCHANGED in
  // EVERY scenario (stateless / stateful-seed / stateful-thin). This is load
  // bearing: Hermes stores cross-turn images as `[screenshot]` placeholders in
  // its history, so even on a reused (thin) session a current-turn image
  // reference must arrive with the cloud url — we never strip it.
  //
  // §13.4a P2 (二跑, decisive) — cross-turn vision is BLIND: a turn quoting an
  // OLDER message that carried an image cannot re-perceive it from Hermes
  // history (placeholder only). So when a quote carries `imageAssetRefs`, the
  // referenced image MUST be re-injected as a real image input THIS turn — the
  // text quote line alone (rendered above) is insufficient. We fold those refs
  // into `assetInputs` so the adapter lifts them into image_url / input_image
  // parts. Done in ALL scenarios (stateful + stateless) — both need the agent
  // to see the image again. Deduped by assetId against the current-turn inputs
  // (and across quotes) so a quoted image that is ALSO a current-turn
  // attachment is not injected twice.
  const assetInputs: AssetRef[] = [...(envelope.assets?.inputs ?? [])];
  const seenAssetIds = new Set(assetInputs.map((a) => a.assetId));
  for (const q of envelope.quotes ?? []) {
    for (const ref of q.imageAssetRefs ?? []) {
      if (seenAssetIds.has(ref.assetId)) continue;
      seenAssetIds.add(ref.assetId);
      assetInputs.push(ref);
    }
  }
  const archiveDescriptions = (envelope.assets?.archives ?? []).map(renderArchiveDescription);

  return { messages, assetInputs, archiveDescriptions };
}
