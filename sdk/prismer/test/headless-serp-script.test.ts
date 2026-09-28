// runtime210/01 experiment — headless-serp.py fixture parsing tests.
// `parse --html` is stdlib-only python (HTMLParser); runs on ANY python3 —
// no playwright, no chromium, no network. Real SERP validation happens in
// the in-pod C6 corpus (docs/runtime210/01 §3).
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeHeadlessPy } from '../src/daemon/web/headless-serp.js';

const execFileAsync = promisify(execFile);

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'serp');

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const hasPython = pythonAvailable();

async function runParse(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync('python3', args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

describe.skipIf(!hasPython)('headless-serp.py parse (fixtures, stdlib only)', () => {
  let tmp: string;
  let scriptPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'headless-serp-script-'));
    scriptPath = await writeHeadlessPy(tmp);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('bing fixture → 2 organic results (url/title/snippet), b_no ignored', async () => {
    const out = await runParse([
      scriptPath,
      'parse',
      '--engine',
      'bing',
      '--html',
      path.join(fixturesDir, 'bing-serp-1.html'),
      '--query',
      'test query',
    ]);
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('bing');
    expect(out.challenge).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].url).toBe('https://example.com/anthropic-claude');
    expect(out.results[0].title).toContain('Anthropic Claude');
    expect(out.results[1].snippet).toContain('large language models');
  });

  it('google fixture → 1 organic result with decoded url', async () => {
    const out = await runParse([
      scriptPath,
      'parse',
      '--engine',
      'google',
      '--html',
      path.join(fixturesDir, 'google-serp-1.html'),
      '--query',
      'test query',
    ]);
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('google');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].url).toBe('https://example.com/claude');
    expect(out.results[0].title).toContain('Claude AI');
    expect(out.results[0].snippet).toContain('Google snippet');
  });

  it('missing html file → non-zero exit + JSON error on stdout', async () => {
    let failure: any;
    try {
      await runParse([scriptPath, 'parse', '--engine', 'bing', '--html', '/nonexistent/no.html', '--query', 'q']);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeTruthy();
    const out = JSON.parse(failure.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('runtime_error');
  });

  it('SSRF gate (check-url): loopback/private/link-local/reserved all rejected, DNS-free', async () => {
    const blocked = [
      'http://127.0.0.1:3000/admin',
      'http://127.0.0.1/',
      'http://[::1]:3000/x',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
      'file:///etc/passwd',
      'ftp://example.com/f',
    ];
    for (const url of blocked) {
      const out = await runParse([scriptPath, 'check-url', '--url', url]);
      expect(out.ok).toBe(false);
      const blockedBy = (r: string) => r.includes('blocked_host') || r.includes('scheme_not_allowed');
      expect(blockedBy(out.reason)).toBe(true);
    }
  });

  it('SSRF gate: fake-IP range (198.18.0.0/15) blocked by DEFAULT; opt-in env allows (dev TUN machines only)', async () => {
    // RFC 2544 benchmark 段 = TUN fake-IP。安全立场：SSRF 门不信任网络层——
    // 默认拦截；仅显式 PRISMER_HEADLESS_ALLOW_FAKE_IP=1 放行（实验机 opt-in）。
    // IP 字面量用例零 DNS、确定性。
    const url = 'https://198.18.0.14/';
    const strict = await runParse([scriptPath, 'check-url', '--url', url]);
    expect(strict.ok).toBe(false);
    expect(strict.reason).toContain('blocked_host');
    const { stdout } = await execFileAsync('python3', [scriptPath, 'check-url', '--url', url], {
      env: { ...process.env, PRISMER_HEADLESS_ALLOW_FAKE_IP: '1' },
    });
    expect(JSON.parse(stdout).ok).toBe(true);
  });

});

// 注：正面用例（公网 hostname 放行）不写单元测试——开发机 DNS 走 TUN fake-IP
// （198.18.0.0/15 代理拦截段，example.com → 198.18.0.159），SSRF 门会正确地
// 拦截它；允许路径由 pod 内 search/load 真实运行（C6/C1–C3）覆盖。

// ─── 真实 SERP HTML 回归（2026-08-23 抓取自真实引擎，见
// docs/runtime210/evidence/serp-parse-corpus/real-fixtures/）───────────────

describe.skipIf(!hasPython)('headless-serp.py parse (REAL serp html)', () => {
  let tmp: string;
  let scriptPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'headless-serp-real-'));
    scriptPath = await writeHeadlessPy(tmp);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('bing REAL: 10 organic results, ck/a redirects decoded to absolute URLs', async () => {
    const out = await runParse([
      scriptPath,
      'parse',
      '--engine',
      'bing',
      '--html',
      path.join(fixturesDir, 'real', 'bing-1.html'),
      '--query',
      'anthropic claude latest model',
    ]);
    expect(out.ok).toBe(true);
    expect(out.challenge).toBe(false);
    expect(out.results.length).toBeGreaterThanOrEqual(5);
    for (const r of out.results) {
      expect(r.url).toMatch(/^https?:\/\//); // 解包后必须绝对 URL
      expect(r.url).not.toContain('bing.com/ck/a'); // 不允许重定向残留
      expect(r.title).toBeTruthy();
    }
    // 查询相关：anthropic/claude 应出现在结果里
    const joined = out.results.map((r: any) => r.url).join(' ');
    expect(joined).toMatch(/anthropic\.com|wikipedia|claude\.com/);
  });

  it('google REAL: no-JS shell page → 0 results, challenge NOT set (fixed behavior)', async () => {
    // google 无 JS 时返回 JS 壳页（<title>Google Search</title>、无 div.g）——
    // 不是 challenge（无 consent/sorry 标记），真实行为是 0 结果；JS 渲染必须 chromium
    const out = await runParse([
      scriptPath,
      'parse',
      '--engine',
      'google',
      '--html',
      path.join(fixturesDir, 'real', 'google-1.html'),
      '--query',
      'anthropic claude',
    ]);
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(0);
    expect(out.challenge).toBe(false);
  });
});
