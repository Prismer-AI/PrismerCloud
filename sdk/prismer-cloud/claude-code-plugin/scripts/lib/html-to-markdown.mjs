/**
 * HTML → Markdown converter + raw content fetcher
 * Uses Turndown (same library as Claude Code) for high-quality conversion.
 */

import TurndownService from 'turndown';

const MAX_RAW_CHARS = 512 * 1024; // ~512K characters cap

// ── Turndown instance (reused across calls) ────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',        // # Heading
  codeBlockStyle: 'fenced',   // ```code```
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',       // [text](url)
});

// Remove non-content elements
turndown.remove(['script', 'style', 'svg', 'noscript', 'nav', 'footer', 'iframe']);

// ── HTML → Markdown ────────────────────────────────────────────

export function htmlToMarkdown(html) {
  if (!html || typeof html !== 'string') return '';

  // Try to extract main content area (reduces sidebar/ad noise)
  const mainMatch =
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const source = mainMatch ? mainMatch[0] : html;

  let md = turndown.turndown(source);

  // Size cap
  if (md.length > MAX_RAW_CHARS) {
    md = md.slice(0, MAX_RAW_CHARS) + '\n\n[... truncated at 512KB]';
  }

  return md;
}

// ── Extract <title> ────────────────────────────────────────────

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').trim().slice(0, 200);
}

// ── Fetch raw content from URL ─────────────────────────────────

export async function fetchRawContent(url, timeoutMs = 6000) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/') && !ct.includes('application/json') && !ct.includes('application/xml') && !ct.includes('application/xhtml')) {
      return null;
    }

    const raw = await res.text();
    if (raw.length < 200) return null;

    // HTML → Turndown markdown
    if (ct.includes('html') || raw.includes('<html') || raw.includes('<!DOCTYPE')) {
      const title = extractTitle(raw);
      const md = htmlToMarkdown(raw);
      return { markdown: md, title, originalBytes: raw.length };
    }

    // Plain text / JSON — return as-is with size cap
    let content = raw;
    if (content.length > MAX_RAW_CHARS) {
      content = content.slice(0, MAX_RAW_CHARS) + '\n\n[... truncated at 512KB]';
    }
    return { markdown: content, title: '', originalBytes: raw.length };
  } catch {
    return null;
  }
}
