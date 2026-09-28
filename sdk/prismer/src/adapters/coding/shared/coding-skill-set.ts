// release203 — canonical coding-agent skill set + multi-format CRUD installer.
//
// A coding agent (claude-code / codex / opencode) must NOT inherit the platform/
// orchestration/PM skills (tasks-Kanban, prismer-im-collab, role/skill builders,
// agent-coordination, …). The legacy `seedDevPreset` filtered with
// `scope ∈ {common, coding}`, and because `skillScopeMatchesCategory('common',
// 'coding') === true` it dumped the ENTIRE `common` bucket into every coder.
// That was both wrong (Kanban skill on a coder is meaningless) and inconsistent
// (it only ever wrote claude-code's `.claude/skills`, so codex/opencode got none).
//
// This module replaces that with (a) an explicit coding set and (b) a CRUD
// reconciler that installs it — identically — into each adapter's OWN skills
// directory. Install locations are VERIFIED, not assumed:
//   - claude-code → <cwd>/.claude/skills/<slug>/   (settingSources "project")
//   - codex       → <CODEX_HOME>/skills/<slug>/     (skills/list — probe-verified)
//   - opencode    → <cwd>/.opencode/command/*.md    (flat command md — separate)
//
// Everything is SYNC so the codex CODEX_HOME writer (writeCodexPrismerHome, sync)
// can seed too. The daemon-local set here is the default; an admin-managed set
// (cloud → all devices) layers on top later.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CodingSkillScope = 'common' | 'persistence' | 'coding';
export interface CodingSkill {
  slug: string;
  /** Absolute path to the skill's source directory (containing SKILL.md). */
  dir: string;
  scope: CodingSkillScope;
}

/**
 * Common-scope skills genuinely useful to a coding agent. Everything ELSE that
 * is `common` (tasks, prismer-im-collab, agent-coordination, agent-meta,
 * claim-agent-ownership, human-approval, internal-comms, role-builder,
 * skill-authoring, skill-builder, skill-creator) is orchestration/PM/meta and
 * is intentionally withheld from coders. (`memory-curation` no longer exists —
 * it is a hidden compatibility alias of `memory`, product209/15 PKF-C2.)
 *
 * This is the tunable default; the admin-managed set replaces it later.
 */
export const CODING_COMMON_ALLOWLIST = new Set(['memory', 'assets', 'ingest', 'pkf-writing', 'pkf-svg', 'evidence-citations', 'webapp-qa']);

/** Marker file we drop in every skill dir we install, so the reconciler can tell
 * OUR managed skills from user-authored ones and never stomp the latter. */
const MANAGED_MARKER = '.prismer-managed';

/**
 * apc/00 §2.4 — marker for the SECOND ownership class: skills that reached this
 * cwd because this agent's workspace is the PLATFORM workspace, not because
 * they live in the local built-in bundle (which seeds every coding agent).
 *
 * Two disjoint managed classes, each reconciled by its own function:
 *   `.prismer-managed`  → the local built-in coding set (reconcileManagedSkills)
 *   `.prismer-entitled` → the platform-workspace APC set (reconcileEntitledSkillDirs)
 *
 * Disjointness is what makes the two installers order-independent: neither
 * reconciler may evict or clobber a dir owned by the other, and neither ever
 * touches a user-authored (unmarked) dir.
 */
export const ENTITLED_MARKER = '.prismer-entitled';

export interface SkillFrontmatter {
  /** `name:` from the frontmatter — the identity claude-code matches on. */
  name: string | null;
  scope: CodingSkillScope;
}

export function parseSkillFrontmatter(skillMd: string): SkillFrontmatter {
  const fm = /^---\n([\s\S]*?)\n---/.exec(skillMd);
  const block = fm?.[1];
  const scopeMatch = block ? /^scope:\s*(common|persistence|coding)\s*$/m.exec(block) : null;
  const nameMatch = block ? /^name:\s*(.+?)\s*$/m.exec(block) : null;
  const rawName = nameMatch?.[1]?.replace(/^['"]|['"]$/g, '').trim();
  return {
    name: rawName && /^[a-zA-Z0-9._-]+$/.test(rawName) ? rawName : null,
    scope: (scopeMatch?.[1] as CodingSkillScope) ?? 'common',
  };
}

function parseScope(skillMd: string): CodingSkillScope {
  return parseSkillFrontmatter(skillMd).scope;
}

/**
 * Resolve the built-in-skills bundle ROOT. Mirrors `resolveBuiltInSkillsRoot`
 * in seed-dev-preset.ts; both source files bundle into the same dist entry so
 * the `import.meta.url`-relative candidates are identical.
 */
export function resolveBuiltInSkillsRoot(): string | null {
  // Explicit override — used by tests (running from `src/`, where none of the
  // import.meta-relative candidates exist) and by bundles that relocate the
  // skill directory. Ignored when the path doesn't exist.
  const override = process.env.PRISMER_BUILT_IN_SKILLS_ROOT?.trim();
  if (override && existsSync(override)) return override;
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  }
  const candidates = [
    join(here, 'built-in-skills'),
    join(here, '..', 'built-in-skills'),
    join(here, '..', '..', 'built-in-skills'),
    join(here, '..', '..', '..', 'built-in-skills'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** All built-in skill slugs (any scope) — used so the reconciler can also evict
 * legacy unmarked seeds (skills the OLD seedDevPreset copied without a marker). */
export function allBuiltInSkillSlugs(builtInRoot: string): Set<string> {
  const slugs = new Set<string>();
  let entries;
  try {
    entries = readdirSync(builtInRoot, { withFileTypes: true });
  } catch {
    return slugs;
  }
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(builtInRoot, e.name, 'SKILL.md'))) slugs.add(e.name);
  }
  return slugs;
}

/** The skills that belong on a coding agent: all `coding`-scope skills + the
 * allowlisted `common` ones. Excludes platform/orchestration/PM skills. */
export function resolveCodingSkillSet(builtInRoot: string): CodingSkill[] {
  const out: CodingSkill[] = [];
  let entries;
  try {
    entries = readdirSync(builtInRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(builtInRoot, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let scope: CodingSkillScope;
    try {
      scope = parseScope(readFileSync(skillMd, 'utf8'));
    } catch {
      continue;
    }
    const keep = scope === 'coding' || (scope === 'common' && CODING_COMMON_ALLOWLIST.has(entry.name));
    if (keep) out.push({ slug: entry.name, dir: join(builtInRoot, entry.name), scope });
  }
  return out;
}

/**
 * apc/00 §2.4 — decide whether an APC skill belongs in a coding agent's
 * `<cwd>/.claude/skills/`, ASSUMING the caller already proved this agent's
 * workspace is the platform workspace (see `resolvePlatformScope`). This
 * function is the per-skill filter only; it is NOT the authorization gate.
 *
 * Why not just add `sdk/apc/skills` to `resolveBuiltInSkillsRoot()`: that
 * bundle seeds EVERY coding agent, and the decree scopes the APC family to the
 * single platform workspace. The workspace gate lives one level up; here we
 * only decide which of the platform's skills may occupy a coding cwd.
 *
 * Rules (all must hold):
 *   1. NOT a built-in slug — the local bundle stays authoritative for those
 *      (`reconcileManagedSkills` owns them; double ownership would ping-pong).
 *   2. scope ≠ 'persistence' — persistence skills are hermes-only; they must
 *      never land in a coding cwd (the hermes-only gate in skill-sync stands).
 *   3. scope ∈ {coding, common} — for the platform workspace, "全量装载 APC"
 *      is the decree, so `CODING_COMMON_ALLOWLIST` (which trims the
 *      unselective built-in common bucket) does NOT apply here.
 *
 * Returns the on-disk dir name (frontmatter `name` preferred over the source
 * dir name, since claude-code resolves a skill by its frontmatter name).
 */
export function selectEntitledCodingSkill(args: {
  slug: string;
  skillMd: string;
  builtInSlugs: Set<string>;
}): { dirName: string; scope: CodingSkillScope } | null {
  if (args.builtInSlugs.has(args.slug)) return null;
  const { name, scope } = parseSkillFrontmatter(args.skillMd);
  if (scope === 'persistence') return null;
  if (scope !== 'coding' && scope !== 'common') return null;
  const dirName = name ?? args.slug;
  // Rule 1 again on the resolved dir name — a community skill whose frontmatter
  // name collides with a built-in slug must not hijack the built-in's dir.
  if (args.builtInSlugs.has(dirName)) return null;
  return { dirName, scope };
}

/**
 * Evict entitled-class dirs (and ONLY those) that are no longer entitled —
 * the uninstall half of the cloud-entitled CRUD. Dirs owned by the built-in
 * class or authored by the user carry no `.prismer-entitled` marker and are
 * never considered.
 */
export function reconcileEntitledSkillDirs(skillsDir: string, wantedDirNames: Set<string>): number {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (wantedDirNames.has(entry.name)) continue;
    const dir = join(skillsDir, entry.name);
    if (!existsSync(join(dir, ENTITLED_MARKER))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/** Stamp a dir as belonging to the cloud-entitled class. */
export function markEntitledSkillDir(dir: string): void {
  writeFileSync(join(dir, ENTITLED_MARKER), '', 'utf8');
}

/**
 * Reconcile `skillsDir` to exactly the managed coding set (CRUD):
 *   - install/overwrite each desired skill (stamped with the managed marker),
 *   - delete skill dirs that are ours (managed marker OR a known built-in slug)
 *     but no longer in the set — this is what evicts the wrongly-seeded
 *     `tasks` / `prismer-im-collab` / … from existing workdirs,
 *   - never touch user-authored (unmarked, non-built-in) dirs.
 *
 * `managedSlugs` = every built-in slug, so legacy unmarked seeds are also evicted.
 * Best-effort per skill; returns counts for logging.
 */
export function reconcileManagedSkills(
  skillsDir: string,
  desired: CodingSkill[],
  managedSlugs: Set<string>,
): { installed: number; removed: number } {
  mkdirSync(skillsDir, { recursive: true });
  const wanted = new Map(desired.map((s) => [s.slug, s]));

  let removed = 0;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    // Never evict a dir owned by the cloud-entitled class (disjoint ownership;
    // `reconcileEntitledSkillDirs` is the only reconciler allowed to remove it).
    if (existsSync(join(dir, ENTITLED_MARKER))) continue;
    const ours = existsSync(join(dir, MANAGED_MARKER)) || managedSlugs.has(entry.name);
    if (ours && !wanted.has(entry.name)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* best-effort */
      }
    }
  }

  let installed = 0;
  for (const skill of desired) {
    const destDir = join(skillsDir, skill.slug);
    // Never clobber the cloud-entitled class either (see the evict loop above).
    if (existsSync(join(destDir, ENTITLED_MARKER))) continue;
    // Never clobber a user-authored skill of the same slug (no marker, not built-in).
    if (existsSync(destDir) && !existsSync(join(destDir, MANAGED_MARKER)) && !managedSlugs.has(skill.slug)) {
      continue;
    }
    try {
      rmSync(destDir, { recursive: true, force: true });
      cpSync(skill.dir, destDir, { recursive: true });
      writeFileSync(join(destDir, MANAGED_MARKER), '', 'utf8');
      installed++;
    } catch {
      /* best-effort per skill */
    }
  }
  return { installed, removed };
}

/**
 * One-call install of the canonical coding skill set into a target skills dir.
 * Resolves the built-in root, the set, and the full slug catalog, then reconciles.
 * Returns null + a reason when the built-in root can't be found (caller logs).
 */
export function installCodingSkills(skillsDir: string): { installed: number; removed: number } | null {
  const root = resolveBuiltInSkillsRoot();
  if (!root) return null;
  return reconcileManagedSkills(skillsDir, resolveCodingSkillSet(root), allBuiltInSkillSlugs(root));
}

// ---------------------------------------------------------------- APC source
//
// The APC family's source of truth is the WORKING TREE (`sdk/apc/skills/`), not
// the cloud skill catalog. Rationale (user decree, 2026-07-26):
//   - APC skills exist to develop prismercloud ITSELF, inside the one platform
//     workspace. They are never published, never installed per-agent, and have
//     no marketplace lifecycle — so "publish then let cloud hand them back" is
//     pure ceremony that also guarantees staleness (cloud's copy lagged the
//     tree by days and was missing 10 of the 17 skills).
//   - Reading the tree makes "latest" free and removes cloud from the CONTENT
//     path entirely. Cloud stays in the AUTHORIZATION path only.

/**
 * Locate the working-tree `sdk/apc/skills/` directory.
 *
 * `PRISMER_APC_SKILLS_ROOT`, when SET, is authoritative — including when it
 * points nowhere (→ null). Tests depend on that strictness: a fallback walk
 * would otherwise find this repo's real `sdk/apc/skills` and make the
 * "no source" case unrepresentable.
 *
 * Otherwise walk up from this module looking for `apc/skills` or
 * `sdk/apc/skills`. Running from `src/` (tests, tsx) in a repo checkout needs
 * up to 7 hops to reach `sdk/`, hence the depth.
 *
 * On a PACKAGED host it is exactly ONE hop above `dist/`: the build mirrors
 * `sdk/apc/skills` → `<package>/apc/skills` (runtime prebuild hook), npm ships
 * it via `files`, and both OTA packers stage `apc/` at the bundle root. So an
 * npm-installed daemon (`node_modules/@prismer/runtime/dist/cli.js`), an OTA
 * bundle (`bundles/daemon/<v>/dist/cli.js`) and the desktop built-in floor
 * (`resources/runtime/dist/cli.js`) all resolve. Before desktop205 D8 they did
 * not, and `installPlatformApcSkills` silently installed nothing everywhere
 * except a repo working tree — a second gate hiding behind the platform gate.
 *
 * Null now means genuinely no source (a stripped install), not "not a checkout".
 */
export function resolveApcSkillsRoot(): string | null {
  const raw = process.env.PRISMER_APC_SKILLS_ROOT;
  if (raw !== undefined) {
    const override = raw.trim();
    return override && existsSync(override) ? override : null;
  }
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    for (const candidate of [join(dir, 'apc', 'skills'), join(dir, 'sdk', 'apc', 'skills')]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every APC skill dir that may occupy a coding cwd (scope ≠ persistence). */
export function resolveApcSkillSet(apcRoot: string): CodingSkill[] {
  const out: CodingSkill[] = [];
  let entries;
  try {
    entries = readdirSync(apcRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(apcRoot, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let scope: CodingSkillScope;
    try {
      scope = parseScope(readFileSync(skillMd, 'utf8'));
    } catch {
      continue;
    }
    if (scope === 'persistence') continue;
    out.push({ slug: entry.name, dir: join(apcRoot, entry.name), scope });
  }
  return out;
}

/**
 * Reconcile `skillsDir` to exactly the APC set, copied from the working tree.
 *
 * ONLY call this once the platform-workspace gate has said yes. Returns null
 * when the APC source can't be found — the caller must then leave the dir
 * alone (absence of source is not evidence of loss of entitlement, and
 * evicting on it would flap a platform checkout that moved its dist).
 *
 * Ownership: writes only dirs it stamps `.prismer-entitled`, skips any
 * pre-existing dir that lacks that marker (that dir belongs to the built-in
 * managed class or to the user), and evicts only entitled-class strays.
 */
export function installPlatformApcSkills(
  skillsDir: string,
): { installed: number; removed: number; loaded: Array<{ slug: string; skillId?: string | null }> } | null {
  const apcRoot = resolveApcSkillsRoot();
  if (!apcRoot) return null;
  const desired = resolveApcSkillSet(apcRoot);

  const builtInRoot = resolveBuiltInSkillsRoot();
  const builtInSlugs = builtInRoot ? allBuiltInSkillSlugs(builtInRoot) : new Set<string>();

  const wanted = new Set<string>();
  const loaded: Array<{ slug: string; skillId?: string | null }> = [];
  let installed = 0;

  for (const skill of desired) {
    let skillMd: string;
    try {
      skillMd = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const selected = selectEntitledCodingSkill({ slug: skill.slug, skillMd, builtInSlugs });
    if (!selected) continue;
    const destDir = join(skillsDir, selected.dirName);
    // Foreign dir (user-authored, or owned by the `.prismer-managed` class) —
    // never clobber. Disjoint ownership is what keeps the two reconcilers
    // order-independent.
    if (existsSync(destDir) && !existsSync(join(destDir, ENTITLED_MARKER))) continue;
    try {
      rmSync(destDir, { recursive: true, force: true });
      cpSync(skill.dir, destDir, { recursive: true });
      markEntitledSkillDir(destDir);
    } catch {
      continue; // best-effort per skill
    }
    wanted.add(selected.dirName);
    installed++;
    loaded.push({ slug: selected.dirName, skillId: null });
  }

  const removed = reconcileEntitledSkillDirs(skillsDir, wanted);
  return { installed, removed, loaded };
}
