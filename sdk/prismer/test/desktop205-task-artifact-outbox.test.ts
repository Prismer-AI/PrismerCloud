/**
 * desktop205 O14 — task 产物的断云降级契约（03-acceptance §3.3 第 3、5 行的另一半）。
 *
 * §3.3 定的「产物落本地 + 进 outbox / 复联补传」此前**只对 drop-folder 成立**：
 * task 产物走 `ArtifactsWatcher.deliverFile` → 裸 `uploader.uploadAsset(...)`，
 * 失败直接抛给调用方，文件留在 task workdir，没有队列、复联不补传。本文件是这条
 * 缺口修好后的门。
 *
 * ## 为什么不 mock
 * 沿用 `desktop205-offline-outbox.test.ts` 的范式：真 `http.Server` + 真 `fetch`
 * + 真 `better-sqlite3` outbox + 真文件系统。**断云 = 真的把监听端口关掉**，得到的是
 * 真 ECONNREFUSED —— SUT 要分类的正是这个形状。SUT（deliverFile / attachDeliver /
 * AgentGenAdapter / UploadRunner / OriginOutbox）一行都没有被替身。
 *
 * ## oracle 只取副作用
 *   - 文件在磁盘上**真的还在**（task workdir）
 *   - outbox 真 sqlite 的 pending / dead-letter 计数
 *   - 真 http server **真收到的字节**（含 multipart 里的 kind / sourceTaskId）
 * 不断言任何日志行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { boundPort } from './_helpers/listen-ephemeral.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginOutbox } from '../src/daemon/asset/origin/outbox.js';
import { AgentGenAdapter } from '../src/daemon/asset/origin/agent-gen.js';
import { DaemonAssetUploadClient, UploadRunner } from '../src/daemon/asset/origin/upload-runner.js';
import type { OriginAdapter } from '../src/daemon/asset/origin/spi.js';
import { ArtifactsWatcher } from '../src/daemon/artifacts-watcher.js';
import { attachDeliver } from '../src/daemon/asset/deliver.js';

const WS = 'ws_o14';
const TASK = 'tsk_o14';

interface ReceivedUpload {
  filename: string;
  raw: Buffer;
  field(name: string): string | null;
}

interface FakeCloud {
  baseUrl: string;
  received: ReceivedUpload[];
  rejectPermanently: boolean;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Cloud stub speaking just enough of the asset-upload protocol. `direct-upload/init`
 *  answers 404 so the client falls back to the multipart `POST /api/im/assets`
 *  branch — the same branch the real daemon takes when no S3 plan is available. */
function makeFakeCloud(): FakeCloud {
  const received: ReceivedUpload[] = [];
  let server: Server | null = null;
  const state: FakeCloud & { port: number } = {
    // Filled in by listen() from the socket the kernel actually bound.
    port: 0,
    baseUrl: '',
    received,
    rejectPermanently: false,
    async listen() {
      server = createServer((req, res) => void handle(req, res));
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
      if (state.rejectPermanently) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'permanently rejected' } }));
        return;
      }
      const raw = Buffer.concat(chunks);
      received.push({
        filename: raw.toString('latin1').match(/filename="([^"]+)"/)?.[1] ?? '',
        raw,
        field: (name) => multipartField(raw, name),
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { id: `ast_${received.length}`, contentHash: 'sha256:stub' } }));
      return;
    }
    // Message POST (`send` mode) — offline tests never reach here.
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

/** Minimal CloudClient surface the deliver sink touches (only `send`/`message-attach`
 *  modes call `.request`; the upload path uses baseUrl/apiKey directly). */
function cloudClientFor(baseUrl: string): any {
  return {
    apiKey: 'sk-prismer-test',
    baseUrl,
    async request(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const data = await res.json().catch(() => undefined);
      if (!res.ok) return { ok: false, status: res.status, error: { code: 'http', message: `HTTP ${res.status}` } };
      return { ok: true, status: res.status, data };
    },
  };
}

interface Rig {
  dir: string;
  artifactsDir: string;
  outbox: OriginOutbox;
  runner: UploadRunner;
  cloud: FakeCloud;
  deliver(body: unknown): Promise<{ status: number; body: any }>;
  /** One daemon tick as runner.ts::runDropFolderTick performs it (drain only —
   *  task artifacts are pushed in by deliverFile, not scanned). */
  drain(): Promise<number>;
  writeArtifact(name: string, contents: string): string;
}

/** @param wireOutbox false ⇒ 负控 3：把「入队」那一步摘掉，其余接线不变。 */
async function makeRig(opts: { wireOutbox?: boolean; maxAttempts?: number } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'desktop205-o14-'));
  const artifactsDir = join(dir, 'workspaces', WS, 'tasks', TASK, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const cloud = makeFakeCloud();
  await cloud.listen();

  const outbox = new OriginOutbox({ dbPath: join(dir, 'asset-origin.db') });
  const wireOutbox = opts.wireOutbox !== false;

  const watcher = new ArtifactsWatcher({
    cloud: cloudClientFor(cloud.baseUrl),
    containerId: 'c-o14',
    workspaceId: () => WS,
    autoScan: false,
    log: { info: () => {}, warn: () => {} },
    ...(wireOutbox ? { assetOutbox: () => outbox } : {}),
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
    maxAttempts: opts.maxAttempts ?? 3,
  });

  const sink = attachDeliver({ watcher, cloud: cloudClientFor(cloud.baseUrl) });

  return {
    dir,
    artifactsDir,
    outbox,
    runner,
    cloud,
    deliver: (body) => sink(body) as Promise<{ status: number; body: any }>,
    drain: () => runner.drainOnce(),
    writeArtifact(name, contents) {
      const full = join(artifactsDir, name);
      writeFileSync(full, contents);
      return full;
    },
  };
}

describe('desktop205 O14 — task 产物进 outbox（断云 / 复联 / dead-letter）', () => {
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
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  /**
   * 正控 —— 契约「产物：落本地 + 进 outbox」+「复联：outbox 补传成功」。
   *
   * 注入的故障是真的：`cloud.close()` 关掉监听 socket，之后每次 upload 都是真
   * ECONNREFUSED。
   */
  it('断云期间 task 产物落本地 + 进 outbox；复联后补传成功', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact('deliverable.md', '# O14 task artifact\n');

    // ── 断云 ──
    await rig.cloud.close();
    const res = await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(true);
    // 产物落本地：文件原地未动
    expect(existsSync(filePath)).toBe(true);
    // 进 outbox 且仍待传（不是 dead-letter）
    expect(rig.outbox.pendingCount()).toBe(1);
    expect(rig.outbox.deadLetterCount()).toBe(0);

    // 断云状态下多跑几个 tick：仍然不丢、不判死
    for (let i = 0; i < 5; i++) await rig.drain();
    expect(rig.outbox.pendingCount()).toBe(1);
    expect(rig.outbox.deadLetterCount()).toBe(0);
    // 负控（断云状态下的反向断言）：cloud 一个字节都没收到 —— 若这里非 0，
    // 说明「断云」这个故障根本没注入进去，下面的复联断言就是开卷考试。
    expect(rig.cloud.received.length).toBe(0);

    // ── 复联 ──
    await rig.cloud.listen();
    await rig.drain();

    expect(rig.cloud.received.length).toBe(1);
    const got = rig.cloud.received[0]!;
    expect(got.filename).toBe('deliverable.md');
    expect(got.raw.toString('utf8')).toContain('# O14 task artifact');
    // 补传必须复现同步路径的云端语义，否则「补传成功」是假的：
    // kind=agent-output（不是默认 file）+ sourceTaskId 绑到看板卡。
    expect(got.field('kind')).toBe('agent-output');
    expect(got.field('sourceTaskId')).toBe(TASK);
    expect(got.field('folderPath')).toBe(`/tasks/${TASK}`);

    expect(rig.outbox.pendingCount()).toBe(0);
    expect(rig.outbox.deadLetterCount()).toBe(0);
  });

  /** mode:'attach' 与 task-attach 同为「上传即交付」，同样 202 + 入队。 */
  it("断云下 mode:'attach' 也入队并返回 202", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact('reply.md', 'attach me\n');

    await rig.cloud.close();
    const res = await rig.deliver({ taskId: TASK, path: filePath, mode: 'attach' });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(rig.outbox.pendingCount()).toBe(1);

    await rig.cloud.listen();
    await rig.drain();
    expect(rig.cloud.received.length).toBe(1);
  });

  /**
   * 语义边界（不是「都算成功」）：'send' 需要用 assetId 再打一次 cloud，断云下
   * 那一步结构上做不了。字节仍然入队（产物不丢），但**必须**报失败，否则 agent
   * 会以为消息已经发出去了。
   */
  it("断云下 mode:'send' 入队但报失败（消息动作确实没发生）", async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact('note.md', 'send me\n');

    await rig.cloud.close();
    const res = await rig.deliver({
      taskId: TASK,
      path: filePath,
      mode: 'send',
      conversationId: 'conv_1',
    });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.queued).toBe(true);
    // 产物没丢
    expect(rig.outbox.pendingCount()).toBe(1);
    expect(existsSync(filePath)).toBe(true);
  });

  /**
   * 负控 2 —— 防「把 dead-letter 整个关掉 / 无限重试」骗绿。
   * 永久性失败（cloud 明确回 400）必须在 maxAttempts 次后判死进 dead-letter。
   */
  it('永久失败（HTTP 400）仍然进 dead-letter，不无限重试', async () => {
    const rig = await makeRig({ maxAttempts: 3 });
    rigs.push(rig);
    const filePath = rig.writeArtifact('bad.md', 'nope\n');

    // 先在断云下入队（这是产物进 outbox 的唯一入口）
    await rig.cloud.close();
    const res = await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });
    expect(res.status).toBe(202);

    // 复联，但 cloud 永久拒绝
    await rig.cloud.listen();
    rig.cloud.rejectPermanently = true;
    for (let i = 0; i < 6; i++) await rig.drain();

    expect(rig.outbox.deadLetterCount()).toBe(1);
    expect(rig.outbox.pendingCount()).toBe(0);
  });

  /**
   * 负控 2b —— 4xx 是永久失败，**同步**路径不得把它当断云入队（否则一个会被
   * 永远拒收的产物会伪装成「已入队」，agent 得到 202 却永远等不到）。
   */
  it('同步路径遇 4xx 直接失败，不入队', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    rig.cloud.rejectPermanently = true;
    const filePath = rig.writeArtifact('rejected.md', 'x\n');

    const res = await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });

    expect(res.status).toBe(502);
    expect(res.body.queued).toBeUndefined();
    expect(rig.outbox.pendingCount()).toBe(0);
    expect(rig.outbox.deadLetterCount()).toBe(0);
  });

  /**
   * 负控 3 —— 把「入队」那一步摘掉（不给 watcher 接 outbox），正控必须转红：
   * 回到 O14 之前的行为 —— 502 抛回调用方、outbox 空、复联无从补传。
   * 这条证明上面那条绿是**接线**带来的，不是测试自说自话。
   */
  it('摘掉入队接线 ⇒ 退回 O14 之前：502 + outbox 空 + 复联无补传', async () => {
    const rig = await makeRig({ wireOutbox: false });
    rigs.push(rig);
    const filePath = rig.writeArtifact('deliverable.md', '# O14 task artifact\n');

    await rig.cloud.close();
    const res = await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(rig.outbox.pendingCount()).toBe(0);

    await rig.cloud.listen();
    await rig.drain();
    expect(rig.cloud.received.length).toBe(0);
  });

  /**
   * 幂等：同一个未修改的文件重复交付只产生一行（idempotencyKey 取 mtime，
   * 与 drop-folder 同构）。否则一个反复重试的 agent 会把 outbox 灌爆，
   * 并在复联后把同一份产物传 N 次。
   */
  it('同一未修改文件重复交付只入队一行', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact('dup.md', 'same bytes\n');

    await rig.cloud.close();
    await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });
    await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });
    await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' });

    expect(rig.outbox.pendingCount()).toBe(1);

    await rig.cloud.listen();
    await rig.drain();
    expect(rig.cloud.received.length).toBe(1);
  });

  /**
   * 队列里的产物在 daemon 重启后仍然补传 —— 「持久化重试保证」的字面含义。
   * 用同一个 db 文件新建 outbox + runner 模拟进程重启。
   */
  it('daemon 重启后 outbox 仍补传（持久化不是内存重试）', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    const filePath = rig.writeArtifact('survive.md', 'restart me\n');

    await rig.cloud.close();
    expect((await rig.deliver({ taskId: TASK, path: filePath, mode: 'task-attach' })).status).toBe(202);
    rig.outbox.close();

    // ── 进程重启：同一个 db 文件，全新对象 ──
    const reopened = new OriginOutbox({ dbPath: join(rig.dir, 'asset-origin.db') });
    const reopenedRunner = new UploadRunner({
      outbox: reopened,
      cloud: new DaemonAssetUploadClient({
        cloudApiBase: rig.cloud.baseUrl,
        apiKey: 'sk-prismer-test',
        timeoutMs: 2_000,
      }),
      adapters: { 'agent-gen': new AgentGenAdapter() as OriginAdapter },
      maxAttempts: 3,
    });
    expect(reopened.pendingCount()).toBe(1);

    await rig.cloud.listen();
    await reopenedRunner.drainOnce();
    expect(rig.cloud.received.length).toBe(1);
    expect(rig.cloud.received[0]!.filename).toBe('survive.md');
    reopened.close();
  });
});
