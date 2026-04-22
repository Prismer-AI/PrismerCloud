// Pack Registry Client — Fetch release manifests from GitHub Releases.
//
// v1.9.0 decision: no custom Pack Registry / CDN. Adapters ship via npm/PyPI
// (their native registries), and the signed manifest (sha256 of each package
// + Ed25519 signature over the whole thing) is attached as a GitHub Release
// asset. This client:
//   1. Resolves the release by tag (v<version>) or "latest".
//   2. Downloads `index.json` + `<name>.manifest.yaml` from Release assets.
//   3. Verifies the Ed25519 signature against the hardcoded pubkey.
//   4. Returns the PackIndex the rest of the runtime consumes.
//
// The internal pack catalog (what-adapters-exist) lives in `./registry.ts` —
// a small hardcoded list shipped inside @prismer/runtime that changes only
// when a new runtime version is published. GitHub Release hosts the signed
// integrity manifest, but it is NOT queried for discovery — it's verification-only.

import * as yaml from 'js-yaml';
import { verifyPackSignature as verifyPackSignatureCanonical } from './pack-verify.js';

// ============================================================
// Types
// ============================================================

export interface PackIndex {
  version: string;
  packs: PackEntry[];
  signature: string;
  signedAt: string;
}

export interface PackEntry {
  name: string;
  displayName: string;
  adapter: string;
  version: string;
  tiersSupported: number[];
  capabilityTags: string[];
  upstreamPackage: string;
  upstreamVersionRange?: string;
  description: string;
  size: string;
  manifestUrl: string;
}

export interface PackManifest {
  name: string;
  displayName: string;
  adapter: string;
  version: string;
  tiersSupported: number[];
  capabilityTags: string[];
  upstreamPackage: string;
  upstreamVersionRange?: string;
  installCommand?: string;
  description: string;
  size: string;
  signature: string;
  signedAt: string;
}

// ============================================================
// Constants
// ============================================================

// GitHub Release asset base. Per-tag URL:
//   https://github.com/Prismer-AI/PrismerCloud/releases/download/v<ver>/<asset>
// And "latest":
//   https://github.com/Prismer-AI/PrismerCloud/releases/latest/download/<asset>
// Env var override kept for enterprise mirror / local dev (e.g. point at an
// nginx that caches GitHub Release assets behind a firewall). The default
// does not touch any Prismer-owned infrastructure.
const RELEASE_BASE = process.env['PACK_RELEASE_BASE'] ??
  'https://github.com/Prismer-AI/PrismerCloud/releases';

/** Build a release asset URL. `version` null → "latest" redirect. */
function releaseAssetUrl(version: string | null, assetName: string): string {
  if (!version) return `${RELEASE_BASE}/latest/download/${assetName}`;
  const tag = `v${version.replace(/^v/, '')}`;
  return `${RELEASE_BASE}/download/${tag}/${assetName}`;
}

// ============================================================
// Pack Registry Client (GitHub Releases)
// ============================================================

/** Fetch the pack index from GitHub Release assets. `version` null → latest. */
export async function fetchPackIndex(
  fetchImpl: typeof fetch = fetch,
  version: string | null = null,
): Promise<PackIndex> {
  const url = releaseAssetUrl(version, 'index.json');

  const resp = await fetchImpl(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'prismer-runtime/1.9.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch pack index: HTTP ${resp.status} (${url})`);
  }

  const index = await resp.json() as PackIndex;

  // Verify index signature — signed payload matches scripts/sign-release.ts output.
  const payload = JSON.stringify({
    version: index.version,
    packs: index.packs,
  });

  const verifyResult = verifyPackSignatureCanonical(Buffer.from(payload), index.signature);
  if (!verifyResult.verified) {
    throw new Error('Pack index signature verification failed');
  }

  console.log(`[PackRegistry] Fetched ${index.packs.length} packs from GitHub Release (verified)`);
  return index;
}

/** Fetch a single pack manifest from GitHub Release. Asset name: `<name>.manifest.yaml`. */
export async function fetchPackManifest(
  name: string,
  fetchImpl: typeof fetch = fetch,
  version: string | null = null,
): Promise<PackManifest> {
  const url = releaseAssetUrl(version, `${name}.manifest.yaml`);

  const resp = await fetchImpl(url, {
    headers: {
      'Accept': 'text/yaml, application/x-yaml, text/plain',
      'User-Agent': 'prismer-runtime/1.9.0',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch pack manifest: HTTP ${resp.status} (${url})`);
  }

  const yaml = await resp.text();
  const manifest = parseYamlManifest(yaml);

  const payload = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    adapter: manifest.adapter,
    tiersSupported: manifest.tiersSupported,
    capabilityTags: manifest.capabilityTags,
  });

  const verifyResult = verifyPackSignatureCanonical(Buffer.from(payload), manifest.signature);
  if (!verifyResult.verified) {
    throw new Error(`Pack manifest signature verification failed: ${name}`);
  }

  console.log(`[PackRegistry] Fetched manifest for ${name} from GitHub Release (verified)`);
  return manifest;
}

/** Verify a (name, signature) pair against the latest signed index.
 *  Client-side only — no server endpoint needed. Resolves the pack entry by
 *  name from the index and delegates to the canonical pack-verify verifier. */
export async function verifyPackByName(
  name: string,
  signature: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ valid: boolean; pack?: PackEntry }> {
  const index = await fetchPackIndex(fetchImpl);
  const pack = index.packs.find((p) => p.name === name);
  if (!pack) return { valid: false };

  const payload = JSON.stringify({
    name: pack.name,
    version: pack.version,
    adapter: pack.adapter,
    tiersSupported: pack.tiersSupported,
    capabilityTags: pack.capabilityTags,
  });
  const result = verifyPackSignatureCanonical(Buffer.from(payload), signature);
  return { valid: result.verified, pack: result.verified ? pack : undefined };
}

// ============================================================
// YAML Parser (js-yaml CORE_SCHEMA — safe, no code execution)
// ============================================================

/**
 * Parse a pack manifest YAML string into a validated PackManifest.
 *
 * Uses yaml.load with CORE_SCHEMA (the v4 default). CORE_SCHEMA is safe —
 * it resolves booleans/nulls/numbers but does NOT execute code and does NOT
 * support !!js/* tags (those are absent from CORE). This is intentional:
 * manifests are fetched from attacker-influenceable URLs (GitHub Release
 * assets, CDN mirrors), so we must not allow tag-based type coercion beyond
 * the CORE set.
 *
 * After loading, we runtime-validate every required field and coerce
 * tiersSupported to number[] (CORE parses bare integers as numbers already,
 * but we validate and coerce defensively).
 */
function parseYamlManifest(rawYaml: string): PackManifest {
  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    throw new Error(`Pack manifest malformed: invalid YAML — ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Pack manifest malformed: top-level value must be a mapping');
  }

  const obj = parsed as Record<string, unknown>;

  function requireString(key: keyof PackManifest): string {
    const val = obj[key as string];
    if (typeof val !== 'string' || val.trim() === '') {
      throw new Error(`Pack manifest malformed: '${key as string}' must be a non-empty string (got ${JSON.stringify(val)})`);
    }
    return val;
  }

  function optionalString(key: keyof PackManifest): string | undefined {
    const val = obj[key as string];
    if (val === undefined || val === null) return undefined;
    if (typeof val !== 'string') {
      throw new Error(`Pack manifest malformed: '${key as string}' must be a string (got ${JSON.stringify(val)})`);
    }
    return val;
  }

  function requireStringArray(key: keyof PackManifest): string[] {
    const val = obj[key as string];
    if (!Array.isArray(val)) {
      throw new Error(`Pack manifest malformed: '${key as string}' must be an array (got ${JSON.stringify(val)})`);
    }
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== 'string') {
        throw new Error(`Pack manifest malformed: '${key as string}[${i}]' must be a string (got ${JSON.stringify(val[i])})`);
      }
    }
    return val as string[];
  }

  function requireNumberArray(key: keyof PackManifest, opts?: { minLength?: number }): number[] {
    const val = obj[key as string];
    if (!Array.isArray(val)) {
      throw new Error(`Pack manifest malformed: '${key as string}' must be an array (got ${JSON.stringify(val)})`);
    }
    if (opts?.minLength !== undefined && val.length < opts.minLength) {
      throw new Error(`Pack manifest malformed: tiersSupported must contain at least one tier`);
    }
    return val.map((item, i) => {
      // CORE_SCHEMA parses bare integers as numbers; accept strings that are
      // decimal integers for forward-compatibility with quoted YAML values.
      if (typeof item === 'number') {
        if (!Number.isFinite(item) || item <= 0 || !Number.isInteger(item)) {
          throw new Error(`Pack manifest malformed: '${key as string}[${i}]' must be a finite positive integer (got ${JSON.stringify(item)})`);
        }
        return item;
      }
      if (typeof item === 'string') {
        const n = Number(item);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          throw new Error(`Pack manifest malformed: '${key as string}[${i}]' must be a finite positive integer (got ${JSON.stringify(item)})`);
        }
        return n;
      }
      throw new Error(`Pack manifest malformed: '${key as string}[${i}]' must be a number or numeric string (got ${JSON.stringify(item)})`);
    });
  }

  const name            = requireString('name');
  const displayName     = requireString('displayName');
  const adapter         = requireString('adapter');
  const version         = requireString('version');
  const description     = requireString('description');
  const size            = requireString('size');
  const signature       = requireString('signature');
  const signedAt        = requireString('signedAt');
  const upstreamPackage = requireString('upstreamPackage');
  const tiersSupported  = requireNumberArray('tiersSupported', { minLength: 1 });
  const capabilityTags  = requireStringArray('capabilityTags');
  const upstreamVersionRange = optionalString('upstreamVersionRange');
  const installCommand       = optionalString('installCommand');

  return {
    name,
    displayName,
    adapter,
    version,
    tiersSupported,
    capabilityTags,
    upstreamPackage,
    upstreamVersionRange,
    installCommand,
    description,
    size,
    signature,
    signedAt,
  };
}

// ============================================================
// Search
// ============================================================

export async function searchPacks(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PackEntry[]> {
  const index = await fetchPackIndex(fetchImpl);
  const lowerQuery = query.toLowerCase();

  const results = index.packs.filter(pack =>
    pack.name.toLowerCase().includes(lowerQuery) ||
    pack.displayName.toLowerCase().includes(lowerQuery) ||
    pack.description.toLowerCase().includes(lowerQuery)
  );

  return results;
}
