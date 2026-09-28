// Shared SS-01 skill bundle library (release203/16 P1).
//
// Pure functions refactored OUT of `cli/commands/skill.ts:readSkillBundle` so
// the CLI lifecycle verbs (validate / package / create) and `ingest*.mjs` share
// ONE bundle representation. No process exits, no network, no `getUI()` — these
// are pure, testable fns. The CLI commands wrap them and map errors to
// `exitWithError`.
//
// Merkle parity: `computeBundleManifest().revision` MUST stay byte-identical to
// cloud `src/im/skills/manifest.ts:computeManifestRevision`. Both compute
//   sha256( sorted(`${path}:${sha256(bytes)}`).join("\n") )
// — round-trip (ingest → catalog → re-derive) depends on this. See
// test/bundle.test.ts for the cross-side equality assertion.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { runStructuredChecker } from './structured-criteria.js';

export {
  STRUCTURED_CHECKERS,
  parseCitations,
  parseClaimCitations,
  verifyCitation,
  runStructuredChecker,
  __resetCheckerFileCache,
} from './structured-criteria.js';
export type {
  StructuredChecker,
  StructuredCheckerContext,
  StructuredCheckerOutcome,
  Citation,
  CitationVerdict,
} from './structured-criteria.js';

// Files that are part of a bundle dir on disk but never contribute to the
// catalog payload / merkle (editor cruft only; retain license/NOTICE resources).
export const BUNDLE_EXCLUDED = new Set([
  '.DS_Store',
  'Thumbs.db',
]);

export interface BundleFile {
  /** Canonical POSIX path within the bundle ("SKILL.md", "scripts/foo.py"). */
  path: string;
  bytes: Buffer;
}

export interface ReadBundleResult {
  dir: string;
  files: BundleFile[];
  /** Parsed SKILL.md frontmatter (flat YAML), or {} when SKILL.md absent. */
  frontmatter: Record<string, string | string[]>;
  /** Raw SKILL.md text, or undefined when absent. */
  skillMd?: string;
}

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  inline: true;
  content: string; // base64 of bytes
}

export interface BundleManifestResult {
  files: ManifestEntry[];
  revision: string; // sha256 merkle root — byte-identical to cloud manifest.ts
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// product204/30 A4 — at least 50 language-aware quality units and at most 1024
// raw characters. Mirrors the cloud validator so local and server gates agree.
// Kept as literals because the runtime package cannot import from `src/im`.
const DESCRIPTION_MIN_LENGTH = 50;
const DESCRIPTION_MAX_LENGTH = 1024;

export function descriptionQualityLength(value: string): number {
  return Array.from(value).reduce((total, char) => total + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0);
}

function sha256(buf: Buffer | string): string {
  const data = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Read a bundle directory off disk: collect every non-dotfile, non-excluded
 * file (recursively), sort by absolute path, normalise to POSIX-relative paths,
 * and parse SKILL.md frontmatter if present.
 *
 * Throws (does NOT exit) when the dir is missing / not a directory — the caller
 * maps it to exitWithError.
 */
export function readBundle(dir: string): ReadBundleResult {
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new BundleError(`bundle dir not found: ${dir}`, 'skill_bundle_missing');
  }
  if (!st.isDirectory()) {
    throw new BundleError(`not a directory: ${dir}`, 'skill_bundle_not_dir');
  }

  const collect = (d: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) out.push(...collect(abs));
      else if (!BUNDLE_EXCLUDED.has(entry.name)) out.push(abs);
    }
    return out;
  };

  const absFiles = collect(dir).sort();
  const toPosix = (abs: string) => relative(dir, abs).split(sep).join('/');
  const files: BundleFile[] = absFiles.map((abs) => ({
    path: toPosix(abs),
    bytes: readFileSync(abs),
  }));

  const skillMdFile = files.find((f) => f.path === 'SKILL.md');
  const skillMd = skillMdFile?.bytes.toString('utf8');
  const frontmatter = skillMd ? parseFrontmatter(skillMd).fm : {};

  return { dir, files, frontmatter, skillMd };
}

/**
 * Validate a read bundle against SS-01 rules (no I/O, no network):
 *  - SKILL.md present at bundle root
 *  - frontmatter.name matches `^[a-z][a-z0-9-]*$`
 *  - frontmatter.description non-empty
 * Returns a collected {ok, errors, warnings} (never throws / exits) so the CLI
 * can print all problems at once.
 */
export function validateBundle(bundle: ReadBundleResult): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const skillMd = bundle.files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) {
    errors.push('SKILL.md not found at bundle root');
    return { ok: false, errors, warnings };
  }

  const fm = bundle.frontmatter;
  const name = typeof fm.name === 'string' ? fm.name : '';
  if (!name) {
    errors.push('frontmatter.name is required');
  } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    errors.push(`frontmatter.name invalid (must match ^[a-z][a-z0-9-]*$): "${name}"`);
  }

  if (!fm.description) {
    errors.push('frontmatter.description is required');
  } else if (typeof fm.description === 'string' && fm.description.trim() === '') {
    errors.push('frontmatter.description is empty');
  } else if (typeof fm.description === 'string' && descriptionQualityLength(fm.description) < DESCRIPTION_MIN_LENGTH) {
    errors.push(
      `frontmatter.description must carry ≥ ${DESCRIPTION_MIN_LENGTH} quality units ` +
        `(got ${descriptionQualityLength(fm.description)}; ${fm.description.length} characters)`,
    );
  } else if (typeof fm.description === 'string' && fm.description.length > DESCRIPTION_MAX_LENGTH) {
    errors.push(
      `frontmatter.description must be ≤ ${DESCRIPTION_MAX_LENGTH} characters (got ${fm.description.length})`,
    );
  }

  if (!fm.category) {
    warnings.push('frontmatter.category absent — defaults to "general"');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Compute the inline manifest + merkle revision for a bundle.
 *
 * Byte-identical to cloud `src/im/skills/manifest.ts`:
 *   - per file: sha256(bytes), size = byteLength, content = base64
 *   - revision = sha256( sorted(`${path}:${sha256}`).join("\n") )
 * All files are inlined (CLI/local path has no S3 uploader).
 */
export function computeBundleManifest(files: BundleFile[]): BundleManifestResult {
  const manifest: ManifestEntry[] = files.map((f) => ({
    path: f.path,
    size: f.bytes.byteLength,
    sha256: sha256(f.bytes),
    inline: true,
    content: f.bytes.toString('base64'),
  }));
  const revision = sha256(
    [...manifest]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.path}:${f.sha256}`)
      .join('\n'),
  );
  return { files: manifest, revision };
}

/**
 * Build the `POST /api/im/skills` create body from a validated bundle. Mirrors
 * the legacy inline `readSkillBundle().createBody` exactly (no behaviour
 * change): single-file bundles omit contentManifest; multi-file include it.
 */
export function buildSkillCreateBody(bundle: ReadBundleResult): {
  slug: string;
  revision: string;
  fileCount: number;
  createBody: Record<string, unknown>;
} {
  const fm = bundle.frontmatter;
  const name = typeof fm.name === 'string' ? fm.name : '';
  const skillMd = bundle.skillMd ?? '';
  const { files: manifest, revision } = computeBundleManifest(bundle.files);

  const compatibility = Array.isArray(fm.compatibility)
    ? fm.compatibility
    : typeof fm.compatibility === 'string'
      ? [fm.compatibility]
      : undefined;
  const isMultiFile = bundle.files.length > 1;

  return {
    slug: name,
    revision,
    fileCount: bundle.files.length,
    createBody: {
      name,
      description: fm.description,
      category: (typeof fm.category === 'string' && fm.category) || 'general',
      ...(fm.license ? { license: fm.license } : {}),
      ...(compatibility ? { compatibility } : {}),
      content: skillMd,
      ...(isMultiFile ? { contentManifest: manifest, contentManifestRevision: revision } : {}),
    },
  };
}

export interface PackageResult {
  /** gzip(tar) bytes. */
  bytes: Buffer;
  /** merkle revision of the packaged files (matches computeBundleManifest). */
  revision: string;
  fileCount: number;
}

/**
 * Package a bundle into a deterministic .tar.gz (USTAR) blob. Pure: caller
 * writes the bytes (or compares). No external tar dependency — a minimal,
 * reproducible USTAR writer keeps the output byte-stable across runs (fixed
 * mtime=0, mode=0644, uid/gid=0) so CI / hash-pinning works.
 */
export function packageBundle(bundle: ReadBundleResult): PackageResult {
  const { revision, fileCount } = {
    revision: computeBundleManifest(bundle.files).revision,
    fileCount: bundle.files.length,
  };
  // Sort for deterministic archive ordering.
  const ordered = [...bundle.files].sort((a, b) => a.path.localeCompare(b.path));
  const tar = buildUstarTar(ordered);
  const bytes = gzipSync(tar, { level: 9 });
  return { bytes, revision, fileCount };
}

// ── Minimal deterministic USTAR writer ───────────────────────────────────────
// 512-byte header + padded data per entry, two zero blocks to terminate. Only
// regular files (typeflag '0'); paths ≤ 100 bytes (skill bundle paths are
// short). All metadata fixed to zero for reproducibility.
function buildUstarTar(files: BundleFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    blocks.push(ustarHeader(f.path, f.bytes.byteLength));
    blocks.push(f.bytes);
    const rem = f.bytes.byteLength % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return Buffer.concat(blocks);
}

function ustarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new BundleError(`path too long for USTAR (>100 bytes): ${name}`, 'skill_bundle_path_too_long');
  }
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  writeOctal(h, 100, 8, 0o644); // mode
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, size); // size
  writeOctal(h, 136, 12, 0); // mtime
  h.write('0', 156, 1, 'ascii'); // typeflag = regular file
  h.write('ustar\0', 257, 6, 'ascii'); // magic
  h.write('00', 263, 2, 'ascii'); // version
  // checksum: spaces during compute, then octal
  h.fill(' ', 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  const chk = sum.toString(8).padStart(6, '0');
  h.write(chk, 148, 6, 'ascii');
  h.write('\0 ', 154, 2, 'ascii');
  return h;
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  const str = value.toString(8).padStart(len - 1, '0') + '\0';
  buf.write(str, offset, len, 'ascii');
}

// ── Frontmatter parser (flat YAML, ported from skill.ts / ingest.mjs) ─────────
export function parseFrontmatter(text: string): { fm: Record<string, string | string[]> } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm: Record<string, string | string[]> = {};
  if (!m) return { fm };
  const strip = (s: string) => s.replace(/^["']|["']$/g, '').trim();
  let key: string | null = null;
  const lines = (m[1] ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && key) {
      const item = strip(listItem[1] ?? '');
      const cur = fm[key];
      if (Array.isArray(cur)) cur.push(item);
      else fm[key] = [item];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && kv[1]) {
      key = kv[1];
      const val = kv[2] ?? '';
      const block = /^([|>])([+-])?$/.exec(val.trim());
      if (block) {
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const candidate = lines[j]!;
          if (candidate.trim() && !/^\s+/.test(candidate)) break;
          body.push(candidate);
        }
        const indents = body
          .filter((candidate) => candidate.trim())
          .map((candidate) => /^\s*/.exec(candidate)?.[0].length ?? 0);
        const indent = indents.length > 0 ? Math.min(...indents) : 0;
        const unindented = body.map((candidate) => candidate.slice(Math.min(indent, candidate.length)));
        let parsed =
          block[1] === '>'
            ? unindented.reduce((out, candidate, index) => {
                if (index === 0) return candidate;
                const previous = unindented[index - 1] ?? '';
                return out + (previous === '' || candidate === '' ? '\n' : ' ') + candidate;
              }, '')
            : unindented.join('\n');
        if (block[2] === '-') parsed = parsed.replace(/\n+$/, '');
        else if (block[2] !== '+') parsed = parsed.replace(/\n*$/, '\n');
        fm[key] = parsed;
        i = j - 1;
        continue;
      }
      fm[key] = val === '' ? [] : strip(val);
    }
  }
  return { fm };
}

// ── skill test acceptance matcher (P2 item 7, pure) ──────────────────────────

export interface AcceptanceCriterion {
  /** Human label for the table; falls back to the raw match value. */
  label?: string;
  /** Substring (default) or regex source to match against task output. */
  match: string;
  /** 'substring' (default) | 'regex' | 'structured'. */
  type?: 'substring' | 'regex' | 'structured';
  /** Regex flags (only when type='regex'); default 'i'. */
  flags?: string;
  /** When false, a miss is a warning, not a verdict-failing required fail. */
  required?: boolean;
  /**
   * type='structured' only — id of a checker in STRUCTURED_CHECKERS. The
   * checker parses declared claims out of the report and RE-VERIFIES them
   * against the filesystem / recomputes them from the task input, so a
   * fabricated report fails on a fact instead of passing on a keyword
   * (apc/12: a zero-`rg`, invented-path:line report scored 6/6 under regex).
   */
  checker?: string;
  /** type='structured' only — checker configuration (see structured-criteria.ts). */
  args?: Record<string, unknown>;
}

export interface CriterionResult {
  label: string;
  match: string;
  type: 'substring' | 'regex' | 'structured';
  required: boolean;
  pass: boolean;
  /** Set when a regex source is invalid (treated as a failed criterion). */
  error?: string;
  /** structured criteria only — per-claim verification evidence. */
  details?: string[];
  /** structured criteria only — the checker id that produced the verdict. */
  checker?: string;
}

/** Evaluation context for structured criteria (ignored by regex/substring). */
export interface CriterionEvalContext {
  /** Repo root the report's path:line citations are relative to. */
  cwd?: string;
}

/**
 * Match one acceptance criterion against a task's completed output.
 *
 * substring/regex stay PURE (no I/O, no dispatch): substring is case-sensitive
 * (exact contains); regex uses the supplied flags (default 'i'); invalid regex
 * → pass=false + error.
 *
 * `type:'structured'` delegates to a registered checker, which DOES read the
 * filesystem (synchronously) to re-verify the report's claims — that is the
 * whole point: text matching cannot separate a real run from a fabricated one.
 */
export function matchCriterion(
  criterion: AcceptanceCriterion,
  output: string,
  ctx?: CriterionEvalContext,
): CriterionResult {
  const type = criterion.type ?? 'substring';
  const required = criterion.required ?? true;
  const label = criterion.label ?? criterion.match;
  const base: Omit<CriterionResult, 'pass' | 'error'> = {
    label,
    match: criterion.match,
    type,
    required,
  };

  if (type === 'structured') {
    const r = runStructuredChecker(criterion.checker, output, criterion.args ?? {}, {
      cwd: ctx?.cwd ?? process.cwd(),
    });
    return {
      ...base,
      pass: r.pass,
      details: r.details,
      ...(criterion.checker ? { checker: criterion.checker } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  if (type === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(criterion.match, criterion.flags ?? 'i');
    } catch (err) {
      return { ...base, pass: false, error: `invalid regex: ${(err as Error).message}` };
    }
    return { ...base, pass: re.test(output) };
  }

  return { ...base, pass: output.includes(criterion.match) };
}

export interface AcceptanceMatchResult {
  results: CriterionResult[];
  /** false when any REQUIRED criterion missed (or had a regex error). */
  ok: boolean;
}

/** Run every criterion; ok=false iff a required criterion failed. */
export function matchAcceptanceCriteria(
  criteria: AcceptanceCriterion[],
  output: string,
  ctx?: CriterionEvalContext,
): AcceptanceMatchResult {
  const results = criteria.map((c) => matchCriterion(c, output, ctx));
  const ok = results.every((r) => r.pass || !r.required);
  return { results, ok };
}

/** Carries a stable error code so CLI wrappers can pass it to exitWithError. */
export class BundleError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BundleError';
    this.code = code;
  }
}

// ── Role validation (SS-02, P1 item 4) ───────────────────────────────────────

export interface RoleValidationInput {
  slug?: unknown;
  requiredSkills?: unknown;
  parameters?: unknown;
  operatingPrinciples?: unknown;
  [k: string]: unknown;
}

/**
 * Validate a single role.json object (no directory/SOUL.md format — out of
 * scope per P1). Rules:
 *  - slug present + matches `^[a-z0-9-]+$`
 *  - requiredSkills (if present) is an array of { skillSlug, required }
 *  - operatingPrinciples present → else warn
 */
export function validateRole(role: RoleValidationInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const slug = typeof role.slug === 'string' ? role.slug : '';
  if (!slug) {
    // Wrong-sample guard (Track2, product204): a role.json whose top level has NO
    // slug/agentType but DOES carry `configSchema.roleTemplate` was copied from
    // the PROFILE-CONFIG template `roles/ceo.json` (outer shape
    // `{ templateName, configSchema: { roleTemplate: {...} } }`), not the SS-02
    // top-level exemplar `catalog/ceo.json`. The real role fields are buried one
    // level down and won't ingest. Name the fix instead of a bare "slug required".
    const cfg = (role as Record<string, unknown>).configSchema;
    const buriedRole =
      cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg as Record<string, unknown>).roleTemplate;
    if (buriedRole && typeof role.agentType !== 'string') {
      errors.push(
        'wrong sample: this looks like a PROFILE-CONFIG template (fields nested under configSchema.roleTemplate), ' +
          'not a top-level SS-02 role. Copy the shape of catalog/ceo.json (slug/agentType/requiredSkills/... at the ROOT), ' +
          'not roles/ceo.json. Lift configSchema.roleTemplate.* up to the top level.',
      );
    } else {
      errors.push('slug is required');
    }
  } else if (!/^[a-z0-9-]+$/.test(slug)) {
    errors.push(`slug invalid (must match ^[a-z0-9-]+$): "${slug}"`);
  }

  if (role.requiredSkills !== undefined) {
    if (!Array.isArray(role.requiredSkills)) {
      errors.push('requiredSkills must be an array of { skillSlug, required }');
    } else {
      role.requiredSkills.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`requiredSkills[${i}] must be an object { skillSlug, required }`);
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.skillSlug !== 'string' || e.skillSlug.trim() === '') {
          errors.push(`requiredSkills[${i}].skillSlug must be a non-empty string`);
        }
        if (e.required !== undefined && typeof e.required !== 'boolean') {
          errors.push(`requiredSkills[${i}].required must be a boolean when present`);
        }
      });
    }
  }

  // product204/37 — role's own config parameters (default/user kind).
  if (role.parameters !== undefined) {
    if (!Array.isArray(role.parameters)) {
      errors.push('parameters must be an array of { key, type, kind, ... }');
    } else {
      const TYPES = new Set(['string', 'enum', 'secret', 'number', 'bool']);
      const KINDS = new Set(['default', 'user']);
      role.parameters.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`parameters[${i}] must be an object { key, type, kind, ... }`);
          return;
        }
        const p = entry as Record<string, unknown>;
        if (typeof p.key !== 'string' || p.key.trim() === '') {
          errors.push(`parameters[${i}].key must be a non-empty string`);
        }
        if (p.type !== undefined && (typeof p.type !== 'string' || !TYPES.has(p.type))) {
          errors.push(`parameters[${i}].type must be one of ${[...TYPES].join('/')}`);
        }
        if (p.kind !== undefined && (typeof p.kind !== 'string' || !KINDS.has(p.kind))) {
          errors.push(`parameters[${i}].kind must be 'default' or 'user'`);
        }
        if (p.type === 'enum' && (!Array.isArray(p.options) || p.options.length === 0)) {
          errors.push(`parameters[${i}] (enum) must declare a non-empty options array`);
        }
        // user-kind params carry no template default (the value is per-account).
        if (p.kind === 'user' && p.default !== undefined && p.default !== null) {
          errors.push(`parameters[${i}] is kind:user and must NOT declare a default (per-account value)`);
        }
      });
    }
  }

  if (
    role.operatingPrinciples === undefined ||
    role.operatingPrinciples === null ||
    (typeof role.operatingPrinciples === 'string' && role.operatingPrinciples.trim() === '')
  ) {
    warnings.push('operatingPrinciples absent — role has no persona/SOUL guidance');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Role bundle (directory) read — doc 16 §5.4 / P4 ───────────────────────────
//
// A role authoring unit is EITHER a single `role.json` (legacy, still accepted)
// OR a DIRECTORY containing `role.json` + an optional `SOUL.md`. When a directory
// is given, SOUL.md's raw markdown becomes the role's `operatingPrinciples`
// (single markdown string), overriding/filling role.json's field. This aligns
// the persona representation with Hermes (SOUL.md slot#1, persona-only) and lets
// the human asset-editor and the agent CLI consume one on-disk bundle.

export interface ReadRoleBundleResult {
  /** Parsed + (when a dir) SOUL-merged role object, ready to POST. */
  role: Record<string, unknown>;
  /** True when the input path was a directory bundle, false for a single .json. */
  isDir: boolean;
  /** Raw SOUL.md text when present in a dir bundle, else undefined. */
  soulMd?: string;
}

/**
 * Read a role authoring unit off disk — file OR directory — and produce the
 * role object to POST. Detection is by `statSync().isDirectory()`:
 *   - file  → JSON.parse the file as-is (legacy single role.json).
 *   - dir   → require `<dir>/role.json`; if `<dir>/SOUL.md` exists and is
 *             non-empty, set its markdown text as `operatingPrinciples`.
 *
 * Throws BundleError (does NOT exit / no network) — the caller maps it to
 * exitWithError. Zero-dep mirror of this logic lives in
 * `built-in-skills/role-builder/scripts/ingest-role.mjs`.
 */
export function readRoleBundle(pathOrDir: string): ReadRoleBundleResult {
  let st;
  try {
    st = statSync(pathOrDir);
  } catch {
    throw new BundleError(`role path not found: ${pathOrDir}`, 'role_path_missing');
  }

  if (!st.isDirectory()) {
    let role: Record<string, unknown>;
    try {
      role = JSON.parse(readFileSync(pathOrDir, 'utf8'));
    } catch (err) {
      throw new BundleError(`could not read/parse ${pathOrDir}: ${(err as Error).message}`, 'role_json_invalid');
    }
    return { role, isDir: false };
  }

  // Directory bundle: role.json (required) + SOUL.md (optional persona).
  const roleJsonPath = join(pathOrDir, 'role.json');
  let role: Record<string, unknown>;
  try {
    role = JSON.parse(readFileSync(roleJsonPath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new BundleError(`role bundle dir is missing role.json: ${roleJsonPath}`, 'role_json_missing');
    }
    throw new BundleError(`could not read/parse ${roleJsonPath}: ${(err as Error).message}`, 'role_json_invalid');
  }

  let soulMd: string | undefined;
  try {
    const raw = readFileSync(join(pathOrDir, 'SOUL.md'), 'utf8');
    if (raw.trim() !== '') {
      soulMd = raw;
      // SOUL.md is the persona source-of-truth — its markdown becomes
      // operatingPrinciples, overriding/filling role.json's field.
      role.operatingPrinciples = raw;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new BundleError(`could not read SOUL.md: ${(err as Error).message}`, 'role_soul_invalid');
    }
    // SOUL.md absent is allowed — role.json's operatingPrinciples (if any) stands.
  }

  return { role, isDir: true, soulMd };
}

/**
 * Validate a role authoring unit that may be a dir bundle. Extends
 * `validateRole` with the dir-specific check: when a SOUL.md is present it must
 * be non-empty (enforced at read time → surfaced as the soul flag here). A dir
 * without SOUL.md is allowed (operatingPrinciples may live in role.json).
 */
export function validateRoleBundle(bundle: ReadRoleBundleResult): ValidationResult {
  const v = validateRole(bundle.role as RoleValidationInput);
  // When a dir bundle carries a SOUL.md, operatingPrinciples is guaranteed
  // present (read merged it in) → drop the "absent" warning to avoid noise.
  if (bundle.isDir && bundle.soulMd) {
    return {
      ok: v.ok,
      errors: v.errors,
      warnings: v.warnings.filter((w) => !w.startsWith('operatingPrinciples absent')),
    };
  }
  return v;
}
