// `cloud asset (list|get|by-hash|upload|download|read|sync)` — workspace asset CLI.
//
// Backs the v2.0 `assets` built-in skill (see sdk/prismer-cloud/built-in-skills/assets/SKILL.md).
// Cloud API: /api/im/assets (see src/im/api/assets.ts).

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { PrismerClient } from '../index';
import type { IMAsset, IMAssetDetail } from '../types';

type ClientFactory = () => PrismerClient;

// ---------------------------------------------------------------------------
// Workspace resolution: --workspace-id flag > PRISMER_WORKSPACE_ID env
// ---------------------------------------------------------------------------
function resolveWorkspaceId(flag?: string): string | undefined {
  if (flag) return flag;
  if (typeof process !== 'undefined' && process.env?.PRISMER_WORKSPACE_ID) {
    return process.env.PRISMER_WORKSPACE_ID;
  }
  return undefined;
}

function requireWorkspaceId(flag?: string): string {
  const wsId = resolveWorkspaceId(flag);
  if (!wsId) {
    process.stderr.write('Error: --workspace-id is required (or set PRISMER_WORKSPACE_ID env var).\n');
    process.exit(1);
  }
  return wsId;
}

// Minimal glob → RegExp (supports * and ?). Anchored.
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}

// Try to surface a filename from an asset row. Server may attach `filename`
// (autocomplete mode) or expose it via `metadata.filename`.
function assetFilename(a: IMAsset & { filename?: string | null }): string | null {
  if (a.filename) return a.filename;
  const meta = a.metadata as Record<string, unknown> | undefined;
  if (meta) {
    const fn = meta['filename'] ?? meta['fileName'] ?? meta['name'];
    if (typeof fn === 'string') return fn;
  }
  return null;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  return String(n);
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const asset = parent
    .command('asset')
    .description('Inspect and manage workspace assets (content-addressed)');

  // -------------------------------------------------------------------------
  // asset list
  // -------------------------------------------------------------------------
  asset
    .command('list')
    .description('List assets in a workspace')
    .option('--workspace-id <id>', 'workspace id (defaults to PRISMER_WORKSPACE_ID env)')
    .option('--filename <glob>', 'filter by filename glob (client-side, e.g. "design-doc*")')
    .option('--mime <type>', 'filter by MIME type prefix (e.g. "application/pdf")')
    .option('--kind <kind>', 'filter by row-level kind (e.g. file, image, sandbox-output)')
    .option('--updated-after <iso>', 'filter to assets created/updated after this ISO timestamp')
    .option('--task-id <id>', 'filter by source task id')
    .option('-n, --limit <n>', 'maximum results to return', '50')
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      workspaceId?: string;
      filename?: string;
      mime?: string;
      kind?: string;
      updatedAfter?: string;
      taskId?: string;
      limit: string;
      json?: boolean;
    }) => {
      const wsId = requireWorkspaceId(opts.workspaceId);
      const client = getIMClient();
      try {
        const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
        const res = await client.im.assets.list({
          workspaceId: wsId,
          taskId: opts.taskId,
          kind: opts.kind,
          limit,
        });

        if (!res.ok) {
          if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          else process.stderr.write(`Error: ${res.error?.message || 'list failed'}\n`);
          process.exit(1);
        }

        let rows = (res.data ?? []) as Array<IMAsset & { filename?: string | null }>;

        // Client-side filters: filename glob, MIME prefix, updatedAfter.
        if (opts.filename) {
          const re = globToRegex(opts.filename);
          rows = rows.filter((r) => {
            const fn = assetFilename(r);
            return fn != null && re.test(fn);
          });
        }
        if (opts.mime) {
          const m = opts.mime.toLowerCase();
          rows = rows.filter((r) => (r.mime ?? '').toLowerCase().startsWith(m));
        }
        if (opts.updatedAfter) {
          const after = Date.parse(opts.updatedAfter);
          if (!Number.isNaN(after)) {
            rows = rows.filter((r) => {
              const ts = Date.parse(r.createdAt ?? '');
              return !Number.isNaN(ts) && ts >= after;
            });
          }
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: true, data: rows }, null, 2) + '\n');
          return;
        }

        if (rows.length === 0) {
          process.stdout.write('No assets found.\n');
          return;
        }

        const idW = 24;
        const mimeW = 20;
        const sizeW = 12;
        const hashW = 16;
        const header =
          'ID'.padEnd(idW) +
          'MIME'.padEnd(mimeW) +
          'SIZE'.padEnd(sizeW) +
          'HASH'.padEnd(hashW) +
          'NAME';
        process.stdout.write(header + '\n');
        process.stdout.write('-'.repeat(idW + mimeW + sizeW + hashW + 20) + '\n');
        for (const r of rows) {
          const id = String(r.id).slice(0, idW - 1);
          const mime = (r.mime ?? '-').slice(0, mimeW - 1);
          const size = formatBytes(r.sizeBytes).slice(0, sizeW - 1);
          const hash = (r.contentHash ?? '-').slice(0, 12);
          const name = assetFilename(r) ?? '';
          process.stdout.write(
            id.padEnd(idW) +
            mime.padEnd(mimeW) +
            size.padEnd(sizeW) +
            hash.padEnd(hashW) +
            name + '\n',
          );
        }
        process.stdout.write(`\n${rows.length} asset(s) listed.\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset get <assetId>
  // -------------------------------------------------------------------------
  asset
    .command('get <assetId>')
    .description('Show full asset metadata (no content)')
    .option('--json', 'output raw JSON response')
    .action(async (assetId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.assets.detail(assetId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          if (!res.ok) process.exit(1);
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'get failed'}\n`);
          process.exit(1);
        }
        const a = res.data as IMAssetDetail;
        process.stdout.write(`ID:           ${a.id}\n`);
        process.stdout.write(`Workspace:    ${a.workspaceId}\n`);
        process.stdout.write(`Hash:         ${a.contentHash}\n`);
        process.stdout.write(`MIME:         ${a.mime ?? '-'}\n`);
        process.stdout.write(`Size:         ${formatBytes(a.sizeBytes)} bytes\n`);
        process.stdout.write(`Kind:         ${a.kind}\n`);
        process.stdout.write(`Storage URI:  ${a.storageUri}\n`);
        process.stdout.write(`Created:      ${a.createdAt}\n`);
        const fn = assetFilename(a);
        if (fn) process.stdout.write(`Filename:     ${fn}\n`);
        if (a.sourceTaskId) process.stdout.write(`Source Task:  ${a.sourceTaskId}\n`);
        if (a.sourceAgentImUserId) process.stdout.write(`Source Agent: ${a.sourceAgentImUserId}\n`);
        if (a.cdnUrl) process.stdout.write(`CDN URL:      ${a.cdnUrl}\n`);
        if (a.url) process.stdout.write(`Signed URL:   ${a.url} (expires in ${a.expiresIn ?? '?'}s)\n`);
        if (a.metadata && Object.keys(a.metadata).length > 0) {
          process.stdout.write(`Metadata:     ${JSON.stringify(a.metadata)}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset by-hash <sha256>
  // -------------------------------------------------------------------------
  asset
    .command('by-hash <sha256>')
    .description('Look up an asset by content hash (sha256)')
    .option('--workspace-id <id>', 'workspace id (defaults to PRISMER_WORKSPACE_ID env)')
    .option('--json', 'output raw JSON response')
    .action(async (sha256: string, opts: { workspaceId?: string; json?: boolean }) => {
      const wsId = requireWorkspaceId(opts.workspaceId);
      const client = getIMClient();
      try {
        const res = await client.im.assets.byHash(sha256, wsId);
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          if (!res.ok) process.exit(1);
          return;
        }
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'by-hash failed'}\n`);
          process.exit(1);
        }
        const a = res.data as IMAsset;
        process.stdout.write(`ID:    ${a.id}\n`);
        process.stdout.write(`Hash:  ${a.contentHash}\n`);
        process.stdout.write(`MIME:  ${a.mime ?? '-'}\n`);
        process.stdout.write(`Size:  ${formatBytes(a.sizeBytes)} bytes\n`);
        process.stdout.write(`Kind:  ${a.kind}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset upload <path>
  // -------------------------------------------------------------------------
  asset
    .command('upload <path>')
    .description('Upload a local file as a workspace asset')
    .option('--workspace-id <id>', 'workspace id (defaults to PRISMER_WORKSPACE_ID env)')
    .option('--conversation-id <id>', 'pin upload to a conversation (stored in metadata)')
    .option('--kind <kind>', 'asset kind label', 'user-upload')
    .option('--task-id <id>', 'source task id')
    .option('--mime <type>', 'override detected MIME type')
    .option('--filename <name>', 'override filename')
    .option('--json', 'output raw JSON response')
    .action(async (filePath: string, opts: {
      workspaceId?: string;
      conversationId?: string;
      kind?: string;
      taskId?: string;
      mime?: string;
      filename?: string;
      json?: boolean;
    }) => {
      const wsId = requireWorkspaceId(opts.workspaceId);
      if (!fs.existsSync(filePath)) {
        process.stderr.write(`Error: file not found: ${filePath}\n`);
        process.exit(1);
      }
      const client = getIMClient();
      try {
        const metadata: Record<string, unknown> = {};
        if (opts.conversationId) metadata.conversationId = opts.conversationId;
        if (opts.filename) metadata.filename = opts.filename;

        const uploadOpts: Record<string, unknown> = {
          workspaceId: wsId,
          kind: opts.kind ?? 'user-upload',
        };
        if (opts.taskId) uploadOpts.sourceTaskId = opts.taskId;
        if (opts.mime) uploadOpts.mimeType = opts.mime;
        if (opts.filename) uploadOpts.fileName = opts.filename;
        if (Object.keys(metadata).length > 0) uploadOpts.metadata = metadata;

        const res = await client.im.assets.upload(filePath, uploadOpts as any);

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          if (!res.ok) process.exit(1);
          return;
        }

        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'upload failed'}\n`);
          process.exit(1);
        }

        const a = res.data as IMAsset;
        process.stdout.write(`Uploaded ${path.basename(filePath)}\n`);
        process.stdout.write(`  ID:    ${a.id}\n`);
        process.stdout.write(`  Hash:  ${a.contentHash}\n`);
        process.stdout.write(`  Size:  ${formatBytes(a.sizeBytes)} bytes\n`);
        process.stdout.write(`  MIME:  ${a.mime ?? '-'}\n`);
        process.stdout.write(`  Kind:  ${a.kind}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset download <assetId>
  // -------------------------------------------------------------------------
  asset
    .command('download <assetId>')
    .description('Download asset bytes (to file or stdout)')
    .option('--out <path>', 'destination file (omit to write to stdout)')
    .option('--offset <n>', 'byte offset for partial download', parseIntOpt)
    .option('--length <n>', 'byte length for partial download', parseIntOpt)
    .action(async (assetId: string, opts: { out?: string; offset?: number; length?: number }) => {
      try {
        const { bytes, truncated, totalSize } = await fetchAssetBytes(
          getIMClient(),
          assetId,
          opts.offset,
          opts.length,
        );
        if (opts.out) {
          fs.writeFileSync(opts.out, bytes);
          const range = describeRange(opts.offset, opts.length, bytes.byteLength);
          process.stderr.write(
            `Downloaded ${assetId} -> ${opts.out} (${bytes.byteLength} bytes${range ? `, ${range}` : ''}${truncated ? ', truncated' : ''}${totalSize != null ? `, total=${totalSize}` : ''})\n`,
          );
        } else {
          process.stdout.write(bytes);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset read <assetId>
  // -------------------------------------------------------------------------
  asset
    .command('read <assetId>')
    .description('Read an asset as text (bounded by --offset/--length)')
    .option('--offset <n>', 'byte offset for read', parseIntOpt)
    .option('--length <n>', 'maximum bytes to read (recommended for large files)', parseIntOpt)
    .option('--force', 'read even if MIME is not text-like')
    .action(async (assetId: string, opts: { offset?: number; length?: number; force?: boolean }) => {
      const client = getIMClient();
      try {
        // 1. Describe to confirm MIME / hash for the locator footer.
        const detailRes = await client.im.assets.detail(assetId);
        if (!detailRes.ok) {
          process.stderr.write(`Error: ${detailRes.error?.message || 'asset get failed'}\n`);
          process.exit(1);
        }
        const detail = detailRes.data as IMAssetDetail;
        const mime = (detail.mime ?? '').toLowerCase();
        const looksTextual =
          mime.startsWith('text/') ||
          mime === 'application/json' ||
          mime === 'application/xml' ||
          mime === 'application/javascript' ||
          mime === 'application/x-yaml' ||
          mime.endsWith('+json') ||
          mime.endsWith('+xml');

        if (!looksTextual && !opts.force) {
          process.stderr.write(
            `Refusing to read non-text asset (mime=${detail.mime ?? 'unknown'}). Use --force to override, or use "cloud asset download" for binary content.\n`,
          );
          process.exit(1);
        }

        // 2. Fetch bytes for the requested range.
        const { bytes, truncated, totalSize } = await fetchAssetBytes(
          client,
          assetId,
          opts.offset,
          opts.length,
        );

        // 3. Print content. Best-effort UTF-8 decode; partial-token edge at the
        // tail is the caller's responsibility (warned in the locator footer).
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        process.stdout.write(text);
        if (text.length > 0 && !text.endsWith('\n')) process.stdout.write('\n');

        // 4. One-line locator footer on stderr so it doesn't pollute piped content.
        const start = opts.offset ?? 0;
        const end = start + bytes.byteLength;
        const range = `${start}..${end}`;
        process.stderr.write(
          `asset=${detail.id} hash=${detail.contentHash} range=${range} bytes=${bytes.byteLength} truncated=${truncated}${totalSize != null ? ` total=${totalSize}` : ''}\n`,
        );
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // asset sync
  // -------------------------------------------------------------------------
  asset
    .command('sync')
    .description('Refresh the local cache index by re-listing the workspace')
    .option('--workspace-id <id>', 'workspace id (defaults to PRISMER_WORKSPACE_ID env)')
    .option('-n, --limit <n>', 'maximum results to walk', '200')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { workspaceId?: string; limit: string; json?: boolean }) => {
      const wsId = requireWorkspaceId(opts.workspaceId);
      const client = getIMClient();
      try {
        const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 200);
        const res = await client.im.assets.list({ workspaceId: wsId, limit });
        if (!res.ok) {
          if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          else process.stderr.write(`Error: ${res.error?.message || 'sync failed'}\n`);
          process.exit(1);
        }
        const count = (res.data ?? []).length;
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: true, data: { workspaceId: wsId, count } }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Synced ${count} asset(s) for workspace ${wsId}.\n`);
        process.stdout.write(
          'Note: asset bytes are fetched lazily on first read; this command refreshes metadata only.\n',
        );
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntOpt(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`expected non-negative integer, got "${value}"`);
  }
  return n;
}

function describeRange(offset?: number, length?: number, actual?: number): string | null {
  if (offset == null && length == null) return null;
  const start = offset ?? 0;
  const end = start + (actual ?? length ?? 0);
  return `range=${start}..${end}`;
}

/**
 * Fetch asset bytes with optional Range header. Uses the public AssetsClient
 * URL builder + `PrismerClient.fetchAuthed()` so auth headers are applied the
 * same way as the typed sub-clients. Adds Range support that
 * `client.im.assets.download()` doesn't.
 *
 * Returns the bytes plus a `truncated` flag set when length was specified and
 * the returned content matches that length (i.e. we capped a larger body).
 */
async function fetchAssetBytes(
  client: PrismerClient,
  assetId: string,
  offset?: number,
  length?: number,
): Promise<{ bytes: Uint8Array; truncated: boolean; totalSize: number | null }> {
  const url = client.im.assets.url(assetId);

  const headers: Record<string, string> = {};
  if (offset != null || length != null) {
    const start = offset ?? 0;
    const end = length != null ? start + length - 1 : '';
    headers['Range'] = `bytes=${start}-${end}`;
  }

  const resp = await client.fetchAuthed(url, { method: 'GET', headers });
  if (!resp.ok && resp.status !== 206) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    throw new Error(`Asset fetch failed (${resp.status}): ${detail || resp.statusText}`);
  }

  const ab = await resp.arrayBuffer();
  const bytes = new Uint8Array(ab);

  // Parse Content-Range when present: "bytes 0-1023/1048576"
  let totalSize: number | null = null;
  const cr = resp.headers.get('content-range');
  if (cr) {
    const m = cr.match(/\/(\d+)$/);
    if (m) totalSize = Number(m[1]);
  } else {
    const cl = resp.headers.get('content-length');
    if (cl) totalSize = Number(cl);
  }

  // `truncated` = caller asked for fewer bytes than total exists.
  let truncated = false;
  if (length != null) {
    if (totalSize != null) {
      const start = offset ?? 0;
      truncated = start + bytes.byteLength < totalSize;
    } else {
      truncated = bytes.byteLength >= length;
    }
  } else if (offset != null && totalSize != null) {
    truncated = offset + bytes.byteLength < totalSize;
  }

  return { bytes, truncated, totalSize };
}
