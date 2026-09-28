/**
 * product209/15 PKF-C3 — cross-adapter delivery / prompt eval.
 *
 *   npm --prefix sdk/prismer test -- --run test/pkf-skill-delivery.test.ts
 *
 * Oracles:
 *   • trigger matrix: remember/recall → `memory`; PKF authoring/convert/
 *     validate → `pkf-writing`; periodic convergence → `memory-dream`
 *     (orchestrator-only role gate preserved);
 *   • all four adapters resolve the SAME canonical skills (coding set +
 *     hermes registry + catalog slugs agree);
 *   • no adapter-specific PKF grammar teaching survives anywhere (grep);
 *   • prompt-size receipt: directive ≤1200 chars, memory SKILL.md ≤ 300
 *     lines, pkf-writing SKILL.md < 180 lines.
 *
 * Negative (same journey red): teaching a nonexistent command, an
 * adapter-local PKF grammar copy, or a non-orchestrator Dream route must fail
 * the same checks.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const CATALOG = join(REPO, 'sdk/cloud/catalog/skills');
const RUNTIME_BUNDLE = join(REPO, 'sdk/prismer/built-in-skills');
const RUNTIME_SRC = join(REPO, 'sdk/prismer/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function fm(file: string): string {
  return /^---\n([\s\S]*?)\n---/.exec(read(file))?.[1] ?? '';
}

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'SKILL.md') files.push(target);
    }
  };
  walk(root);
  return files.sort();
}

/** Deterministic intent router over the skills' own descriptions. */
function routeIntent(intent: string): string | null {
  const t = intent.toLowerCase();
  if (/remember|recall|forget|记忆|回忆/.test(t)) return 'memory';
  if (/converge|convergence|tidy|curat|consolidat|dream/.test(t)) return 'memory-dream';
  if (/\.pkf|pkf|author|report|knowledge page|delivery card|报告|知识页|长文/.test(t)) return 'pkf-writing';
  return null;
}

describe('trigger matrix', () => {
  it('remember/recall → memory; PKF authoring → pkf-writing; convergence → memory-dream', () => {
    expect(routeIntent('remember that the user prefers PostgreSQL')).toBe('memory');
    expect(routeIntent('recall past decisions about the deploy flow')).toBe('memory');
    // negative: a recall intent phrased in Chinese must NOT hit pkf-writing
    expect(routeIntent('recall 我的记忆')).toBe('memory');
    expect(routeIntent('recall 我的记忆')).not.toBe('pkf-writing');
    expect(routeIntent('author a .pkf knowledge page with a data table')).toBe('pkf-writing');
    expect(routeIntent('convert this markdown into a structured long report')).toBe('pkf-writing');
    expect(routeIntent('periodic memory convergence — merge duplicate hubs')).toBe('memory-dream');
  });

  it('memory-dream stays orchestrator-only', () => {
    expect(fm(join(CATALOG, 'memory-dream/SKILL.md'))).toMatch(/role_scope:\s*orchestrator-only/);
  });

  it('pkf-writing and memory route mutually exclusive duties', () => {
    const memoryBody = read(join(CATALOG, 'memory/SKILL.md'));
    const dreamBody = read(join(CATALOG, 'memory-dream/SKILL.md'));
    const pkfDesc = fm(join(CATALOG, 'pkf-writing/SKILL.md'));
    // memory routes body syntax to pkf-writing (the seam lives in the body);
    // pkf-writing routes memory decisions back to memory — never both claim.
    // product209/19 WP4: the memory skill now EMBEDS the mandatory PKF write
    // invariants (frontmatter description / typed-link targets / pkf_validate
    // / browse-first governance) instead of only pointing at pkf-writing.
    expect(memoryBody).toMatch(/pkf-writing/);
    expect(memoryBody).toMatch(/PKF body standard \(embedded/);
    expect(memoryBody).toMatch(/REQUIRED frontmatter `description`/);
    expect(memoryBody).toMatch(/pkf_validate/);
    expect(memoryBody).toMatch(/PKF is the content format, not a fourth carrier/);
    expect(memoryBody).toMatch(/Distill durable knowledge/);
    expect(memoryBody).toMatch(/post-turn Memory classifier automatically/);
    expect(memoryBody).toMatch(/Preserve the exact inline PKF as Memory/);
    expect(memoryBody).toMatch(/parentHubPath/);
    expect(memoryBody).not.toMatch(/parent_hub_path/);
    expect(memoryBody).not.toMatch(/persist plain best-effort/);
    expect(dreamBody).toMatch(/Memory Pages.*, not .all PKF/is);
    expect(dreamBody).toMatch(/Cloud SchedulerService/);
    expect(dreamBody).toMatch(/appointed.*orchestrator executes this skill/is);
    expect(dreamBody).toMatch(/INDEX Contents is graph-derived|graph-derived INDEX Contents/);
    expect(dreamBody).toMatch(/degraded:true/);
    expect(pkfDesc).toMatch(/`memory` skill/i);
  });
});

describe('cross-adapter delivery consistency', () => {
  it('coding allowlist + hermes registry + catalog agree on canonical skills', async () => {
    const { CODING_COMMON_ALLOWLIST } = await import('../src/adapters/coding/shared/coding-skill-set.js');
    const { HERMES_MEMORY_TOOLS } = await import('../src/adapters/persistence/hermes/memory-tools.js');
    expect(CODING_COMMON_ALLOWLIST.has('pkf-writing')).toBe(true);
    expect(CODING_COMMON_ALLOWLIST.has('pkf-svg')).toBe(true);
    expect(CODING_COMMON_ALLOWLIST.has('memory')).toBe(true);
    // hermes carries the pkf tools
    for (const name of ['pkf_validate', 'pkf_outline', 'pkf_search', 'pkf_read', 'pkf_bundle_commit']) {
      expect(HERMES_MEMORY_TOOLS.some((t) => t.function.name === name), name).toBe(true);
    }
    // catalog has no stale curation dir; canonical memory carries the alias
    expect(existsSync(join(CATALOG, 'memory-curation'))).toBe(false);
    expect(read(join(CATALOG, 'memory/SKILL.md'))).toMatch(/memory-curation/);
    expect(existsSync(join(CATALOG, 'pkf-svg/SKILL.md'))).toBe(true);
    expect(read(join(CATALOG, 'pkf-svg/SKILL.md'))).toMatch(/aliases:\s*\n\s*-\s*pkf-visual/);
    expect(existsSync(join(CATALOG, 'pkf-visual'))).toBe(false);
  });

  it('no adapter-local PKF grammar teaching survives (grep adapter surfaces)', () => {
    const grammarMarkers = ['<prismer-data', '<prismer-interactive', 'application/prismer+json', 'data-sid='];
    const dirs = [
      join(RUNTIME_SRC, 'adapters/coding'),
      join(RUNTIME_SRC, 'adapters/persistence'),
      join(RUNTIME_SRC, 'adapters/shared'),
      join(RUNTIME_SRC, 'daemon/dispatch.ts'),
    ];
    const offenders: string[] = [];
    const check = (file: string): void => {
      const src = read(file);
      if (src.includes('<prismer-data') || src.includes('application/prismer+json')) offenders.push(file);
    };
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      const st = statSync(dir);
      if (st.isFile()) {
        check(dir);
        return;
      }
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'built-in-skills' || e.name === 'dist') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          if (!p.includes('test')) check(p);
        }
      }
    };
    for (const d of dirs) walk(d);
    expect(offenders, offenders.join(', ')).toEqual([]);
  });

  it('prompt-size receipt: directive ≤1600, memory ≤520 lines, pkf-writing <240', async () => {
    const { MEMORY_CORE_DIRECTIVE, PKF_REPORT_DIRECTIVE } = await import('../src/daemon/dispatch.js');
    // memory211/01 W5 轴H — the directive now carries the COPY+REFERENCE doctrine
    // (the abolished "never copy the body / anti-copy budget" wording was the D2
    // defect: the runtime prompt taught a model the extraction prompt no longer
    // follows) plus the section-level curate verbs. Both are mandated content;
    // 1200 → 1300 and 340 → 360 rebase for exactly that, not for editorial creep.
    //
    // memory211/10 R1 — 1300 → 1600, same precedent, again not editorial creep:
    // 07 §5 维5 mandates that the narrow-task brief carry the verdict-receipt
    // clause ("产物将过门，verdict 回执"), because the §2.1 gate now REJECTS an
    // evolution artifact whose body omits `extra.memory`. Without the clause a
    // dispatched leg reads the 422 as a dead end and drops the artifact — the
    // no-fallback failure mode this lane exists to kill. The clause is one line
    // (210 chars) and the directive sat at 1292/1300, so there was no room to
    // absorb it; 1600 leaves the same ~100-char headroom the 1300 rebase did.
    expect(MEMORY_CORE_DIRECTIVE.length).toBeLessThanOrEqual(1600);
    // product209/19 WP3 — the new PKF-report directive rides the same prompt
    // seam as the memory directive; same lean-prompt budget applies.
    expect(PKF_REPORT_DIRECTIVE.length).toBeLessThanOrEqual(1200);
    // memory211/01 §6.9 裁决 3 (W6) — the skill is REGENERATED for the new loop:
    // three-stage recall protocol (structure route / semantic search / navigation
    // miss-fallback), batch usage, tier trust bands, copy+reference, 64K sharding.
    // Owner ruling: rebuild without historical baggage and REBASE THE BUDGET
    // rather than drop mandated content — 360 → 460 is that rebase (documented in
    // the W6 commit, not editorial creep).
    // memory211/03 §7.2 B2 (owner R5 ruling, 2026-09-06) — the hybrid FIRST-ROUND
    // recall clause is mandated content: batch queries[] search + parameterless
    // root browse in the same round, the tightened digest exemption ("names the
    // answer outright" / one-line mention ≠ coverage), and the browse ordering
    // semantics (structure order + updatedAt DESC + hubsByRecent[], no
    // memory_recent tool). Rebase 460 → 520 for exactly that — the file is 471
    // lines today — same precedent as the W6 360 → 460 rebase, with headroom.
    expect(read(join(CATALOG, 'memory/SKILL.md')).split('\n').length).toBeLessThanOrEqual(520);
    // memory211 follow-up (owner ruling 2026-09-04, 一图胜千言) — pkf-writing gains
    // MANDATED visual content: the content→visual selection guide AND the four
    // visual-source lanes (native draw / controlled SVG / AI-generate / web
    // materialize). The live commerce-agents report shipped zero visuals; the
    // owner then asked explicitly for the source-lane guidance. 240 → 260 is that
    // rebase for mandated content (same precedent as memory 360→460), partly
    // offset by compressing widget examples and the inline walkthrough.
    expect(read(join(CATALOG, 'pkf-writing/SKILL.md')).split('\n').length).toBeLessThan(260);
  });

  it('memory write guidance treats one successful mutation as terminal for that fact in the turn', async () => {
    const { MEMORY_CORE_DIRECTIVE } = await import('../src/daemon/dispatch.js');
    const memorySkill = read(join(CATALOG, 'memory/SKILL.md'));
    for (const source of [MEMORY_CORE_DIRECTIVE, memorySkill]) {
      expect(source).toContain('{"ok":true}');
      expect(source).toMatch(/do not call `?memory_write`? again|stop writing/i);
      expect(source).toMatch(/memory_load/);
    }
  });

  // memory211/10 R1 (§2.1 + 07 §5 维5) — the evolution-artifact gate is only
  // survivable if the producers are TOLD about it. The §2.1 write gate now
  // rejects an evolution artifact whose body omits `extra.memory`, so both
  // carrier sources must teach (a) that the block exists and (b) that a
  // rejection comes back as a repairable verdict rather than a dead end —
  // otherwise a dispatched leg reads the 422 as "cannot write" and drops the
  // artifact, which is exactly the no-fallback failure this lane exists to kill.
  // NEGATIVE CONTROL: delete the clause from either source and this goes red
  // (exercised on landing: dropping the directive line failed the first loop).
  it('evolution-artifact guidance: the gate and its verdict are taught in BOTH the directive and the skill', async () => {
    const { MEMORY_CORE_DIRECTIVE } = await import('../src/daemon/dispatch.js');
    const memorySkill = read(join(CATALOG, 'memory/SKILL.md'));
    for (const source of [MEMORY_CORE_DIRECTIVE, memorySkill]) {
      expect(source).toContain('extra.memory');
      expect(source).toMatch(/verdict/i);
      expect(source).toMatch(/never (silently )?drop/i);
    }
    // The role domain is a ROUTING fact (07 §2.1), not free text — the skill is
    // where an author reads it, so the three values must be spelled out there.
    expect(memorySkill).toMatch(/knowledge\|procedure\|action_result/);
    // …and the gate's code must be nameable, so an agent can match the 422 to it.
    expect(memorySkill).toContain('evolution_metadata_required');
  });

  it('offline bundle contains byte-identical canonical PKF/Memory skills and no retired visual directory', () => {
    for (const slug of ['pkf-writing', 'pkf-svg', 'memory', 'memory-dream']) {
      const source = join(CATALOG, slug, 'SKILL.md');
      const bundled = join(RUNTIME_BUNDLE, slug, 'SKILL.md');
      expect(existsSync(source), `${slug} catalog source`).toBe(true);
      expect(existsSync(bundled), `${slug} runtime bundle`).toBe(true);
      expect(read(bundled), `${slug} mirror bytes`).toBe(read(source));
    }
    expect(existsSync(join(CATALOG, 'pkf-writing/references'))).toBe(false);
    expect(existsSync(join(RUNTIME_BUNDLE, 'pkf-visual'))).toBe(false);
  });

  it('native Memory schema exposes every Dream surface and the real placement field', async () => {
    const { MEMORY_CURATE_INPUT_SCHEMA, MEMORY_WRITE_INPUT_SCHEMA, MEMORY_CURATE_DESCRIPTION } = await import(
      '../src/adapters/memory-tools.js'
    );
    expect(MEMORY_WRITE_INPUT_SCHEMA.properties).toHaveProperty('parentHubPath');
    expect(MEMORY_WRITE_INPUT_SCHEMA.properties).not.toHaveProperty('parent_hub_path');
    expect(MEMORY_CURATE_INPUT_SCHEMA.properties.kind.enum).toEqual([
      'orphans',
      'duplicates',
      'stale',
      'conflicts',
      'oversized',
      'all',
    ]);
    expect(MEMORY_CURATE_DESCRIPTION).toMatch(/hub TOCs/);
    expect(MEMORY_CURATE_DESCRIPTION).toMatch(/INDEX Contents is derived live/);
  });

  it('carrier-adjacent skills require explicit file delivery and mirror Runtime bytes', () => {
    for (const slug of ['tasks', 'agent-coordination']) {
      const catalog = read(join(CATALOG, `${slug}/SKILL.md`));
      const runtime = read(join(RUNTIME_BUNDLE, `${slug}/SKILL.md`));
      expect(runtime, `${slug} runtime mirror`).toBe(catalog);
      expect(catalog, `${slug} explicit delivery`).toMatch(/cloud deliver|cloud task attach/i);
      expect(catalog, `${slug} no auto watcher`).not.toMatch(
        /artifacts-watcher (?:会)?自动|artifacts-watcher auto-archives/i,
      );
      expect(catalog, `${slug} no implicit final delivery`).not.toMatch(/无需任何 send 命令|platform auto-finalizes/i);
    }
  });

  it('all built-in skills reject the retired implicit artifacts-watcher delivery contract', () => {
    const forbidden = /artifacts-watcher[\s\S]{0,160}auto-archives|artifacts\/`? dir[\s\S]{0,80}auto-archived|会自动归档/i;
    for (const root of [CATALOG, RUNTIME_BUNDLE]) {
      for (const file of collectSkillFiles(root)) {
        expect(read(file), file).not.toMatch(forbidden);
      }
    }
  });
});
