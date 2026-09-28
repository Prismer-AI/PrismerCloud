// `cloud pay ...` — agent-initiated WeChat Pay inside an IM session (wechat202/05).
//
//   cloud pay create --conversation <id> --amount <yuan> --desc "咨询费"
//   cloud pay status <orderId>
//
// Agent-facing port of `prismer pay` (the `pay` namespace previously existed only
// on the daemon CLI). `create` posts a Native QR card into the session (the bridge
// fans the QR out to bound WeChat users); `status` polls one order. Amount is given
// in YUAN on the CLI for ergonomics and converted to 分 for the API. Reuses the
// existing endpoints `POST /api/im/pay/orders` and `GET /api/im/pay/orders/:id`.

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

interface OrderResult {
  orderId?: string;
  outTradeNo?: string;
  status?: string;
  messageId?: string | null;
  codeUrl?: string;
  amount?: number;
  description?: string;
  expiresAt?: string;
}

// `client.im.request<T>` returns the parsed response BODY directly, so T is the
// envelope, not the inner order.
interface OrderEnvelope {
  ok?: boolean;
  data?: OrderResult;
  error?: { code?: string; message?: string };
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const pay = parent.command('pay').description('Agent-initiated WeChat Pay (Native 扫码) in an IM session');

  pay
    .command('create')
    .description('Create a WeChat Pay order and post its QR into the session')
    .requiredOption('--conversation <id>', 'Conversation/session ID to post the QR into')
    .requiredOption('--amount <yuan>', 'Amount in YUAN (e.g. 9.9)')
    .option('--desc <text>', 'Order description', '收款')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { conversation: string; amount: string; desc: string; json?: boolean }) => {
      const fen = Math.round(Number(opts.amount) * 100);
      if (!Number.isInteger(fen) || fen <= 0) {
        process.stderr.write('Error: --amount must be a positive number of yuan, e.g. 9.9\n');
        process.exit(1);
      }
      const client = getIMClient();
      try {
        const res = await client.im.request<OrderEnvelope>('POST', '/api/im/pay/orders', {
          conversationId: opts.conversation,
          amount: fen,
          description: opts.desc,
        });
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'pay create failed'}\n`);
          process.exit(1);
        }
        const d = res.data;
        if (opts.json) {
          process.stdout.write(JSON.stringify(d, null, 2) + '\n');
        } else {
          process.stdout.write(
            `WeChat Pay order ${d.orderId} (${d.status})\n` +
              `¥${((d.amount ?? fen) / 100).toFixed(2)} · ${opts.desc}\n` +
              `QR posted as message ${d.messageId ?? '(none)'}\n` +
              `Poll: cloud pay status ${d.orderId}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  pay
    .command('status <orderId>')
    .description('Query one order (poll until status=succeeded)')
    .option('--json', 'output raw JSON response')
    .action(async (orderId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OrderEnvelope>(
          'GET',
          `/api/im/pay/orders/${encodeURIComponent(orderId)}`,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${res.error?.message ?? 'pay status failed'}\n`);
          process.exit(1);
        }
        const d = res.data;
        if (opts.json) {
          process.stdout.write(JSON.stringify(d, null, 2) + '\n');
        } else {
          process.stdout.write(
            `Order ${d.orderId}: ${d.status} · ¥${((d.amount ?? 0) / 100).toFixed(2)} · ${d.description ?? ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
