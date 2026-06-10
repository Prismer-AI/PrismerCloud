// release201/25 §7 / release201/26 §7.4 — Claude Code (CLI) envelope renderer.
//
// claude-code is a SPAWN-style interactive adapter — the daemon runs
// `claude --headless` with a single composed prompt string (no structured
// API surface for history). It is STATELESS from our perspective: every
// dispatch reseats the entire conversational body into the prompt text.
//
// CLI-friendly rendering: markdown headings + role labels, NOT XML — the
// CLI adapter has no schema doc layer to teach the agent how to parse XML
// tags, and Anthropic's Claude reads markdown structure reliably out of
// the box.
//
// Asset assets:
//   - image-as-input → markdown link / `![alt](url)` reference; the agent
//     can use its `read` tool to fetch (or rely on the cloud-resolved path)
//   - file-as-input  → markdown link with a "use the read tool" hint
//   - archives → text-only reference per decision D (never become images)
//
// SOUL / role-template / skill prompts remain the dispatcher's job; this
// renderer ONLY produces the conversational body that follows them.

import type {
  ConversationContextEnvelope,
} from '../../types/conversation-envelope.js';
import { renderEnvelopeToMessages } from '../shared/render-envelope.js';

export interface CliRenderedContext {
  /**
   * The conversational body the dispatcher concatenates after the system
   * prefix (SOUL / role-template / skill prompts). Markdown formatted with
   * role-labelled message blocks.
   */
  promptText: string;
  /**
   * TEXT-ONLY descriptors for archive assets (decision D). The dispatcher
   * appends these to the prompt; they never become file uploads.
   */
  archiveDescriptions: string[];
}

export interface CliRenderOptions {
  /**
   * Current-turn user prompt. Becomes the final "## Current message" block.
   */
  currentPrompt: string;
}

/**
 * Render an envelope into the CLI-friendly markdown body.
 *
 * Output layout (omits empty sections):
 *
 *   # Conversation Context (group · conv=...)
 *   Participants: alice (human), ceo (agent, hermes)
 *
 *   ## Prior context (compressed)
 *   ...summary blocks...
 *
 *   ## Known entities
 *   ...
 *
 *   ## Recent task trace
 *   ...
 *
 *   ## Quotes
 *   ...
 *
 *   ## Recent messages
 *   **alice** (2026-05-31 09:00): hello
 *   **ceo** (2026-05-31 09:01): hi
 *
 *   ## Current message — needs your reply
 *   **alice** (2026-05-31 09:02): what next?
 *
 *   ## Attached assets (input)
 *   - image-x.png · image/png · https://cdn... (use the read tool)
 *
 *   ## Archive references
 *   - old-deck.pdf · reference only, not loaded
 */
export function renderContextEnvelope(
  envelope: ConversationContextEnvelope,
  options: CliRenderOptions,
): CliRenderedContext {
  // Stateless capability — CLI agents have no upstream memory; ship full body.
  // currentPrompt deliberately omitted from renderEnvelopeToMessages — we
  // emit the current message manually below with the "needs your reply" header.
  const rendered = renderEnvelopeToMessages(envelope, {
    adapterCapability: 'stateless',
  });

  const lines: string[] = [];

  // Header
  const convDescr = envelope.conversationType === 'direct' ? 'direct' : 'group';
  lines.push(`# Conversation Context (${convDescr} · conv=${envelope.conversationId})`);
  if (envelope.participants.length > 0) {
    const ps = envelope.participants
      .map((p) => {
        const agent = p.agentType ? `, ${p.agentType}` : '';
        return `${p.username} (${p.role}${agent})`;
      })
      .join(', ');
    lines.push(`Participants: ${ps}`);
  }
  lines.push('');

  // Per-origin sections — group rendered messages by their `origin` so the
  // markdown reflects the §7.5 cache-stable order (compressedSegment first,
  // recent last).
  const byOrigin = new Map<string, string[]>();
  for (const m of rendered.messages) {
    const bucket = byOrigin.get(m.origin) ?? [];
    bucket.push(m.content);
    byOrigin.set(m.origin, bucket);
  }

  const section = (title: string, origin: string): void => {
    const items = byOrigin.get(origin);
    if (!items || items.length === 0) return;
    lines.push(`## ${title}`);
    for (const text of items) lines.push(text);
    lines.push('');
  };
  section('Prior context (compressed)', 'compressedSegment');
  section('Known entities', 'identifierIndex');
  section('Recent task trace', 'recentTaskTrace');
  section('Quotes', 'quote');

  // Recent messages — markdown role lines instead of role-tagged turns so
  // a CLI agent reading the prompt sees clear authorship.
  if (envelope.recent.length > 0) {
    lines.push('## Recent messages');
    for (const r of envelope.recent) {
      lines.push(`**${r.sender}** (${r.role}, ${r.createdAt}): ${r.content}`);
    }
    lines.push('');
  }

  // Current message
  lines.push('## Current message — needs your reply');
  const triggerSender =
    envelope.recent.length > 0
      ? envelope.recent[envelope.recent.length - 1]!.sender
      : 'user';
  lines.push(`**${triggerSender}**: ${options.currentPrompt}`);
  lines.push('');

  // Assets — input refs as plain markdown links; archives surface separately.
  if (rendered.assetInputs.length > 0) {
    lines.push('## Attached assets (input)');
    for (const a of rendered.assetInputs) {
      const cdn = (a as { cdnUrl?: string }).cdnUrl;
      const url = cdn ? cdn : `asset://${a.assetId}`;
      const name = a.filename ?? `asset-${a.assetId}`;
      lines.push(`- ${name} · ${a.mime ?? 'unknown'} · ${url}`);
    }
    lines.push('');
  }

  if (rendered.archiveDescriptions.length > 0) {
    lines.push('## Archive references');
    for (const d of rendered.archiveDescriptions) lines.push(`- ${d}`);
    lines.push('');
  }

  return {
    promptText: lines.join('\n'),
    archiveDescriptions: rendered.archiveDescriptions,
  };
}
