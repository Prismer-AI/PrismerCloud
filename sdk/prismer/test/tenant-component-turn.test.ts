import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createModels, type Models } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { PiAgentCoreClientOptions } from '../src/adapters/runtime-engine/pi-core/agent.js';
import { stageComponent, type ComponentStageRequest } from '../src/components/tenant-package.js';
import { parseTurnEnvelope, parseTurnResult, parseToolEventLine } from '../src/turn/protocol.js';
import { runTurnFile, type RunTurnDeps } from '../src/turn/runner.js';
import type { TenantComponentHost } from '../src/components/tenant-runtime.js';

// Replace only model transport; staging, runner, PI loader and tool execution are real.
const state = vi.hoisted(() => ({ models: undefined as Models | undefined }));
vi.mock('../src/adapters/runtime-engine/pi-core/agent.js', async (original) => {
  const actual = await original<typeof import('../src/adapters/runtime-engine/pi-core/agent.js')>();
  return {
    ...actual,
    PiAgentCoreClient: class extends actual.PiAgentCoreClient {
      constructor(options: PiAgentCoreClientOptions) {
        super({ ...options, models: state.models });
      }
    },
  };
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(salt = 'artifact-A', resource?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenant-turn-')));
  roots.push(root);
  const marker = join(root, 'loaded.txt');
  const files = Object.entries({
    'package.json': JSON.stringify({ name: '@tenant/challenge', version: '1.0.0', pi: { extensions: ['tool.mjs'], ...(resource ? { [resource]: ['SKILL.md'] } : {}) } }),
    'tool.mjs': `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'loaded'); export default pi => pi.registerTool({name:'tenant_challenge',label:'Challenge',description:'Artifact challenge',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']},execute:async(id,args)=>({content:[{type:'text',text:${JSON.stringify(salt)}+':'+[...args.nonce].reverse().join('')}],details:{}})});`,
    ...(resource ? { 'SKILL.md': '---\nname: tenant-guide\ndescription: Tenant guidance\n---\nUse the artifact challenge.\n' } : {}),
  }).map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha(content),
    contentBase64: Buffer.from(content).toString('base64'),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const request: ComponentStageRequest = {
    schemaVersion: 1,
    environmentId: 'env_one',
    sandboxId: 'pod_one',
    bindingHash: sha('binding'),
    environmentEpoch: 1,
    operationId: 'op_one',
    generation: 'op_one',
    componentId: 'cmp_one',
    attemptId: sha('op_one:component_install'),
    source: 'npm:@tenant/challenge@1.0.0',
    packageName: '@tenant/challenge',
    version: '1.0.0',
    integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
    archiveSha256: sha('archive'),
    installerIdentity: `sha256:${sha('installer')}`,
    policyRevision: 'policy-1',
    tools: ['tenant_challenge'],
    files,
    treeSha256: sha(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))),
  };
  const receipt = await stageComponent(request, root);
  const active = {
    ...request,
    files: files.map(({ contentBase64: _, ...file }) => file),
    enabled: true,
    relativePath: receipt.relativePath,
    loader: receipt.loader,
  };
  const context = {
    environmentId: request.environmentId,
    sandboxId: request.sandboxId,
    bindingHash: request.bindingHash,
    environmentEpoch: 1,
  };
  const envelope = parseTurnEnvelope({
    protocolVersion: 2,
    turnId: 'turn_one',
    message: { text: 'challenge' },
    history: [],
    systemPrompt: '',
    tools: [{ name: 'tenant_challenge', kind: 'tenant-component', enabled: true }],
    tenantComponents: [
      { componentId: active.componentId, generation: active.generation, treeSha256: active.treeSha256 },
    ],
    workdir: root,
    deadlineMs: 5000,
    cancelFile: join(root, 'cancel'),
  });
  return { root, active, context, envelope, marker, file: join(root, receipt.relativePath, 'tool.mjs') };
}

async function run(f: Awaited<ReturnType<typeof fixture>>, mode = 'ok') {
  const nonce = randomUUID();
  const faux = fauxProvider({ provider: 'faux', api: 'faux', models: [{ id: 'test', name: 'Tenant boundary' }] });
  state.models = createModels();
  state.models.setProvider(faux.provider);
  let results: unknown[] = [];
  let calls = 0;
  const live = { grant: true, enabled: true, context: { ...f.context } };
  const authorizations: unknown[] = [];
  faux.setResponses([
    async () => {
      calls++;
      if (mode === 'revoke') live.grant = false;
      if (mode === 'disable') live.enabled = false;
      if (mode === 'epoch') live.context.environmentEpoch++;
      if (mode === 'live-binding') live.context.bindingHash = sha('replacement');
      if (mode === 'live-sandbox') live.context.sandboxId = 'pod_replacement';
      if (mode === 'disk') await writeFile(f.file, 'throw Error("changed")');
      if (mode === 'removed') await rm(f.file);
      return fauxAssistantMessage(fauxToolCall('tenant_challenge', { nonce }, { id: 'challenge' }), {
        stopReason: 'toolUse',
      });
    },
    (context) => {
      results = context.messages.filter((message) => message.role === 'toolResult');
      return fauxAssistantMessage('done');
    },
  ]);
  const deps: RunTurnDeps = {
    resolveTenantComponents: async (selection) => {
      if (mode === 'resolver-failure') throw new Error('PRIVATE_RESOLVER_CREDENTIAL');
      expect(selection).toEqual({ turnId: 'turn_one', components: f.envelope.tenantComponents });
      return {
        root: f.root,
        context: f.context,
        components: [f.active],
        authorize: async (query: Parameters<TenantComponentHost['authorize']>[0]) => {
          authorizations.push(query);
          if (mode === 'unavailable') throw new Error('authorization unavailable');
          if (mode === 'load-revoke' && authorizations.length > 1) return false;
          if (query.phase === 'invoke') {
            if (mode === 'invoke-error') throw new Error('PRIVATE_AUTHORIZATION_CREDENTIAL');
            if (mode === 'truthy') return 'true' as unknown as boolean;
            if (mode === 'invoke-recheck' && authorizations.filter((q) => (q as { phase: string }).phase === 'invoke').length > 1) return false;
          }
          return live.grant && live.enabled && JSON.stringify(query.context) === JSON.stringify(live.context);
        },
      };
    },
  };
  const inputPath = join(f.root, 'input.json');
  const outputPath = join(f.root, 'output.json');
  const egressFilePath = join(f.root, 'egress.json');
  await writeFile(inputPath, JSON.stringify(f.envelope));
  await writeFile(egressFilePath, JSON.stringify({ protocolVersion: 2, url: 'http://unused.invalid/v1', token: 'test', provider: 'faux', model: 'faux/test' }));
  const exitCode = await runTurnFile({ inputPath, outputPath, egressFilePath, deps: mode === 'missing-host' ? {} : deps });
  expect(exitCode).toBe(0);
  expect(existsSync(egressFilePath)).toBe(false);
  const result = parseTurnResult(JSON.parse(await readFile(outputPath, 'utf8')));
  const eventPath = join(f.root, 'events.jsonl');
  const events = existsSync(eventPath) ? (await readFile(eventPath, 'utf8')).trim().split('\n').map(parseToolEventLine) : [];
  return { result, results, calls, nonce, authorizations, events };
}

it('consumes the staged artifact through default runner and actual PI session, including changed artifact challenge', async () => {
  for (const salt of ['artifact-A', 'artifact-B']) {
    const f = await fixture(salt);
    const outcome = await run(f);
    expect(outcome.result.status).toBe('ok');
    expect(existsSync(f.marker)).toBe(true);
    expect(outcome.results).toEqual([
      expect.objectContaining({
        isError: false,
        content: [{ type: 'text', text: `${salt}:${[...outcome.nonce].reverse().join('')}` }],
      }),
    ]);
    expect(outcome.results).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          tenantComponent: {
            componentId: 'cmp_one',
            generation: 'op_one',
            treeSha256: f.active.treeSha256,
            archiveSha256: f.active.archiveSha256,
          },
        }),
      }),
    ]);
    expect(outcome.authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn_one', phase: 'load', context: f.context, component: f.active }),
        expect.objectContaining({
          turnId: 'turn_one',
          phase: 'invoke',
          tool: 'tenant_challenge',
          context: f.context,
          component: f.active,
        }),
      ]),
    );
    expect(outcome.events).toContainEqual(
      expect.objectContaining({ kind: 'tool_finished', name: 'tenant_challenge', isError: false }),
    );
  }
});

it.each(['revoke', 'disable', 'epoch', 'live-binding', 'live-sandbox', 'disk', 'removed', 'invoke-error', 'truthy', 'invoke-recheck'])(
  'blocks %s after session creation with no bundled substitution',
  async (mode) => {
    const outcome = await run(await fixture(), mode);
    expect(outcome.result.status).toBe('ok');
    expect(outcome.results).toEqual([expect.objectContaining({ isError: true })]);
    expect(JSON.stringify(outcome.results)).not.toContain('artifact-A:');
    expect(outcome.events).toEqual([
      expect.objectContaining({ seq: 1, kind: 'tool_started', name: 'tenant_challenge' }),
      expect.objectContaining({ seq: 2, kind: 'tool_finished', name: 'tenant_challenge', isError: true }),
    ]);
    expect(outcome.result.tools).toEqual([expect.objectContaining({ name: 'tenant_challenge', isError: true, finishedAt: expect.any(String) })]);
    expect(JSON.stringify(outcome.events)).not.toContain('artifact-A:');
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE_AUTHORIZATION_CREDENTIAL');
  },
);

it.each([
  'missing-host',
  'unavailable',
  'foreign',
  'stale',
  'disabled',
  'generation',
  'digest',
  'collision',
  'tool-disabled',
  'no-selection',
  'binding',
  'sandbox',
  'load-revoke',
  'resolver-failure',
])('rejects %s before the model or artifact can run', async (mode) => {
  const f = await fixture();
  if (mode === 'foreign') f.context.environmentId = 'env_other';
  if (mode === 'stale') f.context.environmentEpoch++;
  if (mode === 'disabled') f.active.enabled = false;
  if (mode === 'generation') f.envelope.tenantComponents![0].generation = 'op_old';
  if (mode === 'digest') f.envelope.tenantComponents![0].treeSha256 = sha('wrong');
  if (mode === 'collision') f.envelope.tools!.push({ name: 'tenant_challenge', kind: 'component', enabled: true });
  if (mode === 'tool-disabled') f.envelope.tools![0].enabled = false;
  if (mode === 'no-selection') delete f.envelope.tenantComponents;
  if (mode === 'binding') f.context.bindingHash = sha('different binding');
  if (mode === 'sandbox') f.context.sandboxId = 'pod_other';
  const outcome = await run(f, mode);
  expect(outcome.result.status).toBe('error');
  expect(outcome.calls).toBe(0);
  expect(existsSync(f.marker)).toBe(false);
  expect(outcome.events).toEqual([]);
  expect(outcome.result.tools).toBeUndefined();
  expect(JSON.stringify(outcome.result)).not.toContain('PRIVATE_RESOLVER_CREDENTIAL');
});

it.each(['host', 'context', 'authorize', 'resolveTenantComponents', 'deps', '__proto__'])('does not convert JSON %s into host authority', async key => {
  const f = await fixture();
  // Keep __proto__ as an own JSON key, not a JavaScript prototype setter.
  Object.defineProperty(f.envelope, key, { enumerable: true, value: { root: f.root, context: f.context, components: [f.active], authorize: '() => true' } });
  const outcome = await run(f, 'missing-host');
  expect(outcome.result.status).toBe('error');
  expect(outcome.calls).toBe(0);
  expect(outcome.authorizations).toEqual([]);
  expect(outcome.events).toEqual([]);
  expect(existsSync(f.marker)).toBe(false);
});

it.each(['config', 'source', 'version', 'missing-enabled'])('rejects authority-shaped or implicit tenant tool %s at file ingress', async field => {
  const f = await fixture();
  const raw = JSON.parse(JSON.stringify(f.envelope));
  if (field === 'missing-enabled') delete raw.tools[0].enabled;
  else raw.tools[0][field] = field === 'config' ? { host: { context: f.context, root: f.root }, authorize: true } : 'forged';
  const inputPath = join(f.root, 'input.json');
  const outputPath = join(f.root, 'output.json');
  const egressFilePath = join(f.root, 'egress.json');
  await writeFile(inputPath, JSON.stringify(raw));
  await writeFile(egressFilePath, JSON.stringify({ protocolVersion: 2, url: 'http://unused.invalid', token: 'test', provider: 'faux', model: 'test' }));
  expect(await runTurnFile({ inputPath, outputPath, egressFilePath })).toBe(70);
  expect(existsSync(outputPath)).toBe(false);
  expect(existsSync(join(f.root, 'events.jsonl'))).toBe(false);
  expect(existsSync(egressFilePath)).toBe(false);
  expect(existsSync(f.marker)).toBe(false);
});

it.each(['skills', 'mcp', 'prompts', 'themes'])('does not claim a mixed %s package is a supported tools-only extension', async resource => {
  const f = await fixture('artifact-A', resource);
  const outcome = await run(f);
  expect(outcome.result.status).toBe('error');
  expect(outcome.calls).toBe(0);
  expect(outcome.events).toEqual([]);
  expect(existsSync(f.marker)).toBe(false);
});

it.each(['path', 'duplicate', 'malformed', 'oversize', 'maintenance'])(
  'rejects %s component selection at protocol ingress',
  async (mode) => {
    const f = await fixture();
    const raw: Record<string, unknown> = structuredClone(f.envelope);
    if (mode === 'path') raw.tenantComponents = [{ ...f.envelope.tenantComponents![0], relativePath: f.file }];
    if (mode === 'duplicate') raw.tenantComponents = [f.envelope.tenantComponents![0], f.envelope.tenantComponents![0]];
    if (mode === 'malformed')
      raw.tenantComponents = [{ componentId: '../escape', generation: 'op_one', treeSha256: sha('tree') }];
    if (mode === 'oversize') raw.tenantComponents = Array(65).fill(f.envelope.tenantComponents![0]);
    if (mode === 'maintenance') {
      raw.message = { text: '' };
      raw.tools = [];
      raw.maintenance = {
        kind: 'asset-ingest',
        version: 1,
        taskId: 'task_one',
        runId: 'turn_one',
        generation: 1,
        workspaceId: 'ws',
        assetId: 'asset',
        contentHash: sha('content'),
        ingestVersion: 1,
        environmentId: 'env_one',
        environmentEpoch: 1,
        segments: [{ path: 'sources/asset.md', text: 'source' }],
      };
      const withoutComponents = { ...raw, tenantComponents: [] };
      expect(() => parseTurnEnvelope(withoutComponents)).not.toThrow();
    }
    expect(() => parseTurnEnvelope(raw)).toThrow();
    expect(existsSync(f.marker)).toBe(false);
  },
);
