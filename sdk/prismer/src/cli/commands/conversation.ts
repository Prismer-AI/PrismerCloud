// `prismer conversation history <conversationId> [--limit=N]` — pull earlier
// conversation context on demand.
//
// release201/26 decision H: CLI-adapter agents (claude-code / codex) do NOT get
// history inlined into their prompt head. Instead the agent-coordination
// built-in skill documents this command so the agent can fetch earlier turns
// itself when it needs context beyond the recent window. This keeps us off the
// adapter's internal session-file protocol (the §2 root-cause anti-pattern) and
// is cache-friendly (the agent pulls only when needed). Capability is delivered
// via skill + CLI — never MCP (decision H).
//
// This command REUSES the existing cloud message-list endpoint
// (`GET /api/im/messages/:conversationId`); it does not add a new endpoint.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';

interface MessageRecord {
  id: string;
  conversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  role?: string;
  type?: string;
  content?: string | null;
  createdAt?: string;
}

interface SearchMessageRecord extends MessageRecord {
  snippet?: string;
  matchRanges?: Array<{ start: number; end: number }>;
}

interface IdentifierCandidate {
  canonicalId: string;
  displayLabel: string;
  kind: string;
  score: number;
}

interface ResolveIdentifierData {
  canonicalId: string | null;
  displayLabel: string | null;
  kind: string | null;
  candidates: IdentifierCandidate[];
}

interface SummarySegment {
  segmentSeq: number;
  segmentKind: string;
  summary: string;
  coversFromMessageId: string;
  coversToMessageId: string;
  coversFromCreatedAt: string;
  coversToCreatedAt: string;
  messageCount: number;
  tokenCount: number;
}

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

export function buildConversationCommand(): Command {
  const cmd = new Command('conversation').description('Inspect conversation history');

  cmd
    .command('history <conversationId>')
    .description('Fetch earlier messages in a conversation (oldest→newest) for additional context')
    .option('--limit <n>', 'Max messages to fetch', (v) => Number.parseInt(v, 10))
    .option('--before <messageId>', 'Page backwards from this message id')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, { limit?: number; before?: string }]>(
        async (conversationId, opts) => {
          const cloud = mkCloud();
          const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
          const query = new URLSearchParams({ limit: String(limit) });
          if (opts.before) query.set('before', opts.before);

          const res = await cloud.request<{ ok?: boolean; data?: MessageRecord[]; meta?: { total?: number } }>(
            'GET',
            `/api/im/messages/${encodeURIComponent(conversationId)}?${query.toString()}`,
          );
          if (!res.ok) {
            exitWithError(
              `history failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
              { code: res.error?.code ?? 'conversation_history_failed' },
            );
          }

          const messages = Array.isArray(res.data?.data) ? res.data!.data! : [];
          // The cloud endpoint returns newest→oldest; agents read top-to-bottom,
          // so present oldest→newest for natural chronological context.
          const ordered = [...messages].sort((a, b) => {
            const at = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
            return at - bt;
          });

          printJson({
            conversationId,
            count: ordered.length,
            total: res.data?.meta?.total ?? ordered.length,
            messages: ordered.map((m) => ({
              id: m.id,
              role: m.role ?? null,
              sender: m.senderName ?? m.senderUsername ?? m.senderId ?? null,
              senderId: m.senderId ?? null,
              type: m.type ?? null,
              content: m.content ?? '',
              createdAt: m.createdAt ?? null,
            })),
          });
        },
        { code: 'conversation_history_failed' },
      ),
    );

  // `prismer conversation search <conversationId> <keyword>` — release202/04
  // §3.4: keyword-search the full conversation history (including turns that
  // have scrolled out of the recent context window) so the agent can recall
  // earlier discussion on demand.
  //
  // This command REUSES the existing cloud message-list endpoint with a `q`
  // query param (`GET /api/im/messages/:conversationId?q=`); it does not add a
  // new endpoint. The endpoint returns each hit with a highlighted `snippet`
  // and `matchRanges`, plus a `meta.total` count and `meta.query` echo.
  cmd
    .command('search <conversationId> <keyword>')
    .description('Keyword-search a conversation (returns highlighted snippets) for earlier context')
    .option('--limit <n>', 'Max hits to fetch', (v) => Number.parseInt(v, 10))
    .option('--before <messageId>', 'Page backwards from this message id')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, string, { limit?: number; before?: string }]>(
        async (conversationId, keyword, opts) => {
          const cloud = mkCloud();
          // Endpoint clamps search limit to [1, 50]; mirror that default (20).
          const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 20;
          const query = new URLSearchParams({ q: keyword, limit: String(limit) });
          if (opts.before) query.set('before', opts.before);

          const res = await cloud.request<{
            ok?: boolean;
            data?: SearchMessageRecord[];
            meta?: { total?: number; query?: string };
          }>(
            'GET',
            `/api/im/messages/${encodeURIComponent(conversationId)}?${query.toString()}`,
          );
          if (!res.ok) {
            exitWithError(
              `search failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
              { code: res.error?.code ?? 'conversation_search_failed' },
            );
          }

          const messages = Array.isArray(res.data?.data) ? res.data!.data! : [];
          // The endpoint returns newest→oldest; present oldest→newest so the
          // agent reads matches in natural chronological order (matches history).
          const ordered = [...messages].sort((a, b) => {
            const at = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
            return at - bt;
          });

          printJson({
            conversationId,
            keyword: res.data?.meta?.query ?? keyword,
            count: ordered.length,
            total: res.data?.meta?.total ?? ordered.length,
            hits: ordered.map((m) => ({
              id: m.id,
              role: m.role ?? null,
              sender: m.senderName ?? m.senderUsername ?? m.senderId ?? null,
              senderId: m.senderId ?? null,
              type: m.type ?? null,
              snippet: m.snippet ?? m.content ?? '',
              matchRanges: m.matchRanges ?? [],
              createdAt: m.createdAt ?? null,
            })),
          });
        },
        { code: 'conversation_search_failed' },
      ),
    );

  // `prismer conversation resolve-identifier <conversationId> <alias>` —
  // release201/26 Phase 3 (decision H): resolve a fuzzy human reference (e.g.
  // "上次那个 layout", "the auth doc") to a canonical identifier from the
  // conversation's identifier index.
  //
  // 歧义带规则 (doc 26 Phase 3 acceptance): when the alias matches more than one
  // candidate (canonicalId comes back null), the agent MUST surface the choices
  // to the user and ask — it must NOT guess. The output makes this explicit.
  cmd
    .command('resolve-identifier <conversationId> <alias>')
    .description('Resolve a fuzzy reference (alias) to a canonical identifier; surfaces all candidates when ambiguous')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, string, Record<string, never>]>(
        async (conversationId, alias) => {
          const cloud = mkCloud();
          const query = new URLSearchParams({ q: alias });
          const res = await cloud.request<{ ok?: boolean; data?: ResolveIdentifierData }>(
            'GET',
            `/api/im/conversations/${encodeURIComponent(conversationId)}/identifiers/resolve?${query.toString()}`,
          );
          if (!res.ok) {
            exitWithError(
              `resolve-identifier failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
              { code: res.error?.code ?? 'conversation_resolve_failed' },
            );
          }

          const data = res.data?.data;
          const candidates = data?.candidates ?? [];

          if (data?.canonicalId) {
            // Unambiguous: exactly one top-scoring candidate.
            printJson({
              conversationId,
              alias,
              ambiguous: false,
              resolved: {
                canonicalId: data.canonicalId,
                displayLabel: data.displayLabel,
                kind: data.kind,
              },
              candidates,
            });
            return;
          }

          if (candidates.length === 0) {
            printJson({
              conversationId,
              alias,
              ambiguous: false,
              resolved: null,
              candidates: [],
              note: 'No identifier matched this alias. Ask the user to clarify what they are referring to; do not guess.',
            });
            return;
          }

          // Ambiguous: multiple candidates tied for the top score.
          printJson({
            conversationId,
            alias,
            ambiguous: true,
            resolved: null,
            candidates,
            note:
              'AMBIGUOUS: this alias matched multiple identifiers. You MUST ask the user to pick one of the candidates above. Do NOT guess a canonicalId.',
          });
        },
        { code: 'conversation_resolve_failed' },
      ),
    );

  // `prismer conversation summary <conversationId>` — release201/26 Phase 3:
  // read the compressed-segment summaries for the conversation's current range
  // to recall context that has scrolled out of the recent window. Backed by the
  // membership-gated `GET /:id/summary` endpoint (NOT the admin-only /memory).
  cmd
    .command('summary <conversationId>')
    .description('Read compressed-segment summaries (earlier context) for a conversation')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, Record<string, never>]>(
        async (conversationId) => {
          const cloud = mkCloud();
          const res = await cloud.request<{ ok?: boolean; data?: { segments?: SummarySegment[] } }>(
            'GET',
            `/api/im/conversations/${encodeURIComponent(conversationId)}/summary`,
          );
          if (!res.ok) {
            exitWithError(
              `summary failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
              { code: res.error?.code ?? 'conversation_summary_failed' },
            );
          }

          const segments = Array.isArray(res.data?.data?.segments) ? res.data!.data!.segments! : [];
          printJson({
            conversationId,
            count: segments.length,
            segments: segments.map((s) => ({
              segmentSeq: s.segmentSeq,
              kind: s.segmentKind,
              summary: s.summary,
              coversFromMessageId: s.coversFromMessageId,
              coversToMessageId: s.coversToMessageId,
              coversFromCreatedAt: s.coversFromCreatedAt,
              coversToCreatedAt: s.coversToCreatedAt,
              messageCount: s.messageCount,
              tokenCount: s.tokenCount,
            })),
          });
        },
        { code: 'conversation_summary_failed' },
      ),
    );

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}
