/**
 * K 空腔闭合 B — `cloud im contacts --external` + `cloud im send` 202 分支
 * （docs/bugfix211/k-agent-contact-surface-cavity.md §3-B）。
 *
 * 反开卷纪律（apc/11 §1 同款，harness = test/helpers/fake-cloud）：
 *  - fetch 不 mock——真实 node:http server + 真实 PrismerClient，
 *    oracle = server 实际收到的 method/path/query + 进程退出码。
 *  - 缺 workspace-id 的负控断言**副作用缺席**（server.calls.length === 0），
 *    不断言消息文案。
 *
 * 端点锚定（写文件前已对源码核验）：
 *   GET /api/im/me/external-contacts?workspaceId= — src/im/api/me.ts（K 新增）
 *   POST /api/im/direct/:userId/messages 202 ACTION_DEFERRED — src/im/api/direct.ts:141-152
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { register } from '../src/commands/im';
import { startFakeCloud, makeRealClient, runCli, type FakeCloud, type Route } from './helpers/fake-cloud';

const externalOk: Route = () => ({
  status: 200,
  json: {
    ok: true,
    data: {
      viewer: { imUserId: 'l1hhottgean', displayName: '团队管家', role: 'agent' },
      external: [
        {
          viaAgent: { imUserId: 'l1hhottgean', displayName: '团队管家' },
          peer: {
            imUserId: '2kq9ywswpi7',
            displayName: '私人助理',
            agentType: 'orchestrator',
            workspaceName: 'pp',
            lifecycle: 'active',
            principal: { displayName: 'haha', avatarUrl: null },
          },
        },
      ],
    },
  },
});

const deferredSend: Route = ({ path }) => ({
  status: 202,
  json:
    path.startsWith('/api/im/direct/')
      ? {
          ok: true,
          data: { deferred: true, approvalId: 'ap-1', reason: 'cross-ws contact approval' },
          meta: { code: 'ACTION_DEFERRED' },
        }
      : { ok: true, data: {} },
});

let cloud: FakeCloud;
const envBackup: Record<string, string | undefined> = {};

beforeEach(async () => {
  cloud = await startFakeCloud(externalOk);
  for (const k of ['PRISMER_WORKSPACE_ID']) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await cloud.close();
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('cloud im contacts --external — real HTTP round trip', () => {
  it('GETs /api/im/me/external-contacts with workspaceId query, exit 0, prints peer row', async () => {
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(register, client, ['im', 'contacts', '--external', '--workspace-id', 'ws-1']);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    const call = cloud.calls[0];
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/api/im/me/external-contacts');
    expect(call.query).toBe('workspaceId=ws-1');
    // 行级 oracle：对端 displayName / 台名进入输出（不断言整句文案）
    expect(r.stdout).toContain('私人助理');
    expect(r.stdout).toContain('pp');
  });

  it('--external without --workspace-id or PRISMER_WORKSPACE_ID → exit 1, zero requests', async () => {
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(register, client, ['im', 'contacts', '--external']);

    expect(r.exitCode).toBe(1);
    expect(cloud.calls).toHaveLength(0);
  });

  it('empty external list → "No external contacts." without crash', async () => {
    cloud.setRoute(() => ({
      status: 200,
      json: { ok: true, data: { viewer: { imUserId: 'a1', displayName: 'A', role: 'agent' }, external: [] } },
    }));
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(register, client, ['im', 'contacts', '--external', '--workspace-id', 'ws-1']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No external contacts');
  });
});

describe('cloud im send — 202 ACTION_DEFERRED branch', () => {
  it('202 deferred → exit 0, prints approval wait (approvalId), never claims "sent"', async () => {
    cloud.setRoute(deferredSend);
    const client = makeRealClient(cloud.baseUrl);

    const r = await runCli(register, client, ['im', 'send', '2kq9ywswpi7', 'hello peer']);

    expect(r.exitCode).toBe(0);
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0].path).toBe('/api/im/direct/2kq9ywswpi7/messages');
    expect(r.stdout).toContain('ap-1');
    expect(r.stdout).not.toContain('Message sent');
  });
});
