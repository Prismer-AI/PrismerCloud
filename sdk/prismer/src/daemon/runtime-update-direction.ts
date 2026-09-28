/**
 * Direction gate shared by boot-time OTA and the two-phase apply control
 * frame. A lower target is actionable only when Cloud explicitly labels it
 * `rollback`; an ordinary/stale `ota` frame can never restart a newer daemon.
 */

export type RuntimeUpdateDecision = 'ota' | 'rollback';

export type RuntimeUpdateRejectReason =
  | 'target_missing'
  | 'up_to_date'
  | 'downgrade_not_authorized'
  | 'rollback_direction_invalid'
  | 'version_unparseable';

export type RuntimeUpdateDirectionResult =
  | { accepted: true; decision: RuntimeUpdateDecision; targetVersion: string }
  | {
      accepted: false;
      decision: RuntimeUpdateDecision;
      targetVersion?: string;
      reason: RuntimeUpdateRejectReason;
    };

/**
 * Numeric dotted version comparison; suffixes are ignored for direction.
 * Both the prerelease (`-rc1`) and build (`+desktop`) suffixes are stripped —
 * the desktop daemon reports a build-suffixed version while the cloud OTA
 * target is the bare registry version, and treating that as a difference
 * would churn drain_respawn on the SAME release.
 */
export function compareRuntimeVersions(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const core = value.trim().split(/[+-]/)[0];
    if (!core || !/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split('.').map(Number);
  };
  const av = parse(a);
  const bv = parse(b);
  if (!av || !bv) return null;
  const length = Math.max(av.length, bv.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (av[i] ?? 0) - (bv[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function evaluateRuntimeUpdateDirection(input: {
  currentVersion: string;
  targetVersion?: string;
  decision?: RuntimeUpdateDecision;
}): RuntimeUpdateDirectionResult {
  const decision = input.decision ?? 'ota';
  const targetVersion = input.targetVersion?.trim();
  if (!targetVersion) return { accepted: false, decision, reason: 'target_missing' };

  // runtime210/09 review P3 (group B) — direction decisions ride the
  // SUFFIX-STRIPPED numeric comparison, not string equality: a build-suffixed
  // current (`2.2.36+desktop`) vs the bare target (`2.2.36`) is the SAME
  // release and must be up_to_date, never a drain_respawn.
  const comparison = compareRuntimeVersions(input.currentVersion, targetVersion);
  if (comparison === 0) {
    return { accepted: false, decision, targetVersion, reason: 'up_to_date' };
  }
  // Unparseable on either side ⇒ direction cannot be judged at all. The old
  // code let `comparison === null` fall through BOTH guards (accept in both
  // directions) — a blind pass that could restart a daemon on garbage input.
  // Fail closed with an explicit reason instead.
  if (comparison === null) {
    return { accepted: false, decision, targetVersion, reason: 'version_unparseable' };
  }
  if (comparison > 0 && decision !== 'rollback') {
    return { accepted: false, decision, targetVersion, reason: 'downgrade_not_authorized' };
  }
  if (comparison <= 0 && decision === 'rollback') {
    return { accepted: false, decision, targetVersion, reason: 'rollback_direction_invalid' };
  }
  return { accepted: true, decision, targetVersion };
}
