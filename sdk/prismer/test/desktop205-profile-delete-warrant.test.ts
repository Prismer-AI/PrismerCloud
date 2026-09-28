/**
 * desktop205 O15 — `syncProfileFromCloud` 的「删本地 profile + agent 行」判据。
 *
 * 缺口：原判据是裸 `CloudError.status === 404`。真断云给的是 `status:0`，所以当时
 * 是安全的 —— 但「404」≠「服务器确认这个 profile 没了」。captive portal、反代误路由、
 * 滚动发布期的 404 都会命中，而这是**破坏性操作用弱判据**。
 *
 * 且 `CloudError.code` 帮不上忙：`CloudClient.request` 在 body 不是我们
 * `{error:{code}}` 对象时会**合成** `code:'not_found'`（src/auth.ts），nginx 的
 * HTML 404 与真 404 在 CloudError 上完全同形。收紧后要求一次**正向确认**：重读同一
 * 路由的原始响应，必须是 404 且 body 是我们自己的 JSON 错误信封。
 *
 * ## 为什么不 mock
 * 三种 404 的差别就在**真实响应体**上，替身掉 fetch 等于把被测的东西替掉。这里起
 * 真 `http.Server`（分别回我方信封 / nginx HTML / 关端口）、真 `CloudClient`、真
 * better-sqlite3 本地库，跑真 `Runner.syncProfileFromCloud`。
 *
 * ## oracle 只取副作用
 * 断言的是 **local.db 里 `agent_profiles` / `agents` 两张表的行还在不在**，
 * 不断言任何日志行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { boundPort } from './_helpers/listen-ephemeral.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/daemon/runner';
import { LocalServer } from '../src/daemon/local-server';
import { CloudClient } from '../src/auth';
import { openLocalDb, runMigrations, type LocalDb } from '../src/sync/store';

const PROFILE_ID = 'prof_o15';
const AGENT_ID = 'im_agent_o15';

type Mode =
  /**
   * 我方 API 的真 404 —— 行确实没了。
   * 实回 `{ok:false, error:{code:'not_found', message:'Profile not found'}}`
   * （字节形状由 `src/im/tests/acp-agent-profile-ownership-404.test.ts` 打真 cloud 取回）。
   */
  | 'our-envelope-404'
  /**
   * 我方 API 的 404，但原因是**归属换人**（workspace 转移 / 换账号）：profile 行
   * 还在，只是不再属于调用方。路由的 where 带 `workspace.ownerImUserId`，所以这条
   * 与上面那条在状态码和 message 上完全同形，只有 `error.code` 不同。
   */
  | 'owner-changed-404'
  /** 反代 / captive portal 的 HTML 404。 */
  | 'html-404'
  /** 一个 JSON 但不是我方信封（例如中间层的 `{}`）。 */
  | 'foreign-json-404'
  /** 版本漂移：老 cloud 回的裸字符串 error（无 code）。 */
  | 'legacy-string-404'
  /** 正常返回 profile。 */
  | 'found';

interface FakeCloud {
  baseUrl: string;
  mode: Mode;
  /** Every URL the daemon asked for, in order. */
  urls: string[];
  /** How many times the profile route itself was read. */
  profileReads(): number;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function makeFakeCloud(): FakeCloud {
  let server: Server | null = null;
  const urls: string[] = [];
  const state: FakeCloud & { port: number } = {
    // Filled in by listen() from the socket the kernel actually bound.
    port: 0,
    baseUrl: '',
    mode: 'our-envelope-404',
    urls,
    profileReads: () => urls.filter((u) => u.includes(`/agent_profiles/${PROFILE_ID}`)).length,
    async listen() {
      server = createServer((req, res) => {
        urls.push(req.url ?? '');
        // The happy path also resolves the owning agent through a DIFFERENT
        // route; answer it plausibly so the 200 case doesn't degrade on noise.
        if (!(req.url ?? '').includes('/agent_profiles/')) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: [] }));
          return;
        }
        if (state.mode === 'found') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              ok: true,
              data: {
                id: PROFILE_ID,
                workspaceId: 'ws_o15',
                agentImUserId: AGENT_ID,
                adapterName: 'hermes',
                name: 'o15',
                config: {},
                version: 3,
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        if (state.mode === 'html-404') {
          // Byte-for-byte the shape nginx serves.
          res.setHeader('content-type', 'text/html');
          res.end('<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n');
          return;
        }
        res.setHeader('content-type', 'application/json');
        if (state.mode === 'foreign-json-404') {
          res.end('{}');
          return;
        }
        if (state.mode === 'legacy-string-404') {
          // Pre-fix cloud (and any un-upgraded deployment): no discriminating code.
          res.end(JSON.stringify({ ok: false, error: 'Profile not found' }));
          return;
        }
        if (state.mode === 'owner-changed-404') {
          res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'Profile not found' } }));
          return;
        }
        // our-envelope-404 — what src/im/api/agent-profiles.ts really answers.
        res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'Profile not found' } }));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        // Ephemeral on the first bind (O16-b): the kernel picks the port and we
        // read the real one back. Re-listen (断云 → 复联) reuses that same port
        // so the client stays pointed at a live origin.
        server!.listen(state.port, '127.0.0.1', () => {
          state.port = boundPort(server);
          state.baseUrl = `http://127.0.0.1:${state.port}`;
          resolve();
        });
      });
    },
    async close() {
      if (!server) return;
      const s = server;
      server = null;
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
  return state;
}

interface Rig {
  dir: string;
  db: LocalDb;
  cloud: FakeCloud;
  runner: any;
  /** Every WS envelope the daemon actually put on the wire, in order. */
  wsSent: Array<{ type: string }>;
  /** Rows still present in local.db — the whole oracle. */
  rows(): { profiles: number; agents: number };
  /** R2 — durable quarantine stamps in local.db (`agent_profiles.quarantined_at`). */
  quarantined(): Array<{ id: string; since: number }>;
}

async function makeRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'desktop205-o15-'));
  const db = openLocalDb(join(dir, 'local.db'));
  runMigrations(db);
  db.prepare(
    `INSERT INTO agents (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
     VALUES (?, 'ws_o15', 'o15', 'hermes', '[]', 'offline', 1, ?, 0)`,
  ).run(AGENT_ID, Date.now());
  db.prepare(
    `INSERT INTO agent_profiles (id, workspace_id, agent_im_user_id, adapter_name, name, config, version, synced_at, dirty, deleted_at)
     VALUES (?, 'ws_o15', ?, 'hermes', 'o15', '{}', 1, ?, 0, NULL)`,
  ).run(PROFILE_ID, AGENT_ID, Date.now());

  const cloud = makeFakeCloud();
  await cloud.listen();

  // Runner is heavy to boot; construct WITHOUT start() and give it only the
  // collaborators the delete path touches (same pattern as
  // daemon-declare-withdraw.test.ts). Nothing on the SUT path is stubbed:
  // `syncProfileFromCloud`, `confirmProfileGoneOnCloud` and the CloudClient
  // that classifies the response are all the real thing.
  const runner = new Runner() as any;
  runner.db = db;
  runner.cloud = new CloudClient({ baseUrl: cloud.baseUrl, apiKey: 'sk-prismer-test', defaultTimeoutMs: 3_000 });
  // `list()` is what snapshotState()/healthz reads; `get()` is what the dispatch
  // path reads. Returning no adapter makes an un-gated dispatch fail FAST with
  // `adapter_unhealthy` — it still emits the reply frame, which is exactly the
  // side effect the gate is supposed to prevent.
  runner.registry = { get: () => undefined, list: () => [] };
  runner.config = { daemon_id: 'daemon-o15' };
  runner.paths = { root: dir };
  // R2 — the wire IS the oracle for "did a dispatch actually happen": the
  // daemon's only externally visible act on the dispatch path is the
  // `task.dispatch.reply` envelope it sends back to cloud.
  const wsSent: Array<{ type: string }> = [];
  runner.ws = { send: (env: { type: string }) => wsSent.push(env) };
  // Hydrate hostedAgents from the seeded rows (the `agents` map is what the
  // external-channel dispatch resolver consults).
  runner.loadAgentsFromDb();

  return {
    dir,
    db,
    cloud,
    runner,
    wsSent,
    rows() {
      return {
        profiles: (db.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get() as { n: number }).n,
        agents: (db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n,
      };
    },
    quarantined() {
      return db
        .prepare('SELECT id, quarantined_at AS since FROM agent_profiles WHERE quarantined_at IS NOT NULL')
        .all() as Array<{ id: string; since: number }>;
    },
  };
}

/**
 * R2 — run one real dispatch through `Runner.onTaskDispatch` and report only
 * SIDE EFFECTS: how many extra reads the fake cloud saw, and which WS frames
 * the daemon emitted. A blocked dispatch produces neither.
 *
 * `tamper.removeGate` deletes the gate for this run (negative control 4): the
 * predicate is replaced by "nothing is ever quarantined", which is byte-for-byte
 * the pre-R2 behaviour.
 */
async function observeDispatch(
  rig: Rig,
  tamper: { removeGate?: boolean } = {},
): Promise<{ extraProfileReads: number; wsFrames: string[] }> {
  const gate = rig.runner.quarantineBlocking;
  if (tamper.removeGate) rig.runner.quarantineBlocking = () => undefined;
  const readsBefore = rig.cloud.profileReads();
  rig.wsSent.length = 0;
  try {
    await rig.runner.onTaskDispatch({
      taskId: 'task_r2',
      agentImUserId: AGENT_ID,
      profileId: PROFILE_ID,
      capability: 'chat',
      prompt: 'hello',
    });
  } finally {
    rig.runner.quarantineBlocking = gate;
  }
  return {
    extraProfileReads: rig.cloud.profileReads() - readsBefore,
    wsFrames: rig.wsSent.map((e) => e.type),
  };
}

/** R2 — the real `/healthz` body, served by a real LocalServer on an ephemeral port. */
async function healthz(rig: Rig): Promise<Record<string, unknown>> {
  const server = new LocalServer({ port: 0, getState: () => rig.runner.snapshotState() });
  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${boundPort(server)}/healthz`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await server.stop();
  }
}

describe('desktop205 O15 — 删本地 profile 行需要正向确认，不是任何 404 都算', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    while (rigs.length) {
      const r = rigs.pop()!;
      await r.cloud.close();
      try {
        r.db.close();
      } catch {
        /* already closed */
      }
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  /** 正控 —— 别把功能修没：服务器**真的**说它没了，本地行仍然要删掉。 */
  it('我方 API 的 404（{ok:false} 信封）⇒ 删本地 profile + agent 行', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'our-envelope-404';
    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 0, agents: 0 });
  });

  /**
   * 负控 0（本轮核心）—— **归属换人**：profile 还在，只是 workspace 换了主人。
   * 这是我方 API 回的、我方信封的 404，`ok:false` 一样成立，上一版判据（只要信封
   * 对就删）会当场删光本地行。判别位只有 `error.code`。
   * 权限变化 ≠ 服务器确认它没了 ⇒ 不得删。
   */
  it('归属换人（我方信封 404 + code:forbidden）⇒ 不得删任何本地行', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'owner-changed-404';

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
  });

  /**
   * 版本漂移 —— 老 cloud 的裸字符串 404 没有 code，因此**无法**把「没了」和
   * 「不是你的」分开 ⇒ 不确认 ⇒ 保守保留。代价有界（脏 profile 留到 cloud 升级；
   * host.acked 的 tombstone 路径本来就无 owner 过滤，仍会清真删的行），反方向
   * （误删活 agent 的行）不可恢复。
   */
  it('老 cloud 的裸字符串 404（无 code）⇒ 不确认 ⇒ 不得删', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'legacy-string-404';

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
  });

  /** 负控 1 —— 非我方的 404（反代 HTML）不得删。 */
  it('反代 HTML 404 ⇒ 不得删任何本地行', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'html-404';

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
  });

  /** 负控 1b —— 是 JSON 但不是我方信封（中间层的 `{}`）同样不得删。 */
  it('非我方信封的 JSON 404（{}）⇒ 不得删', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'foreign-json-404';

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
  });

  /**
   * 负控 2 —— 真断云（关端口 ⇒ ECONNREFUSED ⇒ `status:0 / cloud_unreachable`）
   * 不得删。这条今天就成立；写下来是为了锁住它别回归（03-acceptance §3.3
   * 「profile / agents：用本地缓存，不删本地行」）。
   */
  it('断云（status:0）⇒ 不得删，且错误向上抛（不是静默吞掉）', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    await rig.cloud.close();

    await expect(rig.runner.syncProfileFromCloud(PROFILE_ID)).rejects.toThrow();

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
  });

  /**
   * 收紧的代价必须是有界的：确认探针只在 404 分支重读 profile 路由，正常路径
   * 一次都不加。（若哪天有人把确认挪到 happy path，这条会红。）
   * 注意别拿「总请求数」当判据 —— happy path 本来就会为 resolveOwnedAgent
   * 打另一条路由；判据只能是**profile 路由被读了几次**。
   */
  it('确认探针只在 404 分支发生：200 时 profile 路由只读一次，404 确认时读两次', async () => {
    const ok = await makeRig();
    rigs.push(ok);
    ok.cloud.mode = 'found';
    await ok.runner.syncProfileFromCloud(PROFILE_ID);
    expect(ok.cloud.profileReads()).toBe(1);
    expect(ok.rows()).toEqual({ profiles: 1, agents: 1 });

    const gone = await makeRig();
    rigs.push(gone);
    gone.cloud.mode = 'our-envelope-404';
    await gone.runner.syncProfileFromCloud(PROFILE_ID);
    expect(gone.cloud.profileReads()).toBe(2);
  });
});

/**
 * desktop205 R2 — 「不是你的」需要一个隔离态，而不是只保留。
 *
 * O15 收紧后，`code:'forbidden'`（归属换人）与「判不出」（反代 HTML / `{}` /
 * 断云）被压成同一个 false：两者都保留本地行，然后 daemon **照常派发**，每次被
 * cloud 拒，用户面上什么也看不到。R2 把判定拆成三值，并给 `forbidden` 一条
 * 「留行 + 停派发 + 可见 + 可自动恢复」的路径。
 *
 * ## oracle 只取副作用
 *   - 本地 DB 行 + `agent_profiles.quarantined_at` 列
 *   - daemon 真的发出去的 WS 帧 / 真的打到 fake cloud 的请求（= 有没有派发）
 *   - 真 LocalServer 的 `/healthz` 响应体
 * 一条日志断言都没有。
 */
describe('desktop205 R2 — forbidden ⇒ 隔离（留行 · 停派发 · 可见 · 可恢复）', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    while (rigs.length) {
      const r = rigs.pop()!;
      await r.cloud.close();
      try {
        r.db.close();
      } catch {
        /* already closed */
      }
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  /** 正控 —— 一条 forbidden 404 之后：行还在 ∧ 被标记 ∧ 两个派发入口都被拦 ∧ healthz 看得见。 */
  it('归属换人 ⇒ 本地行仍在 + 打上隔离戳 + 派发被拦 + healthz 可见', async () => {
    const rig = await makeRig();
    rigs.push(rig);

    // 派发在隔离之前是通的 —— 否则下面的「被拦」什么也证明不了。
    rig.cloud.mode = 'found';
    const before = await observeDispatch(rig);
    expect(before.wsFrames).toEqual(['task.dispatch.reply']);
    expect(before.extraProfileReads).toBe(1);
    expect(rig.runner.findMessageDispatchAgent(AGENT_ID)).not.toBeNull();

    rig.cloud.mode = 'owner-changed-404';
    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    // (a) 留行 —— 归属可能回来，本地状态删了不可恢复。
    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
    // (b) 隔离态是 DURABLE 的，落在列上而不是只在内存里。
    const stamps = rig.quarantined();
    expect(stamps.map((s) => s.id)).toEqual([PROFILE_ID]);
    expect(stamps[0]!.since).toBeGreaterThan(0);

    // (c) 停派发 —— cloud 端已恢复成 200 也照样拦：闸看的是本地隔离态，
    //     不是再去问一次云。两个入口都要拦。
    rig.cloud.mode = 'found';
    const after = await observeDispatch(rig);
    expect(after.wsFrames).toEqual([]);
    expect(after.extraProfileReads).toBe(0);
    expect(rig.runner.findMessageDispatchAgent(AGENT_ID)).toBeNull();

    // (d) 可见 —— 普通用户唯一的可观测面。
    const health = (await healthz(rig)) as {
      quarantinedProfiles?: Array<{ profileId: string; agentImUserId: string; workspaceId: string; name: string; since: number }>;
    };
    expect(health.quarantinedProfiles).toEqual([
      { profileId: PROFILE_ID, agentImUserId: AGENT_ID, workspaceId: 'ws_o15', name: 'o15', since: stamps[0]!.since },
    ]);
  });

  /**
   * 负控 1 —— 别把 O15 刚修好的删除能力弄没了：`code:'not_found'` 仍然删行，
   * 且不会留下任何隔离戳（删了就没有可隔离的东西）。
   */
  it('not_found 404 ⇒ 仍然删行，且不产生隔离态', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'our-envelope-404';

    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.rows()).toEqual({ profiles: 0, agents: 0 });
    expect(rig.quarantined()).toEqual([]);
    expect((await healthz(rig)).quarantinedProfiles).toBeUndefined();
  });

  /**
   * 负控 2（最容易做错的一条）—— 「判不出」不是「不是你的」。反代 HTML 404 /
   * 中间层 `{}` / 老 cloud 裸字符串 / 断云，都只说明我们**什么也没学到**。
   * 在这些情况下隔离，等于每次反代打嗝就把一个健康 agent 静音。
   */
  for (const mode of ['html-404', 'foreign-json-404', 'legacy-string-404'] as const) {
    it(`判不出的 404（${mode}）⇒ 既不删、也不隔离、也不停派发`, async () => {
      const rig = await makeRig();
      rigs.push(rig);
      rig.cloud.mode = mode;

      await rig.runner.syncProfileFromCloud(PROFILE_ID);

      expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
      expect(rig.quarantined()).toEqual([]);
      expect((await healthz(rig)).quarantinedProfiles).toBeUndefined();

      rig.cloud.mode = 'found';
      expect((await observeDispatch(rig)).wsFrames).toEqual(['task.dispatch.reply']);
      expect(rig.runner.findMessageDispatchAgent(AGENT_ID)).not.toBeNull();
    });
  }

  it('断云（status:0）⇒ 既不删、也不隔离', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    await rig.cloud.close();

    await expect(rig.runner.syncProfileFromCloud(PROFILE_ID)).rejects.toThrow();

    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
    expect(rig.quarantined()).toEqual([]);
    expect((await healthz(rig)).quarantinedProfiles).toBeUndefined();
  });

  /**
   * 负控 3 —— 恢复路径。归属换回来（下次 sync 拿到 200）必须**自动**解除隔离：
   * 一个只会单向进入的状态位，等于把 agent 永久毁掉。
   */
  it('隔离后 cloud 恢复 200 ⇒ 隔离自动解除、派发恢复、healthz 字段消失', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'owner-changed-404';
    await rig.runner.syncProfileFromCloud(PROFILE_ID);
    expect(rig.quarantined().map((s) => s.id)).toEqual([PROFILE_ID]);

    rig.cloud.mode = 'found';
    await rig.runner.syncProfileFromCloud(PROFILE_ID);

    expect(rig.quarantined()).toEqual([]);
    expect(rig.rows()).toEqual({ profiles: 1, agents: 1 });
    expect((await healthz(rig)).quarantinedProfiles).toBeUndefined();
    expect((await observeDispatch(rig)).wsFrames).toEqual(['task.dispatch.reply']);
    expect(rig.runner.findMessageDispatchAgent(AGENT_ID)).not.toBeNull();
  });

  /**
   * 负控 4 —— 把派发闸摘掉，正控里「派发被拦」那条必须转红。
   *
   * 同一条 journey、同一个 oracle，只把 `quarantineBlocking` 换成「永远不拦」
   * （= R2 之前的行为）。若隔离态其实没有真的挡住任何东西，这条会和正控一样绿，
   * 那才是开卷考试。
   */
  it('摘掉派发闸 ⇒ 同一隔离状态下派发照样发出（证明正控那条断言是承重的）', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.mode = 'owner-changed-404';
    await rig.runner.syncProfileFromCloud(PROFILE_ID);
    expect(rig.quarantined().map((s) => s.id)).toEqual([PROFILE_ID]);

    rig.cloud.mode = 'found';
    // 闸在 ⇒ 拦住（正控那条）
    expect((await observeDispatch(rig)).wsFrames).toEqual([]);
    // 闸摘掉 ⇒ 同样的隔离态下，dispatch 真的发出去了
    const tampered = await observeDispatch(rig, { removeGate: true });
    expect(tampered.wsFrames).toEqual(['task.dispatch.reply']);
    expect(tampered.extraProfileReads).toBe(1);
  });
});
