/**
 * product209/15 PKF-G2 — APC 18-directory inventory freeze + authoring slimness.
 *
 * Oracles are the real files on disk (`sdk/apc/skills/`), not chat text:
 *   • the inventory is EXACTLY the frozen 18 slugs — a rogue 19th dir is red;
 *   • the 9 authoring skills reference the canonical `pkf-writing` skill and
 *     carry the doc10 §2.5 declaration format, but ZERO grammar skeleton
 *     (no `application/prismer+json` frontmatter template, no `<prismer-data`
 *     block — those live in `pkf-writing` only);
 *   • the other 9 dirs are untouched: they must not gain PKF sections
 *     ("无差别改 18 目录" is red).
 *
 * Every check has its own negative control: the same function must flip red
 * after the injected tamper and green again after restore (no forever-green
 * assertions).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILLS_DIR = resolve(__dirname, '..', '..', 'skills');

/** 18-directory inventory (frozen 2026-08-03, docs/apc/22: ui-align + ui-canvas 并存). */
const FROZEN_18 = [
  'bug-reproduce',
  'code-review',
  'design-review',
  'doc-sync',
  'env-doctor',
  'git-ops',
  'impact-trace',
  'observability',
  'release-db-config-sync',
  'release-ota-promote',
  'release-preflight',
  'release-rollback',
  'release-tag',
  'spec-intake',
  'test-result-feedback',
  'test-runner',
  'ui-align',
  'ui-canvas',
] as const;

/** product209/15 PKF-G2 — the 9 authoring skills that carry slim PKF sections. */
const AUTHORING_9 = [
  'code-review',
  'doc-sync',
  'release-db-config-sync',
  'release-ota-promote',
  'release-preflight',
  'release-rollback',
  'release-tag',
  'test-result-feedback',
  'ui-align',
] as const;

const NON_AUTHORING = FROZEN_18.filter((s) => !(AUTHORING_9 as readonly string[]).includes(s));

// Grammar-skeleton literals that must NOT survive in any authoring SKILL.md.
const SKELETON_LITERALS = ['application/prismer+json', '<prismer-data'];

function listSkillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function skillMd(slug: string): string {
  return readFileSync(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
}

/** In-memory permutation helper — every check runs green + tampered-red. */
async function expectRedWith(mutate: () => void, check: () => void, restore: () => void): Promise<void> {
  mutate();
  try {
    expect(check).toThrow();
  } finally {
    restore();
  }
  expect(check).not.toThrow(); // restore ⇒ green again (not forever-red)
}

function checkInventory(): void {
  const dirs = listSkillDirs();
  if (dirs.length !== 18 || dirs.some((d, i) => d !== FROZEN_18[i])) {
    throw new Error(`inventory drift: disk=${dirs.join(',')}`);
  }
}

function checkAuthoringSlim(): void {
  for (const slug of AUTHORING_9) {
    const md = skillMd(slug);
    if (!md.includes('pkf-writing')) {
      throw new Error(`${slug}: missing canonical pkf-writing reference`);
    }
    if (!md.includes('PKF: prismer://workspace/') || !md.includes('PKF: none —')) {
      throw new Error(`${slug}: missing doc10 §2.5 declaration format (漏 declaration)`);
    }
    for (const literal of SKELETON_LITERALS) {
      if (md.includes(literal)) {
        throw new Error(`${slug}: grammar skeleton literal survives (${literal})`);
      }
    }
  }
}

function checkNonAuthoringUntouched(): void {
  for (const slug of NON_AUTHORING) {
    const md = skillMd(slug);
    if (md.includes('pkf-writing') || md.includes('PKF 直写') || md.includes('PKF 双投影')) {
      throw new Error(`${slug}: non-authoring skill gained a PKF section`);
    }
  }
}

describe('PKF-G2 APC inventory (real filesystem oracle)', () => {
  const rogueDir = join(SKILLS_DIR, 'zz-rogue-tamper');
  const touched: string[] = [];

  const backup = (slug: string) => {
    const p = join(SKILLS_DIR, slug, 'SKILL.md');
    writeFileSync(`${p}.g2bak`, readFileSync(p));
    touched.push(`${p}.g2bak`);
    return p;
  };
  const restore = (p: string) => {
    writeFileSync(p, readFileSync(`${p}.g2bak`));
    rmSync(`${p}.g2bak`);
  };

  afterEach(() => {
    if (existsSync(rogueDir)) rmSync(rogueDir, { recursive: true, force: true });
    for (const bak of touched) if (existsSync(bak)) rmSync(bak);
    touched.length = 0;
  });

  it('inventory is exactly the frozen 18 slugs', async () => {
    expect(listSkillDirs()).toEqual([...FROZEN_18].sort());
    // negative control: a rogue 19th dir must flip the check red
    await expectRedWith(
      () => mkdirSync(rogueDir),
      checkInventory,
      () => rmSync(rogueDir, { recursive: true, force: true }),
    );
  });

  it('9 authoring skills are slim: pkf-writing reference + declaration, zero grammar skeleton', async () => {
    checkAuthoringSlim();
    // negative control 1: a skeleton literal smuggled back in ⇒ red
    const p = backup('code-review');
    await expectRedWith(
      () => writeFileSync(p, readFileSync(p) + '\napplication/prismer+json\n'),
      checkAuthoringSlim,
      () => restore(p),
    );
    // negative control 2: declaration format stripped ⇒ red (漏 declaration)
    const p2 = backup('release-tag');
    await expectRedWith(
      () => writeFileSync(p2, skillMd('release-tag').replace('PKF: prismer://workspace/', 'PKF: ')),
      checkAuthoringSlim,
      () => restore(p2),
    );
  });

  it('the other 9 dirs are untouched (no PKF section added)', async () => {
    checkNonAuthoringUntouched();
    // negative control: polluting a non-authoring skill ⇒ red
    const p = backup('git-ops');
    await expectRedWith(
      () => writeFileSync(p, readFileSync(p) + '\npkf-writing\n'),
      checkNonAuthoringUntouched,
      () => restore(p),
    );
  });
});
