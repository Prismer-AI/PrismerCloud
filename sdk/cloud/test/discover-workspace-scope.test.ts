/** Product207/28 Task 8 — agent-specific CLI discovery stays on the scoped Agent Registry. */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismerClient } from '../src/index';
import { register as registerIM } from '../src/commands/im';

const execFileAsync = promisify(execFile);
const API_KEY = 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const createdHomes: string[] = [];

async function startCloud() {
  const calls: Array<{ method: string; url: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push({ method: req.method ?? 'GET', url: req.url ?? '' });
    if (req.url?.startsWith('/api/im/agents')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        data: [{
          agentId: 'card-bob',
          userId: 'usr-bob',
          username: 'bob',
          name: 'Bob Agent',
          description: 'Scoped agent',
          agentType: 'assistant',
          capabilities: [
            'chat',
            { name: 'code-review', description: 'Reviews code changes' },
          ],
          status: 'online',
          load: 0,
          visionCapable: false,
        }],
      }));
      return;
    }
    if (req.url === '/api/im/direct/usr-bob/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { conversationId: 'conv-bob', messageId: 'msg-1' } }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'unexpected', message: req.url } }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolveClose, reject) => server.close((err) => (err ? reject(err) : resolveClose()))),
  };
}

async function runTopLevel(
  baseUrl: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = await mkdtemp(resolve(tmpdir(), 'p207-cloud-cli-'));
  createdHomes.push(home);
  await writeFile(
    resolve(home, 'config.toml'),
    `[default]\napi_key = "${API_KEY}"\nbase_url = "${baseUrl}"\nenvironment = "production"\n`,
  );
  try {
    const result = await execFileAsync(
      resolve(REPO_ROOT, 'node_modules/.bin/tsx'),
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          PRISMER_HOME: home,
          PRISMER_WORKSPACE_ID: env.PRISMER_WORKSPACE_ID,
          NO_COLOR: '1',
        },
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr || failed.message,
    };
  }
}

async function runIMCli(client: PrismerClient, argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerIM(program, () => client, () => client);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as typeof process.exit;
  try {
    await program.parseAsync(['node', 'cloud', 'im', ...argv]);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('__exit_'))) throw error;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exit = originalExit;
  }
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

afterEach(async () => {
  await Promise.all(createdHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe.sequential('workspace-scoped agent discovery', () => {
  it('top-level discover uses only GET /api/im/agents with explicit workspace precedence', async () => {
    const cloud = await startCloud();
    try {
      const result = await runTopLevel(cloud.baseUrl, ['discover', '--workspace-id', 'ws-a', '--json'], {
        PRISMER_WORKSPACE_ID: 'ws-env',
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(cloud.calls).toEqual([{ method: 'GET', url: '/api/im/agents?workspaceId=ws-a' }]);
      expect(cloud.calls.some((call) => call.url.startsWith('/api/im/discover'))).toBe(false);
      const body = JSON.parse(result.stdout);
      expect(body.data[0].capabilities).toEqual([
        'chat',
        { name: 'code-review', description: 'Reviews code changes' },
      ]);
    } finally {
      await cloud.close();
    }
  });

  it('top-level discover table exposes the routable user id and mixed capability names', async () => {
    const cloud = await startCloud();
    try {
      const result = await runTopLevel(cloud.baseUrl, ['discover', '--workspace-id', 'ws-a']);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(cloud.calls).toEqual([{ method: 'GET', url: '/api/im/agents?workspaceId=ws-a' }]);
      expect(result.stdout).toContain('usr-bob');
      expect(result.stdout).toContain('chat');
      expect(result.stdout).toContain('code-review');
    } finally {
      await cloud.close();
    }
  });

  it('top-level discover fails before fetch when no workspace flag or env exists', async () => {
    const cloud = await startCloud();
    try {
      const result = await runTopLevel(cloud.baseUrl, ['discover', '--json']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('workspace id is required for agent discovery');
      expect(cloud.calls).toEqual([]);
    } finally {
      await cloud.close();
    }
  });

  it('nested im discover uses AgentsClient and PRISMER_WORKSPACE_ID fallback', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new PrismerClient({ apiKey: API_KEY, baseUrl: 'https://api.test', fetch: fetchFn });
    const previous = process.env.PRISMER_WORKSPACE_ID;
    process.env.PRISMER_WORKSPACE_ID = 'ws-env';
    try {
      const result = await runIMCli(client, ['discover', '--json']);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(calls).toEqual(['https://api.test/api/im/agents?workspaceId=ws-env']);
      expect(calls.some((url) => url.includes('/api/im/discover'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PRISMER_WORKSPACE_ID;
      else process.env.PRISMER_WORKSPACE_ID = previous;
    }
  });

  it('top-level send --by-username resolves an AgentCard by userId/username/name', async () => {
    const cloud = await startCloud();
    try {
      const result = await runTopLevel(cloud.baseUrl, [
        'send',
        'Bob Agent',
        'hello',
        '--by-username',
        '--workspace-id',
        'ws-a',
        '--json',
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(cloud.calls.map((call) => call.url)).toEqual([
        '/api/im/agents?workspaceId=ws-a',
        '/api/im/direct/usr-bob/messages',
      ]);
      expect(cloud.calls.some((call) => call.url.startsWith('/api/im/discover'))).toBe(false);
    } finally {
      await cloud.close();
    }
  });

  it('nested im send --by-username remains a human/contact discovery workflow', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url === 'https://api.test/api/im/discover') {
        return new Response(JSON.stringify({
          ok: true,
          data: [{ userId: 'usr-human', username: 'alice', displayName: 'Alice Human' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: { conversationId: 'conv-human', messageId: 'msg-human' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new PrismerClient({ apiKey: API_KEY, baseUrl: 'https://api.test', fetch: fetchFn });

    const result = await runIMCli(client, ['send', 'alice', 'hello', '--by-username', '--json']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(calls).toEqual([
      'https://api.test/api/im/discover',
      'https://api.test/api/im/direct/usr-human/messages',
    ]);
  });
});
