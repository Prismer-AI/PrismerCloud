/**
 * Skill manifest v1 — agentskills.io-compliant multi-file packaging.
 *
 * §A.7.2 spec:
 *   manifest = [{path, size, sha256, content?(base64), url?, inline}]
 *   revision = sha256(join("\n", sorted(`${path}:${sha256}`)))
 *
 * Hybrid storage (§A.5.7 D24):
 *   • size ≤ PRISMER_SKILL_INLINE_THRESHOLD_BYTES → `content: base64` inline
 *   • size  > threshold → `url: <presigned S3 GET>` (7d expiry)
 *
 * Used by:
 *   • BuiltInSkillService (sdk dir scan)
 *   • evolution.ts export-skill (gene → IMSkill emit)
 *   • skills.ts create/update (user-supplied SKILL.md)
 *
 * Pure I/O free: takes Buffer + path; the caller decides where bytes come
 * from (filesystem, multipart upload, gene yaml). S3 upload is an opt-in
 * branch the caller triggers only for > threshold files when S3 is
 * configured (isS3Available()).
 */

import crypto from 'crypto';

export interface ManifestFileInput {
  path: string; // canonical POSIX path within the skill ("SKILL.md", "scripts/foo.py")
  bytes: Buffer;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  inline: boolean;
  // Exactly one of `content` or `url` is set:
  content?: string; // base64 of bytes (when inline=true)
  url?: string; // presigned S3 GET URL (when inline=false)
  s3Key?: string; // optional bookkeeping for caller (S3 key written)
}

export interface ManifestResult {
  files: ManifestFile[];
  revision: string; // sha256 merkle root
}

export const DEFAULT_INLINE_THRESHOLD_BYTES = 100 * 1024;

export function getInlineThresholdBytes(): number {
  const raw = process.env.PRISMER_SKILL_INLINE_THRESHOLD_BYTES;
  if (!raw) return DEFAULT_INLINE_THRESHOLD_BYTES;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INLINE_THRESHOLD_BYTES;
  return n;
}

export function sha256Hex(buf: Buffer | string): string {
  const data = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute manifest merkle root from a list of {path,sha256} pairs.
 *
 * The shape matches the SQL backfill in 400_v210_skill_manifest.sql so a
 * single-file SKILL.md row produces the same revision regardless of which
 * side (DB or app) emits it:
 *   SHA2(CONCAT('SKILL.md:', SHA2(content,256)), 256)  ===
 *   sha256("SKILL.md:" + sha256(content))
 *
 * For multi-file manifests we sort paths alphabetically and join lines with
 * "\n" so the merkle is order-independent w.r.t. how files were collected.
 */
export function computeManifestRevision(files: Array<{ path: string; sha256: string }>): string {
  const lines = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.sha256}`);
  // Single-file shortcut matches the SQL CONCAT (no trailing newline) to keep
  // DB-backfilled rows bit-equal to application-emitted ones.
  return sha256Hex(lines.join('\n'));
}

/**
 * Build a single-file inline manifest from a SKILL.md content string.
 *
 * Used by:
 *   • evolution.ts export-skill (gene yaml → SKILL.md only, no scripts yet)
 *   • skills.ts create/update fallback when caller passes only `content`
 *   • migration backfill parity assertions in tests
 */
export function buildSingleFileManifest(skillMdContent: string): ManifestResult {
  const bytes = Buffer.from(skillMdContent, 'utf8');
  const hash = sha256Hex(bytes);
  const file: ManifestFile = {
    path: 'SKILL.md',
    size: bytes.byteLength,
    sha256: hash,
    inline: true,
    content: bytes.toString('base64'),
  };
  return {
    files: [file],
    revision: computeManifestRevision([{ path: file.path, sha256: file.sha256 }]),
  };
}

export interface BuildManifestOptions {
  inlineThresholdBytes?: number;
  // Caller-provided async upload routine. Called for every file whose size
  // exceeds the threshold; must return a presigned GET URL (or url+s3Key).
  // If omitted, all files are inlined regardless of size (with a warning the
  // caller can choose to surface).
  uploadLarge?: (file: ManifestFileInput, sha256: string) => Promise<{ url: string; s3Key?: string }>;
}

/**
 * Build a manifest from an array of file inputs.
 *
 * `uploadLarge` is the seam for S3 / CDN integration. The built-in skill
 * service supplies an uploader that PUTs to `skills/<sha256>/<basename>` in
 * `pro-prismer-slide` and returns a 7-day presigned GET. In local dev (no
 * AWS creds) the caller omits `uploadLarge` and we transparently fall back
 * to inline base64 — bytes still flow, just bigger API responses.
 */
export async function buildManifest(
  inputs: ManifestFileInput[],
  options: BuildManifestOptions = {},
): Promise<ManifestResult> {
  const threshold = options.inlineThresholdBytes ?? getInlineThresholdBytes();
  const files: ManifestFile[] = [];

  for (const input of inputs) {
    const hash = sha256Hex(input.bytes);
    const size = input.bytes.byteLength;

    if (size <= threshold || !options.uploadLarge) {
      files.push({
        path: input.path,
        size,
        sha256: hash,
        inline: true,
        content: input.bytes.toString('base64'),
      });
    } else {
      const uploaded = await options.uploadLarge(input, hash);
      files.push({
        path: input.path,
        size,
        sha256: hash,
        inline: false,
        url: uploaded.url,
        ...(uploaded.s3Key ? { s3Key: uploaded.s3Key } : {}),
      });
    }
  }

  return {
    files,
    revision: computeManifestRevision(files.map((f) => ({ path: f.path, sha256: f.sha256 }))),
  };
}
