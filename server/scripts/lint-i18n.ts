#!/usr/bin/env tsx
/**
 * lint:i18n — scan workspace + studio surfaces for hardcoded user-facing strings.
 *
 * Detects:
 *   - JSX text content: >Capital Word< pattern
 *   - aria-label="Capital..."
 *   - title="Capital..."
 *   - placeholder="Capital..."
 *
 * Excludes:
 *   - data-testid attrs
 *   - Comments (// or block /* … *​/)
 *   - import paths, className strings, log/error messages (lib path heuristic)
 *   - Lines containing a t(…) translator call (i18n already applied)
 *   - Lines suffixed with `// lint:i18n disable`
 *
 * Usage:
 *   tsx scripts/lint-i18n.ts                       # scan all configured roots
 *   tsx scripts/lint-i18n.ts --file <path>         # scan a single file
 *   tsx scripts/lint-i18n.ts --ci-threshold=N      # fail only if hits exceed N
 *   tsx scripts/lint-i18n.ts --json                # machine-readable output
 *
 * Exit codes:
 *   0  no hits (or hits <= --ci-threshold)
 *   1  hits found (and exceeds threshold if supplied)
 *   2  invocation error
 */

import fg from 'fast-glob';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

interface Hit {
  file: string;
  line: number;
  column: number;
  kind: 'jsx-text' | 'aria-label' | 'title' | 'placeholder';
  match: string;
  snippet: string;
}

interface CliArgs {
  file: string | null;
  threshold: number | null;
  json: boolean;
  quiet: boolean;
}

const ROOTS = [
  'src/app/workspace/**/*.tsx',
  'src/app/workspace/**/*.ts',
  'src/app/evolution/**/*.tsx',
  'src/app/evolution/**/*.ts',
];

const REPO_ROOT = resolve(__dirname, '..');

// File-level allowlist (test files, generated, devtools).
const FILE_ALLOWLIST = [
  '**/__tests__/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/node_modules/**',
];

// Word allowlist — single-word capitalized identifiers that are *not* user-facing
// (component names, constants, JSX self-closing markers, etc.).
const WORD_ALLOWLIST = new Set([
  // common JSX identifiers that show up in >Word< form
  'Fragment',
  'Suspense',
  'Provider',
  'Consumer',
  // common React/Next render markers
  'Outlet',
  'Children',
]);

const DISABLE_DIRECTIVE = /\/\/\s*lint:i18n\s+disable/;
const T_CALL = /\bt\s*\(\s*['"`]/; // `t('key')` or `t("key")` — already keyed
const URL_LIKE = /^https?:\/\//;

const RE_JSX_TEXT = />([A-Z][a-zA-Z]+(?: [a-zA-Z]+){0,5})</g;
const RE_ATTR = /\b(aria-label|title|placeholder)="([A-Z][a-zA-Z]+(?: [a-zA-Z]+){0,5})"/g;

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { file: null, threshold: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' && argv[i + 1]) {
      out.file = argv[++i];
    } else if (a.startsWith('--file=')) {
      out.file = a.slice('--file='.length);
    } else if (a.startsWith('--ci-threshold=')) {
      out.threshold = Number(a.slice('--ci-threshold='.length));
    } else if (a === '--ci-threshold' && argv[i + 1]) {
      out.threshold = Number(argv[++i]);
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--quiet') {
      out.quiet = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'lint:i18n — scan workspace + evolution surfaces for hardcoded English strings.\n' +
          'Flags: --file <path> | --ci-threshold=N | --json | --quiet',
      );
      process.exit(0);
    }
  }
  if (out.threshold !== null && (!Number.isFinite(out.threshold) || out.threshold < 0)) {
    console.error('[lint:i18n] invalid --ci-threshold (must be non-negative integer)');
    process.exit(2);
  }
  return out;
}

/**
 * Strip JS/TS comments from a source string while preserving line numbers.
 * Returns an array of lines where commented-out regions are replaced with spaces.
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  const lines = source.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlock) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) {
        out.push(' '.repeat(line.length));
        continue;
      }
      line = ' '.repeat(endIdx + 2) + line.slice(endIdx + 2);
      inBlock = false;
    }
    // Walk through line stripping any /* … */ and // tail.
    let result = '';
    let i = 0;
    let inStr: '"' | "'" | '`' | null = null;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (inStr) {
        result += ch;
        if (ch === '\\' && i + 1 < line.length) {
          result += next;
          i += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch as '"' | "'" | '`';
        result += ch;
        i++;
        continue;
      }
      if (ch === '/' && next === '/') {
        result += ' '.repeat(line.length - i);
        i = line.length;
        break;
      }
      if (ch === '/' && next === '*') {
        const endIdx = line.indexOf('*/', i + 2);
        if (endIdx === -1) {
          result += ' '.repeat(line.length - i);
          inBlock = true;
          i = line.length;
          break;
        }
        result += ' '.repeat(endIdx + 2 - i);
        i = endIdx + 2;
        continue;
      }
      result += ch;
      i++;
    }
    out.push(result);
  }
  return out;
}

function scanFile(absPath: string): Hit[] {
  const source = readFileSync(absPath, 'utf8');
  const stripped = stripComments(source);
  const rawLines = source.split('\n');
  const hits: Hit[] = [];
  const relPath = relative(REPO_ROOT, absPath);

  for (let i = 0; i < stripped.length; i++) {
    const code = stripped[i];
    const raw = rawLines[i] ?? '';

    if (!code.trim()) continue;
    if (DISABLE_DIRECTIVE.test(raw)) continue;
    // Already-keyed line — assume the developer is composing with t(...).
    if (T_CALL.test(code)) continue;
    // URL/path-only lines — common in href, src
    if (URL_LIKE.test(code.trim())) continue;

    // JSX text hits
    RE_JSX_TEXT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_JSX_TEXT.exec(code)) !== null) {
      const phrase = m[1];
      // Skip single-word allowlist matches (component-ish identifiers).
      if (!phrase.includes(' ') && WORD_ALLOWLIST.has(phrase)) continue;
      hits.push({
        file: relPath,
        line: i + 1,
        column: m.index + 1,
        kind: 'jsx-text',
        match: phrase,
        snippet: raw.trim().slice(0, 160),
      });
    }

    // Attr hits
    RE_ATTR.lastIndex = 0;
    while ((m = RE_ATTR.exec(code)) !== null) {
      const attr = m[1];
      const phrase = m[2];
      hits.push({
        file: relPath,
        line: i + 1,
        column: m.index + 1,
        kind: attr as Hit['kind'],
        match: phrase,
        snippet: raw.trim().slice(0, 160),
      });
    }
  }

  return hits;
}

async function collectFiles(args: CliArgs): Promise<string[]> {
  if (args.file) {
    const abs = resolve(REPO_ROOT, args.file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      console.error(`[lint:i18n] file not found: ${args.file}`);
      process.exit(2);
    }
    return [abs];
  }
  const files = await fg(ROOTS, {
    cwd: REPO_ROOT,
    absolute: true,
    ignore: FILE_ALLOWLIST,
    onlyFiles: true,
  });
  return files;
}

function reportMarkdown(hits: Hit[], scanned: number, args: CliArgs): void {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const arr = byFile.get(h.file) ?? [];
    arr.push(h);
    byFile.set(h.file, arr);
  }
  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  if (args.quiet) {
    console.log(`${hits.length} hits across ${byFile.size} files (scanned ${scanned}).`);
    return;
  }

  console.log(`# lint:i18n report\n`);
  console.log(`- Scanned files: **${scanned}**`);
  console.log(`- Files with hits: **${byFile.size}**`);
  console.log(`- Total hits: **${hits.length} hits**`);
  if (args.threshold !== null) {
    console.log(`- CI threshold: **${args.threshold}**`);
  }
  console.log('');

  if (hits.length === 0) {
    console.log('No hardcoded user-facing strings detected. 0 hits.');
    return;
  }

  console.log(`## Top files\n`);
  for (const [file, fileHits] of sorted.slice(0, 15)) {
    console.log(`### ${file} — ${fileHits.length} hits`);
    for (const h of fileHits.slice(0, 8)) {
      console.log(`- L${h.line}:${h.column} [${h.kind}] "${h.match}"`);
    }
    if (fileHits.length > 8) {
      console.log(`- … +${fileHits.length - 8} more`);
    }
    console.log('');
  }

  if (sorted.length > 15) {
    console.log(`\n_(+${sorted.length - 15} more files with hits — pass --json for full list.)_`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = await collectFiles(args);
  const hits: Hit[] = [];
  for (const f of files) {
    hits.push(...scanFile(f));
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scanned: files.length,
          hitCount: hits.length,
          hits,
        },
        null,
        2,
      ),
    );
  } else {
    reportMarkdown(hits, files.length, args);
  }

  const threshold = args.threshold;
  if (hits.length === 0) {
    process.exit(0);
  }
  if (threshold !== null && hits.length <= threshold) {
    if (!args.json && !args.quiet) {
      console.log(`\n(under --ci-threshold=${threshold}; exiting 0)`);
    }
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[lint:i18n] crashed:', err);
  process.exit(2);
});
