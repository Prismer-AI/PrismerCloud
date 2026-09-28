// D2 config isolation (apc M2-2, docs/apc/05 §1.D).
//
// Problem: `buildSdkEnv` used to inherit the daemon's env untouched, so every
// spawned Claude Code subprocess read the USER's real `~/.claude` (+ `$HOME`
// state like `~/.claude.json`): global plugins / MCP servers / user CLAUDE.md
// bleed into the dev loop and make runs non-reproducible.
//
// Fix: by default the spawned CC gets a per-daemon hermetic config home:
//
//   ~/.prismer/claude-config/            ← HOME (+ USERPROFILE on Windows)
//   ~/.prismer/claude-config/.claude/    ← CLAUDE_CONFIG_DIR
//
// Switch semantics (read dynamically, per spawn):
//   - default (env unset)          → isolation ON.
//   - PRISMER_CC_NO_ISOLATION=1    → legacy behavior: no overlay is applied,
//     the spawned CC reads the user's real `~/.claude` / `$HOME`, and the
//     daemon-side config-dir readers fall back to
//     `CLAUDE_CONFIG_DIR ?? ~/.claude` exactly as before M2-2. This is the
//     escape hatch for existing desktop users who rely on their global Claude
//     Code setup; only the literal value "1" disables isolation.
//
// Daemon-side readers (session history at agent.ts resolveHistoryPath,
// listImportableSessions, models.ts settings discovery, project-dir.ts) MUST
// resolve through `resolveEffectiveClaudeConfigDir()` so they look at the SAME
// directory the spawned CC writes to — otherwise history/session import breaks
// silently when isolation is on.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function isClaudeConfigIsolationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRISMER_CC_NO_ISOLATION !== "1";
}

/** Isolated HOME for spawned Claude Code processes. */
export function resolveIsolatedClaudeHome(): string {
  return path.join(os.homedir(), ".prismer", "claude-config");
}

/** Isolated CLAUDE_CONFIG_DIR (mirrors the normal `$HOME/.claude` layout). */
export function resolveIsolatedClaudeConfigDir(): string {
  return path.join(resolveIsolatedClaudeHome(), ".claude");
}

/**
 * The Claude config dir the daemon itself should read (history, session
 * import, settings model discovery). Matches what the spawned CC sees:
 * isolation ON → the isolated dir; isolation OFF → legacy
 * `CLAUDE_CONFIG_DIR ?? ~/.claude`.
 */
export function resolveEffectiveClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (isClaudeConfigIsolationEnabled(env)) {
    return resolveIsolatedClaudeConfigDir();
  }
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * Env overlay for the spawned Claude Code process. `undefined` when isolation
 * is disabled (legacy passthrough). Pure — no filesystem side effects.
 */
export function claudeConfigIsolationOverlay(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!isClaudeConfigIsolationEnabled(env)) {
    return undefined;
  }
  const home = resolveIsolatedClaudeHome();
  return {
    HOME: home,
    // Windows resolves the profile via USERPROFILE, not HOME.
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  };
}

// ---------------------------------------------------------------------------
// apc/14 D6 — dispatch-side held-out write DENY (docs/apc/02 §2 R4).
//
// The review-side diff gate (scripts/test203/run.ts --review-diff) is the
// review half of the double constraint. This is the dispatch half: when the
// dispatcher marks a run as an APC coding-scope run (env APC_HELDOUT_DENY=1),
// the spawn passes `permissions.deny` rules to the Claude Code process so it
// PHYSICALLY cannot open a held-out file for write/edit — deny rules are a
// hard boundary honored even in bypassPermissions mode (where the canUseTool
// predicate is never consulted).
//
// desktop205 W4: the rules are handed over PER RUN (SDK `Options.settings` →
// CC's `--settings` flag, which CC materializes into its own temp file) and
// are NEVER written to the per-daemon hermetic ~/.prismer/claude-config.
// The previous read-merge-write into that shared settings.json was only ever
// additive (`new Set([...existing, ...rules])`), so a single APC run left the
// deny list in place for every unrelated coding agent on the same machine,
// forever. Per-run passing removes the shared mutable state entirely; a normal
// (non-APC) agent gets no deny rules because nothing is persisted.
//
// desktop205 W5: the SWITCH is per-run too. `apcHeldOutDenySettings(env)` is
// called from agent.ts::buildOptions with the composed SPAWN env (daemon env ⊕
// the dispatch's per-task env ⊕ launch env), not with the daemon's process.env.
// Before W5 it read process.env, so the only way to turn the boundary on was to
// set it for the whole daemon — which narrows every unrelated coding agent on
// that daemon, i.e. exactly the blast radius W4 had just removed (F7).
//
// ⚠️ SCOPE: this is a HINT, not a security boundary (00-INDEX §2.4). `Bash` is
// structurally outside the file-permission check and can write any held-out
// file; 01 §F2 shows the CC binary itself saying so. It exists to lower the
// probability of an accidental touch, and must not be given weight (or
// mechanism) beyond that.
//
// ⚠️ SINGLE SOURCE OF TRUTH: APC_HELD_OUT_PATHS below MIRRORS
// scripts/test203/heldout-guard.ts::HELD_OUT_PATHS. The runtime package roots
// at ./src (rootDir) and cannot import a file outside the package without
// breaking tsc, so the list is mirrored and a drift-guard test
// (test/apc-heldout-deny.test.ts) reads the source file and fails if the two
// lists diverge — the two enforcement mechanisms cannot silently drift apart.
export const APC_HELD_OUT_PATHS = [
  "scripts/test203/baseline.json",
  "apps/desktop/e2e/smoke",
  "scripts/test203/journeys",
  "scripts/contract-tests",
  "scripts/product205",
  "scripts/test203/reset-fixtures.selftest.ts",
  "e2e-playwright/specs/__snapshots__",
  "tests/playwright/__snapshots__",
] as const;

// Write-capable tools whose held-out targets must be denied. Read tools stay
// allowed — the boundary is write-only (agents may still READ baselines to run
// the gates, just not mutate them).
//
// desktop205 W3 — this list used to be ["Write","Edit","MultiEdit","NotebookEdit"].
// Claude Code 2.1.220 rejects 3 of those 4 at startup (verified against the real
// binary, docs/desktop205/01-evidence §F1):
//   Permission deny rule "MultiEdit(p)" matches no known tool — check for typos.
//   Permission deny rule ...: Write(p) is not matched by file permission checks —
//     only Edit(path) rules are. Use Edit(p) instead (Edit rules cover all
//     file-editing tools).
// i.e. `Edit(path)` is the ONLY path-scoped matcher that participates in the file
// permission check, and it covers every file-editing tool (Write / NotebookEdit /
// …). Collapsing to ["Edit"] therefore does NOT weaken the boundary — it removes
// 6 dead rules per held-out path (54 stderr warning lines per spawn).
const APC_DENY_TOOLS = ["Edit"] as const;

/**
 * Dispatch-side switch. Only "1" enables; default OFF (normal agents unaffected).
 *
 * desktop205 W5 — `env` MUST be the composed per-spawn env, never the daemon's
 * process.env: this decides whether ONE run gets the boundary, not whether the
 * machine does.
 */
export function isApcHeldOutDenyEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.APC_HELDOUT_DENY === "1";
}

/**
 * desktop205 W5 (setter half) — the task-metadata key the daemon's dispatch
 * stamps with THIS dispatch's APC coding-scope verdict.
 *
 * WHO DECIDES. Not this module, and not a `cwd`-sniffing heuristic invented
 * here. The verdict is the SAME one the APC coding-SKILL half already runs on:
 * `skill-sync.ts::resolvePlatformScope`, i.e. cloud's authoritative
 * `GET /api/im/workspaces/:id → platformScoped` projection (desktop205 W1/D2-b;
 * "platform workspace" = a workspace owned by a platform-admin account, user
 * decree 2026-07-26). One definition of "APC scope" feeds both halves —
 * "which agents get the APC skill set" and "which runs get the held-out deny
 * hint" are the same question, so they must not be answered twice.
 *
 * `unknown` (offline / old cloud / non-boolean / no workspaceId) resolves to
 * NOT set. The two halves fail in OPPOSITE directions on purpose and both mean
 * "take no action": the skill half leaves the dir untouched (evicting a
 * platform engineer's toolchain on a cloud blip would be the damaging move),
 * while this half adds nothing (narrowing an unrelated civilian agent's Claude
 * Code on a cloud blip would be the damaging move — exactly the blast radius
 * W4/W5 removed). Failing open costs little here because the deny list is a
 * HINT, not a boundary: `Bash` is structurally outside CC's file-permission
 * check (00-INDEX §2.4, 01 §F2) and the real protection is the review-side
 * diff gate (`scripts/test203/run.ts --review-diff`, in CI).
 */
export const APC_HELDOUT_DENY_METADATA_KEY = "apcHeldOutDeny";

/**
 * Map the stamped verdict onto the per-task env overlay that
 * `buildClaudeSpawnEnv` layers over the daemon env (`extra.claude.env` →
 * `taskEnv`). Returns undefined when this run is not APC coding-scope.
 *
 * Strictly `=== true`: dispatch always writes a boolean it computed itself, so
 * a stale/hostile `payload.metadata` carrying a truthy string can never switch
 * the boundary on.
 */
export function apcHeldOutDenyTaskEnv(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  return metadata?.[APC_HELDOUT_DENY_METADATA_KEY] === true
    ? { APC_HELDOUT_DENY: "1" }
    : undefined;
}

/**
 * Claude Code `permissions.deny` rules for the held-out paths. For each path we
 * emit both the exact-path matcher and a `/**` glob so a held-out FILE
 * (baseline.json) and a held-out DIRECTORY (journeys/) are both covered without
 * needing to stat the filesystem. Pure — derived solely from the path list.
 */
export function apcHeldOutDenyRules(
  paths: readonly string[] = APC_HELD_OUT_PATHS,
): string[] {
  const rules: string[] = [];
  for (const p of paths) {
    for (const tool of APC_DENY_TOOLS) {
      rules.push(`${tool}(${p})`);
      rules.push(`${tool}(${p}/**)`);
    }
  }
  return rules;
}

/**
 * The per-run Claude Code settings carrying the held-out deny boundary, or null
 * when this run is not an APC coding-scope run. PURE — no filesystem side
 * effects at all (desktop205 W4: the rules must never land in the per-daemon
 * shared ~/.prismer/claude-config/settings.json, where they would outlive the
 * run and leak onto every other coding agent on the machine).
 *
 * Still gated on config isolation being ON: with PRISMER_CC_NO_ISOLATION=1 the
 * spawned CC reads the user's real ~/.claude, and silently narrowing a user's
 * own Claude Code setup is out of scope for the APC boundary.
 */
export function apcHeldOutDenySettings(
  env: NodeJS.ProcessEnv = process.env,
): { permissions: { deny: string[] } } | null {
  if (!isApcHeldOutDenyEnabled(env) || !isClaudeConfigIsolationEnabled(env)) {
    return null;
  }
  return { permissions: { deny: apcHeldOutDenyRules() } };
}

/**
 * The exact `--settings` payload the spawned Claude Code process receives. The
 * Agent SDK JSON.stringify's `Options.settings` and passes it as the value of
 * the `--settings` CLI flag, so these are the literal bytes CC parses and
 * validates. Exported so the CC-rule-syntax gate (test/apc-heldout-cc-syntax.test.ts)
 * can feed the shipped payload to a real `claude` binary instead of
 * re-deriving it.
 */
export function apcHeldOutSettingsArg(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const settings = apcHeldOutDenySettings(env);
  return settings === null ? null : JSON.stringify(settings);
}

// ---------------------------------------------------------------------------
// desktop205 W4 migration — prune the deny rules the PRE-W4 code left behind.
//
// Before W4 this module read-merge-wrote the rules into the shared hermetic
// settings.json with `new Set([...existing, ...rules])`. Additive only: there
// was no removal path, so on any machine that ever ran one APC run the rules
// are still sitting in that file, silently narrowing every coding agent. W4
// stopped NEW pollution; it cannot un-write the old.
//
// The prune removes exactly the strings that code could have produced and
// nothing else. `Write(...)` / `MultiEdit(...)` / `NotebookEdit(...)` are in the
// removal set even though W3 collapsed generation to `Edit` — those three are
// precisely what the OLD code wrote, so they are the bulk of the debris.
// ---------------------------------------------------------------------------

/**
 * Every deny tool prefix any shipped version of this file has ever emitted.
 * Pre-W3 the list was Write/Edit/MultiEdit/NotebookEdit; W3 collapsed generation
 * to `Edit` alone (the other three are not matched by CC's file permission
 * check), but the retired three are exactly what old machines have on disk.
 */
const LEGACY_APC_DENY_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/**
 * The full set of deny rules the pre-W4 writer could have produced, across every
 * tool spelling it ever used. The held-out path list has only ever grown
 * (`scripts/test203/reset-fixtures.selftest.ts` was appended after the initial
 * 8), so deriving from the CURRENT list is a superset of what any shipped
 * version wrote.
 *
 * A path REMOVED from APC_HELD_OUT_PATHS would stop being pruneable if we derived
 * only from the current list — its rules are already on disk. Retired paths are
 * therefore kept below, and the prune set is (current ∪ retired). Retiring a path
 * means MOVING it into RETIRED_APC_HELD_OUT_PATHS, never just deleting the line.
 */
const RETIRED_APC_HELD_OUT_PATHS = [
  // desktop205 D9 — dropped from the held-out list because it is gitignored
  // (so the review gate could never see it) and holds only regenerated evidence
  // plus scratch shot scripts. Old on-disk rules must still be pruneable.
  "scripts/test203/artifacts",
] as const;

function legacyApcHeldOutDenyRuleSet(): Set<string> {
  const set = new Set<string>();
  for (const p of [...APC_HELD_OUT_PATHS, ...RETIRED_APC_HELD_OUT_PATHS]) {
    for (const tool of LEGACY_APC_DENY_TOOLS) {
      set.add(`${tool}(${p})`);
      set.add(`${tool}(${p}/**)`);
    }
  }
  return set;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ApcDenyPruneResult =
  | { status: "absent" }
  | { status: "unchanged" }
  | { status: "pruned"; removed: string[]; kept: string[] };

/**
 * One-shot, idempotent cleanup of a settings.json polluted by the pre-W4 writer.
 *
 * Removes from `permissions.deny` only the entries that EXACTLY equal a rule the
 * old code generated. A user's own rules survive verbatim — including ones that
 * merely LOOK like ours (`Edit(src/whatever)`), because membership is exact
 * string equality against a derived set, not a pattern match. When the resulting
 * deny list is empty the `deny` key is dropped; nothing else in the file — not
 * even an emptied `permissions` object — is touched.
 *
 * Never throws: a missing / unreadable / non-JSON / read-only settings.json is
 * reported, not raised. This runs on the dispatch path and a failed cleanup must
 * never cost a run.
 */
export function pruneApcHeldOutDenyFromSettings(configDir: string): ApcDenyPruneResult {
  const settingsPath = path.join(configDir, "settings.json");
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return { status: "absent" };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    // Malformed file: leave it exactly as-is. Rewriting a file we cannot parse
    // would destroy whatever the user has in there.
    return { status: "absent" };
  }
  if (!isPlainObject(settings)) {
    return { status: "absent" };
  }
  const permissions = settings.permissions;
  if (!isPlainObject(permissions) || !Array.isArray(permissions.deny)) {
    return { status: "unchanged" };
  }

  const ours = legacyApcHeldOutDenyRuleSet();
  const deny = permissions.deny as unknown[];
  const kept = deny.filter((rule) => !(typeof rule === "string" && ours.has(rule)));
  if (kept.length === deny.length) {
    return { status: "unchanged" };
  }
  const removed = deny.filter(
    (rule): rule is string => typeof rule === "string" && ours.has(rule),
  );

  if (kept.length === 0) {
    delete permissions.deny;
  } else {
    permissions.deny = kept;
  }

  try {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    return { status: "absent" };
  }
  return { status: "pruned", removed, kept: kept as string[] };
}

let ensuredIsolationDir: string | null = null;

/**
 * Ensure the isolation dirs exist (idempotent, cached) and return the spawn
 * overlay. Called from `buildSdkEnv` so the dirs are guaranteed before any
 * spawn; safe to call repeatedly.
 *
 * desktop205 W4 migration lives here — NOT at daemon startup — for three
 * reasons: (a) this function already owns the hermetic dir and is the one thing
 * guaranteed to run before any Claude Code spawn, so the file is clean before
 * the first process could read it; (b) the pollution only exists when isolation
 * is ON, and this is the function that knows that (a daemon-startup hook would
 * have to re-derive it, and would also fire on daemons that never spawn CC);
 * (c) it is already once-per-daemon-process cached, which is exactly the
 * cadence a one-shot migration wants. Failures are swallowed — a cleanup that
 * cannot run must not block a dispatch.
 */
export function ensureClaudeConfigIsolation(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const overlay = claudeConfigIsolationOverlay(env);
  if (!overlay) {
    return undefined;
  }
  const configDir = overlay.CLAUDE_CONFIG_DIR!;
  if (ensuredIsolationDir !== configDir) {
    mkdirSync(configDir, { recursive: true });
    try {
      pruneApcHeldOutDenyFromSettings(configDir);
    } catch {
      // Belt and braces — the function is already non-throwing.
    }
    ensuredIsolationDir = configDir;
  }
  return overlay;
}
