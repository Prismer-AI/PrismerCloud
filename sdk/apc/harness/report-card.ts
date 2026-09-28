/**
 * ReportCard 生成器（docs/apc/09-card-system-pkf.md §1 · 10 §3.4 PKF-4）。
 *
 * ReportCard = 实施报告 / 截图对比报告的**证据卡**（07 B2 的「回用户侧 + 记忆」实体）：
 * 一张 PKF 记忆页，同时是给用户的富报告和机器可查的记忆页。主卡（FeatureCard /
 * BugfixCard）的 stage 段用 typed link 引它。
 *
 * 本模块产出一张 ReportCard PKF 并经**写入 seam** 落库（`pageType='report-card'`，
 * `visibility='task:<id>'`）。**吃自己狗粮**：先 `parsePkf` + `validatePkf`，任一不过
 * 即 throw `ReportCardError`——**决不产废卡**（校验在写入之前，writer 永不被调用）。
 *
 * 落点（00 §2.5 依赖方向铁律）：本文件只在**开发/工具链循环**里跑（生成实施报告），
 * `src/` 生产路径永不 import 它 → 落 `sdk/apc/`。它可以**读** `src/lib/` 的纯函数库
 * （PKF 结构层），反向禁止。
 *
 * ⚠️ 写入面：`prismer memory write` CLI **无 `--visibility` 旗标**（10 §3.4 已报的
 * spec gap），`task:<id>` 可见性只能走 cloud 写入面 `POST /api/im/memory/resolve`，
 * 因此写入经 `createMemoryResolveWriter`（注入式，测试可替身）。
 */

import { parsePkf, validatePkf } from '@prismer/pkf';

/** report-card 的 pageType（证据卡；不参与 dispatch 绑定）。 */
export const REPORT_CARD_PAGE_TYPE = 'report-card';

/** TierResult 表的一行（09 §2 样本 `criterion,tier,status`）。 */
export interface TierResultRow {
  criterion: string;
  tier: string;
  status: string;
}

export interface GenerateReportCardInput {
  /** 目标 workspace（uri 与 ACL 用）。 */
  workspaceId: string;
  /** 绑定的 task（→ `visibility: task:<id>`）。 */
  taskId: string;
  /** 记忆页路径（uri = prismer://workspace/<ws>/memory/<path>）。 */
  path: string;
  title: string;
  description?: string;
  /** 结论文本（渲染进结论段 `<p>`；HTML-escape）。 */
  conclusion: string;
  /** TierResult 表（→ `<prismer-data format=csv view=table>`）。 */
  tierResults: TierResultRow[];
  /** before/after 截图 asset id（→ `<figure>` 内 `prismer://asset/<id>`）。 */
  beforeAssetId?: string;
  afterAssetId?: string;
  /** 主卡 uri（`prismer://workspace/<ws>/memory/<path>`）——typed link `rel=supports`。 */
  mainCardUri?: string;
  /** `<prismer-data>` view（默认 table）；非法值使产出 PKF 不过 validatePkf ⇒ throw。 */
  view?: string;
  /** `<prismer-data>` format（默认 csv）。 */
  format?: string;
}

export interface GeneratedReportCard {
  pageId: string;
  uri: string;
  version?: number;
}

/** 写入 seam：把一页 PKF 落库。注入式 ⇒ 测试可用内存替身，不打真 HTTP。 */
export interface MemoryPageWriter {
  (page: { uri: string; content: string; pageType: string; visibility: string }): Promise<{
    pageId: string;
    version?: number;
  }>;
}

/**
 * 回读 seam（product209/15 PKF-G2 — strict persist/readback）：按 pageId 取回
 * 落库页。`generateReportCard` 在 write 后用它做字节级复核——「声明了 URI」
 * 必须以「回读页与产出字节一致」为证，防空壳与漂移（doc10 §2.5 声明+复核）。
 */
export interface MemoryPageReader {
  (pageId: string): Promise<{ content: string; version?: number }>;
}

/** 结构化错误——所有拒绝路径都抛它，携带机可读 code + 校验明细。 */
export class ReportCardError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'ReportCardError';
    this.code = code;
    this.details = details;
  }
}

// ─── content 构造 ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CSV 单元格安全：逗号/换行会破坏 `criterion,tier,status` 行结构。 */
function assertCsvCell(value: string, field: string, at: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReportCardError('report-card-invalid-tier-row', `TierResult ${at} 的 ${field} 为空`, [
      `${at}.${field}`,
    ]);
  }
  if (value.includes(',') || /[\r\n]/.test(value)) {
    throw new ReportCardError(
      'report-card-invalid-tier-row',
      `TierResult ${at} 的 ${field} 含逗号/换行——会破坏 CSV 行`,
      [`${at}.${field}`],
    );
  }
  return value;
}

function tierResultsToCsv(rows: readonly TierResultRow[]): string {
  const lines = ['criterion,tier,status'];
  rows.forEach((r, i) => {
    const at = `row[${i}]`;
    lines.push(
      [
        assertCsvCell(r.criterion, 'criterion', at),
        assertCsvCell(r.tier, 'tier', at),
        assertCsvCell(r.status, 'status', at),
      ].join(','),
    );
  });
  return lines.join('\n');
}

/**
 * 构造 ReportCard 的 PKF content 字符串。纯函数（不写库、不校验副作用）——
 * `generateReportCard` 在它之上跑 parsePkf+validatePkf 后才写。
 */
export function buildReportCardContent(input: GenerateReportCardInput): string {
  if (!input.taskId) throw new ReportCardError('report-card-no-task', 'ReportCard 必须绑定 taskId');
  if (!Array.isArray(input.tierResults) || input.tierResults.length === 0) {
    throw new ReportCardError('report-card-empty-tier', 'TierResult 表不能为空');
  }
  const view = input.view ?? 'table';
  const format = input.format ?? 'csv';
  const csv = tierResultsToCsv(input.tierResults); // throws on illegal cell (before any write)

  const frontmatter = {
    type: REPORT_CARD_PAGE_TYPE,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    visibility: `task:${input.taskId}`,
    // 证据卡的 card 块（kind='report'，非主卡枚举）——scanApcCardPages 只扫
    // feature/bugfix，故 report-card 永不被 watchdog 计时；此处仅为血缘记账。
    card: { kind: 'report', taskId: input.taskId, schemaRev: 1 },
  };

  const parts: string[] = [
    '<script type="application/prismer+json">',
    JSON.stringify(frontmatter),
    '</script>',
    '',
    '<h2 id="stage-verify">结论</h2>',
    `<p>${escapeHtml(input.conclusion)}</p>`,
  ];
  if (input.mainCardUri) {
    parts.push(`<p>主卡：<a href="${escapeHtml(input.mainCardUri)}" rel="supports">主卡</a></p>`);
  }

  if (input.beforeAssetId || input.afterAssetId) {
    parts.push('', '<h2 id="comparison">截图对比</h2>', '<figure>');
    if (input.beforeAssetId) {
      parts.push(`<img src="prismer://asset/${encodeURIComponent(input.beforeAssetId)}" alt="before" />`);
    }
    if (input.afterAssetId) {
      parts.push(`<img src="prismer://asset/${encodeURIComponent(input.afterAssetId)}" alt="after" />`);
    }
    parts.push('</figure>');
  }

  parts.push(
    '',
    '<h2 id="tier-results">验收结果</h2>',
    `<prismer-data format="${escapeHtml(format)}" view="${escapeHtml(view)}" caption="TierResult">${csv}</prismer-data>`,
    '',
  );

  return parts.join('\n');
}

/**
 * 生成一张 ReportCard 并经 writer 落库。
 *
 * 顺序（不可换）：build content → parsePkf → validatePkf → **仅在合法时** write
 * →（有 reader 时）strict readback。任一步失败 throw `ReportCardError`，writer
 * 永不被调用 ⇒ 库里不留废卡；回读失败 ⇒ 报「写入无证」，绝不静默吞。
 */
export async function generateReportCard(
  input: GenerateReportCardInput,
  writer: MemoryPageWriter,
  reader?: MemoryPageReader,
): Promise<GeneratedReportCard> {
  const content = buildReportCardContent(input); // throws on bad tier rows / empty / no task

  const parsed = parsePkf(content);
  const result = validatePkf(parsed);
  if (!result.ok) {
    // 非法 view/format（坏 TierResult）在这里被 validateDataNode 抓住 ⇒ 拒绝、不写。
    throw new ReportCardError(
      'report-card-invalid-pkf',
      `生成的 ReportCard 不是合法 PKF（${result.errors.length} 处错误）`,
      result.errors.map((e) => `${e.code}: ${e.message}`),
    );
  }

  const uri = `prismer://workspace/${input.workspaceId}/memory/${input.path}`;
  const saved = await writer({
    uri,
    content,
    pageType: REPORT_CARD_PAGE_TYPE,
    visibility: `task:${input.taskId}`,
  });

  if (reader) {
    let readBack: { content: string; version?: number };
    try {
      readBack = await reader(saved.pageId);
    } catch (err) {
      throw new ReportCardError(
        'report-card-readback-missing',
        `回读 ReportCard 失败（${saved.pageId} 不存在或不可达）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // strict：字节级一致（PKF canonical body = IMMemoryPage.content）。
    // 版本单调（回读版本低于写入版本 = 写入被并发覆盖/回滚的签名）。
    if (readBack.content !== content) {
      throw new ReportCardError(
        'report-card-readback-mismatch',
        `回读 ReportCard 与产出字节不一致（${saved.pageId}）——写入漂移，不得声称已落库`,
      );
    }
    if (
      typeof saved.version === 'number' &&
      typeof readBack.version === 'number' &&
      readBack.version < saved.version
    ) {
      throw new ReportCardError(
        'report-card-readback-version-regressed',
        `回读 ReportCard 版本倒退（${saved.pageId}: wrote ${saved.version}, read ${readBack.version}）`,
      );
    }
  }

  return { pageId: saved.pageId, uri, version: saved.version };
}

// ─── 写入 seam 实现（cloud `POST /api/im/memory/resolve`）─────────────────────

export interface MemoryResolveWriterOptions {
  /** cloud base（默认 `APC_CLOUD_BASE_URL` → `http://127.0.0.1:3000`，00 §3 本机优先）。 */
  baseUrl?: string;
  /** Bearer token（默认 `APC_API_KEY` → `PRISMER_API_KEY`）。 */
  token?: string;
  /** 注入 fetch（测试打真 node:http server，不 mock 全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 造一个走 `POST /api/im/memory/resolve` 的写入 seam。这是唯一能带 `visibility`
 * 的写入面（CLI 无 `--visibility`）。
 */
export function createMemoryResolveWriter(opts: MemoryResolveWriterOptions = {}): MemoryPageWriter {
  const baseUrl = (opts.baseUrl ?? process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  return async (page) => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/im/memory/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          uri: page.uri,
          content: page.content,
          pageType: page.pageType,
          visibility: page.visibility,
        }),
      });
    } catch (err) {
      throw new ReportCardError(
        'report-card-write-transport',
        `写入 ReportCard 失败（传输层）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ReportCardError('report-card-write-failed', `写入 ReportCard 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    let body: { ok?: boolean; data?: { pageId?: string; version?: number } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReportCardError('report-card-write-bad-response', `写入响应非 JSON：${text.slice(0, 200)}`);
    }
    const pageId = body?.data?.pageId;
    if (!pageId) {
      throw new ReportCardError('report-card-write-no-page-id', `写入响应缺 pageId：${text.slice(0, 200)}`);
    }
    return { pageId, version: body?.data?.version };
  };
}

/**
 * 造一个走 `GET /api/im/memory/pages/:id` 的回读 seam（product209/15 PKF-G2）。
 * PKF canonical body 即页 `content`（`format=both` 默认返回）；404/5xx/非 JSON
 * 一律抛，由 `generateReportCard` 折成 `report-card-readback-missing`。
 */
export function createMemoryPageReader(opts: MemoryResolveWriterOptions = {}): MemoryPageReader {
  const baseUrl = (opts.baseUrl ?? process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  return async (pageId) => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/im/memory/pages/${encodeURIComponent(pageId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (err) {
      throw new ReportCardError(
        'report-card-readback-transport',
        `回读 ReportCard 失败（传输层）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ReportCardError('report-card-readback-failed', `回读 ReportCard 失败：HTTP ${res.status}`);
    }
    let body: { ok?: boolean; data?: { content?: string; version?: number } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReportCardError('report-card-readback-bad-response', `回读响应非 JSON：${text.slice(0, 200)}`);
    }
    if (typeof body?.data?.content !== 'string') {
      throw new ReportCardError('report-card-readback-no-content', `回读响应缺 content：${text.slice(0, 200)}`);
    }
    return { content: body.data.content, version: body.data.version };
  };
}
