/**
 * Skill Registry Client (P16 Registry source interop).
 *
 * Resolves `<registry>:<ref>` skill references to downloadable tarballs.
 * Supported registries:
 *   - prismer:<name>                       → prismer.cloud signed registry
 *   - github:<owner>/<repo>[@<ref>]       → tarball from GitHub
 *   - well-known:<https://domain/path>    → fetched from a well-known URL
 *
 * Each resolver returns a tarball URL plus a sha256 expectation (if known) and
 * a signature (if the registry publishes one). The installer verifies both
 * before unpacking into `~/.prismer/skills/<name>/`.
 *
 * This file is transport-agnostic — no actual fs / network writes happen here.
 * The caller (CLI or runtime) drives download + extract + signature check.
 */

export type RegistryKind = 'prismer' | 'github' | 'well-known';

export interface ResolvedSkillRef {
  registry: RegistryKind;
  name: string;
  tarballUrl: string;
  sha256?: string;
  signature?: string;
  /** Expected frontmatter name for `agent.skill.installed`. */
  displayName?: string;
}

/** Parse `<registry>:<ref>` → (kind, ref). Throws on unsupported prefix. */
export function parseSkillRef(ref: string): { kind: RegistryKind; body: string } {
  const idx = ref.indexOf(':');
  if (idx === -1) {
    throw new Error(`skill ref missing registry prefix: ${ref}. Expected <registry>:<path>`);
  }
  const prefix = ref.slice(0, idx);
  const body = ref.slice(idx + 1);
  if (prefix !== 'prismer' && prefix !== 'github' && prefix !== 'well-known') {
    throw new Error(`unsupported skill registry: ${prefix}`);
  }
  return { kind: prefix, body };
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  /** Override for prismer registry base (test + enterprise mirrors). */
  prismerRegistryBase?: string;
}

/** Resolve a skill ref into a downloadable tarball URL + integrity metadata. */
export async function resolveSkillRef(ref: string, opts: ResolveOptions = {}): Promise<ResolvedSkillRef> {
  const { kind, body } = parseSkillRef(ref);
  const fetchFn = opts.fetchImpl ?? fetch;

  switch (kind) {
    case 'prismer':
      return resolvePrismer(body, fetchFn, opts.prismerRegistryBase);
    case 'github':
      return resolveGitHub(body);
    case 'well-known':
      return resolveWellKnown(body, fetchFn);
  }
}

// ────────────────────────────────────────────────────────────────────────

async function resolvePrismer(
  name: string,
  fetchFn: typeof fetch,
  base?: string,
): Promise<ResolvedSkillRef> {
  const registryBase = base ?? 'https://skills.prismer.cloud/v1';
  const metaUrl = `${registryBase}/${encodeURIComponent(name)}/latest.json`;
  const resp = await fetchFn(metaUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`prismer registry: ${name} → HTTP ${resp.status}`);
  }
  const meta = await resp.json() as {
    tarball: string;
    sha256?: string;
    signature?: string;
    displayName?: string;
  };
  return {
    registry: 'prismer',
    name,
    tarballUrl: meta.tarball,
    sha256: meta.sha256,
    signature: meta.signature,
    displayName: meta.displayName,
  };
}

function resolveGitHub(body: string): ResolvedSkillRef {
  // Forms: owner/repo, owner/repo@ref, owner/repo/path@ref
  const [repoPart, ref] = body.split('@');
  const parts = repoPart.split('/');
  if (parts.length < 2) {
    throw new Error(`github skill ref: expected owner/repo[@ref], got ${body}`);
  }
  const owner = parts[0];
  const repo = parts[1];
  const tag = ref ?? 'HEAD';
  const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${tag}`;
  return {
    registry: 'github',
    name: `${owner}/${repo}`,
    tarballUrl,
    // No sha256/signature — github refs are content-addressed by commit,
    // which the caller can verify out-of-band via `git log`.
  };
}

async function resolveWellKnown(body: string, fetchFn: typeof fetch): Promise<ResolvedSkillRef> {
  // body is the full URL to the .well-known metadata document.
  const resp = await fetchFn(body, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`well-known skill: HTTP ${resp.status} (${body})`);
  }
  const meta = await resp.json() as {
    name?: string;
    tarball?: string;
    sha256?: string;
    signature?: string;
  };
  if (!meta.tarball) {
    throw new Error(`well-known skill: metadata missing 'tarball' (${body})`);
  }
  return {
    registry: 'well-known',
    name: meta.name ?? body,
    tarballUrl: meta.tarball,
    sha256: meta.sha256,
    signature: meta.signature,
  };
}
