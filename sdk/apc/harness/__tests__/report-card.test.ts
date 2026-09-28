/**
 * report-card.ts + card-scan.ts 验收（§2 code 模块：真副作用 + 负控 + 铁律 1/2）。
 *
 * 分层（照 apc/11 §0.7 的验证层级）：
 *   (a) 纯函数层：`buildReportCardContent` 产出真过 `parsePkf`+`validatePkf` 的 PKF；
 *       负控 = 非法 view / 坏 TierResult cell / 空表 → throw 且**不写**。
 *   (b) 生成器 + 注入 writer：合法 → writer 收到 pageType/visibility；非法 → writer 零调用
 *       （不产废卡的 unit 侧 oracle）。
 *   (c) 传输层：`createMemoryResolveWriter` / `createCloudCardPagesLister` **不 mock fetch**
 *       —— 起真 `node:http` server，oracle = server 实收 method/path/body。
 *
 * 真栈（本机 cloud:3000 + MySQL:3307）的 DB 三表 oracle 在 e2e-playwright/specs/
 * pkf4-report-card-dataview.spec.ts（需活 cloud，不进 vitest 默认门）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePkf, validatePkf } from '../../../../src/lib/pkf';
import {
  buildReportCardContent,
  createMemoryPageReader,
  createMemoryResolveWriter,
  generateReportCard,
  ReportCardError,
  REPORT_CARD_PAGE_TYPE,
  type GenerateReportCardInput,
  type MemoryPageWriter,
} from '../report-card';
import { createCloudCardPagesLister, scanCards } from '../card-scan';
import type { ApcCardPage } from '../card-scan';

const BASE_INPUT: GenerateReportCardInput = {
  workspaceId: 'ws_123',
  taskId: 'task_abc',
  path: 'cards/report-demo',
  title: '顶栏透明度实施报告',
  description: 'M4 样例1 report card',
  conclusion: '视觉基线 T3 通过，选层回归 T2 通过。',
  tierResults: [
    { criterion: '视觉基线', tier: 'T3', status: 'pass' },
    { criterion: '选层回归', tier: 'T2', status: 'pass' },
  ],
  beforeAssetId: 'asset_before',
  afterAssetId: 'asset_after',
  mainCardUri: 'prismer://workspace/ws_123/memory/cards/feature-topbar',
};

// ─── (a) 纯函数：合法 PKF ─────────────────────────────────────────────────────

describe('buildReportCardContent → 合法 PKF', () => {
  it('产出过 validatePkf 的 report-card（含 data table / 截图 figure / 主卡 typed link）', () => {
    const content = buildReportCardContent(BASE_INPUT);
    const parsed = parsePkf(content);
    const result = validatePkf(parsed);
    expect(result.ok).toBe(true);

    expect(parsed.frontmatter?.type).toBe(REPORT_CARD_PAGE_TYPE);
    expect(parsed.frontmatter?.visibility).toBe('task:task_abc');

    // <prismer-data> table 携带 criterion 行。
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].view).toBe('table');
    expect(parsed.data[0].format).toBe('csv');
    expect(parsed.data[0].inlineData).toContain('视觉基线,T3,pass');

    // 主卡 typed link（rel=supports，host=workspace 合法）。
    const supports = parsed.links.find((l) => l.relation === 'supports');
    expect(supports?.targetUri).toBe('prismer://workspace/ws_123/memory/cards/feature-topbar');

    // before/after 截图 media 引 prismer://asset。
    expect(parsed.media.map((m) => m.src)).toEqual([
      'prismer://asset/asset_before',
      'prismer://asset/asset_after',
    ]);
  });

  it('无截图/无主卡时仍合法（可选字段缺省）', () => {
    const content = buildReportCardContent({
      ...BASE_INPUT,
      beforeAssetId: undefined,
      afterAssetId: undefined,
      mainCardUri: undefined,
    });
    expect(validatePkf(parsePkf(content)).ok).toBe(true);
  });
});

// ─── (a) 负控：坏输入 → throw，不产内容 ───────────────────────────────────────

describe('buildReportCardContent 负控', () => {
  it('TierResult cell 含逗号 → ReportCardError(report-card-invalid-tier-row)', () => {
    expect(() =>
      buildReportCardContent({
        ...BASE_INPUT,
        tierResults: [{ criterion: '基线,注入', tier: 'T3', status: 'pass' }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'report-card-invalid-tier-row' }) as unknown as Error);
  });

  it('空 TierResult 表 → ReportCardError(report-card-empty-tier)', () => {
    expect(() => buildReportCardContent({ ...BASE_INPUT, tierResults: [] })).toThrowError(
      expect.objectContaining({ code: 'report-card-empty-tier' }) as unknown as Error,
    );
  });

  it('缺 taskId → ReportCardError(report-card-no-task)', () => {
    expect(() => buildReportCardContent({ ...BASE_INPUT, taskId: '' })).toThrowError(
      expect.objectContaining({ code: 'report-card-no-task' }) as unknown as Error,
    );
  });

  it('非法 view → 产出 PKF 不过 validatePkf（unknown-data-view）', () => {
    // build 本身不校验 PKF（那是 generate 的职责），但 validatePkf 必须能抓到。
    const content = buildReportCardContent({ ...BASE_INPUT, view: 'pie-3d' });
    const result = validatePkf(parsePkf(content));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unknown-data-view')).toBe(true);
  });
});

// ─── (b) generateReportCard + 注入 writer ─────────────────────────────────────

describe('generateReportCard', () => {
  it('合法 → writer 收到 pageType=report-card + visibility=task:<id>，返回 pageId', async () => {
    const captured: Array<Parameters<MemoryPageWriter>[0]> = [];
    const writer: MemoryPageWriter = async (page) => {
      captured.push(page);
      return { pageId: 'page_1', version: 1 };
    };
    const out = await generateReportCard(BASE_INPUT, writer);
    expect(out).toEqual({ pageId: 'page_1', uri: 'prismer://workspace/ws_123/memory/cards/report-demo', version: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0].pageType).toBe('report-card');
    expect(captured[0].visibility).toBe('task:task_abc');
    expect(captured[0].uri).toBe('prismer://workspace/ws_123/memory/cards/report-demo');
  });

  it('非法 view（坏 TierResult）→ throw report-card-invalid-pkf 且 writer 零调用（不产废卡）', async () => {
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));
    await expect(generateReportCard({ ...BASE_INPUT, view: 'pie-3d' }, writer)).rejects.toMatchObject({
      code: 'report-card-invalid-pkf',
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it('坏 TierResult cell → throw 且 writer 零调用', async () => {
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));
    await expect(
      generateReportCard({ ...BASE_INPUT, tierResults: [{ criterion: 'a,b', tier: 'T1', status: 'pass' }] }, writer),
    ).rejects.toBeInstanceOf(ReportCardError);
    expect(writer).not.toHaveBeenCalled();
  });
});

// ─── (c) createMemoryResolveWriter — 真 node:http server ───────────────────────

interface CapturedReq {
  method?: string;
  url?: string;
  auth?: string;
  body: unknown;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

function startServer(handler: (req: IncomingMessage, captured: CapturedReq[]) => Promise<{ status: number; body: unknown }>): {
  baseUrl: string;
  captured: CapturedReq[];
} {
  const captured: CapturedReq[] = [];
  const server = createServer(async (req, res) => {
    const { status, body } = await handler(req, captured);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0);
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, captured };
}

describe('createMemoryResolveWriter (真 http)', () => {
  it('POST /api/im/memory/resolve，带 Bearer + 正确 body，取回 pageId', async () => {
    const { baseUrl, captured } = startServer(async (req, cap) => {
      const raw = await readBody(req);
      cap.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      return { status: 201, body: { ok: true, data: { pageId: 'srv_page_9', version: 3 } } };
    });

    const writer = createMemoryResolveWriter({ baseUrl, token: 'sk-prismer-live-test' });
    const saved = await writer({
      uri: 'prismer://workspace/ws_123/memory/cards/report-demo',
      content: '<h2 id="stage-verify">x</h2>',
      pageType: 'report-card',
      visibility: 'task:task_abc',
    });

    expect(saved).toEqual({ pageId: 'srv_page_9', version: 3 });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('/api/im/memory/resolve');
    expect(captured[0].auth).toBe('Bearer sk-prismer-live-test');
    expect(captured[0].body).toMatchObject({ pageType: 'report-card', visibility: 'task:task_abc' });
  });

  it('server 5xx → ReportCardError(report-card-write-failed)', async () => {
    const { baseUrl } = startServer(async () => ({ status: 500, body: { ok: false, error: 'boom' } }));
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    await expect(
      writer({ uri: 'prismer://workspace/ws/memory/p', content: 'x', pageType: 'report-card', visibility: 'task:t' }),
    ).rejects.toMatchObject({ code: 'report-card-write-failed' });
  });

  it('端到端：generateReportCard → 真 writer 落到 server（body 内含 report-card content）', async () => {
    const { baseUrl, captured } = startServer(async (req, cap) => {
      const raw = await readBody(req);
      cap.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      return { status: 201, body: { ok: true, data: { pageId: 'srv_page_e2e' } } };
    });
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const out = await generateReportCard(BASE_INPUT, writer);
    expect(out.pageId).toBe('srv_page_e2e');
    const body = captured[0].body as { content: string; pageType: string };
    expect(body.pageType).toBe('report-card');
    expect(body.content).toContain('<prismer-data');
    expect(body.content).toContain('视觉基线,T3,pass');
  });
});

describe('generateReportCard strict readback (真 http · PKF-G2)', () => {
  /**
   * 内存页库 fake cloud：POST /resolve 落页并返回 pageId/version；
   * GET /pages/:id 按 id 取回 content/version。tamper 钩子让负控注入漂移。
   */
  function startPageServer(overrides?: {
    get?: (pageId: string, pages: Map<string, { content: string; version: number }>) => { status: number; body: unknown };
  }) {
    const pages = new Map<string, { content: string; version: number }>();
    let nextVersion = 1;
    const { baseUrl, captured } = startServer(async (req) => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/api/im/memory/resolve') {
        const raw = JSON.parse(await readBody(req)) as { content: string };
        const pageId = 'srv_rb';
        const version = nextVersion++;
        pages.set(pageId, { content: raw.content, version });
        return { status: 201, body: { ok: true, data: { pageId, version } } };
      }
      const m = /^\/api\/im\/memory\/pages\/([^?]+)/.exec(url);
      if (req.method === 'GET' && m) {
        const pageId = decodeURIComponent(m[1]);
        if (overrides?.get) return overrides.get(pageId, pages);
        const page = pages.get(pageId);
        if (!page) return { status: 404, body: { ok: false, error: 'Memory page not found' } };
        return { status: 200, body: { ok: true, data: { content: page.content, version: page.version } } };
      }
      return { status: 404, body: { ok: false, error: 'no route' } };
    });
    return { baseUrl, pages };
  }

  it('write 后 strict 回读：字节一致 + version 单调 ⇒ 通过', async () => {
    const { baseUrl } = startPageServer();
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const reader = createMemoryPageReader({ baseUrl, token: 't' });
    const out = await generateReportCard(BASE_INPUT, writer, reader);
    expect(out.pageId).toBe('srv_rb');
    expect(out.version).toBe(1);
  });

  it('负控 1：服务端回读 content 被篡改 ⇒ report-card-readback-mismatch', async () => {
    const { baseUrl } = startPageServer({
      get: (pageId, pages) => {
        const page = pages.get(pageId);
        return { status: 200, body: { ok: true, data: { content: `${page?.content} tampered`, version: page?.version } } };
      },
    });
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const reader = createMemoryPageReader({ baseUrl, token: 't' });
    await expect(generateReportCard(BASE_INPUT, writer, reader)).rejects.toMatchObject({
      code: 'report-card-readback-mismatch',
    });
  });

  it('负控 2：回读 404（空壳/编造 pageId）⇒ report-card-readback-missing', async () => {
    const { baseUrl } = startPageServer({
      get: () => ({ status: 404, body: { ok: false, error: 'Memory page not found' } }),
    });
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const reader = createMemoryPageReader({ baseUrl, token: 't' });
    await expect(generateReportCard(BASE_INPUT, writer, reader)).rejects.toMatchObject({
      code: 'report-card-readback-missing',
    });
  });

  it('负控 3：回读 version 倒退 ⇒ report-card-readback-version-regressed', async () => {
    const { baseUrl } = startPageServer({
      get: (pageId, pages) => {
        const page = pages.get(pageId);
        return { status: 200, body: { ok: true, data: { content: page?.content, version: 0 } } };
      },
    });
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const reader = createMemoryPageReader({ baseUrl, token: 't' });
    await expect(generateReportCard(BASE_INPUT, writer, reader)).rejects.toMatchObject({
      code: 'report-card-readback-version-regressed',
    });
  });

  it('无 reader（旧调用面）⇒ 行为与改造前一致（不回读、不抛）', async () => {
    const { baseUrl } = startPageServer();
    const writer = createMemoryResolveWriter({ baseUrl, token: 't' });
    const out = await generateReportCard(BASE_INPUT, writer);
    expect(out.pageId).toBe('srv_rb');
  });
});

// ─── card-scan ────────────────────────────────────────────────────────────────

function featureCardContent(stage: string, taskId: string): string {
  return [
    '<script type="application/prismer+json">',
    JSON.stringify({
      type: 'feature-card',
      title: 'topbar',
      visibility: `task:${taskId}`,
      card: { kind: 'feature', stage, taskId, schemaRev: 1 },
    }),
    '</script>',
    `<h2 id="stage-${stage}">stage</h2>`,
    '<p>x</p>',
  ].join('\n');
}

describe('scanCards', () => {
  it('feature/bugfix 卡 → {path, stage, taskId}；非卡 pageType 被滤', () => {
    const now = new Date('2026-07-24T00:00:00Z');
    const pages: ApcCardPage[] = [
      {
        path: 'cards/feature-a',
        pageType: 'feature-card',
        content: featureCardContent('implement', 'task_a'),
        updatedAt: new Date('2026-07-20T00:00:00Z'),
      },
      {
        path: 'notes/x',
        pageType: 'note',
        content: '<p>not a card</p>',
        updatedAt: new Date('2026-07-20T00:00:00Z'),
      },
    ];
    const { rows } = scanCards(pages, { now });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: 'cards/feature-a', stage: 'implement', taskId: 'task_a' });
    expect(rows[0].stageAgeDays).toBeCloseTo(4, 1);
  });
});

describe('createCloudCardPagesLister (真 http)', () => {
  it('分页列 pages → 逐张取 content → 喂 scanCards 抽出 stage', async () => {
    const listBatches: Record<string, unknown> = {
      '0': [
        { id: 'p1', path: 'cards/feature-a', pageType: 'feature-card', updatedAt: '2026-07-20T00:00:00Z' },
        { id: 'p2', path: 'notes/n', pageType: 'note', updatedAt: '2026-07-20T00:00:00Z' },
      ],
    };
    const { baseUrl } = startServer(async (req) => {
      const url = new URL(req.url ?? '', 'http://x');
      if (url.pathname === '/api/im/memory/pages') {
        const offset = url.searchParams.get('offset') ?? '0';
        return { status: 200, body: { ok: true, data: listBatches[offset] ?? [] } };
      }
      if (url.pathname === '/api/im/memory/resolve') {
        return {
          status: 200,
          body: { ok: true, data: { page: { content: featureCardContent('test', 'task_a') } } },
        };
      }
      return { status: 404, body: { ok: false } };
    });

    const lister = createCloudCardPagesLister({ workspaceId: 'ws_123', baseUrl, token: 't', pageSize: 200 });
    const pages = await lister();
    // 只有 feature-card 被取回（note 被滤）。
    expect(pages).toHaveLength(1);
    expect(pages[0].pageType).toBe('feature-card');

    const { rows } = scanCards(pages, { now: new Date('2026-07-24T00:00:00Z') });
    expect(rows[0]).toMatchObject({ path: 'cards/feature-a', stage: 'test', taskId: 'task_a' });
  });
});
