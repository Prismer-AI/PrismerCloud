import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const im = parent
    .command('im')
    .description('IM messaging, groups, conversations, and credits');

  // ---------------------------------------------------------------------------
  // im send <user-id> <message>
  // ---------------------------------------------------------------------------
  im
    .command('send <user-id> <message>')
    .description('Send a direct message to a user')
    .option('-t, --type <type>', 'Message type: text, markdown, code, file, etc.', 'text')
    .option('--reply-to <msg-id>', 'Reply to a specific message ID (parentId)')
    .option('--json', 'Output raw JSON response')
    .action(async (userId: string, message: string, opts: { type: string; replyTo?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const sendOpts: Parameters<typeof client.im.direct.send>[2] = {
          type: opts.type as 'text' | 'markdown' | 'code' | 'image' | 'file' | 'tool_call' | 'tool_result' | 'system_event' | 'thinking',
        };
        if (opts.replyTo) sendOpts!.parentId = opts.replyTo;
        const res = await client.im.direct.send(userId, message, sendOpts);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Message sent (conversationId: ${res.data?.conversationId})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im messages <user-id>
  // ---------------------------------------------------------------------------
  im
    .command('messages <user-id>')
    .description('View direct message history with a user')
    .option('-n, --limit <n>', 'Max number of messages to fetch', '20')
    .option('--json', 'Output raw JSON response')
    .action(async (userId: string, opts: { limit: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.direct.getMessages(userId, { limit: parseInt(opts.limit, 10) });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const msgs = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(msgs, null, 2) + '\n');
          return;
        }
        if (msgs.length === 0) {
          process.stdout.write('No messages.\n');
          return;
        }
        for (const m of msgs) {
          const ts = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
          process.stdout.write(`[${ts}] ${m.senderId || '?'}: ${m.content}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im edit <conversation-id> <message-id> <content>
  // ---------------------------------------------------------------------------
  im
    .command('edit <conversation-id> <message-id> <content>')
    .description('Edit an existing message')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, msgId: string, content: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.messages.edit(convId, msgId, content);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Message ${msgId} updated.\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im delete <conversation-id> <message-id>
  // ---------------------------------------------------------------------------
  im
    .command('delete <conversation-id> <message-id>')
    .description('Delete a message')
    .option('--json', 'Output raw JSON response')
    .action(async (convId: string, msgId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.messages.delete(convId, msgId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Message ${msgId} deleted.\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im discover
  // ---------------------------------------------------------------------------
  im
    .command('discover')
    .description('Discover available agents')
    .option('--type <type>', 'Filter by agent type')
    .option('--capability <cap>', 'Filter by capability')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { type?: string; capability?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const discoverOpts: Record<string, string> = {};
        if (opts.type) discoverOpts.type = opts.type;
        if (opts.capability) discoverOpts.capability = opts.capability;
        const res = await client.im.contacts.discover(Object.keys(discoverOpts).length ? discoverOpts : undefined);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const agents = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
          return;
        }
        if (agents.length === 0) {
          process.stdout.write('No agents found.\n');
          return;
        }
        process.stdout.write(
          'Username'.padEnd(20) + 'Type'.padEnd(14) + 'Status'.padEnd(10) + 'Display Name\n',
        );
        for (const a of agents) {
          process.stdout.write(
            `${(a.username || '').padEnd(20)}${(a.agentType || '').padEnd(14)}${(a.status || '').padEnd(10)}${a.displayName || ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im contacts
  // ---------------------------------------------------------------------------
  im
    .command('contacts')
    .description('List contacts')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.contacts.list();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const contacts = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(contacts, null, 2) + '\n');
          return;
        }
        if (contacts.length === 0) {
          process.stdout.write('No contacts.\n');
          return;
        }
        process.stdout.write(
          'Username'.padEnd(20) + 'Role'.padEnd(10) + 'Unread'.padEnd(8) + 'Display Name\n',
        );
        for (const c of contacts) {
          process.stdout.write(
            `${(c.username || '').padEnd(20)}${(c.role || '').padEnd(10)}${String(c.unreadCount ?? 0).padEnd(8)}${c.displayName || ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im conversations
  // ---------------------------------------------------------------------------
  im
    .command('conversations')
    .description('List conversations')
    .option('--unread', 'Show only conversations with unread messages')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { unread: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        const listOpts: { withUnread?: boolean; unreadOnly?: boolean } = {};
        if (opts.unread) {
          listOpts.withUnread = true;
          listOpts.unreadOnly = true;
        }
        const res = await client.im.conversations.list(listOpts);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const list = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(list, null, 2) + '\n');
          return;
        }
        if (list.length === 0) {
          process.stdout.write('No conversations.\n');
          return;
        }
        for (const c of list) {
          const unread = c.unreadCount ? ` (${c.unreadCount} unread)` : '';
          process.stdout.write(`${c.id || ''}  ${c.type || ''}  ${c.title || ''}${unread}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im read <conversation-id>
  // ---------------------------------------------------------------------------
  im
    .command('read <conversation-id>')
    .description('Mark a conversation as read')
    .action(async (convId: string) => {
      const client = getIMClient();
      try {
        const res = await client.im.conversations.markAsRead(convId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        process.stdout.write('Marked as read.\n');
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im groups (sub-command group)
  // ---------------------------------------------------------------------------
  const groups = im
    .command('groups')
    .description('Group chat management');

  // im groups create <title>
  groups
    .command('create <title>')
    .description('Create a new group')
    .option('-m, --members <ids>', 'Comma-separated member user IDs to add')
    .option('--json', 'Output raw JSON response')
    .action(async (title: string, opts: { members?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const members = opts.members ? opts.members.split(',').map((s) => s.trim()) : [];
        const res = await client.im.groups.create({ title, members });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Group created (groupId: ${res.data?.groupId})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // im groups list
  groups
    .command('list')
    .description('List groups you belong to')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.groups.list();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const list = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(list, null, 2) + '\n');
          return;
        }
        if (list.length === 0) {
          process.stdout.write('No groups.\n');
          return;
        }
        for (const g of list) {
          process.stdout.write(`${g.groupId || ''}  ${g.title || ''} (${g.members?.length || '?'} members)\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // im groups send <group-id> <message>
  groups
    .command('send <group-id> <message>')
    .description('Send a message to a group')
    .option('--json', 'Output raw JSON response')
    .action(async (groupId: string, message: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.groups.send(groupId, message);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write('Message sent to group.\n');
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // im groups messages <group-id>
  groups
    .command('messages <group-id>')
    .description('View group message history')
    .option('-n, --limit <n>', 'Max number of messages to fetch', '20')
    .option('--json', 'Output raw JSON response')
    .action(async (groupId: string, opts: { limit: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.groups.getMessages(groupId, { limit: parseInt(opts.limit, 10) });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const msgs = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(msgs, null, 2) + '\n');
          return;
        }
        if (msgs.length === 0) {
          process.stdout.write('No messages.\n');
          return;
        }
        for (const m of msgs) {
          const ts = m.createdAt ? new Date(m.createdAt).toLocaleString() : '';
          process.stdout.write(`[${ts}] ${m.senderId || '?'}: ${m.content}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im me
  // ---------------------------------------------------------------------------
  im
    .command('me')
    .description('Show current identity, agent card, credits, and stats')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.account.me();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const d = res.data;
        if (opts.json) {
          process.stdout.write(JSON.stringify(d, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Display Name: ${d?.user?.displayName || '-'}\n`);
        process.stdout.write(`Username:     ${d?.user?.username || '-'}\n`);
        process.stdout.write(`Role:         ${d?.user?.role || '-'}\n`);
        process.stdout.write(`Agent Type:   ${d?.agentCard?.agentType || '-'}\n`);
        process.stdout.write(`Credits:      ${d?.credits?.balance ?? '-'}\n`);
        process.stdout.write(`Messages:     ${d?.stats?.messagesSent ?? '-'}\n`);
        process.stdout.write(`Unread:       ${d?.stats?.unreadCount ?? '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im credits
  // ---------------------------------------------------------------------------
  im
    .command('credits')
    .description('Show credits balance')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.credits.get();
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Balance: ${res.data?.balance ?? '-'}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im transactions
  // ---------------------------------------------------------------------------
  im
    .command('transactions')
    .description('Show credit transaction history')
    .option('-n, --limit <n>', 'Max number of transactions to fetch', '20')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { limit: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.credits.transactions({ limit: parseInt(opts.limit, 10) });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const txns = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(txns, null, 2) + '\n');
          return;
        }
        if (txns.length === 0) {
          process.stdout.write('No transactions.\n');
          return;
        }
        process.stdout.write(
          'Date'.padEnd(24) + 'Type'.padEnd(20) + 'Amount'.padEnd(12) + 'Description\n',
        );
        for (const t of txns) {
          const date = t.createdAt ? new Date(t.createdAt).toLocaleString() : '';
          process.stdout.write(
            `${date.padEnd(24)}${(t.type || '').padEnd(20)}${String(t.amount ?? '').padEnd(12)}${t.description || ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im heartbeat
  // ---------------------------------------------------------------------------
  im
    .command('heartbeat')
    .description('Send agent heartbeat (online/busy/offline) with optional load')
    .option('--status <status>', 'Presence status: online, busy, or offline', 'online')
    .option('--load <n>', 'Current load factor (0.0 to 1.0)')
    .option('--json', 'Output raw JSON response')
    .action(async (opts: { status: string; load?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = { status: opts.status };
        if (opts.load !== undefined) {
          const load = parseFloat(opts.load);
          if (!isNaN(load)) body.load = load;
        }
        // No dedicated SDK method — use raw request on the account sub-client
        const res = await (client.im.account as unknown as { _r: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }> })
          ._r('POST', '/api/im/agents/heartbeat', body);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Heartbeat sent (status: ${opts.status}${opts.load !== undefined ? `, load: ${opts.load}` : ''}).\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // im health
  // ---------------------------------------------------------------------------
  im
    .command('health')
    .description('Check IM service health')
    .action(async () => {
      const client = getIMClient();
      try {
        const res = await client.im.health();
        if (!res.ok) {
          process.stderr.write(`IM Service: ERROR\n`);
          process.stderr.write(`${JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        process.stdout.write('IM Service: OK\n');
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
