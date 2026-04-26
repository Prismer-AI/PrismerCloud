/**
 * Version Consistency Checker
 *
 * Scans all version declarations across the monorepo and flags
 * any package that is NOT on the expected 1.8.x line.
 *
 * Sources checked:
 *   - Root package.json
 *   - sdk / * / package.json  (excluding node_modules)
 *   - sdk / * / pyproject.toml
 *   - sdk / * / Cargo.toml    (excluding target/)
 *   - src/lib/version.ts
 *
 * Usage: npx tsx scripts/check-version-consistency.ts
 */

import { readFileSync } from 'fs';
import fg from 'fast-glob';
import { resolve, relative } from 'path';

const ROOT = resolve(__dirname, '..');
const EXPECTED_MAJOR_MINOR = '1.8';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VersionEntry {
  source: string; // relative file path
  label: string; // human-readable package identifier
  version: string; // extracted version string
  majorMinor: string; // e.g. "1.8"
  aligned: boolean; // true if majorMinor matches EXPECTED_MAJOR_MINOR
}

// ─── Extraction helpers ─────────────────────────────────────────────────────

function extractFromPackageJson(filePath: string): VersionEntry | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    if (!json.version) return null;
    const ver: string = json.version;
    const parts = ver.split('.');
    return {
      source: relative(ROOT, filePath),
      label: json.name || relative(ROOT, filePath),
      version: ver,
      majorMinor: `${parts[0]}.${parts[1]}`,
      aligned: `${parts[0]}.${parts[1]}` === EXPECTED_MAJOR_MINOR,
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
    const parts = ver.split('.');
    return {
      source: relative(ROOT, filePath),
      label: relative(ROOT, filePath),
      version: ver,
      majorMinor: `${parts[0]}.${parts[1]}`,
      aligned: `${parts[0]}.${parts[1]}` === EXPECTED_MAJOR_MINOR,
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
    const parts = ver.split('.');
    return {
      source: relative(ROOT, filePath),
      label: relative(ROOT, filePath),
      version: ver,
      majorMinor: `${parts[0]}.${parts[1]}`,
      aligned: `${parts[0]}.${parts[1]}` === EXPECTED_MAJOR_MINOR,
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
    const parts = ver.split('.');
    return {
      source: relative(ROOT, filePath),
      label: 'src/lib/version.ts (VERSION)',
      version: ver,
      majorMinor: `${parts[0]}.${parts[1]}`,
      aligned: `${parts[0]}.${parts[1]}` === EXPECTED_MAJOR_MINOR,
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
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n[VersionCheck] Scanning for version declarations...`);
  console.log(`[VersionCheck] Expected major.minor: ${EXPECTED_MAJOR_MINOR}.x\n`);

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

  // ─── Group by major.minor ──────────────────────────────────────────────

  const groups = new Map<string, VersionEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.majorMinor) || [];
    list.push(e);
    groups.set(e.majorMinor, list);
  }

  // ─── Report ────────────────────────────────────────────────────────────

  const aligned = entries.filter((e) => e.aligned);
  const misaligned = entries.filter((e) => !e.aligned);

  console.log('='.repeat(72));
  console.log('  VERSION CONSISTENCY REPORT');
  console.log('='.repeat(72));

  // Aligned packages
  console.log(`\n  Aligned (${EXPECTED_MAJOR_MINOR}.x) — ${aligned.length} package(s):\n`);
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
      console.log(`    ${e.version.padEnd(12)} ${e.label}  (expected ${EXPECTED_MAJOR_MINOR}.x)`);
    }
  }

  // Summary by major.minor group
  console.log(`\n  Version groups:`);
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const list = groups.get(key)!;
    const marker = key === EXPECTED_MAJOR_MINOR ? '  (expected)' : '  ** UNEXPECTED **';
    console.log(`    ${key}.x — ${list.length} package(s)${marker}`);
  }

  console.log('\n' + '='.repeat(72));

  if (misaligned.length > 0) {
    console.log(`\n  RESULT: FAIL — ${misaligned.length} package(s) not at ${EXPECTED_MAJOR_MINOR}.x\n`);
    process.exit(1);
  } else {
    console.log(`\n  RESULT: PASS — all ${aligned.length} package(s) at ${EXPECTED_MAJOR_MINOR}.x\n`);
    process.exit(0);
  }
}

main();
