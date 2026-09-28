---
name: pkf-svg
scope: common
description: 'Design controlled SVG, visual widgets, topology and Visual Core explainers with semantic color, safe geometry, accessibility, and bounded complexity. Use for an explicitly supported SVG/widget surface or to plan PKF visuals. PKF v1.1 has no production inline-SVG authoring surface (diagrams are Mermaid, data charts are d3); v1.2 controlled prismer-svg (pkf209 D19) is activated for PKF source authoring within the frozen validator whitelist.'
metadata:
  nativeReplaces: [architecture-diagram]
  aliases:
    - pkf-visual
---

# pkf-svg

Visual discipline for controlled SVG, widgets, architecture/topology maps,
and Visual Core experiments. It owns composition, semantic color, geometry,
safety, and a11y — not PKF persistence or memory placement.

## Production boundary (tell the truth)

- PKF v1.1 keeps no `prismer-svg` production authoring element: SVG travels as
  a reviewed static asset or a trusted host surface only.
- PKF v1.2 CONTROLLED `prismer-svg` (docs/pkf209 03 D19) is ACTIVATED
  (2026-08-18): it may be authored inside PKF source. The production reader
  validates against the frozen whitelist — script, foreignObject, on*,
  external href, animation and canvas overflow are hard structure failures
  (stable `svg-*` codes), not soft conventions. Never author free/raw SVG in
  any version.
- In PKF, author diagrams with `<prismer-diagram format="mermaid">`; use
  Mermaid `erDiagram|flowchart|sequenceDiagram|xychart-beta` as appropriate.
- Author data charts with `prismer-data` views
  `chart-bar|chart-line|chart-pie`; the production reader renders them with d3.
- Mermaid renders classic today. D19 proposes host-only `handDrawn|neo`
  top-right menu toggles; the workspace host (DiagramView) ships this
  radiogroup — keyboard reachable, persisted per workspace, source never
  carries look. Other hosts may not offer the toggle, so do not rely on
  non-classic look.
- Mermaid actor/entity/class colors SHOULD use the semantic ramps below.
  Implemented status (D19 §7): the workspace reader's `resolveMermaidTheme`
  consumes this exact 9×7 table for themeVariables by diagram family —
  sequence actor = blue (system), sequence alt/opt branch frame + activation
  = amber (attention/reversible), note/signal = gray (annotation), erDiagram
  entity = teal (approved), classDiagram box = purple (control), flowchart
  nodes = blue (system). Honest limits: flowchart decision diamonds share
  node colors (mermaid has no diamond-specific themeVariables), and mermaid
  11.x does not consume `attributeBackgroundColorOdd/Even` for erDiagram
  attribute rows. Unknown diagram types keep the accent palette fallback.
- Apply the SVG rules below for any trusted SVG/widget surface, and for
  `prismer-svg` authored in PKF source (v1.2 activated). Otherwise use Mermaid,
  d3, semantic HTML/prose, or a reviewed static asset.

## Scenario routing

- ERD/database schema → Mermaid `erDiagram`, never hand-drawn.
- Sequential process/decision tree → Mermaid `flowchart`; ≤5 flow nodes.
- Statistical data → d3 chart view; tables → markdown table, not a figure.
- Controlled SVG/widget → structural, illustrative, or multi-cluster topology
  only when Mermaid/data surfaces cannot express the intended hierarchy.
- Loops/cycles → stepper with an explicit wrap-back cue, never a decorative ring.

## Quality floor: 680×480 topology reference

- Use a 680×480 reference canvas for dense topology; preserve the safe area
  x=40..640 and keep the bottom-most element at least 20px above the edge.
- Build at least 3 information layers: figure → container → node or status.
  Containers express bounded contexts; nodes express actors/services/resources;
  status annotations never compete with the primary topology.
- Provide accessible `<title>` and `<desc>` in any trusted SVG surface, plus
  visible labels. Accessibility text must explain the same relationships.
- Use 0.5px default strokes, boundary-anchored connectors, symmetric padding,
  and named geometry constants. Nothing clips or floats outside its owner.
- Maintain stable density: consistent node heights, spacing rhythm, label
  lengths, and connector clearance across peer clusters.

## Validator quality floors (stable svg-* rejections)

The frozen whitelist audit also rejects objectively unreadable figures:
svg-too-sparse (<3 visible shapes), svg-monochrome (<2 distinct shape fills,
backdrop excluded), svg-contrast (text vs container below the 3.0 WCAG
large-text floor), svg-text-overflow (label width outside x∈[40, width-40]),
svg-stroke-floor (authored stroke-width <0.5), svg-unlabeled (zero visible
labels). Each message names the element to fix — repair, never argue.

## Copy-first authoring loop

```text
1. copy the skeleton below into ONE `prismer-svg` element (wrapper carries
   width/height/viewBox; the markup inside is the <svg> block)
2. replace labels, coordinates and colors — ramp hexes from the table only
3. run `pkf_svg_check({"svg":"<complete svg markup>"})` and fix every svg-*
   error (one round: each diagnostic names the element/attribute to change)
4. only then `pkf_validate` the complete PKF and persist
```

`pkf_svg_check` is a pure local tool: write → check → fix without spending a
persist round. If the runtime does not offer it, fall back to `pkf_validate`
on the whole document.

## Skeleton — 680×480, three layers (copy verbatim)

```svg
<svg viewBox="0 0 680 480" role="img" aria-label="Skeleton: two clusters with one orthogonal edge">
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
</svg>
```

Layer contract: `sk-backdrop` (neutral canvas + figure title), `sk-edges`
(orthogonal connectors between clusters), `sk-nodes` (cluster frames, node
rects, labels). Safe area x=40..640; bottom-most element ≥20px above y=480.

## Fragments — cluster / node / orthogonal edge

Each fragment is standalone-valid; copy the inner layer you need into the
skeleton and re-check with `pkf_svg_check` after editing.

```svg
<svg viewBox="0 0 240 150" role="img" aria-label="Cluster frame fragment">
<title>Cluster frame fragment</title>
<desc>One bounded-context frame with a title row and one node slot.</desc>
<rect x="0" y="0" width="240" height="150" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="24" width="160" height="96" rx="10" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="44" font-size="12" font-weight="500" fill="#0C447C">Cluster · context</text>
<rect x="52" y="56" width="136" height="30" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="60" y="76" font-size="12" fill="#0C447C">Node label</text>
</svg>
```

```svg
<svg viewBox="0 0 240 150" role="img" aria-label="Node and status fragment">
<title>Node and status fragment</title>
<desc>One node rect plus a status chip from a second ramp family.</desc>
<rect x="0" y="0" width="240" height="150" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="28" width="136" height="34" rx="6" fill="#FFFFFF" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="49" font-size="12" fill="#0C447C">Node label</text>
<rect x="40" y="72" width="136" height="22" rx="5" fill="#FAEEDA" stroke="#854F0B" stroke-width="0.5"></rect>
<text x="52" y="87" font-size="11" font-weight="500" fill="#633806">attention note</text>
</svg>
```

```svg
<svg viewBox="0 0 300 120" role="img" aria-label="Orthogonal edge fragment">
<title>Orthogonal edge fragment</title>
<desc>Two nodes joined by an orthogonal polyline with endpoint dots and a label.</desc>
<rect x="0" y="0" width="300" height="120" rx="8" fill="#F1EFE8"></rect>
<rect x="40" y="40" width="80" height="36" rx="6" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"></rect>
<text x="52" y="62" font-size="12" fill="#0C447C">source</text>
<polyline points="120,58 160,58 160,80 204,80" fill="none" stroke="#5F5E5A" stroke-width="0.5"></polyline>
<rect x="204" y="62" width="80" height="36" rx="6" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"></rect>
<text x="216" y="84" font-size="12" fill="#085041">target</text>
<text x="160" y="48" font-size="11" fill="#444441" text-anchor="middle">relates</text>
</svg>
```

## Semantic ramp hex table (host tokens — hex only, never CSS variables)

| family | 50 | 100 | 200 | 400 | 600 | 800 | 900 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| purple | #EEEDFE | #CECBF6 | #AFA9EC | #7F77DD | #534AB7 | #3C3489 | #26215C |
| teal | #E1F5EE | #9FE1CB | #5DCAA5 | #1D9E75 | #0F6E56 | #085041 | #04342C |
| coral | #FAECE7 | #F5C4B3 | #F0997B | #D85A30 | #993C1D | #712B13 | #4A1B0C |
| pink | #FBEAF0 | #F4C0D1 | #ED93B1 | #D4537E | #993556 | #72243E | #4B1528 |
| gray | #F1EFE8 | #D3D1C7 | #B4B2A9 | #888780 | #5F5E5A | #444441 | #2C2C2A |
| blue | #E6F1FB | #B5D4F4 | #85B7EB | #378ADD | #185FA5 | #0C447C | #042C53 |
| green | #EAF3DE | #C0DD97 | #97C459 | #639922 | #3B6D11 | #27500A | #173404 |
| amber | #FAEEDA | #FAC775 | #EF9F27 | #BA7517 | #854F0B | #633806 | #412402 |
| red | #FCEBEB | #F7C1C1 | #F09595 | #E24B4A | #A32D2D | #791F1F | #501313 |

Light mode = 50 fill + 600 stroke + 800 title; dark = 800 fill + 200 stroke
+ 100 title (same table, different usage). The svg-monochrome floor requires
≥2 distinct families among shape fills.

## Coordinate grid reference

- x columns at 60px rhythm: 40, 100, 160, 220, 280, 340, 400, 460, 520, 580,
  640 — labels start at a column, nodes span 3 columns (176px at 56px inset).
- y bands: figure title 32, cluster title 94, node rows 127 / 173 (34px tall,
  46px pitch), legend 316..346, fallback caption 378..394, bottom ≥460.

## Semantic color and complexity

- Palette ramps: purple/teal/coral/pink/gray/blue/green/amber/red; use host
  tokens, never improvised hex values. Shape/size/color changes encode meaning.
- Stable defaults: blue = system/deployment, teal = approved/ready/success,
  purple = control/rollback, amber = attention/reversible action, and red =
  risk/blocker only. Use gray for annotation, never to weaken a main branch.
- Dark surfaces preserve depth: map light 50 → dark 800 and light 100 →
  dark 900; keep text/connector contrast explicit instead of auto-inverting.
- Ordinary figure default: ≤2 ramps per figure.
- Complex topology/architecture exception: group by bounded context and use
  up to 4 domain ramps, plus 1 reserved status/risk ramp. Each visual group
  remains ≤2 ramps. Color must express category or status and carry a text cue;
  color alone is never the only signal.
- A figure containing two small flows keeps each of the two small flows ≤2
  ramps; do not borrow the topology exception for decorative variety.
- ≤4 boxes per horizontal tier, ≤5 nodes per simple flow, nesting ≤3,
  subtitles ≤5 words, and ≥60px between flow boxes.

## Typography and composition

- Weights 400/500 only; minimum 11px; sentence case; no emoji as iconography.
- One reading direction and one focal story. Use primary/secondary/annotation
  rhythm; do not distribute motifs merely to fill the canvas.
- Labels remain inside their owning container and outside the object they name.
- Legends reuse rendered token colors and pair every swatch with a label.

## Safety and accessibility gate

- The host allowlist is authoritative. Never emit `script`, `foreignObject`,
  event handler (`on*`), external URL/reference, remote CSS/font, animation,
  iframe, image, or untrusted `use` content.
- v1.2 wire: the frozen validator whitelist (elements {svg,g,rect,circle,
  ellipse,line,path,polyline,polygon,text,tspan,title,desc}, geometry/paint/
  text attributes, budgets 512 elements / 2048 attributes / viewBox ≤4096) is
  enforced by the production reader — author inside it, never around it.
- Internal fragment IDs must be unique and namespaced; references stay local.
- Every connector has a visible endpoint and a textual relationship cue.
- On rejection or unsupported surfaces, fail closed to source/prose/static
  fallback; never claim a sanitized or dropped figure was persisted.

## Self-check

- Correct surface and scenario? v1.2 controlled prismer-svg stays inside the
  frozen whitelist — script/foreignObject/on*/external refs/animations absent,
  title+desc present, ids unique — and is never free/raw?
- Copied the skeleton, kept three information layers, 680 safe area,
  title+desc, 0.5px, stable density — and `pkf_svg_check` is green?
- Ordinary ≤2 ramps, or a justified bounded-context exception within caps?
- Color has semantic meaning plus a text cue; each visual group remains ≤2?
- One reading direction, boundary anchors, no clipping, stable peer rhythm?
- Unsafe tags/attributes/external references absent; fallback remains readable?

## Architecture diagram resource pack

Read [the architecture method](references/architecture-diagram/GUIDE.md) and adapt [its standalone HTML template](references/architecture-diagram/templates/template.html) for explicit architecture artifact requests. Preserve semantic boundaries, readable labels and legends outside all system boundaries. This HTML asset is not inline PKF: for PKF, use the native whitelist and geometry above, not HTML/defs/markers. Choose light/dark according to the existing project, use local fonts, and verify every connection and boundary before delivery.
