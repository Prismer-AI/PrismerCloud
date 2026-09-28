/**
 * Generator for the canonical single-file `pkf-writing` skill.
 *
 *   npx tsx sdk/cloud/scripts/gen-pkf-writing-skill.ts
 *   TAMPER=1 npx tsx sdk/cloud/scripts/gen-pkf-writing-skill.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = process.env.PKF_SKILL_CATALOG_ROOT
  ? path.resolve(process.env.PKF_SKILL_CATALOG_ROOT)
  : path.resolve(SCRIPT_DIR, '../catalog/skills');
const RUNTIME_ROOT = process.env.PKF_SKILL_RUNTIME_ROOT
  ? path.resolve(process.env.PKF_SKILL_RUNTIME_ROOT)
  : path.resolve(SCRIPT_DIR, '../../prismer/built-in-skills');
const TARGETS = [
  path.join(CATALOG_ROOT, 'pkf-writing', 'SKILL.md'),
  path.join(RUNTIME_ROOT, 'pkf-writing', 'SKILL.md'),
];
const TAMPER = process.env.TAMPER === '1';

// Runtime memory tools + Cloud PKF CLI. Every backticked command taught by the
// skill must be present here and on a shipped surface.
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

const TEMPLATE_LINES: string[] = [
  '---',
  'name: pkf-writing',
  'scope: common',
  'description: Author, update, convert, validate, persist, and render PKF (`.pkf`) content through message-inline, Library Asset, or Memory Page carriers. Use for structured reports, knowledge pages, delivery cards, or any `.pkf` body. NOT for recall, memory-graph placement, or curation decisions — those belong to the `memory` skill.',
  '---',
  '',
  '# pkf-writing',
  '',
  'PKF is the workspace long-content format: sanitized HTML plus frontmatter,',
  'typed links, and controlled media/data/math/interactive elements. This skill',
  'owns PKF authoring and carrier discipline. The `memory` skill decides what to',
  'remember and where; domain workflows decide when a deliverable is required.',
  '',
  '## Choose exactly one carrier',
  '',
  '| Carrier | Authority | Validation, persist, and readback | Reply |',
  '| --- | --- | --- | --- |',
  '| Message inline | PKF bytes delivered mechanically by `pkf_reply_inline`; the attached inline ContentBlock is durable with the message | validate the complete file BEFORE the call; the Runtime re-reads, re-validates, and attaches it for you; inspect the extracted/rendered receipt | Markdown projection is the reply text; never paste sentinel comments, never attach the .pkf as a file |',
  '| Library `.pkf` Asset | Library asset bytes + content hash/revision + scoped URI | dependency-free: host Library writer; dependency-bearing: atomic `pkf_bundle_commit`; read back authoritative root and graph | link the root asset and include a short projection |',
  '| Memory Page | Memory Page body + page revision | ask `memory` to choose/create the page; validate before its domain writer; read back the page and revision | summarize the remembered fact and canonical page |',
  '',
  'Carrier authority is exclusive. Markdown projection is a readable derivative,',
  'never canonical authority. Never report success from local draft bytes alone.',
  'When the user asks for an article/report in chat and does not explicitly ask',
  'for a downloadable file or Memory page, choose Message inline. Do not create',
  'an attachment merely because the task workspace exposes an artifacts folder.',
  '',
  '### Message-inline delivery (pkf_reply_inline)',
  '',
  'Deliver mechanically, never by pasting wire bytes: save the validated PKF to a file in',
  'the task scratch dir, then call `pkf_reply_inline({"path":"memo.pkf"})` exactly once and',
  'reply in Markdown projection; the Runtime attaches the ContentBlock. If validation is',
  'not green, do not deliver at all.',
  'Never paste sentinel comments into the reply; never attach the .pkf as a file; the',
  'Runtime still extracts the bytes between the two sentinels',
  '`<!-- prismer-pkf:inline:start -->` / `<!-- prismer-pkf:inline:end -->` for legacy agents that predate the tool — do not hand-write that region.',
  '',
  '## Authoring loop (all carriers)',
  '',
  '```text',
  '1. choose carrier + authority → message inline | Library Asset | Memory Page',
  '2. inspect source and refs    → copy real resolved URIs; never fabricate',
  '3. mint + author + review     → `pkf_mint_sids` once; run the quality gate below; repair',
  '   every error; resolve referenced assets',
  '4. persist through owner      → `pkf_reply_inline` | Library/bundle writer | memory writer',
  '5. readback + project         → URI/revision/hash + resolved validation; concise Markdown projection',
  '```',
  '',
  '**Never fabricate a URI.** Copy scoped `prismer://workspace/<ws>/asset/<sha256>` values',
  'from browse/resolve results. Inside one atomic bundle, reference bundle files by their',
  'bundle-relative path (e.g. `manifest="manifest.json"`, `src="data.csv"`); the Runtime',
  'normalizer computes every SHA-256 content hash, SRI and source hash, generates the harness',
  'manifest from `harnessDecl`, and rewrites those references into host-bound scoped asset URIs',
  'before the commit. Do not compute or hand-type hashes yourself — supply content (`bytesBase64` or',
  '`text`), paths, mime and usage only; a self-supplied hash is verified locally and a mismatch fails fast.',
  'Do not pass actor or workspace arguments to the commit tool; the host binds authority. If',
  'host-bound scope is unavailable, stop instead of guessing it. No base64/data-URI assets,',
  'remote scripts/fonts, or new bare `prismer://asset/<id>` references. If persistence or',
  'readback is unavailable, say so and retain a draft; never fake a revision.',
  '',
  '## Real command matrix and editing lanes',
  '',
  '| Need | Structured/runtime | Native/Cloud CLI |',
  '| --- | --- | --- |',
  '| mint section ids | `pkf_mint_sids` | n/a |',
  '| inspect | `pkf_outline`, `pkf_search`, `pkf_read` | `cloud pkf inspect` or ordinary UTF-8 read |',
  '| edit local draft | normal file tools | `cloud pkf patch`, `cloud pkf diff` |',
  '| validate | `pkf_validate` | `cloud pkf validate` |',
  '| deliver message-inline | `pkf_reply_inline` (task scratch/workdir file path) | n/a |',
  '| persist Library Asset | host Library writer | `cloud asset upload` only when the host exposes it; require its receipt |',
  '| persist logical bundle | `pkf_bundle_commit` | one atomic root + dependency graph; require readback |',
  '| persist Memory Page | `memory_browse` → `memory_write` → `memory_load` | n/a |',
  '| project/export | host projection | `cloud pkf project`, `cloud pkf render` |',
  '| harness assets | n/a | `cloud pkf pack-harness` |',
  '',
  '`pkf_mint_sids`/`pkf_validate`/`pkf_outline`/`pkf_search`/`pkf_read`/',
  '`pkf_bundle_commit`/`pkf_reply_inline` are native **function-call tools** —',
  'not shell executables. Call them through the tool API with JSON arguments;',
  'never `command -v`, terminal probes, Python imports, or hand-written SID/validator',
  'replacements. The shell lane is only `cloud …`. If a required native tool and',
  '`cloud` are both unavailable, keep a draft and report the Runtime capability error.',
  '',
  'The `.pkf` file is ordinary UTF-8. Validate the whole page after every edit;',
  'a 409/412 means re-read and re-target, never force. After persistence, read',
  'back canonical bytes/receipt and run resolved validation where supported.',
  '',
  '## Report quality floor + full-document review gate',
  '',
  'Before `pkf_reply_inline` or any carrier persist, run this gate. A valid PKF',
  'shell can still be an unacceptable deliverable: strict validation only proves',
  'the carrier is parseable. For substantive research memos, playbooks, and',
  'architecture reviews, unless the user asks plain text, include:',
  '- five or more semantic sections, including decision/summary and action/checklist;',
  '- at least two rich affordances chosen by need — plain tables do NOT count',
  '  toward the two: `<prismer-diagram ...>`, `<prismer-data ...>`,',
  '  `<prismer-widget ...>`, or CONTROLLED `prismer-svg` via `pkf-svg` +',
  '  `pkf_svg_check`;',
  '- caption/alt text that explains what each visual proves, not decoration.',
  '',
  'Then review the COMPLETE draft once against the content→visual selection table',
  'above, filtering quality defects that model habit or context pressure inject.',
  'Repair every failed check by editing (convert, split, delete) — never by arguing in prose:',
  '1. shape→carrier: name each major section\'s dominant shape (numbers compared /',
  '   trend / part-to-whole / entities+relationships / decision flow / phases);',
  '   where the table routes that shape to a diagram or chart, that element must',
  '   be present — a prose enumeration or a default table is a failed check, not',
  '   a style choice.',
  '2. no duplication: a fact a visual already shows is removed from body prose;',
  '   the visual keeps structure, prose keeps interpretation, source qualifiers,',
  '   and facts the visual cannot hold.',
  '3. captions: every visual\'s caption states what it proves, not decoration;',
  '   alt text conveys the same relationships.',
  '4. coverage: a section with 3+ paragraphs and no visual or table either gains',
  '   one or carries a one-line, content-specific reason; a document-level "no',
  '   visual fits" excuse fails the gate, and so does ornamental content added',
  '   just to satisfy the checklist.',
  '5. degradation: when a blocked carrier forces a Markdown projection, project',
  '   the same visuals (mermaid fences / Markdown tables); a prose-only fallback',
  '   fails the gate. State remaining limits after readback.',
  '',
  '## Core format (PKF v1.1 strict)',
  '',
  'Canonical MIME: `application/vnd.prismer.pkf+html`.',
  '',
  '```html',
  '<script type="application/prismer+json">',
  '{"type":"note","title":"Database choice","description":"Chose PostgreSQL over MySQL.","tags":["db","decision"],"timestamp":"2026-06-29T00:00:00Z","visibility":"workspace","sensitivity":"none","pkfVersion":"1.1","presentation":{"theme":"knowledge","density":"comfortable","fontProfile":"auto","locale":"zh-CN"}}',
  '</script>',
  '<section><h2 id="decision" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">Decision</h2><p>…</p></section>',
  '```',
  '',
  '- `description` is required and feeds previews/TOC. Presentation theme is',
  '  `knowledge|editorial|technical`; density `compact|comfortable`; fontProfile',
  '  `auto|sans|serif`; locale is BCP-47. Font profiles never accept URLs.',
  '- Each `<section>` first direct heading carries `id` + stable `data-sid` (`sec_` + 26',
  '  lowercase Crockford base32). Mint once; renames do not change it.',
  '- Typed relations: `derived-from|contradicts|supports|child-of|related|references|cites`.',
  '  Copy hrefs from browse/search results. `child-of` points from child to hub.',
  '- Strict errors: scripts/styles, inline handlers/style, javascript URLs, bare',
  '  asset URIs, malformed frontmatter, duplicate/illegal section identities.',
  '',
  '## Semantic content and security',
  '',
  'Use headings, paragraphs, lists, blockquotes, code/pre, tables, figure/figcaption,',
  'details/summary, footnote roles, and optional `data-pkf-layout="columns-2|wide|full-bleed"`.',
  'Every media figure has alt text or figcaption. Sanitization does not grant permission:',
  'rejected content must not be persisted as successful PKF; a raw upload may remain',
  'quarantined but must never render active or be reported as a successful canonical write.',
  '',
  '- Media pointers use scoped resolved URIs; never embed copies or remote media.',
  '- `<prismer-file src="…" name="guide.pdf" mime="application/pdf" bytes="476356">`',
  '  uses a pathless name; unknown MIME degrades to a generic card.',
  '- `<prismer-data format="csv" view="table" caption="…">…</prismer-data>`; formats',
  '  `csv|tsv|json|ndjson|parquet|arrow|npz`, views',
  '  `table|line|bar|scatter|area|heatmap|json-tree|chart-bar|chart-line|chart-pie`.',
  '- `<prismer-math format="tex" display="inline|block">E = mc^2</prismer-math>`;',
  '  TeX only, KaTeX trust=false, ≤16 KiB; unsafe/unknown macros fall back to source.',
  '',
  '## Visual capabilities: content → visual selection, delegate the grammar',
  '',
  'Content → visual selection (一图胜千言 — pick by content shape); structured',
  'reports plan visuals in the outline, never decorate afterwards:',
  '',
  '| Content shape | Visual | Carrier |',
  '| --- | --- | --- |',
  '| Entities + relationships (architecture, topology, integrations) | diagram | `<prismer-diagram format="mermaid">` (`flowchart`/`erDiagram`) |',
  '| Decision paths, state machines, protocols | diagram | `<prismer-diagram format="mermaid">` (`flowchart`/`sequenceDiagram`) |',
  '| Who does what when (handoffs, orchestration) | sequence diagram | `<prismer-diagram format="mermaid">` |',
  '| Numbers compared across categories (gaps, scores, counts) | bar chart | `<prismer-data view="chart-bar">` |',
  '| Trend over stages/time (adoption, latency, cost) | line chart | `<prismer-data view="chart-line">` |',
  '| Part-to-whole (share of count/risk/effort) | pie chart | `<prismer-data view="chart-pie">` |',
  '| Maturity/phases/gates | flowchart or table | `<prismer-diagram>` / table |',
  '',
  'A report with ≥3 major sections and zero visuals is a smell — add the missing visual, or',
  'justify per section with a content-specific line; a document-level excuse fails the review',
  'gate. Never duplicate (chart OR table OR prose enumeration); every caption states the',
  'takeaway, not the mechanics, and prose carries interpretation only.',
  '',
  'Load `pkf-svg` for visual planning, widget composition, accessibility, and quality review;',
  'it owns visual/SVG grammar, this skill only routes the carrier. Simple diagrams stay on',
  '`<prismer-diagram format="mermaid" caption="…">` (Mermaid',
  '`erDiagram|flowchart|sequenceDiagram|xychart-beta`); data stay on d3-backed',
  '`chart-bar|chart-line|chart-pie`.',
  '',
  '### Visual SOURCES — four lanes, one rule: the pointer must be a scoped URI',
  '',
  '1. **Draw it natively (preferred for facts)** — Mermaid diagrams and `prismer-data` charts',
  '   from YOUR structured data: deterministic, editable, theme-consistent, zero external',
  '   dependency. Prefer it whenever the visual encodes facts the report states.',
  '2. **Author controlled SVG** (PKF v1.2 CONTROLLED `prismer-svg`, pkf209 D19 activated',
  '   2026-08-18; grammar owned by `pkf-svg`) — for topology/complex hierarchy Mermaid cannot',
  '   express: copy the pkf-svg skeleton, verify with `pkf_svg_check({"svg":"…"})` until green.',
  '3. **AI-generate imagery** (`image-generate` skill) — concept/mood visuals only (metaphor,',
  '   hero, illustration), never for facts. `cloud deliver` it into the workspace, read back',
  '   the asset id/hash, reference the scoped URI in the body',
  '   (`<figure><img src="prismer://workspace/<ws>/asset/<hash>">`), caption as generated.',
  '4. **Web imagery** (`web_load`/web search) — licensed/public imagery must be DOWNLOADED and',
  '   materialized as a workspace asset first (same scoped-URI path as lane 3); remote URLs',
  '   never render. Public-domain/permissive sources only; attribute in the caption.',
  '',
  'Selection order: facts → lane 1; Mermaid-inexpressible structure → lane 2; concept/mood →',
  'lane 3; real-world photos/screenshots → lane 4 (or lane 3 when nothing suitable exists).',
  'If `pkf-svg` is unavailable, fallback to Mermaid for diagrams, d3 for data, semantic',
  'HTML/prose, or a reviewed static asset. Do not hand-roll free SVG.',
  '',
  '- Mermaid fences from imported markdown serialize into the same diagram element:',
  '  `PKF_EXAMPLE_INLINE_DIAGRAM`, `PKF_EXAMPLE_ER_DIAGRAM`, `PKF_EXAMPLE_MERMAID_IMPORT`;',
  '  data/image/model: `PKF_EXAMPLE_CHARTS`, `PKF_EXAMPLE_AI_IMAGE`, `PKF_EXAMPLE_MODEL_3D`,',
  '  `PKF_EXAMPLE_MIXED` — all in `src/lib/pkf/examples.ts` (`PKF_EXAMPLE_CAPABILITIES`).',
  '  AI text-to-image output is a reviewed PNG asset with a resolved scoped URI, never an inline substitute or hand-drawn SVG.',
  '- `<prismer-model format="primitives" caption="…">`: declarative `box|sphere|cylinder|torus|plane`',
  '  JSON, ≤50 objects, zero script; live WebGL (drag-orbit, ± / Ctrl⌘+wheel zoom) + static isometric fallback.',
  '',
  '## Interactive content: widgets first, harness only for custom JS',
  '',
  'For ordinary interaction (tabbed sections, tag filtering, counters, timelines, checklists)',
  'use the declarative `<prismer-widget>` — the reader renders it natively with',
  'zero JS and zero iframe. At most one widget per document, ≤32 entries each, ≤8 KiB total; types',
  '`tabs|filter|counter|timeline|checklist`.',
  '',
  '```html',
  '<prismer-widget type="tabs">{"tabs":[{"label":"Plan","content":"Phase A complete."},{"label":"Risk","content":"Phase B risk: cache staleness."}]}</prismer-widget>',
  '```',
  '```html',
  '<prismer-widget type="checklist">{"title":"Launch gate","items":[{"text":"Tests green","done":true},{"text":"Docs updated","done":false}]}</prismer-widget>',
  '```',
  '',
  'Seed/onboarding PKF must be self-contained: one canonical tour page, stable ids/SIDs, real scoped',
  'URIs from manifest or bundle readback, no remote URLs/data URIs/base64/invented hashes; success is',
  'proven by persisted assets, ledger rows, Memory receipts, and DOM/readback — not welcome wording.',
  '',
  'Only when custom JS is genuinely required — knowing the host mount is NOT implemented yet (a bundle packs and validates but does not render) — use the JS harness below and let the Runtime compute its hashes and manifest.',
  '',
  '## Interactive harness',
  '',
  'Any PKF with JS, CSS, media, CSV, or other support files is one logical bundle. Call',
  '`pkf_bundle_commit` once with one atomic logical bundle: the PKF root and all dependencies,',
  'using one stable idempotency key across retries. Completion requires canonical readback of',
  'the receipt, root, and resource relation graph. Never upload JS, CSS, media, CSV, or',
  'dependencies separately; never use prose to claim resource relations or attachment associations.',
  '',
  '`<prismer-interactive manifest="prismer://workspace/<ws>/asset/<sha256>">` points to a versioned',
  'manifest whose scripts/styles use scoped URIs and real sha256 integrity; the pack command rejects',
  'traversal, symlinks, remote imports, and oversize; sandbox is allow-scripts without',
  'allow-same-origin under CSP. Always provide a static no-JS fallback; non-empty actions require governance.',
  '',
  '## Validation, readback, projection, export',
  '',
  '```text',
  'native tool: pkf_validate({"source":"<complete PKF>","level":"structure"})',
  'cloud pkf validate <file> [--level resolved] [--json]',
  '```',
  '',
  '- Every error blocks persistence. Resource refs remain unverified until the',
  '  authority readback resolves them. Structure-only success is not completion.',
  '- Markdown projection is read-only degradation, never executable or canonical.',
  '- Standalone export contains no bearer/presigned URLs; private refs degrade to',
  '  labels, interactive content to static fallback, and math uses pinned KaTeX.',
];

function audit(md: string): string[] {
  const errors: string[] = [];
  const lines = md.split('\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? '';
  // Budget rebased 240 → 260 alongside the vitest prompt-size receipt test: the
  // full-document review gate (report quality floor merge + 5 mechanical checks)
  // is mandated content against the v1-zero-visual / v2-duplication failures.
  if (lines.length >= 260) errors.push(`line budget: ${lines.length} (must be < 260)`);
  if (!/\.pkf/.test(fm) || !/author|update|convert|validate/i.test(fm)) errors.push('frontmatter authoring triggers');
  if (!/NOT for recall/i.test(fm) || !/`memory` skill/i.test(fm)) errors.push('frontmatter memory boundary');
  for (const carrier of [/message inline/i, /Library .*\.pkf.*Asset/is, /Memory Page/i]) {
    if (!carrier.test(md)) errors.push(`carrier missing: ${carrier}`);
  }
  for (const term of [/authority/i, /validation/i, /persist/i, /readback/i, /Markdown projection/i]) {
    if (!term.test(md)) errors.push(`carrier contract missing: ${term}`);
  }
  const start = '<!-- prismer-pkf:inline:start -->';
  const end = '<!-- prismer-pkf:inline:end -->';
  if (md.split(start).length !== 2 || md.split(end).length !== 2 || md.indexOf(start) >= md.indexOf(end)) {
    errors.push('message inline sentinel must appear exactly once and in order');
  }
  if (!/Runtime.*extract.*between.*sentinel/is.test(md)) errors.push('Runtime extraction contract missing');
  // pkf209 — inline delivery is taught through the native tool, never by
  // asking the model to reproduce wire bytes verbatim.
  if (!/### Message-inline delivery \(pkf_reply_inline\)/.test(md)) {
    errors.push('pkf_reply_inline delivery section missing');
  }
  if (!/call `pkf_reply_inline\(/.test(md) || !/exactly once/.test(md)) {
    errors.push('pkf_reply_inline call contract missing');
  }
  if (!/Never paste sentinel comments into the reply/.test(md)) {
    errors.push('sentinel-paste prohibition missing');
  }
  if (!/never attach the \.pkf as a\s+file/.test(md)) {
    errors.push('pkf-as-file attachment prohibition missing');
  }
  if (!/Load `pkf-svg`/i.test(md) || !/unavailable.*fallback/is.test(md)) errors.push('pkf-svg delegation/fallback missing');
  if (/viewBox|foreignObject|0\.5px|bounded context/i.test(md)) errors.push('SVG grammar copied into pkf-writing');
  if (!/<prismer-diagram/.test(md) || /<prismer-svg/.test(md)) errors.push('production diagram surface is not honest');
  // pkf209/07 §5 — v1.2 is ACTIVATED: the stale "no raw prismer-svg production
  // element / never invent SVG authoring" claim is drift. Topology/complex
  // structures route to the controlled element behind a pkf_svg_check loop;
  // simple diagrams stay Mermaid. Grammar itself stays in the pkf-svg skill.
  if (!/v1\.2.*CONTROLLED.*prismer-svg/is.test(md)) {
    errors.push('svg routing: v1.2 controlled prismer-svg activation is missing');
  }
  if (!/`pkf_svg_check/.test(md)) errors.push('svg check loop: pkf_svg_check must be taught before persisting controlled svg');
  if (!/topology/i.test(md)) errors.push('svg routing: topology escalation for controlled svg missing');
  if (!/chart-bar\|chart-line\|chart-pie/.test(md) || /\bc-line\b|\bc-pie\b/.test(md)) errors.push('invalid chart view');
  if (!/resolved/.test(md) || !/read back|readback/i.test(md)) errors.push('resolved readback missing');
  if (!/## Report quality floor/.test(md)) errors.push('report quality floor missing');
  if (!/valid PKF.*unacceptable deliverable/is.test(md)) errors.push('strictOk-only quality warning missing');
  if (!/Before `pkf_reply_inline`/.test(md)) errors.push('pre-delivery quality self-check missing');
  if (!/architecture reviews|research memos|playbooks/i.test(md)) errors.push('substantive report trigger missing');
  if (!/at least two/i.test(md) || !/semantic sections/i.test(md)) errors.push('rich report minimum missing');
  if (!/<prismer-data/.test(md) || !/<prismer-widget/.test(md)) errors.push('rich report data/widget path missing');
  if (!/CONTROLLED `prismer-svg`/.test(md) || !/not decoration/i.test(md)) {
    errors.push('visual quality route missing');
  }
  if (!/`pkf_bundle_commit`/.test(md)) errors.push('logical bundle native tool missing');
  if (!/(?:one|single).*(?:atomic|logical bundle).*(?:root).*(?:all|every).*(?:dependenc|resource)/is.test(md)) {
    errors.push('atomic logical bundle contract missing');
  }
  if (!/stable idempotency/i.test(md) || !/readback.*root.*resource.*graph/is.test(md)) {
    errors.push('bundle idempotency/readback contract missing');
  }
  if (!/never.*(?:upload|persist).*(?:JS|CSS|media|CSV|dependenc).*(?:separately|individually)/is.test(md)) {
    errors.push('individual dependency upload prohibition missing');
  }
  if (!/never.*prose.*(?:relation|associat|attach)/is.test(md)) errors.push('prose relation prohibition missing');
  // pkf209/07 §4a — hash sinking is a RUNTIME responsibility. The skill must
  // teach content-only input (bytesBase64|text) + bundle-relative paths, never
  // model-side hash/SRI computation.
  if (!/Runtime\s+normalizer computes every SHA-256 content hash, SRI and source hash/is.test(md)) {
    errors.push('runtime hash-sinking responsibility missing');
  }
  if (!/supply content \(`bytesBase64` or\s+`text`\), paths, mime and usage only/.test(md)) {
    errors.push('content-only bundle input contract missing');
  }
  if (!/Do not\s+compute or hand-type hashes yourself/i.test(md)) {
    errors.push('hash computation prohibition missing');
  }
  // pkf209/07 §4b — widget section with verbatim validator-passing examples.
  if (!/<prismer-widget type="tabs"/.test(md) || !/<prismer-widget type="checklist"/.test(md)) {
    errors.push('declarative widget examples missing');
  }
  if (!/zero JS and zero iframe/.test(md)) errors.push('widget zero-JS contract missing');
  if (!/custom JS is genuinely required/.test(md)) errors.push('widget→harness escalation rule missing');
  if (!/(?:do not|never).*(?:pass|supply).*(?:actor|workspace).*(?:argument|parameter)/is.test(md)) {
    errors.push('model workspace/actor argument prohibition missing');
  }
  if (/references\//.test(md)) errors.push('single-file contract broken');
  if (/prismer:\/\/asset\/[a-z0-9]+\b/.test(md)) errors.push('bare asset URI taught');
  if (/use base64|as base64|data:image|data:application/.test(md)) errors.push('base64/data URI taught');
  if (/<script src="https?:|src="https?:/.test(md)) errors.push('remote script taught');
  const backticked = [...md.matchAll(/`([a-z_][a-z0-9_ -]+)`/g)].map((match) => match[1]!.trim());
  for (const token of backticked) {
    if (/^cloud pkf|^pkf_/.test(token) && !KNOWN_COMMANDS.includes(token)) {
      errors.push(`unknown command taught: ${token}`);
    }
  }
  return errors;
}

function tamper(lines: string[]): void {
  const anchor = lines.findIndex((line) => line === '## Validation, readback, projection, export');
  lines.splice(anchor, 0, '- Run `pkf_teleport`, then load `references/core-format.md`.');
  lines.splice(anchor, 0, '- Copy SVG grammar: viewBox 680 and `<prismer-svg>`.');
  lines.push(...Array(100).fill('# padding beyond the line budget'));
}

const lines = TEMPLATE_LINES.slice();
if (TAMPER) tamper(lines);
const md = `${lines.join('\n')}\n`;
const errors = audit(md);
if (errors.length > 0) {
  console.error('[gen-pkf-writing-skill] ❌ refusing to write — gates red:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

for (const target of TARGETS) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, md, 'utf8');
}
console.log(
  `[gen-pkf-writing-skill] ✅ wrote ${TARGETS.map((target) => path.relative(path.resolve(SCRIPT_DIR, '../..'), target)).join(' + ')} (${lines.length} lines)`,
);
