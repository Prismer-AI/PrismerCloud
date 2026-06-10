// Shared adapter binary-version helpers (Release 201 v2.0.7 P1).
//
// Each adapter probes `<binary> --version` at startup, parses the result,
// and compares against a pinned `MIN_VERSION` / `KNOWN_GOOD` declared next
// to the adapter. This module owns the comparison logic so the four
// adapters do not redefine their own semver math.
//
// Behaviour:
//   - `compareSemver` is a strict numeric dotted-segment compare. Missing
//     segments are treated as 0 (so "1.2" == "1.2.0").
//   - `isVersionInRange` returns true when the detected version is at least
//     `minVersion`. It soft-passes on "unknown" and on the placeholder
//     "0.0.0" min so adapters can ship a probe without a hard pin during
//     the v2.0.7 governance bootstrap.
//   - Pre-release / build-metadata suffixes (e.g. `-rc1`, `+sha.abc`) are
//     stripped before comparison so a "2.0.0-rc1" build still satisfies
//     a "2.0.0" floor.

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function isVersionInRange(detected: string, minVersion: string): boolean {
  if (detected === 'unknown') return true; // soft pass; caller warns separately
  if (minVersion === '0.0.0') return true; // unpinned floor
  try {
    return compareSemver(detected.split(/[-+]/)[0]!, minVersion) >= 0;
  } catch {
    return true;
  }
}

/**
 * Parse the first dotted-numeric token out of a `<binary> --version` stdout
 * blob. Returns 'unknown' when no semver-shaped token is found so callers
 * can still progress (soft-pass path).
 *
 * Handles common formats:
 *   "hermes 1.2.3"
 *   "codex CLI v0.45.2"
 *   "claude-code 2.0.0-rc1 (build abc123)"
 *   "openclaw 2026.4.5"
 */
export function parseVersionFromStdout(stdout: string): string {
  const m = stdout.match(/(\d+\.\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?(?:\+[\w.]+)?)/);
  return m?.[1] ?? 'unknown';
}
