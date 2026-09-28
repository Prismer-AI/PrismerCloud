// memory211/01 W3 轴D — daemon-side T3 ingestion (availability leg, local-first).
//
// The daemon owns the upload→corpus leg for the files it can read locally:
//
//   md / txt / pkf  → read the cached bytes, strip markup, chunk (deterministic)
//   pdf             → `lit --no-ocr` (the bundled liteparse Tier-1 CLI — digital-
//                     PDF fast path, no OCR), falling back to full `lit` (OCR)
//                     when the digital parse yields nothing. 60s timeout.
//
// and mirrors the result into the LOCAL `asset_chunks` table (store.ts V5) so
// recall stays fully offline (F2 裁决), then uploads the same rows to the cloud
// authoritative `im_asset_chunks` through the existing outbox channel
// (`asset.chunk.upsert`), idempotent on (workspaceId, assetId, contentHash,
// ordinal).
//
// CHUNKING CONTRACT (mirrored from cloud `src/im/services/asset-chunk-index.service.ts`
// — the two implementations MUST stay byte-compatible or the cloud/daemon row
// sets diverge; they are text-identical algorithms, cross-referenced by comment.
// A shared package would be the cleaner long-term fix but `sdk/` is deliberately
// independent of the cloud tree).
//
// pdf parsing is DETERMINISTIC and OFFLINE: liteparse is baked into the image
// (PDFium + Tesseract, no LLM) — see built-in-skills/liteparse/SKILL.md Tier-1.

import { detectFormat, parsePkf } from '@prismer/pkf';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStore } from './store.js';
import { MemoryOutbox } from './outbox.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('AssetChunks');

/** Chunk target ≈ 2K tokens (spec 开放裁决点 7 default). MUST match the cloud. */
export const CHUNK_TARGET_TOKENS = 2000;
/** Chunk overlap = 10% of the target. MUST match the cloud. */
export const CHUNK_OVERLAP_RATIO = 0.1;

/** Hard cap: files above this are not chunked in-process (daemon reaps later). */
export const MAX_CHUNK_SOURCE_BYTES = 8 * 1024 * 1024;

/** `lit` timeout (spec 轴D: 60s) — a hung parser must never pin the daemon. */
export const LITEPARSE_TIMEOUT_MS = 60_000;

export interface AssetChunkRow {
  ordinal: number;
  text: string;
  tokenEstimate: number;
}

/** The CJK ranges the token estimator treats as ~1 token per char. */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/** ASCII ≈ 4 chars/token; CJK ≈ 1 char/token. MUST match the cloud estimator. */
export function estimateChunkTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (isCjkCodePoint(ch.codePointAt(0) ?? 0)) cjk += 1;
  }
  const other = text.length - cjk;
  return Math.ceil(other / 4) + cjk;
}

/**
 * Token total of `estimateChunkTokens` over a slice, from ALREADY-COUNTED parts —
 * and on the SAME BASIS the estimator uses: `other` is measured in UTF-16 CODE
 * UNITS (`text.length`), `cjk` in CODE POINTS, so an astral (surrogate-pair)
 * character contributes 2 to `other`. `tokensFromCounts(units, cjk)` therefore
 * takes the slice's UTF-16 length, not a code-point count.
 *
 *   W3 review F-1 — the naive form rescanned the whole accumulated slice per
 *   appended character (O(n²) per chunk; 8MB → ~40s of event-loop time).
 *   W3 review F2-1 — the first incremental form counted `other` per CODE POINT,
 *   which under-counted astral text by half per char and let blocks through with
 *   a stored `tokenEstimate` above the budget (the old algorithm had zero such
 *   blocks). Counting on the estimator's own basis restores the invariant and
 *   keeps the scan O(n).
 *
 * PROJECT-WIDE DEFINITION (W5 E15, the one-line note the W3 fix-round review
 * asked for): this 0.5-token-per-astral-character quirk is the CANONICAL token
 * basis on BOTH sides of the boundary — the cloud chunker
 * (src/im/services/asset-chunk-index.service.ts) computes the identical
 * `ceil((utf16Units - cjk) / 4) + cjk`. Do NOT "fix" one side to code points:
 * that would desynchronise the stored `tokenEstimate` from the other side's
 * budget decisions.
 */
function tokensFromCounts(units: number, cjk: number): number {
  return Math.ceil((units - cjk) / 4) + cjk;
}

/** Deterministic chunker — byte-identical contract with the cloud implementation. */
export function chunkPlainText(text: string): AssetChunkRow[] {
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const chunks: AssetChunkRow[] = [];
  const chars = Array.from(normalized);
  // F-1 — per-character CJK flags computed ONCE, so the budget scan is two
  // running counters instead of a full-string rescan per appended char (O(n)
  // total, same decisions as the estimator).
  const isCjk = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i += 1) {
    isCjk[i] = isCjkCodePoint(chars[i]!.codePointAt(0) ?? 0) ? 1 : 0;
  }
  let start = 0;

  while (start < chars.length) {
    let end = start;
    let units = 0; // UTF-16 code units in [start, end) — the estimator's basis
    let cjk = 0; // CJK code points in [start, end)
    while (end < chars.length) {
      const isCjkChar = isCjk[end] === 1;
      const nextUnits = units + chars[end]!.length; // 1, or 2 for an astral pair
      const nextCjk = cjk + (isCjkChar ? 1 : 0);
      if (tokensFromCounts(nextUnits, nextCjk) > CHUNK_TARGET_TOKENS && end > start) break;
      units = nextUnits;
      cjk = nextCjk;
      end += 1;
    }
    if (end <= start) break;

    const windowStart = start + Math.floor((end - start) * 0.85);
    let cut = end;
    for (let i = end - 1; i > windowStart && i > start; i -= 1) {
      const ch = chars[i];
      if (ch === '\n') {
        cut = i + 1;
        break;
      }
      if (ch === ' ' || ch === '\t') {
        cut = i + 1;
        // keep scanning: a later newline is the better cut
      }
    }
    if (cut <= start) cut = end;

    const trimmed = chars.slice(start, cut).join('').trim();
    if (trimmed.length > 0) {
      chunks.push({ ordinal: chunks.length, text: trimmed, tokenEstimate: estimateChunkTokens(trimmed) });
    }

    const advanceChars = Math.max(1, cut - start);
    const overlapChars = Math.min(
      Math.floor(advanceChars * CHUNK_OVERLAP_RATIO),
      Math.floor(advanceChars / 2),
    );
    start = advanceChars > overlapChars ? start + advanceChars - overlapChars : start + advanceChars;
    if (cut >= chars.length) break;
  }

  return chunks;
}

export type ChunkableKind = 'text' | 'pdf' | 'unsupported';

/** Whitelist + routing (mirror of the cloud resolver). */
export function resolveChunkKind(filename: string | null | undefined): ChunkableKind {
  const name = (filename ?? '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (['md', 'markdown', 'txt', 'pkf'].includes(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  return 'unsupported';
}

/**
 * Strip PKF/HTML markup so a chunk holds readable text (D2 parity).
 *
 * memory211/01 W5 E (W2-M5) — this is the DAEMON TWIN of the cloud's
 * `pkfToPlainText` (src/im/services/memory-plaintext.ts), aligned field for
 * field: frontmatter `title`/`description`/`tags` PREPENDED (those live in the
 * markup-invisible script, so a raw tag-strip loses them), then the sanitized
 * body tag-stripped, then whitespace collapsed. The old version dropped the
 * frontmatter AND left `<prismer-data>` config scripts in the haystack, so the
 * daemon's chunks and the cloud's page projection indexed DIFFERENT text for
 * the same page.
 *
 * The two implementations cannot share a module (independent npm projects), so
 * the anti-drift guard is a shared literal vector test: cloud
 * `acp-memory-search-payload`-style vector pinned in
 * `test/memory-w5-plaintext-parity.test.ts` mirrors the cloud expectation for
 * the SAME input strings. No packages are imported across that boundary.
 *
 * Never throws: a parse failure degrades to the whitespace-normalised raw
 * input (a strictly larger, never-empty haystack) — same contract as the cloud.
 */
function normalizeWhitespace(x: string): string {
  return x.replace(/\s+/g, ' ').trim();
}

function stripTags(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, ' ');
  return noTags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    // The bundled parser re-escapes a literal `&` in safeHtml as `&#x26;`
    // (the cloud's hast serializer emits `&amp;` — the cloud stripTags decodes
    // that one). Both forms must land on a bare `&` or the two projections
    // index different bytes for the same document.
    .replace(/&#x26;/gi, '&')
    .replace(/&#0?38;/g, '&');
}

/** Entity decode + whitespace collapse for a NON-PKF (markdown/txt) source. */
function plainMarkdown(content: string): string {
  return normalizeWhitespace(stripTags(content));
}

export function pkfToPlainTextLocal(content: string): string {
  if (!content) return '';
  // Fast path — same as the cloud: a markdown source has no PKF markup, so skip
  // the parse entirely and index it verbatim (whitespace-normalised). Without
  // this, a markdown body fed through the PKF parser loses its `#` headings.
  if (detectFormat(content) !== 'pkf') return plainMarkdown(content);
  let parsed;
  try {
    parsed = parsePkf(content);
  } catch {
    return normalizeWhitespace(content);
  }
  const fm = parsed.frontmatter;
  const head: string[] = [];
  if (fm?.title) head.push(fm.title);
  if (fm?.description) head.push(fm.description);
  if (fm?.tags?.length) head.push(fm.tags.join(' '));
  const body = stripTags(parsed.safeHtml ?? content);
  return normalizeWhitespace([...head, body].join(' '));
}

function plainTextFor(content: string, filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext !== 'pkf') return plainMarkdown(content);
  return pkfToPlainTextLocal(content);
}

export interface LiteparseResult {
  markdown: string;
  via: 'lit-digital' | 'lit-ocr';
}

/**
 * Run the bundled liteparse `lit` CLI over a PDF. Digital fast path first
 * (`--no-ocr`); an empty/failed digital parse falls back to the OCR pass.
 * Both runs are bounded by LITEPARSE_TIMEOUT_MS and killed (SIGKILL) on expiry.
 */
export async function parsePdfWithLiteparse(pdf: Buffer): Promise<LiteparseResult> {
  const dir = await mkdtemp(join(tmpdir(), 'prismer-lit-'));
  const input = join(dir, 'input.pdf');
  const output = join(dir, 'out.md');
  await writeFile(input, pdf);
  try {
    const digital = await runLit(input, output, true);
    if (digital.trim().length > 0) return { markdown: digital, via: 'lit-digital' };
    const ocr = await runLit(input, output, false);
    return { markdown: ocr, via: 'lit-ocr' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLit(input: string, output: string, noOcr: boolean): Promise<string> {
  const args = [input, '--output', output, ...(noOcr ? ['--no-ocr'] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('lit', args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lit timed out after ${LITEPARSE_TIMEOUT_MS}ms (noOcr=${noOcr})`));
    }, LITEPARSE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`lit exited ${code} (noOcr=${noOcr})`));
    });
  });
  return readFile(output, 'utf8');
}

export interface IngestAssetFileResult {
  assetId: string;
  kind: ChunkableKind;
  chunks: number;
  status: 'indexed' | 'skipped';
  reason?: string;
  via?: 'lit-digital' | 'lit-ocr';
}

/**
 * Chunk one already-cached asset file into the local mirror + the cloud
 * authoritative table. Never throws into the caller (the materialize ack path
 * must not regress because chunking failed) — failures are returned as
 * `status:'skipped'` with a reason and logged.
 */
export async function ingestAssetFile(input: {
  store: MemoryStore;
  outbox: MemoryOutbox;
  assetId: string;
  contentHash: string;
  filename: string | null;
  bytes: Buffer;
}): Promise<IngestAssetFileResult> {
  const { store, outbox, assetId, contentHash, filename, bytes } = input;
  try {
    const kind = resolveChunkKind(filename);
    if (kind === 'unsupported') {
      return { assetId, kind, chunks: 0, status: 'skipped', reason: 'type not in whitelist' };
    }
    if (bytes.length > MAX_CHUNK_SOURCE_BYTES) {
      return { assetId, kind, chunks: 0, status: 'skipped', reason: `${bytes.length} bytes over budget` };
    }

    let markdown: string;
    let via: 'lit-digital' | 'lit-ocr' | undefined;
    if (kind === 'pdf') {
      try {
        const parsed = await parsePdfWithLiteparse(bytes);
        markdown = parsed.markdown;
        via = parsed.via;
      } catch (err) {
        // parse failure is NOT a chunk failure: skip loudly, never block the ack
        log.warn(`liteparse failed asset=${assetId}: ${(err as Error).message}`);
        return { assetId, kind, chunks: 0, status: 'skipped', reason: (err as Error).message };
      }
    } else {
      markdown = plainTextFor(bytes.toString('utf8'), filename ?? '');
    }

    const rows = chunkPlainText(markdown);
    if (rows.length === 0) {
      return { assetId, kind, chunks: 0, status: 'skipped', reason: 'no text content' };
    }

    // (a) local mirror first — offline recall must work even if the upload fails
    store.replaceAssetChunks({ assetId, contentHash, filename, rows });

    // (b) cloud authoritative rows via the existing outbox channel (idempotent:
    // the cloud upsert keys on workspaceId+assetId+contentHash+ordinal)
    for (const row of rows) {
      outbox.enqueue({
        schemaVersion: 1,
        eventType: 'asset.chunk.upsert',
        eventId: `chunk_${assetId}_${contentHash.slice(0, 8)}_${row.ordinal}`,
        workspaceId: store.workspaceId(),
        actorImUserId: 'cloud-sync',
        actorKind: 'agent',
        deviceId: store.deviceId(),
        createdAt: new Date().toISOString(),
        idempotencyKey: `asset.chunk.upsert:${store.workspaceId()}:${assetId}:${contentHash}:${row.ordinal}`,
        payload: {
          assetId,
          contentHash,
          ordinal: row.ordinal,
          text: row.text,
          tokenEstimate: row.tokenEstimate,
          ...(filename ? { filename } : {}),
        },
      });
    }

    log.info(
      `ingested asset=${assetId} kind=${kind} chunks=${rows.length}${via ? ` via=${via}` : ''}`,
    );
    return { assetId, kind, chunks: rows.length, status: 'indexed', ...(via ? { via } : {}) };
  } catch (err) {
    log.warn(`ingest failed asset=${assetId}: ${(err as Error).message}`);
    return { assetId, kind: 'unsupported', chunks: 0, status: 'skipped', reason: (err as Error).message };
  }
}
