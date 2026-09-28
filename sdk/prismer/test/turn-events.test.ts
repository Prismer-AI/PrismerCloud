// turn-events.test.ts — 工具事件写侧验收面（design §3.2 events.jsonl / §3.3 写侧）。
//
// 钉住的东西：seq 归属（写侧 1-based 单调）、一行一条的追加格式与 0600、量级上限
// （修6：达限停写但**终态 `tools[]` 完整**）、摘要截断与凭据剥离（防御纵深）、孤儿
// started 的如实呈现（修5），以及 turn 文件层的落点（events.jsonl 在 dirname(input)
// 下、tools[] 进 output.json）。cloud 侧轮询器的偏移/半行语义不在本文件（端口单测）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_SUMMARY_MAX_CHARS,
  TURN_EVENTS_FILENAME,
  TURN_PROTOCOL_VERSION,
  parseToolEventLine,
  type ToolEventInput,
  type ToolEventV1,
} from '../src/turn/protocol.js';
import {
  createToolEventWriter,
  runTurnFile,
  turnSessionClientOptions,
  type TurnSessionHandle,
} from '../src/turn/runner.js';

const tempDirs: string[] = [];
function makeDir(prefix = 'prismer-turn-events-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 读回 events.jsonl 的全部行（逐行解析——文件本身就是行协议）。 */
function readEventLines(path: string): ToolEventV1[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => parseToolEventLine(line));
}

const started = (name: string, argsSummary?: string): ToolEventInput => ({
  kind: 'tool_started',
  name,
  ...(argsSummary !== undefined ? { argsSummary } : {}),
});
const finished = (name: string, extra: Partial<ToolEventInput> = {}): ToolEventInput => ({
  kind: 'tool_finished',
  name,
  isError: false,
  ...extra,
});

describe('createToolEventWriter：seq 由写侧赋值（行序 ≡ seq 序）', () => {
  it('一行一个 JSON 对象，seq 从 1 起单调递增，at 是 ISO 时刻', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path });

    writer.record(started('bash', 'echo hi'));
    writer.record(finished('bash', { resultSummary: 'hi', durationMs: 12 }));
    writer.record(started('read', '{"path":"a.txt"}'));

    const raw = readFileSync(path, 'utf8');
    // 追加格式：恰 3 行、每行以换行收尾、无空行。
    expect(raw.split('\n')).toHaveLength(4);
    expect(raw.endsWith('\n')).toBe(true);
    const lines = readEventLines(path);
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    expect(lines.map((line) => `${line.kind}:${line.name}`)).toEqual([
      'tool_started:bash',
      'tool_finished:bash',
      'tool_started:read',
    ]);
    for (const line of lines) {
      expect(new Date(line.at).toISOString()).toBe(line.at);
    }
  });

  it('文件 0600（凭据面纪律同族：事件面同样只给 owner 读）', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    createToolEventWriter({ eventsPath: path }).record(started('bash'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('懒创建：没有任何事件 ⇒ 不落 events.jsonl（缺文件 = 零工具调用）', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path });
    expect(writer.summaries()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});

describe('量级上限（修6）：达限停写，但终态完整性不受影响', () => {
  it('条数上限：超出后不再追加，summaries() 仍然完整', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path, maxCount: 3 });

    for (let i = 0; i < 5; i += 1) {
      writer.record(started(`tool-${i}`));
      writer.record(finished(`tool-${i}`));
    }

    const lines = readEventLines(path);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    // 终态完整性：10 条事件折叠出的 5 行一个不少（超限只影响流式粒度）。
    const summaries = writer.summaries();
    expect(summaries).toHaveLength(5);
    expect(summaries.map((row) => row.name)).toEqual(['tool-0', 'tool-1', 'tool-2', 'tool-3', 'tool-4']);
    for (const row of summaries) expect(row.finishedAt).toBeTypeOf('string');
  });

  it('字节上限：先到先停，文件大小不越界', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path, maxBytes: 260 });
    for (let i = 0; i < 20; i += 1) {
      writer.record(started(`tool-${i}`, 'x'.repeat(80)));
      writer.record(finished(`tool-${i}`, { resultSummary: 'y'.repeat(80) }));
    }
    expect(statSync(path).size).toBeLessThanOrEqual(260);
    expect(writer.summaries()).toHaveLength(20);
  });

  it('上限为 0：一条都不写（停写是显式语义，不是「写满为止」）', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path, maxCount: 0 });
    writer.record(started('bash'));
    expect(existsSync(path)).toBe(false);
    expect(writer.summaries()).toHaveLength(1);
  });

  it('写盘失败（目录不存在）→ 不抛、停写，终态仍完整（事件写失败绝不改 turn 结果）', () => {
    const writer = createToolEventWriter({ eventsPath: join(makeDir(), 'nope', 'events.jsonl') });
    expect(() => writer.record(started('bash', 'echo hi'))).not.toThrow();
    expect(() => writer.record(finished('bash', { resultSummary: 'hi' }))).not.toThrow();
    expect(writer.summaries()).toHaveLength(1);
    expect(writer.summaries()[0]!.finishedAt).toBeTypeOf('string');
  });
});

describe('终态汇总折叠（tools[] 的来源）', () => {
  it('started + finished 折叠成一行：startedAt/finishedAt/durationMs/resultSummary 齐备', () => {
    const dir = makeDir();
    const writer = createToolEventWriter({ eventsPath: join(dir, TURN_EVENTS_FILENAME) });
    writer.record(started('bash', 'npm install --no-audit'));
    writer.record(finished('bash', { resultSummary: 'added 143 packages in 12s', durationMs: 12480 }));

    const summaries = writer.summaries();
    expect(summaries).toHaveLength(1);
    const row = summaries[0]!;
    expect(row.name).toBe('bash');
    expect(row.argsSummary).toBe('npm install --no-audit');
    expect(row.resultSummary).toBe('added 143 packages in 12s');
    expect(row.isError).toBe(false);
    expect(row.durationMs).toBe(12480);
    expect(new Date(row.startedAt).toISOString()).toBe(row.startedAt);
    expect(new Date(row.finishedAt!).toISOString()).toBe(row.finishedAt);
    expect(Date.parse(row.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(row.startedAt));
  });

  it('孤儿 started（取消/超时，修5）：如实呈现，无 finishedAt，不补写', () => {
    const dir = makeDir();
    const writer = createToolEventWriter({ eventsPath: join(dir, TURN_EVENTS_FILENAME) });
    writer.record(started('bash', 'sleep 600'));
    // 没有 finished：turn 被取消/超时。
    const summaries = writer.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.name).toBe('bash');
    expect(summaries[0]!.startedAt).toBeTypeOf('string');
    expect('finishedAt' in summaries[0]!).toBe(false);
  });

  it('同名并行：finished 与最近一条未配对 started 配对，剩下的仍是孤儿', () => {
    const dir = makeDir();
    const writer = createToolEventWriter({ eventsPath: join(dir, TURN_EVENTS_FILENAME) });
    writer.record(started('bash', 'first'));
    writer.record(started('bash', 'second'));
    writer.record(finished('bash', { resultSummary: 'done', durationMs: 5 }));
    const summaries = writer.summaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.filter((row) => row.finishedAt !== undefined)).toHaveLength(1);
  });

  it('summaries() 返回快照：调用方拿到后不被后续 record 改写', () => {
    const dir = makeDir();
    const writer = createToolEventWriter({ eventsPath: join(dir, TURN_EVENTS_FILENAME) });
    writer.record(started('bash'));
    const snapshot = writer.summaries();
    writer.record(finished('bash', { resultSummary: 'late' }));
    expect(snapshot[0]!.finishedAt).toBeUndefined();
    expect(snapshot[0]!.resultSummary).toBeUndefined();
    expect(writer.summaries()[0]!.finishedAt).toBeTypeOf('string');
  });
});

describe('摘要：凭据剥离与截断（防御纵深——产生侧之外再洗一次）', () => {
  it('Bearer / sk- 形态在落盘前被剥掉（文件与终态都不含）', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path });
    writer.record(
      started('bash', 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload" -H "x-key: sk-live-abcdef123456"'),
    );
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload');
    expect(raw).not.toContain('sk-live-abcdef123456');
    expect(raw).toContain('Bearer [redacted]');
    expect(raw).toContain('sk-[redacted]');
    expect(writer.summaries()[0]!.argsSummary).not.toContain('sk-live-abcdef123456');
  });

  it('超长摘要落盘前截到 ≤500（含 …(+N chars) 标记），终态与文件同源', () => {
    const dir = makeDir();
    const path = join(dir, TURN_EVENTS_FILENAME);
    const writer = createToolEventWriter({ eventsPath: path });
    writer.record(finished('bash', { resultSummary: 'y'.repeat(900) }));
    const line = readEventLines(path)[0]!;
    expect(line.resultSummary!.length).toBe(TOOL_SUMMARY_MAX_CHARS);
    expect(line.resultSummary!.endsWith('…(+413 chars)')).toBe(true);
    expect(writer.summaries()[0]!.resultSummary).toBe(line.resultSummary);
  });
});

// ── turn 文件层：events.jsonl 落点 + output.json.tools[] ─────────────────────

function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: 'msg_events_1',
    message: { text: 'hello' },
    history: [],
    systemPrompt: 'You are a test agent.',
    workdir: '/tmp',
    deadlineMs: 30_000,
    cancelFile: '/tmp/never-cancel',
    ...overrides,
  };
}

const egressFixture = {
  protocolVersion: TURN_PROTOCOL_VERSION,
  url: 'http://127.0.0.1:1/api/eaas-turn-egress/v1',
  token: 'turn-egress-token-abc123',
  model: 'faux-1',
  provider: 'cloud-egress',
};

/** 注入用假 session：捕获 sink，按脚本产生工具事件。 */
function makeScriptedSession(script: { finalText?: string; emit?: ToolEventInput[] }): {
  handle: TurnSessionHandle;
  captured: { onToolEvent?: (event: ToolEventInput) => void };
} {
  const captured: { onToolEvent?: (event: ToolEventInput) => void } = {};
  const handle: TurnSessionHandle = {
    async run() {
      for (const event of script.emit ?? []) captured.onToolEvent?.(event);
      return { finalText: script.finalText ?? 'ok', usage: { inputTokens: 1, outputTokens: 2 }, timeline: [] };
    },
    subscribe: () => () => undefined,
    async interrupt() {
      /* no-op */
    },
    async close() {
      /* no-op */
    },
  };
  return { handle, captured };
}

function makeTurnDir(): { dir: string; inputPath: string; outputPath: string; egressPath: string } {
  const dir = makeDir();
  return {
    dir,
    inputPath: join(dir, 'input.json'),
    outputPath: join(dir, 'output.json'),
    egressPath: join(dir, 'egress.json'),
  };
}

describe('runTurnFile：工具事件落 turn 目录，终态进 output.json', () => {
  it('events.jsonl 在 dirname(--input) 下逐行追加；output.json 带 v2 tools[]', async () => {
    const { dir, inputPath, outputPath, egressPath } = makeTurnDir();
    // 故意把 output 放到另一个目录：events 的落点只认 input 所在目录（turn 目录约定）。
    const otherDir = makeDir();
    writeFileSync(inputPath, JSON.stringify(envelopeFixture()));
    writeFileSync(egressPath, JSON.stringify(egressFixture), { mode: 0o600 });

    const session = makeScriptedSession({
      finalText: 'done',
      emit: [
        { kind: 'tool_started', name: 'bash', argsSummary: 'npm install --no-audit' },
        { kind: 'tool_finished', name: 'bash', resultSummary: 'added 143 packages in 12s', isError: false, durationMs: 12480 },
      ],
    });
    const code = await runTurnFile({
      inputPath,
      outputPath: join(otherDir, 'output.json'),
      egressFilePath: egressPath,
      deps: {
        createSession: async (args) => {
          session.captured.onToolEvent = args.onToolEvent;
          return session.handle;
        },
      },
    });

    expect(code).toBe(0);
    const eventsPath = join(dir, TURN_EVENTS_FILENAME);
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readEventLines(eventsPath);
    expect(lines.map((line) => `${line.seq}:${line.kind}:${line.name}`)).toEqual([
      '1:tool_started:bash',
      '2:tool_finished:bash',
    ]);
    expect(statSync(eventsPath).mode & 0o777).toBe(0o600);
    // events 落在 input 所在目录，不在 output 目录。
    expect(existsSync(join(otherDir, TURN_EVENTS_FILENAME))).toBe(false);

    const written = JSON.parse(readFileSync(join(otherDir, 'output.json'), 'utf8')) as {
      protocolVersion: number;
      status: string;
      tools?: Array<Record<string, unknown>>;
    };
    expect(written.protocolVersion).toBe(TURN_PROTOCOL_VERSION);
    expect(written.status).toBe('ok');
    expect(written.tools).toHaveLength(1);
    expect(written.tools![0]).toMatchObject({
      name: 'bash',
      argsSummary: 'npm install --no-audit',
      resultSummary: 'added 143 packages in 12s',
      isError: false,
      durationMs: 12480,
    });
    expect(written.tools![0]!.finishedAt).toBeTypeOf('string');
  });

  it('本轮没有工具调用 ⇒ 不落 events.jsonl，output.json 无 tools 字段', async () => {
    const { dir, inputPath, outputPath, egressPath } = makeTurnDir();
    writeFileSync(inputPath, JSON.stringify(envelopeFixture()));
    writeFileSync(egressPath, JSON.stringify(egressFixture), { mode: 0o600 });

    const code = await runTurnFile({
      inputPath,
      outputPath,
      egressFilePath: egressPath,
      deps: { createSession: async () => makeScriptedSession({}).handle },
    });

    expect(code).toBe(0);
    expect(existsSync(join(dir, TURN_EVENTS_FILENAME))).toBe(false);
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    expect('tools' in written).toBe(false);
  });

  it('负控：events.jsonl 写不进去（路径被占用）→ turn 照常结束，终态仍完整、失败可见', async () => {
    const { dir, inputPath, outputPath, egressPath } = makeTurnDir();
    writeFileSync(inputPath, JSON.stringify(envelopeFixture()));
    writeFileSync(egressPath, JSON.stringify(egressFixture), { mode: 0o600 });
    // 故障注入：把 events.jsonl 这个路径做成**目录**——appendFileSync 必然 EISDIR。
    mkdirSync(join(dir, TURN_EVENTS_FILENAME));

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const session = makeScriptedSession({
      finalText: 'survived',
      emit: [
        { kind: 'tool_started', name: 'bash', argsSummary: 'echo hi' },
        { kind: 'tool_finished', name: 'bash', resultSummary: 'hi', isError: false, durationMs: 3 },
      ],
    });
    let code: number;
    try {
      code = await runTurnFile({
        inputPath,
        outputPath,
        egressFilePath: egressPath,
        deps: {
          createSession: async (args) => {
            session.captured.onToolEvent = args.onToolEvent;
            return session.handle;
          },
        },
      });
    } finally {
      spy.mockRestore();
    }

    // §5 失败矩阵：事件写失败绝不改 turn 结果——exit 0 + status ok + 回复照旧。
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      status: string;
      replyText: string;
      tools?: Array<Record<string, unknown>>;
    };
    expect(written.status).toBe('ok');
    expect(written.replyText).toBe('survived');
    // 失败可见（不静默），且终态 tools[] 完整（修6：终态不依赖流式写盘）。
    expect(stderr.join('')).toContain('tool event append failed');
    expect(written.tools).toHaveLength(1);
    expect(written.tools![0]!.finishedAt).toBeTypeOf('string');
  });
});

describe('turn 会话装配：EaaS turn 恒开 shell（§3.1 修1）', () => {
  it('turnSessionClientOptions 显式 allowShell=true（缺省不传 = daemon 路径零变化）', () => {
    expect(turnSessionClientOptions().allowShell).toBe(true);
    const sink = (): void => undefined;
    expect(turnSessionClientOptions(sink).onToolEvent).toBe(sink);
    expect(turnSessionClientOptions().onToolEvent).toBeUndefined();
  });
});
