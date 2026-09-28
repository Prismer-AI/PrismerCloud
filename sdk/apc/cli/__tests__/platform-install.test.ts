/**
 * platform-install.test.ts — M1-e 验收（治 doc 13 C6）。
 *
 * 验证层级同 apc/11 §0.7：**不 mock fetch** —— 起真 `node:http` server + 真
 * `PrismerClient` 走 global fetch。oracle = server 实收的 method/path/body 序列
 * + 抛错/退出码；负控 oracle 一律是 **`calls.length===0` / 没有 install 调用**
 * （副作用缺席），不是"抛了个错"。
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PrismerClient } from '../../../cloud/src/index';
import { BUILT_IN_SKILLS_REL, BundleGuardError, REPO_ROOT } from '../bundle-guard';
import { PLATFORM_PRIVATE_SCOPE, platformInstallBundle } from '../platform-install';

const DESCRIPTION =
  'A fixture skill used by the APC platform-install acceptance tests; long enough to clear the SS-01 description floor of fifty characters.';

function makeBundle(root: string, slug: string, extraFile?: { path: string; body: string }): string {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${DESCRIPTION}\n---\n\n# ${slug}\n`, 'utf8');
  if (extraFile) {
    mkdirSync(join(dir, extraFile.path, '..'), { recursive: true });
    writeFileSync(join(dir, extraFile.path), extraFile.body, 'utf8');
  }
  return dir;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'apc-platform-install-'));
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

describe('platformInstallBundle — 真 http server 契约', () => {
  let server: Server | undefined;
  let client: PrismerClient;
  const calls: Call[] = [];

  afterEach(() => {
    server?.close();
    server = undefined;
    calls.length = 0;
  });

  async function start(route: (c: Call) => { status: number; body: unknown }): Promise<void> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const call: Call = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined };
        calls.push(call);
        const out = route(call);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as { port: number }).port;
    client = new PrismerClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-prismer-live-test' });
  }

  /** 默认路由：skill 不存在 → create → 详情返回私域行 → agent 装载成功。 */
  function defaultRoute(scope = PLATFORM_PRIVATE_SCOPE) {
    const row = { id: 'skill_cuid_1', slug: 'community-git-ops', publishScope: scope };
    return (c: Call) => {
      if (c.method === 'GET' && c.url.startsWith('/api/im/skills/skill_cuid_1')) {
        return { status: 200, body: { ok: true, data: row } };
      }
      if (c.method === 'GET' && c.url.startsWith('/api/im/skills/')) {
        return { status: 404, body: { ok: false, error: 'Skill not found' } };
      }
      if (c.method === 'POST' && c.url === '/api/im/skills') {
        return { status: 201, body: { ok: true, data: row } };
      }
      if (c.method === 'POST' && /\/api\/im\/agents\/.+\/skills$/.test(c.url)) {
        return { status: 201, body: { ok: true, data: { agentSkill: { id: 'as_1' } } } };
      }
      return { status: 500, body: { ok: false, error: `unrouted ${c.method} ${c.url}` } };
    };
  }

  it('正控：validate → POST /api/im/skills → 逐 agent POST /api/im/agents/:id/skills', async () => {
    await start(defaultRoute());
    const dir = makeBundle(tmpRoot(), 'git-ops');
    const r = await platformInstallBundle(dir, {
      workspaceId: 'ws_platform',
      agentIds: ['agent_a', 'agent_b'],
      client,
    });

    expect(r).toMatchObject({
      bundleSlug: 'git-ops',
      catalogSlug: 'community-git-ops',
      catalogSkillId: 'skill_cuid_1',
      publishScope: PLATFORM_PRIVATE_SCOPE,
      catalogAction: 'created',
      installedAgentIds: ['agent_a', 'agent_b'],
    });

    // 打的全部是既有 endpoint（不新建服务端能力）。
    const created = calls.find((c) => c.method === 'POST' && c.url === '/api/im/skills')!;
    expect(created).toBeTruthy();
    expect(created.body).toMatchObject({ name: 'git-ops', description: DESCRIPTION, category: 'general' });
    // create body **不带** publishScope —— 服务端 schema 默认就是私域 'workspace'；
    // 由 CLI 自己指定域是把权限判断挪到客户端，正是 C6 那类病。
    expect(Object.keys(created.body as object)).not.toContain('publishScope');

    const installs = calls.filter((c) => /\/api\/im\/agents\/.+\/skills$/.test(c.url));
    expect(installs.map((c) => c.url)).toEqual([
      '/api/im/agents/agent_a/skills',
      '/api/im/agents/agent_b/skills',
    ]);
    for (const i of installs) {
      expect(i.body).toEqual({ skillId: 'skill_cuid_1', workspaceId: 'ws_platform' });
    }
  });

  it('多文件 bundle → create body 带 contentManifest + revision（scripts/ 不丢）', async () => {
    await start(defaultRoute());
    const dir = makeBundle(tmpRoot(), 'git-ops', { path: 'scripts/run.sh', body: '#!/bin/sh\necho hi\n' });
    await platformInstallBundle(dir, { workspaceId: 'ws_platform', agentIds: [], client });
    const created = calls.find((c) => c.method === 'POST' && c.url === '/api/im/skills')!;
    const body = created.body as Record<string, unknown>;
    expect(Array.isArray(body.contentManifest)).toBe(true);
    expect((body.contentManifest as unknown[]).length).toBe(2);
    expect(typeof body.contentManifestRevision).toBe('string');
  });

  it('已存在 → PATCH 更新而非重复 create（幂等重跑）', async () => {
    const row = { id: 'skill_cuid_1', slug: 'community-git-ops', publishScope: PLATFORM_PRIVATE_SCOPE };
    await start((c) => {
      if (c.method === 'GET') return { status: 200, body: { ok: true, data: row } };
      if (c.method === 'PATCH') return { status: 200, body: { ok: true, data: row } };
      if (c.method === 'POST' && /\/agents\/.+\/skills$/.test(c.url)) return { status: 201, body: { ok: true } };
      return { status: 500, body: { ok: false, error: `unrouted ${c.method} ${c.url}` } };
    });
    const dir = makeBundle(tmpRoot(), 'git-ops');
    const r = await platformInstallBundle(dir, { workspaceId: 'ws_platform', agentIds: ['agent_a'], client });
    expect(r.catalogAction).toBe('updated');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/im/skills')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('负控：catalog 行是 marketplace（公域）→ 中止，且一次 agent 装载都不发生', async () => {
    await start(defaultRoute('marketplace'));
    const dir = makeBundle(tmpRoot(), 'git-ops');
    await expect(
      platformInstallBundle(dir, { workspaceId: 'ws_platform', agentIds: ['agent_a'], client }),
    ).rejects.toThrow(/publishScope='marketplace'/);
    // 副作用缺席才是判据。
    expect(calls.filter((c) => /\/agents\/.+\/skills$/.test(c.url))).toHaveLength(0);
  });

  it('负控：agent 装载被服务端拒（403）→ 抛，后续 agent 不再装', async () => {
    await start((c) => {
      const route = defaultRoute();
      if (/\/api\/im\/agents\/.+\/skills$/.test(c.url)) {
        return { status: 403, body: { ok: false, error: 'Admin, workspace owner, or agent token required' } };
      }
      return route(c);
    });
    const dir = makeBundle(tmpRoot(), 'git-ops');
    await expect(
      platformInstallBundle(dir, { workspaceId: 'ws_platform', agentIds: ['agent_a', 'agent_b'], client }),
    ).rejects.toThrow(/install to agent agent_a failed/);
    expect(calls.filter((c) => c.url === '/api/im/agents/agent_b/skills')).toHaveLength(0);
  });

  it('负控：bundle 不合 SS-01（description 太短）→ 一个请求都不发', async () => {
    await start(defaultRoute());
    const root = tmpRoot();
    const dir = join(root, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: bad\ndescription: too short\n---\n\n# bad\n', 'utf8');
    await expect(platformInstallBundle(dir, { workspaceId: 'ws', agentIds: [], client })).rejects.toThrow(
      /bundle invalid/,
    );
    expect(calls).toHaveLength(0);
  });

  it('负控：指向真 built-in-skills → BundleGuardError，且一个请求都不发', async () => {
    await start(defaultRoute());
    const dir = join(REPO_ROOT, BUILT_IN_SKILLS_REL, 'memory');
    await expect(
      platformInstallBundle(dir, { workspaceId: 'ws', agentIds: ['agent_a'], client }),
    ).rejects.toThrow(BundleGuardError);
    expect(calls).toHaveLength(0);
  });
});

describe('C6-b — 私域标记是单值不是允许集', () => {
  it("PLATFORM_PRIVATE_SCOPE === 'workspace'（schema.mysql.prisma:2157 的 default，二元值域的私域端）", () => {
    expect(PLATFORM_PRIVATE_SCOPE).toBe('workspace');
    // 它是 string 常量，不是集合 —— 旧 `PRIVATE_PUBLISH_SCOPES` 那种"多放行"形态
    // 在类型层面就不可能再出现。
    expect(typeof PLATFORM_PRIVATE_SCOPE).toBe('string');
  });
});
