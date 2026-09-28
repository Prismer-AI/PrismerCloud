// Gate B+ Task 7 — `turn run` CLI：引擎装配、结果文件契约，以及一次**真进程**运行
// （`node dist/cli.js turn run` 打本地假 **egress** 端点）。MUST-1 起 pod 内没有
// provider key：CLI 读的是 `egress.json`（turn 作用域短 TTL token），模型出口打
// cloud 的端点——假上游与假 egress 端点说的是同一种 OpenAI chat-completions wire。
//
// 真跑那一条是本文件的承重断言：它证明「cloud 端口投递的文件形态 → CLI → pi-core
// → 真实 HTTP(SSE) → output.json」整条链在**不触外网**的前提下成立（引擎装配走
// 的是生产同一路径，只有 baseUrl 指向 127.0.0.1）。

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TURN_PROTOCOL_VERSION, TurnProtocolError, type TurnEgressV1 } from '../src/turn/protocol.js';
import { egressSessionEnv, promptFromEnvelope, runTurnFile, runTurnOnce, type TurnSessionHandle } from '../src/turn/runner.js';
import { buildProgram } from '../src/cli/index.js';
import { buildTurnCommand } from '../src/cli/commands/turn.js';

const SDK_DIR = resolve(__dirname, '..');
const CLI = join(SDK_DIR, 'dist', 'cli.js');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

// ── 真进程运行的前置：dist 必须比 src 新（否则先跑一次 tsup build）────────────
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(path));
    else newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

beforeAll(() => {
  const fresh = existsSync(CLI) && statSync(CLI).mtimeMs >= newestMtimeMs(join(SDK_DIR, 'src'));
  if (fresh) return;
  const built = spawnSync('npm', ['run', 'build'], { cwd: SDK_DIR, encoding: 'utf8', timeout: 280_000 });
  if (built.status !== 0) {
    throw new Error(`sdk/prismer build failed (dist/cli.js is required for the real turn run):\n${(built.stderr || built.stdout || '').slice(0, 2000)}`);
  }
  expect(existsSync(CLI)).toBe(true);
});

const tmpDirs: string[] = [];
function makeTurnDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prismer-turn-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: 'msg_test_1',
    message: { text: 'hello' },
    history: [],
    systemPrompt: 'You are a test agent.',
    workdir: '/tmp',
    deadlineMs: 30_000,
    cancelFile: '/tmp/never-cancel',
    ...overrides,
  };
}

/** egress.json fixture（MUST-1：pod 内唯一 LLM 凭据 = turn 作用域 token）。 */
function egress(overrides: Partial<TurnEgressV1> = {}): TurnEgressV1 {
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    url: 'http://127.0.0.1:1/api/eaas-turn-egress/v1',
    token: 'turn-egress-token-abc123',
    model: 'faux-1',
    provider: 'cloud-egress',
    ...overrides,
  };
}

/** 注入用的假 session（记录 env、可脚本化结果）。 */
function makeFakeSession(script: {
  finalText?: string;
  throwOnRun?: string;
  timeline?: Array<{ type: string }>;
  deltas?: string[];
  /** 抛错前先广播一个 tool_call timeline 帧（抛错路径的副作用判据，I-1）。 */
  emitToolCall?: boolean;
}): { handle: TurnSessionHandle; envs: Array<Record<string, string>>; closed: number } {
  const envs: Array<Record<string, string>> = [];
  const state = { closed: 0 };
  const subscribers: Array<(e: { type: string; deltaKind?: string; delta?: string }) => void> = [];
  const handle: TurnSessionHandle = {
    async run() {
      if (script.emitToolCall) {
        // 与 pi-core 的真实事件面同形：recordTimeline → emit({type:'timeline', item})
        for (const sub of subscribers) sub({ type: 'timeline', item: { type: 'tool_call' } });
      }
      for (const delta of script.deltas ?? []) {
        for (const sub of subscribers) sub({ type: 'text_delta', deltaKind: 'text', delta });
      }
      if (script.throwOnRun) throw new Error(script.throwOnRun);
      return {
        finalText: script.finalText ?? 'ok',
        usage: { inputTokens: 7, outputTokens: 9 },
        timeline: script.timeline ?? [],
        servedModel: 'faux/served',
        // servedProvider 缺省 undefined：真实 pi-core 上报的是 PRISMER_PI_PROVIDER
        // （MUST-1 起 = egress.json 的 provider = 'cloud-egress'），runner 对空值回落
        // 到同一 id——两路殊途同归，用例里不需要再造一个源 id。
        servedProvider: script.servedProvider,
      };
    },
    subscribe(cb) {
      subscribers.push(cb);
      return () => undefined;
    },
    async interrupt() {
      /* no-op */
    },
    async close() {
      state.closed += 1;
    },
  };
  return {
    handle,
    envs,
    get closed() {
      return state.closed;
    },
  } as { handle: TurnSessionHandle; envs: Array<Record<string, string>>; closed: number };
}

describe('turn 命令注册与参数面', () => {
  it('exposes machine-readable history capabilities from the built CLI', () => {
    const result = spawnSync(process.execPath, [CLI, 'turn', 'capabilities'], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ protocolVersion: TURN_PROTOCOL_VERSION, maintenance: { assetIngest: 1 }, history: { text: true, principalImages: true, maxMessages: 12, maxImages: 4 } });
  });
  it('buildProgram 挂载 turn；帮助文本列出全部必需的显式参数', () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain('turn');
    const help = buildTurnCommand().commands.find(command => command.name() === 'run')!.helpInformation();
    for (const flag of ['--input', '--output', '--egress-file', '--adapter', '--deadline-ms']) {
      expect(help).toContain(flag);
    }
  });
});

describe('promptFromEnvelope：块 → 引擎 prompt（image 走 content-part，不静默丢图）', () => {
  it('无块 → 纯文本字符串', () => {
    expect(promptFromEnvelope(envelope({ message: { text: 'plain' } } as never) as never)).toBe('plain');
  });

  it('有块 → text + image parts，image 的 data 是 base64 载荷（去 data: 前缀）', () => {
    const prompt = promptFromEnvelope(
      envelope({
        message: {
          text: '看图',
          contentBlocks: [
            { kind: 'text', text: '看图' },
            { kind: 'image', assetId: 'a1', path: '/w/a1.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' },
          ],
        },
      }) as never,
    ) as Array<Record<string, string>>;
    expect(prompt[0]).toEqual({ type: 'text', text: '看图' });
    expect(prompt[1]).toEqual({ type: 'text', text: '看图' });
    expect(prompt[2]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
  });

  it('负控：dataUrl 残缺 → TurnProtocolError（绝不静默丢图）', () => {
    expect(() =>
      promptFromEnvelope(
        envelope({
          message: { text: 'x', contentBlocks: [{ kind: 'image', assetId: 'a1', path: '/w/a1.png', mediaType: 'image/png', dataUrl: 'not-a-data-url' }] },
        }) as never,
      ),
    ).toThrow(TurnProtocolError);
  });
});

describe('runTurnOnce：出口装配（MUST-1：单一出口目标，无 provider key）', () => {
  it('env 键族与 daemon 侧 pi-core 分支同源；token **原样**进 Bearer（不补 sk- 前缀）', async () => {
    const captured: Array<Record<string, string>> = [];
    const fake = makeFakeSession({ finalText: 'egress 回复', deltas: ['egress-', '回复'] });
    const result = await runTurnOnce(envelope() as never, egress(), {
      createSession: async (args) => {
        captured.push(args.env);
        return fake.handle;
      },
    });
    expect(captured).toHaveLength(1);
    expect(egressSessionEnv(envelope() as never, egress())).toMatchObject({
      PRISMER_PI_BASE_URL: 'http://127.0.0.1:1/api/eaas-turn-egress/v1',
      PRISMER_PI_PROVIDER: 'cloud-egress',
      // 出口端点固定 OpenAI chat-completions wire
      PRISMER_PI_API: 'openai-completions',
      PRISMER_PI_MODEL: 'faux-1',
      // ⚠️ 逐字：turn token 原样——sk- 前缀会改变 cloud 出口面的 HMAC 验证输入
      PRISMER_PI_API_KEY: 'turn-egress-token-abc123',
    });
    expect(result.status).toBe('ok');
    expect(result.replyText).toBe('egress 回复');
    expect(result.providerSource).toBe('cloud-egress');
    expect(result.engine).toMatchObject({ adapter: 'pi-core', model: 'faux/served' });
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 9 });
    expect(result.spans!.t7).toBeTypeOf('number');
    expect(result.spans!.t8).toBeTypeOf('number');
    expect(fake.closed).toBe(1);
  });

  it('T6-1/T6-2：envelope.tools 逐项传入 runtime session config，不在 runner 层丢失', async () => {
    let capturedTools: unknown;
    const declarations = [
      { name: 'bash', kind: 'builtin', enabled: true },
      { name: 'grep', kind: 'component', enabled: true, source: '@earendil-works/pi-coding-agent', version: '0.84.2' },
    ];

    const result = await runTurnOnce(envelope({ tools: declarations }) as never, egress(), {
      createSession: async (args) => {
        capturedTools = args.tools;
        return makeFakeSession({ finalText: 'ok' }).handle;
      },
    });

    expect(result.status).toBe('ok');
    expect(capturedTools).toEqual(declarations);
  });

  it('负控：出口报错 → status=error + provider_unreachable（出口不可达归类）', async () => {
    const result = await runTurnOnce(envelope() as never, egress(), {
      createSession: async () => makeFakeSession({ throwOnRun: 'fetch failed: ENOTFOUND cloud.example' }).handle,
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('provider_unreachable');
  });

  it('负控：出口 4xx 语义拒绝 → internal（可见失败，不假装成功）', async () => {
    const result = await runTurnOnce(envelope() as never, egress(), {
      createSession: async () => makeFakeSession({ throwOnRun: '401 invalid turn token' }).handle,
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(result.providerSource).toBe('cloud-egress');
  });

  it('超时：deadline 到点 → interrupt + status=error/code=timeout', async () => {
    const handle = makeFakeSession({ finalText: 'slow' }).handle;
    let interrupted = false;
    handle.interrupt = async () => {
      interrupted = true;
    };
    handle.run = () => new Promise((resolvePromise) => setTimeout(() => resolvePromise({ finalText: 'late', timeline: [] }), 2_000));
    const result = await runTurnOnce(envelope({ deadlineMs: 150 }) as never, egress(), { createSession: async () => handle });
    expect(interrupted).toBe(true);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
  });
});

describe('runTurnFile：文件契约（egress 读完即删；exit 0 / 70）', () => {
  it('合法输入 → 写 output.json（0600）+ 删除 egress 文件 + exit 0', async () => {
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    const egressPath = join(dir, 'egress.json');
    writeFileSync(inputPath, JSON.stringify(envelope()));
    writeFileSync(egressPath, JSON.stringify(egress()), { mode: 0o600 });

    const code = await runTurnFile({
      inputPath,
      outputPath,
      egressFilePath: egressPath,
      deps: { createSession: async () => makeFakeSession({ finalText: 'done' }).handle },
    });
    expect(code).toBe(0);
    expect(existsSync(egressPath)).toBe(false);
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    expect(written.status).toBe('ok');
    expect(written.replyText).toBe('done');
    expect(written.protocolVersion).toBe(TURN_PROTOCOL_VERSION);
  });

  it('负控（I-2）：envelope 坏 → exit 70 + 不产 output.json + **egress 文件被删**', async () => {
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    const egressPath = join(dir, 'egress.json');
    writeFileSync(inputPath, JSON.stringify({ protocolVersion: 1, turnId: 'x' }));
    writeFileSync(egressPath, JSON.stringify(egress()), { mode: 0o600 });
    const code = await runTurnFile({ inputPath, outputPath, egressFilePath: egressPath });
    expect(code).toBe(70);
    expect(existsSync(outputPath)).toBe(false);
    // I-2：最早的 return 路径也必须删 egress —— turn 目录在 agent 文件工具的 jail 内，
    // 残留的 turn token 会被下一轮 turn 的模型读到。
    expect(existsSync(egressPath)).toBe(false);
  });

  it('负控：legacy provider.key（旧协议凭据文件）不再被接受——pod 内没有 owner token 通道', async () => {
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify(envelope()));
    const code = await runTurnFile({
      inputPath,
      outputPath: join(dir, 'output.json'),
      egressFilePath: join(dir, 'provider.key'),
    });
    expect(code).toBe(70);
  });
});

// ── 真进程：`node dist/cli.js turn run` 打本地假 provider ────────────────────

/** 本地 OpenAI-compatible SSE 假 **egress** 端点（只实现 chat/completions 的最小子集）。 */
function startFakeProvider(replyChunks: string[], usage = { prompt_tokens: 5, completion_tokens: 6 }): Promise<{
  server: Server;
  baseUrl: string;
  requests: Array<{ url: string; authorization?: string; body: unknown }>;
}> {
  const requests: Array<{ url: string; authorization?: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })(),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = 'chatcmpl-fake';
      for (const chunk of replyChunks) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'faux-model',
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'faux-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'faux-model', choices: [], usage })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${addr.port}/api/eaas-turn-egress/v1`, requests });
    });
  });
}

/** 异步等子进程退出（保活本进程事件循环，同进程的假 provider 才能应答）。 */
function spawnAndWait(args: string[], timeoutMs: number): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`child did not exit within ${timeoutMs}ms; stderr=${stderr.slice(0, 800)}`));
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stderr });
    });
  });
}

describe('真进程：node dist/cli.js turn run（本地假 egress 端点，全链不触外网）', () => {
  it('产出合法 output.json：status=ok + 模型回复 + spans + engine + 出口归因', async () => {
    const egressSrv = await startFakeProvider(['本地', '假', '出口']);
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    const egressPath = join(dir, 'egress.json');
    writeFileSync(
      inputPath,
      JSON.stringify(
        envelope({
          turnId: 'msg_real_run',
          message: { text: '请回复' },
          systemPrompt: 'You are a test agent.',
          workdir: dir,
          deadlineMs: 30_000,
        }),
      ),
    );
    writeFileSync(
      egressPath,
      JSON.stringify(egress({ url: egressSrv.baseUrl, token: 'turn-egress-token-real' })),
      { mode: 0o600 },
    );

    try {
      // ⚠️ 必须用异步 spawn（不能用 spawnSync）：假 egress 跑在本进程里，
      // spawnSync 会阻塞事件循环 → 子进程的 HTTP 请求永远等不到响应（实测：
      // 整个 turn 卡到 deadline 才以 timeout 收场）。
      const child = await spawnAndWait(
        [CLI, 'turn', 'run', '--input', inputPath, '--output', outputPath, '--egress-file', egressPath, '--adapter', 'pi-core'],
        90_000,
      );
      expect(child.status).toBe(0);

      const written = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        protocolVersion: number;
        turnId: string;
        status: string;
        replyText?: string;
        spans?: { t7: number | null; t8: number | null };
        engine?: { adapter: string; version: string; model: string };
        providerSource?: string | null;
      };
      expect(written.protocolVersion).toBe(TURN_PROTOCOL_VERSION);
      expect(written.turnId).toBe('msg_real_run');
      expect(written.status).toBe('ok');
      expect(written.replyText).toBe('本地假出口');
      expect(written.engine?.adapter).toBe('pi-core');
      expect(written.providerSource).toBe('cloud-egress');
      expect(written.spans?.t7).toBeTypeOf('number');
      // t8 = 首个非空 delta（引擎真上报，不是 fallback）
      expect(written.spans?.t8).toBeTypeOf('number');
      // egress 文件已被 CLI 删除（凭据窗口 = turn 窗口）
      expect(existsSync(egressPath)).toBe(false);
      // 出口端点真的收到了请求，URL = baseURL + /chat/completions，Bearer = turn token 原样
      expect(egressSrv.requests).toHaveLength(1);
      expect(egressSrv.requests[0]!.url).toContain('/api/eaas-turn-egress/v1/chat/completions');
      expect(egressSrv.requests[0]!.authorization).toBe('Bearer turn-egress-token-real');
      expect((egressSrv.requests[0]!.body as { model?: string }).model).toBe('faux-1');
      expect(egressSrv.requests[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    } finally {
      await new Promise<void>((done) => egressSrv.server.close(() => done()));
    }
  });

  it('MUST-1 负控：真进程发出的 Authorization 是 `Bearer <turn-token>`（绝无 sk- 前缀）', async () => {
    // 结构性盲点：假 egress 接受任意 bearer，「前缀对不对」不会被它拒绝而暴露。
    // 这里直接核**记录下来的 Authorization 头**——pi-ai 时代的 C-1 前缀逻辑若被
    // 复用，turn token 会带着 sk- 前缀打出口面（HMAC 输入不同 → 401）。
    const egressSrv = await startFakeProvider(['bare']);
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    const egressPath = join(dir, 'egress.json');
    writeFileSync(
      inputPath,
      JSON.stringify(envelope({ turnId: 'msg_bare_token', workdir: dir })),
    );
    // ⚠️ token 不含 sk- 前缀（turn-egress 域的铸造形态）
    writeFileSync(egressPath, JSON.stringify(egress({ url: egressSrv.baseUrl })), { mode: 0o600 });

    try {
      const child = await spawnAndWait(
        [CLI, 'turn', 'run', '--input', inputPath, '--output', outputPath, '--egress-file', egressPath, '--adapter', 'pi-core'],
        90_000,
      );
      expect(child.status).toBe(0);
      expect(egressSrv.requests).toHaveLength(1);
      expect(egressSrv.requests[0]!.authorization).toBe('Bearer turn-egress-token-abc123');
    } finally {
      await new Promise<void>((done) => egressSrv.server.close(() => done()));
    }
  });

  it('负控：坏 envelope → 真进程 exit 70，且不产 output.json', () => {
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    const outputPath = join(dir, 'output.json');
    writeFileSync(inputPath, JSON.stringify({ protocolVersion: 1, turnId: 'x' }));
    writeFileSync(join(dir, 'egress.json'), JSON.stringify(egress()));
    const child = spawnSync(
      process.execPath,
      [CLI, 'turn', 'run', '--input', inputPath, '--output', outputPath, '--egress-file', join(dir, 'egress.json')],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.status).toBe(70);
    expect(child.stderr).toContain('input envelope rejected');
  });

  it('负控：缺 egress 文件 → 真进程 exit 70（凭据面缺失可见，不静默）', () => {
    const dir = makeTurnDir();
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify(envelope()));
    const child = spawnSync(
      process.execPath,
      [CLI, 'turn', 'run', '--input', inputPath, '--output', join(dir, 'output.json'), '--egress-file', join(dir, 'nope.json')],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.status).toBe(70);
    expect(child.stderr).toContain('turn egress file rejected');
  });

  it('负控：未知 adapter → exit 70（未知引擎不静默回退）', () => {
    const dir = makeTurnDir();
    const child = spawnSync(
      process.execPath,
      [CLI, 'turn', 'run', '--input', join(dir, 'i.json'), '--output', join(dir, 'o.json'), '--egress-file', join(dir, 'k'), '--adapter', 'hermes'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(child.status).toBe(70);
    expect(child.stderr).toContain("unsupported adapter 'hermes'");
  });
});
