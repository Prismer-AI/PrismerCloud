import { promises as fsp } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { CloudClient } from '../auth.js';
import type { AgentProfile } from '../adapters/contract.js';
import { getHermesProfileDir, getHermesProfileName } from '../adapters/hermes/index.js';
import { getOpenClawSkillsDir } from '../adapters/openclaw/index.js';
import { resolveAgentDirPaths } from './agent-dir.js';
import type { ConfigPaths } from '../config.js';

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
  synced: number;
  skipped: number;
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

const REQUIRED_BUILT_IN_SKILL_SLUGS = new Set(['tasks', 'office-artifacts']);

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
  byProfile: Array<{ profileId: string; agentImUserId: string; adapter: string; ok: boolean; result?: SkillSyncResult; error?: string }>;
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

  let data = await cloud.get<unknown>(
    `/api/im/skills/installed?agentId=${encodeURIComponent(agentImUserId)}`,
    { signal },
  );
  let entries = normalizeInstalledSkills(data);
  let backfillReport: SkillSyncResult['backfill'];

  // F19/F24 — auto-backfill the built-in catalog when an agent has zero
  // installed skills OR is missing a must-have built-in added after the agent
  // was created. The second case matters for office-artifacts: old agents may
  // already have tasks/memory/assets, so the old `entries.length === 0` guard
  // never repaired the missing file-deliverable skill.
  //
  // Gated to hermes/openclaw because those are the only adapters that
  // actually consume the skill files (resolveSkillsRoot returns null for
  // codex / claude-code). Saves an unnecessary POST for adapters that
  // wouldn't benefit anyway.
  if (needsBuiltInBackfill(entries) && (profile.adapterName === 'hermes' || profile.adapterName === 'openclaw')) {
    try {
      const backfill = await cloud.request<{ ok?: boolean; data?: { installed?: number }; error?: { message?: string } }>(
        'POST',
        `/api/im/agents/${encodeURIComponent(agentImUserId)}/skills/install-builtins`,
        { body: {}, signal },
      );
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
        body && typeof body === 'object'
          ? (body as { data?: { installed?: number } }).data?.installed ?? 0
          : 0;
      const bodyOkBit =
        body && typeof body === 'object' && 'ok' in body
          ? (body as { ok?: boolean }).ok !== false
          : true;
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
          data = await cloud.get<unknown>(
            `/api/im/skills/installed?agentId=${encodeURIComponent(agentImUserId)}`,
            { signal },
          );
          entries = normalizeInstalledSkills(data);
        }
      } else {
        const errMsg =
          backfill.error?.message
          ?? (body && typeof body === 'object' ? (body as { error?: { message?: string } }).error?.message : undefined)
          ?? `HTTP ${backfill.status}`;
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
      process.stderr.write(
        `[daemon] skill sync: backfill threw for ${agentImUserId.slice(-8)}: ${message}\n`,
      );
    }
  }

  const skillsRoot = resolveSkillsRoot(profile, agentImUserId, ctx);
  if (!skillsRoot) return { synced: 0, skipped: 0, unchanged: 0, loadedSkills: [], backfill: backfillReport };

  let synced = 0;
  let skipped = 0;
  let unchanged = 0;
  const loadedSkills: Array<{ slug: string; skillId?: string | null }> = [];
  for (const entry of entries) {
    const slug = sanitizeSlug(trimmedStringFrom(entry.skill?.slug) ?? trimmedStringFrom(entry.slug));
    const skillId = trimmedStringFrom(entry.skill?.id);
    if (!slug) {
      skipped++;
      continue;
    }

    // Resolve files[]: prefer contentManifest (v2.1+), fallback to content (legacy).
    let files: ManifestFile[] | null = null;
    const manifestRaw = entry.skill?.contentManifest;
    if (typeof manifestRaw === 'string' && manifestRaw.trim()) {
      files = parseManifest(manifestRaw, slug);
    }
    if (!files) {
      const legacyContent = contentStringFrom(entry.skill?.content) ?? contentStringFrom(entry.content);
      if (legacyContent) {
        const buf = Buffer.from(legacyContent, 'utf8');
        files = [
          {
            path: 'SKILL.md',
            size: buf.byteLength,
            sha256: sha256Buffer(buf),
            inline: true,
            content: buf.toString('base64'),
          },
        ];
      }
    }
    if (!files || files.length === 0) {
      skipped++;
      process.stderr.write(`[daemon] skill sync skipped ${slug}: no manifest or content\n`);
      await ackSkillSync(cloud, agentImUserId, { skillId, slug, error: 'missing content' }, signal);
      continue;
    }

    const skillDir = join(skillsRoot, slug);
    await fsp.mkdir(skillDir, { recursive: true });

    // Walk existing files for incremental sync (skip unchanged by sha256).
    const localFiles = await walkLocalDir(skillDir);

    let dirty = false;
    let perFileFailures = 0;
    for (const file of files) {
      // §A.7 P0 — path traversal defense. We strictly enforce relative paths
      // that do not escape skillDir. Reject absolute, ".." segments, drive
      // letters, or NUL bytes.
      if (!isSafeRelativePath(file.path)) {
        process.stderr.write(`[daemon] skill sync ${slug}: skipping suspicious path "${file.path}"\n`);
        perFileFailures++;
        continue;
      }
      const targetPath = join(skillDir, file.path);
      const normalizedTarget = targetPath + (targetPath.endsWith(sep) ? '' : '');
      // Belt-and-suspenders: even after isSafeRelativePath, verify the join
      // result still lives inside skillDir on this OS.
      if (
        normalizedTarget !== skillDir &&
        !normalizedTarget.startsWith(skillDir + sep)
      ) {
        process.stderr.write(`[daemon] skill sync ${slug}: path escapes skillDir "${file.path}"\n`);
        perFileFailures++;
        continue;
      }

      const existingHash = localFiles.get(file.path);
      if (existingHash === file.sha256) {
        // already up-to-date — mark as visited but no rewrite
        localFiles.delete(file.path);
        continue;
      }

      // Resolve bytes.
      let bytes: Buffer | null = null;
      try {
        if (file.inline !== false && typeof file.content === 'string') {
          bytes = Buffer.from(file.content, 'base64');
        } else if (typeof file.url === 'string' && file.url) {
          bytes = await downloadUrl(file.url, signal);
        } else {
          process.stderr.write(
            `[daemon] skill sync ${slug}: file ${file.path} has neither inline content nor url\n`,
          );
          perFileFailures++;
          continue;
        }
      } catch (err) {
        process.stderr.write(
          `[daemon] skill sync ${slug}: failed to fetch ${file.path}: ${(err as Error).message}\n`,
        );
        perFileFailures++;
        continue;
      }

      // sha256 verify.
      const downloadedHash = sha256Buffer(bytes);
      if (downloadedHash !== file.sha256) {
        process.stderr.write(
          `[daemon] skill sync ${slug}: hash mismatch for ${file.path} (expected ${file.sha256}, got ${downloadedHash})\n`,
        );
        perFileFailures++;
        continue;
      }

      await fsp.mkdir(dirname(targetPath), { recursive: true });
      await fsp.writeFile(targetPath, bytes);
      localFiles.delete(file.path);
      dirty = true;
    }

    // Anything still in localFiles is an orphan — manifest no longer lists it.
    // Remove to keep the on-disk view authoritative.
    for (const orphan of localFiles.keys()) {
      try {
        await fsp.unlink(join(skillDir, orphan));
        dirty = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write(
            `[daemon] skill sync ${slug}: failed to remove orphan ${orphan}: ${(err as Error).message}\n`,
          );
        }
      }
    }

    if (perFileFailures > 0) {
      // Partial failure: don't ack revision; cloud will retry next dispatch.
      skipped++;
      await ackSkillSync(
        cloud,
        agentImUserId,
        { skillId, slug, error: `${perFileFailures} file(s) failed` },
        signal,
      );
      continue;
    }

    // Compute merkle from manifest (canonical: sorted path:sha256 lines).
    // Prefer the manifest's declared revision when supplied to keep cloud
    // bookkeeping in lock-step, but verify it matches what we just wrote.
    const localMerkle = computeMerkle(files);
    const declaredRevision = trimmedStringFrom(entry.skill?.contentManifestRevision);
    const revision = declaredRevision ?? localMerkle;
    if (declaredRevision && declaredRevision !== localMerkle) {
      process.stderr.write(
        `[daemon] skill sync ${slug}: declared revision ${declaredRevision} != computed ${localMerkle}; using computed\n`,
      );
    }

    if (dirty) {
      synced++;
    } else {
      unchanged++;
    }
    // release201/11 §4 #7 — record the skill as "load-into-dispatch" so the
    // caller (handleDispatch) can emit one `skill.invoked` event per skill.
    // We include synced + unchanged (both ended up on disk and will be visible
    // to the LLM in this dispatch); skipped entries are NOT loaded.
    loadedSkills.push({ slug, skillId: skillId ?? null });
    await ackSkillSync(
      cloud,
      agentImUserId,
      { skillId, slug, revision: declaredRevision === localMerkle ? declaredRevision : localMerkle },
      signal,
    );
  }

  return { synced, skipped, unchanged, loadedSkills, backfill: backfillReport };
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
 *   3. 旧 fallback (无 ctx / 老调用方):hermes profile dir / openclaw home
 *      — 用于 tests + container/sandbox 旧路径,不影响生产 daemon (v2.0.7
 *      生产 daemon 永远走分支 2)
 *
 * 返回 null 仅当 adapter 不是 hermes/openclaw — codex / claude-code 不消
 * 费 skill 文件。
 */
export function resolveSkillsRoot(
  profile: AgentProfile,
  agentImUserId?: string,
  ctx?: SkillsRootContext,
): string | null {
  if (profile.adapterName !== 'hermes' && profile.adapterName !== 'openclaw') {
    const warnKey = `${profile.id}:${profile.adapterName}`;
    if (!skillSyncWarnedProfiles.has(warnKey)) {
      skillSyncWarnedProfiles.add(warnKey);
      process.stderr.write(
        `[daemon] skill sync no-op profile=${profile.id} adapter=${profile.adapterName}: v2.0 gate is hermes/openclaw only\n`,
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
  // Legacy fallback — only hit by tests / container mode without daemon paths.
  if (profile.adapterName === 'hermes') {
    return join(getHermesProfileDir(getHermesProfileName(profile)), 'skills');
  }
  return getOpenClawSkillsDir(profile);
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
    process.stderr.write(
      `[daemon] skill sync ${slug}: invalid contentManifest JSON: ${(err as Error).message}\n`,
    );
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

async function ackSkillSync(
  cloud: CloudClient,
  agentImUserId: string,
  input: { skillId?: string; slug: string; revision?: string; error?: string },
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await cloud.request(
      'POST',
      `/api/im/agents/${encodeURIComponent(agentImUserId)}/skills/ack`,
      {
        body: {
          ...(input.skillId ? { skillId: input.skillId } : { slug: input.slug }),
          ...(input.revision ? { revision: input.revision } : {}),
          ...(input.error ? { error: input.error } : {}),
        },
        signal,
      },
    );
    if (!res.ok) {
      process.stderr.write(`[daemon] skill sync ack failed ${input.slug}: ${res.error?.message ?? 'request failed'}\n`);
    }
  } catch (err) {
    process.stderr.write(`[daemon] skill sync ack failed ${input.slug}: ${(err as Error).message}\n`);
  }
}
