#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';

export class LibraryImportError extends Error {
  constructor(stage, code, message, exitCode = 1, details = undefined) {
    super(message);
    this.name = 'LibraryImportError';
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const SECRET_OPTIONS = new Set(['--api-key', '--token', '--jwt', '--secret', '--password']);
const BOOLEAN_OPTIONS = new Set(['--json', '--preflight-only', '--help']);
const IGNORED_DIRECTORIES = new Set(['.git', '.prismer', 'node_modules']);
const BUNDLE_EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function optionName(arg) {
  const equalsAt = typeof arg === 'string' ? arg.indexOf('=') : -1;
  return equalsAt === -1 ? arg : arg.slice(0, equalsAt);
}

function isLocalTarget(hostname) {
  return ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
}

function parseBoolean(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());
}

function normalizeRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/') || '.';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultLedgerPath(root) {
  return resolve(`.prismer/operations/skill-library-${sha256(root).slice(0, 16)}.json`);
}

export function loadLibraryImportConfig(argv, env = process.env) {
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = optionName(arg);
    if (SECRET_OPTIONS.has(name)) {
      throw new LibraryImportError(
        'local_validation',
        'SECRET_ARGUMENT_FORBIDDEN',
        `${name} is forbidden; credentials must come from the injected environment`,
        2,
      );
    }
    if (!BOOLEAN_OPTIONS.has(arg)) {
      throw new LibraryImportError(
        'local_validation',
        'UNKNOWN_ARGUMENT',
        `unknown argument at position ${index + 1}`,
        2,
      );
    }
    flags.add(arg);
  }
  if (flags.has('--help')) return { help: true };

  const sourceRootRaw = env.PRISMER_SKILL_LIBRARY_ROOT?.trim();
  if (!sourceRootRaw) {
    throw new LibraryImportError('local_validation', 'CONFIG_MISSING', 'PRISMER_SKILL_LIBRARY_ROOT is required', 2);
  }
  const sourceRoot = resolve(sourceRootRaw);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new LibraryImportError(
      'local_validation',
      'SOURCE_ROOT_INVALID',
      'PRISMER_SKILL_LIBRARY_ROOT must identify an existing directory',
      2,
    );
  }

  let baseUrl;
  try {
    baseUrl = new URL((env.PRISMER_CLOUD_BASE || 'http://127.0.0.1:3000').replace(/\/$/, ''));
  } catch {
    throw new LibraryImportError('local_validation', 'INVALID_BASE_URL', 'PRISMER_CLOUD_BASE must be a valid URL', 2);
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash || baseUrl.pathname !== '/'
  ) {
    throw new LibraryImportError(
      'local_validation',
      'UNSAFE_BASE_URL',
      'PRISMER_CLOUD_BASE must be a plain http(s) origin without credentials, query, or hash',
      2,
    );
  }

  const preflightOnly = flags.has('--preflight-only');
  if (!preflightOnly && !isLocalTarget(baseUrl.hostname) && !parseBoolean(env.PRISMER_ALLOW_REMOTE_WRITE)) {
    throw new LibraryImportError(
      'local_validation',
      'REMOTE_WRITE_NOT_CONFIRMED',
      'remote mutation is blocked; set PRISMER_ALLOW_REMOTE_WRITE=1 after confirming the target environment',
      2,
    );
  }

  const excludes = String(env.PRISMER_SKILL_LIBRARY_EXCLUDE || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);

  return {
    credential: env.PRISMER_API_KEY?.trim() || '',
    sourceRoot,
    excludes,
    cloudBin: env.PRISMER_CLOUD_BIN?.trim() || 'cloud',
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    ledgerPath: resolve(env.PRISMER_IMPORT_LEDGER?.trim() || defaultLedgerPath(sourceRoot)),
    preflightOnly,
    json: flags.has('--json'),
  };
}

function excluded(config, absolute) {
  const path = normalizeRelative(config.sourceRoot, absolute);
  return config.excludes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function discoverSkillDirectories(config) {
  const found = [];
  const visit = (directory) => {
    if (excluded(config, directory)) return;
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      found.push(directory);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      visit(resolve(directory, entry.name));
    }
  };
  visit(config.sourceRoot);
  return found.sort((left, right) => left.localeCompare(right));
}

function sourceRevision(config, directories) {
  const hash = createHash('sha256');
  for (const directory of directories) {
    const files = [];
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const absolute = resolve(current, entry.name);
        if (entry.isSymbolicLink()) throw new LibraryImportError('local_validation', 'SYMLINK_RESOURCE', 'Bundle resources must not be symlinks', 2);
        if (entry.isDirectory()) visit(absolute);
        else files.push(absolute);
      }
    };
    visit(directory);
    for (const file of files.sort((left, right) => left.localeCompare(right))) {
      hash.update(normalizeRelative(config.sourceRoot, file));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function bundleManifest(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new LibraryImportError('local_validation', 'SYMLINK_RESOURCE', 'Bundle resources must not be symlinks', 2);
      if (entry.isDirectory()) visit(absolute);
      else if (!BUNDLE_EXCLUDED_FILES.has(entry.name)) files.push(absolute);
    }
  };
  visit(directory);
  return files
    .sort((left, right) => left.localeCompare(right))
    .map((absolute) => {
      const bytes = readFileSync(absolute);
      return {
        path: normalizeRelative(directory, absolute),
        size: bytes.byteLength,
        sha256: sha256(bytes),
        ...(normalizeRelative(directory, absolute) === 'SKILL.md' ? { content: bytes.toString('utf8') } : {}),
      };
    });
}

function readbackMatchesBundle(readback, directory) {
  const expected = bundleManifest(directory);
  const actual = Array.isArray(readback?.files) ? readback.files : [];
  if (actual.length !== expected.length) return false;
  const actualByPath = new Map(actual.map((file) => [file?.path, file]));
  for (const file of expected) {
    const remote = actualByPath.get(file.path);
    if (!remote || remote.sha256 !== file.sha256 || Number(remote.size) !== file.size) return false;
    if (file.path === 'SKILL.md' && readback.content !== file.content) return false;
  }
  return true;
}

async function readbackOwnedBundle(config, row, directory, runCloud, canonicalSlug) {
  const shown = await runCloud(config, ['skill', 'show', canonicalSlug, '--content', '--json']);
  if (!shown.ok) return { ok: false, error: safeCliFailure(shown) };
  const readback = parseJsonOutput(shown, 'readback');
  if (!readbackMatchesBundle(readback, directory)) {
    return { ok: false, error: 'catalog readback does not match the selected local bundle' };
  }
  row.canonicalSlug = canonicalSlug;
  row.stage = 'verified';
  row.verifiedAt = new Date().toISOString();
  return { ok: true, readback };
}

function parseJsonOutput(result, stage) {
  const raw = String(result.stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through to the typed diagnostic below.
      }
    }
    throw new LibraryImportError(stage, 'INVALID_CLI_JSON', 'cloud CLI did not return valid JSON', 5);
  }
}

function defaultRunCloud(config, args) {
  const result = spawnSync(config.cloudBin, args, {
    encoding: 'utf8',
    env: { ...process.env, PRISMER_CLOUD_BASE: config.baseUrl, PRISMER_API_KEY: config.credential },
    timeout: 120_000,
    shell: false,
  });
  if (result.error) {
    throw new LibraryImportError(
      'local_validation',
      'CLOUD_CLI_UNAVAILABLE',
      `could not execute the configured Cloud CLI: ${result.error.message}`,
      2,
    );
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readLedger(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    throw new LibraryImportError(
      'local_validation',
      'INVALID_IMPORT_LEDGER',
      'the import ledger exists but is not valid JSON',
      2,
    );
  }
}

function safeCliFailure(result) {
  const message = String(result.stderr || '').trim();
  return message ? message.slice(0, 2_000) : `cloud CLI exited ${String(result.status)}`;
}

export async function runLibraryImport(config, runCloud = defaultRunCloud) {
  if (!config.credential) throw new LibraryImportError('local_validation', 'IDENTITY_REQUIRED', 'PRISMER_API_KEY is required to bind the ledger to the executing credential', 2);
  mkdirSync(dirname(config.ledgerPath), { recursive: true });
  const lockPath = `${config.ledgerPath}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    return await runLibraryImportLocked(config, runCloud);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

async function runLibraryImportLocked(config, runCloud) {
  const targetBinding = sha256(JSON.stringify([config.baseUrl, config.credential]));
  const directories = discoverSkillDirectories(config);
  if (directories.length === 0) {
    throw new LibraryImportError('local_validation', 'NO_SKILLS_FOUND', 'no root SKILL.md directories found', 2);
  }
  const revision = sourceRevision(config, directories);
  const previous = readLedger(config.ledgerPath);
  if (previous && (previous.targetBinding !== targetBinding || previous.sourceRoot !== config.sourceRoot || previous.sourceRevision !== revision)) {
    throw new LibraryImportError(
      'local_validation',
      'IMPORT_LEDGER_CONFLICT',
      'the import ledger belongs to a different source selection or source revision',
      2,
    );
  }

  const rowsByPath = new Map((previous?.rows || []).map((row) => [row.sourcePath, row]));
  const rows = [];
  for (const directory of directories) {
    const sourcePath = normalizeRelative(config.sourceRoot, directory);
    const prior = rowsByPath.get(sourcePath);
    if (prior?.stage === 'verified') {
      rows.push(prior);
      continue;
    }
    const validated = await runCloud(config, ['skill', 'validate', directory, '--json']);
    let validation = null;
    try {
      validation = parseJsonOutput(validated, 'validation');
    } catch (error) {
      if (validated.ok) throw error;
    }
    rows.push({
      sourcePath,
      requestedSlug: validation?.slug ?? prior?.requestedSlug ?? null,
      stage: validated.ok && validation?.ok !== false ? 'validated' : 'validation_failed',
      ...(validated.ok && validation?.ok !== false
        ? {}
        : { error: safeCliFailure(validated), validation: validation ?? undefined }),
    });
  }

  const slugs = rows.map((row) => row.requestedSlug).filter(Boolean);
  const duplicates = [...new Set(slugs.filter((slug, index) => slugs.indexOf(slug) !== index))];
  if (duplicates.length > 0) {
    throw new LibraryImportError(
      'validation',
      'DUPLICATE_SOURCE_SLUGS',
      'the selected source contains duplicate Skill slugs; choose the authoritative tree or exclude mirrors',
      2,
      { slugs: duplicates },
    );
  }

  const ledger = {
    targetBinding,
    schemaVersion: 1,
    sourceRoot: config.sourceRoot,
    sourceRevision: revision,
    stage: rows.some((row) => row.stage === 'validation_failed') ? 'validation_failed' : 'validated',
    rows,
    updatedAt: new Date().toISOString(),
  };
  writeLedger(config.ledgerPath, ledger);
  if (ledger.stage === 'validation_failed') {
    throw new LibraryImportError(
      'validation',
      'LIBRARY_VALIDATION_FAILED',
      'one or more Skill bundles failed local validation; no catalog writes were attempted',
      2,
      { failed: rows.filter((row) => row.stage === 'validation_failed').map((row) => row.sourcePath) },
    );
  }
  if (config.preflightOnly) return ledger;

  for (const row of rows) {
    const directory = resolve(config.sourceRoot, row.sourcePath);
    if (row.stage === 'verified') {
      const current = await readbackOwnedBundle(config, row, directory, runCloud, row.canonicalSlug);
      if (!current.ok) { row.stage = 'readback_failed'; row.error = current.error; }
      continue;
    }
    const created = await runCloud(config, ['skill', 'create', directory, '--json']);
    if (!created.ok) {
      // A process may die after the server commits but before the ledger records
      // the create response. Community slugs are server-canonical and
      // deterministic; only accept the existing owner-visible row when its
      // complete manifest matches the selected bundle byte-for-byte.
      const recoverySlug = `community-${row.requestedSlug}`;
      const recovered = await readbackOwnedBundle(config, row, directory, runCloud, recoverySlug);
      if (recovered.ok) {
        row.recoveredAfterCreateFailure = true;
        delete row.error;
      } else {
        row.stage = 'create_failed';
        row.error = safeCliFailure(created);
        row.recoveryError = recovered.error;
      }
      ledger.updatedAt = new Date().toISOString();
      writeLedger(config.ledgerPath, ledger);
      continue;
    }
    const creation = parseJsonOutput(created, 'create');
    row.id = creation.id ?? null;
    row.canonicalSlug = creation.slug ?? null;
    row.publishScope = creation.publishScope ?? null;
    row.status = creation.status ?? null;
    row.stage = 'created';
    delete row.error;
    ledger.updatedAt = new Date().toISOString();
    writeLedger(config.ledgerPath, ledger);

    if (!row.canonicalSlug) {
      row.stage = 'readback_failed';
      row.error = 'create response did not contain a canonical slug';
      writeLedger(config.ledgerPath, ledger);
      continue;
    }
    const verified = await readbackOwnedBundle(config, row, directory, runCloud, row.canonicalSlug);
    if (!verified.ok) {
      row.stage = 'readback_failed';
      row.error = verified.error;
      writeLedger(config.ledgerPath, ledger);
      continue;
    }
    writeLedger(config.ledgerPath, ledger);
  }

  const failed = rows.filter((row) => row.stage !== 'verified');
  ledger.stage = failed.length === 0 ? 'completed' : 'partial_failure';
  ledger.completedAt = failed.length === 0 ? new Date().toISOString() : undefined;
  ledger.updatedAt = new Date().toISOString();
  ledger.requiredSkills = rows
    .filter((row) => row.stage === 'verified')
    .map((row) => ({ skillSlug: row.canonicalSlug, required: true }));
  writeLedger(config.ledgerPath, ledger);
  if (failed.length > 0) {
    throw new LibraryImportError(
      'import',
      'LIBRARY_IMPORT_PARTIAL_FAILURE',
      'some Skill bundles were not verified; retry with the same ledger after fixing transient failures',
      5,
      { failed: failed.map((row) => ({ sourcePath: row.sourcePath, stage: row.stage })) },
    );
  }
  return ledger;
}

const HELP = `Usage:
  # PRISMER_SKILL_LIBRARY_ROOT and cloud authentication are injected in env
  node scripts/import-library.mjs [--preflight-only] [--json]

Optional env: PRISMER_SKILL_LIBRARY_EXCLUDE, PRISMER_IMPORT_LEDGER,
PRISMER_CLOUD_BIN, PRISMER_CLOUD_BASE, PRISMER_ALLOW_REMOTE_WRITE=1.`;

async function main() {
  let config;
  try {
    config = loadLibraryImportConfig(process.argv.slice(2));
    if (config.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    const result = await runLibraryImport(config);
    if (config.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `[skill-creator] ${result.stage}: verified=${result.rows.filter((row) => row.stage === 'verified').length}/${result.rows.length} ledger=${config.ledgerPath}\n`,
      );
    }
  } catch (error) {
    const failure =
      error instanceof LibraryImportError
        ? error
        : new LibraryImportError('internal', 'UNEXPECTED_ERROR', error?.message || String(error), 1);
    process.stderr.write(
      `${JSON.stringify({ ok: false, stage: failure.stage, error: { code: failure.code, message: failure.message, details: failure.details }, ...(config?.ledgerPath ? { ledger: config.ledgerPath } : {}) })}\n`,
    );
    process.exitCode = failure.exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
