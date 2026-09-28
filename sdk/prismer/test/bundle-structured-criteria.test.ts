// Structured acceptance criteria (apc/12 skill-acceptance hardening).
//
// These are the "does the gate have teeth" tests: for every checker, a working
// report is green AND the minimal faithful injection of the fault the criterion
// claims to catch is red. A checker that only ever goes green is the open-book
// exam this whole change exists to delete.
//
// Fixtures are a real (temp) filesystem, not mocks — the checkers' entire job is
// re-reading claims off disk, so stubbing the disk would test nothing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchCriterion,
  matchAcceptanceCriteria,
  __resetCheckerFileCache,
  parseCitations,
  verifyCitation,
} from '../src/bundle/index.js';
// Direct import on purpose: a module-level SyntaxError (e.g. an illegal regex
// quantifier) only surfaces when something LOADS the module. Nothing imported
// structured-criteria.ts in the suite, so a broken build could reach the working
// tree and take down every `prismer` CLI subcommand at require() time. This
// import + the smoke assertion below is the regression guard for that.
import { STRUCTURED_CHECKERS } from '../src/bundle/structured-criteria.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'apc-structured-'));
  mkdirSync(join(repo, 'src/lib'), { recursive: true });
  mkdirSync(join(repo, 'sdk/acme/widget/src'), { recursive: true });
  mkdirSync(join(repo, 'docs/api'), { recursive: true });
  // line 1..5; `scoreReport` occurs on lines 2 and 5, line 4 is blank.
  writeFileSync(
    join(repo, 'src/lib/scorer.ts'),
    ['// header', 'export function scoreReport(x: string) {', '  return x.length;', '', '} // scoreReport end', ''].join(
      '\n',
    ),
  );
  writeFileSync(
    join(repo, 'src/lib/caller.ts'),
    ['import { scoreReport } from "./scorer.js";', 'scoreReport("a");', 'const unrelated = 1;', ''].join('\n'),
  );
  writeFileSync(join(repo, 'sdk/acme/widget/src/index.ts'), 'export const widget = 1;\n');
  writeFileSync(join(repo, 'sdk/acme/widget/CHANGELOG.md'), '# changelog\n');
  writeFileSync(join(repo, 'docs/api/widget.md'), '# widget api\n');
  // apc/12 F3: 19 real files in the main repo live under a URL-ENCODED path
  // segment (`src/app/api/sandboxes/%5Fadmin/…`). The citation regex must be
  // able to parse them, or a truthful report citing one is judged FAKE.
  mkdirSync(join(repo, 'src/app/api/sandboxes/%5Fadmin/runtime-releases'), { recursive: true });
  writeFileSync(
    join(repo, 'src/app/api/sandboxes/%5Fadmin/runtime-releases/route.ts'),
    ['export const runtime = "nodejs";', 'await prisma.iMTaskLog.create({});', ''].join('\n'),
  );
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));
beforeEach(() => __resetCheckerFileCache());

const ctx = () => ({ cwd: repo });

describe('module loads (guards against a module-level SyntaxError reaching the tree)', () => {
  it('registers every checker id the shipped skill.json files reference', () => {
    expect(Object.keys(STRUCTURED_CHECKERS).sort()).toEqual([
      'cited-evidence',
      'declared-id-readback',
      'dimension-coverage',
      'doc-sync-obligations',
      'gh-claim-readback',
      'git-claim-readback',
      'json-claim',
    ]);
  });
});

// ── citation primitives ──────────────────────────────────────────────────────

describe('citation parsing + on-disk re-verification', () => {
  it('extracts repo-relative path:line pairs and ignores absolute paths', () => {
    const cites = parseCitations('see src/lib/scorer.ts:2 and /etc/passwd:3 and out.txt:9');
    expect(cites.map((c) => `${c.path}:${c.line}`)).toEqual(['src/lib/scorer.ts:2']);
  });

  it('accepts a real line, rejects out-of-range / missing file / blank line', () => {
    expect(verifyCitation({ path: 'src/lib/scorer.ts', line: 2, raw: '' }, ctx()).ok).toBe(true);
    expect(verifyCitation({ path: 'src/lib/scorer.ts', line: 900, raw: '' }, ctx()).reason).toMatch(/out of range/);
    expect(verifyCitation({ path: 'src/lib/nope.ts', line: 1, raw: '' }, ctx()).reason).toMatch(/does not exist/);
    expect(verifyCitation({ path: 'src/lib/scorer.ts', line: 4, raw: '' }, ctx()).reason).toMatch(/blank/);
  });

  // apc/12 F3 regression. Before `%` was in the path class the match started
  // AFTER it, yielding `5Fadmin/runtime-releases/route.ts:2` — a path that does
  // not exist — so `cited-evidence` (bad.length > 0 ⇒ fail) went RED on a
  // report whose citation was entirely truthful. Reddening a faithful report is
  // the same class of bug as greening a fabricated one.
  it('parses a URL-encoded path segment (%5Fadmin) as one path, and still rejects fake ones there', () => {
    const cites = parseCitations('see src/app/api/sandboxes/%5Fadmin/runtime-releases/route.ts:2 for the write');
    expect(cites.map((c) => `${c.path}:${c.line}`)).toEqual([
      'src/app/api/sandboxes/%5Fadmin/runtime-releases/route.ts:2',
    ]);
    expect(verifyCitation(cites[0]!, ctx()).ok).toBe(true);
    // existence / range checks are NOT relaxed for these paths
    expect(
      verifyCitation({ path: 'src/app/api/sandboxes/%5Fadmin/runtime-releases/route.ts', line: 900, raw: '' }, ctx())
        .reason,
    ).toMatch(/out of range/);
    expect(
      verifyCitation({ path: 'src/app/api/sandboxes/%5Fadmin/invented/route.ts', line: 1, raw: '' }, ctx()).reason,
    ).toMatch(/does not exist/);
  });
});

// ── cited-evidence ───────────────────────────────────────────────────────────

const citedEvidence = (args: Record<string, unknown> = {}) => ({
  label: 'cited evidence',
  type: 'structured' as const,
  checker: 'cited-evidence',
  match: '<structured:cited-evidence>',
  args: { minRows: 2, minAnchoredRows: 2, ...args },
});

const REAL_REPORT = [
  'CHANGE-POINT: scoreReport @ src/lib/scorer.ts',
  '',
  '| path:line | dimension | contract | risk | regression |',
  '| --- | --- | --- | --- | --- |',
  '| src/lib/scorer.ts:2 | definition | signature | breaks callers | T0 |',
  '| src/lib/caller.ts:1 | direct-callers | import | breaks build | T0 |',
  '| src/lib/caller.ts:2 | direct-callers | call site | breaks build | T0 |',
].join('\n');

describe('cited-evidence — a real path:line is not enough, it must be a real HIT', () => {
  it('passes a report whose citations all resolve and land on the symbol', () => {
    const r = matchCriterion(citedEvidence(), REAL_REPORT, ctx());
    expect(r.pass).toBe(true);
    expect(r.type).toBe('structured');
  });

  it('FAILS when a line number is invented (the apc/12 NEG-3 shape)', () => {
    const faked = REAL_REPORT.replace('src/lib/caller.ts:2', 'src/lib/caller.ts:874');
    const r = matchCriterion(citedEvidence(), faked, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/FAKE citation src\/lib\/caller\.ts:874/);
  });

  it('FAILS when a cited file does not exist at all', () => {
    const faked = REAL_REPORT.replace('src/lib/caller.ts:1', 'src/lib/invented-consumer.ts:1');
    expect(matchCriterion(citedEvidence(), faked, ctx()).details?.join('\n')).toMatch(/does not exist/);
  });

  it('FAILS when citations are real lines that do not contain the traced symbol', () => {
    // caller.ts:3 is a real, non-blank line — but not a hit for `scoreReport`.
    const weak = REAL_REPORT.split('\n')
      .map((l) => l.replace('src/lib/caller.ts:1', 'src/lib/caller.ts:3').replace('src/lib/caller.ts:2', 'src/lib/caller.ts:3'))
      .join('\n');
    const r = matchCriterion(citedEvidence({ minAnchoredRows: 3 }), weak, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/actually land on a line containing/);
  });

  it('FAILS when the report never declares which change point it traced', () => {
    const noAnchor = REAL_REPORT.split('\n').slice(2).join('\n');
    expect(matchCriterion(citedEvidence(), noAnchor, ctx()).details?.join('\n')).toMatch(/CHANGE-POINT/);
  });

  it('FAILS when the declared change point is not the one the task gave', () => {
    const r = matchCriterion(
      citedEvidence({ expectedChangePoint: { symbol: 'somethingElse', path: 'src/lib/scorer.ts' } }),
      REAL_REPORT,
      ctx(),
    );
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/this task's change point is "somethingElse"/);
  });

  it('FAILS when the declared change-point symbol is absent from the declared file', () => {
    const r = matchCriterion(citedEvidence(), REAL_REPORT.replace('scoreReport @', 'ghostSymbol @'), ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/does not occur in/);
  });
});

// ── contract fidelity: a report that follows the SHIPPED contract verbatim ───
// A criterion that reds a 100%-faithful report is the same class of bug as one
// that greens a fabricated report — both are decoupled from the truth. These
// cases pin the three misalignments the end-to-end run surfaced.

describe('cited-evidence — a report produced verbatim from the shipped contract is GREEN', () => {
  const CONTRACT_VERBATIM = [
    // (1) the contract's own example wraps the whole declaration in backticks
    '`CHANGE-POINT: scoreReport @ src/lib/scorer.ts`',
    '',
    'Step (2) of the contract orders a hit-count reconciliation. Raw `rg -c` output:',
    '',
    // `rg -c` prints `path:COUNT`. A count can never exceed the file's line
    // count, but it lands wherever it lands — scorer.ts:4 is a BLANK line, so
    // the pre-fix checker read this count as a line number and cried FAKE.
    '```',
    'src/lib/scorer.ts:4',
    'src/lib/caller.ts:2',
    '```',
    '',
    'Reconciled: count=6 hits across 2 files, matching the 3 impact rows below.',
    '',
    '```',
    '| path:line | dimension | contract | risk | regression |',
    '| --- | --- | --- | --- | --- |',
    '| src/lib/scorer.ts:2 | definition | signature | breaks callers | T0 |',
    '| src/lib/caller.ts:1 | direct-callers | import | breaks build | T0 |',
    '| src/lib/caller.ts:2 | direct-callers | call site | breaks build | T0 |',
    '```',
  ].join('\n');

  it('accepts the backtick-wrapped CHANGE-POINT line (contract example shape)', () => {
    const r = matchCriterion(citedEvidence(), CONTRACT_VERBATIM, ctx());
    expect(r.details?.join('\n')).not.toMatch(/no `CHANGE-POINT/);
    expect(r.pass).toBe(true);
  });

  it('does not mistake a bare `rg -c` COUNT line for a line-number citation', () => {
    // `src/lib/scorer.ts:4` here means FOUR HITS. Line 4 of scorer.ts is blank,
    // so reading it as a line number yields "cited line is blank" — a fake
    // verdict on a report that did exactly what the contract ordered.
    const r = matchCriterion(citedEvidence(), CONTRACT_VERBATIM, ctx());
    expect(r.details?.join('\n')).not.toMatch(/FAKE citation src\/lib\/scorer\.ts:4/);
    expect(r.pass).toBe(true);
    // Same text, count line moved INLINE into a sentence (the contract forbids
    // this) — it is a claim again and the blank line is caught.
    const inlined = CONTRACT_VERBATIM.replace(
      'Reconciled: count=6 hits',
      'Reconciled: src/lib/scorer.ts:4 and more, count=6 hits',
    );
    expect(matchCriterion(citedEvidence(), inlined, ctx()).details?.join('\n')).toMatch(/cited line is blank/);
  });

  it('still catches an invented citation that sits in a real claim position', () => {
    // Same report, one TABLE ROW faked — the count-line tolerance must not leak
    // into the rows, or the whole gate would be back to an open-book exam.
    const faked = CONTRACT_VERBATIM.replace(
      '| src/lib/caller.ts:2 | direct-callers | call site',
      '| src/lib/caller.ts:874 | direct-callers | call site',
    );
    const r = matchCriterion(citedEvidence(), faked, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/FAKE citation src\/lib\/caller\.ts:874/);
  });

  it('names the contract rule instead of implying the agent lied about the path', () => {
    const abbreviated = REAL_REPORT.replace('src/lib/caller.ts:1', 'lib/caller.ts:1');
    expect(matchCriterion(citedEvidence(), abbreviated, ctx()).details?.join('\n')).toMatch(/REPO-ROOT-RELATIVE/);
  });
});

// ── dimension-coverage ───────────────────────────────────────────────────────

const dimensionCoverage = () => ({
  label: 'dimension coverage',
  type: 'structured' as const,
  checker: 'dimension-coverage',
  match: '<structured:dimension-coverage>',
  args: { dimensions: ['direct-callers', 'dual-prisma', 'daemon-sdk-mirror'], minReasonChars: 20 },
});

const DIMS_OK = [
  '- [1] direct-callers: src/lib/caller.ts:2',
  '- [4] dual-prisma: N/A — this change point is a pure function and touches no Prisma model or column at all',
  '- [5] daemon-sdk-mirror: src/lib/scorer.ts:2',
].join('\n');

describe('dimension-coverage — a dimension is answered by its keyed line, not by the word', () => {
  it('passes when every dimension has a verified citation or an N/A with a reason', () => {
    expect(matchCriterion(dimensionCoverage(), DIMS_OK, ctx()).pass).toBe(true);
  });

  it('FAILS when one dimension is dropped even though the word occurs elsewhere (apc/12 NEG-2)', () => {
    const dropped =
      DIMS_OK.split('\n')
        .filter((l) => !l.includes('dual-prisma'))
        .join('\n') + '\n\nRemember to run `npm run prisma:generate` before the regression run.';
    // The old bare-substring criterion `match:"prisma"` is satisfied by this text …
    expect(matchCriterion({ label: 'old', match: 'prisma', type: 'regex', flags: 'is' }, dropped).pass).toBe(true);
    // … the structured one is not.
    const r = matchCriterion(dimensionCoverage(), dropped, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/MISSING dimension\(s\): dual-prisma/);
  });

  it('FAILS on a bare N/A with no reason', () => {
    const bare = DIMS_OK.replace(/- \[4\] dual-prisma:.*/, '- [4] dual-prisma: N/A');
    expect(matchCriterion(dimensionCoverage(), bare, ctx()).details?.join('\n')).toMatch(/N\/A with no \(or too short\)/);
  });

  it('FAILS when a dimension is answered with prose but no verifiable evidence', () => {
    const prose = DIMS_OK.replace('- [1] direct-callers: src/lib/caller.ts:2', '- [1] direct-callers: 应该有几个调用方');
    expect(matchCriterion(dimensionCoverage(), prose, ctx()).details?.join('\n')).toMatch(/no verifiable path:line/);
  });
});

// ── dimension-coverage: anchorToKey (apc/12 F1 — the label promised more than
//    the code delivered: pointing EVERY dimension at one real line scored green)

const anchored = (args: Record<string, unknown>) => ({
  label: 'anchored dimension coverage',
  type: 'structured' as const,
  checker: 'dimension-coverage',
  match: '<structured:dimension-coverage:anchored>',
  args: { dimensions: ['scoreReport', 'widget'], minReasonChars: 20, ...args },
});

// scorer.ts:2 declares `scoreReport`; widget/src/index.ts:1 declares `widget`.
const ANCHORED_OK = ['- scoreReport: src/lib/scorer.ts:2', '- widget: sdk/acme/widget/src/index.ts:1'].join('\n');
// Both dimensions point at ONE real line that only declares `scoreReport`.
const ANCHORED_SAME_LINE = ['- scoreReport: src/lib/scorer.ts:2', '- widget: src/lib/scorer.ts:2'].join('\n');

describe('dimension-coverage — anchorToKey binds a citation to the line that DECLARES the dimension', () => {
  it('without the arg, one real line pasted under every dimension is GREEN (the disclosed hole)', () => {
    expect(matchCriterion(anchored({}), ANCHORED_SAME_LINE, ctx()).pass).toBe(true);
  });

  it('with the arg, the same report is RED — a real line that does not mention the key is not evidence for it', () => {
    const r = matchCriterion(anchored({ anchorToKey: { minAnchored: 1 } }), ANCHORED_SAME_LINE, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/widget: 1 citation\(s\) resolve on disk but 0 land on a line/);
  });

  it('with the arg, a report citing each dimension own declaration is GREEN', () => {
    const r = matchCriterion(anchored({ anchorToKey: { minAnchored: 1 } }), ANCHORED_OK, ctx());
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/anchored on its own declaration/);
  });

  // Found by the apc/12 code-review acceptance run,审 c3d91481 itself.
  // `anchorToKey` used to route through `argRecord`, which returns undefined for
  // anything that is not a plain object — so `true` / `[{…}]` / "minAnchored:1"
  // / a typo'd key silently restored the PRE-FIX behaviour and reported GREEN.
  // Since this arg exists solely to close F1, a silent skip makes the guard
  // decorative — the exact shape this overhaul hunts. Every other
  // misconfiguration in the file already fails closed; this was the odd one out.
  it.each([
    ['a bare boolean', true],
    ['an array wrapper', [{ minAnchored: 1 }]],
    ['a string', 'minAnchored:1'],
    ['a number', 1],
  ])('a malformed anchorToKey (%s) fails LOUD instead of silently skipping', (_label, bad) => {
    const r = matchCriterion(anchored({ anchorToKey: bad }), ANCHORED_SAME_LINE, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/checker misconfigured: args\.anchorToKey must be an object/);
  });

  it('negative control — omitting the arg still preserves the pre-fix behaviour', () => {
    // The default must stay byte-identical, or enabling F1 would retroactively
    // redden the 13 skills whose criteria were verified under the old semantics.
    const r = matchCriterion(anchored({}), ANCHORED_SAME_LINE, ctx());
    expect(r.pass).toBe(true);
  });

  it('accepts a declared alias when the dimension key itself is not the on-disk token', () => {
    const rollup = '- domain-lib: src/lib/scorer.ts:2';
    const crit = {
      label: 'rollup',
      type: 'structured' as const,
      checker: 'dimension-coverage',
      match: '<structured:dimension-coverage:alias>',
      args: {
        dimensions: ['domain-lib'],
        minReasonChars: 20,
        anchorToKey: { minAnchored: 1, aliases: { 'domain-lib': ['scoreReport'] } },
      },
    };
    expect(matchCriterion(crit, rollup, ctx()).pass).toBe(true);
    // …and without the alias the same line is not evidence for `domain-lib`.
    const noAlias = { ...crit, args: { ...crit.args, anchorToKey: { minAnchored: 1 } } };
    expect(matchCriterion(noAlias, rollup, ctx()).pass).toBe(false);
  });
});

// ── dimension-coverage: pinned verdicts (design-review's load-bearing oracle) ─

const verdictCoverage = (requiredVerdicts: Record<string, string>) => ({
  label: 'verdict discipline',
  type: 'structured' as const,
  checker: 'dimension-coverage',
  match: '<structured:dimension-coverage:verdict>',
  args: { dimensions: ['daemon-runtime-sdk'], requiredVerdicts, minReasonChars: 20 },
});

const GAP_LINE =
  '- [4] daemon-runtime-sdk: gap — the cap is cloud-only, the local LLM path never learns it | src/lib/scorer.ts:2';

describe('dimension-coverage — a pinned verdict must sit on that dimension own keyed line', () => {
  it('passes when the dimension carries the required verdict AND on-disk evidence', () => {
    const r = matchCriterion(verdictCoverage({ 'daemon-runtime-sdk': 'gap' }), GAP_LINE, ctx());
    expect(r.pass).toBe(true);
    expect(r.details?.join('\n')).toMatch(/verdict `gap` as required/);
  });

  it('FAILS the rubber stamp: verdict flipped to covered while "gap" still occurs in the prose', () => {
    const stamped = `${GAP_LINE.replace('gap —', 'covered —')}\n\nRemaining risk: there is a gap in offline enforcement.`;
    // The old bare-keyword criterion ("surfaces a GAP") is satisfied by this text …
    expect(matchCriterion({ label: 'old', match: '\\b(gap|missing)\\b', type: 'regex', flags: 'is' }, stamped).pass).toBe(
      true,
    );
    // … the pinned-verdict one is not.
    const r = matchCriterion(verdictCoverage({ 'daemon-runtime-sdk': 'gap' }), stamped, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/verdict is `covered` but this dimension must be `gap`/);
  });

  it('FAILS when the line carries no verdict token at all', () => {
    const bare = '- [4] daemon-runtime-sdk: src/lib/scorer.ts:2';
    const r = matchCriterion(verdictCoverage({ 'daemon-runtime-sdk': 'gap' }), bare, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/no verdict token/);
  });

  it('still requires on-disk evidence on a correctly-verdicted gap line', () => {
    const faked = GAP_LINE.replace('src/lib/scorer.ts:2', 'src/lib/ghost.ts:2');
    const r = matchCriterion(verdictCoverage({ 'daemon-runtime-sdk': 'gap' }), faked, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/no verifiable path:line/);
  });

  it('accepts the Chinese verdict token for the same verdict', () => {
    const zh = GAP_LINE.replace('gap —', '缺口 —');
    expect(matchCriterion(verdictCoverage({ 'daemon-runtime-sdk': 'gap' }), zh, ctx()).pass).toBe(true);
  });

  it('fails closed when requiredVerdicts names a dimension outside args.dimensions', () => {
    const r = matchCriterion(verdictCoverage({ 'no-such-dimension': 'gap' }), GAP_LINE, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/requiredVerdicts names dimension\(s\) absent/);
  });

  it('leaves the no-requiredVerdicts behaviour byte-identical (verdict-free lines still pass)', () => {
    expect(matchCriterion(dimensionCoverage(), DIMS_OK, ctx()).pass).toBe(true);
  });
});

// ── doc-sync-obligations ─────────────────────────────────────────────────────

const docSync = () => ({
  label: 'doc sync obligations',
  type: 'structured' as const,
  checker: 'doc-sync-obligations',
  match: '<structured:doc-sync-obligations>',
  args: { deltaFiles: ['sdk/acme/widget/src/index.ts', 'docs/api/widget.md'], minReasonChars: 20 },
});

const WHY_PKG =
  'the delta changed sdk/acme/widget/src/index.ts, and the SDK CHANGELOG rule requires a matching entry per package';
const WHY_DOC = 'the endpoint doc obligation is triggered by docs/api/widget.md being in the changed-file set itself';

const DS_OK = [
  'DELTA: sdk/acme/widget/src/index.ts | class: sdk-package-source',
  'DELTA: docs/api/widget.md | class: endpoint-doc',
  `OBLIGATION: sdk/acme/widget/CHANGELOG.md | required-because: ${WHY_PKG} | satisfied: no`,
  `OBLIGATION: docs/api/widget.md | required-because: ${WHY_DOC} | satisfied: yes`,
  'GAP: sdk/acme/widget/CHANGELOG.md',
].join('\n');

describe('doc-sync-obligations — obligations and gaps are recomputed, not read off the prose', () => {
  it('passes a report whose obligation + gap sets match the recomputation', () => {
    expect(matchCriterion(docSync(), DS_OK, ctx()).pass).toBe(true);
  });

  it('FAILS the false all-clear (claims the CHANGELOG obligation satisfied, flags no gap)', () => {
    const allClear = DS_OK.replace(`${WHY_PKG} | satisfied: no`, `${WHY_PKG} | satisfied: yes`).replace(
      'GAP: sdk/acme/widget/CHANGELOG.md',
      'CHANGELOG 看过了，没有缺口，文档已同步，放行。',
    );
    const r = matchCriterion(docSync(), allClear, ctx());
    expect(r.pass).toBe(false);
    expect(r.details?.join('\n')).toMatch(/report says satisfied=yes, delta says no/);
    expect(r.details?.join('\n')).toMatch(/GAP not flagged/);
  });

  it('FAILS when the obligation is simply omitted', () => {
    const omitted = DS_OK.split('\n')
      .filter((l) => !l.startsWith('OBLIGATION: sdk/acme/widget/CHANGELOG.md'))
      .join('\n');
    expect(matchCriterion(docSync(), omitted, ctx()).details?.join('\n')).toMatch(/omitted: sdk\/acme\/widget\/CHANGELOG\.md/);
  });

  it('FAILS when the declared delta is invented instead of the real diff', () => {
    const invented = DS_OK.replace(/sdk\/acme\/widget\/src\/index\.ts/g, 'sdk/acme/widget/src/ghost.ts');
    const d = matchCriterion(docSync(), invented, ctx()).details?.join('\n') ?? '';
    expect(d).toMatch(/delta not declared/);
    expect(d).toMatch(/delta invented/);
  });

  it('FAILS a required-because that is empty filler', () => {
    const thin = DS_OK.replace(WHY_PKG, 'because');
    expect(matchCriterion(docSync(), thin, ctx()).details?.join('\n')).toMatch(/required-because is empty\/too short/);
  });

  it('FAILS a falsely reported gap (does not reward over-flagging)', () => {
    const over = `${DS_OK}\nGAP: docs/api/widget.md`;
    expect(matchCriterion(docSync(), over, ctx()).details?.join('\n')).toMatch(/GAP falsely flagged: docs\/api\/widget\.md/);
  });
});

// ── back-compat + fail-closed ────────────────────────────────────────────────

describe('structured criteria are additive and fail closed', () => {
  it('leaves substring / regex criteria byte-identical (no ctx needed)', () => {
    const out = 'total: 42 widgets. status: ok.';
    expect(matchCriterion({ match: '42 widgets' }, out).pass).toBe(true);
    expect(matchCriterion({ match: 'status:\\s*ok', type: 'regex' }, out).pass).toBe(true);
    expect(matchCriterion({ match: 'missing' }, out).pass).toBe(false);
  });

  it('treats an unknown checker id as a failed criterion, never a pass', () => {
    const r = matchCriterion(
      { label: 'x', type: 'structured', checker: 'no-such-checker', match: '<structured:no-such-checker>' },
      'anything',
      ctx(),
    );
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/unknown structured checker/);
  });

  it('treats a structured criterion with no checker id as failed', () => {
    const r = matchCriterion({ label: 'x', type: 'structured', match: '<structured:>' }, 'anything', ctx());
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/no `checker` id/);
  });

  it('gates the overall verdict exactly like regex criteria do', () => {
    const mixed = matchAcceptanceCriteria(
      [{ match: 'CHANGE-POINT' }, citedEvidence()],
      REAL_REPORT.replace('src/lib/caller.ts:2', 'src/lib/caller.ts:874'),
      ctx(),
    );
    expect(mixed.ok).toBe(false);
    expect(mixed.results[0]!.pass).toBe(true);
    expect(mixed.results[1]!.pass).toBe(false);
  });

  it('honours required:false for structured criteria too', () => {
    const soft = matchAcceptanceCriteria([{ ...citedEvidence(), required: false }], 'no anchor here', ctx());
    expect(soft.results[0]!.pass).toBe(false);
    expect(soft.ok).toBe(true);
  });
});

// ── gh-claim-readback (apc/17 §3 phase 1 — W1.1 / W1.2) ─────────────────────
//
// The transport is NOT mocked: a real HTTP server speaking GitHub's response
// shapes runs on loopback and the checker reaches it through the same
// `syncHttpGetJson` child-process fetch it uses against api.github.com. Only the
// SERVER is a fixture — every fail-closed decision (no token / transport error /
// non-2xx / id mismatch / cross-repo binding) runs as real logic.
//
// The server must live in its OWN PROCESS: `syncHttpGetJson` is synchronous by
// contract (`execFileSync`), so a server sharing this process's event loop can
// never accept the connection — the readback would deadlock until timeout.
//
// Four negative controls are mandatory (apc/17 W1.1): ① fabricated id,
// ② a real id belonging to a DIFFERENT repo (the §0.10 free-ride shape),
// ③ no token, ④ non-2xx readback.

/**
 * A GitHub REST fixture, written to a temp file and run as its own process.
 * Serves the exact response shapes api.github.com serves (verified live against
 * `cli/cli` while writing this): `pulls/:n` with `base.repo.full_name` +
 * `head.sha`, `actions/runs/:id` with `repository.full_name` + `head_sha`,
 * `commits/:sha/check-runs` with `{total_count, check_runs[]}`, and
 * `branches/:b/protection`.
 */
const GH_FIXTURE_SERVER = `
const { createServer } = require('node:http');
const { appendFileSync } = require('node:fs');
const LOG = process.env.FIX_LOG;
const HEAD = process.env.FIX_HEAD;
const OTHER = process.env.FIX_OTHER;
const GIT = process.env.FIX_GIT;
const iso = (deltaMs) => new Date(Date.now() - (deltaMs || 0)).toISOString();
const pr = (o) => Object.assign({
  number: 7, state: 'open', merged: false, created_at: iso(),
  url: 'https://api.github.com/repos/acme/widget/pulls/7',
  head: { sha: HEAD, repo: { full_name: 'acme/widget' } },
  base: { repo: { full_name: 'acme/widget' } },
}, o);
const run = (o) => Object.assign({
  id: 111, status: 'completed', conclusion: 'success', head_sha: HEAD,
  created_at: iso(), repository: { full_name: 'acme/widget' },
}, o);
const server = createServer((req, res) => {
  const raw = req.url || '';
  const boom = raw.indexOf('/boom') === 0;
  const url = boom ? raw.slice(5) : raw;
  appendFileSync(LOG, url + '\\t' + (req.headers.authorization || '') + '\\n');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (boom) return json(500, { message: 'Server Error' });
  if (url === '/repos/acme/widget/pulls/7') return json(200, pr());
  if (url === '/repos/acme/widget/pulls/8')
    return json(200, pr({ number: 8, base: { repo: { full_name: 'other/thing' } } }));
  if (url === '/repos/acme/widget/pulls/9')
    return json(200, pr({ number: 9, head: { sha: OTHER, repo: { full_name: 'acme/widget' } } }));
  if (url === '/repos/acme/widget/pulls/10')
    return json(200, pr({ number: 10, created_at: iso(90 * 60000) }));
  if (url === '/repos/acme/widget/pulls/11')
    return json(200, pr({ number: 11, head: { sha: GIT, repo: { full_name: 'acme/widget' } } }));
  if (url === '/repos/acme/widget/actions/runs/111') return json(200, run());
  if (url === '/repos/acme/widget/actions/runs/222')
    return json(200, run({ id: 222, repository: { full_name: 'other/thing' } }));
  if (url.indexOf('/repos/acme/widget/commits/' + HEAD + '/check-runs') === 0)
    return json(200, { total_count: 2, check_runs: [
      { name: 'build (ubuntu-latest)', status: 'completed', conclusion: 'success', head_sha: HEAD },
      { name: 'lint', status: 'completed', conclusion: 'failure', head_sha: HEAD },
    ] });
  if (url === '/repos/acme/widget/branches/main/protection')
    return json(200, {
      url: 'https://api.github.com/repos/acme/widget/branches/main/protection',
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: true },
    });
  if (url === '/repos/acme/widget/branches/locked/protection')
    return json(403, { message: 'Resource not accessible by personal access token' });
  return json(404, { message: 'Not Found' });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

describe('gh-claim-readback — a claim is verified against GitHub, not against the report', () => {
  const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const OTHER_SHA = 'b'.repeat(40);
  let child: import('node:child_process').ChildProcess;
  let apiBase = '';
  let fixDir = '';
  let logPath = '';
  let gitRepo = '';
  let gitHead = '';

  /** Every request the fixture server has served: `url\tauthorization`. */
  const reqLog = (): string[] => {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  // ⚠️ 显式 60s hook 预算（全局是 vitest.config.ts 的 `hookTimeout: 10_000`）。
  // 这个 hook 干的是真活：2 次 mkdtemp + **5 个 git 子进程** + spawn 一个 node
  // fixture server + 等端口就绪。直跑实测 ~10023ms —— 只富余 **0.2%**，于是
  // 被 `scripts/test203/run.ts` 嵌套调用时（多一层 npx + 并发负载，runtime 层
  // 112.3s vs 直跑 90-106s，+6~24%）**确定性**顶穿，报 `Hook timed out in 10000ms`
  // 且连带 16 个 it 被 skip。
  //
  // 症状极具误导性：`46 passed / 16 skipped / 0 failed assertion` —— 没有任何
  // 断言失败，却让 `apc test --tier=T0` 退 1、`apc release tag` 恒 blocked
  // （实测独立跑 3/3 绿、经 release tag 跑 7/7 红，无一次交叉 ⇒ 结构性而非抖动）。
  // 这一格挡住了 MVP 样例 1 的「版本产物」环。
  //
  // 只加时间预算，**一条断言未动**；真挂死仍会在 60s 处失败。
  beforeAll(async () => {
    const { execFileSync, spawn } = await import('node:child_process');

    // a real one-commit git repo for the W1.2 three-way binding.
    gitRepo = mkdtempSync(join(tmpdir(), 'apc-gh-git-'));
    const git = (...argv: string[]) =>
      execFileSync('git', ['-C', gitRepo, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'apc@example.invalid');
    git('config', 'user.name', 'apc');
    writeFileSync(join(gitRepo, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'seed');
    gitHead = git('rev-parse', 'HEAD');

    fixDir = mkdtempSync(join(tmpdir(), 'apc-gh-fixture-'));
    logPath = join(fixDir, 'requests.log');
    const serverPath = join(fixDir, 'github-fixture.cjs');
    writeFileSync(serverPath, GH_FIXTURE_SERVER);
    child = spawn(process.execPath, [serverPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        FIX_LOG: logPath,
        FIX_HEAD: HEAD_SHA,
        FIX_OTHER: OTHER_SHA,
        FIX_GIT: gitHead,
      },
    });
    const port = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error('fixture server did not announce a port')), 10_000);
      child.stdout!.once('data', (b: Buffer) => {
        clearTimeout(t);
        res(Number(String(b).trim()));
      });
    });
    apiBase = `http://127.0.0.1:${port}`;

    process.env.APC_GH_TOKEN = 'fixture-token-not-a-secret';
  }, 60_000);

  afterAll(() => {
    delete process.env.APC_GH_TOKEN;
    child?.kill('SIGKILL');
    rmSync(gitRepo, { recursive: true, force: true });
    rmSync(fixDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFileSync(logPath, '');
  });

  const gh = (args: Record<string, unknown> = {}) => ({
    label: 'gh readback',
    type: 'structured' as const,
    checker: 'gh-claim-readback',
    match: '<structured:gh-claim-readback>',
    args: { apiBase, repo: 'acme/widget', ...args },
  });

  const REPORT = [
    'GH-REPO: acme/widget',
    `SHA: ${HEAD_SHA}`,
    `PR: 7 | head: ${HEAD_SHA} | state: open`,
    'RUN: 111 | conclusion: success | status: completed',
    'CHECK: build (ubuntu-latest) = success',
    'PROTECTION: main | required_reviews: 1 | enforce_admins: true',
  ].join('\n');

  // ── positive control ──
  it('goes green on real server-side objects and reports the facts it read back', () => {
    const r = matchCriterion(gh({ require: ['pr', 'run', 'check', 'protection', 'sha'] }), REPORT, ctx());
    const d = (r.details ?? []).join('\n');
    expect(r.pass).toBe(true);
    expect(d).toMatch(new RegExp(`PR acme/widget#7 exists server-side at head\\.sha ${HEAD_SHA.slice(0, 12)}`));
    expect(d).toMatch(/RUN 111 on acme\/widget read back as completed\/success/);
    expect(d).toMatch(/CHECK `build \(ubuntu-latest\)` = success/);
    expect(d).toMatch(/branch protection on acme\/widget@main/);
    // the credential really travels on the wire (it is not "verified" locally),
    // and all four endpoints were really hit.
    const log = reqLog();
    expect(log.length).toBe(4);
    expect(log.every((l) => l.endsWith('\tBearer fixture-token-not-a-secret'))).toBe(true);
  });

  // ── negative control ① — fabricated id ──
  it('① a fabricated PR number is red (404 is not "could not verify", it is a failed claim)', () => {
    const r = matchCriterion(gh(), REPORT.replace('PR: 7 |', 'PR: 4242 |'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/PR #4242 could not be read back from acme\/widget \(HTTP 404\)/);
  });

  it('① a fabricated run id is red', () => {
    const r = matchCriterion(gh(), REPORT.replace('RUN: 111', 'RUN: 999999'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/RUN 999999 could not be read back/);
  });

  it('① a check-run name that never ran is red, and the server-side list is quoted back', () => {
    const r = matchCriterion(gh(), REPORT.replace('CHECK: build (ubuntu-latest) = success', 'CHECK: e2e = success'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/CHECK `e2e` does not exist on acme\/widget@.*GitHub reports build \(ubuntu-latest\), lint/s);
  });

  // ── negative control ② — a REAL id that belongs to another repo/commit ──
  it('② a real PR that belongs to another repository is red (cross-binding free-ride)', () => {
    const r = matchCriterion(gh(), REPORT.replace('PR: 7 |', 'PR: 8 |'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(
      /PR #8 read back belongs to `other\/thing`, not the declared `acme\/widget`/,
    );
  });

  it('② a real run that belongs to another repository is red', () => {
    const r = matchCriterion(gh(), REPORT.replace('RUN: 111', 'RUN: 222'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/RUN 222 read back belongs to `other\/thing`/);
  });

  it('② a real PR whose head is a different commit than the report claims is red', () => {
    const r = matchCriterion(gh(), REPORT.replace('PR: 7 |', 'PR: 9 |'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/declares head `a1b2c3d4e5f6.*but GitHub says its head\.sha is `bbbb/);
  });

  it('② a green PR opened long before this run is red under maxAgeMinutes (free-ride on an existing PR)', () => {
    const older = REPORT.replace('PR: 7 |', 'PR: 10 |');
    expect(matchCriterion(gh({ maxAgeMinutes: 30 }), older, ctx()).pass).toBe(false);
    expect(matchCriterion(gh({ maxAgeMinutes: 30 }), REPORT, ctx()).pass).toBe(true);
  });

  it('② a repo pinned in skill.json cannot be swapped for the agent own fork', () => {
    const forked = REPORT.replace('GH-REPO: acme/widget', 'GH-REPO: agent/fork');
    const r = matchCriterion(gh(), forked, ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/GH-REPO is `agent\/fork` but this task is pinned to `acme\/widget`/);
  });

  // ── negative control ③ — no token ──
  it('③ no credential is red, and the checker never even reaches the network', () => {
    const saved = process.env.APC_GH_TOKEN;
    delete process.env.APC_GH_TOKEN;
    try {
      const r = matchCriterion(gh(), REPORT, ctx());
      expect(r.pass).toBe(false);
      expect((r.details ?? []).join('\n')).toMatch(/no GitHub readback credential in env \(APC_GH_TOKEN\)/);
      expect(reqLog()).toEqual([]);
    } finally {
      process.env.APC_GH_TOKEN = saved;
    }
  });

  // ── negative control ④ — non-2xx readback ──
  it('④ a non-2xx readback is red, never degraded to env_blocked', () => {
    const r = matchCriterion(gh({ apiBase: `${apiBase}/boom` }), REPORT, ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/could not be read back from acme\/widget \(HTTP 500\)/);
  });

  it('④ an unreachable API is red (transport error is a failed claim)', () => {
    const r = matchCriterion(gh({ apiBase: 'http://127.0.0.1:1', timeoutMs: 5000 }), REPORT, ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/could not be read back/);
  });

  it('④ a 403 on branch protection stays red — the read-only boundary is evidence, not an excuse', () => {
    const r = matchCriterion(gh(), REPORT.replace('PROTECTION: main |', 'PROTECTION: locked |'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/branch protection for acme\/widget@locked could not be read back \(HTTP 403\)/);
  });

  // ── declaration hygiene ──
  it('a report that declares nothing readable is red, not vacuously green', () => {
    expect(matchCriterion(gh(), 'I opened a PR and CI was green.', ctx()).pass).toBe(false);
    expect(matchCriterion(gh(), 'GH-REPO: acme/widget\nCI was green.', ctx()).pass).toBe(false);
    expect(matchCriterion(gh({ require: ['run'] }), 'GH-REPO: acme/widget\nPR: 7', ctx()).pass).toBe(false);
  });

  it('a declared conclusion that disagrees with the Checks API is red', () => {
    const r = matchCriterion(gh(), REPORT.replace('CHECK: build (ubuntu-latest) = success', 'CHECK: lint = success'), ctx());
    expect(r.pass).toBe(false);
    expect((r.details ?? []).join('\n')).toMatch(/CHECK `lint` concluded `failure` server-side, report declared `success`/);
  });

  // ── W1.2: report ⇄ working tree ⇄ GitHub must be the same commit ──
  it('W1.2 binds the server head sha to `git rev-parse HEAD`; a tree that moved on is red', async () => {
    const bound = ['GH-REPO: acme/widget', `SHA: ${gitHead}`, `PR: 11 | head: ${gitHead}`].join('\n');
    const green = matchCriterion(gh({ headShaMustEqualLocal: true }), bound, { cwd: gitRepo });
    expect(green.pass).toBe(true);
    expect((green.details ?? []).join('\n')).toMatch(/three-way bound/);

    // the faithful injection (apc/17 W1.2): local HEAD advances one commit and
    // the report is not updated. Nothing about the server-side facts changed.
    const { execFileSync } = await import('node:child_process');
    const git = (...argv: string[]) =>
      execFileSync('git', ['-C', gitRepo, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    writeFileSync(join(gitRepo, 'b.txt'), 'b\n');
    git('add', 'b.txt');
    git('commit', '-q', '-m', 'moved on');
    const moved = matchCriterion(gh({ headShaMustEqualLocal: true }), bound, { cwd: gitRepo });
    expect(moved.pass).toBe(false);
    expect((moved.details ?? []).join('\n')).toMatch(
      new RegExp(`GitHub carries the claim at ${gitHead.slice(0, 12)} but this working tree is at`),
    );

    // and a tree that is not a repository at all cannot be waved through either.
    const noRepo = matchCriterion(gh({ headShaMustEqualLocal: true }), bound, ctx());
    expect(noRepo.pass).toBe(false);
    expect((noRepo.details ?? []).join('\n')).toMatch(/`git rev-parse HEAD` failed/);
  });
});
