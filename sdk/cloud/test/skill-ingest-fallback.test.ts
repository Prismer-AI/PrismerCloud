import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy skill ingest CLI delegation', () => {
  it('preserves YAML literal block descriptions in the create request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-ingest-'));
    roots.push(root);
    const bundle = join(root, 'legal-research');
    mkdirSync(bundle);
    writeFileSync(
      join(bundle, 'SKILL.md'),
      `---\nname: legal-research\ndescription: |\n  第一行提供法律研究与案例检索说明。\n  第二行继续说明触发条件与适用范围。\n---\n\n# Legal Research\n`,
    );

    let createBody: Record<string, unknown> | null = null;
    let createPath: string | undefined;
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      createPath = request.url;
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        createBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            data: { id: 'skill-1', slug: 'community-legal-research', publishScope: 'workspace' },
          }),
        );
      });
    });
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');

    try {
      const script = resolve('catalog/skills/skill-creator/references/skill-builder/scripts/ingest.mjs');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const configDir = join(root, 'config');
      mkdirSync(configDir);
      writeFileSync(join(configDir, 'config.toml'), TOML.stringify({
        default: { api_key: 'test-api-key', base_url: baseUrl },
      }));
      // Launch this checkout's real CLI, independent of PATH and stale dist builds.
      const cloudBin = join(root, 'cloud.cjs');
      writeFileSync(cloudBin, `#!${process.execPath}\n` +
        `const { spawnSync } = require('node:child_process');\n` +
        `const result = spawnSync(${JSON.stringify(process.execPath)}, ` +
        `[${JSON.stringify(require.resolve('tsx/cli'))}, ${JSON.stringify(resolve('src/cli.ts'))}, ...process.argv.slice(2)], ` +
        `{ stdio: 'inherit', env: process.env });\n` +
        `if (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`,
      { mode: 0o700 });
      await execFileAsync(process.execPath, [script, bundle, '--json'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          PRISMER_API_KEY: 'test-api-key',
          PRISMER_CLOUD_BASE: baseUrl,
          PRISMER_BASE_URL: baseUrl,
          PRISMER_HOME: configDir,
          PRISMER_CLOUD_BIN: cloudBin,
        },
      });
    } finally {
      await new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())));
    }

    expect(createPath).toBe('/api/im/skills');
    expect(authorization).toBe('Bearer test-api-key');
    expect(createBody?.description).toBe('第一行提供法律研究与案例检索说明。\n第二行继续说明触发条件与适用范围。\n');
  });
});
