import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, _getIMClient: ClientFactory, getAPIClient: ClientFactory): void {
  const ctx = parent
    .command('context')
    .description('Context loading, searching, and caching');

  // context load <urls...>
  ctx
    .command('load <urls...>')
    .description('Load one or more URLs into context')
    .option('-f, --format <fmt>', 'output format: hqcc, raw, or both', 'hqcc')
    .option('--json', 'output raw JSON response')
    .action(async (urls: string[], opts: { format: string; json: boolean }) => {
      const client = getAPIClient();
      try {
        const input = urls.length === 1 ? urls[0] : urls;
        const format = opts.format as 'hqcc' | 'raw' | 'both';
        const res = await client.load(input, {
          return: { format },
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.success) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const results = res.results ?? (res.result ? [res.result] : []);
        if (results.length === 0) {
          process.stdout.write('No results returned.\n');
          return;
        }

        for (const item of results) {
          process.stdout.write(`\n--- ${item.url ?? item.input ?? 'result'} ---\n`);
          const hqcc: string = item.hqcc ?? item.content ?? '';
          if (hqcc) {
            const truncated = hqcc.length > 2000 ? hqcc.slice(0, 2000) + '... [truncated]' : hqcc;
            process.stdout.write(truncated + '\n');
          }
          if (item.cached !== undefined) {
            process.stdout.write(`[cached: ${item.cached}]\n`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // context search <query>
  ctx
    .command('search <query>')
    .description('Search for content using a natural language query')
    .option('-k, --top-k <n>', 'number of results to return', '5')
    .option('--json', 'output raw JSON response')
    .action(async (query: string, opts: { topK: string; json: boolean }) => {
      const client = getAPIClient();
      try {
        const topK = parseInt(opts.topK, 10);
        const res = await client.search(query, { topK });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.success) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        const results = res.results ?? (res.result ? [res.result] : []);
        if (results.length === 0) {
          process.stdout.write('No results found.\n');
          return;
        }

        process.stdout.write(`Search results for: "${query}"\n\n`);
        results.forEach((item, i) => {
          process.stdout.write(`[${i + 1}] ${item.url ?? item.input ?? 'result'}\n`);
          const hqcc: string = item.hqcc ?? item.content ?? '';
          if (hqcc) {
            const truncated = hqcc.length > 2000 ? hqcc.slice(0, 2000) + '... [truncated]' : hqcc;
            process.stdout.write(truncated + '\n');
          }
          process.stdout.write('\n');
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // context save <url> <hqcc>
  ctx
    .command('save <url> <hqcc>')
    .description('Save a URL and its HQCC content to the context cache')
    .option('--json', 'output raw JSON response')
    .action(async (url: string, hqcc: string, opts: { json: boolean }) => {
      const client = getAPIClient();
      try {
        const res = await client.save({ url, hqcc });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        if (!res.success) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          process.exit(1);
        }

        process.stdout.write(`Saved: ${url}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
