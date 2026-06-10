/**
 * v2.0 §4.6 ContentBlock — frontend mirror of the SDK typing.
 *
 * SoT lives in `sdk/prismer-cloud/typescript/src/types.ts` (D1 deliverable,
 * `evidence/14-d1-sdk-4lang.md`). We re-declare the discriminated union here
 * because the workspace UI does not (and should not) take a runtime dep on
 * the public SDK package — but the wire-shape MUST stay identical, so any
 * change to one side requires the other to track in lockstep.
 *
 * Anthropic-shape `{ kind, ... }` discriminator (NOT OpenAI-shape). Adapters
 * translate to vendor wire format at dispatch time (D3 Hermes/OpenClaw).
 *
 * See `docs/release200/14-messaging-state-machine-reliability.md` §4.6 +
 * `docs/release200/14b-multimodal-input-pipeline.md` for the source-of-truth
 * narrative. Migration 406 adds `im_messages.contentBlocksJson` JSON column.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | (string & {});
export type AudioMime = 'audio/mpeg' | 'audio/wav' | 'audio/webm' | 'audio/ogg' | (string & {});
export type VideoMime = 'video/mp4' | 'video/webm' | 'video/quicktime' | (string & {});

export type ContentBlockText = { kind: 'text'; text: string };
export type ContentBlockImage = { kind: 'image'; assetId: string; mediaType: ImageMime; alt?: string };
export type ContentBlockAudio = { kind: 'audio'; assetId: string; mediaType: AudioMime; durationMs?: number };
export type ContentBlockVideo = {
  kind: 'video';
  assetId: string;
  mediaType: VideoMime;
  durationMs?: number;
  thumbnailUrl?: string;
};
export type ContentBlockFile = { kind: 'file'; assetId: string; mediaType: string; filename: string };
export type ContentBlockToolUse = {
  kind: 'tool_use';
  toolCallId: string;
  toolName: string;
  inputJson: unknown;
};
export type ContentBlockToolResult = {
  kind: 'tool_result';
  toolCallId: string;
  output: ContentBlock[];
};
export type ContentBlockReasoning = { kind: 'reasoning'; text: string; redacted?: boolean };

/** v2.0 §4.6 ContentBlock discriminated union (Anthropic-shape, 8 variants). */
export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockAudio
  | ContentBlockVideo
  | ContentBlockFile
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockReasoning;

/** Type guard — narrow `unknown` to ContentBlock; used by JSON-from-server parsers. */
export function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'text' ||
    kind === 'image' ||
    kind === 'audio' ||
    kind === 'video' ||
    kind === 'file' ||
    kind === 'tool_use' ||
    kind === 'tool_result' ||
    kind === 'reasoning'
  );
}

/**
 * Best-effort parser for `message.contentBlocks` field. Servers may surface
 * the column as: (a) parsed array, (b) JSON-encoded string, (c) NULL. We
 * accept all three so the FE works during the 6-sprint double-write window
 * regardless of which server endpoint serialised the row.
 */
export function parseContentBlocks(raw: unknown): ContentBlock[] | null {
  if (raw == null) return null;
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const out: ContentBlock[] = [];
  for (const item of arr) {
    if (isContentBlock(item)) out.push(item);
  }
  return out.length > 0 ? out : null;
}
