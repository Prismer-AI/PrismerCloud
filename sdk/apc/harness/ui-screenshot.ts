/**
 * ui-kit 截图对比 harness（docs/apc/07 Part A §A4 步骤 3-4 · 05 S4 ui-align · 11 §0.23）。
 *
 * 「新 UI 需求 → 索引 → 实现 → **Playwright 截图** → 报告」的最后两步：
 *   1. 读 `src/app/ui-kit/registry.ts` 的 `ENTRIES` 拿合法 scope 清单（**索引即真源，不
 *      grep 源码** —— 07 §A3）；给一个不在索引里的 scope ⇒ **结构化错误、不产废卡**。
 *   2. 用 **Playwright** 打真 cloud 的 `/ui-kit?scope=<scope>`，对 light / dark **两态**各截一张。
 *   3. 截图上云成 task-bound asset（`prismer://asset/<id>`）。
 *   4. **复用 `report-card.ts::generateReportCard`**（不另造）产一张 ReportCard PKF：截图 asset +
 *      对比结论段 + TierResult 表 + 若有基线则 before/after。
 *
 * 落点（00 §2.5 依赖方向铁律）：只在**开发/工具链循环**跑 → `sdk/apc/`。**读** `src/` 的纯模块
 * （registry 数据 / pkf 结构层），反向禁止；`src/` 生产路径永不 import 本文件。
 *
 * 诚实边界（同 design-review 固有局限）：本 harness 的 oracle 断的是**副作用**（截图产出了、
 * ReportCard 落库了、对比表结构对），**不是**「视觉好不好看 / 视觉通过」——那是人的判断，非机器
 * 精确断言。别拿本 harness 的绿宣称「视觉正确」。
 *
 * ⚠️ **本 harness 不做任何图像比对**（2026-07-27 更正——此前 `--baseline-*` 的命名与 `mode:
 * 'baseline-compare'` 暗示它会「比对」，实现里没有任何一环承载这个计算，传一个根本不存在的
 * asset id 也照样 exit 0 并把悬空引用嵌进卡）。现在的语义已改写成它真正做的事：
 *   - `baselineAssetIds` = **并排引用**（side-by-side reference），不是 diff 输入。传进来的 id
 *     会在截图之前被**回读校验**（真存在 · 未删除 · 同 workspace · 是图片），解析不到就结构化
 *     失败、不截图不上传不产卡 ⇒ 悬空引用不可能进卡。
 *   - 像素/结构差异由**人看图判定**；像素级阈值 diff（`toHaveScreenshot`）属 Playwright spec
 *     层，**本 harness 不含**，也不打算在这里伪装成含。
 *
 * 另一条承重不变量（同日修）：**截图必须真有像素**。单张 PNG 为 0 字节 / 小于
 * `MIN_SCREENSHOT_BYTES` / 无 PNG magic / 两个不同 theme 字节完全相同（= 主题没切成，卡里两槽
 * 会指向同一个 blob）⇒ 一律在上传之前结构化失败。此前只有「一张都没截到」这一个闸，0 字节图会
 * 一路真上云、真落卡。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENTRIES } from '../../../src/app/ui-kit/registry';
import {
  generateReportCard,
  createMemoryResolveWriter,
  type MemoryPageWriter,
  type TierResultRow,
  type GeneratedReportCard,
} from './report-card';

/** 结构化错误——所有拒绝路径抛它，携机可读 code + 明细（照 report-card 的 ReportCardError 形状）。 */
export class UiScreenshotError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'UiScreenshotError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_THEMES = ['light', 'dark'] as const;
export type ThemeName = string;

/** PNG magic（`\x89PNG\r\n\x1a\n`）——截图必须是真 PNG，不是「有几个字节」。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 单张截图的字节数下限。默认 viewport 是 1440×1000，即便整页纯色底也远超 1 KiB
 * （实测两态真截图各 ~195 KiB）。低于此值只可能是退化产物（0 字节 / 截了个空 buffer），
 * 不可能是一张真的 ui-kit 首屏 —— 所以判失败，而不是当成功产 asset。
 */
export const MIN_SCREENSHOT_BYTES = 1024;

/**
 * 模式。
 *   - `new-baseline`：没传基线 ⇒ 只截当前两态，卡里两槽 = 两态并排。
 *   - `baseline-reference`：传了 `--baseline-*` ⇒ 卡里 before 槽引那张**已存在的**基线图，
 *     after 槽引本次新截的图。**并排引用，不做任何比对计算**（命名从 `baseline-compare`
 *     改来，旧名在暗示一个不存在的计算）。
 */
export type UiScreenshotMode = 'baseline-reference' | 'new-baseline';

/** 一张截图的产物（上云后）。 */
export interface CapturedShot {
  theme: ThemeName;
  assetId: string;
  sha256: string;
  bytes: number;
  /** 并排引用的基线 asset（若调用方传了 baselineAssetIds[theme]，且已回读校验通过）。 */
  baselineAssetId?: string;
}

/** harness 的结构化输出——供 skill / CLI 消费（截图 assetId 列表 + 组件名 + 主题态）。 */
export interface UiScreenshotResult {
  scope: string;
  title: string;
  themes: ThemeName[];
  shots: CapturedShot[];
  /** 有任一基线传入 ⇒ 并排引用模式；否则新基线模式。 */
  mode: UiScreenshotMode;
  /**
   * 本 harness 计算出的图像差异 —— 恒为 `'none'`。
   * 结构化地钉死「它不做比对」这件事，免得读 JSON 的人（或 agent）从 `baseline*` 字段
   * 推断出一个不存在的 diff。像素级 diff 属 Playwright spec 层，本 harness 不含。
   */
  comparison: 'none';
  reportCard: GeneratedReportCard;
}

// ─── 浏览器截图 seam（注入式：测试不需真浏览器） ───────────────────────────────

/** 一次未上云的截图（原始 PNG bytes）。 */
export interface RawShot {
  theme: ThemeName;
  png: Buffer;
}

/** 打真 `/ui-kit?scope=` 对每个 theme 截图。注入式 ⇒ harness 单测用替身，不拉真 chromium。 */
export interface BrowserCapturer {
  (input: {
    baseUrl: string;
    scope: string;
    themes: readonly ThemeName[];
    viewport?: { width: number; height: number };
  }): Promise<RawShot[]>;
}

/**
 * 默认 Playwright capturer：headless chromium，逐 theme 经 `addInitScript` 预置
 * `localStorage['prismer-theme']`（ThemeProvider 的存储键，见 src/contexts/theme-context.tsx），
 * 再导航 `/ui-kit?scope=<scope>`，等 scope 导航栏 + section 渲染，截 viewport。
 *
 * `playwright` 经 `createRequire` 动态加载 —— 它是工具链 devDependency，不该进 sdk/apc 的
 * 编译期依赖图（harness 单测用注入替身，永不触真浏览器）。
 */
export function createPlaywrightCapturer(): BrowserCapturer {
  return async ({ baseUrl, scope, themes, viewport }) => {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('playwright') as typeof import('playwright');
    const vp = viewport ?? { width: 1440, height: 1000 };
    const browser = await chromium.launch({ headless: true });
    try {
      const shots: RawShot[] = [];
      for (const theme of themes) {
        const context = await browser.newContext({ viewport: vp });
        // 预置主题：ThemeProvider 初始化时读 localStorage['prismer-theme']（'light'|'dark'|'system'），
        // 挂 `.light`/`.dark` 到 <html>。必须在页面脚本跑前种下。
        await context.addInitScript((t: string) => {
          try {
            window.localStorage.setItem('prismer-theme', t);
          } catch {
            /* localStorage 不可用时静默——截图仍出，只是主题回落默认 */
          }
        }, theme);
        const page = await context.newPage();
        const url = `${baseUrl.replace(/\/$/, '')}/ui-kit?scope=${encodeURIComponent(scope)}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
        // scope 导航栏是索引壳稳定锚点；section 是懒加载 chunk。
        await page.waitForSelector('[data-testid="ui-kit-scope-nav"]', { timeout: 30_000 });
        // 给懒加载 section + 动画一点落定时间（gallery 首屏）。
        await page.waitForTimeout(1200);
        const png = (await page.screenshot({ fullPage: false })) as Buffer;
        shots.push({ theme, png: Buffer.from(png) });
        await context.close();
      }
      return shots;
    } finally {
      await browser.close();
    }
  };
}

// ─── 上云 seam（截图 → task-bound asset） ────────────────────────────────────

/** 把一张 PNG 上云成 asset，返回 assetId + sha256。注入式 ⇒ 测试起真 node:http server。 */
export interface AssetUploader {
  (input: {
    png: Buffer;
    filename: string;
    workspaceId: string;
    taskId: string;
    scope: string;
    theme: ThemeName;
  }): Promise<{ assetId: string; sha256: string }>;
}

export interface AssetUploaderOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 造一个走 `POST /api/im/assets`（multipart）的上传 seam。截图落 task-bound asset：
 * form 字段 `file` / `workspaceId` / `kind='ui-screenshot'` / `sourceTaskId` /
 * `metadata`（JSON，含 taskId+scope+theme）。响应 `data.assetId`。
 */
export function createAssetUploader(opts: AssetUploaderOptions = {}): AssetUploader {
  const baseUrl = (opts.baseUrl ?? process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  return async ({ png, filename, workspaceId, taskId, scope, theme }) => {
    const sha256 = createHash('sha256').update(png).digest('hex');
    const form = new FormData();
    // node 20 的 Blob/File 全局可用；用 Uint8Array 视图避免 SharedArrayBuffer 类型窄化问题。
    const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
    form.append('file', blob, filename);
    form.append('workspaceId', workspaceId);
    form.append('kind', 'ui-screenshot');
    form.append('sourceTaskId', taskId);
    form.append('contentSha256', sha256);
    form.append('metadata', JSON.stringify({ taskId, scope, theme, sourceKind: 'ui-screenshot' }));

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/im/assets`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
    } catch (err) {
      throw new UiScreenshotError(
        'ui-screenshot-upload-transport',
        `上传截图失败（传输层）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new UiScreenshotError('ui-screenshot-upload-failed', `上传截图失败：HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    let body: { ok?: boolean; data?: { assetId?: string; id?: string } } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UiScreenshotError('ui-screenshot-upload-bad-response', `上传响应非 JSON：${text.slice(0, 200)}`);
    }
    // `POST /api/im/assets` 的成功响应把 asset id 放在 `data.id`（不是 `data.assetId`——
    // 后者是别处 `toAssetResponse` 的字段名，实测 2026-07-24 上传响应用 `id`）。
    const assetId = body?.data?.assetId ?? body?.data?.id;
    if (!assetId) {
      throw new UiScreenshotError('ui-screenshot-upload-no-asset-id', `上传响应缺 assetId：${text.slice(0, 200)}`);
    }
    return { assetId, sha256 };
  };
}

// ─── 基线引用解析 seam（`--baseline-*` 传进来的 id 必须真解析得开） ─────────────

/** 回读一个 asset 的元数据；不存在 / 已删除 ⇒ `{ exists: false }`（不抛）。 */
export interface AssetResolver {
  (input: { assetId: string }): Promise<{
    exists: boolean;
    workspaceId?: string;
    mime?: string | null;
    sizeBytes?: number | null;
    /** 便于错误信息里说清「为什么解析不开」（404 / 410 / 无权限）。 */
    status?: number;
  }>;
}

/**
 * 造一个走 `GET /api/im/assets/:id/detail` 的解析 seam。
 *
 * 存在的唯一理由：`--baseline-*` 以前只是**往卡里填一个字符串**——传
 * `cmTHIS_ASSET_DOES_NOT_EXIST` 也 exit 0，卡正文里就多一条永远打不开的悬空引用。
 * 现在它在截图之前被回读，解析不开就结构化失败。
 */
export function createAssetResolver(opts: AssetUploaderOptions = {}): AssetResolver {
  const baseUrl = (opts.baseUrl ?? process.env.APC_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = opts.token ?? process.env.APC_API_KEY ?? process.env.PRISMER_API_KEY ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  return async ({ assetId }) => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/im/assets/${encodeURIComponent(assetId)}/detail`, {
        method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch (err) {
      throw new UiScreenshotError(
        'ui-screenshot-baseline-transport',
        `回读基线 asset 失败（传输层）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) return { exists: false, status: res.status };
    const text = await res.text();
    let body: { ok?: boolean; data?: { workspaceId?: string; mime?: string | null; sizeBytes?: number | null } } | null =
      null;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UiScreenshotError(
        'ui-screenshot-baseline-bad-response',
        `回读基线 asset 的响应非 JSON：${text.slice(0, 200)}`,
      );
    }
    if (!body?.data) return { exists: false, status: res.status };
    return {
      exists: true,
      status: res.status,
      workspaceId: body.data.workspaceId,
      mime: body.data.mime ?? null,
      sizeBytes: body.data.sizeBytes ?? null,
    };
  };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

export interface RunUiScreenshotInput {
  /** 目标 scope（= registry ENTRIES[].scope；不在其中 → 结构化错误、不产卡）。 */
  scope: string;
  /** workspace（asset + memory ACL）。 */
  workspaceId: string;
  /** 绑定的 task（截图 asset + ReportCard visibility 都挂它）。 */
  taskId: string;
  /** 截哪些主题态（默认 light + dark）。 */
  themes?: readonly ThemeName[];
  /** ReportCard 记忆页路径（默认 `cards/ui-align-<scope>`）。 */
  path?: string;
  /**
   * `baseline-reference` 模式下，卡里 after 槽用哪个 theme 的新图（其 before 槽 = 该 theme 的
   * 基线图）。默认 `themes[0]`。**`new-baseline` 模式不看这个字段**——那时两槽固定按
   * `themes` 顺序排（before=themes[0], after=themes[1]），见 `resolveFigure`。
   */
  figureTheme?: ThemeName;
  /**
   * 基线 asset id（按 theme）——传了就走 `baseline-reference` 模式：卡里 before 槽引这张已有的
   * 图，after 槽引新截的图。**这是并排引用，不是 diff 输入**；harness 不做任何像素/结构比对。
   * 每个 id 都会在截图之前回读校验（存在 · 同 workspace · 是图片），解析不开即失败。
   */
  baselineAssetIds?: Record<string, string>;
  baseUrl?: string;
  token?: string;
  viewport?: { width: number; height: number };
}

export interface RunUiScreenshotDeps {
  capturer?: BrowserCapturer;
  uploader?: AssetUploader;
  writer?: MemoryPageWriter;
  resolver?: AssetResolver;
}

/** registry 里合法 scope 集（索引即真源）。 */
export function validScopes(): string[] {
  return ENTRIES.map((e) => e.scope);
}

function entryFor(scope: string) {
  return ENTRIES.find((e) => e.scope === scope);
}

/**
 * 决定 ReportCard 图的 before/after 槽位（report-card 只有两槽）。
 *
 * ⚠️ 2026-07-27 修正：`new-baseline` 分支此前**与结论文案相反**——文案写「before=themes[0]
 * （light）、after=themes[1]（dark）」，代码却把 before 填成 `others[0]`（dark）、after 填成
 * primary（light）。这条 skill 的全部产出就是给人看图判断，标签写反是承重错误。
 * 现在 `new-baseline` **按 `themes` 顺序**定槽，与结论文案逐字对齐：
 *   - `baseline-reference`：before=基线[figureTheme]，after=新[figureTheme] —— 老图/新图并排。
 *   - `new-baseline` 且 ≥2 theme：before=新[themes[0]]（如 light），after=新[themes[1]]（如 dark）
 *     —— 同组件两态并排，UI 对齐评审最有用的形态。`figureTheme` 在这个分支**不参与**。
 *   - `new-baseline` 且单 theme：只填 after=新[该 theme]。
 * 其余 theme 的截图仍在 `shots[]`（结构化输出）与结论段被记录，不丢。
 */
function resolveFigure(
  shots: CapturedShot[],
  themes: readonly ThemeName[],
  figureTheme: string,
  mode: UiScreenshotMode,
): { beforeAssetId?: string; afterAssetId?: string } {
  if (shots.length === 0) return {};
  if (mode === 'baseline-reference') {
    const primary = shots.find((s) => s.theme === figureTheme) ?? shots[0];
    return { beforeAssetId: primary.baselineAssetId, afterAssetId: primary.assetId };
  }
  // new-baseline：两态并排，槽位 = themes 的声明顺序（结论文案说的就是这个顺序）。
  const first = shots.find((s) => s.theme === themes[0]) ?? shots[0];
  const second = themes[1] ? shots.find((s) => s.theme === themes[1]) : undefined;
  if (second && second.theme !== first.theme) {
    return { beforeAssetId: first.assetId, afterAssetId: second.assetId };
  }
  return { afterAssetId: first.assetId };
}

/**
 * 截图像素闸（2026-07-27 新增）——**在任何上传之前**判掉退化产物。
 *
 * 此前唯一的闸是「一张都没截到」（`raw.length === 0`），单张 PNG 的字节数从不检查 ⇒ 注入两张
 * 0 字节 PNG 会一路真上云（`sizeBytes=0`、hash 是空串的 sha256）、真落 ReportCard，且因两态
 * 字节相同被去重成同一个 asset，卡里 before/after 指向同一个 0 字节 blob。一个只查「有没有
 * id」、不查「有没有像素」的门。
 *
 * 四条判据（任一不过即整轮失败，`details` 逐条列明）：
 *   1. 0 字节；2. < `MIN_SCREENSHOT_BYTES`；3. 无 PNG magic；
 *   4. 两个**不同** theme 的字节完全相同 —— 主题没切成，卡里两槽会指向同一个 blob。
 */
function assertShotsHavePixels(raw: readonly RawShot[]): void {
  const bad: string[] = [];
  for (const r of raw) {
    const n = r.png.length;
    if (n === 0) {
      bad.push(`${r.theme}: 0 字节（空截图）`);
      continue;
    }
    if (n < MIN_SCREENSHOT_BYTES) {
      bad.push(`${r.theme}: ${n} 字节 < 下限 ${MIN_SCREENSHOT_BYTES}（退化产物，不可能是一张真的首屏截图）`);
      continue;
    }
    if (!r.png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      bad.push(`${r.theme}: ${n} 字节但不是 PNG（缺 PNG magic）`);
    }
  }
  // 两态字节相同 ⇒ 主题没切成；上云会被去重，卡里 before/after 会指向同一个 blob。
  const byHash = new Map<string, string[]>();
  for (const r of raw) {
    const h = createHash('sha256').update(r.png).digest('hex');
    byHash.set(h, [...(byHash.get(h) ?? []), r.theme]);
  }
  for (const [h, themes] of byHash) {
    if (themes.length > 1) {
      bad.push(
        `${themes.join(' / ')}: 字节完全相同（sha256=${h.slice(0, 12)}…）——主题没切成，两槽会指向同一个 blob`,
      );
    }
  }
  if (bad.length > 0) {
    throw new UiScreenshotError(
      'ui-screenshot-degenerate-shot',
      `截图退化：${bad.length} 项不合格（截图必须有真像素，否则卡是空的）`,
      bad,
    );
  }
}

/**
 * 跑一轮 ui-kit 截图：（基线引用回读 →）截 → 像素闸 → 上云 → 产 ReportCard。
 *
 * 顺序（不可换，负控全靠它）：**scope 合法性校验最前**，其次**基线引用回读**（解析不开就
 * 停，此时连 chromium 都没起），再截图，**像素闸在上传之前**。任一步 throw ⇒ 后面的
 * uploader / writer 一个都不被调用 ⇒ 库里不留废卡、不上传废 asset。
 */
export async function runUiScreenshot(
  input: RunUiScreenshotInput,
  deps: RunUiScreenshotDeps = {},
): Promise<UiScreenshotResult> {
  // ── 负控闸：不在 registry 索引里的 scope 直接结构化拒绝（在任何副作用之前） ──
  const entry = entryFor(input.scope);
  if (!entry) {
    throw new UiScreenshotError(
      'ui-screenshot-unknown-scope',
      `scope '${input.scope}' 不在 ui-kit registry 索引里`,
      validScopes(),
    );
  }
  if (!input.workspaceId) throw new UiScreenshotError('ui-screenshot-no-workspace', '缺 workspaceId');
  if (!input.taskId) throw new UiScreenshotError('ui-screenshot-no-task', '缺 taskId（截图 asset 与 ReportCard 都要绑 task）');

  const themes = input.themes && input.themes.length > 0 ? input.themes : DEFAULT_THEMES;
  const figureTheme = input.figureTheme ?? themes[0];
  const baselineEntries = Object.entries(input.baselineAssetIds ?? {}).filter(([, id]) => typeof id === 'string' && id !== '');
  const mode: UiScreenshotMode = baselineEntries.length > 0 ? 'baseline-reference' : 'new-baseline';

  const capturer = deps.capturer ?? createPlaywrightCapturer();
  const uploader = deps.uploader ?? createAssetUploader({ baseUrl: input.baseUrl, token: input.token });
  const writer =
    deps.writer ?? createMemoryResolveWriter({ baseUrl: input.baseUrl, token: input.token });

  // 1) 基线引用回读（在起 chromium 之前）。传进来的 id 必须真解析得开——否则卡里会多一条
  //    永远打不开的悬空引用，而这条 skill 的产出就是给人点开看的图。
  if (mode === 'baseline-reference') {
    const resolver = deps.resolver ?? createAssetResolver({ baseUrl: input.baseUrl, token: input.token });
    const bad: string[] = [];
    for (const [theme, assetId] of baselineEntries) {
      const got = await resolver({ assetId });
      if (!got.exists) {
        bad.push(`${theme}: 基线 asset '${assetId}' 解析不到（HTTP ${got.status ?? '?'}：不存在 / 已删除 / 无权限）`);
        continue;
      }
      if (got.workspaceId && got.workspaceId !== input.workspaceId) {
        bad.push(`${theme}: 基线 asset '${assetId}' 属于 workspace ${got.workspaceId}，不是本次的 ${input.workspaceId}`);
        continue;
      }
      if (got.sizeBytes != null && got.sizeBytes < MIN_SCREENSHOT_BYTES) {
        bad.push(`${theme}: 基线 asset '${assetId}' 只有 ${got.sizeBytes} 字节（退化产物，不能当并排引用）`);
        continue;
      }
      if (got.mime && !got.mime.startsWith('image/')) {
        bad.push(`${theme}: 基线 asset '${assetId}' 的 mime 是 ${got.mime}，不是图片`);
      }
    }
    if (bad.length > 0) {
      throw new UiScreenshotError(
        'ui-screenshot-baseline-unresolvable',
        `基线引用解析失败：${bad.length} 项（不截图、不上传、不产卡）`,
        bad,
      );
    }
  }

  // 2) 截图。
  const raw = await capturer({ baseUrl: input.baseUrl ?? 'http://127.0.0.1:3000', scope: input.scope, themes, viewport: input.viewport });
  if (raw.length === 0) {
    throw new UiScreenshotError('ui-screenshot-no-shots', 'capturer 未产出任何截图');
  }
  // 像素闸：0 字节 / 过小 / 非 PNG / 两态同字节 ⇒ 在上传之前失败（不产废 asset、不产废卡）。
  assertShotsHavePixels(raw);

  // 3) 逐张上云。
  const shots: CapturedShot[] = [];
  for (const r of raw) {
    const up = await uploader({
      png: r.png,
      filename: `ui-kit-${input.scope}-${r.theme}.png`,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      scope: input.scope,
      theme: r.theme,
    });
    shots.push({
      theme: r.theme,
      assetId: up.assetId,
      sha256: up.sha256,
      bytes: r.png.length,
      baselineAssetId: input.baselineAssetIds?.[r.theme],
    });
  }

  // 4) TierResult 表：每 theme 一行（截图产出是可断言的副作用；「视觉好坏」不进表）。
  const tierResults: TierResultRow[] = shots.map((s) => ({
    criterion: `${input.scope} · ${s.theme} 态截图`,
    tier: mode === 'baseline-reference' && s.baselineAssetId ? 'reference' : 'baseline',
    status: 'captured',
  }));

  const figure = resolveFigure(shots, themes, figureTheme, mode);
  // 结论文案必须与上面的槽位逐字对齐（此前两者相反，见 resolveFigure 的修正注释），
  // 并且必须说清「没有比对这个计算」——卡是给人看图判断的，不是给人读一个不存在的 diff 的。
  const conclusion =
    mode === 'baseline-reference'
      ? `对 ui-kit scope '${input.scope}'（${entry.title}）在 ${themes.join(' / ')} 两态截图。` +
        `图为 ${figureTheme} 态：before=已有基线截图, after=本次新截图。` +
        `本 harness 不做像素/结构比对（只并排引用两张图），差异与是否对齐一律由人看图判定。`
      : `对 ui-kit scope '${input.scope}'（${entry.title}）在 ${themes.join(' / ')} 两态截取新基线截图。` +
        `图为两态并排（before=${themes[0]} 态, after=${themes[1] ?? themes[0]} 态），不是新旧对比。` +
        `本 harness 不做像素/结构比对，视觉是否对齐由人评审判定——本卡只证明截图已产出。`;

  // 5) 复用 report-card 生成器（不另造）。
  const reportCard = await generateReportCard(
    {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      path: input.path ?? `cards/ui-align-${input.scope}`,
      title: `UI 对齐 · ${input.scope}`,
      description: entry.title,
      conclusion,
      tierResults,
      beforeAssetId: figure.beforeAssetId,
      afterAssetId: figure.afterAssetId,
    },
    writer,
  );

  return { scope: input.scope, title: entry.title, themes: [...themes], shots, mode, comparison: 'none', reportCard };
}

// ─── CLI（skill 经 `npx tsx sdk/apc/harness/ui-screenshot.ts ...` 调用） ──────────

interface CliArgs {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const USAGE = `ui-screenshot — ui-kit 截图 harness（skill: ui-align）

用法（从仓库根跑；stdout 是纯 JSON）：
  npx tsx sdk/apc/harness/ui-screenshot.ts --list
  npx tsx sdk/apc/harness/ui-screenshot.ts --scope <scope> [选项]

选项：
  --list                    打印 registry 索引里的全部合法 scope，然后退出
  --help, -h                打印本帮助，然后退出
  --scope <scope>           目标 scope（必须在 ui-kit registry 索引里，否则 exit 2）
  --themes light,dark       截哪些主题态（默认 light,dark）
  --workspace <id>          workspace id（缺省取 $APC_WORKSPACE_ID）
  --task <id>               task id（缺省取 $PRISMER_TASK_ID）；截图 asset 与卡都绑它
  --path <memory path>      ReportCard 记忆页路径（默认 cards/ui-align-<scope>）
  --base-url <url>          cloud base（默认 $APC_CLOUD_BASE_URL 或 http://127.0.0.1:3000）
  --token <sk-...>          Bearer token（默认 $APC_API_KEY / $PRISMER_API_KEY）
  --figure-theme <theme>    仅 baseline-reference 模式：卡里用哪个 theme 的图（默认第一个 theme）
  --baseline-light <assetId>
  --baseline-dark  <assetId>
                            并排引用：把这张已有的截图放进卡的 before 槽，本次新图放 after 槽。
                            ⚠️ 这不是 diff 输入——本 harness 不做任何像素/结构比对
                            （输出 JSON 里的 "comparison":"none" 就是这个意思）；差异由人看图判定。
                            传进来的 id 会在截图之前回读校验（存在 · 同 workspace · 是图片），
                            解析不开即 exit 1，不截图、不上传、不产卡。

退出码：0 成功 · 2 scope 不在索引 · 1 其它结构化失败（stderr 是 JSON，带 code + details）
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // `-h` 是裸单横杠，parseArgs 只认 `--`，所以直接看 argv。
  if (args.help || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const scope = typeof args.scope === 'string' ? args.scope : '';
  const workspaceId = typeof args.workspace === 'string' ? args.workspace : (process.env.APC_WORKSPACE_ID ?? '');
  const taskId = typeof args.task === 'string' ? args.task : (process.env.PRISMER_TASK_ID ?? '');
  const themes = typeof args.themes === 'string' ? args.themes.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const baseUrl = typeof args['base-url'] === 'string' ? (args['base-url'] as string) : undefined;
  const token = typeof args.token === 'string' ? (args.token as string) : undefined;
  const figureTheme = typeof args['figure-theme'] === 'string' ? (args['figure-theme'] as string) : undefined;
  const path = typeof args.path === 'string' ? (args.path as string) : undefined;
  const baselineAssetIds: Record<string, string> = {};
  if (typeof args['baseline-light'] === 'string') baselineAssetIds.light = args['baseline-light'] as string;
  if (typeof args['baseline-dark'] === 'string') baselineAssetIds.dark = args['baseline-dark'] as string;

  if (args.list) {
    process.stdout.write(JSON.stringify({ ok: true, scopes: validScopes() }, null, 2) + '\n');
    return 0;
  }

  try {
    const result = await runUiScreenshot({
      scope,
      workspaceId,
      taskId,
      themes,
      baseUrl,
      token,
      figureTheme,
      path,
      baselineAssetIds: Object.keys(baselineAssetIds).length ? baselineAssetIds : undefined,
    });
    // 结构化成功输出（stdout 纯 JSON，供 agent 汇报解析）。
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          scope: result.scope,
          themes: result.themes,
          mode: result.mode,
          // 恒 'none'：本 harness 不做像素/结构比对，`--baseline-*` 只是并排引用。
          comparison: result.comparison,
          shots: result.shots.map((s) => ({
            theme: s.theme,
            assetId: s.assetId,
            bytes: s.bytes,
            ...(s.baselineAssetId ? { baselineRefAssetId: s.baselineAssetId } : {}),
          })),
          reportCard: { pageId: result.reportCard.pageId, uri: result.reportCard.uri, version: result.reportCard.version },
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  } catch (err) {
    const e = err as UiScreenshotError;
    const payload = {
      ok: false,
      code: e?.code ?? 'ui-screenshot-error',
      message: e?.message ?? String(err),
      details: e?.details ?? [],
      ...(e?.code === 'ui-screenshot-unknown-scope' ? { validScopes: validScopes() } : {}),
    };
    // 结构化错误落 stderr，退出码非 0。负控：unknown-scope ⇒ 这里返回、绝不产卡。
    process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
    return e?.code === 'ui-screenshot-unknown-scope' ? 2 : 1;
  }
}

/**
 * 本模块是不是「被当脚本直接跑」。
 *
 * ⚠️ 旧写法 `fileURLToPath(import.meta.url) === process.argv[1]` 是 **fail-open**：node 会把模块
 * URL 解成 **realpath**，而 `process.argv[1]` 保留用户敲的**原样路径**。于是只要调用路径上有任何
 * 一段软链（`/tmp/link/sdk/apc/harness/ui-screenshot.ts`），两边就不相等 ⇒ `main()` 根本不跑 ⇒
 * **零输出、exit 0**。而上层判据是「退出码非 0 = 失败」，一次什么都没做的运行会被读成成功。
 * 修法：两侧都 realpath 之后再比。realpath 失败（文件已删/权限）时回落原值比较，不放行。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return canon(self) === canon(entry);
}

// CLI 入口守卫：仅当作为脚本直接跑时执行（被 import 时不跑）。
if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(JSON.stringify({ ok: false, code: 'ui-screenshot-fatal', message: String(err) }) + '\n');
      process.exit(1);
    });
}
