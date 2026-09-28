import { promises as fsp } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CloudClient } from '../auth.js';
import type { AgentProfile } from '../adapters/contract.js';
import { getHermesProfileDir, getHermesProfileName } from '../adapters/persistence/hermes/index.js';
import { pruneHermesSkillProjections } from '../adapters/persistence/hermes/native-skill-projection.js';
import { resolveAgentDirPaths } from './agent-dir.js';
import {
  installPlatformApcSkills,
  reconcileEntitledSkillDirs,
  resolveBuiltInSkillsRoot,
} from '../adapters/coding/shared/coding-skill-set.js';
import type { ConfigPaths } from '../config.js';
import { ExponentialBackoff } from './churn-guard.js';
import {
  resolveBundledSkillDirectory,
  resolveSkillSource,
  SKILL_SOURCE_RECEIPT,
  verifiedLocalSnapshot,
  type SkillResolutionResult,
} from './skill-source-resolution.js';

/**
 * release201/09 §9.3.2 — per-agent skill root context.
 *
 * When `paths` + `daemonId` are both provided AND the profile is hermes /
 * openclaw, skill files land in `devices/<did>/agents/<aid>/skills/` (new
 * per-agent layout, fixes the latent bug where two agents on the same
 * daemon hosting the same skill slug at different versions collided into
 * one shared profile-driven skillsDir).
 *
 * Legacy fallback (no ctx, no daemonId, or non-hermes/openclaw adapter):
 * `resolveSkillsRoot` returns the pre-09 path so tests + container/sandbox
 * paths without daemon paths keep working.
 *
 * `profile.config.skillsDir`,if explicitly set,继续生效作 override —
 * §9.3.2 deprecated 但仍接受 (用户自管 skill dir 的场景)。
 */
export interface SkillsRootContext {
  paths?: ConfigPaths;
  daemonId?: string;
  /**
   * apc — the EFFECTIVE cwd of a coding dispatch (workdir override if one was
   * materialized, else `profile.config.cwd`). Only consulted for the
   * claude-code adapter, whose skills live in `<cwd>/.claude/skills/`.
   * Absent → fall back to `profile.config.cwd`.
   */
  codingCwd?: string;
}

/** Unsafe disk state must abort dispatch, unlike recoverable catalog outages. */
export class SkillSyncSafetyError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SkillSyncSafetyError';
  }
}

/**
 * §A.7 Multi-file Manifest v1 — wire shape from cloud.
 *
 * Each entry in /api/im/skills/installed?agentId=... response.
 * `skill.contentManifest` (new, v2.1+) is a JSON string holding files[].
 * `skill.content` (legacy, dual-write 6mo) is the single-file SKILL.md text.
 *
 * Forward compat: old daemon ignores contentManifest, reads content only.
 * Backward compat: new daemon prefers contentManifest, falls back to content.
 */
interface InstalledSkillEntry {
  slug?: unknown;
  content?: unknown;
  skill?: {
    id?: unknown;
    slug?: unknown;
    content?: unknown;
    contentManifest?: unknown;
    contentManifestRevision?: unknown;
  };
}

/**
 * §A.7.2 — Skill Manifest v1 file descriptor.
 * Either `inline + content (base64)` for size ≤ 100KB, or `url` for >100KB
 * (served via 07-D S3 + CloudFront). `sha256` is mandatory for verification.
 */
interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  inline?: boolean;
  content?: string; // base64
  url?: string;
}

export interface SkillSyncResult {
  /** Catalog unavailable: only sealed local installations were revalidated. */
  catalogError?: string;
  /** Non-destructive isolation, outside skill scan roots; retained for operator recovery. */
  quarantined?: Array<{ slug: string; path: string; reason: string }>;
  synced: number;
  skipped: number;
  /**
   * N2 — count of whole skill directories pruned this sync (uninstalled skills
   * whose `<slug>/` dir was left on disk). Per-file orphan prune (below) only
   * cleans extra files inside slugs still in the active list; it never removes
   * a `<slug>/` dir for a skill that left the active list (uninstall). The
   * system-prompt skill section is rebuilt per-dispatch by readdir(skillsRoot),
   * so a leftover dir = a stale section that never disappears. `pruned>0` flips
   * the dispatch respawn guard so the gateway re-scans its tool catalog too.
   */
  pruned?: number;
  unchanged: number;
  /**
   * release201/11 §4 #7 — skills that were load-into-dispatch (synced or already
   * up-to-date on disk) for this dispatch. Used by dispatch.ts to emit a
   * `skill.invoked` metric per skill so Studio Metrics view sees real counters.
   *
   * v2.0.7 semantic: "skill load-into-dispatch" is treated as a proxy for
   * "LLM-actually-invoked" until adapters surface explicit tool_use traces
   * (deferred to v2.1+; see docs/release201/11 §4 footnote #7).
   *
   * `slug` is the on-disk dir name (sanitised); `skillId` is the canonical
   * skill row id (preferred dim key when populated; some legacy entries only
   * carry the slug).
   */
  loadedSkills: Array<{ slug: string; skillId?: string | null }>;
  /** Source selected for each loaded or failed skill in this sync pass. */
  resolutions?: SkillResolutionResult[];
  /**
   * release201/09 §9.3.2 audit (2026-05-29) — when the agent has 0 entries
   * (or is missing required built-ins) we POST `install-builtins` to repair.
   * Pre-fix, both HTTP 403/404 and thrown errors were silently swallowed
   * via stderr (the `if (backfill.ok && ...)` gate skipped non-2xx responses
   * without surfacing them). Surfacing the failure here lets
   * `prismer skill sync --json` show operators why `synced=0` when the
   * daemon-local agent has zero skill rows in cloud DB.
   *
   * `undefined`           = backfill not attempted (entries.length > 0 with
   *                          all required slugs present, OR adapter is not
   *                          hermes/openclaw).
   * `{ ok: true }`        = backfill ran and at least 1 skill was installed.
   * `{ ok: false }`       = backfill attempted but cloud rejected or threw.
   */
  backfill?: {
    attempted: true;
    ok: boolean;
    installed?: number;
    status?: number;
    message?: string;
  };
}

// This is the runtime authoring floor, not merely a historical bootstrap
// pair. Older agents that already had tasks/office-artifacts must still pick
// up the canonical PKF authoring + visual vocabulary used by fixed report
// directives and inline reply extraction.
const REQUIRED_BUILT_IN_SKILL_SLUGS = new Set([
  'tasks',
  'office-artifacts',
  'pkf-writing',
  'pkf-svg',
]);

/**
 * F16 (2026-05-20) — full-fanout skill sync across every local profile.
 *
 * Previously skills were synced **only** at task-dispatch time
 * (dispatch.ts:192 → syncInstalledSkillsForDispatch per profile). That meant:
 *   - Fresh-booted daemon (especially K8S sandbox pod) had empty skill dirs
 *     until the first task arrived → first dispatch paid the full sync cost
 *     and exposed any auth failure (e.g. F15 skill ack 403) at the worst
 *     possible moment.
 *   - Skills updated cloud-side never propagated until the next dispatch.
 *   - `prismer skill sync` CLI required `--agent <imUserId>` even though
 *     the daemon already knows every hosted agent + every local profile.
 *
 * `syncAllAgentSkills` enumerates `agent_profiles` (rows where
 * `deleted_at IS NULL`) and runs `syncInstalledSkillsForDispatch` for each
 * with bounded concurrency. Used by:
 *   - daemon startup (runner.ts start() — fire-and-forget background)
 *   - daemon periodic re-sync (default 10 min, configurable)
 *   - CLI `prismer skill sync` with no `--agent` / `--profile`
 *
 * Returns per-profile result plus an aggregate counter. Errors per profile
 * are caught and reported but don't fail the batch — partial sync is more
 * useful than no sync.
 */
export interface SyncAllAgentSkillsResult {
  /**
   * `backfillFailed` (2026-05-29) — count of profiles whose install-builtins
   * repair call failed (HTTP non-2xx, body ok=false, or threw). Surface lets
   * operators see WHY a `prismer skill sync` summary shows `synced=0 across
   * the board` (the actual cause is a 403/404 on install-builtins, not a
   * cloud-side empty catalog).
   */
  totals: SkillSyncResult & { profiles: number; failed: number; backfillFailed: number };
  byProfile: Array<{
    profileId: string;
    agentImUserId: string;
    adapter: string;
    ok: boolean;
    result?: SkillSyncResult;
    error?: string;
  }>;
}

export async function syncAllAgentSkills(
  profiles: AgentProfile[],
  cloud: CloudClient,
  options: { concurrency?: number; signal?: AbortSignal; skillsRootCtx?: SkillsRootContext } = {},
): Promise<SyncAllAgentSkillsResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
  const byProfile: SyncAllAgentSkillsResult['byProfile'] = [];
  const totals: SkillSyncResult & { profiles: number; failed: number; backfillFailed: number } = {
    synced: 0,
    skipped: 0,
    unchanged: 0,
    loadedSkills: [],
    profiles: profiles.length,
    failed: 0,
    backfillFailed: 0,
  };
  let cursor = 0;
  async function worker() {
    while (true) {
      if (options.signal?.aborted) return;
      const idx = cursor++;
      if (idx >= profiles.length) return;
      const profile = profiles[idx]!;
      const agentImUserId = profile.agentImUserId;
      try {
        const result = await syncInstalledSkillsForDispatch(
          profile,
          agentImUserId,
          cloud,
          options.signal,
          options.skillsRootCtx,
        );
        totals.synced += result.synced;
        totals.skipped += result.skipped;
        totals.unchanged += result.unchanged;
        if (result.backfill?.attempted && !result.backfill.ok) {
          totals.backfillFailed += 1;
        }
        byProfile.push({ profileId: profile.id, agentImUserId, adapter: profile.adapterName, ok: true, result });
      } catch (err) {
        totals.failed += 1;
        byProfile.push({
          profileId: profile.id,
          agentImUserId,
          adapter: profile.adapterName,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { totals, byProfile };
}

export async function syncInstalledSkillsForDispatch(
  profile: AgentProfile,
  agentImUserId: string | undefined,
  cloud: CloudClient,
  signal?: AbortSignal,
  ctx?: SkillsRootContext,
): Promise<SkillSyncResult> {
  if (!agentImUserId) return { synced: 0, skipped: 0, unchanged: 0, loadedSkills: [] };

  let data: unknown;
  let catalogError: string | undefined;
  try {
    data = await cloud.get<unknown>(`/api/im/skills/installed?agentId=${encodeURIComponent(agentImUserId)}`, { signal });
  } catch (error) {
    const root = resolveSkillsRoot(profile, agentImUserId, ctx);
    if (!root) throw error;
    catalogError = error instanceof Error ? error.message : String(error);
    // Dispatch tolerates catalog transport errors. Validate existing managed
    // installs anyway; an outage must not make arbitrary local bytes trusted.
    data = await ownedSkillEntries(root);
    process.stderr.write(`[daemon] skill sync: catalog unavailable, validating local receipts: ${catalogError}\n`);
  }
  let entries = normalizeInstalledSkills(data);
  let backfillReport: SkillSyncResult['backfill'];

  // F19/F24 — auto-backfill the built-in catalog when an agent has zero
  // installed skills OR is missing a must-have built-in added after the agent
  // was created. The second case matters for office-artifacts: old agents may
  // already have tasks/memory/assets, so the old `entries.length === 0` guard
  // never repaired the missing file-deliverable skill.
  //
  // Gated to hermes + pi-core because they are the only adapters that actually
  // consume the skill files (resolveSkillsRoot returns null for codex /
  // claude-code). Saves an unnecessary POST for adapters that wouldn't
  // benefit anyway.
  if (!catalogError && needsBuiltInBackfill(entries) && (profile.adapterName === 'hermes' || profile.adapterName === 'pi-core')) {
    try {
      const backfill = await cloud.request<{
        ok?: boolean;
        data?: { installed?: number };
        error?: { message?: string };
      }>('POST', `/api/im/agents/${encodeURIComponent(agentImUserId)}/skills/install-builtins`, { body: {}, signal });
      // 2026-05-29 audit (release201/09 §9.3.2 disconnect):
      // (a) pre-fix, the `if (backfill.ok && ...)` guard only logged the
      //     SUCCESS branch — a 403/404 response left zero traces in stdout
      //     or stderr, surfacing to the operator as a mysterious
      //     `synced=0 unchanged=0` on `prismer skill sync`. We now ALWAYS
      //     write a stderr line + populate `backfillReport` so the failure
      //     is visible via both human + --json output.
      // (b) cloud envelope shape is `{ ok, data: { agentId, workspaceId,
      //     installed: N } }`. `backfill.ok` is the HTTP-level ok bit from
      //     CloudClient; we still cross-check `body.ok !== false` because
      //     some error paths return 200 with `{ ok: false }`.
      const body = backfill.data;
      const installedCount =
        body && typeof body === 'object' ? ((body as { data?: { installed?: number } }).data?.installed ?? 0) : 0;
      const bodyOkBit =
        body && typeof body === 'object' && 'ok' in body ? (body as { ok?: boolean }).ok !== false : true;
      if (backfill.ok && bodyOkBit) {
        backfillReport = {
          attempted: true,
          ok: true,
          installed: installedCount,
          status: backfill.status,
        };
        if (installedCount > 0) {
          process.stdout.write(
            `[daemon] skill sync: backfilled ${installedCount} built-in skills for agent ${agentImUserId.slice(-8)}\n`,
          );
          data = await cloud.get<unknown>(`/api/im/skills/installed?agentId=${encodeURIComponent(agentImUserId)}`, {
            signal,
          });
          entries = normalizeInstalledSkills(data);
        }
      } else {
        const errMsg =
          backfill.error?.message ??
          (body && typeof body === 'object' ? (body as { error?: { message?: string } }).error?.message : undefined) ??
          `HTTP ${backfill.status}`;
        backfillReport = {
          attempted: true,
          ok: false,
          status: backfill.status,
          message: errMsg,
        };
        process.stderr.write(
          `[daemon] skill sync: backfill FAILED for ${agentImUserId.slice(-8)} ` +
            `(status=${backfill.status}, adapter=${profile.adapterName}): ${errMsg}\n`,
        );
      }
    } catch (err) {
      // Network / abort / unexpected — surface as failure report (still
      // returns rather than throwing — partial sync is more useful than
      // erroring out the whole syncAllAgentSkills batch).
      const message = err instanceof Error ? err.message : String(err);
      backfillReport = {
        attempted: true,
        ok: false,
        message,
      };
      process.stderr.write(`[daemon] skill sync: backfill threw for ${agentImUserId.slice(-8)}: ${message}\n`);
    }
  }

  const skillsRoot = resolveSkillsRoot(profile, agentImUserId, ctx);
  if (!skillsRoot) {
    // apc — the hermes-only gate above governs the PERSISTENCE delivery path
    // (per-agent hermes skillsDir) and stays exactly as it was. Coding agents
    // have their own delivery surface (`<cwd>/.claude/skills/`), their own
    // source (the working tree's `sdk/apc/skills/`), and their own gate (this
    // agent's workspace must be owned by the platform admin). The cloud
    // per-agent install list plays NO part in it.
    const codingSkillsDir = resolveCodingCwdSkillsDir(profile, ctx);
    if (codingSkillsDir) {
      const r = await reconcileApcCodingSkills(cloud, profile.workspaceId, codingSkillsDir, signal);
      if (r) {
        if (r.installed > 0 || r.removed > 0) {
          process.stderr.write(
            `[daemon] APC coding skills reconciled → ${codingSkillsDir} ` +
              `(installed=${r.installed} removed=${r.removed})\n`,
          );
        }
        return {
          synced: r.installed,
          skipped: 0,
          unchanged: 0,
          loadedSkills: r.loaded,
          backfill: backfillReport,
        };
      }
    }
    return { synced: 0, skipped: 0, unchanged: 0, loadedSkills: [], backfill: backfillReport };
  }

  let synced = 0;
  let skipped = 0;
  let unchanged = 0;
  let pruned = 0;
  const quarantined: NonNullable<SkillSyncResult['quarantined']> = [];
  const loadedSkills: Array<{ slug: string; skillId?: string | null }> = [];
  const resolutions: SkillResolutionResult[] = [];
  const activeSlugs = new Set<string>();
  const bundledSkillsRoot = resolveBuiltInSkillsRoot();
  for (const entry of entries) {
    const slug = sanitizeSlug(trimmedStringFrom(entry.skill?.slug) ?? trimmedStringFrom(entry.slug));
    const skillId = trimmedStringFrom(entry.skill?.id);
    if (slug) activeSlugs.add(slug);
    if (!slug) {
      skipped++;
      continue;
    }

    // Resolve files[]: prefer contentManifest (v2.1+), fallback to content
    // (legacy), then apply the verified remote → LKG → bundled fallback ladder.
    const files = resolveEntryFiles(entry, slug);
    const skillDir = join(skillsRoot, slug);
    const declaredRevision = trimmedStringFrom(entry.skill?.contentManifestRevision);
    const bundledDir = bundledSkillsRoot ? await resolveBundledSkillDirectory(bundledSkillsRoot, slug) : null;
    const resolution = await resolveSkillSource({
      slug,
      targetDir: skillDir,
      ...(files?.length ? { remote: { files, declaredRevision } } : {}),
      bundledDir,
      signal,
      fetchUrl: downloadUrl,
    });
    resolutions.push(resolution);

    if (!resolution.ok || !resolution.source) {
      const retained = await quarantineSkillDirectory(skillDir, resolution.error ?? 'Skill resolution failed');
      if (retained) {
        quarantined.push({ slug, ...retained });
        pruned++;
      }
      skipped++;
      if (!catalogError) await ackSkillSync(
        cloud,
        agentImUserId,
        { skillId, slug, error: resolution.error ?? 'skill_resolution_failed' },
        signal,
      );
      process.stderr.write(`[daemon] ${resolution.error ?? `skill_resolution_failed: ${slug}`}\n`);
      continue;
    }

    if (resolution.source !== 'remote') {
      process.stderr.write(
        `[daemon] skill sync ${slug}: using ${resolution.source} (${resolution.staleReason ?? 'remote unavailable'})\n`,
      );
    }
    if (resolution.changed) {
      synced++;
    } else {
      unchanged++;
    }
    // release201/11 §4 #7 — record the skill as "load-into-dispatch" so the
    // caller (handleDispatch) can emit one `skill.invoked` event per skill.
    // We include synced + unchanged (both ended up on disk and will be visible
    // to the LLM in this dispatch); skipped entries are NOT loaded.
    loadedSkills.push({ slug, skillId: skillId ?? null });
    if (catalogError) continue;
    if (resolution.source === 'remote') {
      await ackSkillSync(cloud, agentImUserId, { skillId, slug, revision: resolution.revision ?? undefined }, signal);
    } else {
      await ackSkillSync(
        cloud,
        agentImUserId,
        { skillId, slug, error: resolution.staleReason ?? `${resolution.source} fallback` },
        signal,
      );
    }
  }

  // N2 — prune whole skill dirs that left the cloud active list (uninstalled).
  // The per-file orphan prune above only cleans extra files inside slugs still
  // in `entries`; it never removes a `<slug>/` dir for a skill no longer active.
  // The system-prompt skill section is rebuilt per-dispatch via readdir, so a
  // leftover dir re-renders a stale section that never disappears after uninstall.
  // Auto-pinning populates config.skillsDir too. Ownership is determined by the
  // actual per-agent root and a Runtime receipt, not by presence of that field.
  const managedRoot = ctx?.paths && ctx.daemonId
    ? resolveAgentDirPaths(ctx.paths, ctx.daemonId, agentImUserId).skillsDir : null;
  if (!catalogError && managedRoot && resolve(skillsRoot) === resolve(managedRoot)) {
    try {
      const onDisk = await fsp.readdir(skillsRoot, { withFileTypes: true });
      for (const d of onDisk) {
        if (!d.isDirectory()) continue;
        if (activeSlugs.has(d.name)) continue;
        const orphanDir = join(skillsRoot, d.name);
        // Unowned user directories remain untouched, even in a managed root.
        try {
          await fsp.access(join(orphanDir, SKILL_SOURCE_RECEIPT));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const unmodified = await verifiedLocalSnapshot(orphanDir);
        const retained = await quarantineSkillDirectory(orphanDir, 'Grant revoked');
        if (retained) {
          if (unmodified) {
            try { await fsp.rm(retained.path, { recursive: true, force: true }); }
            catch (error) {
              retained.reason = `Grant revoked; isolated files retained after cleanup failure: ${String(error)}`;
              quarantined.push({ slug: d.name, ...retained });
              process.stderr.write(`[daemon] skill sync: ${retained.reason} at ${retained.path}\n`);
            }
          } else quarantined.push({ slug: d.name, ...retained });
        }
        pruned++;
        process.stderr.write(`[daemon] skill sync: pruned uninstalled skill dir ${d.name}\n`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SkillSyncSafetyError('Cannot safely remove revoked skills', err);
      }
    }
  }

  if (profile.adapterName === 'hermes') {
    try {
      pruneHermesSkillProjections(skillsRoot, join(getHermesProfileDir(getHermesProfileName(profile)), 'skills'));
    } catch (error) { throw new SkillSyncSafetyError('Cannot safely remove native skill projections', error); }
  }
  return { synced, skipped, unchanged, pruned, loadedSkills, resolutions, quarantined, catalogError, backfill: backfillReport };
}

async function ownedSkillEntries(root: string): Promise<InstalledSkillEntry[]> {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new SkillSyncSafetyError('Cannot inspect installed skill receipts', error);
  }
  const owned: InstalledSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { await fsp.lstat(join(root, entry.name, SKILL_SOURCE_RECEIPT)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new SkillSyncSafetyError('Cannot inspect installed skill receipt', error);
    }
    owned.push({ slug: entry.name });
  }
  return owned;
}

async function quarantineSkillDirectory(target: string, reason: string): Promise<{ path: string; reason: string } | null> {
  try {
    return await moveSkillToQuarantine(target, reason);
  } catch (error) {
    throw new SkillSyncSafetyError(`Cannot isolate rejected skill ${target}`, error);
  }
}

async function moveSkillToQuarantine(target: string, reason: string): Promise<{ path: string; reason: string } | null> {
  try {
    await fsp.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Sibling of the scan root, never below it: native Hermes scans recursively.
  const quarantineRoot = join(dirname(dirname(target)), '.prismer-skill-quarantine');
  await fsp.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  const path = join(quarantineRoot, randomUUID());
  await fsp.rename(target, path);
  process.stderr.write(`[daemon] skill sync: quarantined ${target} at ${path}: ${reason}\n`);
  return { path, reason };
}

/**
 * apc — `<cwd>/.claude/skills` for a claude-code profile, else null.
 *
 * claude-code ONLY, deliberately: codex reads a per-dispatch ephemeral
 * `CODEX_HOME/skills` (written by provider-proxy-env) and opencode uses a flat
 * command-md format — neither is this seam. The decree is "coding-scope →
 * claude-code via cwd seeding"; widening it is a separate decision.
 */
export function resolveCodingCwdSkillsDir(profile: AgentProfile, ctx?: SkillsRootContext): string | null {
  if (profile.adapterName !== 'claude-code') return null;
  const fromCtx = typeof ctx?.codingCwd === 'string' ? ctx.codingCwd.trim() : '';
  const fromConfig =
    typeof (profile.config as { cwd?: unknown } | undefined)?.cwd === 'string'
      ? (profile.config as { cwd: string }).cwd.trim()
      : '';
  const cwd = fromCtx || fromConfig;
  if (!cwd) return null;
  return join(cwd, '.claude', 'skills');
}

// ---------------------------------------------------------- platform gate
//
// 平台 workspace 的定义（用户裁决 2026-07-26）= 平台管理员账号绑定的 workspace。
// The daemon answers ONE question before any APC skill touches disk: "is this
// profile's workspace inside the platform scope?" — and it does NOT answer it
// itself. Cloud does, and ships the verdict as a boolean projection:
//
//   GET /api/im/workspaces/:id → { ..., platformScoped: boolean }
//
// desktop205 W1 (D2-b). The previous criterion mirrored cloud's ADMIN_EMAILS
// allowlist INSIDE the daemon (it read that variable off its own environment,
// plus a second read of `/api/im/users/lookup` to turn each admin email into an
// imUserId). Two things were wrong with it:
//
//   1. `ADMIN_EMAILS` is a CLOUD-side variable. It is injected into no daemon
//      anywhere — not the Dockerfile, not docker-compose.dev.yml, not the
//      desktop spawn env (which is whatever Finder handed Electron). So the
//      allowlist was empty on every real machine, the gate short-circuited to
//      `false` BEFORE any cloud read, and the eviction branch below ran on
//      every single sync. APC skills were never installed, and any that existed
//      were actively deleted (desktop205/01 §F3).
//   2. Even had it been injected, shipping the platform-admin allowlist to
//      every user's machine is an authorization-surface leak. The daemon should
//      know "is this workspace platform-scoped", never "who is an admin".
//
// ⚠️ RELEASE ORDER — cloud first, desktop second. A daemon talking to a cloud
// that predates the `platformScoped` field sees it absent ⇒ verdict `unknown`
// ⇒ it neither installs nor evicts. That window is benign by construction (see
// the three-valued contract below); shipping the desktop half first would just
// make every machine sit in `unknown` until cloud catches up.

/**
 * desktop205 W2 — three-valued, because "cannot tell" must NOT mean "no".
 *
 *   'platform'      cloud said true             → install the APC set
 *   'not-platform'  cloud said false            → evict the entitled class
 *                                                 (the ONLY correct eviction
 *                                                  trigger there is)
 *   'unknown'       anything else — field absent (old cloud), request failed
 *                   (offline / 404 / malformed envelope), value not a boolean,
 *                   or no workspaceId to ask about
 *                                               → leave the dir EXACTLY as it is
 *
 * D6 (05-open-items): no protocol negotiation. A missing field is
 * indistinguishable from an old cloud, and both resolve the conservative way.
 */
export type PlatformScope = 'platform' | 'not-platform' | 'unknown';

/**
 * Positive verdicts are cached longer than negative ones on purpose. The
 * daemon is local-first: once a workspace has been PROVEN to be the platform
 * workspace, a cloud outage must not strip the platform engineer's toolchain
 * mid-session. Negatives expire fast so revoking is felt within a minute.
 * `unknown` is NEVER cached — it is the absence of a verdict, not a verdict.
 */
const PLATFORM_VERDICT_TTL_MS = { positive: 30 * 60_000, negative: 60_000 };
const platformWorkspaceVerdicts = new Map<string, { scope: PlatformScope; expiresAt: number }>();
const platformScopeWarned = new Set<string>();

/** Test seam — drops the verdict cache and the warn-once ledger. */
export function __resetPlatformWorkspaceCache(): void {
  platformWorkspaceVerdicts.clear();
  platformScopeWarned.clear();
}

function warnUnknownPlatformScope(wsId: string, reason: string): void {
  const key = `${wsId}:${reason}`;
  if (platformScopeWarned.has(key)) return;
  platformScopeWarned.add(key);
  process.stderr.write(
    `[daemon] APC coding skills: platform scope UNKNOWN for workspace ${wsId || '<none>'} ` +
      `(${reason}) — leaving <cwd>/.claude/skills untouched (no install, no eviction)\n`,
  );
}

export async function resolvePlatformScope(
  cloud: CloudClient,
  workspaceId: string | undefined,
  signal?: AbortSignal,
): Promise<PlatformScope> {
  const wsId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!wsId) {
    warnUnknownPlatformScope('', 'profile carries no workspaceId');
    return 'unknown';
  }

  const now = Date.now();
  const cached = platformWorkspaceVerdicts.get(wsId);
  if (cached && cached.expiresAt > now) return cached.scope;

  let body: { platformScoped?: unknown } | null | undefined;
  try {
    body = await cloud.get<{ platformScoped?: unknown }>(`/api/im/workspaces/${encodeURIComponent(wsId)}`, { signal });
  } catch (err) {
    // Offline / 404 (not a member) / malformed envelope. Not a verdict, not
    // cached — a transient failure must never pin a decision.
    warnUnknownPlatformScope(wsId, `workspace GET failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  }

  const flag = body?.platformScoped;
  if (flag !== true && flag !== false) {
    // Old cloud (field not shipped yet) or a body we do not understand.
    warnUnknownPlatformScope(wsId, `platformScoped absent or non-boolean (got ${typeof flag})`);
    return 'unknown';
  }

  const scope: PlatformScope = flag ? 'platform' : 'not-platform';
  platformWorkspaceVerdicts.set(wsId, {
    scope,
    expiresAt: now + (flag ? PLATFORM_VERDICT_TTL_MS.positive : PLATFORM_VERDICT_TTL_MS.negative),
  });
  return scope;
}

/**
 * desktop205 W5 — "is THIS dispatch an APC coding-scope run?"
 *
 * Deliberately the SAME two conditions the APC coding-SKILL half runs on, in
 * the same order, reading the same cloud-authoritative verdict:
 *
 *   1. this profile has a claude-code coding cwd (`resolveCodingCwdSkillsDir`),
 *      i.e. it is in the population that receives the APC skill set at all;
 *   2. cloud says its workspace is `platformScoped` (`resolvePlatformScope`).
 *
 * Returns `'n/a'` for (1) failing — not a verdict, just "this profile is not in
 * the population". Everything else is the three-valued `PlatformScope`, with
 * `unknown` meaning "cannot tell" exactly as it does for the skill half.
 *
 * Cost: none in practice. `syncInstalledSkillsForDispatch` already resolved the
 * same workspace earlier in the same dispatch, and `resolvePlatformScope` caches
 * verdicts (positive 30min / negative 60s; `unknown` never cached), so this is a
 * map hit rather than a second HTTP round-trip.
 *
 * NOT a security boundary — see `APC_HELDOUT_DENY_METADATA_KEY` in
 * claude-code/config-isolation.ts for what the verdict is used for and why
 * `unknown` fails open.
 */
export async function resolveApcCodingScope(
  cloud: CloudClient,
  profile: AgentProfile,
  ctx?: SkillsRootContext,
  signal?: AbortSignal,
): Promise<PlatformScope | 'n/a'> {
  if (!resolveCodingCwdSkillsDir(profile, ctx)) return 'n/a';
  return await resolvePlatformScope(cloud, profile.workspaceId, signal);
}

/**
 * apc — reconcile one coding agent's `<cwd>/.claude/skills/` against the APC
 * family, gated on the platform-scope verdict.
 *
 *   platform + source found  → install the working tree's APC set, evict strays
 *   platform + source absent → null (leave the dir untouched; see
 *                              installPlatformApcSkills' contract)
 *   not-platform             → desired set is EMPTY ⇒ evict the entitled class
 *   unknown                  → null (leave the dir untouched — W2)
 *
 * The eviction branch never creates `skillsDir`: `reconcileEntitledSkillDirs`
 * readdirs and returns 0 when the dir does not exist, so an unrelated coding
 * agent's cwd stays exactly as clean as it was.
 */
async function reconcileApcCodingSkills(
  cloud: CloudClient,
  workspaceId: string | undefined,
  skillsDir: string,
  signal?: AbortSignal,
): Promise<{ installed: number; removed: number; loaded: Array<{ slug: string; skillId?: string | null }> } | null> {
  const scope = await resolvePlatformScope(cloud, workspaceId, signal);
  if (scope === 'platform') return installPlatformApcSkills(skillsDir);
  if (scope === 'not-platform') {
    return { installed: 0, removed: reconcileEntitledSkillDirs(skillsDir, new Set<string>()), loaded: [] };
  }
  return null;
}

// v2.0 (A2) — warn once per (profile, adapter) when we silently no-op skill
// sync. Previously this returned null for codex/claude-code without telling
// anyone, making "agent has no skills installed" look like a cloud bug.
const skillSyncWarnedProfiles = new Set<string>();

/**
 * release201/09 §9.3.2 — resolveSkillsRoot 新签名。
 *
 * 优先级:
 *   1. profile.config.skillsDir 显式 override (deprecated; §9.3.2 仍接受)
 *   2. ctx.paths + ctx.daemonId 都给 → devices/<did>/agents/<aid>/skills/
 *   3. 旧 fallback (无 ctx / 老调用方):hermes profile dir
 *      — 用于 tests + container/sandbox 旧路径,不影响生产 daemon (v2.0.7
 *      生产 daemon 永远走分支 2)
 *
 * runtime210 G-A — pi-core 与 hermes 同权:两者都是 skill 文件的消费者
 * (hermes 经 MEMORY.md carrier,pi-core 经 dispatch 时拼进 system prompt)。
 * 返回 null 仅当 adapter 不是消费者 (codex / claude-code 不消费 skill 文件),
 * 以及 pi-core 落到旧 fallback 时 (pi-core 没有 hermes profile dir 载体,无
 * ctx 无显式目录 = 无处可读)。
 */
export function resolveSkillsRoot(
  profile: AgentProfile,
  agentImUserId?: string,
  ctx?: SkillsRootContext,
): string | null {
  if (profile.adapterName !== 'hermes' && profile.adapterName !== 'pi-core') {
    const warnKey = `${profile.id}:${profile.adapterName}`;
    if (!skillSyncWarnedProfiles.has(warnKey)) {
      skillSyncWarnedProfiles.add(warnKey);
      process.stderr.write(
        `[daemon] skill sync no-op profile=${profile.id} adapter=${profile.adapterName}: v2.0 gate is hermes + pi-core only\n`,
      );
    }
    return null;
  }
  const explicitSkillsDir =
    profile.config && typeof profile.config.skillsDir === 'string' && profile.config.skillsDir.trim()
      ? profile.config.skillsDir.trim()
      : null;
  if (explicitSkillsDir) return explicitSkillsDir;
  if (ctx?.paths && ctx.daemonId && agentImUserId) {
    return resolveAgentDirPaths(ctx.paths, ctx.daemonId, agentImUserId).skillsDir;
  }
  // Legacy fallback — only hit by tests / container mode without daemon paths,
  // and only hermes has one (the profile dir). pi-core resolves to null: with
  // neither an explicit dir nor daemon paths there is no skills dir to read.
  if (profile.adapterName !== 'hermes') return null;
  return join(getHermesProfileDir(getHermesProfileName(profile)), 'skills');
}

/**
 * release203/10 §skill-dispatch-fix — pin a hermes profile's `config.skillsDir`
 * to the per-agent device dir (`devices/<did>/agents/<aid>/skills/`) so the
 * long-running hermes gateway spawns reading the SAME directory `skill-sync`
 * writes into.
 *
 * Why this exists: `dispatch.ts` already injected this before its own
 * `ensureService`, but the daemon ALSO warms the gateway from
 * `syncProfileFromCloud → prewarmProfileService` (the canonical profile-arrival
 * choke point) with the raw cloud profile — no `skillsDir`. That prewarm spawns
 * hermes reading the *profile* dir and ServicePool caches it by `profile.id`, so
 * the later dispatch-time injection is a no-op (the service already exists).
 * Net effect: installed skills land in the device dir but the live gateway reads
 * the profile dir → the agent reports "I don't have that skill". Routing BOTH
 * ensureService callers through this helper makes the spawn dir match the sync
 * dir, so every installed skill is visible.
 *
 * Contract: returns a shallow-cloned profile (never mutates the caller's) with
 * `config.skillsDir` set; a no-op passthrough when the adapter is not hermes,
 * daemon paths/daemonId/agentImUserId are unavailable, or the caller already
 * pinned `skillsDir` explicitly.
 */
export function withPerAgentSkillsDir(
  profile: AgentProfile,
  paths: ConfigPaths | undefined,
  daemonId: string | undefined,
): AgentProfile {
  if (profile.adapterName !== 'hermes') return profile;
  if (!paths || !daemonId || !profile.agentImUserId) return profile;
  if (typeof profile.config?.skillsDir === 'string' && profile.config.skillsDir.trim()) return profile;
  const skillsDir = resolveAgentDirPaths(paths, daemonId, profile.agentImUserId).skillsDir;
  return { ...profile, config: { ...profile.config, skillsDir } };
}

function sha256Buffer(value: Buffer | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * §A.7.2 merkle: sha256 of sorted "path:sha256\n" lines.
 * Same path list + same sha256 => same revision; cheap incremental contract
 * with the cloud's agent-skill.service (installedRevision == manifestRevision).
 */
export function computeMerkle(files: ManifestFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((f) => `${f.path}:${f.sha256}`).join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

/**
 * Resolve an installed-skill entry's file list: prefer `contentManifest`
 * (v2.1+, multi-file), fall back to the legacy single-file `content` string.
 * Shared by the hermes writer and the coding-cwd entitled writer.
 */
function resolveEntryFiles(entry: InstalledSkillEntry, slug: string): ManifestFile[] | null {
  const manifestRaw = entry.skill?.contentManifest;
  if (typeof manifestRaw === 'string' && manifestRaw.trim()) {
    const files = parseManifest(manifestRaw, slug);
    if (files) return files;
  }
  const legacyContent = contentStringFrom(entry.skill?.content) ?? contentStringFrom(entry.content);
  if (!legacyContent) return null;
  const buf = Buffer.from(legacyContent, 'utf8');
  return [
    {
      path: 'SKILL.md',
      size: buf.byteLength,
      sha256: sha256Buffer(buf),
      inline: true,
      content: buf.toString('base64'),
    },
  ];
}

function parseManifest(raw: string, slug: string): ManifestFile[] | null {
  try {
    const parsed = JSON.parse(raw);
    // Accept either an array (legacy shape) or { files: [...] } envelope.
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)
        ? (parsed as { files: unknown[] }).files
        : null;
    if (!Array.isArray(arr)) {
      process.stderr.write(`[daemon] skill sync ${slug}: contentManifest is not an array\n`);
      return null;
    }
    const files: ManifestFile[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const path = typeof rec.path === 'string' ? rec.path : null;
      const sha256 = typeof rec.sha256 === 'string' ? rec.sha256 : null;
      const size =
        typeof rec.size === 'number' && Number.isFinite(rec.size) && rec.size >= 0 ? Math.floor(rec.size) : null;
      if (!path || !sha256 || size === null) continue;
      const content = typeof rec.content === 'string' ? rec.content : undefined;
      const url = typeof rec.url === 'string' ? rec.url : undefined;
      const inline = typeof rec.inline === 'boolean' ? rec.inline : content !== undefined ? true : undefined;
      files.push({ path, size, sha256, inline, content, url });
    }
    return files;
  } catch (err) {
    process.stderr.write(`[daemon] skill sync ${slug}: invalid contentManifest JSON: ${(err as Error).message}\n`);
    return null;
  }
}

/**
 * Strict relative-path filter for skill files. agentskills.io files are always
 * forward-slash relative paths within the skill directory (SKILL.md,
 * scripts/foo.py, references/bar.md). Reject anything that smells like
 * traversal or escape.
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || !p) return false;
  if (p.length > 512) return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  // Windows drive (C:\...) — refuse just in case
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // Normalize and inspect segments
  const segs = p.replace(/\\/g, '/').split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

async function walkLocalDir(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        try {
          const buf = await fsp.readFile(full);
          const rel = relative(root, full).split(sep).join('/');
          out.set(rel, sha256Buffer(buf));
        } catch {
          // unreadable file — skip; manifest will treat it as orphan-or-missing
        }
      }
    }
  }
  await walk(root);
  return out;
}

async function downloadUrl(url: string, signal?: AbortSignal): Promise<Buffer> {
  // §A.7.7 — only allow http(s) URLs. file://, data:, javascript: all rejected.
  const lower = url.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    throw new Error(`unsupported url scheme: ${url.slice(0, 32)}`);
  }
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function needsBuiltInBackfill(entries: InstalledSkillEntry[]): boolean {
  if (entries.length === 0) return true;
  const installed = new Set(
    entries
      .map((entry) => sanitizeSlug(trimmedStringFrom(entry.skill?.slug) ?? trimmedStringFrom(entry.slug)))
      .filter((slug): slug is string => Boolean(slug)),
  );
  for (const slug of REQUIRED_BUILT_IN_SKILL_SLUGS) {
    if (!installed.has(slug)) return true;
  }
  return false;
}

function normalizeInstalledSkills(data: unknown): InstalledSkillEntry[] {
  if (Array.isArray(data)) return data.filter(isInstalledSkillEntry);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const nested = record.data;
  if (Array.isArray(nested)) return nested.filter(isInstalledSkillEntry);
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const skills = (nested as Record<string, unknown>).skills;
    if (Array.isArray(skills)) return skills.filter(isInstalledSkillEntry);
  }
  const skills = record.skills;
  if (Array.isArray(skills)) return skills.filter(isInstalledSkillEntry);
  return [];
}

function isInstalledSkillEntry(value: unknown): value is InstalledSkillEntry {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function trimmedStringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function contentStringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sanitizeSlug(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || undefined;
}

// APC Root B (2026-07-25) — per-(agent,slug) backoff gate for the skill-sync
// ack. The ack is re-issued on every sync trigger (per-dispatch / periodic /
// churny host.acked re-declares). Against a slow cloud, an ack that just failed
// used to be re-fired on the very next trigger with no spacing (observed:
// `skill sync ack failed` ×85). This gate skips a re-ack while its exponential
// backoff window is open; the next trigger after the window elapses retries.
// Success resets the streak. Env kill-switch: `PRISMER_DAEMON_ACK_BACKOFF=off`.
const ackBackoffByKey = new Map<string, ExponentialBackoff>();

function ackBackoffEnabled(): boolean {
  const v = process.env.PRISMER_DAEMON_ACK_BACKOFF;
  return v !== 'off' && v !== 'false' && v !== '0';
}

function ackBackoffFor(key: string): ExponentialBackoff {
  let b = ackBackoffByKey.get(key);
  if (!b) {
    // base 2s, cap 60s — a persistently-failing ack backs off toward one
    // attempt/minute instead of one per churn tick.
    b = new ExponentialBackoff({ baseMs: 2_000, maxMs: 60_000 });
    ackBackoffByKey.set(key, b);
  }
  return b;
}

/** Test-only: clear the module-level ack backoff registry. */
export function __resetSkillAckBackoff(): void {
  ackBackoffByKey.clear();
}

export async function ackSkillSync(
  cloud: CloudClient,
  agentImUserId: string,
  input: { skillId?: string; slug: string; revision?: string; error?: string },
  signal?: AbortSignal,
): Promise<void> {
  const key = `${agentImUserId}:${input.skillId ?? input.slug}`;
  const backoff = ackBackoffEnabled() ? ackBackoffFor(key) : null;
  if (backoff && !backoff.ready()) {
    // Still inside the backoff window from a recent failure — skip this
    // attempt. A later trigger (dispatch / periodic / host.acked) will retry
    // once the window elapses, so no ack is lost, only re-hammering is avoided.
    process.stderr.write(
      `[daemon] skill sync ack backoff ${input.slug}: skipping (retry in ~${Math.round(backoff.remainingMs() / 1000)}s)\n`,
    );
    return;
  }
  try {
    const res = await cloud.request('POST', `/api/im/agents/${encodeURIComponent(agentImUserId)}/skills/ack`, {
      body: {
        ...(input.skillId ? { skillId: input.skillId } : { slug: input.slug }),
        ...(input.revision ? { revision: input.revision } : {}),
        ...(input.error ? { error: input.error } : {}),
      },
      signal,
    });
    if (!res.ok) {
      backoff?.recordFailure();
      process.stderr.write(`[daemon] skill sync ack failed ${input.slug}: ${res.error?.message ?? 'request failed'}\n`);
    } else {
      backoff?.recordSuccess();
    }
  } catch (err) {
    backoff?.recordFailure();
    process.stderr.write(`[daemon] skill sync ack failed ${input.slug}: ${(err as Error).message}\n`);
  }
}
