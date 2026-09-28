/**
 * pkf209/07 §4a — Runtime bundle-commit normalizer (hash sinking).
 *
 * The MODEL surface is relaxed: resources carry content (`bytesBase64` | `text`),
 * paths, mime and usage; hashes are optional. This normalizer owns everything
 * the model should never burn turns on:
 *
 *   1. decode + hash every resource (sha256-hex contentHash, base64 SRI);
 *   2. compute `root.sourceHash` (over the FINAL rewritten source);
 *   3. generate the harness manifest via the deterministic `packHarness`
 *      (from @prismer/pkf) when it is missing/incomplete or a `harnessDecl`
 *      was supplied — closing the "manifest URI is a function of the byte
 *      hashes" circular dependency that made weak models 422-loop and strong
 *      models burn 14.5 terminal minutes hashing;
 *   4. rewrite bundle-internal relative references in `root.source` to
 *      host-bound scoped asset URIs (`prismer://workspace/<ws>/asset/<sha256>`);
 *      unmatched references are KEPT verbatim and reported as warnings;
 *   5. verify self-supplied hashes locally — mismatch fast-fails with a
 *      readable, path-named error before anything reaches the Cloud.
 *
 * Output is the FROZEN server wire shape (`PkfBundleCommitInput`); the server
 * remains the validation authority and re-checks every hash.
 */

import { createHash } from 'node:crypto';
import { packHarness } from '@prismer/pkf';
import type { PkfBundleCommitInput, PkfBundleResourceUsage } from '../../adapters/memory-tools.js';

export interface PkfBundleCommitRelaxedResource {
  path: string;
  fromPath?: string;
  bytesBase64?: string;
  /** utf-8 text alternative to bytesBase64 — exactly one of the two. */
  text?: string;
  contentHash?: string;
  integrity?: string;
  mime: string;
  usage: PkfBundleResourceUsage;
}

export interface PkfBundleCommitRelaxedInput {
  idempotencyKey: string;
  root: { filename: string; source: string; sourceHash?: string };
  resources: PkfBundleCommitRelaxedResource[];
  /** Explicit harness declaration → the runtime generates the manifest. */
  harnessDecl?: { scripts?: string[]; styles?: string[]; entry?: string; csp?: string; sandbox?: string[] };
}

export interface PkfBundleNormalized {
  /** Frozen server wire contract — `/api/pkf/bundles/commit` unchanged. */
  input: PkfBundleCommitInput;
  /** Non-fatal notes (e.g. unresolved references kept verbatim). */
  warnings: string[];
}

/** Local fast-fail (HTTP 400 at the RPC seam); the Cloud stays the authority. */
export class PkfBundleNormalizeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PkfBundleNormalizeError';
  }
}

const HASH_RE = /^[0-9a-f]{64}$/;
const BUNDLE_USAGES = new Set<string>([
  'harness-manifest',
  'harness-script',
  'harness-style',
  'harness-resource',
  'image',
  'video',
  'audio',
  'file',
  'data',
]);
const DEFAULT_MANIFEST_PATH = 'manifest.json';
const MAX_RESOURCES = 256;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Sri(bytes: Buffer): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

interface WorkingResource {
  path: string;
  fromPath: string | null;
  bytes: Buffer;
  mime: string;
  usage: PkfBundleResourceUsage;
  suppliedContentHash?: string;
  suppliedIntegrity?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', `harnessDecl.${field} must be an array of bundle paths`);
  }
  return value as string[];
}

// ── step 1/2: shape + decode ─────────────────────────────────────────────────

function parseResources(raw: unknown[]): WorkingResource[] {
  const seen = new Set<string>();
  const out: WorkingResource[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'each bundle resource must be an object');
    }
    const path = typeof candidate.path === 'string' ? candidate.path : '';
    const mime = typeof candidate.mime === 'string' ? candidate.mime : '';
    const usage = typeof candidate.usage === 'string' ? candidate.usage : '';
    if (!path || path.length > 500) {
      throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'bundle resource path must be a non-empty string (≤500 chars)');
    }
    if (seen.has(path)) {
      throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', `duplicate bundle resource path "${path}"`);
    }
    seen.add(path);
    if (!mime || mime.length > 191) {
      throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', `bundle resource "${path}" requires a mime string`);
    }
    if (!BUNDLE_USAGES.has(usage)) {
      throw new PkfBundleNormalizeError(
        'pkf_bundle_request_invalid',
        `bundle resource "${path}" usage "${usage}" is not one of ${[...BUNDLE_USAGES].join('|')}`,
      );
    }
    const hasBase64 = typeof candidate.bytesBase64 === 'string' && candidate.bytesBase64.length > 0;
    const hasText = typeof candidate.text === 'string' && candidate.text.length > 0;
    if (hasBase64 === hasText) {
      throw new PkfBundleNormalizeError(
        'pkf_bundle_request_invalid',
        `bundle resource "${path}" must carry exactly one of bytesBase64 or text`,
      );
    }
    let bytes: Buffer;
    if (hasBase64) {
      const value = candidate.bytesBase64 as string;
      bytes = Buffer.from(value, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== value) {
        throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', `bundle resource "${path}" bytesBase64 is not canonical base64`);
      }
    } else {
      bytes = Buffer.from(candidate.text as string, 'utf8');
    }
    out.push({
      path,
      fromPath: typeof candidate.fromPath === 'string' && candidate.fromPath ? candidate.fromPath : null,
      bytes,
      mime: mime.trim().toLowerCase(),
      usage: usage as PkfBundleResourceUsage,
      suppliedContentHash: typeof candidate.contentHash === 'string' ? candidate.contentHash : undefined,
      suppliedIntegrity: typeof candidate.integrity === 'string' ? candidate.integrity : undefined,
    });
  }
  return out;
}

// ── step 3: manifest generation (deterministic packer) ───────────────────────

interface ManifestEntry {
  path?: unknown;
  src?: unknown;
  integrity?: unknown;
}

/**
 * A model-authored manifest is "complete" when it already matches what the
 * server demands: every harness script/style appears with the exact computed
 * SRI and scoped URI, and the entry count matches the child count (mirror of
 * the server's `bundle_manifest_dependency_mismatch` checks). Anything less →
 * regenerate; the model cannot know the hashes it never computed.
 */
function manifestIsComplete(
  manifestResource: WorkingResource,
  resources: WorkingResource[],
  workspaceId: string,
): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestResource.bytes.toString('utf8'));
  } catch {
    return false;
  }
  if (!isRecord(decoded)) return false;
  const children = resources.filter((r) => r.usage === 'harness-script' || r.usage === 'harness-style');
  const entries = [
    ...((Array.isArray(decoded.scripts) ? decoded.scripts : []) as ManifestEntry[]),
    ...((Array.isArray(decoded.styles) ? decoded.styles : []) as ManifestEntry[]),
  ];
  if (entries.length !== children.length) return false;
  for (const child of children) {
    const entry = entries.find((candidate) => candidate.path === child.path);
    if (!entry) return false;
    const expectedSrc = `prismer://workspace/${workspaceId}/asset/${sha256Hex(child.bytes)}`;
    if (entry.src !== expectedSrc || entry.integrity !== sha256Sri(child.bytes)) return false;
  }
  return true;
}

function generateManifest(
  resources: WorkingResource[],
  decl: { scripts?: string[]; styles?: string[]; entry?: string; csp?: string; sandbox?: string[] } | null,
  existingManifest: WorkingResource | undefined,
  workspaceId: string,
): { manifestPath: string; manifestResource: WorkingResource } {
  const declaredScripts = decl?.scripts ?? resources.filter((r) => r.usage === 'harness-script').map((r) => r.path);
  const declaredStyles = decl?.styles ?? resources.filter((r) => r.usage === 'harness-style').map((r) => r.path);
  const manifestPath = existingManifest?.path ?? decl?.entry ?? DEFAULT_MANIFEST_PATH;

  const files: Record<string, Uint8Array> = {};
  for (const resource of resources) files[resource.path] = new Uint8Array(resource.bytes);

  const packed = packHarness({
    files,
    manifest: {
      scripts: declaredScripts.map((path) => ({ path })),
      styles: declaredStyles.map((path) => ({ path })),
      ...(decl?.csp !== undefined ? { csp: decl.csp } : {}),
      ...(decl?.sandbox !== undefined ? { sandbox: decl.sandbox } : {}),
    },
    computeSrc: (path) => {
      const bytes = files[path];
      return bytes ? `prismer://workspace/${workspaceId}/asset/${sha256Hex(Buffer.from(bytes))}` : undefined;
    },
  });
  if (!packed.ok) {
    throw new PkfBundleNormalizeError('pkf_bundle_manifest_invalid', `harness manifest generation failed: ${packed.message}`);
  }

  const manifestBytes = Buffer.from(JSON.stringify(packed.manifest), 'utf8');
  const manifestResource: WorkingResource = {
    path: manifestPath,
    fromPath: null,
    bytes: manifestBytes,
    mime: 'application/json',
    usage: 'harness-manifest',
  };

  // Replace any model-authored manifest resource, re-parent scripts/styles.
  const next = resources.filter((r) => r !== existingManifest && r.path !== manifestPath);
  for (const resource of next) {
    if (resource.usage === 'harness-script' || resource.usage === 'harness-style') {
      resource.fromPath = manifestPath;
    }
  }
  next.push(manifestResource);
  resources.splice(0, resources.length, ...next);
  return { manifestPath, manifestResource };
}

// ── step 4: root.source reference rewriting ──────────────────────────────────

const REF_ATTR_RE = /\b(src|href|manifest)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SCOPED_URI_RE = /^prismer:\/\/workspace\/([^/]+)\/asset\/([0-9a-f]{64})$/;

/** Map a reference value onto a bundle path (bare, ./-prefixed, prismer-tailed). */
function resolveRefToPath(value: string, paths: Set<string>): string | null {
  if (paths.has(value)) return value;
  if (value.startsWith('./') && paths.has(value.slice(2))) return value.slice(2);
  const tailed = /^prismer:\/\/[^/]+\/(.+)$/.exec(value);
  if (tailed && paths.has(tailed[1]!)) return tailed[1]!;
  return null;
}

function isRelativeRef(value: string): boolean {
  if (!value || value.startsWith('#')) return false;
  // no scheme (no "word:" before the first '/') and not protocol-relative
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(value);
  return !scheme && !value.startsWith('//');
}

function rewriteRootSource(
  source: string,
  scopedByPath: Map<string, string>,
  knownHashes: Set<string>,
  warnings: string[],
): string {
  const paths = new Set(scopedByPath.keys());
  return source.replace(REF_ATTR_RE, (match, _attr: string, dq?: string, sq?: string) => {
    const quote = dq !== undefined ? '"' : "'";
    const value = (dq !== undefined ? dq : sq) ?? '';
    if (!value) return match;
    const hit = resolveRefToPath(value, paths);
    if (hit) {
      const scoped = scopedByPath.get(hit)!;
      return match.replace(`${quote}${value}${quote}`, `${quote}${scoped}${quote}`);
    }
    const scopedMatch = SCOPED_URI_RE.exec(value);
    if (scopedMatch) {
      if (!knownHashes.has(scopedMatch[2]!)) {
        warnings.push(`reference "${value}" is a scoped asset URI not in the bundle (kept verbatim)`);
      }
      return match;
    }
    if (isRelativeRef(value)) {
      warnings.push(`relative reference "${value}" does not match any bundle resource path (kept verbatim)`);
    }
    return match;
  });
}

// ── entry point ──────────────────────────────────────────────────────────────

export function normalizePkfBundleCommit(input: unknown, workspaceId: string): PkfBundleNormalized {
  if (!isRecord(input)) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'bundle commit body must be an object');
  }
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!idempotencyKey || idempotencyKey.length > 191) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'idempotencyKey must be a non-empty string (≤191 chars)');
  }
  const root = isRecord(input.root) ? input.root : null;
  if (!root || typeof root.filename !== 'string' || !root.filename || typeof root.source !== 'string' || !root.source) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'root.filename and root.source are required');
  }
  if (!Array.isArray(input.resources) || input.resources.length < 1 || input.resources.length > MAX_RESOURCES) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', `resources must be an array of 1..${MAX_RESOURCES} entries`);
  }
  const declRaw = input.harnessDecl;
  if (declRaw !== undefined && !isRecord(declRaw)) {
    throw new PkfBundleNormalizeError('pkf_bundle_request_invalid', 'harnessDecl must be an object');
  }
  const decl =
    declRaw !== undefined
      ? {
          scripts: stringArray(declRaw.scripts, 'scripts'),
          styles: stringArray(declRaw.styles, 'styles'),
          entry: typeof declRaw.entry === 'string' && declRaw.entry ? declRaw.entry : undefined,
          csp: typeof declRaw.csp === 'string' ? declRaw.csp : undefined,
          sandbox: Array.isArray(declRaw.sandbox) && declRaw.sandbox.every((t) => typeof t === 'string')
            ? (declRaw.sandbox as string[])
            : undefined,
        }
      : null;

  const warnings: string[] = [];
  const resources = parseResources(input.resources);
  const originalSource = root.source;
  const suppliedSourceHash = typeof root.sourceHash === 'string' && root.sourceHash ? root.sourceHash : undefined;
  if (suppliedSourceHash !== undefined && !HASH_RE.test(suppliedSourceHash)) {
    throw new PkfBundleNormalizeError('pkf_bundle_root_hash_mismatch', 'root.sourceHash must be 64 lowercase hex chars');
  }

  // step 3 — manifest generation when missing/incomplete or explicitly declared
  const existingManifest = resources.find((r) => r.usage === 'harness-manifest');
  const hasHarnessChildren = resources.some((r) => r.usage === 'harness-script' || r.usage === 'harness-style');
  if (decl !== null || (hasHarnessChildren && (!existingManifest || !manifestIsComplete(existingManifest, resources, workspaceId)))) {
    generateManifest(resources, decl, existingManifest, workspaceId);
  } else if (existingManifest) {
    // Complete model-authored manifest: keep the bytes verbatim, but backfill
    // the children's referrer — the server requires scripts/styles to hang off
    // the manifest (fromPath is a plain path, not a hash, so we can fix it).
    for (const resource of resources) {
      if (resource.usage === 'harness-script' || resource.usage === 'harness-style') {
        resource.fromPath = existingManifest.path;
      }
    }
  }

  // step 1/2 + step 5 — hashes: compute, and verify any self-supplied value
  for (const resource of resources) {
    const contentHash = sha256Hex(resource.bytes);
    const integrity = sha256Sri(resource.bytes);
    if (resource.suppliedContentHash !== undefined) {
      if (resource.suppliedContentHash !== contentHash) {
        throw new PkfBundleNormalizeError(
          'pkf_bundle_resource_hash_mismatch',
          `resource "${resource.path}" contentHash mismatch: supplied ${resource.suppliedContentHash}, computed ${contentHash}`,
        );
      }
    }
    if (resource.suppliedIntegrity !== undefined) {
      if (resource.suppliedIntegrity !== integrity) {
        throw new PkfBundleNormalizeError(
          'pkf_bundle_resource_integrity_mismatch',
          `resource "${resource.path}" integrity mismatch: supplied ${resource.suppliedIntegrity}, computed ${integrity}`,
        );
      }
    }
    resource.suppliedContentHash = contentHash;
    resource.suppliedIntegrity = integrity;
  }

  // step 4 — rewrite bundle-internal references to scoped asset URIs
  const scopedByPath = new Map(resources.map((r) => [r.path, `prismer://workspace/${workspaceId}/asset/${sha256Hex(r.bytes)}`]));
  const knownHashes = new Set(resources.map((r) => sha256Hex(r.bytes)));
  const source = rewriteRootSource(originalSource, scopedByPath, knownHashes, warnings);

  // step 2 — root.sourceHash over the FINAL source; supplied value verified
  // against the ORIGINAL bytes the model hashed.
  if (suppliedSourceHash !== undefined && suppliedSourceHash !== sha256Hex(Buffer.from(originalSource, 'utf8'))) {
    throw new PkfBundleNormalizeError(
      'pkf_bundle_root_hash_mismatch',
      `root.sourceHash mismatch: supplied ${suppliedSourceHash}, computed ${sha256Hex(Buffer.from(originalSource, 'utf8'))}`,
    );
  }
  const sourceHash = sha256Hex(Buffer.from(source, 'utf8'));

  const wire: PkfBundleCommitInput = {
    idempotencyKey,
    root: { filename: root.filename, source, sourceHash },
    resources: resources.map((resource) => ({
      path: resource.path,
      ...(resource.fromPath ? { fromPath: resource.fromPath } : {}),
      bytesBase64: resource.bytes.toString('base64'),
      contentHash: resource.suppliedContentHash!,
      integrity: resource.suppliedIntegrity!,
      mime: resource.mime,
      usage: resource.usage,
    })),
  };
  return { input: wire, warnings };
}
