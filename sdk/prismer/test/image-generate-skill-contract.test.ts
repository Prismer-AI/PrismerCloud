import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO = resolve(import.meta.dirname, '../../..');
const CATALOG = join(REPO, 'sdk/cloud/catalog/skills/image-generate');
const SCRIPT = join(CATALOG, 'scripts/generate-and-deliver.mjs');
const ROLE = join(REPO, 'sdk/cloud/catalog/roles/image-prompt-engineer.json');
const REGRESSION_ENTRY = join(REPO, 'scripts/test-image-generate-skill.ts');
const LOCAL_E2E = join(REPO, 'scripts/test-image-generate-skill-local-e2e.ts');
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
});

describe('image-generate built-in skill contract', () => {
  it('routes generation through one deterministic helper and never asks the model to serialize attachments', () => {
    const catalogSkill = readFileSync(join(CATALOG, 'SKILL.md'), 'utf8');

    expect(catalogSkill).toContain('scripts/generate-and-deliver.mjs');
    expect(catalogSkill).toContain('cloud deliver');
    expect(catalogSkill).not.toContain('POST /api/im/assets');
    expect(catalogSkill).not.toMatch(/\{\s*"kind"\s*:\s*"image"/);
    expect(existsSync(SCRIPT)).toBe(true);
    const role = readFileSync(ROLE, 'utf8');
    expect(role).toContain('bundled helper');
    expect(role).not.toContain('Deliver the resulting image as a ContentBlock');
    expect(role).not.toContain('通过 asset 管线以 ContentBlock 交付最终图像');
    const regressionEntry = readFileSync(REGRESSION_ENTRY, 'utf8');
    expect(regressionEntry).toContain('--local-e2e');
    expect(regressionEntry).toContain('test-image-generate-skill-local-e2e.ts');
    const localE2E = readFileSync(LOCAL_E2E, 'utf8');
    expect(localE2E).toContain('/api/im/assets?workspaceId=');
    expect(localE2E).toContain('/api/im/messages/');
    expect(localE2E).toContain('ArtifactsWatcher');
    expect(localE2E).toContain('LocalServer');
  });

  it('generates once, falls back by model priority, and delivers exactly one file without printing ContentBlock JSON', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url === '/api/v1/image-models') {
          res.end(JSON.stringify({ data: [
            { id: 'primary', priority: 1, sizes: ['1024x1024'], defaultSize: '1024x1024' },
            { id: 'fallback', priority: 2, sizes: ['1024x1024'], defaultSize: '1024x1024' },
            { id: 'portrait', priority: 3, sizes: ['1024x1792'], defaultSize: '1024x1792' },
          ] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/api/v1/images/generations') {
          const requestBody = JSON.parse(body);
          if (requestBody.prompt === 'credits exhausted') {
            res.statusCode = 402;
            res.end(JSON.stringify({ error: { code: 'insufficient_credits', message: 'top up' } }));
            return;
          }
          const supportedSizes: Record<string, string[]> = {
            primary: ['1024x1024'],
            fallback: ['1024x1024'],
            portrait: ['1024x1792'],
          };
          if (!supportedSizes[requestBody.model]?.includes(requestBody.size)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { code: 'model_size_unsupported', message: 'bad size' } }));
            return;
          }
          if (requestBody.model === 'primary') {
            res.statusCode = 503;
            res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'retry' } }));
            return;
          }
          res.end(JSON.stringify({ data: [{ b64_json: PNG_1X1 }] }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'unexpected route' } }));
      });
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const scratch = mkdtempSync(join(tmpdir(), 'image-generate-skill-'));
    const callsPath = join(scratch, 'cloud-calls.jsonl');
    const fakeCloud = join(scratch, 'cloud');
    writeFileSync(
      fakeCloud,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'fs.appendFileSync(process.env.CLOUD_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
        'const result = process.env.FAKE_CLOUD_QUEUED === "1"',
        '  ? { ok: true, status: 202, queued: true, mode: "attach" }',
        '  : process.env.FAKE_CLOUD_UNATTACHED === "1"',
        '    ? { ok: true, status: 200, assetId: "asset-once", mode: "attach", ridesReply: false }',
        '    : { ok: true, status: 200, assetId: "asset-once", mode: "attach", ridesReply: true };',
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n'),
    );
    chmodSync(fakeCloud, 0o755);
    const output = join(scratch, 'result.png');

    const result = await execFileAsync(process.execPath, [
      SCRIPT,
      '--prompt',
      'a dog taking a fadeaway jump shot',
      '--output',
      output,
    ], {
      env: {
        ...process.env,
        PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
        PRISMER_API_KEY: 'sk-test',
        PRISMER_CLOUD_BIN: fakeCloud,
        CLOUD_CALLS: callsPath,
      },
      timeout: 8_000,
    });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/image-models',
      'POST /api/v1/images/generations',
      'POST /api/v1/images/generations',
    ]);
    expect(requests.some((request) => request.url.includes('/api/im/assets'))).toBe(false);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['deliver', output, '--json'],
    ]);
    expect(readFileSync(output).toString('base64')).toBe(PNG_1X1);
    expect(result.stdout).toContain('assetId=asset-once');
    expect(result.stdout).not.toContain('"kind":"image"');
    expect(result.stdout).not.toContain('b64_json');

    const beforeFailure = requests.length;
    await expect(
      execFileAsync(process.execPath, [SCRIPT, '--prompt', 'credits exhausted', '--output', join(scratch, 'blocked.png')], {
        env: {
          ...process.env,
          PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
          PRISMER_API_KEY: 'sk-test',
          PRISMER_CLOUD_BIN: fakeCloud,
          CLOUD_CALLS: callsPath,
        },
        timeout: 8_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('status=402'),
    });
    expect(requests.slice(beforeFailure).map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/image-models',
      'POST /api/v1/images/generations',
    ]);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toHaveLength(1);

    const beforePortrait = requests.length;
    await execFileAsync(process.execPath, [
      SCRIPT,
      '--prompt',
      'portrait image',
      '--size',
      '1024x1792',
      '--output',
      join(scratch, 'portrait.png'),
    ], {
      env: {
        ...process.env,
        PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
        PRISMER_API_KEY: 'sk-test',
        PRISMER_CLOUD_BIN: fakeCloud,
        CLOUD_CALLS: callsPath,
      },
      timeout: 8_000,
    });
    expect(requests.slice(beforePortrait).map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/image-models',
      'POST /api/v1/images/generations',
    ]);
    expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({ model: 'portrait', size: '1024x1792' });

    const beforeUnsupported = requests.length;
    const deliversBeforeUnsupported = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    await expect(
      execFileAsync(process.execPath, [
        SCRIPT,
        '--prompt',
        'landscape image',
        '--size',
        '1792x1024',
        '--output',
        join(scratch, 'unsupported.png'),
      ], {
        env: {
          ...process.env,
          PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
          PRISMER_API_KEY: 'sk-test',
          PRISMER_CLOUD_BIN: fakeCloud,
          CLOUD_CALLS: callsPath,
        },
        timeout: 8_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('No image model supports size=1792x1024'),
    });
    expect(requests.slice(beforeUnsupported).map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/v1/image-models',
    ]);
    expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toHaveLength(deliversBeforeUnsupported);

    const artifactsDir = join(scratch, 'dispatch-artifacts');
    await execFileAsync(process.execPath, [SCRIPT, '--prompt', 'default output directory'], {
      cwd: scratch,
      env: {
        ...process.env,
        PRISMER_ARTIFACTS_DIR: artifactsDir,
        PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
        PRISMER_API_KEY: 'sk-test',
        PRISMER_CLOUD_BIN: fakeCloud,
        CLOUD_CALLS: callsPath,
      },
      timeout: 8_000,
    });
    const defaultDeliver = JSON.parse(readFileSync(callsPath, 'utf8').trim().split('\n').at(-1)!);
    expect(defaultDeliver[0]).toBe('deliver');
    expect(defaultDeliver[1]).toMatch(new RegExp(`^${artifactsDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/generated-[a-f0-9]{8}\\.png$`));
    expect(existsSync(defaultDeliver[1])).toBe(true);

    const queued = await execFileAsync(process.execPath, [
      SCRIPT,
      '--prompt',
      'queued upload',
      '--output',
      join(scratch, 'queued.png'),
    ], {
      env: {
        ...process.env,
        FAKE_CLOUD_QUEUED: '1',
        PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
        PRISMER_API_KEY: 'sk-test',
        PRISMER_CLOUD_BIN: fakeCloud,
        CLOUD_CALLS: callsPath,
      },
      timeout: 8_000,
    });
    expect(queued.stdout).toContain('[image-generate] queued');
    expect(queued.stdout).not.toContain('[image-generate] delivered');

    const unattached = await execFileAsync(
      process.execPath,
      [SCRIPT, '--prompt', 'uploaded without dispatch', '--output', join(scratch, 'unattached.png')],
      {
        env: {
          ...process.env,
          FAKE_CLOUD_UNATTACHED: '1',
          PRISMER_CLOUD_BASE: `http://127.0.0.1:${address.port}`,
          PRISMER_API_KEY: 'sk-test',
          PRISMER_CLOUD_BIN: fakeCloud,
          CLOUD_CALLS: callsPath,
        },
        timeout: 8_000,
      },
    );
    expect(unattached.stdout).toContain('[image-generate] uploaded-unattached');
    expect(unattached.stdout).not.toContain('[image-generate] delivered');
  }, 30_000);
});
