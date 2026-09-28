/**
 * Canonical `pkf-svg` visual-authoring discipline.
 *
 * The skill owns controlled SVG/widget/Visual Core composition rules, while
 * remaining honest about the production surface: PKF v1.1 pages author
 * diagrams with Mermaid and data charts with d3; PKF v1.2 (pkf209 D19,
 * activated 2026-08-18) additionally allows the CONTROLLED `prismer-svg`
 * subset inside PKF source — bounded by the frozen validator whitelist, never
 * free/raw. `pkf-visual` is a compatibility alias, never a second canonical
 * directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validatePkfSvg } from '@prismer/pkf';
import { PKF_SEMANTIC_RAMP_LEVELS, semanticRampHexTable } from '@prismer/pkf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(__dirname, '..', '..', 'cloud', 'catalog', 'skills');
const SKILL_DIR = join(CATALOG, 'pkf-svg');
const OLD_SKILL_DIR = join(CATALOG, 'pkf-visual');

function readSkill(): string {
  const path = join(SKILL_DIR, 'SKILL.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function gateProductionTruth(content: string): void {
  expect(content).toMatch(/PKF v1\.1/i);
  expect(content).toMatch(/no .*production.*authoring|not .*production.*authoring/i);
  expect(content).toMatch(/Mermaid/);
  expect(content).toMatch(/d3/i);
  expect(content).toMatch(/<prismer-diagram/);
  // v1.2 controlled `prismer-svg` subset (pkf209 03 D19) is ACTIVATED
  // (2026-08-18): authoring inside the frozen whitelist is taught, free/raw
  // SVG authoring and stale owner-gate language must not survive.
  expect(content).toMatch(/v1\.2/);
  expect(content).toMatch(/controlled|whitelist|白名单/i);
  expect(content).toMatch(/v1\.2.*ACTIVATED|ACTIVATED.*v1\.2|v1\.2.*已激活/is);
  expect(content).toMatch(/frozen whitelist|whitelist.*frozen|冻结.*白名单/i);
  expect(content).toMatch(/hard structure failures|structure fail/i);
  expect(content).toMatch(/svg-\*/);
  expect(content).toMatch(/may be authored|author.*inside PKF source|在 PKF source.*author/i);
  expect(content).not.toMatch(/owner[- ]gated|owner gate|SS-14 ratification|capability.*advertis/i);
  expect(content).not.toMatch(/prismer-svg.*freely|freely.*prismer-svg|自由.*prismer-svg|prismer-svg.*任意/is);
  expect(content).toMatch(/never author free\/raw|never.*free\/raw SVG|never.*raw SVG/i);
  expect(content).toMatch(/Mermaid renders classic today|classic.*default/i);
  expect(content).toMatch(/D19 proposes host-only/i);
}

function gateQualityFloor(content: string): void {
  expect(content).toMatch(/680\s*[×x]\s*480/i);
  expect(content).toMatch(/x\s*=\s*40.*640/i);
  expect(content).toMatch(/figure.*container.*(?:node|status)/is);
  expect(content).toMatch(/<title>.*<desc>|title.*desc/is);
  expect(content).toMatch(/0\.5px/i);
  expect(content).toMatch(/stable density/i);
}

function gateRampPolicy(content: string): void {
  expect(content).toMatch(/ordinary figure.*≤2|default.*≤2 ramps/is);
  expect(content).toMatch(/topology|architecture/i);
  expect(content).toMatch(/bounded context/i);
  expect(content).toMatch(/(?:up to|最多)\s*4.*domain ramps|4.*领域.*ramp/is);
  expect(content).toMatch(/1.*(?:reserved )?(?:status|risk).*ramp/is);
  expect(content).toMatch(/visual group.*≤2|每个视觉组.*≤2/is);
  expect(content).toMatch(/text(?:ual)? cue|文字副线索/i);
  expect(content).toMatch(/two small flows|双小流程/i);
}

describe('pkf-svg skill', () => {
  it('is the sole canonical directory and retains pkf-visual as metadata alias', () => {
    const md = readSkill();
    expect(existsSync(join(SKILL_DIR, 'SKILL.md'))).toBe(true);
    expect(existsSync(OLD_SKILL_DIR)).toBe(false);
    expect(md).toMatch(/^name:\s*pkf-svg$/m);
    const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(md)![1]);
    expect(frontmatter.metadata.aliases).toContain('pkf-visual');
    expect(frontmatter.metadata.nativeReplaces).toContain('architecture-diagram');
  });

  it('ships a compact entrypoint with complete architecture resources and current production truth', () => {
    const md = readSkill();
    expect(md.split('\n').length).toBeLessThan(320);
    for (const resource of ['GUIDE.md', 'templates/template.html', 'LICENSE.hermes']) {
      expect(existsSync(join(SKILL_DIR, 'references/architecture-diagram', resource)), resource).toBe(true);
    }
    expect(md).toContain('references/architecture-diagram/GUIDE.md');
    expect(existsSync(join(SKILL_DIR, 'references/architecture-diagram/SKILL.md'))).toBe(false);
    gateProductionTruth(md);
  });

  /**
   * pkf209/07 §5 — copy-first artifacts: EVERY ```svg fence in the skill
   * (the 680×480 skeleton + the cluster/node/edge fragments) must pass the
   * frozen validator INCLUDING the quality floors, verbatim. A skill that
   * ships an unshippable example is a lie with extra steps.
   */
  it('every shipped svg artifact (skeleton + fragments) passes validatePkfSvg verbatim', () => {
    const md = readSkill();
    const blocks = [...md.matchAll(/```svg\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
    expect(blocks.length).toBeGreaterThanOrEqual(4); // skeleton + 3 fragments
    for (const block of blocks) {
      const issues = validatePkfSvg({
        width: null,
        height: null,
        viewBox: null,
        svg: block,
        raw: block,
        sourceSection: null,
      });
      expect(issues, block.slice(0, 120)).toEqual([]);
    }
  });

  it('teaches the copy → edit → pkf_svg_check loop and the stable quality-floor codes', () => {
    const md = readSkill();
    expect(md).toMatch(/copy the skeleton/i);
    expect(md).toMatch(/`pkf_svg_check`/);
    expect(md).toMatch(/sk-backdrop/);
    expect(md).toMatch(/sk-edges/);
    expect(md).toMatch(/sk-nodes/);
    for (const code of [
      'svg-too-sparse',
      'svg-monochrome',
      'svg-contrast',
      'svg-text-overflow',
      'svg-stroke-floor',
      'svg-unlabeled',
    ]) {
      expect(md).toContain(code);
    }
  });

  it('locks the 680×480 three-level quality floor and accessibility geometry', () => {
    gateQualityFloor(readSkill());
  });

  it('allows bounded-context complexity without turning color into decoration', () => {
    const md = readSkill();
    gateRampPolicy(md);
    expect(md).toMatch(/color.*(?:category|status)|颜色.*(?:类别|状态)/i);
    expect(md).toMatch(/semantic/i);
  });

  it('defines stable semantic pairings and dark-surface depth mapping', () => {
    const md = readSkill();
    expect(md).toMatch(/blue.*system.*deployment/is);
    expect(md).toMatch(/teal.*(?:approved|ready|success)/is);
    expect(md).toMatch(/purple.*(?:control|rollback)/is);
    expect(md).toMatch(/amber.*(?:attention|reversible)/is);
    expect(md).toMatch(/red.*risk/is);
    expect(md).toMatch(/50.*800.*100.*900/is);
  });

  it('teaches safety, routing, and only real d3 chart views', () => {
    const md = readSkill();
    expect(md).toMatch(/script/);
    expect(md).toMatch(/foreignObject/);
    expect(md).toMatch(/event handler|on\*/i);
    expect(md).toMatch(/external (?:URL|reference)/i);
    expect(md).toMatch(/erDiagram/);
    expect(md).toMatch(/chart-bar\|chart-line\|chart-pie/);
    expect(md).not.toMatch(/\bc-line\b|\bc-pie\b/);
  });

  it('has a public generator command and no retired visual generator', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'cloud', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['gen:pkf-svg-skill']).toBe('tsx scripts/gen-pkf-svg-skill.ts');
    expect(pkg.scripts['gen:pkf-visual-skill']).toBeUndefined();
  });

  /**
   * pkf209/07 §6 Phase 4 — token/skill 联动 gate. The shipped hex table must be
   * byte-identical to the one rendered from the package single source
   * (`semanticRampHexTable()`). The generator emits this exact markdown; a
   * hand-edit of either side breaks this gate instead of drifting silently.
   */
  it('semantic ramp hex table matches semanticRampHexTable() output verbatim (drift gate)', () => {
    const md = readSkill();
    const header = `| family | ${PKF_SEMANTIC_RAMP_LEVELS.join(' | ')} |`;
    const rule = `| --- | ${PKF_SEMANTIC_RAMP_LEVELS.map(() => '---').join(' | ')} |`;
    const rows = semanticRampHexTable().map(({ family, hexes }) => `| ${family} | ${hexes.join(' | ')} |`);
    const table = [header, rule, ...rows].join('\n');
    expect(md).toContain(table);
  });

  it('negative control: a hand-edited ramp hex in the table breaks the drift gate', () => {
    const md = readSkill();
    // tamper one hex of the reconstructed expectation → the verbatim match must fail
    const [first, ...rest] = semanticRampHexTable();
    const tamperedRows = [{ ...first, hexes: ['#000000', ...first.hexes.slice(1)] }, ...rest].map(
      ({ family, hexes }) => `| ${family} | ${hexes.join(' | ')} |`,
    );
    const tamperedTable = tamperedRows.join('\n');
    expect(md).not.toContain(tamperedTable);
  });

  it('negative control: free/raw PKF SVG authoring fails the production-truth gate', () => {
    expect(() =>
      gateProductionTruth(
        'PKF v1.1 has no production authoring surface. PKF v1.2 adds a controlled whitelisted `<prismer-svg>`: use it freely with script and onclick for rich topology. Mermaid stays default, charts use d3, look classic.',
      ),
    ).toThrow();
  });

  it('negative control: claiming v1.2 is usable without the frozen-whitelist contract fails the gate', () => {
    expect(() =>
      gateProductionTruth(
        'PKF v1.1 has no production authoring surface. PKF v1.2 adds a controlled whitelist now. Mermaid stays default, charts use d3, use <prismer-diagram>, look classic.',
      ),
    ).toThrow();
  });

  it('negative control: stale owner-gate language (SS-14 ratification / capability advertisement) fails the gate', () => {
    expect(() =>
      gateProductionTruth(
        'PKF v1.1 has no production authoring surface. PKF v1.2 CONTROLLED prismer-svg is ACTIVATED but remains owner-gated until SS-14 ratification and a host capability advertisement; never author free/raw SVG. Mermaid classic, d3 charts, <prismer-diagram>.',
      ),
    ).toThrow();
  });

  it('negative control: a vague canvas rule fails the quality floor', () => {
    expect(() => gateQualityFloor('Use a roomy canvas with accessible labels.')).toThrow();
  });

  it('negative control: an unbounded color exception fails the ramp policy', () => {
    expect(() => gateRampPolicy('Complex architecture diagrams may use as many colors as needed.')).toThrow();
  });
});
