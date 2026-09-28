/**
 * Headless SERP helper (runtime210/01 experiment).
 *
 * The sandbox image ships playwright + chromium as first-class capability
 * (infra/sandbox-image/Dockerfile.daemon:136-144), so bing/google SERP
 * fetching and URL content reading run IN the pod, next to the agent —
 * zero cloud search/compress cost, no new image dependency.
 *
 * The python script is EMBEDDED as a template string and written to
 * ~/.prismer/cache/headless-serp.py at runtime (zero OTA bundle changes).
 * JSON-line protocol:
 *
 *   parse  --engine bing|google --html FILE [--query Q]  → stdlib only, no playwright
 *   search --engine bing|google --query Q                → needs playwright + chromium
 *   load   --url U                                       → needs playwright + chromium
 *
 * stdout = single JSON object; non-zero exit carries {"error": code}.
 * Exit codes: 0 ok · 2 parse/io · 3 playwright_missing · 5 usage.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { defaultPrismerCacheDir } from './seen-journal.js';

/**
 * Python source. Parsing (bing b_algo / google div.g) uses only stdlib
 * HTMLParser so `parse --html` runs on ANY python3 (unit tests need no
 * chromium); only `search`/`load` import playwright (exit 3 when missing).
 * Deliberately regex-free — the embedded template must survive TS template
 * literal processing (backslashes would be eaten).
 */
export const PY_SOURCE = `#!/usr/bin/env python3
"""Prismer headless SERP helper (runtime-generated).

JSON-line protocol: a single JSON object on stdout.
Exit codes: 0 ok, 2 parse/io error, 3 playwright_missing, 5 usage error.

Modes:
  parse  --engine bing|google --html FILE [--query Q]  (stdlib only, no playwright)
  search --engine bing|google --query Q                (needs playwright + chromium)
  load   --url U                                       (needs playwright + chromium)
"""
import argparse
import base64
import ipaddress
import json
import os
import socket
import sys
import urllib.parse
from html.parser import HTMLParser

CHALLENGE_MARKERS = (
    "consent.google",
    "/sorry/",
    "unusual traffic",
    "captcha",
    "verify you are human",
    "robot check",
)

# void elements never emit an end tag — pushing them onto the element stack
# desyncs every later endtag. Chromium-rendered bing SERPs start each
# li.b_algo with <link rel="stylesheet">; without this the whole li is lost
# (live-found 2026-08-23).
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}


# RFC 2544 benchmark segment — the fake-IP range TUN proxies use (Clash/Surge
# etc.). DEFAULT: blocked like any reserved range — an SSRF gate must not
# trust the network layer, and "198.18.x maps to public via TUN" is a
# configuration assumption the code cannot verify. Only an EXPLICIT
# opt-in (PRISMER_HEADLESS_ALLOW_FAKE_IP=1, dev/experiment machines known to
# run TUN fake-IP) exempts this range; pod/production keep the strict gate
# (2026-08-23 security review).
FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
ALLOW_FAKE_IP = os.environ.get("PRISMER_HEADLESS_ALLOW_FAKE_IP") == "1"


def host_is_public(hostname):
    """SSRF gate: every resolved address must be public (no loopback/private/
    link-local/reserved/multicast). Returns (ok, reason)."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        return False, "dns_failed: %s" % exc
    if not infos:
        return False, "no_addresses"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip in FAKE_IP_NETWORK:
            if ALLOW_FAKE_IP:
                continue  # 显式 opt-in（本机 TUN fake-IP 实验环境）
            return False, "blocked_host: %s (fake-ip)" % ip
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False, "blocked_host: %s" % ip
    return True, None


def validate_public_url(url):
    """http(s) only + host must resolve to public addresses (SSRF gate)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, "scheme_not_allowed: %s" % parsed.scheme
    if not parsed.hostname:
        return False, "no_hostname"
    return host_is_public(parsed.hostname)


def decode_bing_redirect(url):
    """Bing organic results are https://www.bing.com/ck/a?...&u=a1<base64url>
    redirects; the real target URL is the base64url payload. Live-verified on
    real SERP HTML (2026-08-23): organic hits decode to the absolute target;
    non-organic page links decode to relative /search|/images... paths —
    those are kept as-is (still ck/a) so consumers never chase bing internals.
    """
    if "bing.com/ck/a" not in url:
        return url
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    uval = qs.get("u", [None])[0]
    if not uval or not uval.startswith("a1"):
        return url
    payload = uval[2:].encode("utf-8")
    padded = payload + b"=" * (-len(payload) % 4)
    try:
        raw = base64.b64decode(padded, altchars=b"-_")
        decoded = raw.decode("utf-8", errors="replace")
        if decoded.startswith(("http://", "https://")):
            return decoded
        return url  # relative bing-internal links: keep the ck/a pointer
    except Exception:
        return url


def emit(payload, exit_code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\\n")
    sys.exit(exit_code)


def fail(code, message):
    emit({"ok": False, "error": code, "message": message}, exit_code=2)


class BingParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self.cur = None
        self.stack = []
        self.in_link = 0

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if self.cur is None:
            if tag == "li" and "b_algo" in classes:
                self.cur = {"rank": len(self.results) + 1, "url": None, "title": None, "snippet": None}
                self.stack.append("algo")
            return
        if tag == "a" and self.cur["url"] is None:
            href = attrs.get("href")
            if href:
                self.cur["url"] = decode_bing_redirect(href)
                self.in_link += 1
                return
            self.stack.append("other")
            return
        if tag == "p" and self.cur["snippet"] is None:
            self.stack.append("snippet")
            return
        self.stack.append("other")

    def handle_data(self, data):
        if self.cur is None:
            return
        if self.in_link > 0 and self.cur["title"] is None:
            title = " ".join(data.split())
            if title:
                self.cur["title"] = title
        elif self.stack and self.stack[-1] == "snippet" and self.cur["snippet"] is None:
            snippet = " ".join(data.split())
            if snippet:
                self.cur["snippet"] = snippet

    def handle_endtag(self, tag):
        if tag == "a" and self.in_link > 0:
            self.in_link -= 1
            return
        if not self.stack:
            return
        kind = self.stack.pop()
        if kind == "algo" and self.cur is not None:
            if self.cur["url"]:
                self.results.append(self.cur)
            self.cur = None


class GoogleParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results = []
        self.cur = None
        self.stack = []
        self.in_link = 0

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        attrs = dict(attrs)
        classes = attrs.get("class", "").split()
        if self.cur is None:
            if tag == "div" and "g" in classes:
                self.cur = {"rank": len(self.results) + 1, "url": None, "title": None, "snippet": None}
                self.stack.append("g")
            return
        if tag == "a" and self.cur["url"] is None:
            href = attrs.get("href", "")
            if href.startswith("/url?q="):
                q = href[len("/url?q="):].split("&", 1)[0]
                self.cur["url"] = urllib.parse.unquote(q)
                self.in_link += 1
                return
            self.stack.append("other")
            return
        if tag == "div" and "VwiC3b" in classes and self.cur["snippet"] is None:
            self.stack.append("snippet")
            return
        self.stack.append("other")

    def handle_data(self, data):
        if self.cur is None:
            return
        if self.in_link > 0 and self.cur["title"] is None:
            title = " ".join(data.split())
            if title:
                self.cur["title"] = title
        elif self.stack and self.stack[-1] == "snippet" and self.cur["snippet"] is None:
            snippet = " ".join(data.split())
            if snippet:
                self.cur["snippet"] = snippet

    def handle_endtag(self, tag):
        if tag == "a" and self.in_link > 0:
            self.in_link -= 1
            return
        if not self.stack:
            return
        kind = self.stack.pop()
        if kind == "g" and self.cur is not None:
            if self.cur["url"]:
                self.results.append(self.cur)
            self.cur = None


class TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "template"}

    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip_depth > 0:
            self.skip_depth -= 1

    def handle_data(self, data):
        if self.skip_depth == 0:
            text = " ".join(data.split())
            if text:
                self.parts.append(text)


def extract_text(html):
    p = TextExtractor()
    try:
        p.feed(html)
    except Exception:
        pass
    return " ".join(p.parts)


def load_html(file_path):
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def serp_url(engine, query):
    q = urllib.parse.quote_plus(query)
    if engine == "bing":
        return "https://www.bing.com/search?q=%s&count=10" % q
    return "https://www.google.com/search?q=%s&num=10&hl=en&gl=us" % q


def parse_serp(engine, html):
    parser = BingParser() if engine == "bing" else GoogleParser()
    try:
        parser.feed(html)
    except Exception as exc:
        fail("parse_error", "parser failed: %s" % exc)
    results = parser.results
    low = html.lower()
    challenge = len(results) == 0 and any(m in low for m in CHALLENGE_MARKERS)
    return {"ok": True, "engine": engine, "results": results, "challenge": challenge}


def playwright_fetch(url):
    ok, reason = validate_public_url(url)
    if not ok:
        fail("ssrf_blocked", reason)
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        emit({"ok": False, "error": "playwright_missing", "message": str(exc)}, exit_code=3)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()

            def block_private(route):
                r = urllib.parse.urlparse(route.request.url)
                if r.hostname:
                    hok, _ = host_is_public(r.hostname)
                    if not hok:
                        route.abort()
                        return
                route.continue_()

            # 拦截私有/回环子资源与重定向跳转（SSRF 纵深）
            page.route("**/*", block_private)
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            final_ok, final_reason = validate_public_url(page.url)
            if not final_ok:
                fail("ssrf_blocked", "final_url: %s" % final_reason)
            html = page.content()
            title = page.title()
        finally:
            browser.close()
    return html, title


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(prog="headless-serp")
    ap.add_argument("mode", choices=["parse", "search", "load", "check-url"])
    ap.add_argument("--engine", choices=["bing", "google"])
    ap.add_argument("--html")
    ap.add_argument("--query")
    ap.add_argument("--url")
    args = ap.parse_args()
    try:
        if args.mode == "parse":
            if not args.engine or not args.html:
                fail("usage_error", "parse requires --engine and --html")
            html = load_html(args.html)
            emit(parse_serp(args.engine, html))
        elif args.mode == "search":
            if not args.engine or not args.query:
                fail("usage_error", "search requires --engine and --query")
            html, _ = playwright_fetch(serp_url(args.engine, args.query))
            emit(parse_serp(args.engine, html))
        elif args.mode == "load":
            if not args.url:
                fail("usage_error", "load requires --url")
            html, title = playwright_fetch(args.url)
            emit({"ok": True, "url": args.url, "title": title, "text": extract_text(html)})
        elif args.mode == "check-url":
            if not args.url:
                fail("usage_error", "check-url requires --url")
            ok, reason = validate_public_url(args.url)
            emit({"ok": ok, "url": args.url, "reason": reason})
    except SystemExit:
        raise
    except Exception as exc:
        fail("runtime_error", str(exc))


if __name__ == "__main__":
    main()
`;

/**
 * Write the embedded python to cacheDir (idempotent). Returns the script path.
 * Tests use the same helper so fixture parsing runs on the real script.
 */
export async function writeHeadlessPy(cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, 'headless-serp.py');
  if (existsSync(file)) return file;
  await writeFile(file, PY_SOURCE, 'utf8');
  return file;
}

// ─── engine chain (runtime210/01 experiment) ─────────────────────────────────

export type SerpEngine = 'bing' | 'google' | 'ddg';

export interface ProviderAttempt {
  provider: 'headless' | 'cloud';
  engine?: SerpEngine;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface SerpResultItem {
  rank: number;
  url: string;
  title: string;
  snippet: string;
  engine: SerpEngine;
}

export interface HeadlessSearchOutcome {
  ok: boolean;
  results: SerpResultItem[];
  attempts: ProviderAttempt[];
  challenge?: boolean;
  error?: string;
}

export interface HeadlessSearchOptions {
  /** Engine chain order. Default ['bing','ddg'] — google is flag-gated by the caller. */
  engines?: SerpEngine[];
  /** Python binary. Default PRISMER_PYTHON || 'python3'. */
  python?: string;
  /** Where the embedded script lives. Default ~/.prismer/cache. */
  cacheDir?: string;
  /** Per-engine timeout. Default 30s. */
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Min gap between SERP runs (安全围栏). Default 2s; tests pass 0. */
  minIntervalMs?: number;
}

/** UA for the plain-HTTP engine (ddg html endpoint gates on UA). */
const SERP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

interface EngineResult {
  ok: boolean;
  results: SerpResultItem[];
  challenge: boolean;
  error?: string;
}

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coalescing single-flight: a concurrent call with the SAME query shares the
 * in-flight promise (one SERP fetch); a different query waits its turn (pod
 * 内 headless 并发 1). The min-interval rail is enforced before engines run.
 */
let inFlight: { query: string; promise: Promise<HeadlessSearchOutcome> } | null = null;
let lastFinishedAt = 0;

export async function runHeadlessSearch(
  query: string,
  opts: HeadlessSearchOptions = {},
): Promise<HeadlessSearchOutcome> {
  if (inFlight) {
    if (inFlight.query === query) return inFlight.promise;
    await inFlight.promise.catch(() => {});
  }
  const promise = doSearch(query, opts);
  inFlight = { query, promise };
  try {
    return await promise;
  } finally {
    inFlight = null;
  }
}

async function doSearch(query: string, opts: HeadlessSearchOptions): Promise<HeadlessSearchOutcome> {
  const engines = opts.engines ?? ['bing', 'ddg'];
  const python = opts.python ?? process.env.PRISMER_PYTHON ?? 'python3';
  const cacheDir = opts.cacheDir ?? defaultPrismerCacheDir();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const minIntervalMs = opts.minIntervalMs ?? 2_000;

  const wait = lastFinishedAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);

  const attempts: ProviderAttempt[] = [];
  for (const engine of engines) {
    const started = Date.now();
    const r: EngineResult =
      engine === 'ddg'
        ? await ddgSearch(query, fetchImpl, timeoutMs)
        : await pythonSearch(engine, query, python, cacheDir, timeoutMs);
    const ms = Date.now() - started;
    if (r.challenge) {
      attempts.push({ provider: 'headless', engine, ok: false, ms, error: 'challenge' });
      continue;
    }
    if (!r.ok || r.results.length === 0) {
      attempts.push({ provider: 'headless', engine, ok: false, ms, error: r.error ?? 'no_results' });
      continue;
    }
    attempts.push({ provider: 'headless', engine, ok: true, ms });
    lastFinishedAt = Date.now();
    return { ok: true, results: r.results, attempts, challenge: false };
  }
  lastFinishedAt = Date.now();
  const anyChallenge = attempts.some((a) => a.error === 'challenge');
  return { ok: false, results: [], attempts, challenge: anyChallenge || undefined, error: 'all_engines_failed' };
}

async function pythonSearch(
  engine: Exclude<SerpEngine, 'ddg'>,
  query: string,
  python: string,
  cacheDir: string,
  timeoutMs: number,
): Promise<EngineResult> {
  let script: string;
  try {
    script = await writeHeadlessPy(cacheDir);
  } catch (err) {
    return { ok: false, results: [], challenge: false, error: `script_write_failed: ${errText(err)}` };
  }
  try {
    const { stdout } = await execFileAsync(python, [script, 'search', '--engine', engine, '--query', query], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout) as {
      ok?: boolean;
      results?: Array<{ url?: string; title?: string; snippet?: string }>;
      challenge?: boolean;
      error?: string;
    };
    if (parsed?.ok !== true) {
      return { ok: false, results: [], challenge: false, error: parsed?.error ?? 'engine_error' };
    }
    const results: SerpResultItem[] = (parsed.results ?? []).map((r, i) => ({
      rank: i + 1,
      url: r.url ?? '',
      title: r.title ?? '',
      snippet: r.snippet ?? '',
      engine,
    }));
    return { ok: results.length > 0, results, challenge: parsed.challenge === true };
  } catch (err) {
    return { ok: false, results: [], challenge: false, error: `python_failed: ${errText(err)}` };
  }
}

async function ddgSearch(query: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<EngineResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let html: string;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': SERP_UA, accept: 'text/html' },
    });
    if (!res.ok) return { ok: false, results: [], challenge: false, error: `http_${res.status}` };
    html = await res.text();
  } catch (err) {
    return { ok: false, results: [], challenge: false, error: `ddg_fetch_failed: ${errText(err)}` };
  }
  const pairs: Array<{ href: string; title: string }> = [];
  const reTitle = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = reTitle.exec(html))) {
    const href = decodeHref(m[1] ?? '');
    const title = cleanText(m[2] ?? '');
    if (href && title) pairs.push({ href, title });
  }
  const snippets: string[] = [];
  const reSnippet = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
  while ((m = reSnippet.exec(html))) {
    const s = cleanText(m[1] ?? '');
    if (s) snippets.push(s);
  }
  const results: SerpResultItem[] = pairs.map((p, i) => ({
    rank: i + 1,
    url: p.href,
    title: p.title,
    snippet: snippets[i] ?? '',
    engine: 'ddg',
  }));
  const challenge = results.length === 0 && /anomaly/i.test(html);
  return { ok: results.length > 0, results, challenge };
}

export interface HeadlessLoadOutcome {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  error?: string;
  attempts: ProviderAttempt[];
}

/**
 * Read a URL's text via the embedded python `load` mode (chromium in the pod;
 * skipped to ddg-style plain HTTP is NOT available for reads — a failed read
 * just falls back to the cloud load path).
 */
export async function runHeadlessLoad(url: string, opts: HeadlessSearchOptions = {}): Promise<HeadlessLoadOutcome> {
  const python = opts.python ?? process.env.PRISMER_PYTHON ?? 'python3';
  const cacheDir = opts.cacheDir ?? defaultPrismerCacheDir();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const attempts: ProviderAttempt[] = [];
  try {
    const script = await writeHeadlessPy(cacheDir);
    const { stdout } = await execFileAsync(python, [script, 'load', '--url', url], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; url?: string; title?: string; text?: string; error?: string };
    if (parsed?.ok !== true) throw new Error(parsed?.error ?? 'engine_error');
    attempts.push({ provider: 'headless', ok: true, ms: Date.now() - started });
    return { ok: true, url: parsed.url ?? url, title: parsed.title, text: parsed.text, attempts };
  } catch (err) {
    attempts.push({ provider: 'headless', ok: false, ms: Date.now() - started, error: errText(err) });
    return { ok: false, url, error: errText(err), attempts };
  }
}

function decodeHref(href: string): string {
  const unescaped = href.replace(/&amp;/g, '&');
  const uddg = unescaped.match(/uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      return unescaped;
    }
  }
  if (unescaped.startsWith('http')) return unescaped;
  if (unescaped.startsWith('//')) return `https:${unescaped}`;
  return unescaped;
}

function cleanText(raw: string): string {
  const noTags = raw.replace(/<[^>]+>/g, '');
  const decoded = noTags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  return decoded.replace(/\s+/g, ' ').trim();
}
