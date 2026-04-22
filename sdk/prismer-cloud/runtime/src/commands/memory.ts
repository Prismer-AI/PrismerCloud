import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import type { CliContext } from '../cli/context.js';
import type { UI } from '../cli/ui.js';
import { createCliContext } from '../cli/context.js';

interface MemoryListOptions {
  scope?: string;
  ownerId?: string;
  limit?: number;
}

interface MemorySearchOptions {
  keyword: string;
  scope?: string;
  ownerId?: string;
  limit?: number;
}

interface MemoryDeleteOptions {
  id: string;
}

function readDaemonPort(): number {
  const portFile = path.join(os.homedir(), '.prismer', 'daemon.port');
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(raw, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // Use the default runtime port.
  }
  return 3210;
}

// HTTP error that carries the daemon status + message so the top-level
// command handler can render a clean { cause, fix } envelope instead of
// letting the raw Node stack bubble out (fixes README smoke: `memory list`
// against a daemon returning 401 used to crash with an unhandled rejection).
class DaemonHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DaemonHttpError';
    this.status = status;
  }
}

class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

function requestJson(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const port = readDaemonPort();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk.toString('utf8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          if (!responseData) {
            if (status >= 400) {
              reject(new DaemonHttpError(status, `HTTP ${status}`));
              return;
            }
            resolve({});
            return;
          }

          try {
            const parsed = JSON.parse(responseData) as Record<string, unknown>;
            if (status >= 400) {
              const message =
                typeof parsed['message'] === 'string'
                  ? parsed['message']
                  : typeof parsed['error'] === 'string'
                    ? parsed['error']
                    : `HTTP ${status}`;
              reject(new DaemonHttpError(status, message));
              return;
            }
            resolve(parsed);
          } catch (err) {
            if (status >= 400) {
              reject(new DaemonHttpError(status, `HTTP ${status}`));
              return;
            }
            reject(
              new Error(
                err instanceof Error ? err.message : 'Invalid JSON response from daemon',
              ),
            );
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(
        new DaemonUnreachableError(
          `daemon unreachable on 127.0.0.1:${port} (${err.message})`,
        ),
      );
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

interface MemoryErrorEnvelope {
  title: string;
  cause: string;
  fix: string;
  code: string;
}

function classifyMemoryError(err: unknown): MemoryErrorEnvelope {
  if (err instanceof DaemonHttpError) {
    if (err.status === 401 || err.status === 403) {
      return {
        title: 'Memory Gateway unavailable',
        cause: `daemon returned ${err.status} (unauthorized)`,
        fix: 'Re-run prismer setup, or check that ~/.prismer/config.toml contains a valid api_key',
        code: 'UNAUTHORIZED',
      };
    }
    return {
      title: 'Memory Gateway request failed',
      cause: `daemon returned ${err.status} — ${err.message}`,
      fix: 'Check prismer daemon logs --tail 50 for the underlying error',
      code: 'DAEMON_ERROR',
    };
  }
  if (err instanceof DaemonUnreachableError) {
    return {
      title: 'Memory Gateway unavailable',
      cause: err.message,
      fix: 'Start the daemon with: prismer daemon start',
      code: 'DAEMON_NOT_RUNNING',
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    title: 'Memory command failed',
    cause: msg,
    fix: 'Check prismer daemon logs --tail 50 for the underlying error',
    code: 'MEMORY_COMMAND_FAILED',
  };
}

async function runMemoryCommand(
  ctx: CliContext,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const envelope = classifyMemoryError(err);
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({
        ok: false,
        error: envelope.code,
        message: envelope.title,
        cause: envelope.cause,
        fix: envelope.fix,
      });
    } else {
      ctx.ui.error(envelope.title, envelope.cause, envelope.fix);
    }
    process.exitCode = 1;
  }
}

function normalizeArray(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;
  if (Array.isArray(root['data'])) {
    return root['data'] as Record<string, unknown>[];
  }
  if (root['data'] && typeof root['data'] === 'object') {
    const data = root['data'] as Record<string, unknown>;
    if (Array.isArray(data['results'])) return data['results'] as Record<string, unknown>[];
    if (Array.isArray(data['files'])) return data['files'] as Record<string, unknown>[];
  }
  return [];
}

async function memoryList(
  ctx: CliContext,
  opts: MemoryListOptions,
): Promise<void> {
  const search = new URLSearchParams();
  if (opts.scope) search.set('scope', opts.scope);
  if (opts.ownerId) search.set('ownerId', opts.ownerId);
  if (opts.limit !== undefined) search.set('limit', String(opts.limit));

  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  const payload = await requestJson('GET', `/api/v1/memory${suffix}`);
  const files = normalizeArray(payload);

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, files });
    return;
  }

  ctx.ui.header(`Prismer Memory · ${files.length} files`);
  ctx.ui.blank();

  if (files.length === 0) {
    ctx.ui.secondary('No memory files found.');
    ctx.ui.tip('prismer memory search <keyword>');
    return;
  }

  ctx.ui.table(
    files.map((file) => ({
      PATH: typeof file['path'] === 'string' ? file['path'] : '-',
      SCOPE: typeof file['scope'] === 'string' ? file['scope'] : 'global',
      TYPE: typeof file['memoryType'] === 'string' ? file['memoryType'] : '-',
      UPDATED:
        typeof file['updatedAt'] === 'string'
          ? file['updatedAt']
          : typeof file['updated_at'] === 'string'
            ? file['updated_at']
            : '-',
    })),
    { columns: ['PATH', 'SCOPE', 'TYPE', 'UPDATED'] },
  );
}

async function memorySearch(
  ctx: CliContext,
  opts: MemorySearchOptions,
): Promise<void> {
  const payload = await requestJson('POST', '/api/v1/memory/recall', {
    keyword: opts.keyword,
    scope: opts.scope,
    ownerId: opts.ownerId,
    limit: opts.limit,
  });
  const results = normalizeArray(payload);

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, query: opts.keyword, results });
    return;
  }

  ctx.ui.header(`Prismer Memory · Search "${opts.keyword}"`);
  ctx.ui.blank();

  if (results.length === 0) {
    ctx.ui.secondary('No results found.');
    return;
  }

  ctx.ui.table(
    results.map((result) => ({
      PATH: typeof result['path'] === 'string' ? result['path'] : '-',
      TYPE: typeof result['memoryType'] === 'string' ? result['memoryType'] : '-',
      SCORE:
        typeof result['relevance'] === 'number'
          ? result['relevance'].toFixed(3)
          : '-',
      SNIPPET:
        typeof result['snippet'] === 'string'
          ? result['snippet'].replace(/\s+/g, ' ').slice(0, 80)
          : '-',
    })),
    { columns: ['PATH', 'TYPE', 'SCORE', 'SNIPPET'] },
  );
}

async function memoryDelete(ctx: CliContext, opts: MemoryDeleteOptions): Promise<void> {
  const payload = await requestJson('DELETE', `/api/v1/memory/${encodeURIComponent(opts.id)}`);

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, data: payload });
    return;
  }

  ctx.ui.ok('Memory deleted', opts.id);
}

async function memoryStats(ctx: CliContext): Promise<void> {
  const payload = (await requestJson('GET', '/api/v1/memory/stats')) as Record<string, unknown>;
  const data =
    payload['data'] && typeof payload['data'] === 'object'
      ? (payload['data'] as Record<string, unknown>)
      : payload;

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, data });
    return;
  }

  ctx.ui.header('Prismer Memory · Stats');
  ctx.ui.blank();
  ctx.ui.table(
    [
      {
        METRIC: 'Files',
        VALUE: String(data['fileCount'] ?? data['files'] ?? 0),
      },
      {
        METRIC: 'Recall p95',
        VALUE:
          data['recallP95'] !== undefined ? `${String(data['recallP95'])}ms` : '-',
      },
      {
        METRIC: 'Total Size',
        VALUE: data['totalSize'] !== undefined ? String(data['totalSize']) : '-',
      },
    ],
    { columns: ['METRIC', 'VALUE'] },
  );
}

async function memorySync(ctx: CliContext): Promise<void> {
  if (ctx.ui.mode !== 'json') {
    ctx.ui.header('Prismer Memory · Sync');
    ctx.ui.blank();
    ctx.ui.secondary('Syncing primary storage to local storage...');
  }

  const payload = await requestJson('POST', '/api/v1/memory/sync', {}) as Record<string, unknown>;
  const data =
    payload['data'] && typeof payload['data'] === 'object'
      ? (payload['data'] as Record<string, unknown>)
      : payload;

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, data });
    return;
  }

  const synced = typeof data['synced'] === 'number' ? data['synced'] : 0;
  const failed = typeof data['failed'] === 'number' ? data['failed'] : 0;
  const errors = Array.isArray(data['errors']) ? data['errors'] as string[] : [];

  ctx.ui.success(`Sync complete: ${synced} files synced`);
  if (failed > 0) {
    ctx.ui.info(`${failed} files failed`);
  }

  if (errors.length > 0) {
    ctx.ui.blank();
    ctx.ui.fail('Errors:');
    for (const err of errors) {
      ctx.ui.secondary(`  ${err}`);
    }
  }
}

export function registerMemoryCommands(program: Command, ui: UI): void {
  const memoryCmd = program.command('memory').description('Manage memory via the local daemon');

  memoryCmd
    .command('list')
    .option('--scope <scope>', 'Filter by scope')
    .option('--owner <id>', 'Filter by owner ID')
    .option('--limit <n>', 'Maximum rows', '50')
    .action(async (options: { scope?: string; owner?: string; limit?: string }) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await runMemoryCommand(ctx, () =>
        memoryList(ctx, {
          scope: options.scope,
          ownerId: options.owner,
          limit: options.limit ? parseInt(options.limit, 10) : 50,
        }),
      );
    });

  memoryCmd
    .command('search')
    .argument('<keyword>', 'Keyword to recall')
    .option('--scope <scope>', 'Filter by scope')
    .option('--owner <id>', 'Filter by owner ID')
    .option('--limit <n>', 'Maximum rows', '10')
    .action(
      async (
        keyword: string,
        options: { scope?: string; owner?: string; limit?: string },
      ) => {
        const ctx = await createCliContext({ argv: process.argv, ui });
        await runMemoryCommand(ctx, () =>
          memorySearch(ctx, {
            keyword,
            scope: options.scope,
            ownerId: options.owner,
            limit: options.limit ? parseInt(options.limit, 10) : 10,
          }),
        );
      },
    );

  memoryCmd
    .command('delete')
    .argument('<id>', 'Memory ID')
    .action(async (id: string) => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await runMemoryCommand(ctx, () => memoryDelete(ctx, { id }));
    });

  memoryCmd
    .command('stats')
    .description('Show memory statistics')
    .action(async () => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await runMemoryCommand(ctx, () => memoryStats(ctx));
    });

  memoryCmd
    .command('sync')
    .description('Manually sync primary storage to local storage')
    .action(async () => {
      const ctx = await createCliContext({ argv: process.argv, ui });
      await runMemoryCommand(ctx, () => memorySync(ctx));
    });
}
