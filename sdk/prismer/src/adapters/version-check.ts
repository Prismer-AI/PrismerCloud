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
//     `minVersion`.
//   - `checkBinaryPin` is the structured exact-pin check used by the
//     claude-code spawn path (`known-versions.ts` `binaryPin`); violations
//     surface as `AdapterBinaryPinError` (never silent).
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

/**
 * PRISMER_ALLOW_UNPINNED=1 (default OFF) — escape hatch that downgrades
 * unpinned/undetected/mismatched adapter binary versions from an explicit
 * failure back to the legacy soft-pass (callers still warn on stderr).
 * Only the literal value "1" enables it.
 */
export function isUnpinnedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRISMER_ALLOW_UNPINNED === '1';
}

export function isVersionInRange(
  detected: string,
  minVersion: string,
): boolean {
  // Range checks retain the release-201 bootstrap behavior. D1 strictness is
  // deliberately scoped to exact binary pins via checkBinaryPin; Hermes still
  // has an explicit 0.0.0 placeholder and must not be disabled incidentally.
  if (detected === 'unknown') return true;
  if (minVersion === '0.0.0') return true;
  try {
    return compareSemver(detected.split(/[-+]/)[0]!, minVersion) >= 0;
  } catch {
    return true;
  }
}

export type BinaryPinCheckCode =
  | 'ok' // detected == pin
  | 'unpinned' // manifest has no binaryPin (or placeholder) — strict fail
  | 'undetected' // `--version` yielded no parseable version — strict fail
  | 'mismatch' // detected != pin — strict fail
  | 'unpinned_allowed' // same three, downgraded by PRISMER_ALLOW_UNPINNED=1
  | 'undetected_allowed'
  | 'mismatch_allowed';

export interface BinaryPinCheck {
  ok: boolean;
  code: BinaryPinCheckCode;
  detected: string;
  pin: string;
}

/**
 * D1 exact-pin check for the spawn path. Pre-release/build suffixes are
 * stripped from `detected` before comparison ("2.1.179 (Claude Code)" parses
 * to "2.1.179"); the pin must match exactly — floors live in
 * `isVersionInRange`, this is the reproducibility gate.
 */
export function checkBinaryPin(
  detected: string,
  pin: string,
  env: NodeJS.ProcessEnv = process.env,
): BinaryPinCheck {
  const allow = isUnpinnedAllowed(env);
  const fail = (code: 'unpinned' | 'undetected' | 'mismatch'): BinaryPinCheck =>
    allow
      ? { ok: true, code: `${code}_allowed`, detected, pin }
      : { ok: false, code, detected, pin };
  if (!pin || pin === 'unknown' || pin === '0.0.0') return fail('unpinned');
  if (detected === 'unknown') return fail('undetected');
  const normalized = detected.split(/[-+]/)[0]!;
  if (compareSemver(normalized, pin) !== 0) return fail('mismatch');
  return { ok: true, code: 'ok', detected, pin };
}

/**
 * Structured, non-silent pin violation raised on the adapter spawn path.
 * Carries machine-readable fields so dispatch error surfacing / logs can
 * report the exact violation instead of a bare string.
 */
export class AdapterBinaryPinError extends Error {
  readonly code = 'ADAPTER_BINARY_PIN_VIOLATION';
  readonly adapter: string;
  readonly binaryPath: string;
  readonly reason: BinaryPinCheckCode;
  readonly detected: string;
  readonly pin: string;

  constructor(adapter: string, binaryPath: string, check: BinaryPinCheck) {
    super(
      `${adapter} binary version pin violation (${check.code}): detected '${check.detected}' at ${binaryPath}, pinned '${check.pin}' (known-versions.ts binaryPin). ` +
        `Install the pinned version, or set PRISMER_ALLOW_UNPINNED=1 to bypass (behavior then unverified).`,
    );
    this.name = 'AdapterBinaryPinError';
    this.adapter = adapter;
    this.binaryPath = binaryPath;
    this.reason = check.code;
    this.detected = check.detected;
    this.pin = check.pin;
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
