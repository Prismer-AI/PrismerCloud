// `cloud conversation <history|search|resolve-identifier|summary>` — agent-facing
// port of the `prismer conversation` daemon namespace.
//
// release201/26 decision H: CLI-adapter agents (claude-code / codex) do NOT get
// history inlined into their prompt head. Instead the agent-coordination
// built-in skill documents this command so the agent can fetch earlier turns
// itself when it needs context beyond the recent window. Capability is delivered
// via skill + CLI — never MCP (decision H).
//
// All subcommands REUSE existing cloud endpoints (`GET /api/im/messages/:id`,
// `GET /api/im/conversations/:id/identifiers/resolve`, `GET /api/im/conversations/:id/summary`);
// none add a new endpoint.

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

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

interface MessageListEnvelope<T = MessageRecord> {
  ok?: boolean;
  data?: T[];
  meta?: { total?: number; query?: string };
  error?: { code?: string; message?: string };
}

interface ResolveEnvelope {
  ok?: boolean;
  data?: ResolveIdentifierData;
  error?: { code?: string; message?: string };
}

interface SummaryEnvelope {
  ok?: boolean;
  data?: { segments?: SummarySegment[] };
  error?: { code?: string; message?: string };
}

function byCreatedAtAsc(a: MessageRecord, b: MessageRecord): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
  return at - bt;
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const conversation = parent.command('conversation').description('Inspect conversation history');

  // `cloud conversation history <conversationId> [--limit=N]` — pull earlier
  // conversation context on demand (oldest→newest).
  conversation
    .command('history <conversationId>')
    .description('Fetch earlier messages in a conversation (oldest→newest) for additional context')
    .option('--limit <n>', 'Max messages to fetch', (v) => Number.parseInt(v, 10))
    .option('--before <messageId>', 'Page backwards from this message id')
    .option('--json', 'output raw JSON response')
    .action(async (conversationId: string, opts: { limit?: number; before?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
        const query: Record<string, string> = { limit: String(limit) };
        if (opts.before) query.before = opts.before;

        const res = await client.im.request<MessageListEnvelope>(
          'GET',
          `/api/im/messages/${encodeURIComponent(conversationId)}`,
          undefined,
          query,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'conversation history failed'}\n`);
          process.exit(1);
        }

        const messages = Array.isArray(res.data) ? res.data : [];
        // The cloud endpoint returns newest→oldest; agents read top-to-bottom,
        // so present oldest→newest for natural chronological context.
        const ordered = [...messages].sort(byCreatedAtAsc);

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                conversationId,
                count: ordered.length,
                total: res.meta?.total ?? ordered.length,
                messages: ordered.map((m) => ({
                  id: m.id,
                  role: m.role ?? null,
                  sender: m.senderName ?? m.senderUsername ?? m.senderId ?? null,
                  senderId: m.senderId ?? null,
                  type: m.type ?? null,
                  content: m.content ?? '',
                  createdAt: m.createdAt ?? null,
                })),
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `Conversation: ${conversationId}\nMessages:     ${ordered.length} of ${res.meta?.total ?? ordered.length}\n\n`,
          );
          for (const m of ordered) {
            const sender = m.senderName ?? m.senderUsername ?? m.senderId ?? 'unknown';
            const at = m.createdAt ?? '';
            process.stdout.write(`[${at}] ${sender}:\n${m.content ?? ''}\n\n`);
          }
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // `cloud conversation search <conversationId> <keyword>` — release202/04 §3.4:
  // keyword-search the full conversation history (including turns scrolled out of
  // the recent window). Reuses the message-list endpoint with a `q` query param;
  // hits come back with a highlighted `snippet` + `matchRanges`.
  conversation
    .command('search <conversationId> <keyword>')
    .description('Keyword-search a conversation (returns highlighted snippets) for earlier context')
    .option('--limit <n>', 'Max hits to fetch', (v) => Number.parseInt(v, 10))
    .option('--before <messageId>', 'Page backwards from this message id')
    .option('--json', 'output raw JSON response')
    .action(
      async (conversationId: string, keyword: string, opts: { limit?: number; before?: string; json?: boolean }) => {
        const client = getIMClient();
        try {
          // Endpoint clamps search limit to [1, 50]; mirror that default (20).
          const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 20;
          const query: Record<string, string> = { q: keyword, limit: String(limit) };
          if (opts.before) query.before = opts.before;

          const res = await client.im.request<MessageListEnvelope<SearchMessageRecord>>(
            'GET',
            `/api/im/messages/${encodeURIComponent(conversationId)}`,
            undefined,
            query,
          );
          if (!res.ok || !res.data) {
            process.stderr.write(`Error: ${res.error?.message ?? 'conversation search failed'}\n`);
            process.exit(1);
          }

          const messages = Array.isArray(res.data) ? res.data : [];
          // The endpoint returns newest→oldest; present oldest→newest so the
          // agent reads matches in natural chronological order (matches history).
          const ordered = [...messages].sort(byCreatedAtAsc);

          if (opts.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  conversationId,
                  keyword: res.meta?.query ?? keyword,
                  count: ordered.length,
                  total: res.meta?.total ?? ordered.length,
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
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(
              `Conversation: ${conversationId}\nKeyword:      ${res.meta?.query ?? keyword}\nHits:         ${ordered.length} of ${res.meta?.total ?? ordered.length}\n\n`,
            );
            for (const m of ordered) {
              const sender = m.senderName ?? m.senderUsername ?? m.senderId ?? 'unknown';
              const at = m.createdAt ?? '';
              process.stdout.write(`[${at}] ${sender}:\n${m.snippet ?? m.content ?? ''}\n\n`);
            }
          }
        } catch (err: unknown) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      },
    );

  // `cloud conversation resolve-identifier <conversationId> <alias>` —
  // release201/26 Phase 3 (decision H): resolve a fuzzy human reference (e.g.
  // "上次那个 layout", "the auth doc") to a canonical identifier from the
  // conversation's identifier index.
  //
  // 歧义带规则 (doc 26 Phase 3 acceptance): when the alias matches more than one
  // candidate (canonicalId comes back null), the agent MUST surface the choices
  // to the user and ask — it must NOT guess. The output makes this explicit.
  conversation
    .command('resolve-identifier <conversationId> <alias>')
    .description('Resolve a fuzzy reference (alias) to a canonical identifier; surfaces all candidates when ambiguous')
    .option('--json', 'output raw JSON response')
    .action(async (conversationId: string, alias: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<ResolveEnvelope>(
          'GET',
          `/api/im/conversations/${encodeURIComponent(conversationId)}/identifiers/resolve`,
          undefined,
          { q: alias },
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'conversation resolve-identifier failed'}\n`);
          process.exit(1);
        }

        const data = res.data;
        const candidates = data.candidates ?? [];

        let payload: Record<string, unknown>;
        if (data.canonicalId) {
          // Unambiguous: exactly one top-scoring candidate.
          payload = {
            conversationId,
            alias,
            ambiguous: false,
            resolved: {
              canonicalId: data.canonicalId,
              displayLabel: data.displayLabel,
              kind: data.kind,
            },
            candidates,
          };
        } else if (candidates.length === 0) {
          payload = {
            conversationId,
            alias,
            ambiguous: false,
            resolved: null,
            candidates: [],
            note: 'No identifier matched this alias. Ask the user to clarify what they are referring to; do not guess.',
          };
        } else {
          // Ambiguous: multiple candidates tied for the top score.
          payload = {
            conversationId,
            alias,
            ambiguous: true,
            resolved: null,
            candidates,
            note:
              'AMBIGUOUS: this alias matched multiple identifiers. You MUST ask the user to pick one of the candidates above. Do NOT guess a canonicalId.',
          };
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        } else if (data.canonicalId) {
          process.stdout.write(
            `Resolved: ${data.canonicalId}\nLabel:    ${data.displayLabel ?? ''}\nKind:     ${data.kind ?? ''}\n`,
          );
        } else if (candidates.length === 0) {
          process.stdout.write(
            `No match for alias "${alias}". Ask the user to clarify what they are referring to; do not guess.\n`,
          );
        } else {
          process.stdout.write(
            `AMBIGUOUS: alias "${alias}" matched ${candidates.length} identifiers. Ask the user to pick one; do NOT guess.\n\n`,
          );
          for (const c of candidates) {
            process.stdout.write(`  - ${c.canonicalId}  ${c.displayLabel} (${c.kind}, score ${c.score})\n`);
          }
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // `cloud conversation summary <conversationId>` — release201/26 Phase 3:
  // read the compressed-segment summaries for the conversation's current range
  // to recall context that has scrolled out of the recent window. Backed by the
  // membership-gated `GET /:id/summary` endpoint (NOT the admin-only /memory).
  conversation
    .command('summary <conversationId>')
    .description('Read compressed-segment summaries (earlier context) for a conversation')
    .option('--json', 'output raw JSON response')
    .action(async (conversationId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<SummaryEnvelope>(
          'GET',
          `/api/im/conversations/${encodeURIComponent(conversationId)}/summary`,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'conversation summary failed'}\n`);
          process.exit(1);
        }

        const segments = Array.isArray(res.data.segments) ? res.data.segments : [];

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
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
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(`Conversation: ${conversationId}\nSegments:     ${segments.length}\n\n`);
          for (const s of segments) {
            process.stdout.write(
              `#${s.segmentSeq} [${s.segmentKind}] ${s.messageCount} msgs / ${s.tokenCount} tokens\n${s.summary}\n\n`,
            );
          }
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
