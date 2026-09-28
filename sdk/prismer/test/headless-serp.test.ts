// runtime210/01 experiment — engine chain tests (stubbed python binary +
// stubbed fetch; no real network, no chromium).
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadlessSearch } from '../src/daemon/web/headless-serp.js';

const OK_BING = JSON.stringify({
  ok: true,
  engine: 'bing',
  results: [{ url: 'https://s.example/1', title: 'S One', snippet: 'snip one' }],
});

describe('headless engine chain', () => {
  let tmp: string;
  let stubSeq = 0;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'headless-chain-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Fake python binary: echoes the given JSON; optionally appends "call" to logFile. */
  async function stubPython(output: string, logFile?: string): Promise<string> {
    const body = logFile
      ? `#!/bin/sh\nprintf '%s' "call" >> "${logFile}"\nprintf '%s' '${output}'`
      : `#!/bin/sh\nprintf '%s' '${output}'`;
    const p = path.join(tmp, `stub-${++stubSeq}.sh`);
    await writeFile(p, body);
    await chmod(p, 0o755);
    return p;
  }

  const htmlResponse = (html: string): typeof fetch =>
    (async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;

  it('bing engine via python stub → results + attempt ok', async () => {
    const py = await stubPython(OK_BING);
    const out = await runHeadlessSearch('q', { engines: ['bing'], python: py, cacheDir: tmp, minIntervalMs: 0 });
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ engine: 'bing', url: 'https://s.example/1', title: 'S One' });
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ provider: 'headless', engine: 'bing', ok: true });
  });

  it('ddg engine via fetch stub → decoded uddg url + cleaned title/snippet', async () => {
    const target = `//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/ddg-target')}&rut=abc`;
    const html = `<html><body>
      <a rel="nofollow" class="result__a" href="${target}">DDG Title &amp; More</a>
      <a class="result__snippet" href="${target}">DDG snippet text.</a>
    </body></html>`;
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(String(url));
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as typeof fetch;
    const out = await runHeadlessSearch('q', { engines: ['ddg'], fetchImpl: fetchStub, minIntervalMs: 0 });
    expect(out.ok).toBe(true);
    expect(out.results[0]).toMatchObject({
      engine: 'ddg',
      url: 'https://example.com/ddg-target',
      title: 'DDG Title & More',
      snippet: 'DDG snippet text.',
    });
    expect(calls[0]).toContain('https://html.duckduckgo.com/html/?q=q');
  });

  it('bing fails → ddg tried; chain continues', async () => {
    const py = await stubPython('{bad json');
    let ddgCalls = 0;
    const fetchStub = (async () => {
      ddgCalls++;
      return new Response('<a class="result__a" href="https://d.example/1">D One</a>', { status: 200 });
    }) as typeof fetch;
    const out = await runHeadlessSearch('q', {
      engines: ['bing', 'ddg'],
      python: py,
      fetchImpl: fetchStub,
      cacheDir: tmp,
      minIntervalMs: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.results[0].engine).toBe('ddg');
    expect(ddgCalls).toBe(1);
    expect(out.attempts.map((a) => a.engine)).toEqual(['bing', 'ddg']);
    expect(out.attempts[0].ok).toBe(false);
  });

  it('all engines fail → ok:false + attempts all false', async () => {
    const py = await stubPython('{bad json');
    const fetchStub = (async () => new Response('no results here', { status: 200 })) as typeof fetch;
    const out = await runHeadlessSearch('q', {
      engines: ['bing', 'ddg'],
      python: py,
      fetchImpl: fetchStub,
      cacheDir: tmp,
      minIntervalMs: 0,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('all_engines_failed');
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('challenge → engine marked unavailable, chain continues', async () => {
    const py = await stubPython(JSON.stringify({ ok: true, engine: 'bing', results: [], challenge: true }));
    const fetchStub = (async () =>
      new Response('<a class="result__a" href="https://c.example/1">C One</a>', { status: 200 })) as typeof fetch;
    const out = await runHeadlessSearch('q', {
      engines: ['bing', 'ddg'],
      python: py,
      fetchImpl: fetchStub,
      cacheDir: tmp,
      minIntervalMs: 0,
    });
    expect(out.ok).toBe(true);
    expect(out.results[0].engine).toBe('ddg');
    expect(out.attempts[0]).toMatchObject({ engine: 'bing', ok: false, error: 'challenge' });
  });

  it('ddg REAL: anomaly challenge page → 0 results + challenge flag (2026-08-23 真实抓取)', async () => {
    // html.duckduckgo.com 对无浏览器流量返回 202 + anomaly 挑战页（真实抓取，
    // 见 docs/runtime210/evidence/serp-parse-corpus/real-fixtures/ddg-1.html）
    const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'serp');
    const real = await readFile(path.join(fixturesDir, 'real', 'ddg-1.html'), 'utf8');
    const fetchStub = (async () => new Response(real, { status: 202 })) as typeof fetch;
    const out = await runHeadlessSearch('q', { engines: ['ddg'], fetchImpl: fetchStub, minIntervalMs: 0 });
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(0);
    expect(out.challenge).toBe(true);
    expect(out.attempts[0]).toMatchObject({ engine: 'ddg', ok: false, error: 'challenge' });
  });

  it('single-flight: concurrent same-query calls share ONE engine invocation', async () => {
    const log = path.join(tmp, 'calls.log');
    const py = await stubPython(OK_BING, log);
    const [a, b] = await Promise.all([
      runHeadlessSearch('same', { engines: ['bing'], python: py, cacheDir: tmp, minIntervalMs: 0 }),
      runHeadlessSearch('same', { engines: ['bing'], python: py, cacheDir: tmp, minIntervalMs: 0 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.results[0].url).toBe(b.results[0].url);
    const calls = await readFile(log, 'utf8');
    expect(calls).toBe('call'); // exactly one invocation
  });
});
