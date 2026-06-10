// release201/25 §7 / release201/26 §7.4 — Hermes adapter envelope renderer.
//
// The cloud builds a `ConversationContextEnvelope` (L3 input contract) and
// threads it through `TaskInput.contextEnvelope`. This module turns the
// typed envelope into the Hermes-specific wire shape that
// `sessions-dispatcher.ts` POSTs to `/api/sessions/{id}/chat/stream`:
//
//   • `body` — the user message body. For Hermes this is the same
//     `<conversation_context>` XML wrapper the legacy path already shipped
//     (composeConversationContextXml), but sourced from the typed envelope
//     instead of the flat TaskInput.{participants,contextEntries,currentMessage*}
//     fields. Keeping the XML shape byte-identical to the legacy composer
//     means the 16-case `conversation-context.test.ts` baseline keeps
//     passing AND we don't have to re-tune the schema doc the model already
//     learned to read.
//   • `imageRefs` — vision-bearing AssetRefs to lift into multimodal
//     `image_url` parts (cloud-resolved `assets.inputs` + cross-turn quote
//     image re-injection per §13.4a P2).
//   • `archiveDescriptions` — TEXT-ONLY descriptors for archive assets
//     (decision D); never become vision blocks.
//
// Capability hint (§13.2): Hermes sessions API is STATEFUL — server holds
// history in state.db. On a reused session we should NOT re-ship recent +
// compressedSegments (Hermes already has them). We surface that decision
// here via `renderEnvelopeToMessages`'s capability-aware path; the
// dispatcher tells us whether the session was freshly created this turn
// or reused.

import type { TaskDispatchContextEntry, ResolvedAssetRef, AssetRef } from '../../types/im-events.js';
import type { ConversationContextEnvelope } from '../../types/conversation-envelope.js';
import {
  composeConversationContextXml,
  type ConversationContextParticipant,
  type ExecutionContextInput,
} from '../../daemon/conversation-context.js';
import { renderEnvelopeToMessages, type AdapterCapability } from '../shared/render-envelope.js';

/**
 * Hermes renderer output. Slots into sessions-dispatcher's body / image-parts
 * pipeline 1:1 with what the legacy hand-composed path produced.
 */
export interface HermesRenderedContext {
  /**
   * The `<conversation_context>` XML body the dispatcher passes to
   * `buildMessage` (the multimodal-aware `message` field on the chat stream
   * request). Same shape as the legacy `composeConversationContextXml`
   * output so the schema doc the model already learned remains valid.
   */
  body: string;
  /**
   * Vision-bearing assets to lift into `image_url` parts. Includes the
   * envelope's `assets.inputs` plus any quote `imageAssetRefs` (cross-turn
   * vision re-injection, §13.4a P2). Deduped by assetId so a quoted image
   * that is ALSO a current-turn attachment is not injected twice.
   *
   * The dispatcher already resolves cloud-supplied AssetRefs to
   * `ResolvedAssetRef` (cdnUrl reachability + base64 prefetch); on the
   * envelope path the inputs come in as raw `AssetRef`, so we surface
   * those and let the dispatcher's existing resolver handle reachability.
   */
  imageRefs: AssetRef[];
  /**
   * TEXT-ONLY descriptors for archive assets (decision D). Sessions-dispatcher
   * appends these to the system prompt or current-message text — they never
   * become image blocks.
   */
  archiveDescriptions: string[];
}

export interface HermesRenderOptions {
  /**
   * Trigger message's current-turn text body (typically the unmodified user
   * prompt). Required: the XML wrapper's `<current_message>` tag needs this
   * verbatim so the model sees what the human actually typed.
   */
  currentPrompt: string;
  /**
   * Profile-side identity hint for the `is_you` participant attribute.
   * `youUsername` is the recipient agent's display handle; `youImUserId`
   * disambiguates if usernames collide.
   */
  youUsername: string;
  youImUserId?: string;
  /**
   * Pre-extracted inline content for non-image assets attached to the
   * current message (PDF / docx text). Sessions-dispatcher hands us
   * `task.assetPromptBlocks`; we forward them into the XML composer so
   * they render inside `<current_message>` instead of being prepended
   * above the envelope.
   */
  currentMessageInlineContent?: string[];
  /**
   * release201/26 §13.2 — Hermes is stateful; on session reuse we omit the
   * replayable body (`recent` + `compressedSegments`) and ship only the
   * IM-domain delta (`quotes` / `identifierIndex` / `recentTaskTrace`)
   * plus the current message. Defaults to `true` (full body / safe seed).
   */
  sessionIsNew?: boolean;
  /**
   * release202/04 §3.3 P3 — structured execution scope derived by the
   * sessions-dispatcher (ids + scoped dirs + self-identity + model/vision +
   * hop budget + linked task, already subset per the §3.3.2 trigger matrix).
   * Forwarded verbatim into composeConversationContextXml so the
   * `<execution_context>` block lands on the envelope path too.
   */
  executionContext?: ExecutionContextInput;
}

/**
 * Render an envelope into the Hermes wire shape.
 *
 * Implementation note: composeConversationContextXml is the source of truth
 * for the XML grammar (15-case test baseline). We synthesize its input from
 * the envelope so the XML output is byte-identical to the legacy hand-composed
 * path — same `<conversation_context>` / `<participants>` / `<prior_message>` /
 * `<current_message>` / `<attached_assets>` / `<inline_content>` tags, same
 * is_you / relation / asset attributes.
 *
 * Capability gate (§13.2): we use `renderEnvelopeToMessages`'s capability-aware
 * path to drop `recent` + `compressedSegments` from `<prior_message>` slots on
 * a reused stateful session. Quote `imageAssetRefs` are folded into `imageRefs`
 * in ALL scenarios (the agent must re-perceive cross-turn images).
 */
export function renderContextEnvelope(
  envelope: ConversationContextEnvelope,
  options: HermesRenderOptions,
): HermesRenderedContext {
  const capability: AdapterCapability = 'stateful';
  const sessionIsNew = options.sessionIsNew ?? true;

  // Use the shared renderer for capability-aware body slicing + asset dedup.
  // We discard its `messages[]` projection (Hermes wants XML, not role-tagged
  // role/content turns) but keep its assetInputs/archiveDescriptions outputs
  // which already handle quote image re-injection (§13.4a P2) + dedup.
  const rendered = renderEnvelopeToMessages(envelope, {
    adapterCapability: capability,
    sessionIsNew,
    // No currentPrompt here — we emit our own <current_message> tag below.
  });

  const participants: ConversationContextParticipant[] = envelope.participants.map((p) => ({
    imUserId: p.imUserId,
    username: p.username,
    displayName: p.displayName,
    role: p.role,
    agentType: p.agentType ?? null,
  }));

  // Prior messages: the envelope's `recent` list IS the prior-turn slot, but
  // on a reused stateful session we drop it (Hermes replays its own
  // server-side transcript — §13.4 P1). Map each EnvelopeRecentEntry into
  // the TaskDispatchContextEntry shape composeConversationContextXml expects.
  const priorMessages: TaskDispatchContextEntry[] =
    capability === 'stateful' && !sessionIsNew
      ? []
      : envelope.recent.map((r) => ({
          sender: r.sender,
          senderRole: r.role,
          content: r.content,
          createdAt: r.createdAt,
          // Per-row assetRefs are not populated in Phase 1 (assets live in
          // the envelope's flat `assets.inputs/archives` partition), so we
          // skip `attachedAssets`/`attachedAssetIds` here — the asset-section
          // surfacing happens via the assetInputs / archiveDescriptions
          // outputs the sessions-dispatcher consumes alongside the body.
        }));

  // §13.2 — on a reused stateful session we also omit compressedSegments;
  // sessions-dispatcher receives empty XML for those tags. We render them
  // here when the body is replayable (stateless or fresh session) by
  // injecting them as system-role `<prior_message>` entries with a synthetic
  // "earlier summary" sender so they appear in time order before any
  // recent[] entries.
  if (capability === 'stateful' && !sessionIsNew) {
    // nothing to do — replayable body already filtered out above
  } else {
    const segments = [...(envelope.compressedSegments ?? [])].sort(
      (a, b) => a.segmentSeq - b.segmentSeq,
    );
    if (segments.length > 0) {
      const segPriors: TaskDispatchContextEntry[] = segments.map((seg) => ({
        sender: 'compressed_summary',
        senderRole: 'system',
        content:
          `[Earlier conversation summary #${seg.segmentSeq} · ${seg.coversFromAt} → ${seg.coversToAt} · ${seg.sourceCount} msgs]\n` +
          (seg.summary || ''),
        // Use coversFromAt so the synthetic entry sorts ahead of any recent
        // message it covers; composeConversationContextXml sorts by parsed
        // createdAt internally.
        createdAt: seg.coversFromAt,
      }));
      // Segments first (oldest covered range first), then real recent[].
      priorMessages.unshift(...segPriors);
    }
  }

  // Quote snippets — surface as system-role <prior_message> rows so the
  // model sees the quoted text linked to its author. Quote image refs are
  // already lifted into imageRefs below (deduped) so the agent re-perceives
  // the cross-turn image when present.
  for (const q of envelope.quotes ?? []) {
    priorMessages.push({
      sender: q.quotedSender,
      senderRole: 'human',
      content: `[Quote · ref=${q.quotedMessageId}]\n${q.snippet}`,
      createdAt: q.quotedAt,
    });
  }

  // Current message — what the trigger sender typed THIS turn.
  const currentMessage: TaskDispatchContextEntry = {
    sender:
      envelope.recent.length > 0
        ? envelope.recent[envelope.recent.length - 1]!.sender
        : options.youUsername,
    senderRole: 'human',
    content: options.currentPrompt,
    createdAt: new Date().toISOString(),
  };

  const xml = composeConversationContextXml({
    conversationType: envelope.conversationType === 'direct' ? 'direct' : 'group',
    conversationId: envelope.conversationId,
    youUsername: options.youUsername,
    ...(options.youImUserId ? { youImUserId: options.youImUserId } : {}),
    participants,
    priorMessages,
    currentMessage,
    ...(options.currentMessageInlineContent && options.currentMessageInlineContent.length > 0
      ? { currentMessageInlineContent: options.currentMessageInlineContent }
      : {}),
    ...(options.executionContext ? { executionContext: options.executionContext } : {}),
  });

  return {
    body: xml,
    imageRefs: rendered.assetInputs,
    archiveDescriptions: rendered.archiveDescriptions,
  };
}

/**
 * Resolved-ref variant for callers that already ran the dispatcher's
 * `resolveAssetRefs` pass. Returns the same XML body + the resolved image
 * refs verbatim (sessions-dispatcher then hands those to `buildMessage`).
 */
export function attachResolvedImageRefs(
  rendered: HermesRenderedContext,
  resolved: ResolvedAssetRef[],
): { body: string; imageRefs: ResolvedAssetRef[]; archiveDescriptions: string[] } {
  // Filter resolved set to those that match our envelope-derived imageRefs by
  // assetId (cross-turn image re-injection includes quote refs not in the
  // dispatcher's `assetRefs`; those have no resolution yet — sessions-dispatcher
  // falls back to cdnUrl-from-AssetRef inside buildMessage when needed).
  const envIds = new Set(rendered.imageRefs.map((r) => r.assetId));
  const filtered = resolved.filter((r) => envIds.has(r.assetId) && r.mime?.startsWith('image/'));
  return {
    body: rendered.body,
    imageRefs: filtered,
    archiveDescriptions: rendered.archiveDescriptions,
  };
}
