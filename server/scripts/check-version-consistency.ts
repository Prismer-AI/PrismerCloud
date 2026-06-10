/**
 * Version Consistency Checker
 *
 * Scans all version declarations across the monorepo and flags
 * any package that does not match the root /VERSION file (single
 * source of truth, per CLAUDE.md §Versioning Principle).
 *
 * Sources checked:
 *   - Root /VERSION                                       (single source of truth)
 *   - Root package.json
 *   - sdk / * / package.json                              (excluding node_modules)
 *   - sdk / * / pyproject.toml
 *   - sdk / * / Cargo.toml                                (excluding target/)
 *   - sdk / * / .claude-plugin/plugin.json                (claude-code-plugin manifest)
 *   - sdk/prismer-cloud/mcp/src/index.ts                  (McpServer hardcoded version)
 *   - sdk/prismer-cloud/runtime/src/cli/index.ts          (const VERSION literal)
 *   - sdk/prismer-cloud/rust/src/cli.rs                   (clap version attr — env! macro should match Cargo.toml)
 *   - src/lib/version.ts
 *
 * Intentionally NOT scanned:
 *   - sdk/prismer-cloud/runtime/src/cli/util.ts           (banner subtitle reads
 *     dynamically from runtime/package.json at module load — drift impossible
 *     by construction, no static scan needed)
 *
 * Usage: npx tsx scripts/check-version-consistency.ts
 */

import { readFileSync } from 'fs';
import fg from 'fast-glob';
import { resolve, relative } from 'path';

const ROOT = resolve(__dirname, '..');
const VERSION_FILE = resolve(ROOT, 'VERSION');
const ROOT_VERSION = readFileSync(VERSION_FILE, 'utf-8').trim(); // e.g. "2.0.0"
const EXPECTED_VERSION = ROOT_VERSION; // exact match — full semver, not major.minor

// ─── Types ──────────────────────────────────────────────────────────────────

interface VersionEntry {
  source: string; // relative file path
  label: string; // human-readable package identifier
  version: string; // extracted version string
  aligned: boolean; // true if version matches EXPECTED_VERSION exactly
}

// ─── Extraction helpers ─────────────────────────────────────────────────────

function extractFromPackageJson(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    if (!json.version) return null;
    const ver: string = json.version;
    return {
      source: relative(ROOT, filePath),
      label: json.name || relative(ROOT, filePath),
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

function extractFromPyproject(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Match version = "X.Y.Z" in [project] or [tool.poetry] sections
    const match = content.match(/^version\s*=\s*"([^"]+)"/m);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: relative(ROOT, filePath),
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

function extractFromCargoToml(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Match the first version = "X.Y.Z" (usually in [package])
    const match = content.match(/^version\s*=\s*"([^"]+)"/m);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: relative(ROOT, filePath),
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

function extractFromVersionTs(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/export\s+const\s+VERSION\s*=\s*'([^']+)'/);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: 'src/lib/version.ts (VERSION)',
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

// Matches the `const VERSION = '...'` literal in runtime/src/cli/index.ts
// (kept in sync via sdk/build/version.sh `bump_runtime_cli_version`).
function extractFromRuntimeCliVersion(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^const\s+VERSION\s*=\s*'([^']+)'/m);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: 'runtime/src/cli/index.ts (const VERSION)',
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

// Matches the McpServer `version: '...'` literal in mcp/src/index.ts
// (kept in sync via sdk/build/version.sh `bump_hardcoded`).
function extractFromMcpServerVersion(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Look for `name: 'prismer'` followed by `version: '...'` (McpServer block).
    const match = content.match(/name:\s*['"]prismer['"]\s*,\s*version:\s*['"]([^'"]+)['"]/);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: 'mcp/src/index.ts (McpServer version)',
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

// Matches the clap `version = "..."` literal in rust/src/cli.rs.
// After R1, this should be `env!("CARGO_PKG_VERSION")` — we accept that as
// always aligned (it inherits from Cargo.toml, already checked).
function extractFromRustCli(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // env! macro — treat as aligned since Cargo.toml is already validated above.
    if (/version\s*=\s*env!\(\s*"CARGO_PKG_VERSION"\s*\)/.test(content)) {
      return {
        source: relative(ROOT, filePath),
        label: 'rust/src/cli.rs (clap version, env! macro)',
        version: EXPECTED_VERSION,
        aligned: true,
      };
    }
    // Fallback: hardcoded literal (regression detector).
    const match = content.match(/version\s*=\s*"([^"]+)"/);
    if (!match) return null;
    const ver = match[1];
    return {
      source: relative(ROOT, filePath),
      label: 'rust/src/cli.rs (clap version, hardcoded)',
      version: ver,
      aligned: ver === EXPECTED_VERSION,
    };
  } catch {
    return null;
  }
}

// ─── File discovery ─────────────────────────────────────────────────────────

function findFiles(pattern: string, ignore: string[] = []): string[] {
  return fg.sync(pattern, {
    cwd: ROOT,
    absolute: true,
    ignore,
    dot: true, // include dotfile dirs like .claude-plugin/
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n[VersionCheck] Scanning for version declarations...`);
  console.log(`[VersionCheck] Expected version (from /VERSION): ${EXPECTED_VERSION}\n`);

  const entries: VersionEntry[] = [];

  // 1. Root package.json
  const rootEntry = extractFromPackageJson(resolve(ROOT, 'package.json'));
  if (rootEntry) {
    rootEntry.label = 'Root package.json';
    entries.push(rootEntry);
  }

  // 2. SDK package.json files (exclude node_modules and target/)
  const sdkPackageJsons = findFiles('sdk/**/package.json', ['**/node_modules/**', '**/target/**']);
  for (const f of sdkPackageJsons) {
    const entry = extractFromPackageJson(f);
    if (entry) entries.push(entry);
  }

  // 3. SDK pyproject.toml files
  const pyprojects = findFiles('sdk/**/pyproject.toml', ['**/node_modules/**', '**/target/**']);
  for (const f of pyprojects) {
    const entry = extractFromPyproject(f);
    if (entry) entries.push(entry);
  }

  // 4. SDK Cargo.toml files (exclude target/)
  const cargos = findFiles('sdk/**/Cargo.toml', ['**/node_modules/**', '**/target/**']);
  for (const f of cargos) {
    const entry = extractFromCargoToml(f);
    if (entry) entries.push(entry);
  }

  // 5. src/lib/version.ts
  const versionTsEntry = extractFromVersionTs(resolve(ROOT, 'src/lib/version.ts'));
  if (versionTsEntry) entries.push(versionTsEntry);

  // 6. plugin.json files (claude-code-plugin manifest, etc.)
  const pluginJsons = findFiles('sdk/**/plugin.json', ['**/node_modules/**', '**/target/**']);
  for (const f of pluginJsons) {
    const entry = extractFromPackageJson(f);
    if (entry) {
      entry.label = `${relative(ROOT, f)} (plugin manifest)`;
      entries.push(entry);
    }
  }

  // 7. Hardcoded version literals in TS source files.
  const runtimeCliEntry = extractFromRuntimeCliVersion(
    resolve(ROOT, 'sdk/prismer-cloud/runtime/src/cli/index.ts'),
  );
  if (runtimeCliEntry) entries.push(runtimeCliEntry);

  const mcpServerEntry = extractFromMcpServerVersion(
    resolve(ROOT, 'sdk/prismer-cloud/mcp/src/index.ts'),
  );
  if (mcpServerEntry) entries.push(mcpServerEntry);

  // 8. Rust CLI version attr (sanity check; env! macro should align by construction).
  const rustCliEntry = extractFromRustCli(resolve(ROOT, 'sdk/prismer-cloud/rust/src/cli.rs'));
  if (rustCliEntry) entries.push(rustCliEntry);

  // ─── Group by exact version ────────────────────────────────────────────

  const groups = new Map<string, VersionEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.version) || [];
    list.push(e);
    groups.set(e.version, list);
  }

  // ─── Report ────────────────────────────────────────────────────────────

  const aligned = entries.filter((e) => e.aligned);
  const misaligned = entries.filter((e) => !e.aligned);

  console.log('='.repeat(72));
  console.log('  VERSION CONSISTENCY REPORT');
  console.log('='.repeat(72));

  // Aligned packages
  console.log(`\n  Aligned (${EXPECTED_VERSION}) — ${aligned.length} package(s):\n`);
  if (aligned.length === 0) {
    console.log('    (none)');
  } else {
    for (const e of aligned) {
      console.log(`    ${e.version.padEnd(12)} ${e.label}`);
    }
  }

  // Misaligned packages
  if (misaligned.length > 0) {
    console.log(`\n  MISALIGNED — ${misaligned.length} package(s):\n`);
    for (const e of misaligned) {
      console.log(`    ${e.version.padEnd(12)} ${e.label}  (expected ${EXPECTED_VERSION})`);
    }
  }

  // Summary by exact version
  console.log(`\n  Version groups:`);
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const list = groups.get(key)!;
    const marker = key === EXPECTED_VERSION ? '  (expected)' : '  ** UNEXPECTED **';
    console.log(`    ${key.padEnd(12)} — ${list.length} package(s)${marker}`);
  }

  console.log('\n' + '='.repeat(72));

  if (misaligned.length > 0) {
    console.log(`\n  RESULT: FAIL — ${misaligned.length} package(s) not at ${EXPECTED_VERSION}\n`);
    process.exit(1);
  } else {
    console.log(`\n  RESULT: PASS — all ${aligned.length} package(s) at ${EXPECTED_VERSION}\n`);
    process.exit(0);
  }
}

main();
