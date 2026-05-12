/**
 * Asset manifest renderer (doc 27 rev 5 §3 — light-weight indexer).
 *
 * Pure function: takes a list of IMAsset rows and returns deterministic
 * markdown grouped by folderPath then by mime. Intentionally has no
 * dependencies on Prisma / Hono / process state so it can be unit-tested
 * in isolation.
 *
 * What it includes per row: filename / mime / size / description /
 * createdAt + canonical prismer:// URI.
 *
 * What it deliberately does NOT include: file content, HQCC / INTR,
 * compressed snippets, or any value that would imply daemon-side
 * pre-processing. Doc 27 rev 5 §1 explicitly forbids that — the agent
 * decides whether to open the file based on the manifest, then writes a
 * memory page itself if the read produced durable knowledge.
 */

export interface AssetManifestRow {
  filename: string | null;
  folderPath: string | null;
  mime: string | null;
  sizeBytes: bigint | null;
  contentHash: string;
  createdAt: Date;
  /** Optional — populated once Line B Phase 1 lands the IMAsset.description column. */
  description?: string | null;
}

export function renderAssetManifestMarkdown(workspaceId: string, rows: AssetManifestRow[]): string {
  const lines: string[] = [];
  lines.push(`# Workspace ${workspaceId} — asset manifest`);
  lines.push('');
  lines.push(`${rows.length} asset${rows.length === 1 ? '' : 's'} indexed.`);
  lines.push('');
  if (rows.length === 0) return ensureTrailingNewline(lines.join('\n'));

  // Group: folderPath → mime → rows.
  const byFolder = new Map<string, Map<string, AssetManifestRow[]>>();
  for (const row of rows) {
    const folderKey = row.folderPath && row.folderPath.length > 0 ? row.folderPath : '(root)';
    const mimeKey = row.mime && row.mime.length > 0 ? row.mime : '(unknown mime)';
    let mimeBucket = byFolder.get(folderKey);
    if (!mimeBucket) {
      mimeBucket = new Map();
      byFolder.set(folderKey, mimeBucket);
    }
    let rowBucket = mimeBucket.get(mimeKey);
    if (!rowBucket) {
      rowBucket = [];
      mimeBucket.set(mimeKey, rowBucket);
    }
    rowBucket.push(row);
  }

  for (const folderKey of [...byFolder.keys()].sort()) {
    lines.push(`## ${folderKey}`);
    lines.push('');
    const mimeBucket = byFolder.get(folderKey)!;
    for (const mimeKey of [...mimeBucket.keys()].sort()) {
      lines.push(`### ${mimeKey}`);
      lines.push('');
      for (const row of mimeBucket.get(mimeKey)!) {
        const name = row.filename ?? row.contentHash.slice(0, 12);
        const size = humanBytes(row.sizeBytes);
        const ts = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
        const desc = row.description ? ` — ${row.description}` : '';
        const uri = `prismer://workspace/${workspaceId}/asset/${row.contentHash}`;
        lines.push(`- [${name}](${uri}) (${size}) — uploaded ${ts}${desc}`);
      }
      lines.push('');
    }
  }
  return ensureTrailingNewline(lines.join('\n'));
}

export function humanBytes(b: bigint | null): string {
  if (b == null) return '? B';
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
