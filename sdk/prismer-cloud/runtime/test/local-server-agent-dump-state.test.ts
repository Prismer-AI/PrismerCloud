import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';

let server: LocalServer | undefined;
let baseUrl = '';
let tempRoot = '';
let previousHermesHome: string | undefined;

const baseState: LocalServerState = {
  daemonId: 'dev_test',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: 'ws-1',
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [{ imUserId: 'agent-1', name: 'Ada', adapterName: 'hermes' }],
  runningTaskIds: [],
};

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'prismer-agent-dump-'));
  previousHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = join(tempRoot, 'hermes');
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousHermesHome;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

async function startServer(): Promise<void> {
  const port = 41400 + Math.floor(Math.random() * 1000);
  server = new LocalServer({
    port,
    getState: () => baseState,
    snapshotRoot: join(tempRoot, 'workspace'),
  });
  await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
}

describe('POST /v1/agents/:agentId/dump-state', () => {
  it('returns an agent-scoped manifest without walking sibling agent dirs', async () => {
    await mkdir(join(tempRoot, 'hermes', 'profiles', 'Ada'), { recursive: true });
    await mkdir(join(tempRoot, 'workspace', 'agents', 'agent-1'), { recursive: true });
    await mkdir(join(tempRoot, 'workspace', 'agents', 'agent-2'), { recursive: true });
    await writeFile(join(tempRoot, 'hermes', 'profiles', 'Ada', 'SOUL.md'), 'You are Ada.');
    await writeFile(join(tempRoot, 'workspace', 'agents', 'agent-1', 'output.txt'), 'agent one output');
    await writeFile(join(tempRoot, 'workspace', 'agents', 'agent-2', 'secret.txt'), 'do not include');
    await startServer();

    const res = await fetch(`${baseUrl}/v1/agents/agent-1/dump-state`, { method: 'POST' });
    const body = await res.json() as {
      files: Array<{ path: string; sha256: string; sizeBytes: number; rootKind: string }>;
      roots: Array<{ kind: string; exists: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(body.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hermes-profile', exists: true }),
        expect.objectContaining({ kind: 'workspace-agent', exists: true }),
      ]),
    );
    expect(body.files.map((file) => file.path).sort()).toEqual([
      'hermes-profile/SOUL.md',
      'workspace-agent/output.txt',
    ]);
    expect(body.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it('returns 404 for agents not hosted by this daemon', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/v1/agents/agent-missing/dump-state`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toMatchObject({ error: 'agent_not_hosted', agentId: 'agent-missing' });
  });
});
