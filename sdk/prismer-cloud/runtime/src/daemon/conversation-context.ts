// release201/30 — XML-wrapped conversation context for sessions-style adapters.
//
// Why this exists:
//   The Hermes /api/sessions/{id}/chat/stream endpoint is stateful: hermes
//   keeps history server-side, so the daemon only sends the current user turn.
//   But "current turn" in a group chat is highly ambiguous — when CEO replies
//   "我是 Prismer 的 CEO ... Winshare (你) 项目发起人 ..." and the user then
//   pings "@engineer @marketer 请两位介绍一下自己", the engineer agent's
//   hermes session sees the **raw text of the @ message** with no signal
//   that the first-person pronouns ("我", "你") inside the prior CEO message
//   belong to CEO. Weaker models echo the pattern → engineer writes
//   "我是 Winshare, 作为项目 Owner". Identity confusion.
//
// Fix: wrap every piece of conversation state in unambiguous XML tags so the
// model can structurally bind first-person to the right participant. Anthropic
// best-practice for structured input (see Claude prompting guide), AutoGen
// and CAMEL papers both use XML for multi-agent context for the same reason.
//
// Output contract:
//   - Single string, suitable as the user `message` content of one hermes
//     /api/sessions chat turn (agnostic of API beyond "takes a text string").
//   - Schema explained to the model via `conversation-context-schema-doc.ts`
//     which the caller MUST prepend to `system_message`.
//   - Tags used: <conversation_context>, <participants>, <p>, <prior_message>,
//     <current_message>. These tags do NOT collide with Hermes reserved tags
//     (<tool_call>, <tool_response>, <tools>, <think>, <thinking>,
//     <reasoning>, <thought>, <REASONING_SCRATCHPAD>) — verified by grep
//     against hermes-agent/agent on 2026-05-31.
//
// Reply-side discipline (enforced by schema doc, NOT by stripping):
//   The agent MUST reply in plain markdown — no XML tags. Sessions API
//   passes the assistant content through verbatim into the chat surface; an
//   XML leak in the reply would render as raw `<tag>` text to humans.

import type { TaskDispatchContextEntry } from '../types/im-events.js';

/**
 * release202/04 §3.3 P3 — default agent-to-agent hop budget. Surfaced to the
 * model in `<execution_context>` as `<hop n=… budget=…/>` so a multi-agent
 * dispatch chain knows how many hops remain before it MUST request human
 * approval (the prior "5 轮" rule was prompt prose with no machine counter).
 * A const so a single edit retunes every trigger path.
 */
export const EXECUTION_CONTEXT_ROUND_BUDGET = 5;

/**
 * release202/04 §3.3 P3 — the `type` discriminant of `<execution_context>`.
 *   - `task-run`     kanban dispatch / agent-to-agent run (no chat room)
 *   - `group-session` multi-party chat @ trigger
 *   - `dm-session`    1:1 direct message
 */
export type ExecutionContextType = 'task-run' | 'group-session' | 'dm-session';

/**
 * release202/04 §3.3.1 — structured execution scope injected at dispatch
 * construction time as the FIRST child of `<conversation_context>`. Every
 * field is composed by the daemon (never guessed by the agent). Fields are
 * emitted only when present; the per-trigger subset (§3.3.2) is the CALLER's
 * responsibility — it threads only the fields relevant to `type` into this
 * object, and the composer faithfully renders whatever it is given.
 *
 * Threading note (per design §3.3): the sessions-dispatcher (which holds
 * `task.metadata` + profile) derives this object and passes it in, rather
 * than the composer re-deriving deep ids it cannot see.
 */
export interface ExecutionContextInput {
  type: ExecutionContextType;
  /** Scope ids — feed `cloud conversation history/search <conversation_id>`. */
  conversationId?: string;
  sessionId?: string;
  /**
   * release202/09 §3.2 — chat-dispatch RUN id. When set, the execution_context
   * emits `<run_id>` (a chat reply closes the turn — no `cloud task` op) and
   * SUPPRESSES `<task_id>`. `taskId` below is reserved for kanban TASKs only,
   * so an agent never sees a run id under a `<task_id>` tag (the 404 incident).
   */
  runId?: string;
  taskId?: string;
  workspaceId?: string;
  projectId?: string;
  /** Agent self-identity — who am I (@handle + role). */
  agentUsername?: string;
  agentImUserId?: string;
  role?: string;
  /** Scoped dirs — deliverables → artifactsDir; intermediates → scratchDir. */
  artifactsDir?: string;
  scratchDir?: string;
  /** ISO8601 with timezone offset — computed at dispatch (kills date hallucination). */
  now?: string;
  /** Effective LLM model + vision capability (non-vision models must not look at images). */
  model?: string;
  supportsVision?: boolean;
  /** Who sent the trigger message this turn + their role. */
  currentTurnSender?: string;
  currentTurnSenderRole?: string;
  /** Agent-to-agent hop counter; budget defaults to EXECUTION_CONTEXT_ROUND_BUDGET. */
  hop?: number;
  roundBudget?: number;
  /** Linked kanban task — the "definition of done" so the agent doesn't drift. */
  linkedTaskTitle?: string;
  linkedTaskStatus?: string;
  /**
   * group-session only: emit a pointer to `cloud team list` for workspace
   * members NOT in this conversation (semi-static, degrade-gracefully — we
   * do not block on assembling a ready member list at dispatch). When true,
   * render `<workspace_contacts hint="use: cloud team list"/>`.
   */
  workspaceContactsHint?: boolean;
}

export interface ConversationContextParticipant {
  imUserId: string;
  username: string;
  displayName: string;
  /** im_users.role: 'agent' | 'human' | 'admin' | 'system' | ... */
  role: string;
  agentType?: string | null;
}

export interface ConversationContextInput {
  conversationType: 'direct' | 'group' | 'unknown';
  conversationId?: string;
  /** Username of the agent receiving this dispatch (profile.agentUsername). */
  youUsername: string;
  /** IM user id of that same agent (profile.agentImUserId). Used as fallback when username collides. */
  youImUserId?: string;
  participants: ConversationContextParticipant[];
  /**
   * Prior chat history WITHOUT the current message. If `currentMessage` is
   * omitted, the most recent priorMessages entry is promoted to current and
   * removed from prior, so callers that only have a single ordered list still
   * produce well-formed XML.
   */
  priorMessages: TaskDispatchContextEntry[];
  /** The dispatch trigger — the message the agent must reply to. */
  currentMessage?: TaskDispatchContextEntry;
  /**
   * 2026-05-31 release201/30 §XML-context P0 — pre-extracted inline content
   * for non-image assets attached to the current message (PDF text, docx
   * text, large code snippets). Sourced from
   * `dispatch.ts.assetResolution.promptBlocks` and rendered inside
   * `<current_message>` as one `<inline_content>` element per block so the
   * agent can read the file body without an extra `prismer.asset.read`
   * round trip. Empty / undefined → no inline_content tag emitted.
   *
   * Replaces the pre-2026-05-31 behaviour where sessions-dispatcher
   * prepended these blocks ABOVE the `<conversation_context>` envelope —
   * structurally disconnected from the message they belonged to.
   */
  currentMessageInlineContent?: string[];
  /**
   * release202/04 §3.3 P3 — structured execution scope (ids + scoped dirs +
   * self-identity + model/vision + hop budget + linked task). Rendered as the
   * FIRST child of `<conversation_context>` so the agent reads its operating
   * environment before any chat history. Omitted entirely when undefined
   * (back-compat: envelope/legacy callers that don't thread it are unchanged).
   */
  executionContext?: ExecutionContextInput;
}

/**
 * Compose a `<conversation_context>` XML block for the dispatch user message.
 *
 * Output ends with a single trailing newline so the caller can prepend asset
 * blocks or other prose without manual padding.
 */
export function composeConversationContextXml(input: ConversationContextInput): string {
  // Determine current vs prior split. Callers may pass an explicit
  // currentMessage; if not, promote the last priorMessages entry.
  let prior = [...input.priorMessages];
  let current: TaskDispatchContextEntry | undefined = input.currentMessage;
  if (!current && prior.length > 0) {
    current = prior[prior.length - 1];
    prior = prior.slice(0, -1);
  }

  // Sort prior ascending by createdAt (defensive — callers may pass either order).
  prior.sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  const lines: string[] = [];
  const typeAttr = attr('type', input.conversationType);
  const convIdAttr = input.conversationId ? ' ' + attr('conversation_id', input.conversationId) : '';
  lines.push(`<conversation_context ${typeAttr}${convIdAttr}>`);

  // release202/04 §3.3 P3 — execution scope as the FIRST child. The agent
  // reads its operating environment (ids / scoped dirs / self-identity /
  // model / hop budget / linked task) before any chat history. Per-trigger
  // field subset (§3.3.2) is decided by the caller; we render whatever is
  // present.
  if (input.executionContext) {
    appendExecutionContext(lines, input.executionContext, '  ');
  }

  // Participants block — always emit when we have any, including DM. Marks
  // the recipient agent with is_you="true" so the model can bind identity.
  if (input.participants.length > 0) {
    lines.push('  <participants>');
    for (const p of input.participants) {
      const youMatch = isYou(p, input.youUsername, input.youImUserId);
      // TODO release201/26 — relation derivation will read ACL/role bindings
      // from im_conversation_acl. Until then: every human participant in a
      // group chat is treated as the owner. Safe in practice (workspace
      // creator + invited humans are both "owners" relative to the agent);
      // refine when ACL lands.
      const isHuman = p.role === 'human' || p.role === 'admin';
      const relationAttr = isHuman && input.conversationType !== 'direct'
        ? ' ' + attr('relation', 'owner')
        : '';
      const youAttr = youMatch ? ' is_you="true"' : '';
      lines.push(
        `    <p ${attr('username', p.username)} ${attr('role', p.role)}${relationAttr}${youAttr}/>`,
      );
    }
    lines.push('  </participants>');
  }

  // Prior history. Each entry gets its own <prior_message> tag so first-person
  // pronouns inside the content are unambiguously bound to that author.
  for (const m of prior) {
    lines.push('');
    lines.push(
      `  <prior_message ${attr('author', m.sender)} ${attr('role', m.senderRole)} ${attr('at', m.createdAt)}>`,
    );
    lines.push(indent(escapeXmlContent(m.content), '    '));
    appendAttachedAssets(lines, m, '    ');
    lines.push('  </prior_message>');
  }

  // Current message — the dispatch trigger.
  if (current) {
    lines.push('');
    lines.push(
      `  <current_message ${attr('author', current.sender)} ${attr('role', current.senderRole)} ${attr('at', current.createdAt)}>`,
    );
    lines.push(indent(escapeXmlContent(current.content), '    '));
    appendAttachedAssets(lines, current, '    ');
    // release201/30 §XML-context P0 — inline content (PDF text, docx text,
    // large snippets) goes ONLY in <current_message>. Prior turns have
    // their original content captured verbatim above; only the active
    // dispatch turn carries pre-extracted bodies via promptBlocks.
    const inlineBlocks = (input.currentMessageInlineContent ?? []).filter(
      (b) => typeof b === 'string' && b.length > 0,
    );
    if (inlineBlocks.length > 0) {
      // Heuristic: if the current message attached exactly one asset, link
      // every inline_content block to that asset_id; otherwise emit
      // attribute-less inline_content (callers wanting per-asset linkage
      // can structure promptBlocks differently in the future).
      const onlyAssetId =
        current.attachedAssets && current.attachedAssets.length === 1
          ? current.attachedAssets[0]!.id
          : current.attachedAssetIds && current.attachedAssetIds.length === 1
            ? current.attachedAssetIds[0]!
            : undefined;
      for (const block of inlineBlocks) {
        const openTag = onlyAssetId
          ? `    <inline_content ${attr('asset_id', onlyAssetId)}>`
          : '    <inline_content>';
        lines.push(openTag);
        lines.push(indent(escapeXmlContent(block), '      '));
        lines.push('    </inline_content>');
      }
    }
    lines.push('  </current_message>');
  }

  lines.push('</conversation_context>');
  lines.push('');
  return lines.join('\n');
}

/**
 * release201/30 §XML-context P0 — render `<attached_assets>` child of a
 * `<prior_message>` / `<current_message>` when the entry has any attached
 * assets. Prefers the enriched `attachedAssets` (mime/filename/sizeBytes
 * surfaced for the model); falls back to id-only `<asset id="..."/>` for
 * back-compat with cloud builds that only ship `attachedAssetIds`.
 * Emits nothing when neither field has entries.
 */
function appendAttachedAssets(
  lines: string[],
  entry: TaskDispatchContextEntry,
  basePrefix: string,
): void {
  const enriched = entry.attachedAssets ?? [];
  const idOnly = entry.attachedAssetIds ?? [];
  // Dedup ids the enriched list already covers so we don't double-emit the
  // same asset (cloud writes both lists for forward-compat).
  const enrichedIds = new Set(enriched.map((a) => a.id));
  const extraIdOnly = idOnly.filter((id) => !enrichedIds.has(id));
  if (enriched.length === 0 && extraIdOnly.length === 0) return;
  const innerPrefix = basePrefix + '  ';
  lines.push(`${basePrefix}<attached_assets>`);
  for (const a of enriched) {
    const parts = [attr('id', a.id)];
    if (a.mime) parts.push(attr('mime', a.mime));
    if (a.filename) parts.push(attr('filename', a.filename));
    if (typeof a.sizeBytes === 'number' && Number.isFinite(a.sizeBytes) && a.sizeBytes >= 0) {
      parts.push(attr('size_bytes', String(a.sizeBytes)));
    }
    lines.push(`${innerPrefix}<asset ${parts.join(' ')}/>`);
  }
  for (const id of extraIdOnly) {
    lines.push(`${innerPrefix}<asset ${attr('id', id)}/>`);
  }
  lines.push(`${basePrefix}</attached_assets>`);
}

/**
 * release202/04 §3.3 P3 — render the `<execution_context type=…>` block.
 *
 * Every child element is emitted ONLY when its source field is present, so
 * the per-trigger subset (§3.3.2) collapses naturally: a task-run caller that
 * never sets `currentTurnSender` simply yields no `<current_turn_sender>` tag.
 * Scalar fields go on dedicated child tags (not the open-tag attribute soup)
 * so each id is independently greppable by the model.
 */
/**
 * release202/08 Phase 1 — render JUST the `<execution_context>` block as a
 * standalone string. The Hermes `/v1/runs` task-run path injects this into
 * `system_prompt` (the run is stateless, so there is no `<conversation_context>`
 * envelope with participants / prior messages — the run's "精简 prompt" is the
 * task spec + this execution_context block). Byte-identical grammar to the
 * sessions path (same `appendExecutionContext`).
 */
export function renderExecutionContextXml(ec: ExecutionContextInput): string {
  const lines: string[] = [];
  appendExecutionContext(lines, ec, '');
  return lines.join('\n');
}

function appendExecutionContext(
  lines: string[],
  ec: ExecutionContextInput,
  basePrefix: string,
): void {
  const inner = basePrefix + '  ';
  lines.push(`${basePrefix}<execution_context ${attr('type', ec.type)}>`);
  const leaf = (tag: string, value: string | undefined): void => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`${inner}<${tag}>${escapeXmlContent(String(value))}</${tag}>`);
  };
  leaf('conversation_id', ec.conversationId);
  leaf('session_id', ec.sessionId);
  // release202/09 §3.2 — a chat-dispatch run surfaces `<run_id>`; a kanban
  // task surfaces `<task_id>`. Never both: emitting a run id under `<task_id>`
  // is exactly the mislabel that led an agent to `cloud task complete <runId>`
  // (→ 404). `runId` wins when present.
  if (ec.runId) {
    leaf('run_id', ec.runId);
  } else {
    leaf('task_id', ec.taskId);
  }
  leaf('workspace_id', ec.workspaceId);
  leaf('project_id', ec.projectId);
  leaf('agent_username', ec.agentUsername);
  leaf('agent_im_user_id', ec.agentImUserId);
  leaf('role', ec.role);
  leaf('artifacts_dir', ec.artifactsDir);
  leaf('scratch_dir', ec.scratchDir);
  leaf('now', ec.now);
  if (ec.model !== undefined && ec.model !== '') {
    const visAttr =
      ec.supportsVision === undefined
        ? ''
        : ' ' + attr('supports_vision', ec.supportsVision ? 'true' : 'false');
    lines.push(`${inner}<model${visAttr}>${escapeXmlContent(ec.model)}</model>`);
  }
  if (ec.currentTurnSender !== undefined && ec.currentTurnSender !== '') {
    const roleAttr =
      ec.currentTurnSenderRole !== undefined && ec.currentTurnSenderRole !== ''
        ? ' ' + attr('role', ec.currentTurnSenderRole)
        : '';
    lines.push(
      `${inner}<current_turn_sender${roleAttr}>${escapeXmlContent(ec.currentTurnSender)}</current_turn_sender>`,
    );
  }
  if (typeof ec.hop === 'number' && Number.isFinite(ec.hop)) {
    const budget =
      typeof ec.roundBudget === 'number' && Number.isFinite(ec.roundBudget)
        ? ec.roundBudget
        : EXECUTION_CONTEXT_ROUND_BUDGET;
    lines.push(`${inner}<hop ${attr('n', String(ec.hop))} ${attr('budget', String(budget))}/>`);
  }
  if (ec.linkedTaskTitle !== undefined && ec.linkedTaskTitle !== '') {
    const statusAttr =
      ec.linkedTaskStatus !== undefined && ec.linkedTaskStatus !== ''
        ? ' ' + attr('status', ec.linkedTaskStatus)
        : '';
    lines.push(
      `${inner}<linked_task${statusAttr}>${escapeXmlContent(ec.linkedTaskTitle)}</linked_task>`,
    );
  }
  if (ec.workspaceContactsHint) {
    lines.push(`${inner}<workspace_contacts ${attr('hint', 'use: cloud team list')}/>`);
  }
  lines.push(`${basePrefix}</execution_context>`);
}

/**
 * XML attribute serialization. Always emits `name="value"` with the value
 * fully escaped. Newlines inside the value are normalized to a single space
 * so the attribute stays on one line.
 */
function attr(name: string, value: string): string {
  const escaped = escapeXmlAttr(String(value));
  return `${name}="${escaped}"`;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ');
}

/**
 * Escape XML special chars inside element content. We DO NOT escape quotes
 * here — quotes are legal in CDATA-style text content; only `<`, `>`, `&`
 * need replacement to avoid the model parsing user text as a tag boundary.
 */
function escapeXmlContent(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Re-indent a (possibly multi-line) chunk by `prefix` on every line.
 * Empty lines stay empty (no padded-blank artifacts).
 */
function indent(s: string, prefix: string): string {
  if (s.length === 0) return prefix;
  return s
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

function isYou(
  p: ConversationContextParticipant,
  youUsername: string,
  youImUserId: string | undefined,
): boolean {
  if (p.username && youUsername && p.username === youUsername) return true;
  if (youImUserId && p.imUserId === youImUserId) return true;
  return false;
}
