import { parsePkf, validatePkf } from '@prismer/pkf';
import type { AgentDispatchReplyPkfContentBlock } from '../wire/dispatch-types.js';

export const INLINE_PKF_START = '<!-- prismer-pkf:inline:start -->';
export const INLINE_PKF_END = '<!-- prismer-pkf:inline:end -->';

// The server caps the complete ContentBlock JSON payload at 32 KiB. Apply the
// same cap here so an extracted block cannot be rejected later in transport.
const MAX_INLINE_CONTENT_BLOCK_BYTES = 32_768;

export interface InlinePkfReply {
  replyText: string;
  contentBlocks?: AgentDispatchReplyPkfContentBlock[];
}

/**
 * Build the single inline-PKF ContentBlock from a validated PKF source.
 * Shared by BOTH inline carriers so their semantics cannot drift:
 *   - the sentinel extraction path (agent pasted the wire markers), and
 *   - the `pkf_reply_inline` tool path (pkf209 — the daemon re-reads the
 *     validated file at dispatch terminal state).
 * Returns null for any invalid PKF, non-v1.1 schema, or over-budget block.
 */
export function inlinePkfContentBlockFromSource(
  source: string,
): AgentDispatchReplyPkfContentBlock[] | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_INLINE_CONTENT_BLOCK_BYTES) return null;

  let title: string | undefined;
  try {
    const parsed = parsePkf(trimmed);
    if (
      !parsed.frontmatter ||
      parsed.schemaVersion !== '1.1' ||
      validatePkf(parsed).structureStatus !== 'pass'
    ) {
      return null;
    }
    title = parsed.frontmatter.title?.trim() || undefined;
  } catch {
    return null;
  }

  const contentBlocks: AgentDispatchReplyPkfContentBlock[] = [
    { kind: 'pkf', source: trimmed, ...(title ? { title } : {}) },
  ];
  if (Buffer.byteLength(JSON.stringify(contentBlocks), 'utf8') > MAX_INLINE_CONTENT_BLOCK_BYTES) {
    return null;
  }
  return contentBlocks;
}

/**
 * product210/03 W1-3 — chat-line fallback carrier. The task-line terminal
 * state (dispatch.ts) resolves BOTH inline carriers (sentinel +
 * `pkf_reply_inline` marker) into validated contentBlocks and strips the
 * sentinel bytes from the output text, so the chat line's own sentinel
 * re-extraction cannot see them. The daemon bridge therefore hands the
 * validated blocks across as `metadata.inlineContentBlocks`. This helper
 * re-validates every carried source through the SAME inline-carrier
 * semantics before use — the carrier is never trusted (same fail-closed rule
 * as the marker file). Returns null when nothing valid survives.
 */
export function inlinePkfContentBlocksFromCarriedMetadata(
  metadata: Record<string, unknown> | undefined,
): AgentDispatchReplyPkfContentBlock[] | null {
  const carried = metadata?.inlineContentBlocks;
  if (!Array.isArray(carried)) return null;
  const blocks: AgentDispatchReplyPkfContentBlock[] = [];
  for (const item of carried) {
    if (!item || typeof item !== 'object') continue;
    const source = (item as { source?: unknown }).source;
    if (typeof source !== 'string') continue;
    const rebuilt = inlinePkfContentBlockFromSource(source);
    if (rebuilt) blocks.push(...rebuilt);
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * Extract the single inline-PKF carrier emitted by an agent final response.
 * Any malformed carrier, invalid PKF, duplicate sentinel, or over-budget block
 * is returned verbatim as plain text for backwards-compatible fail-closed
 * behaviour.
 */
export function extractInlinePkfReply(output: string): InlinePkfReply {
  const start = output.indexOf(INLINE_PKF_START);
  const end = output.indexOf(INLINE_PKF_END);
  if (
    start < 0 ||
    end < start + INLINE_PKF_START.length ||
    output.indexOf(INLINE_PKF_START, start + INLINE_PKF_START.length) >= 0 ||
    output.indexOf(INLINE_PKF_END, end + INLINE_PKF_END.length) >= 0
  ) {
    return { replyText: output };
  }

  const contentBlocks = inlinePkfContentBlockFromSource(
    output.slice(start + INLINE_PKF_START.length, end),
  );
  if (!contentBlocks) return { replyText: output };

  const before = output.slice(0, start).trimEnd();
  const after = output.slice(end + INLINE_PKF_END.length).trimStart();
  const replyText = before && after ? `${before}\n\n${after}` : before || after;
  return { replyText, contentBlocks };
}
