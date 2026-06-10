// `prismer chat ...` — IM direct/group lifecycle helpers.

import { Command } from 'commander';
import { CloudClient, type CloudResponse } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson } from '../util.js';
import { getUI } from '../ui.js';

interface MeResult {
  imUserId?: string;
  userId?: string;
  username?: string;
  displayName?: string;
  role?: string;
  type?: string;
}

interface MessageResult {
  message?: {
    id?: string;
    conversationId?: string;
    senderId?: string;
    type?: string;
    content?: string;
    createdAt?: string;
  };
  routing?: {
    mode?: string;
    targets?: Array<{ userId?: string; username?: string; displayName?: string }>;
  };
}

interface GroupResult {
  groupId?: string;
  title?: string | null;
  description?: string | null;
  members?: Array<{ userId?: string; username?: string; displayName?: string; role?: string }>;
}

export function buildChatCommand(): Command {
  const cmd = new Command('chat').description('Use IM chat and group APIs');

  cmd
    .command('me')
    .description('Show the current IM identity')
    .option('--json', 'Print raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const data = await requestOrExit<MeResult>('GET', '/api/im/me');
      if (opts.json) {
        printJson(data);
        return;
      }

      const id = data.imUserId ?? data.userId ?? '(unknown)';
      const name = data.displayName ?? data.username ?? '(unnamed)';
      const role = data.role ?? data.type ?? 'unknown';
      getUI().line(`IM user ${id}\n${name} (${role})`);
    });

  cmd
    .command('direct <targetUserId>')
    .description('Send a direct message')
    .requiredOption('--message <text>', 'Message text')
    .option('--json', 'Print raw JSON response')
    .action(async (targetUserId: string, opts: { message: string; json?: boolean }) => {
      const data = await requestOrExit<MessageResult>(
        'POST',
        `/api/im/direct/${encodeURIComponent(targetUserId)}/messages`,
        { type: 'text', content: opts.message },
      );
      if (opts.json) {
        printJson(data);
        return;
      }
      printMessageSummary('Direct message sent', data);
    });

  const group = new Command('group').description('Manage IM groups');

  group
    .command('create')
    .description('Create a group')
    .requiredOption('--name <name>', 'Group name/title')
    .requiredOption('--members <csv>', 'Comma-separated IM user IDs, usernames, or cloud user IDs')
    .option('--json', 'Print raw JSON response')
    .action(async (opts: { name: string; members: string; json?: boolean }) => {
      const members = parseCsv(opts.members);
      const data = await requestOrExit<GroupResult>('POST', '/api/im/groups', {
        title: opts.name,
        members,
      });
      if (opts.json) {
        printJson(data);
        return;
      }
      const memberCount = data.members?.length ?? members.length;
      getUI().line(`Group created ${data.groupId ?? '(unknown)'}\n${data.title ?? opts.name} (${memberCount} members)`);
    });

  group
    .command('messages <groupId>')
    .description('List group messages')
    .option('--limit <n>', 'Max messages', parsePositiveInt)
    .option('--before <id>', 'Return messages before this message id')
    .option('--json', 'Print raw JSON response')
    .action(async (groupId: string, opts: { limit?: number; before?: string; json?: boolean }) => {
      const data = await requestOrExit<unknown[]>(
        'GET',
        withQuery(`/api/im/groups/${encodeURIComponent(groupId)}/messages`, {
          limit: opts.limit,
          before: opts.before,
        }),
      );
      if (opts.json) {
        printJson(data);
        return;
      }
      printMessagesSummary(data);
    });

  group
    .command('send <groupId>')
    .description('Send a message to a group')
    .requiredOption('--message <text>', 'Message text')
    .option('--json', 'Print raw JSON response')
    .action(async (groupId: string, opts: { message: string; json?: boolean }) => {
      const data = await requestOrExit<MessageResult>(
        'POST',
        `/api/im/groups/${encodeURIComponent(groupId)}/messages`,
        { type: 'text', content: opts.message },
      );
      if (opts.json) {
        printJson(data);
        return;
      }
      printMessageSummary('Group message sent', data);
    });

  group
    .command('remove-member <groupId> <memberId>')
    .description('Remove a member from a group')
    .option('--json', 'Print raw JSON response')
    .action(async (groupId: string, memberId: string, opts: { json?: boolean }) => {
      const data = await requestOrExit<unknown>(
        'DELETE',
        `/api/im/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}`,
      );
      if (opts.json) {
        printJson(data ?? { ok: true });
        return;
      }
      getUI().line(`Removed ${memberId} from group ${groupId}`);
    });

  cmd.addCommand(group);

  cmd
    .command('messages <conversationId>')
    .description('List conversation messages')
    .option('--limit <n>', 'Max messages', parsePositiveInt)
    .option('--before <id>', 'Return messages before this message id')
    .option('--json', 'Print raw JSON response')
    .action(async (conversationId: string, opts: { limit?: number; before?: string; json?: boolean }) => {
      const data = await requestOrExit<unknown[]>(
        'GET',
        withQuery(`/api/im/messages/${encodeURIComponent(conversationId)}`, {
          limit: opts.limit,
          before: opts.before,
        }),
      );
      if (opts.json) {
        printJson(data);
        return;
      }
      printMessagesSummary(data);
    });

  return cmd;
}

async function requestOrExit<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let res: CloudResponse<unknown>;
  try {
    res = await mkCloud().request(method, path, body === undefined ? undefined : { body });
  } catch (err) {
    exitWithError(sanitizeError((err as Error).message));
  }
  if (!res.ok) {
    exitWithError(`${method} ${path} failed (${res.status}): ${sanitizeError(res.error?.message ?? 'unknown')}`);
  }
  return unwrapEnvelope<T>(res.data);
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === 'object') {
    if ('ok' in raw) {
      const env = raw as { ok?: boolean; data?: unknown; error?: { message?: string } | string; meta?: unknown };
      if (env.ok === false) {
        const message = typeof env.error === 'string' ? env.error : env.error?.message;
        exitWithError(sanitizeError(message ?? 'IM API returned ok=false'));
      }
      return env.data as T;
    }
    if ('success' in raw) {
      const env = raw as { success?: boolean; data?: unknown; error?: { message?: string } | string };
      if (env.success === false) {
        const message = typeof env.error === 'string' ? env.error : env.error?.message;
        exitWithError(sanitizeError(message ?? 'API returned success=false'));
      }
      return env.data as T;
    }
  }
  return raw as T;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('expected a positive integer');
  }
  return parsed;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function printMessageSummary(label: string, data: MessageResult): void {
  const msg = data.message ?? {};
  getUI().line(`${label}: ${msg.id ?? '(unknown)'}`);
  if (msg.conversationId) getUI().line(`Conversation: ${msg.conversationId}`);
  if (data.routing?.mode) {
    const targetCount = data.routing.targets?.length ?? 0;
    getUI().line(`Routing: ${data.routing.mode} (${targetCount} targets)`);
  }
}

function printMessagesSummary(data: unknown): void {
  const messages = Array.isArray(data) ? data : [];
  getUI().line(`${messages.length} message${messages.length === 1 ? '' : 's'}`);
  for (const item of messages.slice(0, 10)) {
    const msg = item as { id?: string; senderId?: string; content?: string; createdAt?: string };
    const preview = (msg.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
    getUI().line(`${msg.id ?? '(unknown)'} ${msg.senderId ?? '(unknown)'} ${preview}`);
  }
}

function sanitizeError(message: string): string {
  return message.replace(/sk-prismer-[A-Za-z0-9._-]+/g, 'sk-prismer-***');
}
