/**
 * Generator for the canonical `pkf-svg` skill. `pkf-visual` survives only as
 * metadata.aliases compatibility; the artifact is one SKILL.md.
 *
 *   npx tsx sdk/cloud/scripts/gen-pkf-svg-skill.ts
 *   TAMPER=1 npx tsx sdk/cloud/scripts/gen-pkf-svg-skill.ts
 *
 * Production truth (pkf209 D19 v1.2, activated 2026-08-18): the controlled
 * `prismer-svg` subset may be authored inside PKF source. The frozen validator
 * whitelist is the hard boundary — script/foreignObject/on-handlers/external
 * href/animation/canvas overflow are structure failures, never soft conventions.
 *
 * pkf209/07 §5 Phase 3: the skill also ships a COPYABLE skeleton + fragments
 * (each one passes `validatePkfSvg` INCLUDING the quality floors — enforced at
 * generation time below and re-checked from the written artifact by
 * sdk/prismer/test/pkf-svg-skill.test.ts) and the semantic ramp hex table
 * generated from the package single source (`packages/pkf/src/core/semantic-ramp.ts`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PKF_SEMANTIC_RAMP_LEVELS,
  semanticRampHexTable,
} from '../../../packages/pkf/src/core/semantic-ramp.js';
import { validatePkfSvg } from '../../../packages/pkf/src/core/svg.js';
import type { PkfSvg } from '../../../packages/pkf/src/core/types.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = process.env.PKF_SKILL_CATALOG_ROOT
  ? path.resolve(process.env.PKF_SKILL_CATALOG_ROOT)
  : path.resolve(SCRIPT_DIR, '../catalog/skills');
const RUNTIME_ROOT = process.env.PKF_SKILL_RUNTIME_ROOT
  ? path.resolve(process.env.PKF_SKILL_RUNTIME_ROOT)
  : path.resolve(SCRIPT_DIR, '../../prismer/built-in-skills');
const TARGETS = [
  path.join(CATALOG_ROOT, 'pkf-svg', 'SKILL.md'),
  path.join(RUNTIME_ROOT, 'pkf-svg', 'SKILL.md'),
];
const TAMPER = process.env.TAMPER === '1';

// ── Copyable artifacts (pkf209/07 §5) ────────────────────────────────────────
//
// Every markup block below must pass validatePkfSvg VERBATIM — the
// generation-time gate refuses to write otherwise. Values use the package
// semantic ramp directly (hex, never CSS variables: the whitelist carries no
// var() surface).

const SKELETON_680 = `<svg viewBox="0 0 680 480" role="img" aria-label="Skeleton: two clusters with one orthogonal edge">
<title>Skeleton: two clusters, one orthogonal edge</title>
<desc>Copyable 680x480 skeleton in three layers: backdrop (neutral canvas plus figure title), edges (orthogonal connectors), nodes (clusters, node rects, labels). Replace labels, coordinates and ramp colors.</desc>
<g id="sk-backdrop">
<rect x="0" y="0" width="680" height="480" rx="12" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"></rect>
<text x="40" y="32" font-size="13" font-weight="500" fill="#2C2C2A">Figure title — replace</text>
</g>
<g id="sk-edges">
<line x1="248" y1="170" x2="432" y2="170" stroke="#5F5E5A" stroke-width="0.5"></line>
<circle cx="248" cy="170" r="2.5" fill="#5F5E5A"></circle>
<circle cx="432" cy="170" r="2.5" fill="#5F5E5A"></circle>
<text x="340" y="158" font-size="11" fill="#444441" text-anchor="middle">relates</text>
</g>
<g id="sk-nodes">
<rect x="40" y="72" width="208" height="196" rx="10" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="56" y="94" font-size="12" font-weight="500" fill="#0C447C">Cluster A · blue · system</text>
<rect x="56" y="106" width="176" height="34" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="64" y="127" font-size="12" fill="#0C447C">Node label one</text>
<rect x="56" y="152" width="176" height="34" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="64" y="173" font-size="12" fill="#0C447C">Node label two</text>
<rect x="432" y="72" width="208" height="196" rx="10" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="448" y="94" font-size="12" font-weight="500" fill="#085041">Cluster B · teal · ready</text>
<rect x="448" y="106" width="176" height="34" rx="6" fill="#FFFFFF" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="456" y="127" font-size="12" fill="#085041">Node label one</text>
<rect x="448" y="152" width="176" height="34" rx="6" fill="#FFFFFF" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="456" y="173" font-size="12" fill="#085041">Node label two</text>
</g>
<text x="40" y="452" font-size="11" fill="#444441">Fallback caption — describe the same relationships in words.</text>
</svg>`;

const FRAGMENT_CLUSTER = `<svg viewBox="0 0 240 150" role="img" aria-label="Cluster frame fragment">
<title>Cluster frame fragment</title>
<desc>One bounded-context frame with a title row and one node slot.</desc>
<rect x="0" y="0" width="240" height="150" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="24" width="160" height="96" rx="10" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="44" font-size="12" font-weight="500" fill="#0C447C">Cluster · context</text>
<rect x="52" y="56" width="136" height="30" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="60" y="76" font-size="12" fill="#0C447C">Node label</text>
</svg>`;

const FRAGMENT_NODE = `<svg viewBox="0 0 240 150" role="img" aria-label="Node and status fragment">
<title>Node and status fragment</title>
<desc>One node rect plus a status chip from a second ramp family.</desc>
<rect x="0" y="0" width="240" height="150" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="28" width="136" height="34" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="49" font-size="12" fill="#0C447C">Node label</text>
<rect x="40" y="72" width="136" height="22" rx="5" fill="#FAEEDA" stroke="#854F0B" stroke-width="0.5"></rect>
<text x="52" y="87" font-size="11" font-weight="500" fill="#633806">attention note</text>
</svg>`;

const FRAGMENT_EDGE = `<svg viewBox="0 0 300 120" role="img" aria-label="Orthogonal edge fragment">
<title>Orthogonal edge fragment</title>
<desc>Two nodes joined by an orthogonal polyline with endpoint dots and a label.</desc>
<rect x="0" y="0" width="300" height="120" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="40" width="80" height="36" rx="6" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="62" font-size="12" fill="#0C447C">source</text>
<polyline points="120,58 160,58 160,80 204,80" fill="none" stroke="#5F5E5A" stroke-width="0.5"></polyline>
<rect x="204" y="62" width="80" height="36" rx="6" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="216" y="84" font-size="12" fill="#085041">target</text>
<text x="160" y="48" font-size="11" fill="#444441" text-anchor="middle">relates</text>
</svg>`;

const FRAGMENTS: Array<[string, string]> = [
  ['cluster', FRAGMENT_CLUSTER],
  ['node', FRAGMENT_NODE],
  ['edge', FRAGMENT_EDGE],
];

/** Markdown table of the 9×7 ramp, generated from the package single source. */
function rampTableLines(): string[] {
  const header = `| family | ${PKF_SEMANTIC_RAMP_LEVELS.join(' | ')} |`;
  const rule = `| --- | ${PKF_SEMANTIC_RAMP_LEVELS.map(() => '---').join(' | ')} |`;
  const rows = semanticRampHexTable().map(({ family, hexes }) => `| ${family} | ${hexes.join(' | ')} |`);
  return [header, rule, ...rows];
}

const TEMPLATE_LINES: string[] = [
  '---',
  'name: pkf-svg',
  'scope: common',
  "description: 'Design controlled SVG, visual widgets, topology and Visual Core explainers with semantic color, safe geometry, accessibility, and bounded complexity. Use for an explicitly supported SVG/widget surface or to plan PKF visuals. PKF v1.1 has no production inline-SVG authoring surface (diagrams are Mermaid, data charts are d3); v1.2 controlled prismer-svg (pkf209 D19) is activated for PKF source authoring within the frozen validator whitelist.'",
  'metadata:',
  '  nativeReplaces: [architecture-diagram]',
  '  aliases:',
  '    - pkf-visual',
  '---',
  '',
  '# pkf-svg',
  '',
  'Visual discipline for controlled SVG, widgets, architecture/topology maps,',
  'and Visual Core experiments. It owns composition, semantic color, geometry,',
  'safety, and a11y — not PKF persistence or memory placement.',
  '',
  '## Production boundary (tell the truth)',
  '',
  '- PKF v1.1 keeps no `prismer-svg` production authoring element: SVG travels as',
  '  a reviewed static asset or a trusted host surface only.',
  '- PKF v1.2 CONTROLLED `prismer-svg` (docs/pkf209 03 D19) is ACTIVATED',
  '  (2026-08-18): it may be authored inside PKF source. The production reader',
  '  validates against the frozen whitelist — script, foreignObject, on*,',
  '  external href, animation and canvas overflow are hard structure failures',
  '  (stable `svg-*` codes), not soft conventions. Never author free/raw SVG in',
  '  any version.',
  '- In PKF, author diagrams with `<prismer-diagram format="mermaid">`; use',
  '  Mermaid `erDiagram|flowchart|sequenceDiagram|xychart-beta` as appropriate.',
  '- Author data charts with `prismer-data` views',
  '  `chart-bar|chart-line|chart-pie`; the production reader renders them with d3.',
  '- Mermaid renders classic today. D19 proposes host-only `handDrawn|neo`',
  '  top-right menu toggles; the workspace host (DiagramView) ships this',
  '  radiogroup — keyboard reachable, persisted per workspace, source never',
  '  carries look. Other hosts may not offer the toggle, so do not rely on',
  '  non-classic look.',
  '- Mermaid actor/entity/class colors SHOULD use the semantic ramps below.',
  '  Implemented status (D19 §7): the workspace reader\'s `resolveMermaidTheme`',
  '  consumes this exact 9×7 table for themeVariables by diagram family —',
  '  sequence actor = blue (system), sequence alt/opt branch frame + activation',
  '  = amber (attention/reversible), note/signal = gray (annotation), erDiagram',
  '  entity = teal (approved), classDiagram box = purple (control), flowchart',
  '  nodes = blue (system). Honest limits: flowchart decision diamonds share',
  '  node colors (mermaid has no diamond-specific themeVariables), and mermaid',
  '  11.x does not consume `attributeBackgroundColorOdd/Even` for erDiagram',
  '  attribute rows. Unknown diagram types keep the accent palette fallback.',
  '- Apply the SVG rules below for any trusted SVG/widget surface, and for',
  '  `prismer-svg` authored in PKF source (v1.2 activated). Otherwise use Mermaid,',
  '  d3, semantic HTML/prose, or a reviewed static asset.',
  '',
  '## Scenario routing',
  '',
  '- ERD/database schema → Mermaid `erDiagram`, never hand-drawn.',
  '- Sequential process/decision tree → Mermaid `flowchart`; ≤5 flow nodes.',
  '- Statistical data → d3 chart view; tables → markdown table, not a figure.',
  '- Controlled SVG/widget → structural, illustrative, or multi-cluster topology',
  '  only when Mermaid/data surfaces cannot express the intended hierarchy.',
  '- Loops/cycles → stepper with an explicit wrap-back cue, never a decorative ring.',
  '',
  '## Quality floor: 680×480 topology reference',
  '',
  '- Use a 680×480 reference canvas for dense topology; preserve the safe area',
  '  x=40..640 and keep the bottom-most element at least 20px above the edge.',
  '- Build at least 3 information layers: figure → container → node or status.',
  '  Containers express bounded contexts; nodes express actors/services/resources;',
  '  status annotations never compete with the primary topology.',
  '- Provide accessible `<title>` and `<desc>` in any trusted SVG surface, plus',
  '  visible labels. Accessibility text must explain the same relationships.',
  '- Use 0.5px default strokes, boundary-anchored connectors, symmetric padding,',
  '  and named geometry constants. Nothing clips or floats outside its owner.',
  '- Maintain stable density: consistent node heights, spacing rhythm, label',
  '  lengths, and connector clearance across peer clusters.',
  '',
  '## Validator quality floors (stable svg-* rejections)',
  '',
  'The frozen whitelist audit also rejects objectively unreadable figures:',
  'svg-too-sparse (<3 visible shapes), svg-monochrome (<2 distinct shape fills,',
  'backdrop excluded), svg-contrast (text vs container below the 3.0 WCAG',
  'large-text floor), svg-text-overflow (label width outside x∈[40, width-40]),',
  'svg-stroke-floor (authored stroke-width <0.5), svg-unlabeled (zero visible',
  'labels). Each message names the element to fix — repair, never argue.',
  '',
  '## Copy-first authoring loop',
  '',
  '```text',
  '1. copy the skeleton below into ONE `prismer-svg` element (wrapper carries',
  '   width/height/viewBox; the markup inside is the <svg> block)',
  '2. replace labels, coordinates and colors — ramp hexes from the table only',
  '3. run `pkf_svg_check({"svg":"<complete svg markup>"})` and fix every svg-*',
  '   error (one round: each diagnostic names the element/attribute to change)',
  '4. only then `pkf_validate` the complete PKF and persist',
  '```',
  '',
  '`pkf_svg_check` is a pure local tool: write → check → fix without spending a',
  'persist round. If the runtime does not offer it, fall back to `pkf_validate`',
  'on the whole document.',
  '',
  '## Skeleton — 680×480, three layers (copy verbatim)',
  '',
  '```svg',
  ...SKELETON_680.split('\n'),
  '```',
  '',
  'Layer contract: `sk-backdrop` (neutral canvas + figure title), `sk-edges`',
  '(orthogonal connectors between clusters), `sk-nodes` (cluster frames, node',
  'rects, labels). Safe area x=40..640; bottom-most element ≥20px above y=480.',
  '',
  '## Fragments — cluster / node / orthogonal edge',
  '',
  'Each fragment is standalone-valid; copy the inner layer you need into the',
  'skeleton and re-check with `pkf_svg_check` after editing.',
  '',
  '```svg',
  ...FRAGMENT_CLUSTER.split('\n'),
  '```',
  '',
  '```svg',
  ...FRAGMENT_NODE.split('\n'),
  '```',
  '',
  '```svg',
  ...FRAGMENT_EDGE.split('\n'),
  '```',
  '',
  '## Semantic ramp hex table (host tokens — hex only, never CSS variables)',
  '',
  ...rampTableLines(),
  '',
  'Light mode = 50 fill + 600 stroke + 800 title; dark = 800 fill + 200 stroke',
  '+ 100 title (same table, different usage). The svg-monochrome floor requires',
  '≥2 distinct families among shape fills.',
  '',
  '## Coordinate grid reference',
  '',
  '- x columns at 60px rhythm: 40, 100, 160, 220, 280, 340, 400, 460, 520, 580,',
  '  640 — labels start at a column, nodes span 3 columns (176px at 56px inset).',
  '- y bands: figure title 32, cluster title 94, node rows 127 / 173 (34px tall,',
  '  46px pitch), legend 316..346, fallback caption 378..394, bottom ≥460.',
  '',
  '## Semantic color and complexity',
  '',
  '- Palette ramps: purple/teal/coral/pink/gray/blue/green/amber/red; use host',
  '  tokens, never improvised hex values. Shape/size/color changes encode meaning.',
  '- Stable defaults: blue = system/deployment, teal = approved/ready/success,',
  '  purple = control/rollback, amber = attention/reversible action, and red =',
  '  risk/blocker only. Use gray for annotation, never to weaken a main branch.',
  '- Dark surfaces preserve depth: map light 50 → dark 800 and light 100 →',
  '  dark 900; keep text/connector contrast explicit instead of auto-inverting.',
  '- Ordinary figure default: ≤2 ramps per figure.',
  '- Complex topology/architecture exception: group by bounded context and use',
  '  up to 4 domain ramps, plus 1 reserved status/risk ramp. Each visual group',
  '  remains ≤2 ramps. Color must express category or status and carry a text cue;',
  '  color alone is never the only signal.',
  '- A figure containing two small flows keeps each of the two small flows ≤2',
  '  ramps; do not borrow the topology exception for decorative variety.',
  '- ≤4 boxes per horizontal tier, ≤5 nodes per simple flow, nesting ≤3,',
  '  subtitles ≤5 words, and ≥60px between flow boxes.',
  '',
  '## Typography and composition',
  '',
  '- Weights 400/500 only; minimum 11px; sentence case; no emoji as iconography.',
  '- One reading direction and one focal story. Use primary/secondary/annotation',
  '  rhythm; do not distribute motifs merely to fill the canvas.',
  '- Labels remain inside their owning container and outside the object they name.',
  '- Legends reuse rendered token colors and pair every swatch with a label.',
  '',
  '## Safety and accessibility gate',
  '',
  '- The host allowlist is authoritative. Never emit `script`, `foreignObject`,',
  '  event handler (`on*`), external URL/reference, remote CSS/font, animation,',
  '  iframe, image, or untrusted `use` content.',
  '- v1.2 wire: the frozen validator whitelist (elements {svg,g,rect,circle,',
  '  ellipse,line,path,polyline,polygon,text,tspan,title,desc}, geometry/paint/',
  '  text attributes, budgets 512 elements / 2048 attributes / viewBox ≤4096) is',
  '  enforced by the production reader — author inside it, never around it.',
  '- Internal fragment IDs must be unique and namespaced; references stay local.',
  '- Every connector has a visible endpoint and a textual relationship cue.',
  '- On rejection or unsupported surfaces, fail closed to source/prose/static',
  '  fallback; never claim a sanitized or dropped figure was persisted.',
  '',
  '## Self-check',
  '',
  '- Correct surface and scenario? v1.2 controlled prismer-svg stays inside the',
  '  frozen whitelist — script/foreignObject/on*/external refs/animations absent,',
  '  title+desc present, ids unique — and is never free/raw?',
  '- Copied the skeleton, kept three information layers, 680 safe area,',
  '  title+desc, 0.5px, stable density — and `pkf_svg_check` is green?',
  '- Ordinary ≤2 ramps, or a justified bounded-context exception within caps?',
  '- Color has semantic meaning plus a text cue; each visual group remains ≤2?',
  '- One reading direction, boundary anchors, no clipping, stable peer rhythm?',
  '- Unsafe tags/attributes/external references absent; fallback remains readable?',
  '',
  '## Architecture diagram resource pack',
  '',
  'Read [the architecture method](references/architecture-diagram/GUIDE.md) and adapt [its standalone HTML template](references/architecture-diagram/templates/template.html) for explicit architecture artifact requests. Preserve semantic boundaries, readable labels and legends outside all system boundaries. This HTML asset is not inline PKF: for PKF, use the native whitelist and geometry above, not HTML/defs/markers. Choose light/dark according to the existing project, use local fonts, and verify every connection and boundary before delivery.',
];

/** Generation-time gate: every shipped svg artifact passes its own validator. */
function validateFragmentGate(errors: string[], name: string, markup: string): void {
  const parsed: PkfSvg = {
    width: null,
    height: null,
    viewBox: null,
    svg: markup,
    raw: markup,
    sourceSection: null,
  };
  for (const issue of validatePkfSvg(parsed)) {
    errors.push(`artifact "${name}" fails its own validator: ${issue.code}: ${issue.message}`);
  }
}

function audit(md: string, errors: string[]): void {
  const lines = md.split('\n');
  if (lines.length >= 320) errors.push(`line budget: ${lines.length} (must be < 320)`);
  if (!/^name:\s*pkf-svg$/m.test(md) || !/aliases:\s*\n\s*-\s*pkf-visual/m.test(md)) {
    errors.push('identity: canonical pkf-svg must retain pkf-visual alias');
  }
  if (!/PKF v1\.1.*no .*production.*authoring/is.test(md) || !/Mermaid/.test(md) || !/d3/i.test(md)) {
    errors.push('production truth: PKF v1.1 must remain Mermaid/d3 with no SVG authoring');
  }
  if (!/v1\.2.*ACTIVATED|ACTIVATED.*v1\.2|v1\.2.*已激活/is.test(md)) {
    errors.push('production truth: v1.2 controlled prismer-svg must be marked ACTIVATED (2026-08-18)');
  }
  if (!/frozen whitelist|whitelist.*frozen|冻结.*白名单/i.test(md)) {
    errors.push('production truth: the frozen validator whitelist must be taught as the hard boundary');
  }
  if (!/hard structure failures|structure fail/i.test(md) || !/svg-\*/i.test(md)) {
    errors.push('production truth: whitelist violations must be taught as hard structure failures with stable svg-* codes');
  }
  if (/owner-gated|owner gate|SS-14 ratification|capability advertisement/i.test(md)) {
    errors.push('production truth: stale owner-gate language must be removed');
  }
  if (!/never author free\/raw|never.*free\/raw SVG|never.*raw SVG/i.test(md)) {
    errors.push('production truth: free/raw SVG authoring must remain forbidden');
  }
  if (/<prismer-svg/.test(md)) errors.push('production truth: raw PKF SVG tag taught');
  // pkf209/07 §5 — copy-first artifacts + check loop.
  if (!/```svg/.test(md)) errors.push('skeleton: no copyable svg fence shipped');
  if (!/sk-backdrop/.test(md) || !/sk-edges/.test(md) || !/sk-nodes/.test(md)) {
    errors.push('skeleton: the three-layer skeleton must be present');
  }
  if (!/copy the skeleton/i.test(md) || !/`pkf_svg_check`/.test(md)) {
    errors.push('authoring loop: copy-skeleton → pkf_svg_check must be taught');
  }
  if (!/svg-too-sparse/.test(md) || !/svg-monochrome/.test(md) || !/svg-contrast/.test(md)) {
    errors.push('quality floors: the stable rejection codes must be taught');
  }
  if (!semanticRampHexTable().every(({ hexes }) => hexes.every((hex) => md.includes(hex)))) {
    errors.push('ramp table: every family must ship its generated hexes');
  }
  for (const required of [
    /680×480/,
    /x=40\.\.640/,
    /figure.*container.*node or status/is,
    /<title>.*<desc>/is,
    /0\.5px/,
    /stable density/i,
    /ordinary figure default: ≤2/i,
    /bounded context/i,
    /up to 4 domain ramps/i,
    /1 reserved status\/risk ramp/i,
    /Each visual group.*≤2/is,
    /text cue/i,
    /two small flows/i,
    /blue.*system.*deployment/is,
    /teal.*approved.*ready.*success/is,
    /purple.*control.*rollback/is,
    /amber.*attention.*reversible/is,
    /red.*risk/is,
    /50.*800.*100.*900/is,
  ]) {
    if (!required.test(md)) errors.push(`quality floor missing: ${required}`);
  }
  if (!/chart-bar\|chart-line\|chart-pie/.test(md) || /\bc-line\b|\bc-pie\b/.test(md)) {
    errors.push('chart views: must use the exact production enum');
  }
  if (!/script/.test(md) || !/foreignObject/.test(md) || !/event handler/.test(md) || !/external URL/.test(md)) {
    errors.push('safety: forbidden SVG capabilities must be explicit');
  }
  if (!/512 elements.*2048 attributes.*4096/is.test(md)) {
    errors.push('v1.2 wire: the frozen budgets (512/2048/4096) must be explicit');
  }
  // Keep inline PKF authoring self-contained; only the separate architecture
  // artifact pack may be linked. Unknown reference imports still fail closed.
  const allowed = new Set([
    'references/architecture-diagram/GUIDE.md',
    'references/architecture-diagram/templates/template.html',
  ]);
  for (const match of md.matchAll(/references\/[\w./-]+/g)) {
    if (!allowed.has(match[0])) errors.push(`unknown reference import: ${match[0]}`);
  }
  if (!md.includes('nativeReplaces: [architecture-diagram]') || !md.includes('references/architecture-diagram/GUIDE.md')) {
    errors.push('architecture merge: replacement metadata and guide link are required');
  }
}

function tamper(lines: string[]): void {
  const anchor = lines.findIndex((line) => line === '## Self-check');
  lines.splice(anchor, 0, '- In PKF use `<prismer-svg>` and as many colors as needed.');
  lines.splice(anchor, 0, '- Full syntax lives in `references/svg-format.md`.');
  lines.push(...Array(160).fill('# padding beyond the line budget'));
}

let skeleton = SKELETON_680;
if (TAMPER) {
  // Corrupt the shipped skeleton so the generation-time validator gate fires.
  skeleton = skeleton.replace('stroke-width="0.5"', 'stroke-width="0.2"');
  tamper(TEMPLATE_LINES);
}

// The template embeds the ORIGINAL constants verbatim; a tampered run swaps
// the skeleton in-place so both the md audit and the validator gate see it.
const finalLines = TAMPER
  ? TEMPLATE_LINES.join('\n').replace(SKELETON_680, skeleton).split('\n')
  : TEMPLATE_LINES;
const md = `${finalLines.join('\n')}\n`;

const errors: string[] = [];
audit(md, errors);
validateFragmentGate(errors, 'skeleton-680', skeleton);
for (const [name, markup] of FRAGMENTS) validateFragmentGate(errors, `fragment-${name}`, markup);

if (errors.length > 0) {
  console.error('[gen-pkf-svg-skill] ❌ refusing to write — gates red:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

for (const target of TARGETS) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, md, 'utf8');
}
console.log(
  `[gen-pkf-svg-skill] ✅ wrote ${TARGETS.map((target) => path.relative(path.resolve(SCRIPT_DIR, '../..'), target)).join(' + ')} (${finalLines.length} lines)`,
);
