// Gate B+ Task 7 — TurnEnvelopeV1 / TurnResultV1 协议 fixture（design §2.4 逐字）。
//
// 两侧钉住的东西：cloud 端口写什么、CLI 读什么、结果读回什么。协议字段名/取值集合
// 改动会让本文件先红（cloud 侧镜像断言在 src/tenant/__tests__/agent-turn-runtime.test.ts）。

import { describe, expect, it } from 'vitest';
import {
  TURN_EVENTS_FILENAME,
  TURN_EVENTS_MAX_BYTES,
  TURN_EVENTS_MAX_COUNT,
  TURN_PROTOCOL_VERSION,
  TOOL_SUMMARY_MAX_CHARS,
  TurnProtocolError,
  collapseErrorMessage,
  parseToolEventLine,
  parseTurnEgress,
  parseTurnEnvelope,
  parseTurnResult,
  sanitizeToolSummary,
  summarizeToolArgs,
  summarizeToolResult,
} from '../src/turn/protocol.js';

/** 与 cloud 端口产出的 envelope 同形的最小 fixture。 */
function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: TURN_PROTOCOL_VERSION,
    turnId: 'msg_fixture_1',
    message: {
      text: '这张图里是什么？',
      contentBlocks: [
        { kind: 'text', text: '这张图里是什么？' },
        {
          kind: 'image',
          assetId: 'ast_fixture',
          path: '/home/agent/workspace/.eaas/turns/msg_fixture_1/inputs/ast_fixture.png',
          mediaType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          alt: '截图',
        },
      ],
    },
    history: [
      { role: 'principal', content: '你好' },
      { role: 'agent', content: '你好，有什么可以帮你？' },
    ],
    systemPrompt: 'You are the hosted agent inside a Prismer EaaS environment.',
    tools: [
      { name: 'bash', kind: 'builtin', enabled: true },
      { name: 'read', kind: 'builtin', enabled: true },
      { name: 'write', kind: 'builtin', enabled: true },
      { name: 'edit', kind: 'builtin', enabled: true },
      {
        name: 'mcp',
        kind: 'component',
        enabled: true,
        source: 'pi-mcp-adapter',
        version: '2.36.0',
        config: { servers: [{ name: 'docs', url: 'https://mcp.example.test/rpc' }] },
      },
    ],
    workdir: '/home/agent/workspace',
    deadlineMs: 120000,
    cancelFile: '/home/agent/workspace/.eaas/turns/msg_fixture_1/cancel',
    ...overrides,
  };
}

describe('TurnEnvelopeV1：接受合法 envelope（逐字段保真）', () => {
  it('round-trip：字段名与取值原样保留（含 image 块的 path 与 dataUrl 双载）', () => {
    const parsed = parseTurnEnvelope(envelopeFixture());
    expect(parsed.protocolVersion).toBe(TURN_PROTOCOL_VERSION);
    expect(parsed.turnId).toBe('msg_fixture_1');
    expect(parsed.message.text).toBe('这张图里是什么？');
    expect(parsed.message.contentBlocks).toHaveLength(2);
    expect(parsed.message.contentBlocks![1]).toEqual({
      kind: 'image',
      assetId: 'ast_fixture',
      path: '/home/agent/workspace/.eaas/turns/msg_fixture_1/inputs/ast_fixture.png',
      mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      alt: '截图',
    });
    expect(parsed.history.map((h) => `${h.role}:${h.content}`)).toEqual([
      'principal:你好',
      'agent:你好，有什么可以帮你？',
    ]);
    expect(parsed.workdir).toBe('/home/agent/workspace');
    expect(parsed.tools).toEqual([
      { name: 'bash', kind: 'builtin', enabled: true },
      { name: 'read', kind: 'builtin', enabled: true },
      { name: 'write', kind: 'builtin', enabled: true },
      { name: 'edit', kind: 'builtin', enabled: true },
      {
        name: 'mcp',
        kind: 'component',
        enabled: true,
        source: 'pi-mcp-adapter',
        version: '2.36.0',
        config: { servers: [{ name: 'docs', url: 'https://mcp.example.test/rpc' }] },
      },
    ]);
    expect(parsed.deadlineMs).toBe(120000);
    expect(parsed.cancelFile).toContain('/cancel');
  });

  it('无 contentBlocks / tools 的纯文本 turn 合法（history 缺省 = 空，旧 cloud 缺省不变）', () => {
    const parsed = parseTurnEnvelope(
      envelopeFixture({ message: { text: 'hi' }, history: undefined, systemPrompt: undefined, tools: undefined }),
    );
    expect(parsed.message.contentBlocks).toBeUndefined();
    expect(parsed.history).toEqual([]);
    expect(parsed.systemPrompt).toBe('');
    expect(parsed.tools).toBeUndefined();
  });
});

describe('TurnEnvelopeV1：坏输入必须可见失败（不静默补默认值）', () => {
  it('bounds historical messages and combined current/history image counts', () => {
    expect(() => parseTurnEnvelope(envelopeFixture({ history: Array.from({ length: 13 }, () => ({ role: 'principal', content: 'old' })) }))).toThrow(/history window/);
    const image = { kind: 'image', assetId: 'old', path: '/tmp/old.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' };
    expect(() => parseTurnEnvelope(envelopeFixture({ history: [{ role: 'principal', content: 'old', contentBlocks: [image, image, image, image] }] }))).toThrow(/image budget/);
  });
  it('bounds decoded image bytes before passing data to the provider', () => {
    const image = { kind: 'image', assetId: 'large', path: '/tmp/large.png', mediaType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}` };
    expect(() => parseTurnEnvelope(envelopeFixture({ message: { text: 'image', contentBlocks: [image] } }))).toThrow(/byte budget/);
  });
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    // v2 纪律（§3.2 版本纪律，照 MUST-1 先例）：v1 envelope 在 v2 runtime 上**明确拒绝**
    // （反之旧 bundle 收到 v2 会以同一行拒绝——旧 bundle 的真机路径靠 bundle floor 探测覆盖）。
    ['协议版本 v1（旧 cloud / 旧 bundle）', { protocolVersion: 1 }, /unsupported protocolVersion 1 \(this runtime speaks 2\)/],
    [
      'legacy providers[] 块（cloud 早于本 runtime）→ 明确拒绝，不静默忽略',
      { providers: [{ id: 'x', baseUrl: 'https://x', apiMode: 'openai-completions', model: 'm' }] },
      /legacy providers\[\] block/,
    ],
    ['workdir 缺失', { workdir: undefined }, /workdir must be a non-empty string/],
    ['deadlineMs 非数', { deadlineMs: 'soon' }, /deadlineMs must be a finite number/],
    ['tools 非数组', { tools: { name: 'bash' } }, /tools must be an array/],
    [
      'tool 声明 name 缺失',
      { tools: [{ kind: 'builtin', enabled: true }] },
      /tools\[0\]\.name must be a non-empty string/,
    ],
    [
      'image 块缺 path',
      {
        message: {
          text: 'x',
          contentBlocks: [{ kind: 'image', assetId: 'a', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
        },
      },
      /message\.contentBlocks\[0\]\.path must be a non-empty string/,
    ],
    [
      '未知块 kind',
      { message: { text: 'x', contentBlocks: [{ kind: 'audio', assetId: 'a' }] } },
      /message\.contentBlocks\[0\]\.kind must be 'text' \| 'image'/,
    ],
    ['history role 非法', { history: [{ role: 'system', content: 'x' }] }, /history\[0\]\.role must be/],
  ];

  for (const [name, overrides, pattern] of cases) {
    it(`拒绝：${name}`, () => {
      expect(() => parseTurnEnvelope(envelopeFixture(overrides))).toThrow(TurnProtocolError);
      expect(() => parseTurnEnvelope(envelopeFixture(overrides))).toThrow(pattern);
    });
  }

  it('拒绝：顶层不是对象', () => {
    expect(() => parseTurnEnvelope([])).toThrow(/must be a JSON object/);
    expect(() => parseTurnEnvelope('nope')).toThrow(TurnProtocolError);
  });
});

describe('TurnResultV1：ok / error / canceled 三态', () => {
  it('ok：replyText + usage + spans + engine + providerSource', () => {
    const parsed = parseTurnResult({
      protocolVersion: TURN_PROTOCOL_VERSION,
      turnId: 'msg_1',
      status: 'ok',
      replyText: '答案',
      usage: { promptTokens: 11, completionTokens: 22 },
      spans: { t7: 1000, t8: 1042 },
      engine: { adapter: 'pi-core', version: '2.2.59', model: 'deepseek-v4-flash' },
      providerSource: 'deepseek',
    });
    expect(parsed.status).toBe('ok');
    expect(parsed.replyText).toBe('答案');
    expect(parsed.usage).toEqual({ promptTokens: 11, completionTokens: 22 });
    expect(parsed.spans).toEqual({ t7: 1000, t8: 1042 });
    expect(parsed.engine).toEqual({ adapter: 'pi-core', version: '2.2.59', model: 'deepseek-v4-flash' });
    expect(parsed.providerSource).toBe('deepseek');
  });

  it('error：code 白名单外的值归一到 internal（不把上游字符串透传成新码）', () => {
    const parsed = parseTurnResult({
      protocolVersion: TURN_PROTOCOL_VERSION,
      turnId: 'msg_1',
      status: 'error',
      error: { code: 'something_upstream_invented', message: 'boom' },
    });
    expect(parsed.status).toBe('error');
    expect(parsed.error?.code).toBe('internal');
  });

  it('canceled：包装器命中取消哨兵后写下的形态（无 replyText/error）', () => {
    const parsed = parseTurnResult({ protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'msg_1', status: 'canceled' });
    expect(parsed.status).toBe('canceled');
    expect(parsed.replyText).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  it('负控：status 非法 / 版本不符 → TurnProtocolError', () => {
    expect(() => parseTurnResult({ protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'm', status: 'done' })).toThrow(TurnProtocolError);
    expect(() => parseTurnResult({ protocolVersion: 9, turnId: 'm', status: 'ok' })).toThrow(/unsupported result protocolVersion 9/);
  });

  it('spans 里非数（null）保留为 null —— 「引擎没观测到」与「没有该字段」同义', () => {
    const parsed = parseTurnResult({ protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'm', status: 'ok', spans: { t7: 5, t8: null } });
    expect(parsed.spans).toEqual({ t7: 5, t8: null });
  });
});

describe('TurnResultV2：版本纪律与 tools[] 终态汇总（§3.2）', () => {
  it('负控（T5 ①）：v1 output.json 被 v2 解析器**明确拒绝**，不静默按 v2 读', () => {
    expect(() => parseTurnResult({ protocolVersion: 1, turnId: 'msg_1', status: 'ok', replyText: 'x' })).toThrow(
      /v1 result rejected: the writer is a pre-v2 runtime/,
    );
    expect(() => parseTurnResult({ protocolVersion: 1, turnId: 'msg_1', status: 'ok' })).toThrow(TurnProtocolError);
  });

  it('tools[]：成对行 + 孤儿 started（修5：如实呈现，无 finishedAt，不补写）', () => {
    const parsed = parseTurnResult({
      protocolVersion: TURN_PROTOCOL_VERSION,
      turnId: 'msg_1',
      status: 'ok',
      replyText: 'done',
      tools: [
        {
          name: 'bash',
          argsSummary: 'npm install --no-audit',
          resultSummary: 'added 143 packages in 12s',
          isError: false,
          durationMs: 12480,
          startedAt: '2026-09-21T02:00:00.000Z',
          finishedAt: '2026-09-21T02:00:12.480Z',
        },
        // 取消留下的孤儿：只有 started。
        { name: 'write', argsSummary: '{"path":"a.txt"}', startedAt: '2026-09-21T02:00:13.000Z' },
      ],
    });
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools![0]).toEqual({
      name: 'bash',
      argsSummary: 'npm install --no-audit',
      resultSummary: 'added 143 packages in 12s',
      isError: false,
      durationMs: 12480,
      startedAt: '2026-09-21T02:00:00.000Z',
      finishedAt: '2026-09-21T02:00:12.480Z',
    });
    expect(parsed.tools![1]!.finishedAt).toBeUndefined();
  });

  it('tools[] 坏形态 → TurnProtocolError（缺 name / 缺 startedAt / 非数组）', () => {
    const base = { protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'm', status: 'ok' as const };
    expect(() => parseTurnResult({ ...base, tools: [{ startedAt: 'x' }] })).toThrow(/result\.tools\[0\]\.name/);
    expect(() => parseTurnResult({ ...base, tools: [{ name: 'bash' }] })).toThrow(/result\.tools\[0\]\.startedAt/);
    expect(() => parseTurnResult({ ...base, tools: 'nope' })).toThrow(/result\.tools must be an array/);
  });

  it('tools[] 摘要读侧再截断（防御纵深：手写 10KB 摘要读回 ≤500）', () => {
    const parsed = parseTurnResult({
      protocolVersion: TURN_PROTOCOL_VERSION,
      turnId: 'm',
      status: 'ok',
      tools: [{ name: 'bash', argsSummary: 'x'.repeat(900), startedAt: 't0' }],
    });
    const summary = parsed.tools![0]!.argsSummary!;
    expect(summary.length).toBe(TOOL_SUMMARY_MAX_CHARS);
    const marker = '…(+413 chars)';
    expect(summary.endsWith(marker)).toBe(true);
    // N = 实际未显示的字符数：487 字符头 + 413 = 900（不是「原长度 - 500」）。
    expect(summary.slice(0, -marker.length).length + 413).toBe(900);
  });

  it('无 tools 字段 → 缺省（本轮没有工具调用，不是空数组）', () => {
    const parsed = parseTurnResult({ protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'm', status: 'ok' });
    expect(parsed.tools).toBeUndefined();
  });
});

describe('events.jsonl：行 schema（§3.2）与常量', () => {
  const lineFixture = (overrides: Record<string, unknown> = {}) => ({
    seq: 1,
    at: '2026-09-21T02:00:00.000Z',
    kind: 'tool_started',
    name: 'bash',
    argsSummary: 'npm install --no-audit',
    ...overrides,
  });

  it('常量：文件名与两个量级上限（修6）钉死', () => {
    expect(TURN_EVENTS_FILENAME).toBe('events.jsonl');
    expect(TURN_EVENTS_MAX_COUNT).toBe(200);
    expect(TURN_EVENTS_MAX_BYTES).toBe(512 * 1024);
    expect(TOOL_SUMMARY_MAX_CHARS).toBe(500);
    expect(TURN_PROTOCOL_VERSION).toBe(2);
  });

  it('合法行：逐字段保真（started / finished 两形态）', () => {
    const started = parseToolEventLine(
      JSON.stringify(lineFixture()),
    );
    expect(started).toEqual({
      seq: 1,
      at: '2026-09-21T02:00:00.000Z',
      kind: 'tool_started',
      name: 'bash',
      argsSummary: 'npm install --no-audit',
    });
    const finished = parseToolEventLine(
      JSON.stringify(
        lineFixture({ seq: 2, kind: 'tool_finished', resultSummary: 'added 143 packages in 12s', isError: false, durationMs: 12480, argsSummary: undefined }),
      ),
    );
    expect(finished.kind).toBe('tool_finished');
    expect(finished.isError).toBe(false);
    expect(finished.durationMs).toBe(12480);
    expect(finished.argsSummary).toBeUndefined();
  });

  const badLines: Array<[string, string, RegExp]> = [
    ['空行', '', /tool event line is empty/],
    ['非 JSON', '{not json', /tool event line is not JSON/],
    ['非对象', '[1,2]', /tool event must be a JSON object/],
    ['未知 kind', JSON.stringify(lineFixture({ kind: 'tool_other' })), /kind must be 'tool_started' \| 'tool_finished'/],
    ['seq 非正整数', JSON.stringify(lineFixture({ seq: 0 })), /seq must be a positive integer/],
    ['seq 非整数', JSON.stringify(lineFixture({ seq: 1.5 })), /seq must be a positive integer/],
    ['缺 name', JSON.stringify(lineFixture({ name: '' })), /toolEvent\.name must be a non-empty string/],
    ['缺 at', JSON.stringify(lineFixture({ at: undefined })), /toolEvent\.at must be a non-empty string/],
  ];

  for (const [label, line, pattern] of badLines) {
    it(`拒绝：${label}`, () => {
      expect(() => parseToolEventLine(line)).toThrow(TurnProtocolError);
      expect(() => parseToolEventLine(line)).toThrow(pattern);
    });
  }

  it('超长摘要读回截断 ≤500（含 …(+N chars) 标记）', () => {
    const event = parseToolEventLine(JSON.stringify(lineFixture({ argsSummary: 'y'.repeat(700) })));
    expect(event.argsSummary!.length).toBe(TOOL_SUMMARY_MAX_CHARS);
    expect(event.argsSummary!.endsWith('…(+213 chars)')).toBe(true);
  });

  it('凭据读侧再剥（Bearer / sk-）', () => {
    const event = parseToolEventLine(
      JSON.stringify(lineFixture({ argsSummary: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload" -H "x-api-key: sk-live-abcdef123456"' })),
    );
    expect(event.argsSummary).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload');
    expect(event.argsSummary).toContain('Bearer [redacted]');
    expect(event.argsSummary).not.toContain('sk-live-abcdef123456');
    expect(event.argsSummary).toContain('sk-[redacted]');
  });
});

describe('摘要清洗（sanitizeToolSummary / summarizeTool*）', () => {
  it('截断：恰好 500 字符，标记含实际丢弃数', () => {
    const out = sanitizeToolSummary('z'.repeat(1234));
    expect(out.length).toBe(TOOL_SUMMARY_MAX_CHARS);
    expect(out.slice(0, 10)).toBe('z'.repeat(10));
    // 487 字符头 + `…(+747 chars)` 标记 = 500；N 覆盖了标记自身占用的额度。
    const marker = '…(+747 chars)';
    expect(out.endsWith(marker)).toBe(true);
    expect(out.slice(0, -marker.length).length + 747).toBe(1234);
  });

  it('≤500 的值原样保留（不截断、不加标记）', () => {
    expect(sanitizeToolSummary('short summary')).toBe('short summary');
    expect(sanitizeToolSummary('a'.repeat(500)).length).toBe(500);
  });

  it('压平空白（摘要恒单行——JSONL 一行一条）', () => {
    expect(sanitizeToolSummary('line1\n\nline2\t\tline3')).toBe('line1 line2 line3');
  });

  it('字面量密钥逐值剥掉（出口 token 不是 sk- 形态，靠 secrets 列表命中）', () => {
    const token = 'turn-egress-token-abc123';
    const out = sanitizeToolSummary(`curl -H "Authorization: Bearer ${token}"`, [token]);
    expect(out).not.toContain(token);
    expect(out).toContain('[redacted]');
    // 短值不参与逐值剥（避免把普通文本打散）。
    expect(sanitizeToolSummary('abc', ['abc'])).toBe('abc');
  });

  it('summarizeToolArgs：对象走 JSON，字符串原样，不可序列化不抛', () => {
    expect(summarizeToolArgs({ path: 'a.txt', content: 'hi' })).toBe('{"path":"a.txt","content":"hi"}');
    expect(summarizeToolArgs('plain')).toBe('plain');
    expect(summarizeToolArgs(undefined)).toBe('');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => summarizeToolArgs(circular)).not.toThrow();
    expect(summarizeToolArgs(circular)).toContain('[object Object]');
  });

  it('summarizeToolResult：取 content 的 text 块（多块换行拼接）', () => {
    expect(summarizeToolResult({ content: [{ type: 'text', text: 'out-1' }, { type: 'text', text: 'out-2' }] })).toBe('out-1 out-2');
    expect(summarizeToolResult({ content: [{ type: 'image', data: 'x' }] })).toContain('"type":"image"');
    expect(summarizeToolResult(undefined)).toBe('');
  });
});

describe('TurnEgressV1：出口凭据文件（MUST-1——pod 内没有 provider key）', () => {
  const egressFixture = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: TURN_PROTOCOL_VERSION,
    url: 'https://cloud.test/api/eaas-turn-egress/v1',
    token: 'eyJ2IjoxLCJlbnZJZCI6ImVudiJ9.mac',
    model: 'deepseek-v4-flash',
    provider: 'cloud-egress',
    ...overrides,
  });

  it('round-trip：url/token/model/provider 逐字段保真', () => {
    const parsed = parseTurnEgress(egressFixture());
    expect(parsed.protocolVersion).toBe(TURN_PROTOCOL_VERSION);
    expect(parsed.url).toBe('https://cloud.test/api/eaas-turn-egress/v1');
    expect(parsed.token).toBe('eyJ2IjoxLCJlbnZJZCI6ImVudiJ9.mac');
    expect(parsed.model).toBe('deepseek-v4-flash');
    expect(parsed.provider).toBe('cloud-egress');
  });

  it('负控：缺 token / 缺 url / 版本不符 → TurnProtocolError（凭据面绝不静默补默认）', () => {
    expect(() => parseTurnEgress(egressFixture({ token: '' }))).toThrow(/egress\.token must be a non-empty string/);
    expect(() => parseTurnEgress(egressFixture({ url: '' }))).toThrow(/egress\.url must be a non-empty string/);
    expect(() => parseTurnEgress(egressFixture({ protocolVersion: 1 }))).toThrow(/unsupported egress protocolVersion 1 \(this runtime speaks 2\)/);
    expect(() => parseTurnEgress('nope')).toThrow(/turn egress must be a JSON object/);
  });
});

describe('错误文本', () => {
  it('collapseErrorMessage：压平空白并截到 500 字符', () => {
    const raw = `line1\nline2\t\tline3 ${'x'.repeat(600)}`;
    const collapsed = collapseErrorMessage(raw);
    expect(collapsed).not.toContain('\n');
    expect(collapsed).not.toContain('\t');
    expect(collapsed.length).toBe(500);
  });

  it('错误体 message 同样压平（与 task_result ≤500 契约同口径）', () => {
    const parsed = parseTurnResult({ protocolVersion: TURN_PROTOCOL_VERSION, turnId: 'm', status: 'ok', error: { code: 'internal', message: 'a\nb' } });
    expect(parsed.error?.message).toBe('a b');
  });
});
