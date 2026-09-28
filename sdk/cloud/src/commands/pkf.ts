/**
 * `cloud pkf` — PKF toolchain CLI (product209/15 §7.3).
 *
 * Current subcommands: `pack-harness` (PKF-F1). validate/inspect/project and
 * the revision-plane commands land with PKF-D3 and later tickets — this file
 * is the single CLI surface for the toolchain.
 *
 * Rules (§7.3):
 *   • pack computes REAL SRI, rejects symlinks / path traversal / remote
 *     imports, and emits a deterministic manifest;
 *   • everything here is offline — no cloud dependency.
 */

import { Command } from 'commander';
type ClientFactory = () => import('../index').PrismerClient;
import { lstatSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { applyPkfPatch, diffPkf, inspectPkf, packHarness, parsePkf, projectPkf, validatePkf } from '@prismer/pkf';
import { exportPkfHtml, pkfExportReceiptKey } from '@prismer/pkf';
import { createHash } from 'node:crypto';
import { info as uiInfo, errorLine as uiError, success } from '../cli-ui';

/** Walk a bundle dir: regular files only — symlinks fail the pack (F1 RED). */
export function walkBundle(dir: string): { files: Record<string, Uint8Array>; root: string } {
  const root = resolve(dir);
  const files: Record<string, Uint8Array> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink not allowed in harness bundle: ${relative(root, abs)}`);
      }
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('.')) {
          throw new Error(`forbidden directory in harness bundle: ${relative(root, abs)}`);
        }
        walk(abs);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`special file not allowed in harness bundle: ${relative(root, abs)}`);
      }
      const rel = relative(root, abs).split(sep).join('/');
      files[rel] = new Uint8Array(readFileSync(abs));
    }
  };
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`bundle root must not be a symlink: ${dir}`);
  }
  walk(root);
  return { files, root };
}

// ── validate / inspect / project (PKF-D3) ───────────────────────────────────
//
// Exit-code contract (§10.4 / §7.3):
//   structure level: 0 = structure pass, 1 = structure fail
//   resolved level:  0 = strictOk, 1 = resource fail, 2 = unverified
// Validation failure is a BUSINESS result — never a transport error.

export interface PkfValidateCliOptions {
  source: string;
  level: 'structure' | 'resolved';
  json: boolean;
  manifestPath?: string;
  budgets?: Record<string, number>;
}

export function runPkfValidate(opts: PkfValidateCliOptions): number {
  let manifest: unknown;
  if (opts.manifestPath) {
    manifest = JSON.parse(readFileSync(opts.manifestPath, 'utf8'));
  }
  const result = validatePkf(opts.source, { harnessManifest: manifest });
  const payload = {
    sourceHash: createHash('sha256').update(opts.source).digest('hex'),
    schemaVersion: parsePkf(opts.source).schemaVersion,
    structureStatus: result.structureStatus,
    resourceStatus: result.resourceStatus,
    strictOk: result.strictOk,
    diagnostics: result.diagnostics,
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const d of result.diagnostics) {
      process.stderr.write(`[pkf] ${d.level}: ${d.code} — ${d.message}\n`);
    }
  }
  if (opts.level === 'structure') {
    return result.structureStatus === 'pass' ? 0 : 1;
  }
  // resolved: structure fail → 1; unverified → 2; resource fail → 1; pass → 0
  if (result.structureStatus === 'fail') return 1;
  if (result.resourceStatus === 'unverified') return 2;
  if (result.resourceStatus === 'fail') return 1;
  return 0;
}

export function runPkfInspect(source: string, json: boolean): number {
  // inspectPkf is deliberately hash-agnostic because it can be embedded by
  // callers with different byte authorities. The CLI owns the exact UTF-8
  // bytes it read, so its bounded receipt must fill the raw-source hash.
  const inspection = {
    ...inspectPkf(source),
    sourceHash: createHash('sha256').update(source).digest('hex'),
  };
  if (json) process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  else {
    process.stdout.write(
      `format=${inspection.format} schema=${inspection.schemaVersion ?? 'v1.0'} sections=${inspection.counts.sections} links=${inspection.counts.links} files=${inspection.counts.files} math=${inspection.counts.math} structure=${inspection.structureStatus}\n`,
    );
  }
  return 0;
}

export function runPkfProject(source: string): number {
  process.stdout.write(projectPkf(source));
  return 0;
}

function readSourceArg(file: string): string {
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}



export function runPkfPatchFile(source: string, patchFile: string, baseRevision: string | null, dryRun: boolean): number {
  const patchJson = JSON.parse(readFileSync(patchFile, 'utf8')) as {
    operations?: unknown[];
    message?: string;
    expectedBaseHash?: string;
  };
  const result = applyPkfPatch(source, {
    operations: (patchJson.operations ?? []) as never,
    message: patchJson.message ?? 'patch',
    expectedBaseHash: patchJson.expectedBaseHash ?? sha256HexOf(source),
  });
  if (!result.ok) {
    process.stderr.write(`[pkf] patch rejected: ${result.code ?? 'unknown'}\n`);
    return 1;
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, candidateHash: result.candidateHash, changedSectionSids: result.changedSectionSids, sourceDiffStat: result.sourceDiffStat }, null, 2)}\n`);
  } else {
    process.stdout.write(result.candidateSource ?? '');
  }
  return 0;
}

export function runPkfDiff(baseFile: string, headFile: string, json: boolean): number {
  const d = diffPkf(readFileSync(baseFile, 'utf8'), readFileSync(headFile, 'utf8'));
  if (json) process.stdout.write(`${JSON.stringify({ ...d, source: d.source.page }, null, 2)}\n`);
  else {
    process.stdout.write(d.source.page + '\n');
    process.stdout.write(`sections changed: ${d.receipt.sectionsChanged}, links: ${d.receipt.linksChanged}\n`);
  }
  return 0;
}

function sha256HexOf(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}


export async function runPkfRender(source: string, target: 'html' | 'pdf', theme: string | null, outFile: string): Promise<number> {
  const html = await exportPkfHtml(source, { theme: theme ?? undefined });
  if (target === 'html') {
    writeFileSync(outFile, html);
    process.stderr.write(`[pkf] rendered standalone HTML → ${outFile} (receipt ${pkfExportReceiptKey(source, { theme: theme ?? undefined })})\n`);
    return 0;
  }
  // PDF: headless Chromium print adapter (§10.8) — fonts.ready is awaited by
  // the browser before pdf(); NO Cloud render endpoint/job exists.
  let chromium: typeof import('playwright');
  try {
    chromium = await import('playwright');
  } catch {
    process.stderr.write('[pkf] render --to pdf requires the playwright package (headless Chromium adapter)\n');
    return 1;
  }
  const browser = await chromium.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
    await page.pdf({ path: outFile, format: 'A4', printBackground: true });
    process.stderr.write(`[pkf] rendered PDF → ${outFile} (A4, fonts awaited)\n`);
    return 0;
  } finally {
    await browser.close();
  }
}


export interface PkfCliClient {
  fetchJson: (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: unknown }>;
}

export async function runPkfCheckoutCli(
  uri: string,
  revisionId: string | null,
  outFile: string,
  client: PkfCliClient,
): Promise<number> {
  const res = await client.fetchJson('/pkf/read', { documentUri: uri, revisionId, anchorSlug: undefined, maxBytes: 5 * 1024 * 1024 });
  if (!res.ok) {
    process.stderr.write(`[pkf] checkout failed: ${String(res.error)}\n`);
    return 1;
  }
  // the read plane is bounded (64 KiB hard cap) — a checkout needs FULL bytes;
  // the committed full-source fetch goes through /pkf/commit's inverse is not
  // exposed; the CLI relies on the daemon tool lane for registry-backed
  // checkout. This command surfaces a TYPED error instead of a partial file.
  process.stderr.write('[pkf] checkout requires the daemon tool lane (pkf_checkout_file) — the bounded read plane cannot ship full revisions\n');
  return 1;
}

export async function runPkfCommitCli(
  file: string,
  documentUri: string,
  baseRevisionId: string,
  baseSourceHash: string,
  message: string,
  client: { request: <T>(method: string, path: string, body?: unknown) => Promise<T> },
): Promise<number> {
  const source = readFileSync(file, 'utf8');
  const res = await client.request<{ ok: boolean; data?: { newRevisionId: string; sourceHash: string }; error?: unknown }>(
    'POST',
    '/pkf/commit',
    { documentUri, baseRevisionId, baseSourceHash, source, message },
  );
  if (!res.ok) {
    process.stderr.write(`[pkf] commit rejected: ${String(res.error ?? 'unknown')}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, newRevisionId: res.data?.newRevisionId, sourceHash: res.data?.sourceHash }, null, 2)}\n`,
  );
  return 0;
}

interface PkfMaterializationEnvelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string } | string;
}

export interface PkfMaterializationCliClient {
  request: <T>(
    method: string,
    path: `/api/pkf/${string}`,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<T>;
}

export interface PkfMaterializeCliOptions {
  workspaceId: string;
  idempotencyKey: string;
  source: {
    messageId: string;
    blockId: string;
    blockRevision: number;
    sourceHash: string;
  };
  targetKind: 'asset' | 'memory-page';
  filename?: string;
  path?: string;
  confirmPath?: boolean;
  visibility?: string;
  json?: boolean;
}

export interface PkfMaterializationReadCliOptions {
  workspaceId: string;
  idempotencyKey: string;
  targetKind: 'asset' | 'memory-page';
  json?: boolean;
}

interface PkfBundleDescriptor {
  workspaceId: string;
  idempotencyKey: string;
  root: { filename: string; sourceFile: string };
  resources: Array<{
    path: string;
    fromPath?: string;
    file: string;
    mime: string;
    usage: string;
  }>;
}

function readDescriptorFile(baseDir: string, value: string): Buffer {
  if (!value || value.includes('\0')) throw new Error('bundle descriptor file path is required');
  const target = resolve(baseDir, value);
  const prefix = `${resolve(baseDir)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error(`bundle descriptor path escapes its directory: ${value}`);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`bundle descriptor path is not a regular file: ${value}`);
  return readFileSync(target);
}

function parseBundleDescriptor(file: string): { descriptor: PkfBundleDescriptor; request: Record<string, unknown> } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PkfBundleDescriptor>;
  if (
    !raw ||
    typeof raw.workspaceId !== 'string' ||
    typeof raw.idempotencyKey !== 'string' ||
    !raw.root ||
    typeof raw.root.filename !== 'string' ||
    typeof raw.root.sourceFile !== 'string' ||
    !Array.isArray(raw.resources) ||
    raw.resources.length === 0
  ) {
    throw new Error('bundle descriptor is missing workspaceId, idempotencyKey, root, or resources');
  }
  const descriptor = raw as PkfBundleDescriptor;
  const baseDir = dirname(resolve(file));
  const rootBytes = readDescriptorFile(baseDir, descriptor.root.sourceFile);
  const source = rootBytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(rootBytes)) throw new Error('bundle root source must be valid UTF-8');
  const resources = descriptor.resources.map((resource) => {
    if (
      !resource ||
      typeof resource.path !== 'string' ||
      typeof resource.file !== 'string' ||
      typeof resource.mime !== 'string' ||
      typeof resource.usage !== 'string'
    ) {
      throw new Error('bundle resource descriptor is incomplete');
    }
    const bytes = readDescriptorFile(baseDir, resource.file);
    return {
      path: resource.path,
      ...(resource.fromPath ? { fromPath: resource.fromPath } : {}),
      bytesBase64: bytes.toString('base64'),
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
      mime: resource.mime,
      usage: resource.usage,
    };
  });
  return {
    descriptor,
    request: {
      workspaceId: descriptor.workspaceId,
      idempotencyKey: descriptor.idempotencyKey,
      root: {
        filename: descriptor.root.filename,
        source,
        sourceHash: createHash('sha256').update(rootBytes).digest('hex'),
      },
      resources,
    },
  };
}

export async function runPkfBundleCommitCli(
  descriptorFile: string,
  client: PkfMaterializationCliClient,
): Promise<number> {
  let request: Record<string, unknown>;
  try {
    request = parseBundleDescriptor(descriptorFile).request;
  } catch (error) {
    process.stderr.write(`[pkf] bundle-commit descriptor rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const response = await client.request<PkfMaterializationEnvelope>('POST', '/api/pkf/bundles/commit', request);
  if (!response.success || response.data === undefined) {
    process.stderr.write(`[pkf] bundle-commit failed: ${materializationErrorMessage(response)}\n`);
    return 1;
  }
  emitMaterializationData(response.data, true);
  return 0;
}

export async function runPkfBundleReadCli(
  workspaceId: string,
  idempotencyKey: string,
  client: PkfMaterializationCliClient,
): Promise<number> {
  const response = await client.request<PkfMaterializationEnvelope>(
    'GET',
    '/api/pkf/bundles/commit',
    undefined,
    { workspaceId, idempotencyKey },
  );
  if (!response.success || response.data === undefined) {
    process.stderr.write(`[pkf] bundle-read failed: ${materializationErrorMessage(response)}\n`);
    return 1;
  }
  emitMaterializationData(response.data, true);
  return 0;
}

function materializationErrorMessage(response: PkfMaterializationEnvelope): string {
  if (typeof response.error === 'string') return response.error;
  return response.error?.message ?? response.error?.code ?? 'PKF materialization failed';
}

function emitMaterializationData(data: unknown, _json: boolean | undefined): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function runPkfMaterializeCli(
  opts: PkfMaterializeCliOptions,
  client: PkfMaterializationCliClient,
): Promise<number> {
  let target: Record<string, unknown>;
  if (opts.targetKind === 'memory-page') {
    if (!opts.path?.trim()) {
      process.stderr.write('[pkf] materialize: --path is required for a Memory Page target\n');
      return 1;
    }
    if (opts.confirmPath !== true) {
      process.stderr.write('[pkf] materialize: Memory Page target requires --confirm-path\n');
      return 1;
    }
    target = {
      kind: 'memory-page',
      path: opts.path,
      pathConfirmed: true,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    };
  } else {
    if (!opts.filename?.trim()) {
      process.stderr.write('[pkf] materialize: --filename is required for an Asset target\n');
      return 1;
    }
    target = { kind: 'asset', filename: opts.filename };
  }

  const response = await client.request<PkfMaterializationEnvelope>('POST', '/api/pkf/materializations', {
    workspaceId: opts.workspaceId,
    idempotencyKey: opts.idempotencyKey,
    source: { kind: 'message-pkf', ...opts.source },
    target,
  });
  if (!response.success || response.data === undefined) {
    process.stderr.write(`[pkf] materialize failed: ${materializationErrorMessage(response)}\n`);
    return 1;
  }
  emitMaterializationData(response.data, opts.json);
  return 0;
}

export async function runPkfMaterializationReadCli(
  opts: PkfMaterializationReadCliOptions,
  client: PkfMaterializationCliClient,
): Promise<number> {
  const response = await client.request<PkfMaterializationEnvelope>(
    'GET',
    '/api/pkf/materializations',
    undefined,
    {
      workspaceId: opts.workspaceId,
      idempotencyKey: opts.idempotencyKey,
      targetKind: opts.targetKind,
    },
  );
  if (!response.success || response.data === undefined) {
    process.stderr.write(`[pkf] materialization read failed: ${materializationErrorMessage(response)}\n`);
    return 1;
  }
  emitMaterializationData(response.data, opts.json);
  return 0;
}

export function register(parent: Command, _getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const pkf = parent.command('pkf').description('PKF toolchain — parse / validate / inspect / pack (offline)');

  // PKF-D3 — cloud pkf validate <file|-> [--level structure|resolved] [--manifest] [--json]
  pkf
    .command('validate')
    .description('Validate a PKF source (structure or resolved phase). Exit 0/1/2 per §10.4.')
    .argument('<file>', 'PKF file, or - for stdin')
    .option('--level <level>', 'structure | resolved', 'structure')
    .option('--manifest <file>', 'harness manifest JSON for interactive PKF')
    .option('--json', 'emit the diagnostic payload as JSON')
    .action(async (file: string, opts: { level: string; manifest?: string; json: boolean }) => {
      try {
        const level = opts.level === 'resolved' ? 'resolved' : 'structure';
        process.exitCode = runPkfValidate({
          source: readSourceArg(file),
          level,
          json: opts.json,
          manifestPath: opts.manifest,
        });
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-D3 — cloud pkf inspect <file|-> --json
  pkf
    .command('inspect')
    .description('Deterministic structural inspection of a PKF source')
    .argument('<file>', 'PKF file, or - for stdin')
    .option('--json', 'emit JSON')
    .action(async (file: string, opts: { json: boolean }) => {
      try {
        process.exitCode = runPkfInspect(readSourceArg(file), opts.json);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-D3 — cloud pkf project <file|-> --to markdown
  pkf
    .command('project')
    .description('Project a PKF source to markdown (read-only degradation)')
    .argument('<file>', 'PKF file, or - for stdin')
    .option('--to <target>', 'projection target (markdown)', 'markdown')
    .action(async (file: string, opts: { to: string }) => {
      try {
        if (opts.to !== 'markdown') {
          uiError(`[pkf] unsupported projection target: ${opts.to}`);
          process.exitCode = 1;
          return;
        }
        process.exitCode = runPkfProject(readSourceArg(file));
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-H5 — filesystem lane: registry-backed operations live in the daemon
  // tool lane (pkf_checkout_file / pkf_status_file / pkf_commit_file /
  // pkf_normalize_file); the CLI surfaces typed guidance + a stateless commit
  // with explicit base flags from the checkout receipt.
  pkf
    .command('checkout')
    .description('Check out a PKF document revision as an ordinary UTF-8 file (daemon tool lane owns the registry)')
    .argument('<uri>', 'prismer:// document URI')
    .requiredOption('--out <file>', 'destination file')
    .option('--revision <id>', 'revision id')
    .action(async (uri: string, opts: { out: string; revision?: string }) => {
      try {
        process.exitCode = await runPkfCheckoutCli(uri, opts.revision ?? null, opts.out, {
          fetchJson: async (_p, _b) => ({ ok: false, error: 'unused' }),
        });
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  pkf
    .command('status')
    .description('Report a checkout file state (daemon tool lane owns the registry)')
    .argument('<file>', 'checked-out file')
    .option('--json', 'emit JSON')
    .action(async (_file: string, _opts: { json: boolean }) => {
      uiError('[pkf] status requires the daemon tool lane (pkf_status_file) — registry-backed bindings live with the daemon');
      process.exitCode = 1;
    });

  pkf
    .command('commit')
    .description('Commit final file bytes through the carrier CAS (explicit base from the checkout receipt)')
    .argument('<file>', 'PKF file')
    .requiredOption('--document-uri <uri>', 'prismer:// document URI')
    .requiredOption('--base-revision <id>', 'base revision id from the checkout receipt')
    .requiredOption('--base-hash <sha256>', 'base source hash from the checkout receipt')
    .requiredOption('--message <text>', 'commit message')
    .action(async (file: string, opts: { documentUri: string; baseRevision: string; baseHash: string; message: string }) => {
      try {
        const client = _getIMClient().im;
        process.exitCode = await runPkfCommitCli(file, opts.documentUri, opts.baseRevision, opts.baseHash, opts.message, client);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  pkf
    .command('bundle-commit')
    .description('Atomically commit a PKF root and file-backed dependency descriptor')
    .argument('<descriptor>', 'JSON descriptor with workspaceId, idempotencyKey, root.sourceFile and resource.file paths')
    .action(async (descriptor: string) => {
      try {
        process.exitCode = await runPkfBundleCommitCli(descriptor, _getAPIClient().pkf);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  pkf
    .command('bundle-read')
    .description('Restore an actor-scoped committed PKF bundle receipt after restart')
    .argument('<idempotency-key>', 'bundle idempotency key')
    .requiredOption('--workspace-id <id>', 'workspace id')
    .action(async (idempotencyKey: string, opts: { workspaceId: string }) => {
      try {
        process.exitCode = await runPkfBundleReadCli(opts.workspaceId, idempotencyKey, _getAPIClient().pkf);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  pkf
    .command('materialize')
    .description('Materialize authoritative inline PKF into an Asset or Memory Page')
    .requiredOption('--workspace-id <id>', 'workspace id')
    .requiredOption('--message-id <id>', 'authoritative message id')
    .requiredOption('--block-id <id>', 'authoritative inline block id')
    .requiredOption('--block-revision <number>', 'inline block revision', (value) => Number.parseInt(value, 10))
    .requiredOption('--source-hash <sha256>', 'authoritative inline source SHA-256')
    .requiredOption('--target-kind <kind>', 'asset | memory-page')
    .requiredOption('--idempotency-key <key>', 'stable materialization idempotency key')
    .option('--filename <name>', 'Asset target .pkf filename')
    .option('--path <path>', 'Memory Page target .pkf path')
    .option('--confirm-path', 'explicitly confirm the Memory Page path')
    .option('--visibility <visibility>', 'Memory Page visibility', 'workspace')
    .option('--json', 'emit JSON')
    .action(
      async (opts: {
        workspaceId: string;
        messageId: string;
        blockId: string;
        blockRevision: number;
        sourceHash: string;
        targetKind: string;
        idempotencyKey: string;
        filename?: string;
        path?: string;
        confirmPath?: boolean;
        visibility?: string;
        json?: boolean;
      }) => {
        try {
          if (opts.targetKind !== 'asset' && opts.targetKind !== 'memory-page') {
            uiError(`[pkf] unsupported materialization target: ${opts.targetKind}`);
            process.exitCode = 1;
            return;
          }
          process.exitCode = await runPkfMaterializeCli(
            {
              workspaceId: opts.workspaceId,
              idempotencyKey: opts.idempotencyKey,
              source: {
                messageId: opts.messageId,
                blockId: opts.blockId,
                blockRevision: opts.blockRevision,
                sourceHash: opts.sourceHash,
              },
              targetKind: opts.targetKind,
              filename: opts.filename,
              path: opts.path,
              confirmPath: opts.confirmPath,
              visibility: opts.visibility,
              json: opts.json,
            },
            _getAPIClient().pkf,
          );
        } catch (err) {
          uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  pkf
    .command('materialization')
    .description('Read a committed PKF materialization receipt')
    .argument('<idempotency-key>', 'materialization idempotency key')
    .requiredOption('--workspace-id <id>', 'workspace id')
    .requiredOption('--target-kind <kind>', 'asset | memory-page')
    .option('--json', 'emit JSON')
    .action(
      async (
        idempotencyKey: string,
        opts: { workspaceId: string; targetKind: string; json?: boolean },
      ) => {
        try {
          if (opts.targetKind !== 'asset' && opts.targetKind !== 'memory-page') {
            uiError(`[pkf] unsupported materialization target: ${opts.targetKind}`);
            process.exitCode = 1;
            return;
          }
          process.exitCode = await runPkfMaterializationReadCli(
            {
              workspaceId: opts.workspaceId,
              idempotencyKey,
              targetKind: opts.targetKind,
              json: opts.json,
            },
            _getAPIClient().pkf,
          );
        } catch (err) {
          uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  pkf
    .command('normalize')
    .description('Normalize a checked-out PKF file into canonical form (daemon tool lane owns the registry)')
    .argument('<file>', 'checked-out file')
    .option('--dry-run', 'plan only')
    .action(async (_file: string, _opts: { dryRun: boolean }) => {
      uiError('[pkf] normalize requires the daemon tool lane (pkf_normalize_file)');
      process.exitCode = 1;
    });

  // PKF-E2 — cloud pkf render <file> --to html|pdf --theme <profile> --out <file>
  pkf
    .command('render')
    .description('Render a PKF source to deterministic standalone HTML or PDF (headless Chromium)')
    .argument('<file>', 'PKF file, or - for stdin')
    .requiredOption('--to <target>', 'html | pdf')
    .option('--theme <profile>', 'knowledge | editorial | technical')
    .requiredOption('--out <file>', 'output file')
    .action(async (file: string, opts: { to: string; theme?: string; out: string }) => {
      try {
        if (opts.to !== 'html' && opts.to !== 'pdf') {
          uiError(`[pkf] unsupported render target: ${opts.to}`);
          process.exitCode = 1;
          return;
        }
        process.exitCode = await runPkfRender(readSourceArg(file), opts.to, opts.theme ?? null, opts.out);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-H3 — cloud pkf patch <file> --patch <json> [--dry-run]
  pkf
    .command('patch')
    .description('Apply typed patch operations to a local PKF file (offline; whole-page validated)')
    .argument('<file>', 'PKF file')
    .requiredOption('--patch <file>', 'JSON patch request file')
    .option('--dry-run', 'print the candidate receipt instead of the source')
    .action(async (file: string, opts: { patch: string; dryRun: boolean }) => {
      try {
        process.exitCode = runPkfPatchFile(readSourceArg(file), opts.patch, null, opts.dryRun);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-H3 — cloud pkf diff <from> <to> [--json]
  pkf
    .command('diff')
    .description('Source + semantic diff between two local PKF files (offline)')
    .argument('<from>', 'base file')
    .argument('<to>', 'head file')
    .option('--json', 'emit JSON')
    .action(async (from: string, to: string, opts: { json: boolean }) => {
      try {
        process.exitCode = runPkfDiff(from, to, opts.json);
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // PKF-F1 — cloud pkf pack-harness <dir> --out <dir>
  pkf
    .command('pack-harness')
    .description('Pack a harness bundle directory into a deterministic manifest with real SRI')
    .argument('<dir>', 'bundle directory (manifest.json + referenced js/css)')
    .requiredOption('-o, --out <dir>', 'output directory for the packed manifest.json')
    .action(async (dir: string, opts: { out: string }) => {
      try {
        const { files, root } = walkBundle(dir);
        const authored = JSON.parse(new TextDecoder().decode(files['manifest.json'] ?? new Uint8Array())) as {
          scripts?: Array<{ path: string }>;
          styles?: Array<{ path: string }>;
          actions?: unknown[];
          csp?: string;
          sandbox?: string[];
        };
        if (!authored.scripts && !authored.styles) {
          throw new Error('manifest.json missing or declares no scripts/styles');
        }
        const result = packHarness({
          files,
          manifest: {
            scripts: authored.scripts ?? [],
            styles: authored.styles ?? [],
            actions: authored.actions ?? [],
            ...(authored.csp ? { csp: authored.csp } : {}),
            ...(authored.sandbox ? { sandbox: authored.sandbox } : {}),
          },
        });
        if (!result.ok) {
          throw new Error(`pack failed: ${result.error} — ${result.message}`);
        }
        mkdirSync(opts.out, { recursive: true });
        writeFileSync(join(opts.out, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`);
        uiInfo(`[pkf] packed ${result.fileOrder.length} file(s) from ${relative(process.cwd(), root)}`);
        uiInfo(`[pkf] bundle ${result.fileOrder.length} entries, deterministic manifest → ${opts.out}/manifest.json`);
        success('[pkf] pack-harness done');
      } catch (err) {
        uiError(`[pkf] ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
