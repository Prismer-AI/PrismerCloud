/**
 * Documentation Link Checker
 *
 * Scans all .md files in the repo (excluding node_modules, .git, prisma/generated),
 * extracts external URLs and internal file references, checks them, and reports broken links.
 *
 * Usage:
 *   npx tsx scripts/check-doc-links.ts
 *   npx tsx scripts/check-doc-links.ts --verbose    # Show all links, not just broken
 *   npx tsx scripts/check-doc-links.ts --skip-external  # Skip HTTP checks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Configuration
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'docs', 'v181-doc-links-report.json');

const EXCLUDE_DIRS = ['node_modules', '.git', 'prisma/generated', '.next', 'dist'];
const HTTP_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MS = 100;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const skipExternal = args.includes('--skip-external');

// =============================================================================
// Types
// =============================================================================

interface LinkResult {
  file: string; // relative path from repo root
  line: number;
  url: string;
  type: 'external' | 'internal';
  status: 'ok' | 'broken' | 'error' | 'skipped';
  statusCode?: number;
  errorMessage?: string;
}

interface Report {
  timestamp: string;
  filesScanned: number;
  totalLinks: number;
  externalLinks: number;
  internalLinks: number;
  brokenLinks: number;
  skippedLinks: number;
  broken: LinkResult[];
  allResults: LinkResult[];
}

// =============================================================================
// File Discovery
// =============================================================================

function discoverMarkdownFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(ROOT, fullPath);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.some((ex) => relPath === ex || relPath.startsWith(ex + '/'))) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(ROOT);
  return results.sort();
}

// =============================================================================
// Link Extraction
// =============================================================================

interface ExtractedLink {
  url: string;
  line: number;
  type: 'external' | 'internal';
}

function extractLinks(filePath: string): ExtractedLink[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Track code blocks
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    // Extract markdown links: [text](url)
    const mdLinkRegex = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdLinkRegex.exec(line)) !== null) {
      let url = match[1].trim();

      // Strip fragment identifiers for internal links
      const urlWithoutFragment = url.split('#')[0];

      // Skip anchors-only (e.g. [link](#section))
      if (!urlWithoutFragment) continue;

      // Skip mailto: and other non-http/file schemes
      if (url.startsWith('mailto:')) continue;

      const key = `${filePath}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (url.startsWith('http://') || url.startsWith('https://')) {
        links.push({ url, line: lineNum, type: 'external' });
      } else {
        links.push({ url: urlWithoutFragment, line: lineNum, type: 'internal' });
      }
    }

    // Extract bare external URLs (not already captured in markdown links)
    const bareUrlRegex = /(?<!\()(?<!\]\()https?:\/\/[^\s<>)"'\]]+/g;
    while ((match = bareUrlRegex.exec(line)) !== null) {
      const url = match[0].replace(/[.,;:!?)]+$/, ''); // trim trailing punctuation

      const key = `${filePath}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({ url, line: lineNum, type: 'external' });
    }
  }

  return links;
}

// =============================================================================
// Link Checking
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkExternalUrl(url: string): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'PrismerDocLinkChecker/1.0',
        Accept: '*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    // Some servers reject HEAD; retry with GET for 405/403
    if (response.status === 405 || response.status === 403) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), HTTP_TIMEOUT_MS);
      try {
        const getResponse = await fetch(url, {
          method: 'GET',
          signal: controller2.signal,
          headers: {
            'User-Agent': 'PrismerDocLinkChecker/1.0',
            Accept: '*/*',
          },
          redirect: 'follow',
        });
        clearTimeout(timer2);
        if (getResponse.status >= 400) {
          return { ok: false, statusCode: getResponse.status };
        }
        return { ok: true, statusCode: getResponse.status };
      } catch (err: any) {
        clearTimeout(timer2);
        return { ok: false, error: err.message || String(err) };
      }
    }

    if (response.status >= 400) {
      return { ok: false, statusCode: response.status };
    }
    return { ok: true, statusCode: response.status };
  } catch (err: any) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? `Timeout after ${HTTP_TIMEOUT_MS}ms` : err.message || String(err);
    return { ok: false, error: msg };
  }
}

function checkInternalRef(filePath: string, ref: string): { ok: boolean; error?: string } {
  const dir = path.dirname(filePath);
  const resolved = path.resolve(dir, ref);

  if (fs.existsSync(resolved)) {
    return { ok: true };
  }

  // Also try with common extensions if no extension
  if (!path.extname(ref)) {
    for (const ext of ['.md', '.ts', '.tsx', '.js', '.json']) {
      if (fs.existsSync(resolved + ext)) {
        return { ok: true };
      }
    }
  }

  return { ok: false, error: `File not found: ${resolved}` };
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log('[DocLinkChecker] Scanning markdown files...');
  const files = discoverMarkdownFiles();
  console.log(`[DocLinkChecker] Found ${files.length} .md files`);

  // Extract all links
  const allExtracted: { file: string; links: ExtractedLink[] }[] = [];
  let totalLinks = 0;
  let externalCount = 0;
  let internalCount = 0;

  for (const file of files) {
    const links = extractLinks(file);
    if (links.length > 0) {
      allExtracted.push({ file, links });
      totalLinks += links.length;
      externalCount += links.filter((l) => l.type === 'external').length;
      internalCount += links.filter((l) => l.type === 'internal').length;
    }
  }

  console.log(`[DocLinkChecker] Extracted ${totalLinks} links (${externalCount} external, ${internalCount} internal)`);

  // Check all links
  const results: LinkResult[] = [];
  let checkedCount = 0;
  const externalUrlCache = new Map<string, { ok: boolean; statusCode?: number; error?: string }>();

  for (const { file, links } of allExtracted) {
    const relFile = path.relative(ROOT, file);

    for (const link of links) {
      checkedCount++;
      if (checkedCount % 50 === 0) {
        console.log(`[DocLinkChecker] Progress: ${checkedCount}/${totalLinks}`);
      }

      if (link.type === 'internal') {
        const result = checkInternalRef(file, link.url);
        results.push({
          file: relFile,
          line: link.line,
          url: link.url,
          type: 'internal',
          status: result.ok ? 'ok' : 'broken',
          errorMessage: result.error,
        });
      } else {
        // External
        if (skipExternal) {
          results.push({
            file: relFile,
            line: link.line,
            url: link.url,
            type: 'external',
            status: 'skipped',
          });
          continue;
        }

        // Deduplicate external URL checks
        let cached = externalUrlCache.get(link.url);
        if (!cached) {
          await sleep(RATE_LIMIT_MS);
          cached = await checkExternalUrl(link.url);
          externalUrlCache.set(link.url, cached);
        }

        results.push({
          file: relFile,
          line: link.line,
          url: link.url,
          type: 'external',
          status: cached.ok ? 'ok' : cached.statusCode ? 'broken' : 'error',
          statusCode: cached.statusCode,
          errorMessage: cached.error,
        });
      }
    }
  }

  // Summarize
  const brokenResults = results.filter((r) => r.status === 'broken' || r.status === 'error');
  const skippedResults = results.filter((r) => r.status === 'skipped');

  console.log('\n' + '='.repeat(72));
  console.log('[DocLinkChecker] Results Summary');
  console.log('='.repeat(72));
  console.log(`  Files scanned:   ${files.length}`);
  console.log(`  Total links:     ${totalLinks}`);
  console.log(`  External links:  ${externalCount}`);
  console.log(`  Internal links:  ${internalCount}`);
  console.log(`  Broken links:    ${brokenResults.length}`);
  console.log(`  Skipped links:   ${skippedResults.length}`);

  if (brokenResults.length > 0) {
    console.log('\n' + '-'.repeat(72));
    console.log('Broken Links:');
    console.log('-'.repeat(72));
    for (const r of brokenResults) {
      const statusInfo = r.statusCode ? `HTTP ${r.statusCode}` : r.errorMessage || 'unknown error';
      console.log(`  ${r.file}:${r.line}`);
      console.log(`    ${r.type.toUpperCase()} ${r.url}`);
      console.log(`    -> ${statusInfo}`);
    }
  }

  if (verbose) {
    const okResults = results.filter((r) => r.status === 'ok');
    if (okResults.length > 0) {
      console.log('\n' + '-'.repeat(72));
      console.log('OK Links:');
      console.log('-'.repeat(72));
      for (const r of okResults) {
        console.log(`  ${r.file}:${r.line} ${r.url} ${r.statusCode ? `(${r.statusCode})` : ''}`);
      }
    }
  }

  // Build report
  const report: Report = {
    timestamp: new Date().toISOString(),
    filesScanned: files.length,
    totalLinks: totalLinks,
    externalLinks: externalCount,
    internalLinks: internalCount,
    brokenLinks: brokenResults.length,
    skippedLinks: skippedResults.length,
    broken: brokenResults,
    allResults: results,
  };

  // Save JSON report
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n[DocLinkChecker] Report saved to ${path.relative(ROOT, REPORT_PATH)}`);

  // Exit code
  if (brokenResults.length > 0) {
    console.log(`\n[DocLinkChecker] FAIL: ${brokenResults.length} broken link(s) found`);
    process.exit(1);
  } else {
    console.log('\n[DocLinkChecker] PASS: No broken links found');
  }
}

main().catch((err) => {
  console.error('[DocLinkChecker] Fatal error:', err);
  process.exit(2);
});
