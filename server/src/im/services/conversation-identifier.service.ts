/**
 * Prismer IM — Conversation Identifier-Index Service (release201/26 Phase 3)
 *
 * Auto-populates `IMConversationIdentifierIndex` from each newly-persisted
 * message so the L3 envelope (`buildEnvelope.identifierIndex`) and the agent
 * `resolve-identifier` endpoint can map人话 aliases ("上次那个 layout",
 * "@eng") back to a canonical id.
 *
 * Ground truth: docs/release201/26-conversational-memory-plan.md
 *   - §4 / schema IMConversationIdentifierIndex field contract
 *   - §8 Phase 3 — "IdentifierIndex 在 message persist hook 自动 populate"
 *   - §5 envelope.identifierIndex { kind, canonicalId, displayLabel, lastSeenAt }
 *
 * Design invariants:
 *   - Invoked fire-and-forget AFTER the message is persisted (mirrors the
 *     Phase 2 compaction trigger). NEVER throws, NEVER blocks send().
 *   - Conservative extraction: four kinds only (task / asset / agent / url).
 *     Over-extraction pollutes the index; we'd rather miss than guess.
 *   - Upsert keyed on `(conversationId, identifierKind, canonicalId)` (schema
 *     unique). Each sighting bumps `lastReferencedMessageId` and merges any new
 *     human alias into `aliasesJson`.
 */

import prisma from '../db';
import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('ConversationIdentifier');

export type IdentifierKind = 'task' | 'asset' | 'agent' | 'url';

export interface ExtractedIdentifier {
  kind: IdentifierKind;
  canonicalId: string;
  /** Human-facing alias from the message (mention handle, label, raw token). */
  alias?: string;
  displayLabel?: string;
}

// ─── Extraction patterns (conservative — four kinds only) ─────────────────────
//
// Repo id shapes (grep-verified): cuid-style ids are `c` + base36
// (`cmp…`, `clx…`), 24-30 chars. We do NOT try to canonicalise free CamelCase
// words (that's the compaction extractive vocab's job, not a canonical index).

// `task:<id>` explicit ref, or a bare cuid that a `@mention`/metadata marks as a
// task. We only treat the explicit `task:` form as a task to stay conservative.
const TASK_REF = /\btask:([a-z0-9][a-z0-9_-]{6,})\b/gi;
// `asset:<id>` / `assetId=<id>` explicit refs.
const ASSET_REF = /\b(?:asset:|assetId[=:])([a-z0-9][a-z0-9_-]{6,})\b/gi;
// @mention handle (agent or person). Canonical id is resolved from the handle
// against conversation participants (below); the raw handle is kept as alias.
const MENTION = /(?:^|[\s(])@([a-zA-Z0-9][\w.-]{1,63})/g;
// http(s) URLs.
const URL_RE = /\bhttps?:\/\/[^\s<>")]+/gi;

function parseMetadata(meta: unknown): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta as Record<string, unknown>;
  if (typeof meta === 'string') {
    try {
      const p = JSON.parse(meta);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Pure extraction from message content + metadata. Exposed for unit tests.
 * `participantsByHandle` maps lowercased username → { id, role, displayName }
 * so @mentions resolve to a canonical imUserId + agent/person kind.
 */
export function extractIdentifiers(
  content: string,
  metadata: unknown,
  participantsByHandle?: Map<string, { id: string; role: string; displayName: string }>,
): ExtractedIdentifier[] {
  const out: ExtractedIdentifier[] = [];
  const seen = new Set<string>();
  const text = content ?? '';

  const push = (e: ExtractedIdentifier) => {
    const key = `${e.kind}:${e.canonicalId}`;
    if (seen.has(key)) {
      // merge alias onto the already-collected entry
      const existing = out.find((o) => `${o.kind}:${o.canonicalId}` === key);
      if (existing && e.alias && !existing.alias) existing.alias = e.alias;
      return;
    }
    seen.add(key);
    out.push(e);
  };

  for (const m of text.matchAll(TASK_REF)) {
    push({ kind: 'task', canonicalId: m[1], alias: m[0], displayLabel: m[0] });
  }
  for (const m of text.matchAll(ASSET_REF)) {
    push({ kind: 'asset', canonicalId: m[1], alias: m[0], displayLabel: m[0] });
  }
  for (const m of text.matchAll(URL_RE)) {
    // strip trailing punctuation a URL regex commonly over-captures
    const url = m[0].replace(/[.,;:!?]+$/, '');
    push({ kind: 'url', canonicalId: url, displayLabel: url });
  }
  for (const m of text.matchAll(MENTION)) {
    const handle = m[1];
    const resolved = participantsByHandle?.get(handle.toLowerCase());
    if (resolved) {
      // Both @-mentioned agents AND people are captured under the 'agent' kind
      // (the spec asks for "被 @ 的 agent/人" — a single referenced-participant
      // index). canonicalId is the resolved imUserId so repeated mentions of the
      // same participant coalesce regardless of handle casing.
      push({
        kind: 'agent',
        canonicalId: resolved.id,
        alias: `@${handle}`,
        displayLabel: resolved.displayName || handle,
      });
    } else {
      // Unresolved handle: keep the handle string as canonicalId so repeated
      // references coalesce; alias is the same handle.
      push({ kind: 'agent', canonicalId: `@${handle}`, alias: `@${handle}`, displayLabel: `@${handle}` });
    }
  }

  // metadata.quotes / metadata.assetIds — explicit structured asset refs.
  const meta = parseMetadata(metadata);
  const metaAssets = meta.assetIds;
  if (Array.isArray(metaAssets)) {
    for (const a of metaAssets) {
      if (typeof a === 'string' && a) push({ kind: 'asset', canonicalId: a, displayLabel: a });
    }
  }

  return out;
}

export class ConversationIdentifierService {
  /**
   * Populate the identifier index from a just-persisted message. Fire-and-forget
   * safe: NEVER throws.
   */
  async populateFromMessage(input: {
    id: string;
    conversationId: string;
    content: string;
    metadata?: unknown;
  }): Promise<void> {
    try {
      // Resolve @mention handles against the conversation's active participants
      // so an `@eng` mention indexes the agent's imUserId, not the raw handle.
      let byHandle: Map<string, { id: string; role: string; displayName: string }> | undefined;
      if (input.content && input.content.includes('@')) {
        const parts = (await prisma.iMParticipant.findMany({
          where: { conversationId: input.conversationId, leftAt: null },
          include: { imUser: { select: { id: true, username: true, role: true, displayName: true } } },
        })) as Array<{
          imUser: { id: string; username: string; role: string; displayName: string } | null;
        }>;
        byHandle = new Map();
        for (const p of parts) {
          if (p.imUser?.username) {
            byHandle.set(p.imUser.username.toLowerCase(), {
              id: p.imUser.id,
              role: p.imUser.role,
              displayName: p.imUser.displayName,
            });
          }
        }
      }

      const extracted = extractIdentifiers(input.content, input.metadata, byHandle);
      if (extracted.length === 0) return;

      for (const e of extracted) {
        await this.upsertOne(input.conversationId, input.id, e).catch((err) =>
          log.warn(
            { err, conversationId: input.conversationId, kind: e.kind, canonicalId: e.canonicalId },
            `[ConversationIdentifier] upsert skipped: ${(err as Error).message}`,
          ),
        );
      }
    } catch (err) {
      log.warn(
        { err, conversationId: input.conversationId, messageId: input.id },
        `[ConversationIdentifier] populate non-fatal error: ${(err as Error).message}`,
      );
    }
  }

  /** Upsert a single identifier, accumulating aliases. */
  private async upsertOne(
    conversationId: string,
    messageId: string,
    e: ExtractedIdentifier,
  ): Promise<void> {
    const existing = (await prisma.iMConversationIdentifierIndex.findUnique({
      where: {
        conversationId_identifierKind_canonicalId: {
          conversationId,
          identifierKind: e.kind,
          canonicalId: e.canonicalId,
        },
      },
    })) as { id: string; aliasesJson: string; displayLabel: string | null } | null;

    if (!existing) {
      await prisma.iMConversationIdentifierIndex.create({
        data: {
          conversationId,
          identifierKind: e.kind,
          canonicalId: e.canonicalId,
          aliasesJson: JSON.stringify(e.alias ? [e.alias] : []),
          firstSeenMessageId: messageId,
          lastReferencedMessageId: messageId,
          displayLabel: e.displayLabel ?? e.alias ?? null,
        },
      });
      return;
    }

    // Merge alias, bump lastReferencedMessageId.
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(existing.aliasesJson || '[]');
      if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      aliases = [];
    }
    let changed = false;
    if (e.alias && !aliases.includes(e.alias)) {
      aliases.push(e.alias);
      changed = true;
    }
    await prisma.iMConversationIdentifierIndex.update({
      where: { id: existing.id },
      data: {
        lastReferencedMessageId: messageId,
        ...(changed ? { aliasesJson: JSON.stringify(aliases) } : {}),
        ...(!existing.displayLabel && (e.displayLabel || e.alias)
          ? { displayLabel: e.displayLabel ?? e.alias }
          : {}),
      },
    });
  }
}

export const conversationIdentifierService = new ConversationIdentifierService();
