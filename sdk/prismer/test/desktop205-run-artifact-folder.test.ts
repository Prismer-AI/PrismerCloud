/**
 * desktop205 R1 — 不 bind sourceTaskId 的产物必须仍有「可定位的归属」。
 *
 * ## 缺陷
 * `deliverFile` 对 hermes 聊天 run id（`session:…`，>30 字符）正确地**不**写
 * `sourceTaskId`（cloud 列是 VarChar(30)，硬塞会 500 且绑到不存在的看板卡）。
 * 但它连 `folderPath` 也一起置空了 —— 于是资产落进 workspace 资产库后
 * `sourceTaskId` 与 `folderPath` **双空**，只剩 `metadata.runId` 这个纯观测位。
 * 原注释辩称「资产仍会经 reply.assetIds / 独立消息浮现」，那只在**在线**路径成立：
 * desktop205 O14 的离线入队路径上 `deliverFile` 在任何 reply/消息发生**之前**就
 * 返回 `queued`（`send` 更是直接 502），那条 reply 永远不会发生。
 *
 * 修复：不 bind 时 `folderPath = /runs/<runId>`（与 `/tasks/<id>` 同构；
 * folderPath 是 VarChar(700)，装得下 `session:…`）。
 *
 * ## 为什么不 mock
 * 沿用 `desktop205-task-artifact-outbox.test.ts` 的形状：真 `http.Server` +
 * 真 `fetch` + 真 `better-sqlite3` outbox + 真文件系统。断云 = 真的关掉监听
 * socket（真 ECONNREFUSED）。SUT（attachDeliver / deliverFile / AgentGenAdapter /
 * OriginOutbox / UploadRunner / DaemonAssetUploadClient）一行都没有被替身。
 *
 * ## oracle 只取副作用
 * 断言全部取自**真 http server 真收到的 multipart 字段**（folderPath /
 * sourceTaskId / metadata）与 outbox 的真 sqlite 计数。不断言任何日志行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { boundPort } from './_helpers/listen-ephemeral.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginOutbox } from '../src/daemon/asset/origin/outbox.js';
import { AgentGenAdapter } from '../src/daemon/asset/origin/agent-gen.js';
import { DaemonAssetUploadClient, UploadRunner } from '../src/daemon/asset/origin/upload-runner.js';
import type { OriginAdapter } from '../src/daemon/asset/origin/spi.js';
import { ArtifactsWatcher } from '../src/daemon/artifacts-watcher.js';
import { attachDeliver } from '../src/daemon/asset/deliver.js';
import { openLocalDb } from '../src/sync/store.js';
import { RunSessionRegistry, setRunSessionRegistry } from '../src/daemon/memory/run-session-map.js';
import { HermesSessionMapper } from '../src/adapters/persistence/hermes/sessions-mapper.js';
import { handleDispatch } from '../src/daemon/dispatch.js';
import type { AdapterDef } from '../src/adapters/contract.js';

const WS = 'ws_r1';
/** 真看板 task id 的形状：≤30 字符、无 session:/run_ 前缀 ⇒ deliver 会 bind。 */
const KANBAN_TASK = 'cmp7k2x9q0001abcd';
/** hermes 聊天 run id 的形状：`session:` 前缀且 >30 字符 ⇒ deliver 不 bind。 */
const CHAT_RUN = 'session:01j8zq7k3m4n5p6q7r8s9t0uvw';
/** hermes /v1/runs 铸的本地 run id —— 前端永远看不到它。 */
const HERMES_RUN = 'run_9f3c1d2e-7a41-4b8c-9d5e-0123456789ab';
/** cloud dispatch id（cuid 形状）—— 前端手里就是这个（message.metadata.taskId）。 */
const CLOUD_DISPATCH = 'cmq5r8t1v0002wxyz';
const AGENT_IM_USER = 'imu_ceo_r1c';
const CONV = 'cnv_r1c_0001';

interface ReceivedUpload {
  filename: string;
  /** The assetId this stub answered with (equal across a dedup hit). */
  assetId: string;
  field(name: string): string | null;
}

interface FakeCloud {
  baseUrl: string;
  received: ReceivedUpload[];
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Cloud stub speaking just enough of the asset-upload protocol.
 *  `direct-upload/init` answers 404 so the client falls back to the multipart
 *  `POST /api/im/assets` branch — the branch the real daemon takes with no S3 plan.
 *
 *  `opts.dedup` (R1-e/B) mirrors the REAL `POST /api/im/assets` dedup rule
 *  verbatim (src/im/api/assets.ts `existingWhere`, non-drop-folder branch):
 *  same `(workspaceId, contentHash[, sourceTaskId ?? metadata.taskId])` ⇒ the
 *  EXISTING row is returned, i.e. the SAME assetId comes back for a re-upload.
 *  Off by default so the pre-existing cases keep their 1-call-1-id shape. */
function makeFakeCloud(opts?: { dedup?: boolean }): FakeCloud {
  const received: ReceivedUpload[] = [];
  const byDedupKey = new Map<string, string>();
  let server: Server | null = null;
  const state: FakeCloud & { port: number } = {
    port: 0,
    baseUrl: '',
    received,
    async listen() {
      server = createServer((req, res) => void handle(req, res));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        // O16-b: ephemeral on first bind — kernel picks the port, we read the
        // real one back. Re-listen (断云 → 复联) reuses it so the client stays
        // pointed at a live origin.
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

  async function handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = req.url ?? '';
    if (url.startsWith('/api/im/assets/direct-upload/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'direct upload unavailable' }));
      return;
    }
    if (url.startsWith('/api/im/assets')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      const field = (name: string): string | null => multipartField(raw, name);
      let assetId = `ast_${received.length + 1}`;
      if (opts?.dedup) {
        // Same tuple the cloud handler narrows on. `sourceTaskId` falls back to
        // `metadata.taskId` exactly like `dedupTaskScope` does server-side.
        let metaTaskId: string | null = null;
        try {
          const meta = JSON.parse(field('metadata') ?? '{}') as { taskId?: unknown };
          metaTaskId = typeof meta.taskId === 'string' ? meta.taskId : null;
        } catch {
          /* metadata absent */
        }
        const key = [field('workspaceId') ?? '', field('contentSha256') ?? '', field('sourceTaskId') ?? metaTaskId ?? ''].join('|');
        const hit = byDedupKey.get(key);
        if (hit) assetId = hit;
        else byDedupKey.set(key, assetId);
      }
      received.push({
        filename: raw.toString('latin1').match(/filename="([^"]+)"/)?.[1] ?? '',
        assetId,
        field,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { id: assetId, contentHash: 'sha256:stub' } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, data: { id: 'msg_1' } }));
  }

  return state;
}

/** Read one non-file multipart field value out of the raw body. */
function multipartField(raw: Buffer, name: string): string | null {
  const text = raw.toString('latin1');
  const idx = text.indexOf(`name="${name}"`);
  if (idx === -1) return null;
  const rest = text.slice(idx);
  const m = /\r\n\r\n([\s\S]*?)\r\n--/.exec(rest);
  return m?.[1] ?? null;
}

/**
 * `folderPath` 会被 cloud 的 `canonicalizeFolderPath`（src/im/api/assets.ts）
 * 过一道：按 '/' 切、trim、丢空段、重新加前导 '/'。对已规范的路径它是幂等的。
 * 这里断言 daemon 发出的值**本来就规范**，否则 cloud 落库的字节与我们以为发出去
 * 的不一致（历史上「文件夹显示为空」正是这么来的）。
 */
function expectCanonical(folderPath: string | null): void {
  expect(folderPath).not.toBeNull();
  const segs = folderPath!.split('/');
  expect(segs[0]).toBe('');
  expect(segs.slice(1).every((s) => s.length > 0 && s === s.trim())).toBe(true);
}

/**
 * 一台假 hermes 网关，只答 `POST /api/sessions`。用它是为了让**真**的
 * `HermesSessionMapper.createForConversation` 去写那行合成行（run_id =
 * `session:<id>`、task_id = NULL），而不是我手搓一行 SQL 冒充它。
 */
async function makeFakeHermes(): Promise<{ baseUrl: string; sessionId: string; close(): Promise<void> }> {
  const sessionId = 'api_1784048863_613bf0ec';
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/sessions')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'session', session: { id: sessionId } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  // 端口一律 listen(0) + 回读（O16-b）。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    baseUrl: `http://127.0.0.1:${boundPort(server)}`,
    sessionId,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Rig {
  dir: string;
  outbox: OriginOutbox;
  cloud: FakeCloud;
  /** 真 local.db —— RunSessionRegistry 与 HermesSessionMapper 共用的那张表。 */
  db: ReturnType<typeof openLocalDb>;
  registry: RunSessionRegistry;
  /** R1-d — 真 ArtifactsWatcher，同一个实例同时喂 deliver sink 与 handleDispatch。 */
  watcher: ArtifactsWatcher;
  /** R1-d — handleDispatch 的 deps.cloud（`get` + `request`）。 */
  cloudClient: any;
  deliver(body: unknown): Promise<{ status: number; body: any }>;
  drain(): Promise<number>;
  writeArtifact(runOrTaskId: string, name: string, contents: string): string;
}

async function makeRig(opts?: { dedup?: boolean }): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'desktop205-r1-'));

  const cloud = makeFakeCloud(opts);
  await cloud.listen();

  const outbox = new OriginOutbox({ dbPath: join(dir, 'asset-origin.db') });

  const cloudClient: any = {
    apiKey: 'sk-prismer-test',
    baseUrl: cloud.baseUrl,
    async request() {
      return { ok: true, status: 200, data: {} };
    },
    // R1-d — handleDispatch 的读路径（profile / skills / memory / goals）。
    // 只答 dispatch 真会问的那几条；其余返回空，让被测路径保持在「一条正常的
    // hermes 聊天 dispatch」上，而不是被无关的 404 打断。
    async get(path: string) {
      if (path.startsWith('/api/im/agent_profiles/')) {
        return {
          id: 'profile-r1d',
          workspaceId: WS,
          agentImUserId: AGENT_IM_USER,
          adapterName: 'hermes',
          name: 'Hermes',
          config: { systemPrompt: 'You are Hermes.' },
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      if (path.startsWith('/api/im/memory/digest')) return { digest: '', filesSummarized: 0, filesTotal: 0, totalBytes: 0 };
      if (path.startsWith('/api/im/tasks?')) return [];
      if (path.startsWith('/api/im/skills/installed')) return [];
      return {};
    },
  };

  const watcher = new ArtifactsWatcher({
    cloud: cloudClient,
    containerId: 'c-r1',
    workspaceId: () => WS,
    autoScan: false,
    log: { info: () => {}, warn: () => {} },
    assetOutbox: () => outbox,
  });

  // Exactly the wiring runner.ts::ensureDropFolderRuntime builds.
  const runner = new UploadRunner({
    outbox,
    cloud: new DaemonAssetUploadClient({
      cloudApiBase: cloud.baseUrl,
      apiKey: 'sk-prismer-test',
      timeoutMs: 2_000,
    }),
    adapters: { 'agent-gen': new AgentGenAdapter() as OriginAdapter },
    maxAttempts: 3,
  });

  const sink = attachDeliver({ watcher, cloud: cloudClient });

  // 真 local.db + 真 RunSessionRegistry，挂上 deliver 读的那个模块级 singleton
  // （`getRunSessionRegistry()`）——auto-resolve 分支走的是真实现，没有替身。
  const db = openLocalDb(join(dir, 'local.db'));
  const registry = new RunSessionRegistry(db);
  setRunSessionRegistry(registry);

  return {
    dir,
    outbox,
    cloud,
    db,
    registry,
    watcher,
    cloudClient,
    deliver: (body) => sink(body) as Promise<{ status: number; body: any }>,
    drain: () => runner.drainOnce(),
    writeArtifact(runOrTaskId, name, contents) {
      const artifactsDir = join(dir, 'workspaces', WS, 'runs', encodeURIComponent(runOrTaskId), 'artifacts');
      mkdirSync(artifactsDir, { recursive: true });
      const full = join(artifactsDir, name);
      writeFileSync(full, contents);
      return full;
    },
  };
}

const HERMES_ADAPTER: AdapterDef = {
  name: 'hermes',
  kind: 'long-running',
  capabilities: [],
  workspaceSchema: {} as any,
  validate: () => ({ ok: true }),
  health: async () => ({ available: true }),
};

/**
 * 跑一次真 dispatch。`duringRun` 在 adapter 的 `dispatch()` 内部执行 ——
 * 那正是 agent 在飞时 shell 出 `cloud deliver` 的时刻（`addActiveTask`
 * 之后、`flushPending` 之前）。
 */
async function runDispatch(
  rig: Rig,
  opts: {
    taskId: string;
    kind: 'run' | 'task';
    conversationId?: string;
    duringRun: () => Promise<void>;
  },
): Promise<any> {
  const root = join(rig.dir, 'daemon-home');
  return handleDispatch(
    {
      taskId: opts.taskId,
      agentImUserId: AGENT_IM_USER,
      profileId: 'profile-r1d',
      capability: 'code',
      prompt: 'write a file and deliver it',
      kind: opts.kind,
      ...(opts.kind === 'run' ? { runId: opts.taskId } : {}),
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    } as any,
    'req-r1d',
    {
      registry: { get: () => HERMES_ADAPTER } as any,
      cloud: rig.cloudClient,
      uriResolver: {
        rewrite: async (text: string) => ({ text, resolvedHashes: [] }),
        rewriteAll: async (texts: string[]) => ({ texts, resolvedHashes: [] }),
      } as any,
      assetCache: { unpin: () => {}, pin: () => {} } as any,
      ws: { send: () => {} } as any,
      artifactsWatcher: rig.watcher,
      ensureService: async () => ({
        id: 'svc',
        healthy: async () => true,
        async dispatch() {
          await opts.duringRun();
          return { ok: true, output: 'done' };
        },
      }),
      paths: {
        root,
        configFile: join(root, 'config.toml'),
        localDb: join(root, 'local.db'),
        cacheDir: join(root, 'cache'),
        logsDir: join(root, 'logs'),
        runsDir: join(root, 'runs'),
        workspacesDir: join(root, 'workspaces'),
        devicesDir: join(root, 'devices'),
      },
    } as any,
  );
}

/**
 * R1-e/A 的 oracle：`pendingByTask` 的**真实**桶。私有字段是故意的 —— 这条缺陷
 * 的现象就是「桶存在但没人读」，只断言 `flushPending` 看不出「桶被建过」与
 * 「桶从没建过」的区别（两者都返回 []）。
 */
function pendingBuckets(watcher: ArtifactsWatcher): Map<string, string[]> {
  return (watcher as unknown as { pendingByTask: Map<string, string[]> }).pendingByTask;
}

describe('desktop205 R1 — 不 bind 的产物用 /runs/<runId> 落定归属', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    while (rigs.length) {
      const r = rigs.pop()!;
      await r.cloud.close();
      try {
        r.outbox.close();
      } catch {
        /* already closed */
      }
      setRunSessionRegistry(null);
      try {
        (r.db as unknown as { close(): void }).close();
      } catch {
        /* already closed */
      }
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  /**
   * 正控 A（在线） —— 聊天 run 的交付：cloud 真收到的 payload 里 folderPath
   * 非空且形状正确。
   */
  it('在线：聊天 run 的产物带 folderPath=/runs/<runId>', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(CHAT_RUN, 'chat-out.md', '# from a chat run\n');

    const res = await rig.deliver({ taskId: CHAT_RUN, path: filePath, mode: 'attach' });
    expect(res.status).toBe(200);

    expect(rig.cloud.received.length).toBe(1);
    const got = rig.cloud.received[0]!;
    expect(got.filename).toBe('chat-out.md');
    expect(got.field('folderPath')).toBe(`/runs/${CHAT_RUN}`);
    expectCanonical(got.field('folderPath'));
  });

  /**
   * 正控 B（离线入队 → 复联补传）—— 这条才是缺陷的动机路径：离线时 reply/消息
   * 结构上不会发生，folderPath 是资产**唯一**的锚。
   *
   * 注入的故障是真的：`cloud.close()` 关掉监听 socket ⇒ 真 ECONNREFUSED。
   */
  it('离线入队后复联补传：folderPath=/runs/<runId> 一路带到 cloud', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(CHAT_RUN, 'offline-out.md', '# queued from a chat run\n');

    // ── 断云 ──
    await rig.cloud.close();
    const res = await rig.deliver({ taskId: CHAT_RUN, path: filePath, mode: 'attach' });
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(rig.outbox.pendingCount()).toBe(1);
    // 反向断言：断云确实注入进去了，cloud 一个字节没收到。
    expect(rig.cloud.received.length).toBe(0);

    // ── 复联 ──
    await rig.cloud.listen();
    await rig.drain();

    expect(rig.cloud.received.length).toBe(1);
    const got = rig.cloud.received[0]!;
    expect(got.filename).toBe('offline-out.md');
    expect(got.field('folderPath')).toBe(`/runs/${CHAT_RUN}`);
    expectCanonical(got.field('folderPath'));
    expect(rig.outbox.pendingCount()).toBe(0);
    expect(rig.outbox.deadLetterCount()).toBe(0);
  });

  /**
   * 负控 1 —— 既有行为不许改坏：真看板 task 仍然 `/tasks/<id>` + 绑 sourceTaskId。
   * 同步路径与 outbox 补传路径都要成立（两条路径各自拼 payload）。
   */
  it('负控 1（在线）：真看板 task 仍是 /tasks/<id> + sourceTaskId', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(KANBAN_TASK, 'deliverable.md', '# kanban\n');

    const res = await rig.deliver({ taskId: KANBAN_TASK, path: filePath, mode: 'task-attach' });
    expect(res.status).toBe(200);

    const got = rig.cloud.received[0]!;
    expect(got.field('folderPath')).toBe(`/tasks/${KANBAN_TASK}`);
    expect(got.field('sourceTaskId')).toBe(KANBAN_TASK);
    expect(JSON.parse(got.field('metadata')!).taskId).toBe(KANBAN_TASK);
  });

  it('负控 1（复联补传）：真看板 task 仍是 /tasks/<id> + sourceTaskId', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(KANBAN_TASK, 'deliverable.md', '# kanban offline\n');

    await rig.cloud.close();
    expect((await rig.deliver({ taskId: KANBAN_TASK, path: filePath, mode: 'task-attach' })).status).toBe(202);
    await rig.cloud.listen();
    await rig.drain();

    const got = rig.cloud.received[0]!;
    expect(got.field('folderPath')).toBe(`/tasks/${KANBAN_TASK}`);
    expect(got.field('sourceTaskId')).toBe(KANBAN_TASK);
  });

  /**
   * 负控 3 —— 修 folderPath 不得把 500 的成因复活。聊天 run 的 payload 里
   * `sourceTaskId` 必须**仍然缺席**，且 `metadata.taskId` 也必须缺席
   * （cloud `POST /assets` 会从 metadata.taskId 反推 sourceTaskId，
   *   DaemonAssetUploadClient.uploadMultipart 同样会 —— 两处都得堵）。
   */
  it('负控 3（在线）：聊天 run 不得出现 sourceTaskId / metadata.taskId', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(CHAT_RUN, 'chat-out.md', '# no binding\n');

    await rig.deliver({ taskId: CHAT_RUN, path: filePath, mode: 'attach' });

    const got = rig.cloud.received[0]!;
    expect(got.field('sourceTaskId')).toBeNull();
    const meta = JSON.parse(got.field('metadata')!);
    expect(meta.taskId).toBeUndefined();
    expect(meta.runId).toBe(CHAT_RUN);
  });

  it('负控 3（复联补传）：聊天 run 不得出现 sourceTaskId / metadata.taskId', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact(CHAT_RUN, 'offline-out.md', '# no binding offline\n');

    await rig.cloud.close();
    expect((await rig.deliver({ taskId: CHAT_RUN, path: filePath, mode: 'attach' })).status).toBe(202);
    await rig.cloud.listen();
    await rig.drain();

    const got = rig.cloud.received[0]!;
    expect(got.field('sourceTaskId')).toBeNull();
    expect(JSON.parse(got.field('metadata')!).taskId).toBeUndefined();
  });

  /**
   * 归属是**可下钻**的，不是一个大杂烩：两个不同的 run 落两个不同的文件夹，
   * 且都在 `/runs/` 前缀下（cloud `GET /assets?folderPathPrefix=/runs/` 的下钻面）。
   */
  it('不同 run 落不同文件夹，且共享 /runs/ 前缀', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const other = 'session:01j8zq7k3m4n5p6q7r8s9t0zzz';
    await rig.deliver({ taskId: CHAT_RUN, path: rig.writeArtifact(CHAT_RUN, 'a.md', 'a\n'), mode: 'attach' });
    await rig.deliver({ taskId: other, path: rig.writeArtifact(other, 'b.md', 'b\n'), mode: 'attach' });

    const folders = rig.cloud.received.map((r) => r.field('folderPath'));
    expect(folders).toEqual([`/runs/${CHAT_RUN}`, `/runs/${other}`]);
    expect(new Set(folders).size).toBe(2);
    expect(folders.every((f) => f!.startsWith('/runs/'))).toBe(true);
  });

  /**
   * ## R1-c —— `/runs/<key>` 的 key 必须是**前端解析得出**的那个 id
   *
   * R1 用的是 `hit.runId`：那是 daemon/hermes 本地铸的 id
   * （`run_<uuid>` / `session:<id>` / `psession:<adapter>:<id>`）。前端手上只有
   * cloud dispatch id（`message.metadata.taskId` ← src/im/ws/handler.ts），而
   * cloud 侧**没有**任何 hermesRunId ↔ cloud id 的持久映射（`im_task_runs` 无对应
   * 列；资产上的 `metadata.runId` 无人消费）。⇒ 资产落进 `/runs/<本地 id>`，
   * 深链只能拼出 `/runs/<cloud dispatch id>`，指向一个永不存在的目录。
   *
   * 修法只动 folder 的 key：`hit.taskId`（= 注册时写入的 `task.taskId`，就是
   * cloud dispatch id）优先，为空回退 `hit.runId`。`taskId` 变量本身不动 ——
   * 它还喂着 `bindSourceTask` / `metadata` / `recordDeliveredAsset`。
   */
  describe('R1-c — /runs/ 的 key 用 cloud dispatch id', () => {
    /** 走 auto-resolve 分支（hermes 无 per-dispatch env）：body 不带 taskId。 */
    const autoResolveBody = (filePath: string) => ({
      path: filePath,
      mode: 'attach' as const,
      resolveActiveDispatch: true,
      agentImUserId: AGENT_IM_USER,
    });

    /** 真 registry 写入一行「有 cloud dispatch id」的在飞 run（hermes 适配器的形状）。 */
    function registerLiveRun(rig: Rig): void {
      rig.registry.register({
        runId: HERMES_RUN,
        conversationId: CONV,
        taskId: CLOUD_DISPATCH,
        agentImUserId: AGENT_IM_USER,
        workspaceId: WS,
        profileName: 'ceo',
        roleTemplateSlug: null,
        adapterName: 'hermes',
      });
    }

    /**
     * 正控 1（在线）—— 有 cloud dispatch id ⇒ folderPath = /runs/<cloud dispatch id>。
     * 同时钉死它**不是**本地 run id：那正是缺陷的形状。
     */
    it('正控 1（在线）：有 cloud dispatch id ⇒ /runs/<cloud dispatch id>', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      registerLiveRun(rig);
      const filePath = rig.writeArtifact(HERMES_RUN, 'auto-out.md', '# auto-resolved\n');

      const res = await rig.deliver(autoResolveBody(filePath));
      expect(res.status).toBe(200);
      // auto-resolve 确实发生了（否则这条用例测的是别的东西）。
      expect(res.body.ok).toBe(true);

      expect(rig.cloud.received.length).toBe(1);
      const got = rig.cloud.received[0]!;
      expect(got.field('folderPath')).toBe(`/runs/${CLOUD_DISPATCH}`);
      expect(got.field('folderPath')).not.toBe(`/runs/${HERMES_RUN}`);
      expectCanonical(got.field('folderPath'));
    });

    /**
     * 正控 1（离线入队 → 复联补传）—— outbox 那条路径自己拼 payload，
     * 换 key 必须一路带过去。
     */
    it('正控 1（复联补传）：/runs/<cloud dispatch id> 一路带到 cloud', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      registerLiveRun(rig);
      const filePath = rig.writeArtifact(HERMES_RUN, 'auto-offline.md', '# queued\n');

      await rig.cloud.close();
      const res = await rig.deliver(autoResolveBody(filePath));
      expect(res.status).toBe(202);
      expect(rig.outbox.pendingCount()).toBe(1);
      expect(rig.cloud.received.length).toBe(0);

      await rig.cloud.listen();
      await rig.drain();

      const got = rig.cloud.received[0]!;
      expect(got.filename).toBe('auto-offline.md');
      expect(got.field('folderPath')).toBe(`/runs/${CLOUD_DISPATCH}`);
      expect(rig.outbox.deadLetterCount()).toBe(0);
    });

    /**
     * 正控 2 —— 合成行（`HermesSessionMapper.persist` 写的 `session:<id>` 行，
     * `task_id` 是 **NULL**）没有 cloud dispatch id，只能回退 runId。
     * 这里用**真** mapper 打一台假 hermes 建出那行，不手搓 SQL 冒充。
     *
     * 最容易做错的地方：`/runs/null` 或 `/runs/undefined`。显式钉死。
     */
    it('正控 2（合成行 task_id=NULL）：回退 /runs/<runId>，不得是 /runs/null', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const hermes = await makeFakeHermes();
      try {
        const mapper = new HermesSessionMapper(rig.db);
        const row = await mapper.createForConversation(
          hermes.baseUrl,
          'hermes-key',
          CONV,
          AGENT_IM_USER,
          'ceo',
          WS,
        );
        expect(row.hermesSessionId).toBe(hermes.sessionId);

        // 前置条件取自 DB 原始行：这行的 task_id 真的是 NULL（否则这条用例
        // 测的不是回退分支）。
        const syntheticRunId = `session:${hermes.sessionId}`;
        const raw = rig.db
          .prepare('SELECT run_id, task_id FROM local_run_sessions WHERE run_id = ?')
          .get(syntheticRunId) as { run_id: string; task_id: string | null } | undefined;
        expect(raw?.run_id).toBe(syntheticRunId);
        expect(raw?.task_id).toBeNull();

        const filePath = rig.writeArtifact(syntheticRunId, 'synthetic-out.md', '# synthetic\n');
        const res = await rig.deliver(autoResolveBody(filePath));
        expect(res.status).toBe(200);

        const got = rig.cloud.received[0]!;
        expect(got.field('folderPath')).toBe(`/runs/${syntheticRunId}`);
        expect(got.field('folderPath')).not.toBe('/runs/null');
        expect(got.field('folderPath')).not.toBe('/runs/undefined');
        expect(got.field('folderPath')).not.toBe('/runs/');
        expectCanonical(got.field('folderPath'));
      } finally {
        await hermes.close();
      }
    });

    /**
     * 负控 2 —— 换 key 不得把 500 的成因复活。cloud dispatch id 是 cuid 形状
     * （≤30、无前缀），若不小心把它灌进 `taskId` 变量，`bindSourceTask` 的形状
     * 闸会翻成 true，`sourceTaskId` / `metadata.taskId` 就会双双复活并绑到一张
     * 不存在的看板卡。两处都必须**仍然缺席**。
     */
    it('负控 2：auto-resolve 的 payload 里 sourceTaskId / metadata.taskId 仍缺席', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      registerLiveRun(rig);
      const filePath = rig.writeArtifact(HERMES_RUN, 'auto-out.md', '# no binding\n');

      await rig.deliver(autoResolveBody(filePath));

      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBeNull();
      const meta = JSON.parse(got.field('metadata')!);
      expect(meta.taskId).toBeUndefined();
      // 观测位仍是本地 run id（metadata.runId 的语义没被换掉）。
      expect(meta.runId).toBe(HERMES_RUN);
    });
  });

  /**
   * ## R1-d —— `reply.assetIds` 的 key 必须是 dispatch 真会 flush 的那个
   *
   * `pendingByTask` 在别处**一律**按 cloud dispatch id 立键：dispatch.ts 用
   * `addActiveTask({ taskId })` 注册、用 `flushPending(taskId)` 抽干（两处都是
   * `payload.taskId`），watcher 的 auto-scan 也把上传记在同一个 `task.taskId`
   * 下。只有 deliver 的 auto-resolve 分支立的是 `hit.runId`（daemon/hermes 本地
   * id）—— 于是 hermes 的 `cloud deliver --mode attach` 落进一个
   * `flushPending` 永远不读的桶，资产**永远上不了 `reply.assetIds`**。
   *
   * ### 为什么必须打到 handleDispatch
   * 只断言 `flushPending(cloudDispatchId)` 仍是在测中间态。这里跑**真**
   * `handleDispatch`：真 profile 解析 → 真 artifactsDir provision → 真
   * `addActiveTask` → adapter 的 `dispatch()` 里（= agent 在飞时）打真的
   * deliver sink → 真 `scanNow()` + `flushPending` → 断言取**真 reply payload**
   * 的 `assetIds` 字段。没有一处日志断言。
   */
  describe('R1-d — reply.assetIds 的 key 用 cloud dispatch id', () => {
    const autoResolveBody = (filePath: string, agentImUserId = AGENT_IM_USER) => ({
      path: filePath,
      mode: 'attach' as const,
      resolveActiveDispatch: true,
      agentImUserId,
    });

    /**
     * 正控 —— hermes auto-resolve + mode:'attach'：资产真的出现在
     * `reply.assetIds` 上。这条在修复前是空的（缺陷本体）。
     */
    it('正控：hermes auto-resolve 的 attach 资产出现在真 reply.assetIds 上', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      rig.registry.register({
        runId: HERMES_RUN,
        conversationId: CONV,
        taskId: CLOUD_DISPATCH,
        agentImUserId: AGENT_IM_USER,
        workspaceId: WS,
        profileName: 'ceo',
        roleTemplateSlug: null,
        adapterName: 'hermes',
      });
      const filePath = rig.writeArtifact(HERMES_RUN, 'reply-rider.md', '# rides the reply\n');

      let delivered: any;
      const reply = await runDispatch(rig, {
        taskId: CLOUD_DISPATCH,
        kind: 'run',
        conversationId: CONV,
        duringRun: async () => {
          delivered = await rig.deliver(autoResolveBody(filePath));
        },
      });

      // 前置条件：deliver 真的走通了 auto-resolve 分支（否则这条测的是别的）。
      expect(delivered.status).toBe(200);
      expect(delivered.body.assetId).toBe('ast_1');

      // ── oracle：真 reply payload 的 assetIds 字段 ──
      expect(reply.ok).toBe(true);
      expect(reply.taskId).toBe(CLOUD_DISPATCH);
      expect(reply.assetIds).toEqual(['ast_1']);

      // 负控 4 同一发：500 的成因不得复活（同一次真上传的 payload）。
      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBeNull();
      expect(JSON.parse(got.field('metadata')!).taskId).toBeUndefined();
      // R1-c 的锚点没被这次改动带歪。
      expect(got.field('folderPath')).toBe(`/runs/${CLOUD_DISPATCH}`);
    });

    /**
     * 负控 1 —— 显式 `--run-id` 的非 hermes 路径行为一字不变。那条路径上
     * deliver 的 `taskId` 本来就是 dispatch flush 用的那个 id，`dispatchKey`
     * 必须保持 undefined（走 `?? taskId`），资产照旧上 reply。
     */
    it('负控 1：显式 --run-id（看板 task）仍照旧上 reply.assetIds', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const filePath = rig.writeArtifact(KANBAN_TASK, 'explicit.md', '# explicit run-id\n');

      let delivered: any;
      const reply = await runDispatch(rig, {
        taskId: KANBAN_TASK,
        kind: 'task',
        duringRun: async () => {
          delivered = await rig.deliver({ taskId: KANBAN_TASK, path: filePath, mode: 'attach' });
        },
      });

      expect(delivered.status).toBe(200);
      expect(reply.assetIds).toEqual(['ast_1']);
      // 显式路径上 auto-resolve 从未发生 ⇒ 归属仍按看板形状绑定，一字未动。
      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBe(KANBAN_TASK);
      expect(got.field('folderPath')).toBe(`/tasks/${KANBAN_TASK}`);
    });

    /**
     * 负控 3 —— 合成行（`task_id` NULL，无 cloud dispatch id）不得错挂。
     * 它回退到 `hit.runId`（`session:` 前缀），与 cuid 形状的 dispatch id 是两个
     * 不相交的 key 空间；那条资产**不许**混进另一个在飞 run 的 reply。
     *
     * 用真 `HermesSessionMapper` 打一台假 hermes 建出那行；两个 agent 身份
     * （A=有 dispatch 的、B=合成行的）避免 auto-resolve 落到 409 歧义分支。
     */
    it('负控 3：合成行（task_id=NULL）的资产不混进别的 run 的 reply.assetIds', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const hermes = await makeFakeHermes();
      try {
        const AGENT_B = 'imu_synthetic_r1d';
        rig.registry.register({
          runId: HERMES_RUN,
          conversationId: CONV,
          taskId: CLOUD_DISPATCH,
          agentImUserId: AGENT_IM_USER,
          workspaceId: WS,
          profileName: 'ceo',
          roleTemplateSlug: null,
          adapterName: 'hermes',
        });
        // 真 mapper 写那行合成行（run_id=`session:<id>`、task_id=NULL）。
        const mapper = new HermesSessionMapper(rig.db);
        await mapper.createForConversation(hermes.baseUrl, 'hermes-key', 'cnv_other', AGENT_B, 'analyst', WS);
        const syntheticRunId = `session:${hermes.sessionId}`;
        const raw = rig.db
          .prepare('SELECT task_id FROM local_run_sessions WHERE run_id = ?')
          .get(syntheticRunId) as { task_id: string | null } | undefined;
        // 前置条件：这行真的没有 cloud dispatch id。
        expect(raw?.task_id).toBeNull();

        const fileA = rig.writeArtifact(HERMES_RUN, 'mine.md', '# mine\n');
        const fileB = rig.writeArtifact(syntheticRunId, 'not-mine.md', '# not mine\n');

        const reply = await runDispatch(rig, {
          taskId: CLOUD_DISPATCH,
          kind: 'run',
          conversationId: CONV,
          duringRun: async () => {
            expect((await rig.deliver(autoResolveBody(fileA))).status).toBe(200);
            expect((await rig.deliver(autoResolveBody(fileB, AGENT_B))).status).toBe(200);
          },
        });

        // 两份都真上传了（都拿到 assetId），但只有本 run 的那份上 reply。
        expect(rig.cloud.received.map((r) => r.filename)).toEqual(['mine.md', 'not-mine.md']);
        expect(reply.assetIds).toEqual(['ast_1']);
        expect(reply.assetIds).not.toContain('ast_2');
      } finally {
        await hermes.close();
      }
    });
  });

  /**
   * ## R1-e —— R1 链的三条残留
   *
   * A. 合成行（`hit.taskId` NULL）上 `recordDeliveredAsset` 立的桶**没有抽干方**：
   *    `flushPending` 的两处生产调用（dispatch.ts reply-build + finally 兜底）
   *    都按 `payload.taskId`（cloud dispatch id）取键，而合成行的键是
   *    `session:<id>` / hermes 本地 run id —— 两个不相交的键空间。写进去的桶
   *    永远没人读，只随 daemon 生命周期单调增长。
   * B. auto-scan 写入方（`upload()`）是裸 `push`，而 `recordDeliveredAsset` 有
   *    `includes` 去重。cloud 的 `POST /assets` 按
   *    `(workspaceId, contentHash[, sourceTaskId])` 去重并返回**同一个** assetId，
   *    于是同一份文件走「写进 artifactsDir + 显式 attach」两条路 ⇒ 同一个
   *    assetId 在 `reply.assetIds` 里出现两次。
   * C. `bindSourceTask` 靠字符串形状区分看板卡 id 与 chat dispatch id ——
   *    而 `IMTask.id` 与 `IMTaskRun.id` 都是 `@default(cuid()) @db.VarChar(30)`，
   *    形状完全一样。cloud 对聊天 dispatch 下发的 `payload.taskId` 就是
   *    `IMTaskRun.id`，形状闸会把它判成看板卡并 stamp `sourceTaskId`。
   */
  describe('R1-e — pendingByTask 泄漏 / auto-scan 去重 / bindSourceTask 判别', () => {
    const autoResolveBody = (filePath: string, agentImUserId = AGENT_IM_USER) => ({
      path: filePath,
      mode: 'attach' as const,
      resolveActiveDispatch: true,
      agentImUserId,
    });

    /**
     * A 正控 —— 合成行（`task_id` NULL）的交付不再立桶。
     *
     * 用**真** `HermesSessionMapper` 打一台假 hermes 写出那行，不手搓 SQL。
     * 交付三次以把「单调增长」这件事测出来：修复前桶数恒为 1、列表长到 3；
     * 修复后桶数恒为 0。
     */
    it('A 正控：合成行（无 cloud dispatch id）的 attach 不再往 pendingByTask 立桶', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const hermes = await makeFakeHermes();
      try {
        const AGENT_B = 'imu_synthetic_r1e';
        const mapper = new HermesSessionMapper(rig.db);
        await mapper.createForConversation(hermes.baseUrl, 'hermes-key', 'cnv_r1e', AGENT_B, 'analyst', WS);
        const syntheticRunId = `session:${hermes.sessionId}`;
        // 前置条件取自 DB 原始行：这行真的没有 cloud dispatch id。
        const raw = rig.db
          .prepare('SELECT task_id FROM local_run_sessions WHERE run_id = ?')
          .get(syntheticRunId) as { task_id: string | null } | undefined;
        expect(raw?.task_id).toBeNull();

        expect(pendingBuckets(rig.watcher).size).toBe(0);

        for (const n of [1, 2, 3]) {
          const filePath = rig.writeArtifact(syntheticRunId, `leak-${n}.md`, `# delivery ${n}\n`);
          const res = await rig.deliver(autoResolveBody(filePath, AGENT_B));
          expect(res.status).toBe(200);
          // 前置条件：auto-resolve 真的走了合成行分支（否则测的是别的东西）。
          expect(res.body.ridesReply).toBe(false);
          // ── oracle：桶数不增长 ──
          expect(pendingBuckets(rig.watcher).size).toBe(0);
        }

        // 反向断言：资产**没有**被丢掉，三份都真上传了并锚在 /runs/<runId>。
        expect(rig.cloud.received.map((r) => r.filename)).toEqual(['leak-1.md', 'leak-2.md', 'leak-3.md']);
        for (const got of rig.cloud.received) {
          expect(got.field('folderPath')).toBe(`/runs/${syntheticRunId}`);
        }
      } finally {
        await hermes.close();
      }
    });

    /**
     * A 反向负控 —— 不许修成「一律不 record」。正常 dispatch（auto-resolve 拿到
     * cloud dispatch id）的桶必须照旧建立、照旧被 `flushPending` 抽干，资产照旧
     * 上 `reply.assetIds`，且 dispatch 结束后 map 归零（没有第二种泄漏）。
     */
    it('A 反向负控：有 cloud dispatch id 时桶仍被建立、被抽干、且资产上 reply', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      rig.registry.register({
        runId: HERMES_RUN,
        conversationId: CONV,
        taskId: CLOUD_DISPATCH,
        agentImUserId: AGENT_IM_USER,
        workspaceId: WS,
        profileName: 'ceo',
        roleTemplateSlug: null,
        adapterName: 'hermes',
      });
      const filePath = rig.writeArtifact(HERMES_RUN, 'still-rides.md', '# still rides\n');

      let bucketsDuringRun: string[] = [];
      const reply = await runDispatch(rig, {
        taskId: CLOUD_DISPATCH,
        kind: 'run',
        conversationId: CONV,
        duringRun: async () => {
          const res = await rig.deliver(autoResolveBody(filePath));
          expect(res.status).toBe(200);
          expect(res.body.ridesReply).toBe(true);
          // 在飞时桶确实存在，且键就是 dispatch 会 flush 的那个。
          bucketsDuringRun = [...pendingBuckets(rig.watcher).keys()];
        },
      });

      expect(bucketsDuringRun).toEqual([CLOUD_DISPATCH]);
      expect(reply.assetIds).toEqual(['ast_1']);
      // dispatch 收尾后 map 归零 —— 桶被抽干，不是被留下。
      expect(pendingBuckets(rig.watcher).size).toBe(0);
    });

    /**
     * B 正控 —— 同一份文件显式 `--mode attach` 后，即使仍躺在
     * artifactsDir，auto-scan 也不会再上传；`reply.assetIds` 只出现一次。
     */
    it('B 正控：同一份文件 auto-scan + 显式 attach ⇒ reply.assetIds 只出现一次', async () => {
      const rig = await makeRig({ dedup: true });
      rigs.push(rig);
      const artifactsDir = join(rig.dir, 'b-artifacts');
      mkdirSync(artifactsDir, { recursive: true });
      const filePath = join(artifactsDir, 'dup.md');
      writeFileSync(filePath, '# delivered twice\n');

      const watcher = new ArtifactsWatcher({
        cloud: rig.cloudClient,
        containerId: 'c-r1e',
        workspaceId: () => WS,
        pollIntervalMs: 60_000, // 手动 scanNow，不跑定时器
        autoScan: true, // 这条用例测的正是 auto-scan 那个写入方
        log: { info: () => {}, warn: () => {} },
      });
      watcher.addActiveTask({ taskId: KANBAN_TASK, kind: 'task', artifactsDir });
      const sink = attachDeliver({ watcher, cloud: rig.cloudClient });

      // 路径 1：agent 显式交付。
      expect((await sink({ taskId: KANBAN_TASK, path: filePath, mode: 'attach' }) as any).status).toBe(200);
      // 路径 2：同一份文件还躺在 artifactsDir 里，auto-scan 应识别为已处理。
      await watcher.scanNow();

      // 只发生一次真实上传；不再依赖 cloud 的二次请求去重。
      expect(rig.cloud.received.length).toBe(1);

      // ── oracle：reply 侧的清单里只出现一次 ──
      expect(watcher.flushPending(KANBAN_TASK)).toEqual([rig.cloud.received[0]!.assetId]);
    });

    /**
     * B 反向负控 —— 去重不许把两份**不同**的文件吃掉。
     */
    it('B 反向负控：两份不同的文件仍然都在 reply.assetIds 里', async () => {
      const rig = await makeRig({ dedup: true });
      rigs.push(rig);
      const artifactsDir = join(rig.dir, 'b2-artifacts');
      mkdirSync(artifactsDir, { recursive: true });
      const scanned = join(artifactsDir, 'from-scan.md');
      writeFileSync(scanned, '# written into artifactsDir\n');
      const explicit = join(rig.dir, 'explicit.md');
      writeFileSync(explicit, '# delivered explicitly (different bytes)\n');

      const watcher = new ArtifactsWatcher({
        cloud: rig.cloudClient,
        containerId: 'c-r1e',
        workspaceId: () => WS,
        pollIntervalMs: 60_000,
        autoScan: true,
        log: { info: () => {}, warn: () => {} },
      });
      watcher.addActiveTask({ taskId: KANBAN_TASK, kind: 'task', artifactsDir });
      const sink = attachDeliver({ watcher, cloud: rig.cloudClient });

      expect((await sink({ taskId: KANBAN_TASK, path: explicit, mode: 'attach' }) as any).status).toBe(200);
      await watcher.scanNow();

      expect(rig.cloud.received.map((r) => r.filename)).toEqual(['explicit.md', 'from-scan.md']);
      expect(rig.cloud.received[0]!.assetId).not.toBe(rig.cloud.received[1]!.assetId);
      expect(watcher.flushPending(KANBAN_TASK)).toEqual([
        rig.cloud.received[0]!.assetId,
        rig.cloud.received[1]!.assetId,
      ]);
    });

    /**
     * C 正控 —— 形状与看板卡**完全一样**的 chat dispatch id 不得被绑成
     * `sourceTaskId`。
     *
     * `CLOUD_DISPATCH` 是 cuid 形状（≤30、无前缀），正是 cloud 对聊天 dispatch
     * 下发的 `payload.taskId`（= `IMTaskRun.id`）。agent 从
     * `<execution_context><run_id>` 里抄出它、`cloud deliver --run-id <id>`
     * ——CLI 的报错文案就是这么教的——于是它以显式 taskId 的形态走到这里。
     * 老的形状闸会答「看板卡」。真值来自 dispatch 自己：`payload.kind='run'`。
     */
    it('C 正控：cuid 形状的 chat dispatch id 不再被误绑成 sourceTaskId', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const filePath = rig.writeArtifact(CLOUD_DISPATCH, 'from-run.md', '# chat run deliverable\n');

      let delivered: any;
      const reply = await runDispatch(rig, {
        taskId: CLOUD_DISPATCH,
        kind: 'run',
        duringRun: async () => {
          // 显式 taskId（没有 auto-resolve）—— 就是 `--run-id` 那条路。
          delivered = await rig.deliver({ taskId: CLOUD_DISPATCH, path: filePath, mode: 'attach' });
        },
      });
      expect(delivered.status).toBe(200);

      // ── oracle：cloud 真收到的 multipart 字段 ──
      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBeNull();
      const meta = JSON.parse(got.field('metadata')!);
      expect(meta.taskId).toBeUndefined();
      expect(meta.runId).toBe(CLOUD_DISPATCH);
      expect(got.field('folderPath')).toBe(`/runs/${CLOUD_DISPATCH}`);
      expect(got.field('folderPath')).not.toBe(`/tasks/${CLOUD_DISPATCH}`);
      // 不 bind 不等于不上 reply：taskId 本来就是 flush 的那个键。
      expect(reply.assetIds).toEqual(['ast_1']);
    });

    /**
     * C 反向负控 —— 真看板 dispatch（`kind='task'`，同样 cuid 形状）必须**仍然**
     * 绑 `sourceTaskId` 并落 `/tasks/<id>`。判别式换了，结论不能跟着换。
     */
    it('C 反向负控：kind=task 的 dispatch 仍绑 sourceTaskId + /tasks/<id>', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const filePath = rig.writeArtifact(KANBAN_TASK, 'from-task.md', '# kanban deliverable\n');

      const reply = await runDispatch(rig, {
        taskId: KANBAN_TASK,
        kind: 'task',
        duringRun: async () => {
          expect((await rig.deliver({ taskId: KANBAN_TASK, path: filePath, mode: 'attach' })).status).toBe(200);
        },
      });

      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBe(KANBAN_TASK);
      expect(JSON.parse(got.field('metadata')!).taskId).toBe(KANBAN_TASK);
      expect(got.field('folderPath')).toBe(`/tasks/${KANBAN_TASK}`);
      expect(reply.assetIds).toEqual(['ast_1']);
    });

    /**
     * C 反向负控 2 —— 不在飞的 id（老 CLI / 跨 dispatch 交付）没有权威来源，
     * 必须**保持**老的形状闸行为，不许因为「查不到就当 run」而把既有的看板绑定
     * 弄丢。
     */
    it('C 反向负控 2：非在飞的看板形状 id 仍走形状闸并绑定', async () => {
      const rig = await makeRig();
      rigs.push(rig);
      const filePath = rig.writeArtifact(KANBAN_TASK, 'orphan.md', '# no dispatch registered\n');

      // 没有任何 dispatch 在飞 —— activeTaskKind 查不到。
      expect((await rig.deliver({ taskId: KANBAN_TASK, path: filePath, mode: 'attach' })).status).toBe(200);

      const got = rig.cloud.received[0]!;
      expect(got.field('sourceTaskId')).toBe(KANBAN_TASK);
      expect(got.field('folderPath')).toBe(`/tasks/${KANBAN_TASK}`);
    });
  });
});
