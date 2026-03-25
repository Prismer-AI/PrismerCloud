import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const mem = parent
    .command('memory')
    .description('Agent memory file management');

  // memory write --scope <scope> --path <path> --content <content>
  mem
    .command('write')
    .description('Write a memory file')
    .requiredOption('-s, --scope <scope>', 'memory scope')
    .requiredOption('-p, --path <path>', 'file path within scope')
    .requiredOption('-c, --content <content>', 'file content')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { scope: string; path: string; content: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.memory.createFile({
          scope: opts.scope,
          path: opts.path,
          content: opts.content,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const file = res.data;
        process.stdout.write(`Memory file created\n`);
        process.stdout.write(`  ID:    ${file.id}\n`);
        process.stdout.write(`  Scope: ${file.scope}\n`);
        process.stdout.write(`  Path:  ${file.path}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // memory read [file-id]
  mem
    .command('read [file-id]')
    .description('Read a memory file by ID, or filter by scope/path')
    .option('-s, --scope <scope>', 'filter by scope (used when no file-id given)')
    .option('-p, --path <path>', 'filter by path (used when no file-id given)')
    .option('--json', 'output raw JSON response')
    .action(async (fileId: string | undefined, opts: { scope?: string; path?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        // Direct lookup by ID
        if (fileId) {
          const res = await client.im.memory.getFile(fileId);

          if (opts.json) {
            process.stdout.write(JSON.stringify(res, null, 2) + '\n');
            return;
          }

          if (!res.ok) {
            process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
            process.exit(1);
          }

          const file = res.data;
          process.stdout.write(`ID:    ${file.id}\n`);
          process.stdout.write(`Scope: ${file.scope}\n`);
          process.stdout.write(`Path:  ${file.path}\n`);
          process.stdout.write(`\n${file.content ?? ''}\n`);
          return;
        }

        // Filter by scope/path, auto-read if single match
        const listRes = await client.im.memory.listFiles({
          scope: opts.scope,
          path: opts.path,
        });

        if (opts.json) {
          if (listRes.ok && Array.isArray(listRes.data) && listRes.data.length === 1) {
            const detailRes = await client.im.memory.getFile(listRes.data[0].id);
            process.stdout.write(JSON.stringify(detailRes, null, 2) + '\n');
          } else {
            process.stdout.write(JSON.stringify(listRes, null, 2) + '\n');
          }
          return;
        }

        if (!listRes.ok) {
          process.stderr.write(`Error: ${listRes.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const files = listRes.data as Array<{ id: string; scope: string; path: string }>;

        if (files.length === 0) {
          process.stdout.write('No memory files found.\n');
          return;
        }

        if (files.length === 1) {
          // Auto-read single match
          const detailRes = await client.im.memory.getFile(files[0].id);
          if (!detailRes.ok) {
            process.stderr.write(`Error: ${detailRes.error?.message || 'Unknown error'}\n`);
            process.exit(1);
          }
          const file = detailRes.data;
          process.stdout.write(`ID:    ${file.id}\n`);
          process.stdout.write(`Scope: ${file.scope}\n`);
          process.stdout.write(`Path:  ${file.path}\n`);
          process.stdout.write(`\n${file.content ?? ''}\n`);
          return;
        }

        // Multiple matches — show table
        printFileTable(files);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // memory list
  mem
    .command('list')
    .description('List memory files')
    .option('-s, --scope <scope>', 'filter by scope')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { scope?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.memory.listFiles({ scope: opts.scope });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const files = res.data as Array<{ id: string; scope: string; path: string }>;

        if (files.length === 0) {
          process.stdout.write('No memory files found.\n');
          return;
        }

        printFileTable(files);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // memory delete <file-id>
  mem
    .command('delete <file-id>')
    .description('Delete a memory file by ID')
    .option('--json', 'output raw JSON response')
    .action(async (fileId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.memory.deleteFile(fileId);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        process.stdout.write(`Deleted memory file: ${fileId}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // memory compact <conversation-id>
  mem
    .command('compact <conversation-id>')
    .description('Create a compaction summary for a conversation')
    .option('--json', 'output raw JSON response')
    .action(async (conversationId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.memory.compact({ conversationId });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const summary = res.data;
        process.stdout.write(`Compaction complete\n`);
        if (summary?.id) {
          process.stdout.write(`  Summary ID:      ${summary.id}\n`);
        }
        if (summary?.conversationId) {
          process.stdout.write(`  Conversation ID: ${summary.conversationId}\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // memory load
  mem
    .command('load')
    .description('Load session memory context')
    .option('-s, --scope <scope>', 'scope to load')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { scope?: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.memory.load(opts.scope);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const context = res.data;
        if (!context || (typeof context === 'object' && Object.keys(context).length === 0)) {
          process.stdout.write('No memory context available.\n');
          return;
        }

        process.stdout.write('Memory context loaded:\n\n');
        if (typeof context === 'string') {
          process.stdout.write(context + '\n');
        } else {
          process.stdout.write(JSON.stringify(context, null, 2) + '\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}

function printFileTable(files: Array<{ id: string; scope: string; path: string }>): void {
  const idLen = Math.max(2, ...files.map((f) => f.id.length));
  const scopeLen = Math.max(5, ...files.map((f) => f.scope.length));
  const pathLen = Math.max(4, ...files.map((f) => f.path.length));

  const row = (id: string, scope: string, path: string) =>
    `${id.padEnd(idLen)}  ${scope.padEnd(scopeLen)}  ${path.padEnd(pathLen)}`;

  process.stdout.write(row('ID', 'SCOPE', 'PATH') + '\n');
  process.stdout.write(`${'-'.repeat(idLen)}  ${'-'.repeat(scopeLen)}  ${'-'.repeat(pathLen)}\n`);
  for (const f of files) {
    process.stdout.write(row(f.id, f.scope, f.path) + '\n');
  }
}
