import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDevPreset } from '../src/daemon/seed-dev-preset.js';
// resolveBuiltInSkillsRoot moved to coding-skill-set.ts (seed-dev-preset now
// consumes it via installCodingSkills); import it from its current home.
import { resolveBuiltInSkillsRoot } from '../src/adapters/coding/shared/coding-skill-set.js';

const MANAGED_START = '<!-- prismer:managed:start';
const MANAGED_END = '<!-- prismer:managed:end -->';

let dir: string;
const savedFlag = process.env.PRISMER_SEED_DEV_PRESET;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seed-preset-'));
  delete process.env.PRISMER_SEED_DEV_PRESET; // default ON
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env.PRISMER_SEED_DEV_PRESET;
  else process.env.PRISMER_SEED_DEV_PRESET = savedFlag;
});

const skillsResolvable = resolveBuiltInSkillsRoot() !== null;

describe('seedDevPreset — init (full seed)', () => {
  it('seeds manuals, docs/agents, and coding+common skills (not persistence)', async () => {
    await seedDevPreset(dir, 'init');

    // (a) manuals exist with managed markers
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const p = join(dir, f);
      expect(existsSync(p)).toBe(true);
      const c = readFileSync(p, 'utf8');
      expect(c).toContain(MANAGED_START);
      expect(c).toContain(MANAGED_END);
    }

    // (c) docs/agents
    expect(existsSync(join(dir, 'docs', 'agents', 'platform.md'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'agents', 'domain.md'))).toBe(true);

    // (b) skills — only assert when the real bundle resolves
    if (skillsResolvable) {
      const skillsDir = join(dir, '.claude', 'skills');
      expect(existsSync(skillsDir)).toBe(true);
      // coding-scoped (e.g. tdd, claude-api)
      const hasCoding = existsSync(join(skillsDir, 'tdd')) || existsSync(join(skillsDir, 'claude-api'));
      expect(hasCoding).toBe(true);
      // common-scoped (memory)
      expect(existsSync(join(skillsDir, 'memory'))).toBe(true);
      // persistence-only (okr) must NOT be seeded
      expect(existsSync(join(skillsDir, 'okr'))).toBe(false);
    }
  });

  it('is idempotent — second init run does not throw and preserves existing skill dirs', async () => {
    await seedDevPreset(dir, 'init');

    if (skillsResolvable) {
      // mark an existing skill dir with a sentinel; it must survive
      const sentinel = join(dir, '.claude', 'skills', 'memory', '__sentinel__');
      writeFileSync(sentinel, 'keep me', 'utf8');
      await seedDevPreset(dir, 'init');
      expect(existsSync(sentinel)).toBe(true);
    } else {
      await seedDevPreset(dir, 'init');
    }

    // manuals still have exactly one managed block (replace-in-place, not duplicated)
    const c = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(c.match(new RegExp(MANAGED_END, 'g'))?.length).toBe(1);
  });
});

describe('seedDevPreset — cloned (existing repo, append-only)', () => {
  it('preserves user content, appends managed block, does not stomp existing .claude/skills', async () => {
    const userContent = '# My Repo\n\nUser-written intro.\n';
    writeFileSync(join(dir, 'AGENTS.md'), userContent, 'utf8');

    // pre-existing .claude/skills with a user skill
    const existingSkill = join(dir, '.claude', 'skills', 'my-skill');
    mkdirSync(existingSkill, { recursive: true });
    writeFileSync(join(existingSkill, 'SKILL.md'), 'user skill', 'utf8');

    await seedDevPreset(dir, 'cloned');

    const c = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(c).toContain('User-written intro.'); // user content preserved
    expect(c.startsWith(userContent)).toBe(true);
    expect(c).toContain(MANAGED_START); // managed block appended

    // existing .claude/skills NOT stomped, and NOT augmented with bundle skills
    expect(existsSync(join(existingSkill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'tdd'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'skills', 'memory'))).toBe(false);

    // docs/agents NOT created on append-only seed
    expect(existsSync(join(dir, 'docs', 'agents', 'platform.md'))).toBe(false);
  });

  it('updates an existing managed block in place (no duplication)', async () => {
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      `# Repo\n\n${MANAGED_START} (auto-generated; edits outside this block are preserved) -->\n\nOLD\n${MANAGED_END}\n\n## tail\n`,
      'utf8',
    );

    await seedDevPreset(dir, 'cloned');

    const c = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(c).toContain('# Repo'); // header preserved
    expect(c).toContain('## tail'); // trailing user content preserved
    expect(c).not.toContain('OLD'); // old managed body replaced
    expect(c.match(new RegExp(MANAGED_END, 'g'))?.length).toBe(1); // single block
  });
});

describe('seedDevPreset — reused', () => {
  it('is a no-op', async () => {
    await seedDevPreset(dir, 'reused');
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });
});

describe('seedDevPreset — flag off', () => {
  it('writes nothing when PRISMER_SEED_DEV_PRESET=false', async () => {
    process.env.PRISMER_SEED_DEV_PRESET = 'false';
    await seedDevPreset(dir, 'init');
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, 'docs'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  it('also off via opts.enabled=false', async () => {
    await seedDevPreset(dir, 'init', { enabled: false });
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });
});
