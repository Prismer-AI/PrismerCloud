// release201/25 §7 / release201/26 §7.4 — OpenClaw adapter envelope renderer.
//
// OpenClaw's `/v1/responses` endpoint accepts a structured `input` array of
// `{type: 'message', role, content}` items where each `content` is itself
// an array of `input_text` / `input_image` / `input_file` blocks (OpenAI
// Responses API shape). It is STATELESS — no server-side memory — so we
// must re-ship the full conversational body every turn (§13.2 default).
//
// Phase 0 strategy (per task spec §F):
//   - render the envelope via the shared neutral renderer
//     (compressedSegments → quotes → recent → currentPrompt order)
//   - project each rendered message into a single OpenAI Responses
//     `{type:'message', role, content:[{type:'input_text', text}]}` item
//   - image-bearing assets become `input_image` content parts on the
//     CURRENT-turn message (the final entry); non-image assets become
//     `input_file` parts on the same item
//   - `instructions` (top-level OpenClaw field) carries the system prompt
//     unchanged — the adapter still injects role-template + skill prompts
//     via that path
//
// We intentionally do NOT try to map historical assets onto historical
// messages (the envelope's `recent[]` carries text-only contents in Phase 1).
// Cross-turn images surface via the current-turn input_image parts the same
// way Hermes handles them — verified safe per §13.4a P2.

import type { TaskInput } from '../contract.js';
import type {
  ConversationContextEnvelope,
} from '../../types/conversation-envelope.js';
import { renderEnvelopeToMessages, type RenderedMessage } from '../shared/render-envelope.js';

/** One item of OpenClaw `/v1/responses` `input[]`. */
export interface OpenClawInputItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: Array<OpenClawContentBlock>;
}

export type OpenClawContentBlock =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; source: OpenClawAssetSource }
  | { type: 'input_file'; source: OpenClawAssetSource };

export type OpenClawAssetSource =
  | { type: 'url'; url: string; filename?: string }
  | { type: 'base64'; mime: string; data: string; filename?: string };

export interface OpenClawRenderedContext {
  /**
   * `/v1/responses` `input` array, ordered stable → volatile (§7.5). The
   * dispatcher passes this through verbatim; OpenClaw threads each message
   * into the model's conversation buffer.
   */
  input: OpenClawInputItem[];
  /**
   * TEXT-ONLY descriptors for archive assets (decision D). Adapter prepends
   * these to the current-turn message's `input_text` block.
   */
  archiveDescriptions: string[];
}

export interface OpenClawRenderOptions {
  /**
   * Current-turn user prompt (typically `task.currentPrompt ?? task.prompt`).
   * Becomes the final `input` item's `input_text`; image / file assets are
   * attached to this same item.
   */
  currentPrompt: string;
}

/**
 * Phase 0 renderer. Produces a `/v1/responses` input array sourced from the
 * envelope.
 *
 * Asset attachment policy:
 *   - `envelope.assets.inputs` → `input_image` (image/*) or `input_file`
 *     (everything else) blocks attached to the CURRENT-turn message
 *   - `envelope.assets.archives` → TEXT descriptors in `archiveDescriptions`
 *     (caller decides whether to render them as text blocks or skip)
 *
 * Quoted image refs (§13.4a P2): folded into the current-turn `input_image`
 * blocks via the shared renderer's dedup pass (no double injection).
 */
export function renderContextEnvelope(
  envelope: ConversationContextEnvelope,
  options: OpenClawRenderOptions,
): OpenClawRenderedContext {
  const rendered = renderEnvelopeToMessages(envelope, {
    adapterCapability: 'stateless', // OpenClaw /v1/responses holds no session memory
    currentPrompt: options.currentPrompt,
  });

  const input: OpenClawInputItem[] = rendered.messages.map((m: RenderedMessage) => ({
    type: 'message',
    role: m.role,
    content: [{ type: 'input_text', text: m.content }],
  }));

  // Attach inputs (images + files) onto the CURRENT-turn message — that is
  // the final `currentPrompt` item the shared renderer emitted. If the
  // current-turn item is absent (no currentPrompt) we synthesize an empty
  // user item so the assets don't get orphaned.
  if (input.length === 0 || input[input.length - 1]!.role !== 'user') {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] });
  }
  const currentItem = input[input.length - 1]!;
  for (const ref of rendered.assetInputs) {
    const source = pickResponsesSource(ref);
    if (!source) {
      currentItem.content.push({
        type: 'input_text',
        text: `[attachment id=${ref.assetId} mime=${ref.mime ?? 'unknown'} unavailable: no cdn url, no inline bytes]`,
      });
      continue;
    }
    const isImage = ref.kind === 'image' || (ref.mime?.startsWith('image/') ?? false);
    if (isImage) {
      currentItem.content.push({ type: 'input_image', source });
    } else {
      currentItem.content.push({ type: 'input_file', source });
    }
  }

  return {
    input,
    archiveDescriptions: rendered.archiveDescriptions,
  };
}

/**
 * Best-effort source picker mirroring openclaw/index.ts. Prefers cdnUrl when
 * present (the dispatcher resolves these); falls back to base64 inline.
 * Returns null when neither is available so the caller can surface a clear
 * error to the model.
 */
function pickResponsesSource(
  ref: ConversationContextEnvelope['assets']['inputs'][number],
): OpenClawAssetSource | null {
  // The envelope's AssetRef wire shape may carry cdnUrl (envelope-side
  // re-attachment per §13.4a P2). For Phase 0 we honour it directly; the
  // dispatcher's resolved-ref path is a future enhancement.
  const cdn = (ref as { cdnUrl?: string }).cdnUrl;
  if (cdn) {
    const out: OpenClawAssetSource = { type: 'url', url: cdn };
    if (ref.filename) out.filename = ref.filename;
    return out;
  }
  // Base64 fallback not surfaced on raw AssetRef; sessions-dispatcher's
  // resolver runs separately. Phase 0 returns null to keep the typing tight.
  return null;
}

/**
 * Convenience helper for the OpenClaw dispatcher: derive the renderer's
 * `currentPrompt` from the dispatcher's `TaskInput`.
 */
export function currentPromptOf(task: Pick<TaskInput, 'currentPrompt' | 'prompt'>): string {
  return task.currentPrompt ?? task.prompt ?? '';
}
