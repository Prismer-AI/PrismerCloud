// `cloud quote read <conversationId> <messageId>` — release203/15 WS-E4.
//
// Agent-facing port of `prismer quote read` (the `quote` namespace previously
// existed only on the daemon CLI, but the agent-coordination skill tells agents
// to run `cloud quote read`). Reuses the existing endpoint
// `GET /api/im/conversations/:id/quote/:messageId` (durable IMConversationQuoteCache
// snapshot, resilient to source deletion). No new endpoint.

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

interface QuoteEnvelope {
  ok?: boolean;
  data?: {
    messageId: string;
    content: string;
    sender: string;
    createdAt: string;
    sourceDeletedAt?: string;
  };
  error?: { code?: string; message?: string };
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const quote = parent.command('quote').description('Read quoted / referenced messages');

  quote
    .command('read <conversationId> <messageId>')
    .description('Read the full content of a quoted message (resilient to source deletion)')
    .option('--json', 'output raw JSON response')
    .action(async (conversationId: string, messageId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<QuoteEnvelope>(
          'GET',
          `/api/im/conversations/${encodeURIComponent(conversationId)}/quote/${encodeURIComponent(messageId)}`,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'quote read failed'}\n`);
          process.exit(1);
        }
        const d = res.data;
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                conversationId,
                messageId: d.messageId,
                sender: d.sender,
                createdAt: d.createdAt,
                deleted: Boolean(d.sourceDeletedAt),
                ...(d.sourceDeletedAt ? { sourceDeletedAt: d.sourceDeletedAt } : {}),
                content: d.content,
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(`From:    ${d.sender}\nAt:      ${d.createdAt}\n`);
          if (d.sourceDeletedAt) process.stdout.write(`Deleted: ${d.sourceDeletedAt} (source removed; snapshot shown)\n`);
          process.stdout.write(`\n${d.content}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
