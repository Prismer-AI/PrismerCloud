/**
 * T8 / 08 §5.2 — Image pin service.
 *
 * Resolves the canonical daemon image ref the cloud should inject into pod
 * specs. The resolution order is intentionally narrow so production cannot
 * silently fall back to a stale tag:
 *
 *   1. `CONTAINER_IMAGE` env (CI / operator override)
 *   2. `infra/sandbox-image/image-pin.yaml` → `images.daemon.canonical`
 *   3. REJECT (throw — refuse to provision rather than ImagePullBackOff)
 *
 * The `request.image` priority (caller explicit override) is enforced
 * upstream in `k8s-sandbox.ts::provisionContainer` (it passes `config.image`
 * through unchanged when set). This module is the fallback resolver.
 *
 * Notes:
 *   - Loaded synchronously at first call from disk; cached for the process
 *     lifetime. Tests can reset via `_resetCache()`.
 *   - Parser is intentionally lightweight (line-based regex) so the cloud
 *     does not take a hard runtime dep on `yaml` at module-init time — the
 *     `yaml` package IS in deps, but a tiny parser keeps the surface
 *     unambiguous (we only read 3-4 fields).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DaemonImagePin {
  canonical: string;
  digest: string;
  lastBuiltAt: string;
  pinnedBy: string;
}

interface ImagePinFile {
  images: { daemon: DaemonImagePin };
}

// 2026-05-25 — touched AGAIN to force HMR reload. Last touch shipped
// daemon-v2.0.6-approval-ok-fix into cache; yaml has since bumped to
// daemon-v2.0.6-reliability-v2 (P0 + P1 + Cleanup batch). Module-level
// `cached` resets on re-import so the next sandbox provision reads the
// new yaml. If Next.js dev fails to HMR this for some reason, fully
// restart the dev server.
let cached: ImagePinFile | null = null;

/**
 * Parse `image-pin.yaml`. We only consume a narrow shape:
 *   images:
 *     daemon:
 *       canonical: <string>
 *       digest: <string>
 *       lastBuiltAt: <string>
 *       pinnedBy: <string>
 *
 * Anything else (comments, top-level keys we don't recognise) is ignored.
 * Strings may be quoted (single or double) or bare.
 */
function parseImagePin(raw: string): ImagePinFile {
  const lines = raw.split('\n');
  let inImagesDaemon = false;
  let inImages = false;
  const pin: Partial<DaemonImagePin> = {};

  const readScalar = (val: string): string => {
    const trimmed = val.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
    return trimmed;
  };

  for (const rawLine of lines) {
    // Strip inline comments (only when '#' is preceded by whitespace; URLs in
    // values do not contain '#' so this is safe for our schema).
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;

    // Top-level keys (no indent)
    if (/^[A-Za-z]/.test(noComment)) {
      inImages = noComment.startsWith('images:');
      inImagesDaemon = false;
      continue;
    }

    if (!inImages) continue;

    // Second-level keys (2-space indent under `images:`)
    if (/^ {2}[A-Za-z]/.test(noComment)) {
      inImagesDaemon = /^ {2}daemon:/.test(noComment);
      continue;
    }

    if (!inImagesDaemon) continue;

    // Third-level (4-space indent under `daemon:`) — these are our fields.
    const m = /^ {4}(canonical|digest|lastBuiltAt|pinnedBy):\s*(.*)$/.exec(noComment);
    if (m) {
      const [, key, val] = m;
      pin[key as keyof DaemonImagePin] = readScalar(val);
    }
  }

  return {
    images: {
      daemon: {
        canonical: pin.canonical ?? '',
        digest: pin.digest ?? '',
        lastBuiltAt: pin.lastBuiltAt ?? '',
        pinnedBy: pin.pinnedBy ?? 'unknown',
      },
    },
  };
}

function load(): ImagePinFile {
  if (cached) return cached;
  // Resolve relative to the repo root. The cloud always runs from repo root
  // (Next.js workspace root); standalone test scripts use cwd-relative.
  const pinPath = resolve(process.cwd(), 'infra/sandbox-image/image-pin.yaml');
  let raw: string;
  try {
    raw = readFileSync(pinPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[image-pin] cannot read ${pinPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        'image-pin.yaml is required to resolve the canonical sandbox image ref (08 §5.2). ' +
        'Set CONTAINER_IMAGE env to bypass for one-off scripts.',
    );
  }
  cached = parseImagePin(raw);
  emitVersionDriftWarnOnce(cached);
  return cached;
}

let driftWarnEmitted = false;

/**
 * 2026-05-29 — warn (once per process) when image-pin.yaml's canonical tag
 * encodes a different version than /VERSION. This is the silent failure
 * mode that broke the v2.0.7 → kind pull loop: the cloud bumped to /VERSION
 * 2.0.7 but image-pin.yaml stayed on daemon-v2.0.6, so pods kept pulling
 * the older image even though localhost:5001 already served the new one.
 *
 * We extract the version from the canonical ref's `:daemon-v<VERSION>`
 * tail (the convention enforced by build.sh and bump-image-pin.sh). If
 * extraction fails (custom override tag) we stay silent — those are valid
 * use cases for CI / one-off pins.
 *
 * The warning is informational. We do NOT throw — production may legitimately
 * pin to an older tag during a phased rollback. The fix command pointer
 * tells dev-time users where to look.
 */
function emitVersionDriftWarnOnce(pin: ImagePinFile): void {
  if (driftWarnEmitted) return;
  const canonical = pin.images?.daemon?.canonical;
  if (typeof canonical !== 'string' || canonical.length === 0) return;

  // Pull the version segment from the tag suffix `:daemon-v<VERSION>`.
  const match = canonical.match(/:daemon-v([^\s]+?)(?:-[a-z][\w-]*)?$/);
  const pinVersion = match?.[1];
  if (!pinVersion) return; // custom override — silent

  let repoVersion: string | undefined;
  try {
    repoVersion = readFileSync(resolve(process.cwd(), 'VERSION'), 'utf-8').trim();
  } catch {
    return; // running outside repo root (unusual) — silent
  }
  if (!repoVersion || pinVersion === repoVersion) {
    driftWarnEmitted = true;
    return;
  }

  // Drift confirmed — warn with the precise fix command.
  driftWarnEmitted = true;

  console.warn(
    `[image-pin] ⚠️  version drift detected: /VERSION=${repoVersion} but image-pin.yaml canonical=daemon-v${pinVersion}. ` +
      `Sandbox pods will run an OLDER daemon than the cloud expects. ` +
      `Fix: bash scripts/sandbox/dev-loop.sh bootstrap-local`,
  );
}

/**
 * Resolve the canonical daemon image ref for new pod specs.
 *
 * Priority:
 *   1. `CONTAINER_IMAGE` env (CI / operator override)
 *   2. `image-pin.yaml` → `images.daemon.canonical`
 *   3. throw — never silently fall back to a ghost tag.
 */
export function getDaemonImage(): string {
  const fromEnv = process.env.CONTAINER_IMAGE?.trim();
  if (fromEnv) return fromEnv;

  const pin = load();
  const canonical = pin.images?.daemon?.canonical?.trim();
  if (!canonical) {
    throw new Error(
      '[image-pin] no canonical image — refusing to provision sandbox. ' +
        'Set CONTAINER_IMAGE env or fix infra/sandbox-image/image-pin.yaml ' +
        '(images.daemon.canonical). 08 §5.2 — "永远 reject 优于永远 ImagePullBackOff".',
    );
  }
  return canonical;
}

/**
 * Return the full pin record (for /healthz / admin / diagnostic surfaces).
 * Same priority as `getDaemonImage` for the canonical field; digest /
 * lastBuiltAt always come from disk (env override is not applied to those).
 */
export function getDaemonImagePin(): DaemonImagePin {
  const fromEnv = process.env.CONTAINER_IMAGE?.trim();
  const pin = load();
  return {
    canonical: fromEnv || pin.images.daemon.canonical,
    digest: pin.images.daemon.digest,
    lastBuiltAt: pin.images.daemon.lastBuiltAt,
    pinnedBy: fromEnv ? 'env:CONTAINER_IMAGE' : pin.images.daemon.pinnedBy,
  };
}

/** Test-only cache reset. */
export function _resetCache(): void {
  cached = null;
}
