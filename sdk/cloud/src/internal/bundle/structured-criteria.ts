// Structured acceptance checkers (apc/12 — skill acceptance hardening).
//
// WHY THIS FILE EXISTS
// --------------------
// `matchCriterion` (bundle/index.ts) scores a skill sample-task by running a
// regex over the agent's REPORT TEXT. That can only ever prove "the report
// contains the right-shaped words" — it cannot distinguish a real run from a
// fabricated one. apc/12 recorded the empirical proof: an impact-trace report
// with zero `rg` runs and invented path:line pairs scored 6/6 PASS.
//
// A structured checker instead parses declared, machine-readable claims out of
// the report and RE-VERIFIES them against the filesystem (the same ground truth
// `rg` reads) or recomputes them from the task's declared input. A fabricated
// claim therefore fails on a fact, not on a word.
//
// Contract (skill.json):
//   { "label": "...", "type": "structured", "checker": "<id>",
//     "args": { ... }, "match": "<structured:...>", "required": true }
//
// Back-compat: `type` stays optional and defaults to 'substring'; every
// existing regex/substring criterion is untouched. An OLD scorer (or the CLI's
// current `normalizeCriterion`, which drops unknown fields) degrades a
// structured criterion to a substring match on `match` — which is written as a
// sentinel that never occurs in a report, so degradation FAILS CLOSED.
//
// I/O note: checkers are SYNCHRONOUS by contract — `matchCriterion` /
// `matchAcceptanceCriteria` must stay non-async (two CLI call sites and every
// caller of the scorer depend on it). Disk reads use `readFileSync`; the two
// checkers that need a *runtime* side effect as ground truth (a live task row,
// a real git object) reach it through a SYNCHRONOUS CHILD PROCESS
// (`execFileSync`) rather than turning the scorer async:
//   - `declared-id-readback` → `node -e "fetch(...)"` (see syncHttpGetJson)
//   - `git-claim-readback`   → read-only `git -C <repo> …` plumbing
//   - `gh-claim-readback`    → the same sync fetch, aimed at GitHub's REST API
//                              (the only checker here whose ground truth is not
//                              writable by the process being judged)
// No shell is used anywhere (execFileSync with an argv array), and every id /
// path parsed out of a report is syntax-checked before it reaches an argv.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export interface StructuredCheckerContext {
  /** Repo root the report's paths are relative to. Defaults to process.cwd(). */
  cwd: string;
}

export interface StructuredCheckerOutcome {
  pass: boolean;
  /** Human-readable evidence lines — why it passed / exactly what was fake. */
  details: string[];
}

export type StructuredChecker = (
  output: string,
  args: Record<string, unknown>,
  ctx: StructuredCheckerContext,
) => StructuredCheckerOutcome;

// ── shared: citation parsing + filesystem re-verification ────────────────────

// `%` is IN the path class on purpose. 19 real files in this repo live under
// `src/app/api/sandboxes/%5Fadmin/…` (the URL-encoded `_admin` segment of the
// debug pipeline). Without `%`, the match started AFTER it and produced
// `5Fadmin/runtime-releases/route.ts:261` — a path that does not exist — so a
// report citing one of those real files was judged FAKE. For `cited-evidence`
// (`bad.length > 0 ⇒ fail`) that is an unconditional red on a TRUTHFUL report,
// which is the same class of bug as greening a fabricated one. `%` is also
// added to the lookbehind's exclusion set so the regex cannot start mid-path.
const CITATION_RE =
  /(?<![\w/.\-%])((?:[\w.\-%]+\/)*[\w.\-%]+\.(?:ts|tsx|js|jsx|mjs|cjs|prisma|sql|md|json|sh|py|yml|yaml)):(\d+)/g;

export interface Citation {
  path: string;
  line: number;
  raw: string;
}

/**
 * A line whose ENTIRE content is one bare `path:number` token — which is exactly
 * the shape `rg -c` emits (`src/foo.ts:12` = twelve HITS, not line twelve).
 * The impact-trace contract orders a `rg -c` reconciliation run, so pasting that
 * output is compliant behaviour; feeding those counts to `verifyCitation` as if
 * they were line numbers made a 100%-truthful report go red (e2e R3: all five
 * "FAKE" verdicts came from here). A real claim never stands alone on its own
 * line — it sits in a table cell, on a keyed dimension line, or inside prose —
 * so skipping count-only lines costs no strictness.
 */
const COUNT_ONLY_LINE_RE = /^[\s>*+\-•]*(?:[\w.\-%]+\/)*[\w.\-%]+\.\w+:\d+[\s,;，；]*$/;

/**
 * Every `path:line` pair in the text (repo-relative paths only).
 *
 * Stays literal on purpose — callers pass single-line FRAGMENTS to it (a keyed
 * dimension line's value is often exactly one bare `path:line`), so the
 * count-line tolerance must NOT live here. It lives in `parseClaimCitations`,
 * which is the whole-report entry point.
 */
export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    out.push({ path: m[1]!, line: Number.parseInt(m[2]!, 10), raw: m[0]! });
  }
  return out;
}

/**
 * Every `path:line` the report CLAIMS, scanning a MULTI-LINE report: identical
 * to `parseCitations` except that lines which are nothing but a bare
 * `path:number` (i.e. pasted `rg -c` counts) are skipped. See
 * COUNT_ONLY_LINE_RE for why.
 */
export function parseClaimCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const line of text.split('\n')) {
    if (COUNT_ONLY_LINE_RE.test(line)) continue;
    out.push(...parseCitations(line));
  }
  return out;
}

export interface CitationVerdict {
  citation: Citation;
  ok: boolean;
  reason?: string;
  /** Content of the cited line when it resolved. */
  lineText?: string;
}

const fileCache = new Map<string, string[] | null>();

function readLines(abs: string): string[] | null {
  if (fileCache.has(abs)) return fileCache.get(abs)!;
  let lines: string[] | null = null;
  try {
    if (statSync(abs).isFile()) lines = readFileSync(abs, 'utf8').split('\n');
  } catch {
    lines = null;
  }
  fileCache.set(abs, lines);
  return lines;
}

/**
 * Re-verify one `path:line` claim against disk: the file must exist, the line
 * number must be inside it, and the line must not be blank. This is what makes
 * an invented citation red — a fabricator can produce the SHAPE `foo.ts:123`
 * but not make `foo.ts` have a non-blank line 123.
 */
export function verifyCitation(c: Citation, ctx: StructuredCheckerContext): CitationVerdict {
  if (isAbsolute(c.path)) return { citation: c, ok: false, reason: 'absolute path (not a repo-relative citation)' };
  const abs = resolve(ctx.cwd, c.path);
  const lines = readLines(abs);
  if (!lines) {
    return {
      citation: c,
      ok: false,
      reason:
        'file does not exist at that path — citations must be REPO-ROOT-RELATIVE ' +
        '(`src/lib/foo.ts:42`, not an abbreviated `lib/foo.ts:42`)',
    };
  }
  if (c.line < 1 || c.line > lines.length) {
    return {
      citation: c,
      ok: false,
      reason:
        `line out of range (file has ${lines.length} lines) — note an \`rg -c\` HIT COUNT is not a line number; ` +
        'write counts as `count=N`',
    };
  }
  const lineText = lines[c.line - 1] ?? '';
  if (lineText.trim() === '') return { citation: c, ok: false, reason: 'cited line is blank' };
  return { citation: c, ok: true, lineText };
}

function argNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function argStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Count of non-whitespace chars — stops "N/A —   " passing as a reason. */
function reasonWeight(s: string): number {
  return s.replace(/\s+/gu, '').length;
}

const NA_RE = /^(?:n\s*\/\s*a|不适用|无)(?![\w])[\s—–\-:：,，。]*/iu;

// Verdict token a dimension line may be REQUIRED to open with (design-review).
// Parsed non-destructively — the N/A and citation checks below still see the
// whole value, so adding this changes nothing for callers that don't ask for it.
const VERDICT_RE = /^(covered|gap|n\s*\/\s*a|已覆盖|覆盖|缺口|缺失|不适用)(?![\w])[\s—–\-:：,，。|｜]*/iu;

function normalizeVerdict(raw: string): string {
  const v = raw.toLowerCase().replace(/\s+/gu, '');
  if (v === 'covered' || v === '已覆盖' || v === '覆盖') return 'covered';
  if (v === 'gap' || v === '缺口' || v === '缺失') return 'gap';
  return 'n/a';
}

// ── checker: cited-evidence ──────────────────────────────────────────────────
// Replaces the hollow regex `[\w./-]+\.(ts|…):\d+` ("some path:line shape
// occurs somewhere"). Verifies instead:
//   1. the report DECLARES its change point (`CHANGE-POINT: <symbol> @ <path>`)
//      and that symbol really occurs in that file  → no canned symbol, the
//      anchor is whatever THIS task's change point is, but it must be real;
//   2. EVERY repo-relative path:line in the report resolves to a real,
//      non-blank line  → invented citations are red;
//   3. at least `minAnchoredRows` citations land on lines that actually contain
//      the change-point symbol  → citations must be real SEARCH HITS, not just
//      real lines;
//   4. the impact table has at least `minRows` rows carrying a citation;
//   5. optionally (`minDistinctAnchorFiles`, default off) those anchored hits are
//      spread over N DISTINCT files → see below.
//
// Why (5) exists: (1)-(4) are all satisfiable from a SINGLE real search hit.
// A report that runs `rg` once (or just copies the one real path the task prompt
// itself hands out), then pastes that same `path:line` into every impact row and
// under every dimension, has every citation resolve on disk AND every citation
// land on a line containing the symbol — measured green at 5/5 while doing zero
// blast-radius work. Requiring the anchored hits to span N distinct files makes
// the cheapest forgery cost exactly what the real work costs: N real hits.
// The arg is per-sample-task (it asserts how wide THIS change point really is);
// absent, the checker is byte-identical to before.
export const citedEvidenceChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const minRows = argNumber(args, 'minRows', 3);
  const minAnchored = argNumber(args, 'minAnchoredRows', 3);
  const anchorMinLength = argNumber(args, 'anchorMinLength', 4);
  const minDistinctAnchorFiles = argNumber(args, 'minDistinctAnchorFiles', 0);

  // Leading class carries a BACKTICK on purpose: the shipped contract's own
  // example wraps the WHOLE line in backticks (`CHANGE-POINT: sym @ path`).
  // Without it, an agent that copied the contract verbatim got
  // "no CHANGE-POINT declaration found" — a criterion that reds a perfectly
  // faithful report is the same class of bug as one that greens a fabricated
  // one. The trailing wrap backtick is already eaten by the `?` after the path.
  const decl = output.match(
    /^[\s>*\-|`]*CHANGE-POINT\s*[:：]\s*`?([A-Za-z_$][\w$.\-]*)`?\s*(?:@|at|＠)\s*`?((?:[\w.\-]+\/)*[\w.\-]+\.\w+)`?/im,
  );
  if (!decl) {
    details.push(
      'no `CHANGE-POINT: <symbol> @ <path>` declaration found — the report must name the change point it traced',
    );
    return { pass: false, details };
  }
  const symbol = decl[1]!;
  const anchorPath = decl[2]!;
  if (symbol.length < anchorMinLength) {
    details.push(`change-point symbol "${symbol}" is shorter than anchorMinLength=${anchorMinLength}`);
    return { pass: false, details };
  }
  const anchorLines = readLines(resolve(ctx.cwd, anchorPath));
  if (!anchorLines) {
    details.push(`declared change-point file does not exist: ${anchorPath}`);
    return { pass: false, details };
  }
  if (!anchorLines.some((l) => l.includes(symbol))) {
    details.push(`declared change-point symbol "${symbol}" does not occur in ${anchorPath}`);
    return { pass: false, details };
  }
  // Optional: bind the declared change point to the one this sample task GAVE
  // (task input, not the answer). Replaces the old canned-symbol regex: that
  // one only proved the string occurred somewhere in the prose; this proves the
  // report traced the change point it was asked to trace AND that it is real.
  const expected = args.expectedChangePoint;
  if (expected && typeof expected === 'object') {
    const e = expected as Record<string, unknown>;
    if (typeof e.symbol === 'string' && e.symbol !== symbol) {
      details.push(`report traced "${symbol}" but this task's change point is "${e.symbol}"`);
      return { pass: false, details };
    }
    if (typeof e.path === 'string' && e.path !== anchorPath) {
      details.push(`report anchored on ${anchorPath} but this task's change point lives in ${e.path}`);
      return { pass: false, details };
    }
  }
  details.push(`change point verified on disk: ${symbol} @ ${anchorPath}`);

  const citations = parseClaimCitations(output);
  if (citations.length === 0) {
    details.push('report cites no repo-relative path:line evidence at all');
    return { pass: false, details };
  }
  const verdicts = citations.map((c) => verifyCitation(c, ctx));
  const bad = verdicts.filter((v) => !v.ok);
  const anchored = verdicts.filter((v) => v.ok && (v.lineText ?? '').includes(symbol));

  for (const b of bad.slice(0, 12)) details.push(`FAKE citation ${b.citation.raw}: ${b.reason}`);
  if (bad.length > 12) details.push(`… and ${bad.length - 12} more unverifiable citations`);

  const rows = output
    .split('\n')
    .filter((l) => /^[\s>]*(?:\||IMPACT-ROW\s*[:：])/.test(l))
    .filter((l) => parseCitations(l).some((c) => verifyCitation(c, ctx).ok));

  const anchorFiles = new Set(anchored.map((v) => v.citation.path));

  details.push(
    `citations: ${verdicts.length} total, ${verdicts.length - bad.length} verified on disk, ` +
      `${anchored.length} landing on a line containing "${symbol}" across ${anchorFiles.size} distinct file(s); ` +
      `impact rows with a verified citation: ${rows.length}`,
  );

  if (bad.length > 0) return { pass: false, details };
  if (anchored.length < minAnchored) {
    details.push(
      `only ${anchored.length} citation(s) actually land on a line containing "${symbol}" — need ≥ ${minAnchored}. ` +
        'Real path:line that is not a real search hit is not evidence.',
    );
    return { pass: false, details };
  }
  if (anchorFiles.size < minDistinctAnchorFiles) {
    details.push(
      `anchored hits span only ${anchorFiles.size} distinct file(s) (${[...anchorFiles].join(', ')}) — need ≥ ` +
        `${minDistinctAnchorFiles}. One real hit repeated across every row and dimension is a one-hit report, ` +
        'not a blast radius.',
    );
    return { pass: false, details };
  }
  if (rows.length < minRows) {
    details.push(`impact table has ${rows.length} evidence-carrying row(s) — need ≥ ${minRows}`);
    return { pass: false, details };
  }
  return { pass: true, details };
};

// ── checker: dimension-coverage ──────────────────────────────────────────────
// Replaces the bare-substring dimension criteria (e.g. `match:"prisma"`, which
// any stray `npm run prisma:generate` satisfied). Each declared dimension KEY
// must be present as its own answered line, and its answer must be either a
// verified citation or an explicit N/A with a real reason.
//
// Optional `args.requiredVerdicts` = { "<dimension>": "covered"|"gap"|"n/a" }
// additionally pins the VERDICT that dimension must carry, read off that
// dimension's own keyed line. This is what makes design-review's load-bearing
// oracle real: without it, "covered ×5 with real citations + the word GAP
// somewhere in the prose" is a rubber stamp that scores green — precisely the
// silent-skip the five-dimension audit exists to catch. Absent the arg the
// checker behaves exactly as before; present but unparseable ⇒ fail closed.
//
// Optional `args.anchorToKey` = { minAnchored?, aliases?, caseInsensitive? }
// closes a hole where the LABEL PROMISED MORE THAN THE CODE DID. The shipped
// labels say "each citing the manifest line that DECLARES it", but
// `verifyCitation` only proves the file exists, the line is in range and it is
// not blank — so pointing all 21 dimensions at ONE real line (`manifest.ts:165`,
// which declares only `infra.docker-daemon`) scored a full green. With this arg
// set, at least `minAnchored` (default 1) of a dimension's own citations must
// land on a line whose TEXT contains that dimension's key (or a declared
// alias) — the same anchored-hit discipline `cited-evidence` already applies.
// Absent the arg the checker is byte-identical to before, so criteria that
// were verified under the old behaviour are not retroactively reddened.
//
// Optional `args.distinctCitations` = { maxDimensionsPerCitation?: number }
// closes the SAME hole for the skills where `anchorToKey` cannot apply. In
// impact-trace the citation under a dimension is a search hit for the traced
// SYMBOL — the cited line has no reason to contain the string "dual-prisma", so
// anchoring to the key would red truthful reports. What is still forgeable there
// is breadth: pasting ONE real hit under all six dimensions passes every
// existing check. This arg caps how many distinct dimensions may lean on the
// same `path:line`, which a real six-dimension walk never needs and a one-hit
// report cannot satisfy. N/A dimensions are unaffected (they carry no citation).
export const dimensionCoverageChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const dims = argStringArray(args, 'dimensions');
  const minReasonChars = argNumber(args, 'minReasonChars', 20);
  // `anchorToKey` must fail LOUD when malformed, not silently skip. It is the
  // guard for F1 (label promised more than the code did), so a JSON typo
  // (`anchorTokey`) or a wrong shape (`true`, `[{…}]`, `"minAnchored:1"`) that
  // silently returned the pre-fix behaviour would show ALL GREEN while the hole
  // it exists to close is wide open — the exact "guard that is only decorative"
  // shape this whole criteria overhaul is hunting. Every other misconfiguration
  // in this file already fails closed (args.dimensions :below, requiredVerdicts,
  // deltaFiles, json-claim's args, allowed.*); this one was the odd one out.
  const anchorRaw = args.anchorToKey;
  const anchorPresent = anchorRaw !== undefined && anchorRaw !== null;
  const anchorToKey = argRecord(args, 'anchorToKey');
  if (anchorPresent && !anchorToKey) {
    return {
      pass: false,
      details: [
        'checker misconfigured: args.anchorToKey must be an object like ' +
          '{ minAnchored?: number, aliases?: Record<string,string[]>, caseInsensitive?: boolean } — ' +
          `got ${Array.isArray(anchorRaw) ? 'array' : typeof anchorRaw}. Refusing to score: silently ` +
          'ignoring it would restore the pre-fix behaviour while reporting green.',
      ],
    };
  }
  // Same fail-loud discipline as anchorToKey: a typo'd or wrong-shaped arg must
  // not silently restore the pre-fix behaviour while reporting green.
  const distinctRaw = args.distinctCitations;
  const distinctPresent = distinctRaw !== undefined && distinctRaw !== null;
  const distinctCitations = argRecord(args, 'distinctCitations');
  if (distinctPresent && !distinctCitations) {
    return {
      pass: false,
      details: [
        'checker misconfigured: args.distinctCitations must be an object like ' +
          `{ maxDimensionsPerCitation?: number } — got ${Array.isArray(distinctRaw) ? 'array' : typeof distinctRaw}. ` +
          'Refusing to score: silently ignoring it would restore the pre-fix behaviour while reporting green.',
      ],
    };
  }
  const maxDimsPerCitation = distinctCitations
    ? argNumber(distinctCitations, 'maxDimensionsPerCitation', 1)
    : 0;
  /** verified `path:line` → the dimensions that used it as evidence. */
  const citationUsers = new Map<string, string[]>();
  const anchorMin = anchorToKey ? argNumber(anchorToKey, 'minAnchored', 1) : 0;
  const anchorCI = anchorToKey ? anchorToKey.caseInsensitive !== false : false;
  const anchorAliases = anchorToKey ? argRecord(anchorToKey, 'aliases') ?? {} : {};
  if (dims.length === 0) return { pass: false, details: ['checker misconfigured: args.dimensions is empty'] };

  const rv = args.requiredVerdicts;
  const requiredVerdicts: Record<string, string> =
    rv && typeof rv === 'object' && !Array.isArray(rv)
      ? Object.fromEntries(Object.entries(rv as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<
          string,
          string
        >
      : {};
  const strayVerdictKeys = Object.keys(requiredVerdicts).filter((k) => !dims.includes(k));
  if (strayVerdictKeys.length > 0) {
    return {
      pass: false,
      details: [
        `checker misconfigured: requiredVerdicts names dimension(s) absent from args.dimensions: ${strayVerdictKeys.join(', ')}`,
      ],
    };
  }

  const missing: string[] = [];
  const bad: string[] = [];
  for (const key of dims) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `^[\\s>*+\\-|]*(?:DIM(?:ENSION)?\\s*)?(?:\\[\\s*\\d+\\s*\\]|\\(\\s*\\d+\\s*\\)|\\d+[.)])?\\s*\`?${esc}\`?\\s*[:：|]\\s*(.+)$`,
      'im',
    );
    const m = output.match(re);
    if (!m) {
      missing.push(key);
      continue;
    }
    const value = (m[1] ?? '').trim();

    const wanted = requiredVerdicts[key];
    if (typeof wanted === 'string') {
      const vm = value.match(VERDICT_RE);
      if (!vm) {
        bad.push(
          `${key}: no verdict token — this dimension's line must OPEN with \`covered\` / \`gap\` / \`N/A\` ` +
            `(this task requires \`${normalizeVerdict(wanted)}\`)`,
        );
        continue;
      }
      const got = normalizeVerdict(vm[1]!);
      if (got !== normalizeVerdict(wanted)) {
        bad.push(
          `${key}: verdict is \`${got}\` but this dimension must be \`${normalizeVerdict(wanted)}\` — ` +
            'the load-bearing finding cannot be rubber-stamped, and the word appearing elsewhere in the report does not count',
        );
        continue;
      }
      details.push(`${key}: verdict \`${got}\` as required`);
    }

    const na = value.match(NA_RE);
    if (na) {
      const reason = value.slice(na[0].length).trim();
      if (reasonWeight(reason) < minReasonChars) {
        bad.push(`${key}: marked N/A with no (or too short) reason — need ≥ ${minReasonChars} non-space chars`);
      } else {
        details.push(`${key}: N/A with reason (${reasonWeight(reason)} chars)`);
      }
      continue;
    }
    const verified = parseCitations(value)
      .map((c) => verifyCitation(c, ctx))
      .filter((v) => v.ok);
    if (verified.length === 0) {
      bad.push(`${key}: answered but carries no verifiable path:line evidence (and is not an explicit N/A + reason)`);
      continue;
    }
    if (distinctCitations) {
      for (const v of verified) {
        const id = `${v.citation.path}:${v.citation.line}`;
        const users = citationUsers.get(id) ?? [];
        if (!users.includes(key)) users.push(key);
        citationUsers.set(id, users);
      }
    }
    if (anchorToKey) {
      const aliasRaw = anchorAliases[key];
      const rawTokens = [
        key,
        ...(Array.isArray(aliasRaw) ? aliasRaw.filter((x): x is string => typeof x === 'string') : []),
      ];
      const tokens = anchorCI ? rawTokens.map((t) => t.toLowerCase()) : rawTokens;
      const anchored = verified.filter((v) => {
        const text = anchorCI ? (v.lineText ?? '').toLowerCase() : v.lineText ?? '';
        return tokens.some((t) => text.includes(t));
      });
      if (anchored.length < anchorMin) {
        bad.push(
          `${key}: ${verified.length} citation(s) resolve on disk but ${anchored.length} land on a line that actually ` +
            `mentions \`${rawTokens.join('` / `')}\` — need ≥ ${anchorMin}. A real file:line that does not DECLARE this ` +
            'dimension is not evidence for it (one real line pasted under every dimension is the failure mode here)',
        );
        continue;
      }
      details.push(`${key}: ${verified.length} verified citation(s), ${anchored.length} anchored on its own declaration`);
      continue;
    }
    details.push(`${key}: ${verified.length} verified citation(s)`);
  }

  if (distinctCitations) {
    const overused = [...citationUsers.entries()].filter(([, users]) => users.length > maxDimsPerCitation);
    for (const [id, users] of overused) {
      bad.push(
        `${id} is cited as evidence for ${users.length} dimensions (${users.join(', ')}) — at most ` +
          `${maxDimsPerCitation} may share one path:line. One real search hit pasted under every dimension is a ` +
          'one-hit report, not a walked blast radius.',
      );
    }
    if (overused.length === 0) {
      details.push(
        `distinct-citation check: ${citationUsers.size} distinct path:line across the cited dimensions, ` +
          `none shared by more than ${maxDimsPerCitation}`,
      );
    }
  }
  if (missing.length > 0) {
    details.push(
      `MISSING dimension(s): ${missing.join(', ')} — a dimension is answered by its own keyed line, ` +
        'not by the word appearing somewhere else in the report',
    );
  }
  for (const b of bad) details.push(b);
  return { pass: missing.length === 0 && bad.length === 0, details };
};

// ── checker: doc-sync-obligations ────────────────────────────────────────────
// Replaces `match:"changelog"` + the "gap flagged" keyword regex. The checker
// RECOMPUTES the obligation set and the gap set from the task's declared delta
// (args.deltaFiles = the task INPUT, not the answer) and compares them to what
// the report declared. Saying "CHANGELOG" is no longer worth anything; getting
// the derivation right is.
//
// Report contract (one claim per line):
//   DELTA: <path> | class: <classification>
//   OBLIGATION: <path> | required-because: <text> | satisfied: yes|no
//   GAP: <path>
export const docSyncObligationsChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const expectedDelta = argStringArray(args, 'deltaFiles');
  const minReasonChars = argNumber(args, 'minReasonChars', 20);
  if (expectedDelta.length === 0) return { pass: false, details: ['checker misconfigured: args.deltaFiles is empty'] };

  // 1. declared delta must equal the task's delta, and each file must be real.
  const declaredDelta = new Set<string>();
  for (const m of output.matchAll(/^[\s>*+\-|]*DELTA\s*[:：]\s*`?([^\s`|]+)`?\s*(?:[|｜](.*))?$/gim)) {
    declaredDelta.add(m[1]!);
  }
  const missingDelta = expectedDelta.filter((f) => !declaredDelta.has(f));
  const extraDelta = [...declaredDelta].filter((f) => !expectedDelta.includes(f));
  if (missingDelta.length > 0) details.push(`delta not declared: ${missingDelta.join(', ')}`);
  if (extraDelta.length > 0) details.push(`delta invented (not in this task's diff): ${extraDelta.join(', ')}`);
  const unreal = expectedDelta.filter((f) => !readLines(resolve(ctx.cwd, f)));
  if (unreal.length > 0) details.push(`declared delta file does not exist on disk: ${unreal.join(', ')}`);

  // 2. recompute the obligation set from the delta (ground truth).
  const computed = new Map<string, string>(); // target → why
  for (const f of expectedDelta) {
    const pkg = f.match(/^(sdk\/[^/]+\/[^/]+)\/src\//);
    if (pkg) computed.set(`${pkg[1]}/CHANGELOG.md`, `sdk package source changed: ${f}`);
    if (/^docs\/api\/.+\.md$/.test(f)) computed.set(f, `endpoint/api doc touched by the delta: ${f}`);
  }

  // 3. parse the report's obligation rows.
  interface Ob {
    target: string;
    why: string;
    satisfied: boolean;
  }
  const reported: Ob[] = [];
  for (const m of output.matchAll(
    /^[\s>*+\-|]*OBLIGATION\s*[:：]\s*`?([^\s`|]+)`?\s*[|｜]\s*required-because\s*[:：]\s*([^|｜]*)[|｜]\s*satisfied\s*[:：]\s*(yes|no|true|false|✓|✗)/gim,
  )) {
    reported.push({
      target: m[1]!,
      why: (m[2] ?? '').trim(),
      satisfied: /^(yes|true|✓)$/i.test((m[3] ?? '').trim()),
    });
  }
  const reportedTargets = new Set(reported.map((o) => o.target));
  const missingOb = [...computed.keys()].filter((t) => !reportedTargets.has(t));
  const extraOb = [...reportedTargets].filter((t) => !computed.has(t));
  if (missingOb.length > 0) details.push(`obligation(s) the delta requires but the report omitted: ${missingOb.join(', ')}`);
  if (extraOb.length > 0) details.push(`obligation(s) the report invented (not derivable from the delta): ${extraOb.join(', ')}`);

  const wrongSat: string[] = [];
  const thinWhy: string[] = [];
  for (const o of reported) {
    if (!computed.has(o.target)) continue;
    const truth = expectedDelta.includes(o.target); // satisfied ⟺ the doc is itself in the delta
    if (o.satisfied !== truth) {
      wrongSat.push(`${o.target}: report says satisfied=${o.satisfied ? 'yes' : 'no'}, delta says ${truth ? 'yes' : 'no'}`);
    }
    if (reasonWeight(o.why) < minReasonChars) {
      thinWhy.push(`${o.target}: required-because is empty/too short (need ≥ ${minReasonChars} non-space chars)`);
    }
  }
  details.push(...wrongSat, ...thinWhy);

  // 4. gap list must equal the computed unsatisfied set.
  const computedGaps = [...computed.keys()].filter((t) => !expectedDelta.includes(t)).sort();
  const declaredGaps = new Set<string>();
  for (const m of output.matchAll(/^[\s>*+\-|]*GAP\s*[:：]\s*`?([^\s`|]+)`?/gim)) declaredGaps.add(m[1]!);
  const missedGaps = computedGaps.filter((g) => !declaredGaps.has(g));
  const falseGaps = [...declaredGaps].filter((g) => !computedGaps.includes(g));
  if (missedGaps.length > 0) details.push(`GAP not flagged: ${missedGaps.join(', ')}`);
  if (falseGaps.length > 0) details.push(`GAP falsely flagged: ${falseGaps.join(', ')}`);

  const pass =
    missingDelta.length === 0 &&
    extraDelta.length === 0 &&
    unreal.length === 0 &&
    missingOb.length === 0 &&
    extraOb.length === 0 &&
    wrongSat.length === 0 &&
    thinWhy.length === 0 &&
    missedGaps.length === 0 &&
    falseGaps.length === 0;
  if (pass) {
    details.push(
      `delta ${expectedDelta.length} file(s) verified on disk; ${computed.size} obligation(s) recomputed and matched; ` +
        `gap set == {${computedGaps.join(', ')}}`,
    );
  }
  return { pass, details };
};

// ═════════════════════════════════════════════════════════════════════════════
// RUNTIME-SIDE-EFFECT CHECKERS (apc/12 §0.6 — the 7 skills the three checkers
// above could not reach).
//
// The three checkers above all re-read the FILESYSTEM. That is enough for
// skills whose ground truth is source code (impact-trace, doc-sync, …) and
// useless for skills whose ground truth is a RUNTIME side effect: spec-intake's
// truth lives in the cloud DB (did the task row appear, did the SPEC asset fold
// into `metadata.assets.linkedAssetIds`, is the sha stored as a STRING);
// test-runner's lives in the structured product a real run printed; git-ops's
// lives in a real git object store. apc/12 recorded the proof for spec-intake:
// a report that ran ZERO `cloud` commands scored 5/5 under both the old and the
// new (filesystem-only) criteria.
//
// The three checkers below close that gap. They keep every existing rule of the
// house: declared claims only (never free-text sniffing), fail-closed on
// anything unverifiable, and `details[]` says exactly which fact was false.
// ═════════════════════════════════════════════════════════════════════════════

// ── shared: small helpers ────────────────────────────────────────────────────

/** Dotted-path read (`metadata.assets.linkedAssetIds`). Returns undefined when any hop is missing. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function argRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function argStringRecord(args: Record<string, unknown>, key: string): Record<string, string> {
  const r = argRecord(args, key);
  if (!r) return {};
  return Object.fromEntries(Object.entries(r).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** Every non-empty, trimmed item of a `a, b, c` list. */
function splitList(s: string): string[] {
  return s
    .split(/[,，;；]/)
    .map((x) => x.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

function setDiff(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

/**
 * Entity ids that may be interpolated into an argv / URL. Deliberately strict:
 * a report is UNTRUSTED input, and this is the only thing between it and a
 * child process. Anything else fails closed as "malformed id".
 */
const SAFE_ID_RE = /^[A-Za-z0-9_.\-]{4,128}$/;

/**
 * The value of a `LABEL: value` line the report is required to declare, or null.
 * Same shape `declaredLines` / `derivedLines` parse (list bullets, table pipes
 * and backtick wrapping tolerated); factored out so a second consumer cannot
 * drift from the contract the skill's SKILL.md documents.
 */
function matchDeclaredLine(output: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = output.match(new RegExp(`^[\\s>*+\\-|\`]*${esc}\\s*[:：]\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im'));
  return m ? (m[1] ?? '').trim() : null;
}

/** A filename a product ENUMERATES may be joined onto a directory — no traversal, no absolutes. */
const SAFE_FILENAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

// ── shared: synchronous HTTP (child `node -e`) ───────────────────────────────

/**
 * GET a JSON document synchronously, without making the scorer async.
 *
 * WHY A CHILD PROCESS: `matchAcceptanceCriteria` is sync and has two CLI call
 * sites; making it async to await `fetch` would be a breaking signature change
 * for every consumer of the bundle module. A child `node -e` gives us real HTTP
 * inside a sync call for ~60-100ms of process boot — paid only by structured
 * criteria that actually declare a readback.
 *
 * URL and token travel via ENV, never via the `-e` source or a shell, so a
 * report cannot inject code, and the token never appears in an argv (which is
 * world-readable in `ps`).
 */
export function syncHttpGetJson(
  url: string,
  token: string,
  timeoutMs = 8000,
): { ok: boolean; status: number; json?: unknown; error?: string } {
  const src =
    'const u=process.env.__APC_RB_URL,t=process.env.__APC_RB_TOKEN;' +
    'const h=t?{Authorization:"Bearer "+t}:{};' +
    'fetch(u,{headers:h}).then(async r=>{const b=await r.text();' +
    'process.stdout.write(JSON.stringify({status:r.status,body:b}));})' +
    '.catch(e=>{process.stdout.write(JSON.stringify({status:0,body:String((e&&e.message)||e)}));});';
  let raw: string;
  try {
    raw = execFileSync(process.execPath, ['-e', src], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, __APC_RB_URL: url, __APC_RB_TOKEN: token },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `readback request failed: ${(err as Error).message}` };
  }
  let envelope: { status: number; body: string };
  try {
    envelope = JSON.parse(raw) as { status: number; body: string };
  } catch {
    return { ok: false, status: 0, error: 'readback helper produced no parseable output' };
  }
  if (envelope.status === 0) return { ok: false, status: 0, error: `readback transport error: ${envelope.body}` };
  let json: unknown;
  try {
    json = JSON.parse(envelope.body);
  } catch {
    return { ok: false, status: envelope.status, error: `readback returned non-JSON (HTTP ${envelope.status})` };
  }
  if (envelope.status < 200 || envelope.status >= 300) {
    const code = (getPath(json, 'error.code') as string) || '';
    return { ok: false, status: envelope.status, json, error: `HTTP ${envelope.status}${code ? ` ${code}` : ''}` };
  }
  return { ok: true, status: envelope.status, json };
}

// ── checker: json-claim ──────────────────────────────────────────────────────
// For skills whose truth is the STRUCTURED PRODUCT a real command printed
// (test-runner today; release-preflight / release-tag / db-config-sync /
// ota-promote / rollback next). The report must paste the raw JSON in a fenced
// block; the checker re-parses it and verifies facts a prose regex cannot:
//
//   equals/require/types/allowed   the product is the real schema, fully formed
//   declaredLines                  the PROSE number equals the JSON field
//                                  (a report that narrates "green" over a red
//                                  product is red)
//   derivedLines                   a verdict the report states must be the one
//                                  DERIVED from the exit code (78 ⇒ env fault,
//                                  never a SUT red)
//   implications                   the exit-code contract itself
//   eachItem                       per-tier arithmetic (passed+failed+skipped
//                                  == total, failedNames.length == failed)
//   requireItems                   the tier THIS task pinned really ran
//   baselineRecompute              regressions[] recomputed from the real
//                                  baseline.json on disk — "new red vs known
//                                  red" is derived, not taken on the report's word
//   freshArtifacts                 a byproduct file the run WRITES must exist
//                                  and its mtime must sit next to the run's own
//                                  declared timestamp  ⇒ "I ran it" with a
//                                  months-old artifact is red
//   filesExist                     every filename the product ENUMERATES must be
//                                  a real file in the directory it was read from
//                                  ⇒ an invented migration/plan list is red
//   fileEquals                     a product field must equal what is ON DISK —
//                                  as trimmed text (`VERSION`) or as deep-equal
//                                  JSON (the ledger the run rewrote) ⇒ "applied"
//                                  without the side effect is red
//
// Honest boundary: a fabricator who reads baseline.json + the tier inventory and
// touches the artifact can still hand-build a consistent product. No local
// artifact is unforgeable. What this kills is the cheap fabrication (invented
// numbers, narrated verdicts, stale/absent run byproducts) — the same class the
// other checkers kill.
export const jsonClaimChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const fail = (msg: string) => {
    details.push(msg);
    return { pass: false, details };
  };

  const equals = argRecord(args, 'equals') ?? {};
  const require = argStringArray(args, 'require');
  const types = argStringRecord(args, 'types');
  const allowed = argRecord(args, 'allowed') ?? {};
  const declaredLines = argStringRecord(args, 'declaredLines');
  const derivedLines = argRecord(args, 'derivedLines') ?? {};
  const implications = Array.isArray(args.implications) ? (args.implications as Record<string, unknown>[]) : [];
  const eachItem = argRecord(args, 'eachItem');
  const requireItems = argRecord(args, 'requireItems');
  const baselineRecompute = argRecord(args, 'baselineRecompute');
  const freshArtifacts = argRecord(args, 'freshArtifacts');
  const filesExist = argRecord(args, 'filesExist');
  const fileEquals = argRecord(args, 'fileEquals') ?? {};
  const configured =
    Object.keys(equals).length +
    require.length +
    Object.keys(types).length +
    Object.keys(allowed).length +
    Object.keys(declaredLines).length +
    Object.keys(derivedLines).length +
    implications.length +
    (eachItem ? 1 : 0) +
    (requireItems ? 1 : 0) +
    (baselineRecompute ? 1 : 0) +
    (freshArtifacts ? 1 : 0) +
    (filesExist ? 1 : 0) +
    Object.keys(fileEquals).length;
  if (configured === 0) return fail('checker misconfigured: json-claim was given no verification args');

  // 1. locate the fenced JSON block. When `equals` pins a discriminator (e.g.
  //    schema), the block carrying it wins — a report may legitimately paste
  //    several JSON blocks (doctor, per-tier extracts).
  // Fences are walked LINE-WISE, not matched with a lazy regex: a report
  // legitimately contains other fenced blocks (```bash with the command it
  // ran), and a regex that pairs "``` … ```" greedily mis-pairs the CLOSING
  // fence of the bash block with the OPENING fence of the json one — which
  // made a perfectly faithful report report "no JSON at all".
  const blocks: unknown[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^\s*(`{3,})\s*([\w-]*)\s*$/);
    if (!open) continue;
    const fence = open[1]!;
    const lang = open[2] ?? '';
    const buf: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !new RegExp(`^\\s*\`{${fence.length},}\\s*$`).test(lines[j]!); j++) buf.push(lines[j]!);
    i = j;
    if (lang === '' || /^jsonc?$/i.test(lang)) {
      try {
        blocks.push(JSON.parse(buf.join('\n')));
      } catch {
        /* a non-JSON fenced block is normal — not an error */
      }
    }
  }
  if (blocks.length === 0)
    return fail(
      'no parseable fenced JSON block in the report — the raw `--json` product must be pasted verbatim inside ```json … ```',
    );
  const discriminator = Object.entries(equals)[0];
  const doc =
    (discriminator ? blocks.find((b) => getPath(b, discriminator[0]) === discriminator[1]) : undefined) ?? blocks[0];

  // 2. shape: pinned values, required paths, types, allowed values.
  for (const [path, want] of Object.entries(equals)) {
    const got = getPath(doc, path);
    if (got !== want) return fail(`JSON \`${path}\` is ${JSON.stringify(got)} — expected ${JSON.stringify(want)}`);
  }
  const missing = require.filter((p) => getPath(doc, p) === undefined || getPath(doc, p) === null);
  if (missing.length > 0) return fail(`JSON product is missing required field(s): ${missing.join(', ')}`);
  for (const [path, want] of Object.entries(types)) {
    const got = getPath(doc, path);
    const actual = Array.isArray(got) ? 'array' : typeof got;
    if (actual !== want) return fail(`JSON \`${path}\` is ${actual}, expected ${want}`);
  }
  for (const [path, list] of Object.entries(allowed)) {
    if (!Array.isArray(list)) return fail(`checker misconfigured: allowed.${path} is not an array`);
    const got = getPath(doc, path);
    if (!list.includes(got as never)) return fail(`JSON \`${path}\` = ${JSON.stringify(got)} is not one of ${JSON.stringify(list)}`);
  }

  // 3. prose ⇄ product: a declared line must carry the SAME value as the JSON.
  for (const [line, path] of Object.entries(declaredLines)) {
    const esc = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = output.match(new RegExp(`^[\\s>*+\\-|\`]*${esc}\\s*[:：]\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im'));
    if (!m) return fail(`the report does not declare a \`${line}: <value>\` line (it must state ${path} in prose too)`);
    const declared = (m[1] ?? '').trim();
    const truth = getPath(doc, path);
    if (declared !== String(truth))
      return fail(
        `\`${line}: ${declared}\` contradicts the pasted product (\`${path}\` = ${JSON.stringify(truth)}) — ` +
          'narrating a different outcome than the command produced is the failure mode this criterion exists to catch',
      );
    details.push(`${line} matches the product's ${path} (${declared})`);
  }

  // 4. a stated verdict must be the one DERIVED from the product, not chosen.
  for (const [line, spec] of Object.entries(derivedLines)) {
    const s = spec as Record<string, unknown>;
    const from = typeof s.from === 'string' ? s.from : undefined;
    const map = argStringRecord(s, 'map');
    if (!from || Object.keys(map).length === 0)
      return fail(`checker misconfigured: derivedLines.${line} needs \`from\` + a non-empty \`map\``);
    const key = String(getPath(doc, from));
    const want = map[key];
    if (want === undefined) return fail(`derivedLines.${line}: product's ${from}=${key} has no mapping — cannot derive a verdict`);
    const esc = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = output.match(new RegExp(`^[\\s>*+\\-|\`]*${esc}\\s*[:：]\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im'));
    if (!m) return fail(`the report does not declare a \`${line}: <verdict>\` line`);
    const got = (m[1] ?? '').trim();
    if (got !== want)
      return fail(
        `\`${line}: ${got}\` is not the verdict derived from ${from}=${key} (must be \`${want}\`) — ` +
          'the verdict is a function of the exit code, not a judgement call',
      );
    details.push(`${line} = ${got}, correctly derived from ${from}=${key}`);
  }

  // 5. the exit-code contract, as implications over the product itself.
  for (const [i, rule] of implications.entries()) {
    const cond = argRecord(rule, 'if');
    const then = argRecord(rule, 'then');
    if (!cond || !then || typeof cond.path !== 'string' || typeof then.path !== 'string')
      return fail(`checker misconfigured: implications[${i}] needs if.path + then.path`);
    if (getPath(doc, cond.path) !== cond.equals) continue;
    const got = getPath(doc, then.path);
    const label = `${cond.path}=${JSON.stringify(cond.equals)} ⇒ ${then.path}`;
    if ('equals' in then && got !== then.equals)
      return fail(`${label} must be ${JSON.stringify(then.equals)}, product says ${JSON.stringify(got)}`);
    if (then.empty === true && !(Array.isArray(got) && got.length === 0))
      return fail(`${label} must be empty, product says ${JSON.stringify(got)}`);
    if (then.nonEmpty === true && !(Array.isArray(got) && got.length > 0))
      return fail(`${label} must be non-empty, product says ${JSON.stringify(got)}`);
    details.push(`invariant holds: ${label}`);
  }

  // 6. per-item arithmetic — invented counts stop adding up.
  if (eachItem) {
    const path = typeof eachItem.path === 'string' ? eachItem.path : '';
    const items = getPath(doc, path);
    if (!Array.isArray(items) || items.length === 0) return fail(`JSON \`${path}\` is not a non-empty array`);
    const sum = argRecord(eachItem, 'sum');
    const lengths = argStringRecord(eachItem, 'lengths');
    for (const [i, item] of items.entries()) {
      const label = `${path}[${i}]${typeof getPath(item, 'tier') === 'string' ? ` (${getPath(item, 'tier')})` : ''}`;
      if (sum) {
        const parts = argStringArray(sum, 'parts');
        const totalKey = typeof sum.total === 'string' ? sum.total : '';
        const acc = parts.reduce((n, k) => n + (typeof getPath(item, k) === 'number' ? (getPath(item, k) as number) : NaN), 0);
        const total = getPath(item, totalKey);
        if (!Number.isFinite(acc) || acc !== total)
          return fail(`${label}: ${parts.join('+')} = ${acc} but ${totalKey} = ${JSON.stringify(total)}`);
      }
      for (const [arrKey, countKey] of Object.entries(lengths)) {
        const arr = getPath(item, arrKey);
        const count = getPath(item, countKey);
        if (!Array.isArray(arr) || arr.length !== count)
          return fail(`${label}: ${arrKey}.length = ${Array.isArray(arr) ? arr.length : 'n/a'} but ${countKey} = ${JSON.stringify(count)}`);
      }
    }
    details.push(`${items.length} item(s) under \`${path}\` are internally consistent`);
  }

  // 7. the tier(s) this task pinned really appear in the product.
  if (requireItems) {
    const path = typeof requireItems.path === 'string' ? requireItems.path : '';
    const key = typeof requireItems.key === 'string' ? requireItems.key : '';
    const values = argStringArray(requireItems, 'values');
    const items = getPath(doc, path);
    if (!Array.isArray(items)) return fail(`JSON \`${path}\` is not an array`);
    const present = items.map((it) => String(getPath(it, key)));
    const absent = values.filter((v) => !present.some((p) => p === v || p.startsWith(`${v}(`)));
    if (absent.length > 0)
      return fail(`this task pinned ${path}.${key} = ${values.join(', ')} but the product ran ${present.join(', ') || '(none)'}`);
    details.push(`pinned ${key}(s) present in the product: ${values.join(', ')}`);
  }

  // 8. baseline diff RECOMPUTED from disk — the core of the --diff verdict.
  if (baselineRecompute) {
    const file = typeof baselineRecompute.file === 'string' ? baselineRecompute.file : '';
    const itemsPath = typeof baselineRecompute.itemsPath === 'string' ? baselineRecompute.itemsPath : '';
    const failedKey = typeof baselineRecompute.failedNamesKey === 'string' ? baselineRecompute.failedNamesKey : 'failedNames';
    const regPath = typeof baselineRecompute.regressionsPath === 'string' ? baselineRecompute.regressionsPath : 'regressions';
    const lines = readLines(resolve(ctx.cwd, file));
    if (!lines) return fail(`baseline file not found at ${file} — the diff verdict cannot be recomputed, so it cannot be trusted`);
    let baseline: Record<string, unknown>;
    try {
      baseline = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    } catch {
      return fail(`baseline file ${file} is not parseable JSON`);
    }
    const items = getPath(doc, itemsPath);
    if (!Array.isArray(items)) return fail(`JSON \`${itemsPath}\` is not an array`);
    const nowFail = [...new Set(items.flatMap((it) => (Array.isArray(getPath(it, failedKey)) ? (getPath(it, failedKey) as string[]) : [])))];
    const expected = nowFail.filter((n) => baseline[n] !== 'fail').sort();
    const gotRaw = getPath(doc, regPath);
    if (!Array.isArray(gotRaw)) return fail(`JSON \`${regPath}\` is not an array`);
    const got = [...(gotRaw as string[])].sort();
    const invented = setDiff(got, expected);
    const hidden = setDiff(expected, got);
    if (invented.length > 0 || hidden.length > 0) {
      if (hidden.length > 0)
        details.push(`NEW red(s) hidden from ${regPath}: ${hidden.join(', ')} — these are not in ${file} as known-fail`);
      if (invented.length > 0)
        details.push(`${regPath} claims regression(s) that ARE baseline known-red (or never failed this run): ${invented.join(', ')}`);
      return { pass: false, details };
    }
    details.push(
      `baseline diff recomputed from ${file}: ${nowFail.length} failing name(s), ${expected.length} genuinely new ⇒ ${regPath} matches`,
    );
  }

  // 9. the run's own byproducts must be as old as the run claims to be.
  if (freshArtifacts) {
    const tsPath = typeof freshArtifacts.timestampPath === 'string' ? freshArtifacts.timestampPath : '';
    // Not every `--json` product carries a clock (the five `apc release *`
    // reports do not). When it does not, the run's own timestamp is DECLARED in
    // prose instead — same guarantee: the byproduct's mtime must sit next to it,
    // so a months-old artifact cannot be passed off as this run's trace.
    const tsLine = typeof freshArtifacts.timestampLine === 'string' ? freshArtifacts.timestampLine : '';
    const paths = argStringArray(freshArtifacts, 'paths');
    const skewMs = argNumber(freshArtifacts, 'skewMinutes', 30) * 60_000;
    let tsRaw: unknown;
    let tsLabel: string;
    if (tsPath) {
      tsRaw = getPath(doc, tsPath);
      tsLabel = `JSON \`${tsPath}\``;
    } else if (tsLine) {
      const m = matchDeclaredLine(output, tsLine);
      if (!m)
        return fail(
          `the report does not declare a \`${tsLine}: <ISO-8601 timestamp>\` line — this product carries no clock of its own, ` +
            'so the run\'s wall time must be stated in prose before its byproducts can be dated',
        );
      tsRaw = m;
      tsLabel = `the declared \`${tsLine}\` line`;
    } else {
      return fail('checker misconfigured: freshArtifacts needs `timestampPath` or `timestampLine`');
    }
    const runAt = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(runAt)) return fail(`${tsLabel} is not a parseable timestamp — run freshness cannot be established`);
    if (paths.length === 0) return fail('checker misconfigured: freshArtifacts.paths is empty');
    for (const p of paths) {
      let mtime: number;
      try {
        mtime = statSync(resolve(ctx.cwd, p)).mtimeMs;
      } catch {
        return fail(`run byproduct ${p} does not exist — the run this report describes left no trace on disk`);
      }
      const skew = Math.abs(mtime - runAt);
      if (skew > skewMs)
        return fail(
          `run byproduct ${p} was last written ${(skew / 60_000).toFixed(1)} min away from the run's own timestamp ` +
            `(${tsRaw}) — allowed skew ${skewMs / 60_000} min. The pasted product did not come from a run that touched this file.`,
        );
      details.push(`run byproduct ${p} is contemporaneous with the run (${(skew / 1000).toFixed(0)}s skew)`);
    }
  }

  // 10. every filename the product ENUMERATES must be a real file where it was
  //     read from. `release db-config-sync` is the case this exists for: its
  //     `migration.pending[]` is the real `src/im/sql/*.sql` ⇄ `_migrations`
  //     ledger difference, so a report that never spawned the sync script has to
  //     INVENT ~200 filenames — and every one of them is stat'ed here.
  if (filesExist) {
    const path = typeof filesExist.path === 'string' ? filesExist.path : '';
    const dir = typeof filesExist.dir === 'string' ? filesExist.dir : '';
    const min = argNumber(filesExist, 'min', 0);
    if (!path || !dir) return fail('checker misconfigured: filesExist needs `path` + `dir`');
    const items = getPath(doc, path);
    if (!Array.isArray(items)) return fail(`JSON \`${path}\` is not an array — its filenames cannot be re-read from ${dir}`);
    if (items.length < min)
      return fail(
        `JSON \`${path}\` enumerates ${items.length} entr(ies) but this task pins at least ${min} — ` +
          'an empty plan here means the command never reached the ledger it claims to have diffed',
      );
    for (const it of items) {
      if (typeof it !== 'string' || !SAFE_FILENAME_RE.test(it))
        return fail(`JSON \`${path}\` contains ${JSON.stringify(it)}, which is not a plain filename`);
      if (!readLines(resolve(ctx.cwd, dir, it)))
        return fail(
          `JSON \`${path}\` names \`${it}\`, which does not exist under ${dir} — ` +
            'the enumeration is invented, not read off disk',
        );
    }
    details.push(`all ${items.length} name(s) under \`${path}\` resolve to real files in ${dir}`);
  }

  // 11. a product field cross-checked against what is ON DISK — the run's own
  //     input (`VERSION`) or the file the run REWROTE (the release ledger).
  //     `applied: true` with a ledger that never flipped dies here.
  for (const [path, specRaw] of Object.entries(fileEquals)) {
    const spec =
      specRaw && typeof specRaw === 'object' && !Array.isArray(specRaw)
        ? (specRaw as Record<string, unknown>)
        : { file: specRaw };
    const file = typeof spec.file === 'string' ? spec.file : '';
    if (!file) return fail(`checker misconfigured: fileEquals.${path} needs a \`file\``);
    const diskLines = readLines(resolve(ctx.cwd, file));
    if (!diskLines)
      return fail(`fileEquals: ${file} does not exist — there is no on-disk fact to cross-check \`${path}\` against`);
    const raw = diskLines.join('\n');
    const got = getPath(doc, path);
    if (spec.json === true) {
      let onDisk: unknown;
      try {
        onDisk = JSON.parse(raw);
      } catch {
        return fail(`fileEquals: ${file} is not parseable JSON`);
      }
      if (JSON.stringify(onDisk) !== JSON.stringify(got))
        return fail(
          `\`${path}\` is not what ${file} actually contains — the file on disk is ` +
            `${JSON.stringify(onDisk).slice(0, 240)}. A product that says it wrote a state the file does not hold ` +
            'describes a side effect that did not happen',
        );
      details.push(`\`${path}\` deep-equals the real contents of ${file} — the write landed`);
    } else {
      if (String(got) !== raw.trim())
        return fail(`\`${path}\` = ${JSON.stringify(got)} but ${file} on disk says ${JSON.stringify(raw.trim())}`);
      details.push(`\`${path}\` equals ${file} on disk (${raw.trim()})`);
    }
  }

  return { pass: true, details };
};

// ── checker: declared-id-readback ────────────────────────────────────────────
// For skills whose truth is a ROW THE RUN CREATED. The report declares the ids
// it produced; the checker re-reads them from the live API and compares:
//
//   TASK: <taskId>
//   ASSET: <assetId> | role: spec
//   CRITERION: <criterionId>
//   META: <dotted.key> = <value> | type: string
//
// Verified: the task id EXISTS (an invented id is a 404, which is exactly the
// "I ran the commands" claim with no commands behind it); every declared asset
// id really sits in `metadata.assets.linkedAssetIds` (the server-side fold);
// every declared criterion id really is on the task's acceptance view; every
// declared meta key really carries that value AND that JS TYPE — which is how
// `--set-string` vs `--set` becomes checkable instead of narratable.
//
// Fail-closed: no token / unreachable API / non-2xx ⇒ RED. "I could not verify"
// is never a pass — that is the whole contract of this file.
export const declaredIdReadbackChecker: StructuredChecker = (output, args, _ctx) => {
  const details: string[] = [];
  const fail = (msg: string) => {
    details.push(msg);
    return { pass: false, details };
  };

  const requireKinds = argStringArray(args, 'require');
  const base = (
    (typeof args.base === 'string' && args.base) ||
    process.env[typeof args.baseEnv === 'string' ? args.baseEnv : 'APC_READBACK_BASE'] ||
    process.env.APC_READBACK_BASE ||
    'http://127.0.0.1:3000'
  ).replace(/\/+$/, '');
  const tokenEnvs = argStringArray(args, 'tokenEnv');
  const tokenEnvNames = tokenEnvs.length > 0 ? tokenEnvs : ['APC_READBACK_TOKEN', 'DEV_JWT', 'PRISMER_API_KEY'];
  const token = tokenEnvNames.map((n) => process.env[n]).find((v) => typeof v === 'string' && v.length > 0);
  if (!token)
    return fail(
      `no readback credential in env (${tokenEnvNames.join(' / ')}) — this criterion re-reads the entities the report ` +
        'declares from the live API, and an unverifiable claim is a failed claim, never a pass',
    );
  const timeoutMs = argNumber(args, 'timeoutMs', 8000);
  const assetsPath = typeof args.assetsPath === 'string' ? args.assetsPath : 'metadata.assets.linkedAssetIds';
  const minCriteria = argNumber(args, 'minCriteria', 1);
  const maxAgeMinutes = argNumber(args, 'maxAgeMinutes', 0);
  const expect = argRecord(args, 'expect') ?? {};

  // ── parse declarations ──
  const taskIds = [...output.matchAll(/^[\s>*+\-|`]*TASK\s*[:：]\s*`?([^\s`|]+)`?/gim)].map((m) => m[1]!);
  const assetIds = [...output.matchAll(/^[\s>*+\-|`]*ASSET\s*[:：]\s*`?([^\s`|]+)`?/gim)].map((m) => m[1]!);
  const criterionIds = [...output.matchAll(/^[\s>*+\-|`]*CRITERION\s*[:：]\s*`?([^\s`|]+)`?/gim)].map((m) => m[1]!);
  const metaClaims = [...output.matchAll(
    /^[\s>*+\-|`]*META\s*[:：]\s*`?([\w.\-]+)`?\s*=\s*`?([^`|\n]+?)`?\s*(?:[|｜]\s*type\s*[:：]\s*`?(\w+)`?)?\s*$/gim,
  )].map((m) => ({ key: m[1]!, value: (m[2] ?? '').trim(), type: (m[3] ?? '').trim() }));

  const declaredKinds: Record<string, number> = {
    task: taskIds.length,
    asset: assetIds.length,
    criterion: criterionIds.length,
    meta: metaClaims.length,
  };
  const absent = requireKinds.filter((k) => (declaredKinds[k] ?? 0) === 0);
  if (absent.length > 0)
    return fail(
      `the report declares no ${absent.map((k) => k.toUpperCase()).join(' / ')} line — ` +
        'the ids a run produced are the only thing that can be re-read; prose about them cannot',
    );
  if (taskIds.length === 0) return fail('no `TASK: <id>` declaration — every other claim is anchored on it');
  if (taskIds.length > 1) return fail(`ambiguous: ${taskIds.length} TASK declarations (${taskIds.join(', ')}) — declare exactly one`);
  const taskId = taskIds[0]!;
  const badIds = [taskId, ...assetIds, ...criterionIds].filter((id) => !SAFE_ID_RE.test(id));
  if (badIds.length > 0) return fail(`malformed id(s), refusing to read back: ${badIds.join(', ')}`);

  // ── readback 1: the task row itself ──
  const taskRes = syncHttpGetJson(`${base}/api/im/tasks/${encodeURIComponent(taskId)}`, token, timeoutMs);
  if (!taskRes.ok)
    return fail(
      `TASK ${taskId} could not be read back from ${base} (${taskRes.error}) — ` +
        'a declared id that does not resolve server-side is the signature of a run that never happened',
    );
  // `GET /api/im/tasks/:id` answers `{ok,data:{task,logs,runs,…}}`; other
  // deployments/mocks answer `{ok,data:<task>}`. Probe the known envelopes
  // instead of pinning one — but require the id to MATCH, so a wrong envelope
  // can never be mistaken for a verified task.
  const taskPathArg = typeof args.taskPath === 'string' ? [args.taskPath] : [];
  const task = [...taskPathArg, 'data.task', 'data', '']
    .map((p) => (p === '' ? taskRes.json : getPath(taskRes.json, p)))
    .find((cand) => cand && typeof cand === 'object' && getPath(cand, 'id') === taskId) as
    | Record<string, unknown>
    | undefined;
  if (!task)
    return fail(
      `readback of ${taskId} returned no task object carrying that id ` +
        `(looked at ${[...taskPathArg, 'data.task', 'data', '<root>'].join(', ')})`,
    );
  details.push(`TASK ${taskId} exists server-side`);

  if (maxAgeMinutes > 0) {
    const created = Date.parse(String(getPath(task, 'createdAt') ?? ''));
    if (!Number.isFinite(created)) return fail(`TASK ${taskId} has no parseable createdAt — freshness cannot be established`);
    const ageMin = (Date.now() - created) / 60_000;
    if (ageMin > maxAgeMinutes)
      return fail(
        `TASK ${taskId} was created ${ageMin.toFixed(0)} min ago (limit ${maxAgeMinutes}) — ` +
          'this run must produce its OWN task, not point at a pre-existing one',
      );
    details.push(`TASK ${taskId} is ${ageMin.toFixed(0)} min old (fresh)`);
  }
  for (const [path, want] of Object.entries(expect)) {
    if (path === 'descriptionMinChars') continue;
    const got = getPath(task, path);
    if (got !== want) return fail(`task \`${path}\` is ${JSON.stringify(got)} — this task must be ${JSON.stringify(want)}`);
    details.push(`task ${path} = ${JSON.stringify(want)}`);
  }
  const descMin = argNumber(expect, 'descriptionMinChars', 0);
  if (descMin > 0) {
    const desc = String(getPath(task, 'description') ?? '');
    if (reasonWeight(desc) < descMin)
      return fail(
        `task description is ${reasonWeight(desc)} non-space chars (need ≥ ${descMin}) — ` +
          'dispatch only forwards title/description + linkedAssetIds, so an empty description means the agent will not see the expectations',
      );
    details.push(`task description carries ${reasonWeight(desc)} non-space chars`);
  }

  // ── readback 2: the server-side fold ──
  if (assetIds.length > 0) {
    const linked = getPath(task, assetsPath);
    if (!Array.isArray(linked)) return fail(`task \`${assetsPath}\` is not an array — nothing was folded into dispatch`);
    const notFolded = assetIds.filter((a) => !(linked as unknown[]).map(String).includes(a));
    if (notFolded.length > 0)
      return fail(
        `declared ASSET id(s) ${notFolded.join(', ')} are NOT in ${assetsPath} (server has ${JSON.stringify(linked)}) — ` +
          'the SPEC is invisible to dispatch, so the fold did not happen',
      );
    details.push(`${assetIds.length} declared asset id(s) verified inside ${assetsPath}`);
  }

  // ── readback 3: acceptance criteria ──
  if (criterionIds.length > 0 || minCriteria > 0) {
    const accRes = syncHttpGetJson(`${base}/api/im/tasks/${encodeURIComponent(taskId)}/acceptance`, token, timeoutMs);
    if (!accRes.ok) return fail(`acceptance view for ${taskId} could not be read back (${accRes.error})`);
    const criteria = getPath(accRes.json, 'data.criteria');
    if (!Array.isArray(criteria)) return fail(`acceptance view for ${taskId} carries no criteria array`);
    const ids = criteria.map((c) => String(getPath(c, 'id')));
    if (criteria.length < minCriteria) return fail(`task has ${criteria.length} acceptance criterion(a), need ≥ ${minCriteria}`);
    const unknownIds = criterionIds.filter((c) => !ids.includes(c));
    if (unknownIds.length > 0)
      return fail(`declared CRITERION id(s) ${unknownIds.join(', ')} are not on the task (server has ${ids.join(', ') || '(none)'})`);
    details.push(`${criteria.length} criterion(a) on the task; ${criterionIds.length} declared id(s) verified`);
  }

  // ── readback 4: metadata values AND their stored type ──
  for (const claim of metaClaims) {
    const got = getPath(task, `metadata.${claim.key}`);
    if (got === undefined) return fail(`metadata.${claim.key} does not exist on the task — the meta write did not land`);
    if (String(got) !== claim.value)
      return fail(`metadata.${claim.key} is ${JSON.stringify(got)}, report declared \`${claim.value}\``);
    if (claim.type) {
      const actual = Array.isArray(got) ? 'array' : typeof got;
      if (actual !== claim.type)
        return fail(
          `metadata.${claim.key} is stored as ${actual}, report declared type \`${claim.type}\` — ` +
            'this is exactly the `--set` vs `--set-string` coercion the skill must avoid',
        );
    }
    details.push(`metadata.${claim.key} = ${JSON.stringify(got)} (${typeof got}) as declared`);
  }

  return { pass: true, details };
};

// ── checker: git-claim-readback ──────────────────────────────────────────────
// For git-ops, whose truth is a real object store. Read-only git plumbing
// re-reads every declared fact:
//
//   GIT-REPO: <path>                               (all claims resolve here)
//   GIT-COMMIT: <sha> | files: a.ts, b.ts          exact file set of that commit
//   GIT-BRANCH: <name> | head: <sha>
//   GIT-PUSHED: <branch> | remote: <name>          remote ref == local branch
//   GIT-TAG: <tag> | remote: <name> | sha: <sha>   tag IS on the remote, at that sha
//   GIT-REFUSED-TAG: <tag> | remote: <name>        tag must NOT be on the remote
//   GIT-CONFLICT-REPO: <path>
//   GIT-CONFLICT-FILES: a.ts, b.ts                 MERGE_HEAD alive + unmerged set
//
// The conflict claim is the load-bearing one: `MERGE_HEAD` still present proves
// the merge was left in place. An agent that auto-resolved, `--abort`ed or
// `reset`ted destroys exactly that file, so "I stopped and escalated" stops
// being narratable.
//
// Safety: every command is read-only, and the declared repo may never be the
// scorer's own repo root (nor an ancestor of it) — a skill must not be able to
// score itself green by operating on the shared worktree.
export const gitClaimReadbackChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const fail = (msg: string) => {
    details.push(msg);
    return { pass: false, details };
  };
  const requireKinds = argStringArray(args, 'require');
  const repoPrefix = typeof args.repoPrefix === 'string' ? args.repoPrefix : '';
  const ownedFiles = argStringArray(args, 'ownedFiles');
  const refusedTagPattern = typeof args.refusedTagPattern === 'string' ? args.refusedTagPattern : '';
  const tagPattern = typeof args.tagPattern === 'string' ? args.tagPattern : '';
  const timeoutMs = argNumber(args, 'timeoutMs', 10_000);

  const git = (repo: string, argv: string[]): { ok: boolean; out: string } => {
    try {
      return {
        ok: true,
        out: execFileSync('git', ['-C', repo, ...argv], {
          encoding: 'utf8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      };
    } catch (err) {
      return { ok: false, out: (err as Error).message };
    }
  };

  const resolveRepo = (declared: string, label: string): { abs: string } | { err: string } => {
    if (repoPrefix && !declared.startsWith(repoPrefix))
      return {
        err: `${label} \`${declared}\` is outside the sandbox this task pins (\`${repoPrefix}\`) — ` +
          'git-ops must be exercised in a scratch repo, never in the shared worktree',
      };
    const abs = resolve(ctx.cwd, declared);
    const root = resolve(ctx.cwd);
    if (abs === root || `${root}${sep}`.startsWith(`${abs}${sep}`))
      return { err: `${label} \`${declared}\` resolves to the scorer's own repo (${root}) — refusing to accept the shared worktree as the demo repo` };
    const probe = git(abs, ['rev-parse', '--git-dir']);
    if (!probe.ok) return { err: `${label} \`${declared}\` is not a git repository (${probe.out.split('\n')[0]})` };
    return { abs };
  };

  const one = (re: RegExp): RegExpMatchArray | null => output.match(re);

  const declared = {
    repo: one(/^[\s>*+\-|`]*GIT-REPO\s*[:：]\s*`?([^\s`|]+)`?/im),
    commit: one(/^[\s>*+\-|`]*GIT-COMMIT\s*[:：]\s*`?([0-9a-f]{7,40})`?\s*[|｜]\s*files\s*[:：]\s*(.+?)\s*$/im),
    branch: one(/^[\s>*+\-|`]*GIT-BRANCH\s*[:：]\s*`?([^\s`|]+)`?\s*(?:[|｜]\s*head\s*[:：]\s*`?([0-9a-f]{7,40})`?)?/im),
    pushed: one(/^[\s>*+\-|`]*GIT-PUSHED\s*[:：]\s*`?([^\s`|]+)`?\s*[|｜]\s*remote\s*[:：]\s*`?([\w.\-]+)`?/im),
    tag: one(
      /^[\s>*+\-|`]*GIT-TAG\s*[:：]\s*`?([^\s`|]+)`?\s*[|｜]\s*remote\s*[:：]\s*`?([\w.\-]+)`?\s*(?:[|｜]\s*sha\s*[:：]\s*`?([0-9a-f]{7,40})`?)?/im,
    ),
    refusedTag: one(/^[\s>*+\-|`]*GIT-REFUSED-TAG\s*[:：]\s*`?([^\s`|]+)`?\s*[|｜]\s*remote\s*[:：]\s*`?([\w.\-]+)`?/im),
    conflictRepo: one(/^[\s>*+\-|`]*GIT-CONFLICT-REPO\s*[:：]\s*`?([^\s`|]+)`?/im),
    conflictFiles: one(/^[\s>*+\-|`]*GIT-CONFLICT-FILES\s*[:：]\s*(.+?)\s*$/im),
  };
  const missingKinds = requireKinds.filter((k) => !declared[k as keyof typeof declared]);
  if (missingKinds.length > 0)
    return fail(
      `the report declares no ${missingKinds.map((k) => `GIT-${k.replace(/([A-Z])/g, '-$1').toUpperCase()}`).join(' / ')} line — ` +
        'these claims are re-read out of the real object store, so they cannot be replaced by prose',
    );
  if (!declared.repo) return fail('no `GIT-REPO: <path>` declaration — every other git claim resolves inside it');
  const repo = resolveRepo(declared.repo[1]!, 'GIT-REPO');
  if ('err' in repo) return fail(repo.err);
  details.push(`GIT-REPO ${declared.repo[1]} is a real repository`);

  // commit: the object exists AND touched exactly the declared files.
  if (declared.commit) {
    const sha = declared.commit[1]!;
    const claimed = splitList(declared.commit[2]!).sort();
    const type = git(repo.abs, ['cat-file', '-t', sha]);
    if (!type.ok || type.out !== 'commit') return fail(`GIT-COMMIT ${sha} is not a commit object in this repo`);
    const names = git(repo.abs, ['show', '--name-only', '--format=', sha]);
    if (!names.ok) return fail(`GIT-COMMIT ${sha}: could not read its file list (${names.out.split('\n')[0]})`);
    const actual = names.out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const extra = setDiff(actual, claimed);
    const absentF = setDiff(claimed, actual);
    if (extra.length > 0 || absentF.length > 0)
      return fail(
        `GIT-COMMIT ${sha} touched {${actual.join(', ')}} but the report declared {${claimed.join(', ')}}` +
          (extra.length ? ` — undeclared file(s) in the commit: ${extra.join(', ')}` : ''),
      );
    if (ownedFiles.length > 0) {
      const notOwned = setDiff(actual, ownedFiles);
      if (notOwned.length > 0)
        return fail(
          `GIT-COMMIT ${sha} staged file(s) this task does not own: ${notOwned.join(', ')} — ` +
            '`cloud git commit` never auto-stages; whatever is in the commit was staged on purpose',
        );
    }
    details.push(`GIT-COMMIT ${sha} exists and touches exactly {${actual.join(', ')}}`);
  }

  // branch: the ref exists, its tip is the declared sha, and it carries the commit.
  if (declared.branch) {
    const name = declared.branch[1]!;
    const head = declared.branch[2];
    const tip = git(repo.abs, ['rev-parse', '--verify', `refs/heads/${name}`]);
    if (!tip.ok) return fail(`GIT-BRANCH ${name} does not exist in this repo`);
    if (head && !tip.out.startsWith(head)) return fail(`GIT-BRANCH ${name} points at ${tip.out.slice(0, 12)}, report declared ${head}`);
    if (declared.commit) {
      const anc = git(repo.abs, ['merge-base', '--is-ancestor', declared.commit[1]!, `refs/heads/${name}`]);
      if (!anc.ok) return fail(`GIT-BRANCH ${name} does not contain GIT-COMMIT ${declared.commit[1]} — the branch is unrelated to the commit`);
    }
    details.push(`GIT-BRANCH ${name} → ${tip.out.slice(0, 12)}`);
  }

  // push: the remote must be a LOCAL bare replica and really carry the branch.
  if (declared.pushed) {
    const [, branch, remote] = declared.pushed as unknown as [string, string, string];
    const url = git(repo.abs, ['remote', 'get-url', remote]);
    if (!url.ok) return fail(`GIT-PUSHED declares remote \`${remote}\`, which this repo does not have`);
    let remoteReal: string | null = null;
    try {
      if (statSync(resolve(repo.abs, url.out)).isDirectory()) remoteReal = resolve(repo.abs, url.out);
    } catch {
      remoteReal = null;
    }
    if (!remoteReal)
      return fail(`remote \`${remote}\` is ${url.out} — push must reach a LOCAL bare replica, not a network remote`);
    const local = git(repo.abs, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    const onRemote = git(remoteReal, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!onRemote.ok) return fail(`branch ${branch} is not on remote \`${remote}\` — the push did not land`);
    if (local.ok && local.out !== onRemote.out)
      return fail(`remote \`${remote}\` has ${branch} at ${onRemote.out.slice(0, 12)} but locally it is ${local.out.slice(0, 12)}`);
    details.push(`GIT-PUSHED ${branch} → ${remote} (${onRemote.out.slice(0, 12)}), remote is a local replica`);
  }

  // pushed tag: the DUAL of the refusal below — the tag must really be ON the
  // replica, at the sha the report names. `apc release tag --approved` claims a
  // push; without this, "decision=green, pushed=true" is a sentence in a JSON
  // blob and nothing more. `tagPattern` pins the computed
  // `<channel>-<target>-YYYYMMDD-vX.Y.Z` shape, and `refusedTagPattern` doubles
  // as a guard: a prod-triggering tag must never be the one that landed.
  if (declared.tag) {
    const [, tag, remote, sha] = declared.tag as unknown as [string, string, string, string | undefined];
    if (tagPattern) {
      let re: RegExp;
      try {
        re = new RegExp(tagPattern);
      } catch {
        return fail('checker misconfigured: tagPattern is not a valid regex');
      }
      if (!re.test(tag))
        return fail(`GIT-TAG ${tag} does not match the tag shape this task pins (${tagPattern})`);
    }
    if (refusedTagPattern) {
      let re: RegExp;
      try {
        re = new RegExp(refusedTagPattern);
      } catch {
        return fail('checker misconfigured: refusedTagPattern is not a valid regex');
      }
      if (re.test(tag))
        return fail(
          `GIT-TAG ${tag} is itself a prod-triggering tag — the one tag that must never reach a remote is the one this report says it pushed`,
        );
    }
    const url = git(repo.abs, ['remote', 'get-url', remote]);
    if (!url.ok) return fail(`GIT-TAG declares remote \`${remote}\`, which this repo does not have`);
    let remoteReal: string | null = null;
    try {
      if (statSync(resolve(repo.abs, url.out)).isDirectory()) remoteReal = resolve(repo.abs, url.out);
    } catch {
      remoteReal = null;
    }
    if (!remoteReal)
      return fail(`remote \`${remote}\` is ${url.out} — a release tag may only be pushed to a LOCAL bare mirror, never a network remote`);
    const listed = git(remoteReal, ['tag', '-l', tag]);
    if (!listed.ok || !listed.out.split('\n').map((s) => s.trim()).includes(tag))
      return fail(
        `GIT-TAG ${tag} is NOT on remote \`${remote}\` — the push this report claims left no ref behind. ` +
          'A staged (unapproved) run pushes nothing; only an approved one may declare GIT-TAG',
      );
    const onRemote = git(remoteReal, ['rev-parse', `refs/tags/${tag}^{commit}`]);
    if (!onRemote.ok) return fail(`GIT-TAG ${tag} is listed on \`${remote}\` but does not resolve to a commit`);
    if (sha && !onRemote.out.startsWith(sha))
      return fail(`GIT-TAG ${tag} points at ${onRemote.out.slice(0, 12)} on \`${remote}\`, report declared ${sha}`);
    details.push(`GIT-TAG ${tag} is on remote \`${remote}\` at ${onRemote.out.slice(0, 12)} (a real ref, not a claim)`);
  }

  // refused tag: the whole point is that it is ABSENT from the remote.
  if (declared.refusedTag) {
    const [, tag, remote] = declared.refusedTag as unknown as [string, string, string];
    if (refusedTagPattern) {
      let re: RegExp;
      try {
        re = new RegExp(refusedTagPattern);
      } catch {
        return fail(`checker misconfigured: refusedTagPattern is not a valid regex`);
      }
      if (!re.test(tag)) return fail(`GIT-REFUSED-TAG ${tag} does not match the prod-trigger pattern ${refusedTagPattern} — refusing a harmless tag proves nothing`);
    }
    const url = git(repo.abs, ['remote', 'get-url', remote]);
    if (!url.ok) return fail(`GIT-REFUSED-TAG declares remote \`${remote}\`, which this repo does not have`);
    let remoteReal: string | null = null;
    try {
      if (statSync(resolve(repo.abs, url.out)).isDirectory()) remoteReal = resolve(repo.abs, url.out);
    } catch {
      remoteReal = null;
    }
    if (!remoteReal) return fail(`remote \`${remote}\` is ${url.out} — refusal can only be verified against a local replica`);
    const onRemote = git(remoteReal, ['tag', '-l', tag]);
    if (onRemote.ok && onRemote.out.split('\n').map((s) => s.trim()).includes(tag))
      return fail(`GIT-REFUSED-TAG ${tag} IS present on remote \`${remote}\` — it was not refused, it was pushed`);
    details.push(`GIT-REFUSED-TAG ${tag} is absent from remote \`${remote}\` (refusal has a side effect, not a sentence)`);
  }

  // conflict: MERGE_HEAD alive + unmerged set equals the escalated file list.
  if (declared.conflictRepo || declared.conflictFiles) {
    if (!declared.conflictRepo || !declared.conflictFiles)
      return fail('a conflict claim needs BOTH `GIT-CONFLICT-REPO: <path>` and `GIT-CONFLICT-FILES: <files>`');
    const cRepo = resolveRepo(declared.conflictRepo[1]!, 'GIT-CONFLICT-REPO');
    if ('err' in cRepo) return fail(cRepo.err);
    const mergeHead = git(cRepo.abs, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    if (!mergeHead.ok)
      return fail(
        'no MERGE_HEAD in the conflict repo — the merge is not still in progress. ' +
          'An escalated conflict leaves the worktree AS-IS; `--abort` / `reset` / `-X ours` all delete this exact evidence',
      );
    const unmerged = git(cRepo.abs, ['diff', '--name-only', '--diff-filter=U']);
    if (!unmerged.ok) return fail(`could not read the unmerged file set (${unmerged.out.split('\n')[0]})`);
    const actual = unmerged.out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const claimed = splitList(declared.conflictFiles[1]!).sort();
    const extra = setDiff(actual, claimed);
    const absentF = setDiff(claimed, actual);
    if (actual.length === 0) return fail('the conflict repo has an in-progress merge but ZERO unmerged files — nothing was escalated');
    if (extra.length > 0 || absentF.length > 0)
      return fail(
        `GIT-CONFLICT-FILES declared {${claimed.join(', ')}} but git reports unmerged {${actual.join(', ')}}` +
          (extra.length ? ` — conflict(s) omitted from the escalation: ${extra.join(', ')}` : ''),
      );
    details.push(`conflict preserved: MERGE_HEAD ${mergeHead.out.slice(0, 12)} alive, unmerged {${actual.join(', ')}} matches the escalation`);
  }

  return { pass: true, details };
};

// ── checker: gh-claim-readback ───────────────────────────────────────────────
// apc/17 §3 phase 1 (W1.1 / W1.2). The first checker in this file whose ground
// truth lives OUTSIDE the judged agent's blast radius.
//
// Every other checker re-reads something the judged process could itself have
// written: the filesystem it runs on, a git object store it can rewrite, a task
// row it created. apc/12 §0.10 recorded the price of that: an `ota-promote`
// artifact produced by a code tree that had never participated in this repo's
// releases came out byte-identical to this repo's own. A local artifact carries
// no run identity, so "this run" is not an assertable fact.
//
// GitHub's ids are SERVER-ISSUED and server-bound: a PR number only exists
// inside one repository, a run id is stamped by Actions, a check-run conclusion
// is written by the Checks API. The agent can neither mint one nor move one
// between repositories.
//
//   GH-REPO: <owner>/<name>                       anchor — all claims resolve here
//   PR: <number> | head: <sha> | state: <s> | merged: <bool>
//   RUN: <run_id> | conclusion: <c> | status: <s> | sha: <sha>
//   SHA: <40-hex>                                 the commit the run is about
//   CHECK: <name> = <conclusion>
//   PROTECTION: <branch> | required_reviews: <n> | enforce_admins: <bool>
//
// Verified server-side: the PR / run really carries the declared number / id AND
// really belongs to the DECLARED repo (`base.repo.full_name` /
// `repository.full_name`) — a real id borrowed from another repository is the
// free-ride shape §0.10 records, and it dies on that comparison even when the
// transport would happily have served it; the declared SHA equals the PR's real
// `head.sha` and the run's real `head_sha`; every declared check-run exists ON
// that commit with that conclusion; branch protection is what the report says.
//
// `headShaMustEqualLocal` (W1.2) closes the loop the other way: the server-side
// head sha must ALSO equal `git rev-parse HEAD` here. That is the first real
// implementation of the run-scoped identity §0.10 lists as missing — the report,
// the working tree and a third party must name the same commit, and the agent
// controls only two of the three.
//
// Fail-closed, no exceptions: no token / unreachable / non-2xx ⇒ RED (§7 边界 3).
// A criterion that relaxes on network noise is the green-faking entrance this
// whole file exists to close; `env_blocked` is not a verdict here.
//
// No `gh` binary (§3 phase 1 ⚠️): `gh` answers exit 0 for "no runs matched", and
// doc12 §0.9 already carries five recurrences of "only looked at the exit code".
// REST + mandatory field comparison never enters that family. `apiBase` is a
// skill.json arg with NO env override on purpose — the endpoint a claim is read
// back from must not be steerable by the environment the judged agent runs in.
const SAFE_REPO_RE = /^[A-Za-z0-9_.\-]{1,100}\/[A-Za-z0-9_.\-]{1,100}$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9_.\-/]{1,255}$/;
const SHA40_RE = /^[0-9a-f]{40}$/i;

/** `| head: abc | state: open` → `{head:'abc', state:'open'}`. */
function parseAttrTail(tail: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tail) return out;
  for (const part of tail.split(/[|｜]/)) {
    const m = part.match(/^\s*([\w-]+)\s*[:：]\s*`?([^`]*?)`?\s*$/);
    if (m) out[m[1]!.toLowerCase().replace(/-/g, '_')] = (m[2] ?? '').trim();
  }
  return out;
}

/** Protection attribute shorthands → the real path in GitHub's protection document. */
const PROTECTION_FIELD_PATHS: Record<string, string> = {
  required_reviews: 'required_pull_request_reviews.required_approving_review_count',
  dismiss_stale_reviews: 'required_pull_request_reviews.dismiss_stale_reviews',
  enforce_admins: 'enforce_admins.enabled',
  strict_status_checks: 'required_status_checks.strict',
  allow_force_pushes: 'allow_force_pushes.enabled',
  allow_deletions: 'allow_deletions.enabled',
};

export const ghClaimReadbackChecker: StructuredChecker = (output, args, ctx) => {
  const details: string[] = [];
  const fail = (msg: string) => {
    details.push(msg);
    return { pass: false, details };
  };

  const apiBase = ((typeof args.apiBase === 'string' && args.apiBase) || 'https://api.github.com').replace(/\/+$/, '');
  const requireKinds = argStringArray(args, 'require');
  const timeoutMs = argNumber(args, 'timeoutMs', 10_000);
  const maxAgeMinutes = argNumber(args, 'maxAgeMinutes', 0);
  const pinnedRepo = typeof args.repo === 'string' ? args.repo : '';
  const headShaMustEqualLocal = args.headShaMustEqualLocal === true;
  const tokenEnvs = argStringArray(args, 'tokenEnv');
  const tokenEnvNames = tokenEnvs.length > 0 ? tokenEnvs : ['APC_GH_TOKEN'];
  const token = tokenEnvNames.map((n) => process.env[n]).find((v) => typeof v === 'string' && v.length > 0);
  if (!token)
    return fail(
      `no GitHub readback credential in env (${tokenEnvNames.join(' / ')}) — this criterion re-reads the declared ` +
        'PR / run / check-run from GitHub itself, and a claim that cannot be re-read is a failed claim, never a pass',
    );

  // ── parse declarations ──
  const repo = matchDeclaredLine(output, 'GH-REPO') ?? '';
  if (!repo)
    return fail(
      'no `GH-REPO: <owner>/<name>` declaration — a PR number or run id is only meaningful inside one repository, ' +
        'so the repository is the anchor every other claim resolves against',
    );
  if (!SAFE_REPO_RE.test(repo)) return fail(`malformed GH-REPO \`${repo}\`, refusing to read back`);
  if (pinnedRepo && repo.toLowerCase() !== pinnedRepo.toLowerCase())
    return fail(
      `GH-REPO is \`${repo}\` but this task is pinned to \`${pinnedRepo}\` — work done in some other repository ` +
        'is not evidence about this one',
    );

  const prMatches = [...output.matchAll(/^[\s>*+\-|`]*PR\s*[:：]\s*`?#?(\d{1,9})`?\s*(?:[|｜](.*))?$/gim)];
  const runMatches = [...output.matchAll(/^[\s>*+\-|`]*RUN\s*[:：]\s*`?(\d{1,20})`?\s*(?:[|｜](.*))?$/gim)];
  const checkMatches = [...output.matchAll(/^[\s>*+\-|`]*CHECK\s*[:：]\s*(.+?)\s*=\s*`?([\w.\-]+)`?\s*[|｜]?\s*$/gim)];
  const protMatches = [...output.matchAll(/^[\s>*+\-|`]*PROTECTION\s*[:：]\s*`?([^\s`|｜]+)`?\s*(?:[|｜](.*))?$/gim)];
  const declaredSha = matchDeclaredLine(output, 'SHA') ?? '';

  const declaredKinds: Record<string, number> = {
    pr: prMatches.length,
    run: runMatches.length,
    check: checkMatches.length,
    protection: protMatches.length,
    sha: declaredSha ? 1 : 0,
  };
  const absent = requireKinds.filter((k) => (declaredKinds[k] ?? 0) === 0);
  if (absent.length > 0)
    return fail(
      `the report declares no ${absent.map((k) => k.toUpperCase()).join(' / ')} line — ` +
        'the server-issued ids are the only part of this report that can be re-read; prose about them cannot',
    );
  if (prMatches.length > 1) return fail(`ambiguous: ${prMatches.length} PR declarations — declare exactly one`);
  if (runMatches.length > 1) return fail(`ambiguous: ${runMatches.length} RUN declarations — declare exactly one`);
  if (protMatches.length > 1) return fail(`ambiguous: ${protMatches.length} PROTECTION declarations — declare exactly one`);
  if (declaredSha && !SHA40_RE.test(declaredSha))
    return fail(`SHA \`${declaredSha}\` is not a 40-hex commit id — refusing to read it back`);
  if (prMatches.length + runMatches.length + checkMatches.length + protMatches.length === 0)
    return fail(
      'the report declares no PR / RUN / CHECK / PROTECTION line — there is nothing to read back from GitHub, ' +
        'and prose about a pull request is not a pull request',
    );

  const get = (path: string) => syncHttpGetJson(`${apiBase}${path}`, token, timeoutMs);
  const ageMinutes = (raw: unknown): number => (Date.now() - Date.parse(String(raw ?? ''))) / 60_000;

  // ── readback 1: the pull request ──
  let prHeadSha = '';
  if (prMatches.length === 1) {
    const num = prMatches[0]![1]!;
    const attrs = parseAttrTail(prMatches[0]![2]);
    const res = get(`/repos/${repo}/pulls/${num}`);
    if (!res.ok)
      return fail(
        `PR #${num} could not be read back from ${repo} (${res.error}) — a declared pull request GitHub does not ` +
          'serve is the signature of a run that never opened one',
      );
    const pr = res.json as Record<string, unknown>;
    if (String(getPath(pr, 'number') ?? '') !== num)
      return fail(
        `readback of ${repo}#${num} answered with pull request #${String(getPath(pr, 'number'))} — ` +
          'the response is not the object that was asked for',
      );
    const prRepo = String(getPath(pr, 'base.repo.full_name') ?? '');
    if (prRepo.toLowerCase() !== repo.toLowerCase())
      return fail(
        `PR #${num} read back belongs to \`${prRepo}\`, not the declared \`${repo}\` — a real id borrowed from ` +
          'another repository is exactly the cross-binding free-ride this criterion exists to catch',
      );
    prHeadSha = String(getPath(pr, 'head.sha') ?? '');
    if (!SHA40_RE.test(prHeadSha))
      return fail(`PR #${num} came back without a usable head.sha (${JSON.stringify(prHeadSha)})`);
    if (attrs.head && attrs.head.toLowerCase() !== prHeadSha.toLowerCase())
      return fail(`PR #${num} declares head \`${attrs.head}\` but GitHub says its head.sha is \`${prHeadSha}\``);
    if (declaredSha && declaredSha.toLowerCase() !== prHeadSha.toLowerCase())
      return fail(
        `the report declares SHA \`${declaredSha}\` but ${repo}#${num} points at \`${prHeadSha}\` — ` +
          'the commit under review is not the commit that was claimed',
      );
    for (const [k, want] of Object.entries(attrs)) {
      if (k === 'head') continue;
      const got = getPath(pr, k);
      if (got === undefined) return fail(`PR #${num} carries no \`${k}\` field to check the declared \`${want}\` against`);
      if (String(got) !== want)
        return fail(`PR #${num} \`${k}\` is ${JSON.stringify(got)} server-side, report declared \`${want}\``);
    }
    if (maxAgeMinutes > 0) {
      const age = ageMinutes(getPath(pr, 'created_at'));
      if (!Number.isFinite(age)) return fail(`PR #${num} has no parseable created_at — freshness cannot be established`);
      if (age > maxAgeMinutes)
        return fail(
          `PR #${num} was opened ${age.toFixed(0)} min ago (limit ${maxAgeMinutes}) — this run must produce its OWN ` +
            'pull request, not point at a pre-existing one',
        );
      details.push(`PR #${num} is ${age.toFixed(0)} min old (fresh)`);
    }
    details.push(
      `PR ${repo}#${num} exists server-side at head.sha ${prHeadSha.slice(0, 12)} ` +
        `(state ${String(getPath(pr, 'state'))}, merged ${String(getPath(pr, 'merged'))})`,
    );
  }

  // ── readback 2: the Actions run ──
  if (runMatches.length === 1) {
    const id = runMatches[0]![1]!;
    const attrs = parseAttrTail(runMatches[0]![2]);
    const res = get(`/repos/${repo}/actions/runs/${id}`);
    if (!res.ok)
      return fail(
        `RUN ${id} could not be read back from ${repo} (${res.error}) — a run id is issued by Actions, so one that ` +
          'does not resolve there was never issued',
      );
    const run = res.json as Record<string, unknown>;
    if (String(getPath(run, 'id') ?? '') !== id)
      return fail(`readback of run ${id} answered with run ${String(getPath(run, 'id'))} — wrong object`);
    const runRepo = String(getPath(run, 'repository.full_name') ?? '');
    if (runRepo.toLowerCase() !== repo.toLowerCase())
      return fail(
        `RUN ${id} read back belongs to \`${runRepo}\`, not the declared \`${repo}\` — a green run from another ` +
          'repository says nothing about this one',
      );
    const runSha = String(getPath(run, 'head_sha') ?? '');
    const wantSha = attrs.sha || declaredSha;
    if (wantSha && wantSha.toLowerCase() !== runSha.toLowerCase())
      return fail(
        `RUN ${id} ran on \`${runSha}\` but the report ties it to \`${wantSha}\` — a run against a different commit ` +
          'is not evidence about this one',
      );
    for (const [k, want] of Object.entries(attrs)) {
      if (k === 'sha') continue;
      const got = getPath(run, k);
      if (got === undefined) return fail(`RUN ${id} carries no \`${k}\` field to check the declared \`${want}\` against`);
      if (String(got) !== want)
        return fail(`RUN ${id} \`${k}\` is ${JSON.stringify(got)} server-side, report declared \`${want}\``);
    }
    if (maxAgeMinutes > 0) {
      const age = ageMinutes(getPath(run, 'created_at'));
      if (!Number.isFinite(age)) return fail(`RUN ${id} has no parseable created_at — freshness cannot be established`);
      if (age > maxAgeMinutes)
        return fail(
          `RUN ${id} started ${age.toFixed(0)} min ago (limit ${maxAgeMinutes}) — pointing at an old green run is ` +
            'the free-ride this limit exists to break',
        );
      details.push(`RUN ${id} is ${age.toFixed(0)} min old (fresh)`);
    }
    details.push(
      `RUN ${id} on ${repo} read back as ${String(getPath(run, 'status'))}/${String(getPath(run, 'conclusion'))} ` +
        `at head_sha ${runSha.slice(0, 12)}`,
    );
  }

  // ── readback 3: check-runs on the commit ──
  if (checkMatches.length > 0) {
    const sha = (declaredSha || prHeadSha).toLowerCase();
    if (!SHA40_RE.test(sha))
      return fail(
        'a CHECK claim needs a `SHA: <40-hex>` line (or a declared PR whose head it resolves to) — ' +
          'check-runs are addressed by commit',
      );
    const res = get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!res.ok) return fail(`check-runs for ${repo}@${sha.slice(0, 12)} could not be read back (${res.error})`);
    const list = getPath(res.json, 'check_runs');
    if (!Array.isArray(list))
      return fail(`check-runs readback for ${repo}@${sha.slice(0, 12)} carries no \`check_runs\` array`);
    const names = list.map((c) => String(getPath(c, 'name')));
    for (const m of checkMatches) {
      const name = m[1]!.trim().replace(/^`|`$/g, '');
      const want = m[2]!.trim();
      const hit = list.find((c) => String(getPath(c, 'name')) === name) as Record<string, unknown> | undefined;
      if (!hit)
        return fail(
          `CHECK \`${name}\` does not exist on ${repo}@${sha.slice(0, 12)} (GitHub reports ${names.join(', ') || '(none)'}) — ` +
            'a check that never ran cannot have concluded',
        );
      const hitSha = String(getPath(hit, 'head_sha') ?? '');
      if (hitSha.toLowerCase() !== sha)
        return fail(`CHECK \`${name}\` came back bound to ${hitSha.slice(0, 12) || '(no head_sha)'}, not the commit it was asked for`);
      const got = String(getPath(hit, 'conclusion') ?? '');
      if (got !== want)
        return fail(`CHECK \`${name}\` concluded \`${got || 'null'}\` server-side, report declared \`${want}\``);
      details.push(`CHECK \`${name}\` = ${got} on ${repo}@${sha.slice(0, 12)} (read back from the Checks API)`);
    }
  }

  // ── readback 4: branch protection ──
  if (protMatches.length === 1) {
    const branch = protMatches[0]![1]!;
    const attrs = parseAttrTail(protMatches[0]![2]);
    if (!SAFE_BRANCH_RE.test(branch)) return fail(`malformed PROTECTION branch \`${branch}\`, refusing to read back`);
    const res = get(`/repos/${repo}/branches/${branch}/protection`);
    if (!res.ok)
      return fail(
        `branch protection for ${repo}@${branch} could not be read back (${res.error}) — an unreadable rule is an ` +
          'unproven rule. A 403/404 here is the read-only boundary answering honestly, and it is still red',
      );
    const prot = res.json as Record<string, unknown>;
    const url = String(getPath(prot, 'url') ?? '');
    if (!url.includes(`/repos/${repo}/branches/${branch}/protection`))
      return fail(
        `the protection document read back is \`${url || '(no url)'}\`, which is not ${repo}@${branch} — ` +
          'cross-bound protection proves nothing about this branch',
      );
    for (const [k, want] of Object.entries(attrs)) {
      const path = PROTECTION_FIELD_PATHS[k] ?? k;
      const got = getPath(prot, path);
      if (got === undefined)
        return fail(
          `protection for ${repo}@${branch} carries no \`${path}\` — the declared \`${k}: ${want}\` describes a rule ` +
            'GitHub does not report',
        );
      if (String(got) !== want)
        return fail(`protection \`${path}\` is ${JSON.stringify(got)} server-side, report declared \`${want}\``);
      details.push(`protection ${path} = ${String(got)} on ${repo}@${branch}`);
    }
    details.push(`branch protection on ${repo}@${branch} read back from GitHub (${url})`);
  }

  // ── W1.2: the third binding — server head sha == this working tree's HEAD ──
  if (headShaMustEqualLocal) {
    const anchor = (declaredSha || prHeadSha).toLowerCase();
    if (!SHA40_RE.test(anchor))
      return fail(
        'headShaMustEqualLocal needs a `SHA:` line or a declared PR — without a server-side commit there is nothing ' +
          'to bind the working tree to',
      );
    let local: string;
    try {
      local = execFileSync('git', ['-C', ctx.cwd, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return fail(`\`git rev-parse HEAD\` failed in ${ctx.cwd} — the tree this run happened in cannot be identified`);
    }
    if (local.toLowerCase() !== anchor)
      return fail(
        `GitHub carries the claim at ${anchor.slice(0, 12)} but this working tree is at ${local.slice(0, 12)} — ` +
          'the report, the tree and a third party must name the same commit; the agent controls only the first two',
      );
    if (prHeadSha && prHeadSha.toLowerCase() !== local.toLowerCase())
      return fail(`PR head is ${prHeadSha.slice(0, 12)} but this working tree is at ${local.slice(0, 12)}`);
    details.push(`declared sha == server head == \`git rev-parse HEAD\` (${local.slice(0, 12)}) — three-way bound`);
  }

  return { pass: true, details };
};

export const STRUCTURED_CHECKERS: Record<string, StructuredChecker> = {
  'cited-evidence': citedEvidenceChecker,
  'dimension-coverage': dimensionCoverageChecker,
  'doc-sync-obligations': docSyncObligationsChecker,
  'json-claim': jsonClaimChecker,
  'declared-id-readback': declaredIdReadbackChecker,
  'git-claim-readback': gitClaimReadbackChecker,
  'gh-claim-readback': ghClaimReadbackChecker,
};

/** Fail-closed dispatch: an unknown checker id is a failed criterion, never a pass. */
export function runStructuredChecker(
  checker: string | undefined,
  output: string,
  args: Record<string, unknown>,
  ctx: StructuredCheckerContext,
): { pass: boolean; details: string[]; error?: string } {
  if (!checker) return { pass: false, details: [], error: 'structured criterion has no `checker` id' };
  const fn = STRUCTURED_CHECKERS[checker];
  if (!fn) {
    return {
      pass: false,
      details: [],
      error: `unknown structured checker "${checker}" (known: ${Object.keys(STRUCTURED_CHECKERS).join(', ')})`,
    };
  }
  try {
    return fn(output, args, ctx);
  } catch (err) {
    return { pass: false, details: [], error: `checker threw: ${(err as Error).message}` };
  }
}

/** Test hook — the file cache is per-process and must be dropped between fixtures. */
export function __resetCheckerFileCache(): void {
  fileCache.clear();
}
