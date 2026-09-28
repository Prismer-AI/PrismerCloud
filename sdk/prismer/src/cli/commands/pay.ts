// `prismer pay ...` — agent-initiated WeChat Pay inside an IM session (wechat202/05).
//
//   prismer pay create --conversation <id> --amount <yuan> --desc "咨询费"
//   prismer pay status <orderId>
//
// `create` posts a Native QR card into the session (the bridge fans the QR out
// to bound WeChat users). `status` polls one order. Amount is given in YUAN on
// the CLI for ergonomics and converted to 分 for the API.

import { Command } from 'commander';
import { CloudClient, type CloudResponse } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson } from '../util.js';
import { getUI } from '../ui.js';

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

export function buildPayCommand(): Command {
  const cmd = new Command('pay').description('Agent-initiated WeChat Pay (Native 扫码) in an IM session');

  cmd
    .command('create')
    .description('Create a WeChat Pay order and post its QR into the session')
    .requiredOption('--conversation <id>', 'Conversation/session ID to post the QR into')
    .requiredOption('--amount <yuan>', 'Amount in YUAN (e.g. 9.9)')
    .option('--desc <text>', 'Order description', '收款')
    .option('--json', 'Print raw JSON response')
    .action(async (opts: { conversation: string; amount: string; desc: string; json?: boolean }) => {
      const fen = Math.round(Number(opts.amount) * 100);
      if (!Number.isInteger(fen) || fen <= 0) exitWithError('--amount must be a positive number of yuan, e.g. 9.9');
      const data = await requestOrExit<OrderResult>('POST', '/api/im/pay/orders', {
        conversationId: opts.conversation,
        amount: fen,
        description: opts.desc,
      });
      if (opts.json) return printJson(data);
      getUI().line(
        `WeChat Pay order ${data.orderId} (${data.status})\n` +
          `¥${((data.amount ?? fen) / 100).toFixed(2)} · ${opts.desc}\n` +
          `QR posted as message ${data.messageId ?? '(none)'}\n` +
          `Poll: prismer pay status ${data.orderId}`,
      );
    });

  cmd
    .command('status <orderId>')
    .description('Query one order (poll until status=succeeded)')
    .option('--json', 'Print raw JSON response')
    .action(async (orderId: string, opts: { json?: boolean }) => {
      const data = await requestOrExit<OrderResult>('GET', `/api/im/pay/orders/${encodeURIComponent(orderId)}`);
      if (opts.json) return printJson(data);
      getUI().line(`Order ${data.orderId}: ${data.status} · ¥${((data.amount ?? 0) / 100).toFixed(2)} · ${data.description ?? ''}`);
    });

  return cmd;
}

async function requestOrExit<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const cfg = loadConfig(resolvePaths());
  const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
  let res: CloudResponse<unknown>;
  try {
    res = await cloud.request(method, path, body === undefined ? undefined : { body });
  } catch (err) {
    exitWithError((err as Error).message);
  }
  if (!res.ok) exitWithError(`${method} ${path} failed (${res.status}): ${res.error?.message ?? 'unknown'}`);
  const raw = res.data;
  if (raw && typeof raw === 'object' && 'ok' in raw) {
    const env = raw as { ok?: boolean; data?: unknown; error?: { message?: string } | string };
    if (env.ok === false) {
      const m = typeof env.error === 'string' ? env.error : env.error?.message;
      exitWithError(m ?? 'IM API returned ok=false');
    }
    return env.data as T;
  }
  return raw as T;
}
