/**
 * `cloud memory-grant ...` — cross-workspace memory grant management CLI
 * (memory211/05 W3, plan 2026-09-10-cross-workspace-memory-grant-v1 Task 5).
 *
 * Naming: `memory-grant`, NOT `memory` — the legacy SDK-side `cloud memory`
 * command group was REMOVED (memory211/01 §6.9 裁决 3, the "双 CLI 同名异物"
 * footgun: the canonical agent-facing memory CLI is the runtime one,
 * `prismer memory ...` → local daemon). This is a distinct, human-owner
 * diagnostics surface for the cloud grant ledger, so it carries its own name.
 *
 * Commands (mirror `client.im.memory.grants.*` 1:1 — same paths):
 *   cloud memory-grant create   --target <workspaceId> [--expires-in-days <n>]
 *                               [--workspace <sourceWorkspaceId>] [--json]
 *   cloud memory-grant list     [--workspace <sourceWorkspaceId>] [--json]
 *   cloud memory-grant incoming [--workspace <targetWorkspaceId>] [--json]
 *   cloud memory-grant search   --source <workspaceId> --query <text>
 *                               [--workspace <targetWorkspaceId>] [--limit <n>] [--json]
 *   cloud memory-grant load     --source <workspaceId> --path <path>
 *                               [--workspace <targetWorkspaceId>] [--format markdown|html|both] [--json]
 *   cloud memory-grant revoke   <grantId> [--json]
 *
 * create/list assert source-owner authority; incoming asserts target-owner
 * authority (server-side); agents are rejected 403 (they file a `memory_grant`
 * approval instead). Errors print verbatim as `<code>: <message>` and exit 1 —
 * the structured grant codes (409 MEMORY_GRANT_PAIR_RACE,
 * 403 MEMORY_GRANT_DECIDER_NOT_OWNER / MEMORY_GRANT_FORBIDDEN, 404 family,
 * 422 MEMORY_GRANT_INVALID_EXPIRY) are never rewritten.
 */

import { Command } from 'commander';
import type { PrismerClient, IMMemoryExternalHit, IMMemoryExternalLoadResult, IMMemoryGrant } from '../index';

type ClientFactory = () => PrismerClient;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function emit(data: unknown, json: boolean, lines: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  lines();
}

function printGrant(g: IMMemoryGrant, heading = 'Grant'): void {
  process.stdout.write(`${heading}: ${g.id}\n`);
  process.stdout.write(`  pair      ${g.sourceWorkspaceId} -> ${g.targetWorkspaceId}\n`);
  process.stdout.write(`  status    ${g.status}\n`);
  process.stdout.write(`  grantedBy ${g.grantedByImUserId}\n`);
  process.stdout.write(`  expiresAt ${g.expiresAt ?? 'never'}\n`);
  if (g.approvalId) process.stdout.write(`  approval  ${g.approvalId}\n`);
  process.stdout.write(`  updatedAt ${g.updatedAt}\n`);
}

function printGrantTable(grants: IMMemoryGrant[], emptyLabel: string): void {
  if (grants.length === 0) {
    process.stdout.write(`${emptyLabel}\n`);
    return;
  }
  process.stdout.write('ID'.padEnd(28) + 'STATUS'.padEnd(10) + 'SOURCE'.padEnd(28) + 'TARGET'.padEnd(28) + 'EXPIRES\n');
  for (const g of grants) {
    process.stdout.write(
      g.id.padEnd(28) +
        g.status.padEnd(10) +
        g.sourceWorkspaceId.padEnd(28) +
        g.targetWorkspaceId.padEnd(28) +
        (g.expiresAt ?? 'never') +
        '\n',
    );
  }
}

function printSearchHits(hits: IMMemoryExternalHit[], emptyLabel: string): void {
  if (hits.length === 0) {
    process.stdout.write(`${emptyLabel}\n`);
    return;
  }
  process.stdout.write('SCORE'.padEnd(8) + 'SOURCE'.padEnd(28) + 'VIA'.padEnd(24) + 'PATH\n');
  for (const hit of hits) {
    process.stdout.write(
      String(hit.score.toFixed(3)).padEnd(8) +
        hit.sourceWorkspaceId.padEnd(28) +
        hit.via.padEnd(24) +
        hit.path +
        '\n',
    );
    if (hit.snippet) process.stdout.write(`  ${hit.snippet.replace(/\s+/g, ' ').trim().slice(0, 180)}\n`);
  }
}

function printLoadedPage(result: IMMemoryExternalLoadResult): void {
  const { page } = result;
  process.stdout.write(`${page.path} (${page.sourceWorkspaceId}, ${page.via})\n`);
  if (page.title) process.stdout.write(`# ${page.title}\n\n`);
  if (page.content) {
    process.stdout.write(`${page.content}\n`);
  } else if (page.contentHtml) {
    process.stdout.write(`${page.contentHtml}\n`);
  } else {
    process.stdout.write('(empty page body)\n');
  }
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const memoryGrant = parent
    .command('memory-grant')
    .description(
      'Cross-workspace memory grants (memory211/05 W3) — owner diagnostics for the cloud grant ledger',
    );

  memoryGrant
    .command('create')
    .description('Grant a target workspace read access to this workspace shareable memory band')
    .requiredOption('--target <workspaceId>', 'Target workspace id (the receiving side)')
    .option('--expires-in-days <n>', 'Lifetime in days, 1..365 (default 30)', (v) => Number(v))
    .option('--workspace <sourceWorkspaceId>', 'Source (granting) workspace; defaults to your default workspace')
    .option('--json', 'Output JSON')
    .action(async (opts: { target: string; expiresInDays?: number; workspace?: string; json?: boolean }) => {
      if (
        opts.expiresInDays !== undefined &&
        (!Number.isInteger(opts.expiresInDays) || opts.expiresInDays < 1 || opts.expiresInDays > 365)
      ) {
        fail('--expires-in-days must be an integer between 1 and 365');
      }
      const client = getIMClient();
      const res = await client.im.memory.grants.create({
        targetWorkspaceId: opts.target,
        ...(opts.expiresInDays !== undefined ? { expiresInDays: opts.expiresInDays } : {}),
        ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
      });
      if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
      emit(res.data, opts.json === true, () => printGrant(res.data!, 'Grant created'));
    });

  memoryGrant
    .command('list')
    .description('List grants THIS workspace has granted to others (source perspective)')
    .option('--workspace <sourceWorkspaceId>', 'Source workspace; defaults to your default workspace')
    .option('--json', 'Output JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      const client = getIMClient();
      const res = await client.im.memory.grants.list(opts.workspace ? { workspaceId: opts.workspace } : undefined);
      if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
      emit(res.data, opts.json === true, () => printGrantTable(res.data ?? [], 'No grants granted.'));
    });

  memoryGrant
    .command('incoming')
    .description('List grants THIS workspace has received from others (target perspective)')
    .option('--workspace <targetWorkspaceId>', 'Target workspace; defaults to your default workspace')
    .option('--json', 'Output JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      const client = getIMClient();
      const res = await client.im.memory.grants.incoming(
        opts.workspace ? { workspaceId: opts.workspace } : undefined,
      );
      if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
      emit(res.data, opts.json === true, () => printGrantTable(res.data ?? [], 'No incoming grants.'));
    });

  memoryGrant
    .command('search')
    .description('Search a granted source workspace from the target workspace perspective')
    .requiredOption('--source <sourceWorkspaceId>', 'Source (granting) workspace to search')
    .requiredOption('--query <text>', 'Search query')
    .option('--workspace <targetWorkspaceId>', 'Target (consuming) workspace; defaults to your default workspace')
    .option('--limit <n>', 'Hits per query, 1..50', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (opts: { source: string; query: string; workspace?: string; limit?: number; json?: boolean }) => {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50)) {
        fail('--limit must be an integer between 1 and 50');
      }
      const query = opts.query.trim();
      if (!query) fail('--query must not be empty');
      const client = getIMClient();
      const res = await client.im.memory.externalSearch({
        sourceWorkspaceId: opts.source,
        queries: [query],
        ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
      emit(res.data, opts.json === true, () => printSearchHits(res.data?.results ?? [], 'No grant recall hits.'));
    });

  memoryGrant
    .command('load')
    .description('Load a page from a granted source workspace')
    .requiredOption('--source <sourceWorkspaceId>', 'Source (granting) workspace to load from')
    .requiredOption('--path <path>', 'Band-relative page path')
    .option('--workspace <targetWorkspaceId>', 'Target (consuming) workspace; defaults to your default workspace')
    .option('--format <format>', 'markdown, html, or both', 'markdown')
    .option('--json', 'Output JSON')
    .action(
      async (opts: {
        source: string;
        path: string;
        workspace?: string;
        format?: 'markdown' | 'html' | 'both' | string;
        json?: boolean;
      }) => {
        if (opts.format !== 'markdown' && opts.format !== 'html' && opts.format !== 'both') {
          fail('--format must be one of markdown, html, both');
        }
        const client = getIMClient();
        const res = await client.im.memory.externalLoad({
          sourceWorkspaceId: opts.source,
          path: opts.path,
          format: opts.format,
          ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
        });
        if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
        emit(res.data, opts.json === true, () => printLoadedPage(res.data!));
      },
    );

  memoryGrant
    .command('revoke <grantId>')
    .description('Soft-revoke a grant (idempotent; the row stays as a revoked ledger marker)')
    .option('--json', 'Output JSON')
    .action(async (grantId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.im.memory.grants.revoke(grantId);
      if (!res.ok) fail(`${res.error?.code ?? 'http_error'}: ${res.error?.message ?? 'request failed'}`);
      emit(res.data, opts.json === true, () => printGrant(res.data!, 'Grant revoked'));
    });
}
