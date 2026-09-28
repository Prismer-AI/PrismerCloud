/**
 * product209/15 PKF-C1 + product209/19 WP2 — canonical `pkf-writing` skill acceptance.
 *
 *   npm --prefix sdk/prismer test -- --run test/pkf-writing-skill.test.ts
 *
 * Oracles (WP2 single-file contract):
 *   • the skill ships as a SINGLE SKILL.md under a < 260 line quality budget;
 *     the references/ directory is GONE and never imported;
 *   • the description triggers on PKF authoring/convert/validate intents and
 *     NOT on recall/remember/memory-graph intents (those belong to `memory`);
 *   • it teaches ONLY real commands (native pkf_validate/query tools and the
 *     working cloud pkf offline commands — all shipped by the runtime tools
 *     and the cloud pkf CLI; matrix must stay in sync with
 *     sdk/cloud/scripts/gen-pkf-writing-skill.ts);
 *   • it never teaches bare URIs, base64 assets or remote scripts;
 *   • it carries the WP1 capability guidance (mermaid-driven diagrams /
 *     d3 chart views / prismer-model static 3D / AI image channel) pointing at
 *     src/lib/pkf/examples.ts — simple diagrams stay mermaid-authored
 *     (`<prismer-diagram>`); PKF v1.2 CONTROLLED `prismer-svg` (pkf209 D19,
 *     activated 2026-08-18) is routed for topology/complex hierarchy behind a
 *     `pkf_svg_check` loop, with the SVG grammar itself owned by `pkf-svg`
 *     (this skill never teaches the raw `<prismer-svg>` tag);
 *   • it carries a report-quality floor so long-form/architecture outputs do
 *     not pass merely because the PKF structure is valid;
 *   • the coding allowlist installs it (resolveCodingSkillSet).
 *
 * Negative controls (same journey red): the shared gate helpers turn red on
 * content that exceeds the line budget, teaches a nonexistent command,
 * re-imports references/, or teaches a bare asset URI.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..', '..', 'cloud', 'catalog', 'skills', 'pkf-writing');

function read(rel: string): string {
  return readFileSync(join(SKILL_DIR, rel), 'utf8');
}

// Real surfaces the skill may teach. Keep in sync with
// sdk/cloud/scripts/gen-pkf-writing-skill.ts (runtime memory tools:
// sdk/prismer/src/adapters/memory-tools.ts; cloud CLI: sdk/cloud/src/commands/pkf.ts).
const KNOWN_COMMANDS = [
  'pkf_mint_sids',
  'pkf_validate',
  'pkf_outline',
  'pkf_search',
  'pkf_read',
  'pkf_bundle_commit',
  'pkf_svg_check',
  'pkf_reply_inline',
  'cloud pkf validate',
  'cloud pkf inspect',
  'cloud pkf patch',
  'cloud pkf diff',
  'cloud pkf pack-harness',
  'cloud pkf project',
  'cloud pkf render',
];

// ── Shared gates (positive path uses them on the artifact; negative control
//    feeds them tampered content and expects the same throw). ────────────────

function gateLineBudget(content: string): void {
  // 2026-09-08 pkf-writing 全文评审门波：行预算 240→260（generator 自审预算
  // 同步上调，SKILL.md 现为 258 行）。
  expect(content.split('\n').length).toBeLessThan(260);
}

function gateSingleFileContract(content: string): void {
  // the references/ directory must not exist and must never be imported
  expect(existsSync(join(SKILL_DIR, 'references'))).toBe(false);
  expect(content).not.toMatch(/references\//);
}

function gateCommandMatrix(content: string): void {
  const backticked = [...content.matchAll(/`([a-z_][a-z0-9_ -]+)`/g)].map((m) => m[1]!.trim());
  for (const token of backticked) {
    if (/^cloud pkf|^pkf_/.test(token) && !KNOWN_COMMANDS.includes(token)) {
      expect(KNOWN_COMMANDS, `unknown command taught: ${token}`).toContain(token);
    }
  }
}

function gateNoUnsafeTeaching(content: string): void {
  expect(content).not.toMatch(/prismer:\/\/asset\/[a-z0-9]+\b/);
  // no POSITIVE base64/data-URI teaching (a negation clause like
  // "No base64 assets" is the correct instruction, not a violation)
  expect(content).not.toMatch(/use base64|as base64|data:image|data:application/);
  expect(content).not.toMatch(/<script src="https?:/);
  expect(content).not.toMatch(/src="https?:/);
}

function gateDiagramElement(content: string): void {
  // Simple diagrams stay mermaid-driven — the skill MUST teach
  // <prismer-diagram>. PKF v1.2 CONTROLLED prismer-svg is activated
  // (pkf209 D19, 2026-08-18) and routed via pkf_svg_check, but the raw
  // authoring TAG stays in the pkf-svg skill — pkf-writing teaches the
  // element by name only (backticked, without angle brackets).
  expect(content).toMatch(/<prismer-diagram/);
  expect(content).not.toMatch(/<prismer-svg/);
}

/** pkf209/07 §5 — v1.2 activated routing: controlled svg for topology only. */
function gateControlledSvgRouting(content: string): void {
  expect(content).toMatch(/v1\.2.*CONTROLLED.*prismer-svg/is);
  expect(content).toMatch(/`pkf_svg_check/);
  expect(content).toMatch(/topology/i);
  // the stale pre-v1.2 claim ("no raw prismer-svg production element") is drift
  expect(content).not.toMatch(/no raw `prismer-svg` PKF\s+production element/is);
  expect(content).not.toMatch(/Never invent SVG authoring/i);
}

function gateFrontmatter(content: string): void {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? '';
  expect(fm).toMatch(/\.pkf/);
  expect(fm).toMatch(/create|author|update|convert|validate/i);
  // memory-graph decisions belong to `memory` — pkf-writing must ROUTE them
  // away explicitly, never claim them
  expect(fm).toMatch(/NOT for recall/i);
  expect(fm).toMatch(/`memory` skill/i);
  expect(fm).not.toMatch(/^description:.*\bfor recall\b.*$/i);
}

function gateCarrierContract(content: string): void {
  expect(content).toMatch(/message inline/i);
  expect(content).toMatch(/Library .*\.pkf.*Asset/is);
  expect(content).toMatch(/Memory Page/i);
  for (const word of ['authority', 'validation', 'persist', 'readback', 'Markdown projection']) {
    expect(content).toMatch(new RegExp(word, 'i'));
  }
  // pkf209 — inline delivery is taught through the native tool (path-only);
  // the sentinel wire literals appear exactly once as the LEGACY note.
  expect(content).toMatch(/### Message-inline delivery \(pkf_reply_inline\)/);
  expect(content).toMatch(/call `pkf_reply_inline\(/);
  expect(content).toMatch(/Never paste sentinel comments into the reply/);
  expect(content).toMatch(/never attach the \.pkf as a\s+file/);
  const start = '<!-- prismer-pkf:inline:start -->';
  const end = '<!-- prismer-pkf:inline:end -->';
  expect(content.split(start)).toHaveLength(2);
  expect(content.split(end)).toHaveLength(2);
  expect(content.indexOf(start)).toBeLessThan(content.indexOf(end));
  expect(content).toMatch(/Runtime.*extract.*between.*sentinel/is);
}

function gateVisualDelegation(content: string): void {
  expect(content).toMatch(/(?:load|use).*`pkf-svg`/i);
  expect(content).toMatch(/(?:unavailable|not loaded|missing).*fallback/is);
  expect(content).toMatch(/Mermaid/);
  expect(content).toMatch(/d3/i);
  expect(content).not.toMatch(/viewBox|foreignObject|0\.5px|bounded context/i);
}

function gateLogicalBundleContract(content: string): void {
  expect(content).toMatch(/`pkf_bundle_commit`/);
  expect(content).toMatch(/(?:one|single).*(?:atomic|logical bundle).*(?:root).*(?:all|every).*(?:dependenc|resource)/is);
  expect(content).toMatch(/stable idempotency/i);
  expect(content).toMatch(/readback.*(?:root|receipt).*(?:resource|dependency).*(?:graph|relation)/is);
  expect(content).toMatch(/never.*(?:upload|persist).*(?:JS|CSS|media|CSV|dependenc).*(?:separately|individually)/is);
  expect(content).toMatch(/never.*prose.*(?:relation|associat|attach)/is);
  // pkf209/07 §4a — hash sinking is a Runtime responsibility: the skill teaches
  // content-only input and bundle-relative paths, never model-side hashing.
  expect(content).toMatch(/Runtime\s+normalizer computes every SHA-256 content hash, SRI and source hash/);
  expect(content).toMatch(/supply content \(`bytesBase64` or\s+`text`\), paths, mime and usage only/);
  expect(content).toMatch(/Do not\s+compute or hand-type hashes yourself/i);
  expect(content).toMatch(/(?:do not|never).*(?:pass|supply).*(?:actor|workspace).*(?:argument|parameter)/is);
}

/** pkf209/07 §4b — widgets first, harness only for genuinely custom JS. */
function gateWidgetContract(content: string): void {
  expect(content).toMatch(/<prismer-widget type="tabs"/);
  expect(content).toMatch(/<prismer-widget type="checklist"/);
  expect(content).toMatch(/zero JS and zero iframe/);
  expect(content).toMatch(/custom JS is genuinely required/);
}

/** A valid PKF shell is not enough for substantive reports. */
function gateReportQualityFloor(content: string): void {
  expect(content).toMatch(/## Report quality floor/);
  expect(content).toMatch(/valid PKF.*unacceptable deliverable/is);
  expect(content).toMatch(/Before `pkf_reply_inline`/);
  expect(content).toMatch(/architecture reviews|research memos|playbooks/i);
  expect(content).toMatch(/at least two/i);
  expect(content).toMatch(/semantic sections/i);
  expect(content).toMatch(/comparison|risk|ownership|action/i);
  expect(content).toMatch(/<prismer-diagram/);
  expect(content).toMatch(/<prismer-data/);
  expect(content).toMatch(/<prismer-widget/);
  expect(content).toMatch(/CONTROLLED `prismer-svg`/);
  expect(content).toMatch(/caption|alt text/i);
  expect(content).toMatch(/not decoration/i);
  // 2026-09-08 全文评审门 — 逃生门从「一句话解释纯文本」收紧为逐节内容化
  // 理由，document-level excuse 直接判失败（SKILL.md §Visual capabilities）。
  expect(content).toMatch(/zero visuals is a smell/i);
  expect(content).toMatch(/justify per section/i);
  expect(content).toMatch(/document-level excuse fails/i);
}

describe('pkf-writing skill', () => {
  it('ships as a single SKILL.md under the line budget (references/ is gone)', () => {
    const md = read('SKILL.md');
    gateLineBudget(md);
    gateSingleFileContract(md);
  });

  it('description triggers on authoring intents, not on recall/remember', () => {
    gateFrontmatter(read('SKILL.md'));
  });

  it('teaches ONLY shipped commands (no invented surface)', () => {
    const md = read('SKILL.md');
    gateCommandMatrix(md);
    expect(md).toMatch(/function-call tools.*not shell executables/is);
    expect(md).not.toMatch(/pkf_validate\s+--/);
    expect(md).not.toMatch(/cloud pkf (?:checkout|status|normalize)/);
  });

  it('defaults chat articles to inline PKF instead of opportunistic artifacts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/does not explicitly ask[\s\S]*choose Message inline/i);
    expect(md).toMatch(/Do not create[\s\S]*attachment[\s\S]*artifacts folder/i);
  });

  it('never teaches bare URIs, base64 assets or remote scripts', () => {
    gateNoUnsafeTeaching(read('SKILL.md'));
  });

  it('teaches the resolved readback step (never structure-only completion)', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/resolved/);
    expect(md).toMatch(/read back/);
  });

  it('defines message inline, Library Asset, and Memory Page carriers with one extraction sentinel', () => {
    gateCarrierContract(read('SKILL.md'));
  });

  it('delegates visual craft to pkf-svg and teaches an honest unavailable fallback', () => {
    gateVisualDelegation(read('SKILL.md'));
  });

  it('routes v1.2 controlled svg through pkf_svg_check (no stale no-authoring claim)', () => {
    gateControlledSvgRouting(read('SKILL.md'));
  });

  it('requires an atomic logical bundle commit and canonical graph readback for dependency-bearing PKF', () => {
    gateLogicalBundleContract(read('SKILL.md'));
  });

  it('teaches declarative widgets before the JS harness (pkf209/07 §4b)', () => {
    gateWidgetContract(read('SKILL.md'));
  });

  it('requires a report-quality floor before delivery (not just strictOk)', () => {
    gateReportQualityFloor(read('SKILL.md'));
  });

  it('ships verbatim widget examples that PASS the core validator', async () => {
    const md = read('SKILL.md');
    const examples = [...md.matchAll(/<prismer-widget type="[a-z]+">[^<]*<\/prismer-widget>/g)].map((m) => m[0]!);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    const { validatePkf } = await import('@prismer/pkf');
    for (const example of examples) {
      const result = validatePkf(
        `<script type="application/prismer+json">{"type":"note","title":"Example","pkfVersion":"1.1"}</script><section><h2 id="ex" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Example</h2>${example}</section>`,
      );
      expect(result.diagnostics, example).toEqual([]);
      expect(result.structureStatus, example).toBe('pass');
    }
  });

  it('carries the WP1 capability guidance pointing at the canonical examples', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/<prismer-diagram format="mermaid"/);
    expect(md).toMatch(/erDiagram/); // mermaid DSL IS the authoring surface
    expect(md).toMatch(/<prismer-model format="primitives"/);
    expect(md).toMatch(/chart-bar/);
    expect(md).toMatch(/chart-line/);
    expect(md).toMatch(/chart-pie/);
    expect(md).toMatch(/AI text-to-image/);
    expect(md).toMatch(/PKF_EXAMPLE_INLINE_DIAGRAM/);
    expect(md).toMatch(/PKF_EXAMPLE_ER_DIAGRAM/);
    expect(md).toMatch(/PKF_EXAMPLE_CHARTS/);
    expect(md).toMatch(/PKF_EXAMPLE_AI_IMAGE/);
    expect(md).toMatch(/PKF_EXAMPLE_MODEL_3D/);
    expect(md).toMatch(/PKF_EXAMPLE_MERMAID_IMPORT/);
    expect(md).toMatch(/PKF_EXAMPLE_MIXED/);
    expect(md).toMatch(/src\/lib\/pkf\/examples\.ts/);
    // import round-trip note present (same element as authoring)
    expect(md).toMatch(/imported markdown/);
    gateDiagramElement(md);
  });

  it('is installed on coding agents via the common allowlist', async () => {
    const { CODING_COMMON_ALLOWLIST } = await import('../src/adapters/coding/shared/coding-skill-set.js');
    expect(CODING_COMMON_ALLOWLIST.has('pkf-writing')).toBe(true);
  });

  // ── Negative controls: the same gates go red on tampered content ─────────

  it('negative control: over-budget content fails the line-budget gate', () => {
    const overBudget = 'padding line\n'.repeat(265);
    expect(() => gateLineBudget(overBudget)).toThrow();
  });

  it('negative control: an invented command fails the command-matrix gate', () => {
    const invented = 'Run `pkf_teleport` to beam the page into another workspace.';
    expect(() => gateCommandMatrix(invented)).toThrow();
  });

  it('negative control: a references/ import fails the single-file gate', () => {
    const importLine = 'Full syntax: load `references/core-format.md` when the page is huge.';
    expect(() => gateSingleFileContract(importLine)).toThrow();
  });

  it('negative control: teaching a bare asset URI fails the unsafe-teaching gate', () => {
    const bareUri = 'Reference it as <img src="prismer://asset/abc123def456">.';
    expect(() => gateNoUnsafeTeaching(bareUri)).toThrow();
  });

  it('negative control: teaching raw inline SVG fails the diagram gate', () => {
    const svgLine = 'Structure diagram: use `<prismer-svg>` with escaped SVG source.';
    expect(() => gateDiagramElement(svgLine)).toThrow();
  });

  it('negative control: omitting <prismer-diagram> fails the diagram gate', () => {
    const noDiagram = 'Diagrams render themselves — write prose instead.';
    expect(() => gateDiagramElement(noDiagram)).toThrow();
  });

  it('negative control: an incomplete carrier contract fails the carrier gate', () => {
    expect(() => gateCarrierContract('Persist a PKF wherever convenient.')).toThrow();
  });

  it('negative control: sentinel-paste-only delivery (pre-pkf209 style) fails the carrier gate', () => {
    const legacy = [
      'Message inline with authority, validation, persist, readback and Markdown projection.',
      'Library .pkf Asset and Memory Page carriers exist.',
      'Emit <!-- prismer-pkf:inline:start --> then the PKF then <!-- prismer-pkf:inline:end -->.',
      'Runtime must extract only the bytes between the two sentinel comments.',
    ].join(' ');
    expect(() => gateCarrierContract(legacy)).toThrow(/Message-inline delivery/);
  });

  it('negative control: copied SVG grammar fails the delegation gate', () => {
    expect(() =>
      gateVisualDelegation('Load `pkf-svg`; if unavailable fallback to Mermaid or d3. Use a 680 viewBox and 0.5px lines.'),
    ).toThrow();
  });

  it('negative control: the stale pre-v1.2 "no authoring surface" claim fails the routing gate', () => {
    const stale =
      'Load `pkf-svg`; if unavailable fallback to Mermaid or d3. Simple diagrams use <prismer-diagram> and d3 charts. ' +
      'There is no raw `prismer-svg` PKF production element. Never invent SVG authoring.';
    expect(() => gateControlledSvgRouting(stale)).toThrow(/CONTROLLED|pkf_svg_check/);
    const activatedButUnchecked =
      'PKF v1.2 CONTROLLED `prismer-svg` is activated for topology: author it freely, no extra check needed. ' +
      'Simple diagrams use <prismer-diagram> and d3; fallback to Mermaid.';
    expect(() => gateControlledSvgRouting(activatedButUnchecked)).toThrow(/pkf_svg_check/);
  });

  it('negative control: individual uploads plus prose association fail the logical bundle gate', () => {
    expect(() =>
      gateLogicalBundleContract(
        'Upload JS and CSS individually, save the PKF root, then explain their relationship in prose.',
      ),
    ).toThrow();
  });

  it('negative control: teaching model-side hash computation fails the logical bundle gate', () => {
    expect(() =>
      gateLogicalBundleContract(
        '`pkf_bundle_commit` uploads one atomic logical bundle containing the root and all dependencies. ' +
          'Use a stable idempotency key and readback the receipt, root, and resource graph. ' +
          'Never upload JS, CSS, media, CSV, or dependencies separately; never use prose to claim relations. ' +
          'Compute the SHA-256 of every file yourself, hand-type the SRI values, and never pass workspace arguments.',
      ),
    ).toThrow(/supply content|normalizer computes/);
  });

  it('negative control: widget examples missing fails the widget gate', () => {
    expect(() => gateWidgetContract('Use prismer-diagram for everything; harness for the rest.')).toThrow();
  });

  it('negative control: strict-only guidance fails the report-quality gate', () => {
    expect(() =>
      gateReportQualityFloor('Validate with pkf_validate until strictOk, then call pkf_reply_inline.'),
    ).toThrow();
  });

  it('negative control: a widget example that fails the core validator is not shippable', async () => {
    const broken = '<prismer-widget type="tabs">{"tabs":[{"label":"Only one","content":"x"}]}</prismer-widget>';
    const { validatePkf } = await import('@prismer/pkf');
    const result = validatePkf(
      `<script type="application/prismer+json">{"type":"note","title":"Example","pkfVersion":"1.1"}</script><section><h2 id="ex" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Example</h2>${broken}</section>`,
    );
    expect(result.structureStatus).toBe('fail');
    expect(result.diagnostics.map((d) => d.code)).toContain('widget-tabs-count');
  });
});
