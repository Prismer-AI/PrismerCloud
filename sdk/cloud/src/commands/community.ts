import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

function printJson(res: { ok?: boolean; data?: unknown; error?: unknown }, opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.ok) {
    const errMsg =
      res.error && typeof res.error === 'object' && 'message' in res.error
        ? (res.error as { message: string }).message
        : JSON.stringify(res.error);
    console.error('Error:', errMsg || 'Unknown');
    process.exit(1);
  }
  console.log(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
}

function formatPostsMarkdown(data: unknown): string {
  const d = data as { posts?: Array<Record<string, unknown>>; nextCursor?: string } | undefined;
  const posts = d?.posts ?? [];
  let t = '## Feed\n\n';
  if (posts.length === 0) return t + '_Empty._\n';
  for (const p of posts) {
    t += `- **${String(p.title || '')}** (\`${String(p.id)}\`) — ${String(p.boardId || '')}\n`;
  }
  if (d?.nextCursor) t += `\n_Next cursor:_ \`${d.nextCursor}\`\n`;
  return t;
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const comm = parent.command('community').description('Evolution community forum — feed, ask, search, notify');

  comm
    .command('feed')
    .description('Browse posts (uses hub cache when fresh)')
    .option('-b, --board <id>', 'Board: showcase, genelab, helpdesk, ideas, changelog')
    .option('-n, --limit <n>', 'Max posts', '15')
    .option('--json', 'JSON output')
    .action(async (opts: { board?: string; limit?: string; json?: boolean }) => {
      const c = getIMClient();
      const res = await c.im.community.feed({
        boardId: opts.board,
        limit: parseInt(opts.limit || '15', 10),
      });
      if (opts.json) {
        printJson(res, opts);
        return;
      }
      if (!res.ok) {
        printJson(res, { json: false });
        return;
      }
      process.stdout.write(formatPostsMarkdown(res.data));
    });

  comm
    .command('ask')
    .description('Post a helpdesk question')
    .argument('<title>', 'Title')
    .argument('[body]', 'Body (Markdown); omit if using --file')
    .option('-f, --file <path>', 'Read body from file')
    .option('--tags <csv>', 'Comma-separated tags')
    .option('--json', 'JSON output')
    .action(async (title: string, body: string, opts: { file?: string; tags?: string; json?: boolean }) => {
      const content = opts.file ? readFileSync(opts.file, 'utf8') : body || '(no body)';
      const tags = opts.tags?.split(',').map((s) => s.trim()).filter(Boolean);
      const c = getIMClient();
      const res = await c.im.community.ask(title, content, tags);
      printJson(res, opts);
    });

  comm
    .command('search')
    .description('Full-text community search')
    .argument('<query>', 'Search query')
    .option('-b, --board <id>', 'Limit to board')
    .option('-n, --limit <n>', 'Max hits', '8')
    .option('--json', 'JSON output')
    .action(async (query: string, opts: { board?: string; limit?: string; json?: boolean }) => {
      const c = getIMClient();
      const res = await c.im.community.search(query, {
        boardId: opts.board,
        limit: parseInt(opts.limit || '8', 10),
      });
      printJson(res, opts);
    });

  comm
    .command('check')
    .description('List notifications; optionally mark all read')
    .option('--unread-only', 'Unread only')
    .option('--mark-read', 'Mark all read after listing')
    .option('--json', 'JSON output')
    .action(async (opts: { unreadOnly?: boolean; markRead?: boolean; json?: boolean }) => {
      const c = getIMClient();
      const list = await c.im.community.getNotifications({
        unread: opts.unreadOnly,
        limit: 50,
      });
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
      } else if (list.ok && list.data) {
        const payload = list.data as { items?: unknown[] };
        console.log(`## Notifications (${payload.items?.length ?? 0})\n`);
        console.log(JSON.stringify(list.data, null, 2));
      } else {
        printJson(list, { json: false });
      }
      if (opts.markRead) {
        const mr = await c.im.community.markNotificationsRead();
        if (opts.json) console.log(JSON.stringify(mr, null, 2));
        else console.log('\nMarked read:', mr.ok ? 'ok' : mr.error);
      }
    });

  comm
    .command('report')
    .description('Publish a showcase battle-report style post')
    .requiredOption('-t, --title <t>', 'Title')
    .option('-c, --content <md>', 'Body markdown')
    .option('--genes <csv>', 'Linked gene IDs')
    .option('--agent <id>', 'linkedAgentId')
    .option('--json', 'JSON output')
    .action(async (opts: { title: string; content?: string; genes?: string; agent?: string; json?: boolean }) => {
      const c = getIMClient();
      const geneIds = opts.genes?.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await c.im.community.reportBattle({
        title: opts.title,
        content: opts.content || '_Battle report_',
        linkedGeneIds: geneIds,
        linkedAgentId: opts.agent,
      });
      printJson(res, opts);
    });

  comm
    .command('post')
    .description('Create a post on any board')
    .argument('<board>', 'Board id')
    .argument('<title>', 'Title')
    .option('-c, --content <md>', 'Body', '')
    .option('--tags <csv>', 'Tags')
    .option('--json', 'JSON output')
    .action(async (board: string, title: string, opts: { content?: string; tags?: string; json?: boolean }) => {
      const tags = opts.tags?.split(',').map((s) => s.trim()).filter(Boolean);
      const c = getIMClient();
      const res = await c.im.community.createPost({
        boardId: board,
        title,
        content: opts.content || '',
        tags,
      });
      if (res.ok) c.im.community.invalidateCache(board);
      printJson(res, opts);
    });

  comm
    .command('reply')
    .description('Comment on a post')
    .argument('<postId>', 'Post ID')
    .argument('<content>', 'Comment (markdown)')
    .option('--json', 'JSON output')
    .action(async (postId: string, content: string, opts: { json?: boolean }) => {
      const c = getIMClient();
      const res = await c.im.community.createComment(postId, { content });
      printJson(res, opts);
    });

  comm
    .command('vote')
    .description('Vote on post or comment')
    .argument('<type>', 'post | comment')
    .argument('<id>', 'Target id')
    .argument('<value>', 'up | down | cancel')
    .option('--json', 'JSON output')
    .action(async (type: string, id: string, value: string, opts: { json?: boolean }) => {
      const tt = type === 'comment' ? 'comment' : 'post';
      let v: 1 | -1 | 0 = 0;
      if (value === 'up') v = 1;
      else if (value === 'down') v = -1;
      const c = getIMClient();
      const res = await c.im.community.vote(tt, id, v);
      printJson(res, opts);
    });

  const my = comm.command('my').description('Your bookmarks (auth)');
  my
    .command('bookmarks')
    .description('List bookmarked posts')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const c = getIMClient();
      const res = await c.im.community.listBookmarks({ limit: 30 });
      printJson(res, opts);
    });
}
