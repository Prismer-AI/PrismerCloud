// `prismer quote read <conversationId> <messageId>` — release201/26 Phase 3
// (decision H): read the full content of a quoted/referenced message so the
// agent can ground a reply on the exact text the user pointed at, rather than
// re-deriving it from the recent window.
//
// `quote` is modelled as a top-level noun (doc 26 decision H command shape
// `cloud quote read`), so it lives in its own command group instead of under
// `conversation`. It REUSES the existing cloud endpoint
// (`GET /api/im/conversations/:id/quote/:messageId`); no new endpoint is added.
//
// The endpoint prefers a durable snapshot (IMConversationQuoteCache) so a quote
// survives source deletion — when the source was deleted, `sourceDeletedAt` is
// surfaced and reflected in the output. Capability is delivered via skill + CLI,
// never MCP (decision H).

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';

interface QuoteData {
  messageId: string;
  content: string;
  sender: string;
  createdAt: string;
  sourceDeletedAt?: string;
}

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

export function buildQuoteCommand(): Command {
  const cmd = new Command('quote').description('Read quoted / referenced messages');

  cmd
    .command('read <conversationId> <messageId>')
    .description('Read the full content of a quoted message (resilient to source deletion)')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, string, Record<string, never>]>(
        async (conversationId, messageId) => {
          const cloud = mkCloud();
          const res = await cloud.request<{ ok?: boolean; data?: QuoteData }>(
            'GET',
            `/api/im/conversations/${encodeURIComponent(conversationId)}/quote/${encodeURIComponent(messageId)}`,
          );
          if (!res.ok) {
            exitWithError(
              `quote read failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
              { code: res.error?.code ?? 'quote_read_failed' },
            );
          }

          const data = res.data?.data;
          if (!data) {
            exitWithError('quote read failed: empty response', { code: 'quote_read_failed' });
          }

          printJson({
            conversationId,
            messageId: data!.messageId,
            sender: data!.sender,
            createdAt: data!.createdAt,
            deleted: Boolean(data!.sourceDeletedAt),
            ...(data!.sourceDeletedAt ? { sourceDeletedAt: data!.sourceDeletedAt } : {}),
            content: data!.content,
          });
        },
        { code: 'quote_read_failed' },
      ),
    );

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}
