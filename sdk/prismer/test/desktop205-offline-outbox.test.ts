/**
 * desktop205 W8 — 断云降级契约：产物 / outbox / 复联补传（03-acceptance §3.3 的第 3、5 行）。
 *
 * ⚠️ 前提（未最终裁决，见 docs/desktop205/02-impl-spec.md D1）：
 *   本文件按 **读法 A** 写 —— "没有云端 agent-rt pod，但 cloud 数据面照常在"，
 *   断云 = 桌面 daemon 到 cloud 的连接中断。读法 B（云端整体不可达）在结构上没有
 *   更强的可验证目标：dispatch 只经 cloud WS（runner.ts `task.dispatch.request`），
 *   daemon 无本地 HTTP dispatch 面 ⇒ 断云期间**新任务根本进不来**（01-evidence F11）。
 *   若用户最终裁决取 B，本文件的契约不变，只是"新任务抵达"那一格仍旧不设门。
 *
 * ## 为什么不 mock
 * 《验收纪律》§3 点名的骗绿手段第一条就是"mock/打桩绕过难点"。这里的难点恰恰是
 * **真实的网络失败长什么样**：undici `fetch` 在 ECONNREFUSED 上抛 `TypeError: fetch
 * failed` 且把 `cause.code` 挂在下面，超时抛 AbortError —— 这两种形状正是 SUT 要
 * 分类的东西。所以本文件起**真 http.Server**、用**真 fetch**、真 better-sqlite3
 * outbox、真文件系统，断云的方式是**真的把监听端口关掉**。SUT 一行都没有被替身。
 *
 * ## oracle 只取副作用
 *   - outbox 行状态（pending / dead-letter 计数，真 sqlite）
 *   - 磁盘上文件**真的在哪个目录**（drop / uploaded / upload-failed）
 *   - cloud 侧真收到的字节
 * 不断言任何日志行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { boundPort } from './_helpers/listen-ephemeral.js';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OriginOutbox } from '../src/daemon/asset/origin/outbox.js';
import { DropFolderAdapter } from '../src/daemon/asset/origin/drop-folder.js';
import { DaemonAssetUploadClient, UploadRunner } from '../src/daemon/asset/origin/upload-runner.js';
import type { OriginAdapter } from '../src/daemon/asset/origin/spi.js';

const WS = 'ws_desktop205';

interface FakeCloud {
  port: number;
  baseUrl: string;
  /** Bodies the cloud actually received on POST /api/im/assets. */
  received: Array<{ filename: string; bytes: Buffer }>;
  /** Force every upload POST to answer with a permanent 400. */
  rejectPermanently: boolean;
  listen(): Promise<void>;
  /** 断云：真的把监听端口关掉 ⇒ 之后的 fetch 得到真 ECONNREFUSED。 */
  close(): Promise<void>;
}

/** A cloud stub that speaks just enough of the asset-upload protocol.
 *  `direct-upload/init` answers 404 so the client falls back to the multipart
 *  path (`POST /api/im/assets`) — same branch the real daemon takes when the
 *  S3 direct-upload plan is unavailable. */
function makeFakeCloud(): FakeCloud {
  const received: FakeCloud['received'] = [];
  let server: Server | null = null;
  const state = {
    // Filled in by listen() from the socket the kernel actually bound.
    port: 0,
    baseUrl: '',
    received,
    rejectPermanently: false,
    async listen() {
      server = createServer((req, res) => {
        void handle(req, res);
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
      received.push({ filename: filenameFromMultipart(raw), bytes: raw });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { id: `ast_${received.length}`, contentHash: 'sha256:stub' } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }

  return state;
}

function filenameFromMultipart(raw: Buffer): string {
  return raw.toString('latin1').match(/filename="([^"]+)"/)?.[1] ?? '';
}

interface Rig {
  dir: string;
  workspaceDir: string;
  outbox: OriginOutbox;
  adapter: DropFolderAdapter;
  runner: UploadRunner;
  cloud: FakeCloud;
  /** One daemon tick: scan drop/ → enqueue → drain (mirrors runner.ts runDropFolderTick). */
  tick(): Promise<void>;
  files(sub: 'drop' | 'uploaded' | 'upload-failed'): string[];
}

async function makeRig(opts: { maxAttempts?: number } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'desktop205-offline-'));
  const workspaceDir = join(dir, 'workspaces', WS);
  for (const sub of ['drop', 'uploaded', 'upload-failed']) {
    mkdirSync(join(workspaceDir, sub), { recursive: true });
  }
  const cloud = makeFakeCloud();
  await cloud.listen();

  const outbox = new OriginOutbox({ dbPath: join(dir, 'asset-origin.db') });
  const adapter = new DropFolderAdapter({ workspaceDir });
  // Exactly the wiring runner.ts::ensureDropFolderRuntime builds (maxAttempts: 3).
  const runner = new UploadRunner({
    outbox,
    cloud: new DaemonAssetUploadClient({
      cloudApiBase: cloud.baseUrl,
      apiKey: 'sk-prismer-test',
      timeoutMs: 2_000,
    }),
    adapters: { 'drop-folder': adapter as OriginAdapter },
    maxAttempts: opts.maxAttempts ?? 3,
  });

  return {
    dir,
    workspaceDir,
    outbox,
    adapter,
    runner,
    cloud,
    async tick() {
      for (const obs of await adapter.scanOnce(WS)) {
        const id = await adapter.identifySource(obs);
        outbox.enqueue({
          workspaceId: obs.workspaceId,
          originKind: 'drop-folder',
          sourceRef: id.sourceRef,
          payloadJson: JSON.stringify(obs.detail),
          hintsJson: JSON.stringify(id.hints ?? {}),
          observedAt: obs.observedAt,
        });
      }
      await runner.drainOnce();
    },
    files(sub) {
      return readdirSync(join(workspaceDir, sub));
    },
  };
}

describe('desktop205 W8 — 断云降级契约（产物 / outbox / 复联）', () => {
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
   * 契约「产物：落本地 + 进 outbox」+「复联：outbox 补传成功」。
   *
   * 注入的故障是真的：`cloud.close()` 关掉监听 socket，之后每次 upload 都是真
   * ECONNREFUSED。10 个 tick ≈ 真实 daemon 10 秒的断云（tick 间隔 1s）。
   */
  it('断云期间产物留在本地且 outbox 不丢；复联后补传成功', async () => {
    const rig = await makeRig();
    rigs.push(rig);
    writeFileSync(join(rig.workspaceDir, 'drop', 'report.md'), '# desktop205 artifact\n');

    // ── 断云 ──
    await rig.cloud.close();
    for (let i = 0; i < 10; i++) await rig.tick();

    // 产物落本地：文件既没被上传掉，也没被判死移进 upload-failed/
    expect(rig.files('drop')).toEqual(['report.md']);
    expect(rig.files('upload-failed')).toEqual([]);
    // 进 outbox 且仍然待传（不是 dead-letter）
    expect(rig.outbox.pendingCount()).toBe(1);
    expect(rig.outbox.deadLetterCount()).toBe(0);
    // 负控（断云状态下的反向断言）：cloud 一个字节都没收到 —— 若这里非 0，说明
    // "断云"这个故障根本没注入进去，下面的复联断言就是开卷考试。
    expect(rig.cloud.received.length).toBe(0);

    // ── 复联 ──
    await rig.cloud.listen();
    await rig.tick();

    expect(rig.cloud.received.length).toBe(1);
    expect(rig.cloud.received[0].filename).toBe('report.md');
    expect(rig.cloud.received[0].bytes.toString('utf8')).toContain('# desktop205 artifact');
    expect(rig.outbox.pendingCount()).toBe(0);
    expect(rig.outbox.deadLetterCount()).toBe(0);
    expect(rig.files('drop')).toEqual([]);
    expect(rig.files('uploaded')).toEqual(['report.md']);
  });

  /**
   * 负控 A —— 防"把 dead-letter 整个关掉"骗绿。
   *
   * 上一条要求瞬时故障永不 dead-letter。若实现图省事直接把 dead-letter 拆了，
   * 这条必须红：**永久性**失败（cloud 明确回 400）仍然要在 maxAttempts 次后
   * 判死并把文件移进 upload-failed/。
   */
  it('永久性失败（HTTP 400）仍然 dead-letter 并把文件移进 upload-failed/', async () => {
    const rig = await makeRig({ maxAttempts: 3 });
    rigs.push(rig);
    rig.cloud.rejectPermanently = true;
    writeFileSync(join(rig.workspaceDir, 'drop', 'bad.md'), 'nope\n');

    for (let i = 0; i < 5; i++) await rig.tick();

    expect(rig.outbox.deadLetterCount()).toBe(1);
    expect(rig.outbox.pendingCount()).toBe(0);
    expect(rig.files('drop')).toEqual([]);
    expect(rig.files('upload-failed')).toEqual(['bad.md']);
  });

  /**
   * 负控 B —— 防"一个 tick 烧光所有 attempt"回归。
   *
   * `drainOnce` 的 `while(true)` 会把 recordFailure 刚放回 'pending' 的同一行
   * **立刻重新 claim**，于是 maxAttempts 次重试全部发生在同一次 drain 里。配合
   * 上面 1s 一次的 tick，这意味着一次 1 秒的网络抖动就能把产物判死。
   * 断言：一次 drain 对同一行只算一次尝试。
   */
  it('一次 drain 对同一行只消耗一次尝试', async () => {
    const rig = await makeRig({ maxAttempts: 3 });
    rigs.push(rig);
    rig.cloud.rejectPermanently = true;
    writeFileSync(join(rig.workspaceDir, 'drop', 'once.md'), 'x\n');

    await rig.tick(); // 第 1 次尝试
    expect(rig.outbox.deadLetterCount()).toBe(0);
    expect(rig.outbox.pendingCount()).toBe(1);

    await rig.tick(); // 第 2 次
    expect(rig.outbox.deadLetterCount()).toBe(0);

    await rig.tick(); // 第 3 次 ⇒ 达到 maxAttempts
    expect(rig.outbox.deadLetterCount()).toBe(1);
  });
});
