/**
 * apc — the APC skill family lands in a claude-code agent's
 * `<cwd>/.claude/skills/` IF AND ONLY IF that agent's workspace is the platform
 * workspace.
 *
 * The decree (user, 2026-07-26), two clauses:
 *   1. APC skills install in the ONE platform workspace only — they exist to
 *      develop prismercloud itself, and nothing about them is ever published.
 *      Source of truth is therefore the working tree (`sdk/apc/skills/`), never
 *      the cloud catalog.
 *   2. 平台 workspace = 平台管理员账号绑定的 workspace.
 *
 * desktop205 W1 + W2 rewrote HOW clause 2 is answered and what "cannot answer"
 * means:
 *
 *   W1 — the criterion is a boolean CLOUD ships on `GET /api/im/workspaces/:id`
 *        (`platformScoped`). The daemon no longer mirrors the admin allowlist:
 *        the old code read `process.env.ADMIN_EMAILS`, a cloud-only variable
 *        injected into no daemon anywhere, so the gate was permanently false on
 *        every real machine — APC skills were never installed AND every sync
 *        actively deleted any that existed (01-evidence §F3).
 *   W2 — the verdict is three-valued. `unknown` (old cloud / offline / garbage
 *        body / no workspaceId) leaves the directory EXACTLY as it is. Only a
 *        cloud that positively says `false` evicts.
 *
 * Every positive below is paired with the negative that proves the gate is
 * load-bearing (same call, one input flipped).
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncInstalledSkillsForDispatch,
  resolveCodingCwdSkillsDir,
  resolvePlatformScope,
  __resetPlatformWorkspaceCache,
} from '../src/daemon/skill-sync.js';
import {
  ENTITLED_MARKER,
  reconcileManagedSkills,
  resolveApcSkillSet,
  resolveApcSkillsRoot,
  selectEntitledCodingSkill,
} from '../src/adapters/coding/shared/coding-skill-set.js';
import type { AgentProfile } from '../src/adapters/contract.js';

const PLATFORM_WS = 'ws-platform';
const OTHER_WS = 'ws-someone-else';

const cleanupDirs: string[] = [];
const savedEnv = {
  builtIn: process.env.PRISMER_BUILT_IN_SKILLS_ROOT,
  apc: process.env.PRISMER_APC_SKILLS_ROOT,
  admins: process.env.ADMIN_EMAILS,
};

beforeEach(() => {
  __resetPlatformWorkspaceCache();
  // W1 regression guard, ambient form: EVERY test below runs with the variable
  // the old criterion depended on deliberately unset. If anyone reintroduces
  // `process.env.ADMIN_EMAILS` as the gate, the positives go red at once.
  delete process.env.ADMIN_EMAILS;
});

afterEach(async () => {
  restore('PRISMER_BUILT_IN_SKILLS_ROOT', savedEnv.builtIn);
  restore('PRISMER_APC_SKILLS_ROOT', savedEnv.apc);
  restore('ADMIN_EMAILS', savedEnv.admins);
  __resetPlatformWorkspaceCache();
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ------------------------------------------------ W1 — cloud is the criterion

describe('resolvePlatformScope — cloud ships the verdict, daemon holds no allowlist', () => {
  it('is "platform" when cloud says platformScoped:true', async () => {
    const cloud = cloudFor({ [PLATFORM_WS]: true });
    await expect(resolvePlatformScope(cloud as never, PLATFORM_WS)).resolves.toBe('platform');
  });

  // NEGATIVE ① — same call, same code path, the delivered field flipped.
  it('is "not-platform" when cloud says platformScoped:false', async () => {
    const cloud = cloudFor({ [OTHER_WS]: false });
    await expect(resolvePlatformScope(cloud as never, OTHER_WS)).resolves.toBe('not-platform');
  });

  /**
   * W1 REGRESSION GUARD (behavioural half). The daemon must decide from the
   * cloud field ALONE. Both directions are asserted while `ADMIN_EMAILS` is
   * set to a value that, under the old criterion, would have forced the
   * opposite answer:
   *   - unset allowlist used to short-circuit to false BEFORE any cloud read,
   *     so the "platform" case proves the short-circuit is gone;
   *   - a populated allowlist could never make cloud's `false` into a `true`,
   *     so the "not-platform" case proves the env cannot override cloud either.
   */
  it('ignores process.env.ADMIN_EMAILS entirely (both directions)', async () => {
    delete process.env.ADMIN_EMAILS;
    const yes = cloudFor({ [PLATFORM_WS]: true });
    await expect(resolvePlatformScope(yes as never, PLATFORM_WS)).resolves.toBe('platform');
    expect(yes.get).toHaveBeenCalled(); // it DID go ask cloud (old code did not)

    __resetPlatformWorkspaceCache();
    process.env.ADMIN_EMAILS = 'tomwinshare@gmail.com,everyone@example.com';
    const no = cloudFor({ [OTHER_WS]: false });
    await expect(resolvePlatformScope(no as never, OTHER_WS)).resolves.toBe('not-platform');
  });

  /**
   * W1 REGRESSION GUARD (structural half). The behavioural test above can only
   * see the env through its effect; this one forbids the reference outright, so
   * a future "just read the env as a fallback" patch is caught even if it is
   * written not to change any of the verdicts above.
   */
  it('the gate source file contains no reference to ADMIN_EMAILS', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon', 'skill-sync.ts'),
      'utf8',
    );
    // The word appears in the comment block explaining WHY it is gone; what
    // must not exist is a read of it.
    expect(src).not.toMatch(/process\.env\.ADMIN_EMAILS/);
    expect(src).not.toMatch(/process\.env\[['"]ADMIN_EMAILS/);
  });

  it('caches the verdict so a per-dispatch check does not re-ask cloud', async () => {
    const cloud = cloudFor({ [PLATFORM_WS]: true });
    await resolvePlatformScope(cloud as never, PLATFORM_WS);
    const afterFirst = cloud.get.mock.calls.length;
    await resolvePlatformScope(cloud as never, PLATFORM_WS);
    expect(cloud.get.mock.calls.length).toBe(afterFirst);
  });
});

// ---------------------------------- W2 — "cannot tell" is not "no"

describe('resolvePlatformScope — the third value', () => {
  it('is "unknown" when the workspace GET fails (offline / 404 / envelope error)', async () => {
    const cloud = cloudFor({}); // every workspace GET throws
    await expect(resolvePlatformScope(cloud as never, OTHER_WS)).resolves.toBe('unknown');
  });

  it('is "unknown" when the cloud predates the field (platformScoped absent)', async () => {
    const cloud = cloudWithoutPlatformField();
    await expect(resolvePlatformScope(cloud as never, PLATFORM_WS)).resolves.toBe('unknown');
  });

  it('is "unknown" when platformScoped is present but not a boolean', async () => {
    const cloud = cloudWithRawPlatformField('false'); // the string, not the boolean
    await expect(resolvePlatformScope(cloud as never, PLATFORM_WS)).resolves.toBe('unknown');
  });

  it('is "unknown" when the profile carries no workspaceId', async () => {
    const cloud = cloudFor({ [PLATFORM_WS]: true });
    await expect(resolvePlatformScope(cloud as never, '')).resolves.toBe('unknown');
    await expect(resolvePlatformScope(cloud as never, undefined)).resolves.toBe('unknown');
    expect(cloud.get).not.toHaveBeenCalled();
  });

  // NEGATIVE for the whole third-value block: `unknown` is the ABSENCE of a
  // verdict, so it must not be cached — otherwise one blip would pin the
  // workspace into "do nothing" for the rest of the TTL.
  it('never caches "unknown" — the next reachable call decides', async () => {
    const offline = cloudFor({});
    await expect(resolvePlatformScope(offline as never, PLATFORM_WS)).resolves.toBe('unknown');
    const online = cloudFor({ [PLATFORM_WS]: true });
    await expect(resolvePlatformScope(online as never, PLATFORM_WS)).resolves.toBe('platform');
  });
});

// ------------------------------------------------------------- APC source

describe('resolveApcSkillsRoot / resolveApcSkillSet — working tree is the source', () => {
  it('honours an explicit root and returns every non-persistence skill', async () => {
    const { apcRoot } = await tempCwd();
    expect(resolveApcSkillsRoot()).toBe(apcRoot);
    expect(resolveApcSkillSet(apcRoot).map((s) => s.slug).sort()).toEqual([
      'impact-trace',
      'test-runner',
    ]);
  });

  // NEGATIVE: a set root that does not exist resolves to null rather than
  // silently walking up into the real repo.
  it('returns null when the configured root does not exist', () => {
    process.env.PRISMER_APC_SKILLS_ROOT = join(tmpdir(), 'prismer-no-such-apc-root');
    expect(resolveApcSkillsRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------- selection

describe('selectEntitledCodingSkill — scope gate', () => {
  const builtInSlugs = new Set(['tasks', 'memory']);

  it('accepts a coding-scope skill and names the dir after its frontmatter name', () => {
    const got = selectEntitledCodingSkill({
      slug: 'code-review',
      skillMd: skillMd('code-review', 'coding'),
      builtInSlugs,
    });
    expect(got).toEqual({ dirName: 'code-review', scope: 'coding' });
  });

  it('accepts a common-scope skill (全量装载 — no CODING_COMMON_ALLOWLIST here)', () => {
    const got = selectEntitledCodingSkill({
      slug: 'impact-trace',
      skillMd: skillMd('impact-trace', 'common'),
      builtInSlugs,
    });
    expect(got).toEqual({ dirName: 'impact-trace', scope: 'common' });
  });

  // NEGATIVE for both of the above: identical input, scope flipped.
  it('REJECTS a persistence-scope skill (hermes-only delivery)', () => {
    expect(
      selectEntitledCodingSkill({
        slug: 'team-standup',
        skillMd: skillMd('team-standup', 'persistence'),
        builtInSlugs,
      }),
    ).toBeNull();
  });

  it('REJECTS a built-in slug (the local bundle stays authoritative)', () => {
    expect(
      selectEntitledCodingSkill({ slug: 'tasks', skillMd: skillMd('tasks', 'common'), builtInSlugs }),
    ).toBeNull();
  });

  it('REJECTS a built-in slug even when its frontmatter name would dodge the dir check', () => {
    expect(
      selectEntitledCodingSkill({ slug: 'tasks', skillMd: skillMd('tasks-v2', 'coding'), builtInSlugs }),
    ).toBeNull();
  });

  it('REJECTS a skill whose frontmatter name hijacks a built-in slug', () => {
    expect(
      selectEntitledCodingSkill({
        slug: 'apc-evil',
        skillMd: skillMd('memory', 'coding'),
        builtInSlugs,
      }),
    ).toBeNull();
  });
});

// ------------------------------------------------------------- target dir

describe('resolveCodingCwdSkillsDir — claude-code only', () => {
  it('resolves <cwd>/.claude/skills for claude-code', () => {
    expect(resolveCodingCwdSkillsDir(profileFor('claude-code', { cwd: '/repo' }))).toBe(
      join('/repo', '.claude', 'skills'),
    );
  });

  it('prefers the dispatch workdir override over profile.config.cwd', () => {
    expect(
      resolveCodingCwdSkillsDir(profileFor('claude-code', { cwd: '/repo' }), { codingCwd: '/wd/x' }),
    ).toBe(join('/wd/x', '.claude', 'skills'));
  });

  // NEGATIVE: every other adapter must stay out of this seam.
  it('returns null for hermes / codex / opencode', () => {
    for (const adapter of ['hermes', 'codex', 'opencode']) {
      expect(resolveCodingCwdSkillsDir(profileFor(adapter, { cwd: '/repo' }))).toBeNull();
    }
  });
});

// ------------------------------------------------------------ end-to-end

describe('syncInstalledSkillsForDispatch — APC delivery', () => {
  it('installs the working-tree APC set into a PLATFORM workspace coding agent', async () => {
    const { cwd, skillsDir } = await tempCwd();
    const cloud = cloudFor({ [PLATFORM_WS]: true });

    const result = await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-1',
      cloud as never,
    );

    expect(result.synced).toBe(2);
    // Content comes from the TREE, not from any cloud catalog row.
    await expect(readFile(join(skillsDir, 'test-runner', 'SKILL.md'), 'utf8')).resolves.toContain(
      'TREE-ONLY-MARKER',
    );
    await expect(readFile(join(skillsDir, 'impact-trace', 'SKILL.md'), 'utf8')).resolves.toContain(
      'scope: common',
    );
    // stamped with the entitled ownership marker (not the built-in one)
    await expect(access(join(skillsDir, 'test-runner', ENTITLED_MARKER))).resolves.toBeUndefined();
    // multi-file skills keep their extra files
    await expect(
      readFile(join(skillsDir, 'test-runner', 'reference', 'notes.md'), 'utf8'),
    ).resolves.toContain('extra');
  });

  // W1 NEGATIVE (the flip the spec demands): the SAME workspace, the SAME
  // source tree, the SAME call — only the delivered `platformScoped` value is
  // inverted, and the positive above turns red. Nothing installs.
  it('installs NOTHING once the delivered platformScoped flips to false', async () => {
    const { cwd, skillsDir } = await tempCwd();

    const result = await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-1b',
      cloudFor({ [PLATFORM_WS]: false }) as never,
    );

    expect(result.synced).toBe(0);
    await expect(readdir(skillsDir).catch(() => [])).resolves.toEqual([]);
  });

  // NEGATIVE ① (load-bearing) — identical code path, identical source, an agent
  // whose workspace is simply not platform-scoped. Nothing installs AND the
  // skills dir is never even created.
  it('installs NOTHING for a coding agent in a non-platform workspace', async () => {
    const { cwd, skillsDir } = await tempCwd();
    const cloud = cloudFor({ [OTHER_WS]: false });

    const result = await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, OTHER_WS),
      'agent-2',
      cloud as never,
    );

    expect(result.synced).toBe(0);
    await expect(readdir(skillsDir).catch(() => [])).resolves.toEqual([]);
  });

  // NEGATIVE ① (b) — and it EVICTS APC dirs a previous (wrong) criterion left
  // behind. This is the real-machine cleanup case: 7 dirs seeded under the old
  // per-agent-entitlement rule must disappear the next time the agent syncs.
  it('evicts pre-existing APC dirs from a non-platform coding agent', async () => {
    const { cwd, skillsDir } = await tempCwd();
    await seedEntitledDir(skillsDir, 'test-runner');
    await seedEntitledDir(skillsDir, 'impact-trace');
    await seedManagedDir(skillsDir, 'memory');
    await seedUserDir(skillsDir, 'my-own-skill');

    const result = await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, OTHER_WS),
      'agent-3',
      cloudFor({ [OTHER_WS]: false }) as never,
    );

    expect(result.synced).toBe(0);
    // entitled class gone; the OTHER two ownership classes untouched.
    await expect(readdir(skillsDir)).resolves.toEqual(['memory', 'my-own-skill']);
  });

  // ---- W2: install for real, then take the criterion away three ways ----

  /**
   * W2 POSITIVE — the local-first clause. Install under a reachable cloud, then
   * make the very next sync's workspace GET throw. The entitled dirs (and their
   * markers) must SURVIVE: an outage is not evidence of lost entitlement.
   *
   * The verdict cache is dropped between the two syncs on purpose — otherwise
   * the cached `platform` would answer and the offline branch would never run,
   * i.e. the test would pass without testing anything.
   */
  it('W2: keeps the installed APC set when cloud becomes unreachable', async () => {
    const { cwd, skillsDir } = await tempCwd();
    const profile = profileFor('claude-code', { cwd }, PLATFORM_WS);

    await syncInstalledSkillsForDispatch(profile, 'agent-w2a', cloudFor({ [PLATFORM_WS]: true }) as never);
    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'test-runner']);

    __resetPlatformWorkspaceCache();
    const offline = cloudFor({}); // every workspace GET throws
    const result = await syncInstalledSkillsForDispatch(profile, 'agent-w2a', offline as never);

    expect(result.synced).toBe(0);
    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'test-runner']);
    await expect(access(join(skillsDir, 'test-runner', ENTITLED_MARKER))).resolves.toBeUndefined();
  });

  /** W2 POSITIVE (b) — an OLD cloud that does not ship the field yet is the
   * release-order window. Same contract: touch nothing. */
  it('W2: keeps the installed APC set when the cloud predates platformScoped', async () => {
    const { cwd, skillsDir } = await tempCwd();
    const profile = profileFor('claude-code', { cwd }, PLATFORM_WS);

    await syncInstalledSkillsForDispatch(profile, 'agent-w2b', cloudFor({ [PLATFORM_WS]: true }) as never);
    __resetPlatformWorkspaceCache();
    await syncInstalledSkillsForDispatch(profile, 'agent-w2b', cloudWithoutPlatformField() as never);

    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'test-runner']);
  });

  /**
   * W2 NEGATIVE — the eviction capability must NOT have been thrown away by the
   * two tests above. Same fixture, same second sync, but this time cloud is
   * reachable and positively says `platformScoped:false`: the entitled dirs
   * MUST disappear (and only those).
   */
  it('W2 negative: a reachable cloud saying platformScoped:false still evicts', async () => {
    const { cwd, skillsDir } = await tempCwd();
    const profile = profileFor('claude-code', { cwd }, PLATFORM_WS);

    await syncInstalledSkillsForDispatch(profile, 'agent-w2c', cloudFor({ [PLATFORM_WS]: true }) as never);
    await seedUserDir(skillsDir, 'my-own-skill');
    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'my-own-skill', 'test-runner']);

    __resetPlatformWorkspaceCache();
    const result = await syncInstalledSkillsForDispatch(
      profile,
      'agent-w2c',
      cloudFor({ [PLATFORM_WS]: false }) as never,
    );

    expect(result.synced).toBe(0);
    await expect(readdir(skillsDir)).resolves.toEqual(['my-own-skill']);
  });

  // NEGATIVE ③ — persistence never reaches a coding cwd, platform or not.
  it('never writes a persistence-scope APC skill into the coding cwd', async () => {
    const { cwd, skillsDir, apcRoot } = await tempCwd();
    await writeSkill(apcRoot, 'team-standup', 'persistence');

    await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-5',
      cloudFor({ [PLATFORM_WS]: true }) as never,
    );

    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'test-runner']);
  });

  // NEGATIVE ④ — the seam is claude-code-only; a codex profile in the very same
  // platform workspace writes nothing into its cwd.
  it('does not seed a codex cwd', async () => {
    const { cwd, skillsDir } = await tempCwd();

    await syncInstalledSkillsForDispatch(
      profileFor('codex', { cwd }, PLATFORM_WS),
      'agent-6',
      cloudFor({ [PLATFORM_WS]: true }) as never,
    );

    await expect(readdir(skillsDir).catch(() => [])).resolves.toEqual([]);
  });

  it('evicts an APC dir once the skill leaves the working tree', async () => {
    const { cwd, skillsDir, apcRoot } = await tempCwd();
    const profile = profileFor('claude-code', { cwd }, PLATFORM_WS);
    const cloud = cloudFor({ [PLATFORM_WS]: true });

    await syncInstalledSkillsForDispatch(profile, 'agent-7', cloud as never);
    await expect(readdir(skillsDir)).resolves.toEqual(['impact-trace', 'test-runner']);

    await rm(join(apcRoot, 'impact-trace'), { recursive: true, force: true });
    await syncInstalledSkillsForDispatch(profile, 'agent-7', cloud as never);
    await expect(readdir(skillsDir)).resolves.toEqual(['test-runner']);
  });

  it('re-copies the tree on every sync, so an edited skill propagates', async () => {
    const { cwd, skillsDir, apcRoot } = await tempCwd();
    const profile = profileFor('claude-code', { cwd }, PLATFORM_WS);
    const cloud = cloudFor({ [PLATFORM_WS]: true });

    await syncInstalledSkillsForDispatch(profile, 'agent-8', cloud as never);
    await writeFile(
      join(apcRoot, 'test-runner', 'SKILL.md'),
      `${skillMd('test-runner', 'coding')}\n## 输出契约\nNEW-SECTION\n`,
      'utf8',
    );
    await syncInstalledSkillsForDispatch(profile, 'agent-8', cloud as never);

    await expect(readFile(join(skillsDir, 'test-runner', 'SKILL.md'), 'utf8')).resolves.toContain(
      'NEW-SECTION',
    );
  });

  it('never clobbers or evicts a user-authored dir of the same name', async () => {
    const { cwd, skillsDir } = await tempCwd();
    await seedUserDir(skillsDir, 'test-runner');

    await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-9',
      cloudFor({ [PLATFORM_WS]: true }) as never,
    );

    await expect(readFile(join(skillsDir, 'test-runner', 'SKILL.md'), 'utf8')).resolves.toBe('MINE\n');
  });

  it('never clobbers a dir owned by the built-in managed class', async () => {
    const { cwd, skillsDir } = await tempCwd();
    await seedManagedDir(skillsDir, 'test-runner');

    await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-10',
      cloudFor({ [PLATFORM_WS]: true }) as never,
    );

    await expect(readFile(join(skillsDir, 'test-runner', 'SKILL.md'), 'utf8')).resolves.toBe('BUILT-IN\n');
  });

  // FAIL-OPEN-ON-SOURCE (deliberate asymmetry vs the gate): a platform agent
  // whose APC source is missing keeps what it has. Losing the source is not
  // evidence of losing entitlement, and evicting on it would flap.
  it('leaves the dir untouched when the APC source is unresolvable', async () => {
    const { cwd, skillsDir } = await tempCwd();
    await seedEntitledDir(skillsDir, 'test-runner');
    process.env.PRISMER_APC_SKILLS_ROOT = join(tmpdir(), 'prismer-no-such-apc-root');

    await syncInstalledSkillsForDispatch(
      profileFor('claude-code', { cwd }, PLATFORM_WS),
      'agent-11',
      cloudFor({ [PLATFORM_WS]: true }) as never,
    );

    await expect(readdir(skillsDir)).resolves.toEqual(['test-runner']);
  });
});

// -------------------------------------------------- cross-reconciler safety

describe('reconcileManagedSkills — disjoint ownership', () => {
  it('leaves entitled-class dirs alone (they are not in the built-in desired set)', async () => {
    const { skillsDir } = await tempCwd();
    const entitled = join(skillsDir, 'code-review');
    await mkdir(entitled, { recursive: true });
    await writeFile(join(entitled, 'SKILL.md'), skillMd('code-review', 'coding'), 'utf8');
    await writeFile(join(entitled, ENTITLED_MARKER), '', 'utf8');

    reconcileManagedSkills(skillsDir, [], new Set(['code-review', 'tasks']));

    await expect(readFile(join(entitled, 'SKILL.md'), 'utf8')).resolves.toContain('code-review');
  });

  // NEGATIVE: strip the marker and the very same call DOES evict it — proving
  // the marker (not luck) is what protects the entitled class.
  it('evicts the same dir once the entitled marker is gone', async () => {
    const { skillsDir } = await tempCwd();
    const dir = join(skillsDir, 'code-review');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), skillMd('code-review', 'coding'), 'utf8');

    reconcileManagedSkills(skillsDir, [], new Set(['code-review', 'tasks']));

    await expect(readdir(skillsDir)).resolves.toEqual([]);
  });
});

// ------------------------------------------------------------------ helpers

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function tempCwd(): Promise<{ cwd: string; skillsDir: string; apcRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'prismer-apc-coding-'));
  cleanupDirs.push(root);
  // A minimal built-in bundle so `allBuiltInSkillSlugs` is non-empty and the
  // built-in-slug rejection rule has something real to reject.
  const builtIn = join(root, 'built-in-skills');
  for (const slug of ['tasks', 'memory']) {
    await mkdir(join(builtIn, slug), { recursive: true });
    await writeFile(join(builtIn, slug, 'SKILL.md'), skillMd(slug, 'common'), 'utf8');
  }
  process.env.PRISMER_BUILT_IN_SKILLS_ROOT = builtIn;

  // A minimal working-tree APC source: one coding, one common.
  const apcRoot = join(root, 'apc-skills');
  await writeSkill(apcRoot, 'test-runner', 'coding', 'TREE-ONLY-MARKER');
  await mkdir(join(apcRoot, 'test-runner', 'reference'), { recursive: true });
  await writeFile(join(apcRoot, 'test-runner', 'reference', 'notes.md'), 'extra\n', 'utf8');
  await writeSkill(apcRoot, 'impact-trace', 'common');
  process.env.PRISMER_APC_SKILLS_ROOT = apcRoot;

  const cwd = join(root, 'repo');
  await mkdir(cwd, { recursive: true });
  return { cwd, skillsDir: join(cwd, '.claude', 'skills'), apcRoot };
}

async function writeSkill(apcRoot: string, slug: string, scope: string, extra = ''): Promise<void> {
  await mkdir(join(apcRoot, slug), { recursive: true });
  await writeFile(join(apcRoot, slug, 'SKILL.md'), `${skillMd(slug, scope)}${extra}\n`, 'utf8');
}

async function seedEntitledDir(skillsDir: string, name: string): Promise<void> {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, 'SKILL.md'), 'STALE\n', 'utf8');
  await writeFile(join(skillsDir, name, ENTITLED_MARKER), '', 'utf8');
}

async function seedManagedDir(skillsDir: string, name: string): Promise<void> {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, 'SKILL.md'), 'BUILT-IN\n', 'utf8');
  await writeFile(join(skillsDir, name, '.prismer-managed'), '', 'utf8');
}

async function seedUserDir(skillsDir: string, name: string): Promise<void> {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, 'SKILL.md'), 'MINE\n', 'utf8');
}

function skillMd(name: string, scope: string): string {
  return `---\nname: ${name}\ndescription: ${name} test fixture\nscope: ${scope}\n---\n\n# ${name}\n`;
}

/**
 * Cloud double. `get` mirrors CloudClient.get: it returns the UNWRAPPED
 * envelope payload and THROWS on 404 — which is exactly how a workspace the
 * caller is not a member of behaves (verified live against :3000).
 *
 * The workspace body carries `platformScoped` exactly as `GET /workspaces/:id`
 * does after desktop205 W1 (src/im/api/workspaces.ts). A workspace absent from
 * the map throws, i.e. models both 404 and offline.
 */
function cloudFor(platformScopedByWs: Record<string, boolean>) {
  return cloudWith((wsId) => {
    const scoped = platformScopedByWs[wsId];
    if (scoped === undefined) throw new Error('404 workspace not found');
    return { id: wsId, ownerImUserId: 'imu-owner', platformScoped: scoped };
  });
}

/** A cloud deployed BEFORE the field existed — body is otherwise identical. */
function cloudWithoutPlatformField() {
  return cloudWith((wsId) => ({ id: wsId, ownerImUserId: 'imu-owner' }));
}

/** A body whose `platformScoped` is present but not a boolean. */
function cloudWithRawPlatformField(raw: unknown) {
  return cloudWith((wsId) => ({ id: wsId, ownerImUserId: 'imu-owner', platformScoped: raw }));
}

function cloudWith(workspaceBody: (wsId: string) => Record<string, unknown>) {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith('/api/im/skills/installed')) return [];
    const ws = /^\/api\/im\/workspaces\/([^/?]+)$/.exec(path);
    if (ws) return workspaceBody(decodeURIComponent(ws[1]!));
    throw new Error(`unexpected path ${path}`);
  });
  return { get, request: vi.fn(async () => ({ ok: true, status: 200, data: { ok: true } })) };
}

function profileFor(
  adapterName: string,
  config: Record<string, unknown>,
  workspaceId = PLATFORM_WS,
): AgentProfile {
  return {
    id: `profile-${adapterName}`,
    workspaceId,
    agentImUserId: 'agent-1',
    agentUsername: 'agent-user',
    adapterName,
    name: 'Agent',
    config,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentProfile;
}
