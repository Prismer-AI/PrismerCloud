import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface ComponentStageRequest {
  schemaVersion: 1;
  environmentId: string;
  sandboxId: string;
  bindingHash: string;
  environmentEpoch: number;
  operationId: string;
  componentId: string;
  generation: string;
  attemptId: string;
  source: string;
  integrity: string;
  policyRevision: string;
  installerIdentity: string;
  packageName: string;
  version: string;
  archiveSha256: string;
  treeSha256: string;
  tools: string[];
  files: { path: string; bytes: number; sha256: string; contentBase64: string }[];
}
export interface ComponentStageReceipt {
  schemaVersion: 1;
  status: 'staged';
  environmentId: string;
  sandboxId: string;
  bindingHash: string;
  environmentEpoch: number;
  operationId: string;
  componentId: string;
  generation: string;
  attemptId: string;
  relativePath: string;
  archiveSha256: string;
  treeSha256: string;
  diskBytes: number;
  fileCount: number;
  loader: { kind: 'pi-extension'; entrypoint: string; tools: string[] };
}
export type ComponentStageManifest = Omit<ComponentStageRequest, 'files'> & {
  files: Array<Omit<ComponentStageRequest['files'][number], 'contentBase64'>>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = (): never => {
  throw new Error('component package validation failed');
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 512 &&
  value.split('/').every((part) => /^[A-Za-z0-9_.@-]+$/.test(part) && part !== '.' && part !== '..');

function validate(input: ComponentStageRequest) {
  if (!object(input) || input.schemaVersion !== 1) invalid();
  for (const id of [input.environmentId, input.sandboxId, input.operationId, input.componentId, input.generation])
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) invalid();
  if (input.generation !== input.operationId || input.attemptId !== hash(`${input.operationId}:component_install`))
    invalid();
  if (!Number.isSafeInteger(input.environmentEpoch) || input.environmentEpoch < 1) invalid();
  for (const digest of [input.archiveSha256, input.treeSha256]) if (!/^[a-f0-9]{64}$/.test(digest)) invalid();
  if (
    typeof input.bindingHash !== 'string' ||
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(input.bindingHash) ||
    typeof input.installerIdentity !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(input.installerIdentity) ||
    typeof input.policyRevision !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.policyRevision)
  )
    invalid();
  const match = /^(sha256|sha512)-([A-Za-z0-9+/]+=*)$/.exec(input.integrity);
  if (!match) invalid();
  const digest = Buffer.from(match![2]!, 'base64');
  if (digest.length !== (match![1] === 'sha256' ? 32 : 64) || digest.toString('base64') !== match![2]) invalid();
  if (
    input.source !== `npm:${input.packageName}@${input.version}` ||
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(input.packageName) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.version)
  )
    invalid();
  if (
    !Array.isArray(input.tools) ||
    !input.tools.length ||
    input.tools.length > 64 ||
    input.tools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)) ||
    new Set(input.tools).size !== input.tools.length
  )
    invalid();
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 256) invalid();
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const file of input.files) {
    if (
      !object(file) ||
      !safePath(file.path) ||
      file.path.split('/').includes('node_modules') ||
      file.path.endsWith('.node') ||
      file.path.split('/').includes('binding.gyp') ||
      files.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 8 * 1024 * 1024 ||
      typeof file.contentBase64 !== 'string' ||
      file.contentBase64.length > 12 * 1024 * 1024
    )
      invalid();
    const bytes = Buffer.from(file.contentBase64, 'base64');
    total += bytes.length;
    if (
      bytes.length !== file.bytes ||
      bytes.toString('base64') !== file.contentBase64 ||
      hash(bytes) !== file.sha256 ||
      total > 8 * 1024 * 1024
    )
      invalid();
    files.set(file.path, bytes);
  }
  const rows = [...files]
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (hash(JSON.stringify(rows)) !== input.treeSha256) invalid();
  let manifest: unknown;
  try {
    manifest = JSON.parse(files.get('package.json')!.toString('utf8'));
  } catch {
    invalid();
  }
  if (!object(manifest) || manifest.name !== input.packageName || manifest.version !== input.version) invalid();
  const pkg = manifest as Record<string, unknown>;
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    if (pkg[key] !== undefined && (!object(pkg[key]) || Object.keys(pkg[key] as object).length)) invalid();
  for (const key of ['bundledDependencies', 'bundleDependencies'])
    if (pkg[key] !== undefined && (!Array.isArray(pkg[key]) || (pkg[key] as unknown[]).length)) invalid();
  if (pkg.scripts !== undefined) {
    if (!object(pkg.scripts)) invalid();
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare', 'preprepare', 'postprepare'])
      if (Object.hasOwn(pkg.scripts as object, hook)) invalid();
  }
  const pi = pkg.pi;
  if (
    !object(pi) ||
    !Array.isArray(pi.extensions) ||
    pi.extensions.length !== 1 ||
    !safePath(pi.extensions[0]) ||
    !pi.extensions[0].endsWith('.mjs') ||
    !files.has(pi.extensions[0])
  )
    invalid();
  const entrypoint = (pi as { extensions: string[] }).extensions[0]!;
  const receipt: ComponentStageReceipt = {
    schemaVersion: 1,
    status: 'staged',
    environmentId: input.environmentId,
    sandboxId: input.sandboxId,
    bindingHash: input.bindingHash,
    environmentEpoch: input.environmentEpoch,
    operationId: input.operationId,
    componentId: input.componentId,
    generation: input.generation,
    attemptId: input.attemptId,
    relativePath: `environments/${input.environmentId}/${input.componentId}/${input.generation}/${input.attemptId}/files`,
    archiveSha256: input.archiveSha256,
    treeSha256: input.treeSha256,
    diskBytes: total,
    fileCount: files.size,
    loader: { kind: 'pi-extension', entrypoint, tools: [...input.tools].sort() },
  };
  // Staging can preserve these bytes, but the tools-only loader must not silently
  // claim support for resource surfaces it does not bind into the actual session.
  const unsupportedResources = ['skills', 'mcp', 'prompts', 'themes'].filter(key => Object.hasOwn(pi as object, key));
  return { files, receipt, unsupportedResources };
}

async function directory(path: string, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
}
async function parents(root: string, subpath: string, create: boolean) {
  if (!isAbsolute(root)) invalid();
  await directory(root, create);
  if ((await realpath(root)) !== root) invalid();
  let cursor = root;
  for (const part of subpath.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    await directory(cursor, create);
  }
  return join(root, subpath);
}
async function inspect(target: string, expected: Map<string, Buffer>) {
  const observed = new Set<string>();
  async function walk(path: string) {
    await directory(path, false);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        const prefix = `${relative(target, full).split(sep).join('/')}/`;
        if (![...expected.keys()].some((path) => path.startsWith(prefix))) invalid();
        await walk(full);
      }
      else {
        if (!entry.isFile()) invalid();
        const name = relative(target, full).split(sep).join('/');
        const bytes = expected.get(name);
        if (!bytes) invalid();
        const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await fd.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes!.length) invalid();
          const actual = Buffer.alloc(bytes!.length + 1);
          let offset = 0;
          while (offset < actual.length) {
            const read = await fd.read(actual, offset, actual.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          if (offset !== bytes!.length || !actual.subarray(0, offset).equals(bytes!)) invalid();
        } finally {
          await fd.close();
        }
        observed.add(name);
      }
    }
  }
  await walk(target);
  if (observed.size !== expected.size) invalid();
}

/** No code execution or activation. A stage receipt alone is never load authority. */
export async function stageComponent(request: ComponentStageRequest, root: string): Promise<ComponentStageReceipt> {
  const { files, receipt } = validate(request);
  const target = await parents(root, receipt.relativePath, true);
  try {
    await lstat(target);
    await inspect(target, files);
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = await mkdtemp(join(dirname(target), '.component-stage-'));
  try {
    for (const [path, bytes] of files) {
      const output = await parents(temporary, path, true);
      const fd = await open(
        output,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await inspect(temporary, files);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await inspect(target, files);
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyComponent(request: ComponentStageRequest, root: string): Promise<ComponentStageReceipt> {
  const { files, receipt } = validate(request);
  const target = await parents(root, receipt.relativePath, false);
  await inspect(target, files);
  return receipt;
}

/** Capture exact verified bytes for loading; never import the mutable on-disk path afterward. */
export async function captureComponent(manifest: ComponentStageManifest, root: string) {
  const ids = [manifest.environmentId, manifest.componentId, manifest.generation, manifest.operationId];
  if (!ids.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) ||
    manifest.generation !== manifest.operationId || manifest.attemptId !== hash(`${manifest.operationId}:component_install`) ||
    !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 256) invalid();
  const subpath = `environments/${manifest.environmentId}/${manifest.componentId}/${manifest.generation}/${manifest.attemptId}/files`;
  const target = await parents(root, subpath, false);
  const files: ComponentStageRequest['files'] = [];
  let total = 0;
  for (const file of manifest.files) {
    if (!safePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || (total += file.bytes) > 8 * 1024 * 1024) invalid();
    const path = await parents(target, file.path, false);
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes) invalid();
      const bytes = Buffer.alloc(file.bytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset !== file.bytes || hash(bytes.subarray(0, offset)) !== file.sha256) invalid();
      files.push({ ...file, contentBase64: bytes.subarray(0, offset).toString('base64') });
    } finally { await fd.close(); }
  }
  const validated = validate({ ...manifest, files });
  await inspect(target, validated.files);
  return { receipt: validated.receipt, entry: Buffer.from(validated.files.get(validated.receipt.loader.entrypoint)!), unsupportedResources: validated.unsupportedResources };
}
