/**
 * watchdog 扫卡 helper（docs/apc/09 §3/§4.5 空腔 1 · 10 §3.4 PKF-4）。
 *
 * 「狗粮」侧：列 cloud 的卡页 → 喂 `scanApcCardPages`（`src/lib/apc-card-scan.ts`
 * 的纯扫描——同一个扫描器 product205 定时任务也在用，本 helper 不另造判据）→ 得每张
 * feature/bugfix 主卡的 `{path, stage, stageAgeDays}`，供开发循环里查「哪张卡在某个
 * stage 打转」。
 *
 * 落点（00 §2.5）：只在开发/工具链循环跑 → `sdk/apc/`。复用 `src/lib/` 纯扫描器（可读，
 * 反向禁止）。
 */

import { scanApcCardPages, APC_CARD_PAGE_TYPES } from '../../../src/lib/apc-card-scan';
import type { ApcCardPage, ApcCardScanResult } from '../../../src/lib/apc-card-scan';

export { APC_CARD_PAGE_TYPES };
export type { ApcCardPage, ApcCardScanResult, ApcCardScanRow } from '../../../src/lib/apc-card-scan';

/** 纯扫描包装——等价于 `scanApcCardPages`，作为 harness 的稳定公开面。 */
export function scanCards(
  pages: readonly ApcCardPage[],
  opts: { now?: Date; pageTypes?: readonly string[] } = {},
): ApcCardScanResult {
  return scanApcCardPages(pages, opts);
}

export interface CloudCardPagesListerOptions {
  workspaceId: string;
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** 只列这些 pageType（默认主卡 feature/bugfix）。 */
  pageTypes?: readonly string[];
  /** 每页 take（cloud 端 hard-cap 200）。 */
  pageSize?: number;
}

/** cloud `GET /api/im/memory/pages` 的行（只取扫描要的字段）。 */
interface CloudPageRow {
  id: string;
  path: string;
  pageType: string;
  updatedAt: string;
}

/**
 * 造一个「列 cloud 卡页」的 lister：分页拉满 `GET /memory/pages`（cloud 端单页 cap 200，
 * 用 `offset` 翻页直到不足一页），筛主卡 pageType，逐张经 `GET /memory/resolve` 取 content
 * （list 响应不含 content），产出 `ApcCardPage[]` 喂 `scanCards`。
 *
 * 注：这是「狗粮」helper，不带 version 历史 ⇒ stageAge 走 `updatedAt` fallback（只低估、
 * 不假阳）；生产 watchdog（`apc-watchdog.service`）走 `listWatchdogCardPages` 带 versions。
 */
export function createCloudCardPagesLister(
  opts: CloudCardPagesListerOptions,
): () => Promise<ApcCardPage[]> {
  const baseUrl = (opts.baseUrl ?? process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;
  const pageTypes = opts.pageTypes ?? APC_CARD_PAGE_TYPES;
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 200), 200);

  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, { headers: { ...authHeaders } });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status} ${text.slice(0, 160)}`);
    const body = JSON.parse(text) as { ok?: boolean; data?: T };
    if (body.data === undefined) throw new Error(`GET ${path} → missing data`);
    return body.data;
  }

  return async () => {
    // 1) 分页拉满 pages（翻到不足一页为止）。
    const rows: CloudPageRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const wsq = encodeURIComponent(opts.workspaceId);
      const batch = await getJson<CloudPageRow[]>(
        `/api/im/memory/pages?workspaceId=${wsq}&limit=${pageSize}&offset=${offset}`,
      );
      rows.push(...batch);
      if (batch.length < pageSize) break;
    }

    // 2) 筛主卡 pageType，逐张取 content。
    const cardRows = rows.filter((r) => pageTypes.includes(r.pageType));
    const out: ApcCardPage[] = [];
    for (const r of cardRows) {
      const uri = `prismer://workspace/${opts.workspaceId}/memory/${r.path}`;
      const loaded = await getJson<{ page: { content: string | null } | null }>(
        `/api/im/memory/resolve?uri=${encodeURIComponent(uri)}&format=both`,
      );
      out.push({
        path: r.path,
        pageType: r.pageType,
        content: loaded.page?.content ?? '',
        updatedAt: r.updatedAt,
      });
    }
    return out;
  };
}
