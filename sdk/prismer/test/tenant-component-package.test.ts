import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { stageComponent, verifyComponent, type ComponentStageRequest } from '../src/components/tenant-package.js';
import { buildComponentCommand } from '../src/cli/commands/component.js';
import { loadTenantComponent } from '../src/components/tenant-loader.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'eaas-component-stage-')));
  roots.push(path);
  return path;
}
function request(): ComponentStageRequest {
  const files = Object.entries({
    'package.json': JSON.stringify({ name: '@tenant/test', version: '1.0.0', pi: { extensions: ['tool.mjs'] } }),
    'tool.mjs': 'export default function(pi) { pi.registerTool({name:"lookup"}); }',
  }).map(([path, text]) => ({
    path,
    bytes: Buffer.byteLength(text),
    sha256: sha(text),
    contentBase64: Buffer.from(text).toString('base64'),
  }));
  return {
    schemaVersion: 1,
    environmentId: 'env_test',
    sandboxId: 'pod_test',
    bindingHash: sha('binding'),
    environmentEpoch: 1,
    operationId: 'op_test',
    componentId: 'cmp_test',
    generation: 'op_test',
    attemptId: sha('op_test:component_install'),
    source: 'npm:@tenant/test@1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    policyRevision: 'policy-1',
    installerIdentity: `sha256:${sha('installer')}`,
    packageName: '@tenant/test',
    version: '1.0.0',
    archiveSha256: sha('archive'),
    treeSha256: sha(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))),
    tools: ['lookup'],
    files,
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('tenant component inert staging', () => {
  it('loads actual tenant code through the pinned PI extension loader and refuses revoked execution', async () => {
    const directory = await root();
    const input = request();
    const code = Buffer.from('export default (pi) => pi.registerTool({ name:"lookup", label:"Lookup", description:"Tenant challenge", parameters:{type:"object",properties:{nonce:{type:"string"}},required:["nonce"]}, execute:async(id,args)=>({content:[{type:"text",text:"artifact-only:"+args.nonce}],details:{}}) });');
    Object.assign(input.files[1], { bytes: code.length, sha256: sha(code), contentBase64: code.toString('base64') });
    input.treeSha256 = sha(JSON.stringify(input.files.map(({path, bytes, sha256}) => ({path, bytes, sha256}))));
    const receipt = await stageComponent(input, directory);
    const { files, ...identity } = input;
    const active = { ...identity, files: files.map(({contentBase64: _bytes, ...file}) => file), enabled: true, relativePath: receipt.relativePath, loader: receipt.loader };
    let allowed = true;
    const loaded = await loadTenantComponent(active, identity, directory, async () => allowed);
    expect(loaded.map(tool => tool.definition.name)).toEqual(['lookup']);
    const nonce = sha(String(Math.random()));
    const result = await loaded[0].definition.execute('call', { nonce }, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: 'text', text: `artifact-only:${nonce}` }]);
    allowed = false;
    await expect(loaded[0].definition.execute('call2', {nonce}, undefined, undefined, {} as never)).rejects.toThrow(/component/);
  });
  it.each(['disabled', 'foreign-environment', 'stale-epoch', 'unauthorized', 'changed-file'])(
    'does not load %s declarations', async (kind) => {
      const directory = await root();
      const input = request();
      const receipt = await stageComponent(input, directory);
      const { files, ...identity } = input;
      const active = { ...identity, files: files.map(({contentBase64: _bytes, ...file}) => file), enabled: kind !== 'disabled', relativePath: receipt.relativePath, loader: receipt.loader };
      const context = { ...identity };
      if (kind === 'foreign-environment') context.environmentId = 'env_other';
      if (kind === 'stale-epoch') context.environmentEpoch += 1;
      if (kind === 'changed-file') await writeFile(join(directory, receipt.relativePath, 'tool.mjs'), 'throw Error("unverified")');
      await expect(loadTenantComponent(active, context, directory, async () => kind !== 'unauthorized')).rejects.toThrow(/component/);
    },
  );
  it('uses the CLI JSON framing and actual stage/verify implementation', async () => {
    const directory = await root();
    const input = request();
    const results: unknown[] = [];
    for (const method of ['stage', 'verify']) {
      let output = '';
      const command = buildComponentCommand({
        root: directory,
        input: Readable.from([JSON.stringify(input)]),
        output: new Writable({
          write(chunk, _encoding, done) {
            output += chunk.toString();
            done();
          },
        }),
      });
      await command.parseAsync([method], { from: 'user' });
      expect(output.split('\n')).toHaveLength(2);
      results.push(JSON.parse(output));
    }
    expect(results[0]).toEqual(results[1]);
  });
  it('writes exact files and verifies them without executing the extension', async () => {
    const directory = await root();
    const input = request();
    const receipt = await stageComponent(input, directory);
    expect(receipt.status).toBe('staged');
    expect(receipt.relativePath).toBe(`environments/env_test/cmp_test/op_test/${input.attemptId}/files`);
    expect(receipt.loader).toEqual({ kind: 'pi-extension', entrypoint: 'tool.mjs', tools: ['lookup'] });
    expect(await readFile(join(directory, receipt.relativePath, 'tool.mjs'), 'utf8')).toBe(
      Buffer.from(input.files[1].contentBase64, 'base64').toString(),
    );
    expect(await verifyComponent(input, directory)).toEqual(receipt);
    expect(await stageComponent(input, directory)).toEqual(receipt);
  });
  it.each([
    'digest',
    'traversal',
    'duplicate',
    'generation',
    'attempt',
    'tool',
    'identity',
    'dependency',
    'hook',
    'entrypoint',
  ])('rejects invalid %s before materialization', async (kind) => {
    const input = request();
    if (kind === 'digest') input.files[1].contentBase64 = Buffer.from('changed').toString('base64');
    if (kind === 'traversal') input.files[1].path = '../escape';
    if (kind === 'duplicate') input.files.push({ ...input.files[0] });
    if (kind === 'generation') input.generation = 'op_old';
    if (kind === 'attempt') input.attemptId = sha('old');
    if (kind === 'tool') input.tools = ['bash;evil'];
    if (['identity', 'dependency', 'hook', 'entrypoint'].includes(kind)) {
      const manifest = JSON.parse(Buffer.from(input.files[0].contentBase64, 'base64').toString());
      if (kind === 'identity') manifest.name = '@other/test';
      if (kind === 'dependency') manifest.dependencies = { unverified: 'latest' };
      if (kind === 'hook') manifest.scripts = { prepare: 'touch /tmp/never' };
      if (kind === 'entrypoint') manifest.pi.extensions = ['missing.mjs'];
      const bytes = Buffer.from(JSON.stringify(manifest));
      Object.assign(input.files[0], {
        contentBase64: bytes.toString('base64'),
        bytes: bytes.length,
        sha256: sha(bytes),
      });
      input.treeSha256 = sha(JSON.stringify(input.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
    }
    await expect(stageComponent(input, await root())).rejects.toThrow(/component/);
  });
  it.each(['modified', 'extra', 'symlink', 'empty-directory', 'hardlink'])('rejects %s staged bytes without repair or fallback', async (kind) => {
    const input = request();
    const directory = await root();
    const receipt = await stageComponent(input, directory);
    const file = join(directory, receipt.relativePath, 'tool.mjs');
    if (kind === 'modified') await writeFile(file, 'changed');
    if (kind === 'extra') await writeFile(join(directory, receipt.relativePath, 'extra.mjs'), 'extra');
    if (kind === 'symlink') {
      await rm(file);
      await symlink('/etc/hosts', file);
    }
    if (kind === 'empty-directory') await mkdir(join(directory, receipt.relativePath, 'unexpected'));
    if (kind === 'hardlink') await link(file, join(directory, 'external-link'));
    await expect(verifyComponent(input, directory)).rejects.toThrow(/component/);
    await expect(stageComponent(input, directory)).rejects.toThrow(/component/);
  });
});
