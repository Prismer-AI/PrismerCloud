/**
 * ui-screenshot.ts 验收（§2 code 模块：真副作用 + 负控 + 铁律 1/2）。
 *
 * 分层（照 report-card.test.ts 同款）：
 *   (a) scope 合法性负控：不在 registry ENTRIES 的 scope → UiScreenshotError('unknown-scope')
 *       且 capturer/uploader/writer **一个都不调用**（不产废卡、不上传废 asset）。
 *   (b) 主流程 + 注入 3 seam：合法 scope → 截图 → 上云 → generateReportCard，断
 *       writer 收到 report-card pageType/visibility、shots 结构、before/after 槽位。
 *   (c) 传输层：`createAssetUploader` **不 mock fetch** —— 起真 `node:http` server，
 *       oracle = server 实收 method/path/multipart 字段。
 *
 * 真栈（本机 cloud:3000 + MySQL:3307）的 DB 三表 oracle 由 scripts/apc/ 的真跑脚本 +
 * skill §2 验收承担（需活 cloud + 真 chromium，不进 vitest 默认门）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runUiScreenshot,
  createAssetUploader,
  createAssetResolver,
  validScopes,
  MIN_SCREENSHOT_BYTES,
  UiScreenshotError,
  type BrowserCapturer,
  type AssetUploader,
  type AssetResolver,
  type RawShot,
} from '../ui-screenshot';
import type { MemoryPageWriter } from '../report-card';
import { ENTRIES } from '../../../../src/app/ui-kit/registry';

// ─── 替身 ─────────────────────────────────────────────────────────────────────

const KNOWN_SCOPE = ENTRIES[0].scope; // 'basics'（registry 真源）
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 一张「像真截图」的 PNG 替身：真 PNG magic + 足够字节（真截图 ~195 KiB，这里只需过下限）+
 * 每个 theme 字节不同。像素闸就是查这三件事，替身必须满足它们才是诚实的正控输入。
 */
function pngFixture(seed: string): Buffer {
  const body = Buffer.alloc(MIN_SCREENSHOT_BYTES * 2, seed.charCodeAt(0) % 251);
  body.write(seed, 0, 'utf8');
  return Buffer.concat([PNG_SIGNATURE, body]);
}

function fakeCapturer(themes: string[] = ['light', 'dark']): { capturer: BrowserCapturer } {
  const capturer: BrowserCapturer = async ({ scope }) =>
    themes.map<RawShot>((theme) => ({ theme, png: pngFixture(`${scope}-${theme}`) }));
  return { capturer };
}

/** 基线引用解析替身：默认「都解析得开、同 workspace、是图片」。 */
function fakeResolver(over: Partial<Awaited<ReturnType<AssetResolver>>> = {}): AssetResolver {
  return async () => ({ exists: true, workspaceId: 'ws_1', mime: 'image/png', sizeBytes: 199602, ...over });
}

function fakeUploader(): { uploader: AssetUploader; uploads: Array<{ theme: string; scope: string; taskId: string; sha256: string }> } {
  const uploads: Array<{ theme: string; scope: string; taskId: string; sha256: string }> = [];
  let n = 0;
  const uploader: AssetUploader = async ({ theme, scope, taskId, png }) => {
    const sha256 = createHash('sha256').update(png).digest('hex');
    uploads.push({ theme, scope, taskId, sha256 });
    return { assetId: `asset_${theme}_${++n}`, sha256 };
  };
  return { uploader, uploads };
}

function capturingWriter(): { writer: MemoryPageWriter; captured: Array<Parameters<MemoryPageWriter>[0]> } {
  const captured: Array<Parameters<MemoryPageWriter>[0]> = [];
  const writer: MemoryPageWriter = async (page) => {
    captured.push(page);
    return { pageId: 'page_report_1', version: 1 };
  };
  return { writer, captured };
}

// ─── (a) 负控：unknown scope → 结构化错误、零副作用 ──────────────────────────────

describe('runUiScreenshot 负控（unknown scope）', () => {
  it('不在 registry 的 scope → UiScreenshotError(unknown-scope) 且 capturer/uploader/writer 零调用（不产废卡）', async () => {
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    const uploader = vi.fn<AssetUploader>(async () => ({ assetId: 'x', sha256: 'y' }));
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));

    await expect(
      runUiScreenshot(
        { scope: 'no-such-component', workspaceId: 'ws_1', taskId: 'task_1' },
        { capturer, uploader, writer },
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-unknown-scope' });

    // 铁律：负控证明没有任何副作用被触发（不是「抛了个错」而已）。
    expect(capturer).not.toHaveBeenCalled();
    expect(uploader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('错误 details 列出合法 scope 全集（= registry 真源）', async () => {
    const err: UiScreenshotError = await runUiScreenshot(
      { scope: 'bogus', workspaceId: 'ws', taskId: 't' },
      { capturer: vi.fn(async () => []), uploader: vi.fn(async () => ({ assetId: '', sha256: '' })), writer: vi.fn(async () => ({ pageId: '' })) },
    ).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as UiScreenshotError,
    );
    expect(err).toBeInstanceOf(UiScreenshotError);
    expect(err.details).toEqual(validScopes());
    expect(err.details).toContain(KNOWN_SCOPE);
  });

  it('缺 workspaceId / taskId → 结构化错误且 capturer 零调用', async () => {
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    await expect(
      runUiScreenshot({ scope: KNOWN_SCOPE, workspaceId: '', taskId: 't' }, { capturer }),
    ).rejects.toMatchObject({ code: 'ui-screenshot-no-workspace' });
    await expect(
      runUiScreenshot({ scope: KNOWN_SCOPE, workspaceId: 'ws', taskId: '' }, { capturer }),
    ).rejects.toMatchObject({ code: 'ui-screenshot-no-task' });
    expect(capturer).not.toHaveBeenCalled();
  });
});

// ─── (b) 主流程 + 注入 seam ─────────────────────────────────────────────────────

describe('runUiScreenshot 主流程（新基线模式）', () => {
  it('合法 scope → 两态截图 → 上云 → generateReportCard；writer 收到 report-card+visibility', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader, uploads } = fakeUploader();
    const { writer, captured } = capturingWriter();

    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 'task_ui', themes: ['light', 'dark'] },
      { capturer, uploader, writer },
    );

    // 结构化输出：两态 shots + assetId + reportCard。
    expect(out.scope).toBe(KNOWN_SCOPE);
    expect(out.themes).toEqual(['light', 'dark']);
    expect(out.mode).toBe('new-baseline');
    expect(out.shots.map((s) => s.theme)).toEqual(['light', 'dark']);
    expect(out.shots.every((s) => s.assetId.startsWith('asset_'))).toBe(true);
    expect(out.reportCard).toEqual({ pageId: 'page_report_1', uri: expect.stringContaining(`cards/ui-align-${KNOWN_SCOPE}`), version: 1 });

    // 上云真发生（两张，绑同一 task）。
    expect(uploads).toHaveLength(2);
    expect(uploads.map((u) => u.theme)).toEqual(['light', 'dark']);
    expect(uploads.every((u) => u.taskId === 'task_ui')).toBe(true);

    // writer 收到的是 report-card PKF：pageType + visibility=task:<id> + 图引两态 asset。
    expect(captured).toHaveLength(1);
    expect(captured[0].pageType).toBe('report-card');
    expect(captured[0].visibility).toBe('task:task_ui');
    // 新基线模式：before=light asset, after=dark asset（两态并排）。
    expect(captured[0].content).toContain('prismer://asset/asset_light_1');
    expect(captured[0].content).toContain('prismer://asset/asset_dark_2');
    // TierResult 表两行（每 theme 一行）。
    expect(captured[0].content).toContain(`${KNOWN_SCOPE} · light 态截图`);
    expect(captured[0].content).toContain(`${KNOWN_SCOPE} · dark 态截图`);
  });

  // ⚠️ 承重：卡是给人看图判断的，标签指错图 = 结论反了。此前 resolveFigure 把 before 填成
  // dark、after 填成 light，而结论文案写着 before=light/after=dark —— 两者相反。
  it('alt="before"/alt="after" 指的图与结论文案逐字一致（before=themes[0], after=themes[1]）', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader } = fakeUploader();
    const { writer, captured } = capturingWriter();

    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 'task_ui', themes: ['light', 'dark'] },
      { capturer, uploader, writer },
    );

    const html = captured[0].content;
    const beforeId = /<img src="prismer:\/\/asset\/([^"]+)" alt="before"/.exec(html)?.[1];
    const afterId = /<img src="prismer:\/\/asset\/([^"]+)" alt="after"/.exec(html)?.[1];
    const themeOf = (id?: string) => out.shots.find((s) => s.assetId === id)?.theme;

    // 槽位事实
    expect(themeOf(beforeId)).toBe('light');
    expect(themeOf(afterId)).toBe('dark');
    // 结论文案的自述（同一份 HTML 里）
    expect(html).toContain('before=light 态, after=dark 态');
    // 两张图必须是不同的 asset（否则「两态并排」是假的）
    expect(beforeId).not.toBe(afterId);
  });

  // figureTheme 在 new-baseline 分支不参与定槽——顺序永远按 themes 声明。
  it('new-baseline 模式下 figureTheme 不改变槽位（before 仍是 themes[0]）', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader } = fakeUploader();
    const { writer, captured } = capturingWriter();

    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 'task_ui', themes: ['light', 'dark'], figureTheme: 'dark' },
      { capturer, uploader, writer },
    );
    const beforeId = /<img src="prismer:\/\/asset\/([^"]+)" alt="before"/.exec(captured[0].content)?.[1];
    expect(out.shots.find((s) => s.assetId === beforeId)?.theme).toBe('light');
  });

  it('结构化输出显式声明 comparison=none（本 harness 不做任何比对）', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader } = fakeUploader();
    const { writer, captured } = capturingWriter();
    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 'task_ui' },
      { capturer, uploader, writer },
    );
    expect(out.comparison).toBe('none');
    expect(captured[0].content).toContain('不做像素/结构比对');
  });
});

// ─── 像素闸负控：截图必须真有像素（此前 0 字节图会一路真上云、真落卡） ────────────

describe('runUiScreenshot 像素闸（负控）', () => {
  const cases: Array<{ name: string; png: (theme: string) => Buffer; hint: string }> = [
    { name: '0 字节 PNG', png: () => Buffer.alloc(0), hint: '0 字节' },
    {
      name: `字节数 < ${MIN_SCREENSHOT_BYTES} 的退化产物`,
      png: (t) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(24, t === 'light' ? 7 : 8)]),
      hint: '下限',
    },
    {
      name: '有字节但不是 PNG（缺 magic）',
      png: (t) => Buffer.alloc(MIN_SCREENSHOT_BYTES * 2, t === 'light' ? 9 : 10),
      hint: '不是 PNG',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → UiScreenshotError(degenerate-shot)，uploader/writer 零调用（不产废 asset、不产废卡）`, async () => {
      const capturer: BrowserCapturer = async ({ themes }) => themes.map((theme) => ({ theme, png: c.png(theme) }));
      const uploader = vi.fn<AssetUploader>(async () => ({ assetId: 'x', sha256: 'y' }));
      const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));

      const err: UiScreenshotError = await runUiScreenshot(
        { scope: KNOWN_SCOPE, workspaceId: 'ws', taskId: 't', themes: ['light', 'dark'] },
        { capturer, uploader, writer },
      ).then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as UiScreenshotError,
      );

      expect(err.code).toBe('ui-screenshot-degenerate-shot');
      expect(err.details.join('\n')).toContain(c.hint);
      // 铁律：闸在上传之前，所以一个副作用都没有。
      expect(uploader).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
    });
  }

  it('两个 theme 字节完全相同 → 判红（主题没切成；上云会去重成同一个 blob，卡里两槽指同一张图）', async () => {
    const same = pngFixture('identical');
    const capturer: BrowserCapturer = async ({ themes }) => themes.map((theme) => ({ theme, png: same }));
    const uploader = vi.fn<AssetUploader>(async () => ({ assetId: 'x', sha256: 'y' }));
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));

    await expect(
      runUiScreenshot(
        { scope: KNOWN_SCOPE, workspaceId: 'ws', taskId: 't', themes: ['light', 'dark'] },
        { capturer, uploader, writer },
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-degenerate-shot' });
    expect(uploader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('正控（同一形状、只把字节换成合格 PNG）→ 通过并真产卡', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader } = fakeUploader();
    const { writer, captured } = capturingWriter();
    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws', taskId: 't', themes: ['light', 'dark'] },
      { capturer, uploader, writer },
    );
    expect(out.shots.every((s) => s.bytes >= MIN_SCREENSHOT_BYTES)).toBe(true);
    expect(captured).toHaveLength(1);
  });
});

describe('runUiScreenshot 并排引用模式（传了基线 asset）', () => {
  it('传 baselineAssetIds → mode=baseline-reference，figure before=基线 after=新；comparison 仍是 none', async () => {
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { uploader } = fakeUploader();
    const { writer, captured } = capturingWriter();

    const out = await runUiScreenshot(
      {
        scope: KNOWN_SCOPE,
        workspaceId: 'ws_1',
        taskId: 'task_ui',
        themes: ['light', 'dark'],
        figureTheme: 'light',
        baselineAssetIds: { light: 'baseline_light_old' },
      },
      { capturer, uploader, writer, resolver: fakeResolver() },
    );

    expect(out.mode).toBe('baseline-reference');
    // 名字改了（旧名 'baseline-compare' 在暗示一个不存在的计算），但它仍然不做比对。
    expect(out.comparison).toBe('none');
    expect(out.shots.find((s) => s.theme === 'light')?.baselineAssetId).toBe('baseline_light_old');
    // 图：before = 基线, after = 新 light asset。
    const html = captured[0].content;
    expect(html).toContain('<img src="prismer://asset/baseline_light_old" alt="before" />');
    expect(html).toContain('<img src="prismer://asset/asset_light_1" alt="after" />');
    // 卡正文必须自己说清没有比对这回事。
    expect(html).toContain('不做像素/结构比对');
  });

  // 负控：`--baseline-*` 以前只是往卡里填一个字符串——传一个不存在的 id 也 exit 0，
  // 卡里就多一条永远打不开的悬空引用。
  it('基线 asset 解析不到 → UiScreenshotError(baseline-unresolvable)，capturer/uploader/writer 零调用', async () => {
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    const uploader = vi.fn<AssetUploader>(async () => ({ assetId: 'x', sha256: 'y' }));
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));

    const err: UiScreenshotError = await runUiScreenshot(
      {
        scope: KNOWN_SCOPE,
        workspaceId: 'ws_1',
        taskId: 'task_ui',
        baselineAssetIds: { light: 'cmTHIS_ASSET_DOES_NOT_EXIST' },
      },
      { capturer, uploader, writer, resolver: fakeResolver({ exists: false, status: 404 }) },
    ).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as UiScreenshotError,
    );

    expect(err.code).toBe('ui-screenshot-baseline-unresolvable');
    expect(err.details[0]).toContain('cmTHIS_ASSET_DOES_NOT_EXIST');
    // 闸在 chromium 之前：连截图都没起。
    expect(capturer).not.toHaveBeenCalled();
    expect(uploader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('基线 asset 属于别的 workspace → 判红（跨 workspace 引用在卡里也打不开）', async () => {
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));
    await expect(
      runUiScreenshot(
        { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 't', baselineAssetIds: { light: 'a_other' } },
        { capturer, writer, resolver: fakeResolver({ workspaceId: 'ws_OTHER' }) },
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-baseline-unresolvable' });
    expect(capturer).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('基线 asset 是 0 字节 / 非图片 → 判红', async () => {
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    await expect(
      runUiScreenshot(
        { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 't', baselineAssetIds: { light: 'a_empty' } },
        { capturer, resolver: fakeResolver({ sizeBytes: 0 }) },
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-baseline-unresolvable' });
    await expect(
      runUiScreenshot(
        { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 't', baselineAssetIds: { light: 'a_pdf' } },
        { capturer, resolver: fakeResolver({ mime: 'application/pdf' }) },
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-baseline-unresolvable' });
    expect(capturer).not.toHaveBeenCalled();
  });
});

describe('runUiScreenshot 截图失败传播', () => {
  it('capturer 产 0 张 → UiScreenshotError(no-shots)，writer 零调用', async () => {
    const capturer: BrowserCapturer = async () => [];
    const uploader = vi.fn<AssetUploader>(async () => ({ assetId: 'x', sha256: 'y' }));
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));
    await expect(
      runUiScreenshot({ scope: KNOWN_SCOPE, workspaceId: 'ws', taskId: 't' }, { capturer, uploader, writer }),
    ).rejects.toMatchObject({ code: 'ui-screenshot-no-shots' });
    expect(uploader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });
});

// ─── (c) createAssetUploader — 真 node:http server ────────────────────────────

interface CapturedUpload {
  method?: string;
  url?: string;
  auth?: string;
  contentType?: string;
  bodyLen: number;
  hasFile: boolean;
  workspaceId: string | null;
  kind: string | null;
  metadata: string | null;
}

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function startServer(
  handler: (req: IncomingMessage, raw: Buffer) => { status: number; body: unknown },
): { baseUrl: string; captured: CapturedUpload[] } {
  const captured: CapturedUpload[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readRaw(req);
    const text = raw.toString('latin1');
    captured.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      bodyLen: raw.length,
      hasFile: text.includes('name="file"'),
      workspaceId: /name="workspaceId"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? null,
      kind: /name="kind"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? null,
      metadata: /name="metadata"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? null,
    });
    const { status, body } = handler(req, raw);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0);
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, captured };
}

describe('createAssetUploader (真 http)', () => {
  it('POST /api/im/assets multipart，带 Bearer + file/workspaceId/kind/metadata，取回 assetId', async () => {
    const { baseUrl, captured } = startServer(() => ({
      status: 201,
      body: { ok: true, data: { assetId: 'srv_asset_9' } },
    }));

    const uploader = createAssetUploader({ baseUrl, token: 'sk-prismer-live-test' });
    const png = Buffer.from('PNG-BYTES');
    const saved = await uploader({
      png,
      filename: 'ui-kit-basics-light.png',
      workspaceId: 'ws_123',
      taskId: 'task_abc',
      scope: 'basics',
      theme: 'light',
    });

    expect(saved.assetId).toBe('srv_asset_9');
    expect(saved.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('/api/im/assets');
    expect(captured[0].auth).toBe('Bearer sk-prismer-live-test');
    expect(captured[0].contentType).toContain('multipart/form-data');
    expect(captured[0].hasFile).toBe(true);
    expect(captured[0].workspaceId).toBe('ws_123');
    expect(captured[0].kind).toBe('ui-screenshot');
    expect(captured[0].metadata).toContain('"theme":"light"');
    expect(captured[0].metadata).toContain('"taskId":"task_abc"');
  });

  it('server 5xx → UiScreenshotError(upload-failed)', async () => {
    const { baseUrl } = startServer(() => ({ status: 500, body: { ok: false, error: 'boom' } }));
    const uploader = createAssetUploader({ baseUrl, token: 't' });
    await expect(
      uploader({ png: Buffer.from('x'), filename: 'f.png', workspaceId: 'ws', taskId: 't', scope: 'basics', theme: 'light' }),
    ).rejects.toMatchObject({ code: 'ui-screenshot-upload-failed' });
  });

  it('响应缺 assetId → UiScreenshotError(upload-no-asset-id)', async () => {
    const { baseUrl } = startServer(() => ({ status: 201, body: { ok: true, data: {} } }));
    const uploader = createAssetUploader({ baseUrl, token: 't' });
    await expect(
      uploader({ png: Buffer.from('x'), filename: 'f.png', workspaceId: 'ws', taskId: 't', scope: 'basics', theme: 'light' }),
    ).rejects.toMatchObject({ code: 'ui-screenshot-upload-no-asset-id' });
  });

  it('端到端：runUiScreenshot → 真 uploader 落到 server（两态各一发）+ writer 收 report-card', async () => {
    let n = 0;
    const { baseUrl, captured } = startServer(() => ({
      status: 201,
      body: { ok: true, data: { assetId: `srv_asset_${++n}` } },
    }));
    const { capturer } = fakeCapturer(['light', 'dark']);
    const { writer, captured: written } = capturingWriter();

    const out = await runUiScreenshot(
      { scope: KNOWN_SCOPE, workspaceId: 'ws_1', taskId: 'task_ui', themes: ['light', 'dark'], baseUrl, token: 't' },
      { capturer, writer }, // uploader 用真 http 默认 seam（baseUrl 指向真 server）
    );

    // 两态各上传一次（真 http）。
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => c.url === '/api/im/assets' && c.kind === 'ui-screenshot')).toBe(true);
    expect(out.shots.map((s) => s.assetId)).toEqual(['srv_asset_1', 'srv_asset_2']);
    // report-card content 引真 server 回的 assetId。
    expect(written[0].content).toContain('prismer://asset/srv_asset_1');
    expect(written[0].content).toContain('prismer://asset/srv_asset_2');
  });
});

// ─── createAssetResolver — 真 node:http server ────────────────────────────────

describe('createAssetResolver (真 http)', () => {
  it('GET /api/im/assets/:id/detail 带 Bearer，200 → exists + workspaceId/mime/sizeBytes', async () => {
    const { baseUrl, captured } = startServer(() => ({
      status: 200,
      body: { ok: true, data: { id: 'a1', workspaceId: 'ws_1', mime: 'image/png', sizeBytes: 199602 } },
    }));
    const resolver = createAssetResolver({ baseUrl, token: 'sk-prismer-live-test' });
    const got = await resolver({ assetId: 'a1' });

    expect(got).toMatchObject({ exists: true, workspaceId: 'ws_1', mime: 'image/png', sizeBytes: 199602 });
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('/api/im/assets/a1/detail');
    expect(captured[0].auth).toBe('Bearer sk-prismer-live-test');
  });

  it('404 → exists=false（带 status，用于错误信息里说清为什么解析不开）', async () => {
    const { baseUrl } = startServer(() => ({ status: 404, body: { ok: false, error: 'Asset not found' } }));
    const resolver = createAssetResolver({ baseUrl, token: 't' });
    expect(await resolver({ assetId: 'nope' })).toMatchObject({ exists: false, status: 404 });
  });

  it('端到端负控：真 http 回 404 → runUiScreenshot 判红，capturer 零调用', async () => {
    const { baseUrl } = startServer(() => ({ status: 404, body: { ok: false, error: 'Asset not found' } }));
    const capturer = vi.fn<BrowserCapturer>(async () => []);
    const writer = vi.fn<MemoryPageWriter>(async () => ({ pageId: 'x' }));
    await expect(
      runUiScreenshot(
        {
          scope: KNOWN_SCOPE,
          workspaceId: 'ws_1',
          taskId: 't',
          baseUrl,
          token: 't',
          baselineAssetIds: { light: 'cmTHIS_ASSET_DOES_NOT_EXIST' },
        },
        { capturer, writer }, // resolver 用真 http 默认 seam
      ),
    ).rejects.toMatchObject({ code: 'ui-screenshot-baseline-unresolvable' });
    expect(capturer).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });
});

// ─── CLI 入口守卫（经软链调用不得 fail-open） ──────────────────────────────────

/**
 * 回归钉：旧守卫 `fileURLToPath(import.meta.url) === process.argv[1]` 在**任何含软链的调用路径**
 * 下都不成立（node 把模块 URL 解成 realpath，argv[1] 保留原样路径）⇒ main() 不跑、零输出、
 * **exit 0**。而上层判据是「退出码非 0 = 失败」，于是一次什么都没做的运行被读成成功。
 */
describe('CLI 入口守卫（真 spawn）', () => {
  const execFileAsync = promisify(execFile);
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  it('经软链路径调用 --list 仍然真跑（非「零输出 exit 0」）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apc-symlink-guard-'));
    const link = join(dir, 'repolink');
    try {
      symlinkSync(repoRoot, link);
      const { stdout } = await execFileAsync(
        'npx',
        ['tsx', join(link, 'sdk/apc/harness/ui-screenshot.ts'), '--list'],
        { cwd: repoRoot, timeout: 120_000 },
      );
      const parsed = JSON.parse(stdout) as { ok: boolean; scopes: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.scopes).toContain(KNOWN_SCOPE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('被 import 时不跑 main（本测试文件自己就是活证：import 了本模块，没有 CLI 输出/退出）', () => {
    expect(validScopes().length).toBeGreaterThan(0);
  });
});
