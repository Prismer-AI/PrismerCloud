'use client';

/**
 * MemoryTextPreview — minimal markdown rendering for the Memory detail panel
 * and the IM-channel "View memory" inline preview.
 *
 * Mirrors the visual treatment used by `AssetPreview` in
 * `workspace-inspector-dialog.tsx` (mono-spaced `<pre>` block inside a
 * scroll container) so memory pages and `text/markdown` assets read the same.
 *
 * Adds inline link interception that the underlying `<pre><code>` cannot do:
 *
 *   - `prismer://workspace/<wsId>/memory/<path>` → calls `onJumpToMemory(path)`
 *     so the host (LibraryMemoryPanel) can navigate without a page reload.
 *   - `https://…` and `http://…` → opens in a new tab. Per doc 18 the audit
 *     fetch happens server-side; the client just emits the click.
 *
 * Deliberately does **not** introduce a markdown library — the renderer is a
 * line-based, regex-driven walker that handles headings, paragraphs, lists,
 * code fences, inline code, and links. Anything richer (tables, images,
 * reference-style links) renders as the underlying source text.
 */

import { Fragment, type ReactNode } from 'react';

interface MemoryTextPreviewProps {
  content: string;
  isDark: boolean;
  onJumpToMemory?: (path: string) => void;
}

const PRISMER_MEMORY_URI = /^prismer:\/\/workspace\/[^/]+\/memory\/(.+)$/;
const URL_PATTERN = /(prismer:\/\/[^\s)]+|https?:\/\/[^\s)]+)/g;
const LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_CODE = /`([^`]+)`/g;
/**
 * Memory page content can be agent-authored (proposals) or pasted by a
 * human, so a markdown link's `href` is not trusted input. Allow only
 * schemes whose anchor handlers cannot execute script: http(s), the
 * platform's own `prismer://`, mailto, fragment links, and rooted
 * paths. Anything else (notably `javascript:` and `data:`) renders as
 * plain text — see code-review C1.
 *
 * Rooted paths are restricted to a single leading `/` followed by a
 * non-`/` char; `//evil.com/...` would otherwise be resolved by the
 * browser as `https://evil.com/...` (open-redirect / phishing vector).
 */
const SAFE_LINK_SCHEME = /^(?:https?:|prismer:|mailto:|#|\/(?!\/))/i;

export function MemoryTextPreview({ content, isDark, onJumpToMemory }: MemoryTextPreviewProps) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre
          key={key++}
          data-testid="memory-text-codeblock"
          className={`my-3 overflow-x-auto rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
            isDark ? 'border-white/[0.06] bg-zinc-950/60 text-zinc-200' : 'border-zinc-200 bg-zinc-50 text-zinc-800'
          }`}
        >
          {lang ? (
            <span
              className={`mb-1 block text-[9px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              {lang}
            </span>
          ) : null}
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Heading.
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls =
        level === 1
          ? 'mt-4 text-lg font-bold'
          : level === 2
            ? 'mt-4 text-base font-bold'
            : level === 3
              ? 'mt-3 text-sm font-bold'
              : 'mt-2 text-xs font-semibold uppercase tracking-wider';
      blocks.push(
        <p key={key++} className={`${cls} ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {renderInline(text, isDark, onJumpToMemory, key)}
        </p>,
      );
      i += 1;
      continue;
    }

    // List item.
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      blocks.push(
        <p
          key={key++}
          className={`pl-${Math.min(8, listMatch[1].length / 2 + 4)} text-xs leading-relaxed ${
            isDark ? 'text-zinc-300' : 'text-zinc-700'
          }`}
          style={{ paddingLeft: `${Math.min(32, listMatch[1].length * 2 + 12)}px` }}
        >
          <span className={`mr-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{listMatch[2]}</span>
          {renderInline(listMatch[3], isDark, onJumpToMemory, key)}
        </p>,
      );
      i += 1;
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Plain paragraph (collapse following non-blank, non-special lines).
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^\s*([-*+]|\d+\.)\s/)
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={key++} className={`text-xs leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
        {renderInline(buf.join(' '), isDark, onJumpToMemory, key)}
      </p>,
    );
  }

  return (
    <div data-testid="memory-text-preview" className="space-y-2 px-1 py-2">
      {blocks}
    </div>
  );
}

/**
 * Render inline markdown segments — links, inline code, raw URLs.
 * Honors a tokenization order: explicit `[label](url)` links first, then
 * inline code, then bare URLs.
 */
function renderInline(
  text: string,
  isDark: boolean,
  onJumpToMemory: ((path: string) => void) | undefined,
  baseKey: number,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let segmentKey = baseKey * 1000;

  // Collect all markdown link spans first so we don't double-process URLs
  // inside their hrefs.
  const reservedRanges: Array<{ start: number; end: number; label: string; href: string }> = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    if (match.index === undefined) continue;
    reservedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
      label: match[1],
      href: match[2],
    });
  }

  reservedRanges.forEach((range, idx) => {
    if (cursor < range.start) {
      parts.push(...tokenizeNonLink(text.slice(cursor, range.start), isDark, onJumpToMemory, segmentKey));
      segmentKey += 100;
    }
    parts.push(buildLink(range.href, range.label, isDark, onJumpToMemory, `link-${idx}-${segmentKey++}`));
    cursor = range.end;
  });

  if (cursor < text.length) {
    parts.push(...tokenizeNonLink(text.slice(cursor), isDark, onJumpToMemory, segmentKey));
  }

  return parts;
}

/**
 * Walk a span that has no `[label](url)` constructs and emit:
 *  - inline code spans
 *  - bare URLs (prismer:// or http(s)://)
 *  - plain text in between
 */
function tokenizeNonLink(
  text: string,
  isDark: boolean,
  onJumpToMemory: ((path: string) => void) | undefined,
  baseKey: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  let key = baseKey;

  // First split out inline code spans.
  type CodeRange = { start: number; end: number; literal: string };
  const codeRanges: CodeRange[] = [];
  for (const m of text.matchAll(INLINE_CODE)) {
    if (m.index === undefined) continue;
    codeRanges.push({ start: m.index, end: m.index + m[0].length, literal: m[1] });
  }

  let segments: Array<{ start: number; end: number; kind: 'code' | 'plain' }> = [];
  let pos = 0;
  for (const range of codeRanges) {
    if (range.start > pos) segments.push({ start: pos, end: range.start, kind: 'plain' });
    segments.push({ start: range.start, end: range.end, kind: 'code' });
    pos = range.end;
  }
  if (pos < text.length) segments.push({ start: pos, end: text.length, kind: 'plain' });
  if (segments.length === 0) segments = [{ start: 0, end: text.length, kind: 'plain' }];

  for (const seg of segments) {
    const sliceText = text.slice(seg.start, seg.end);
    if (seg.kind === 'code') {
      out.push(
        <code
          key={`c-${key++}`}
          className={`rounded px-1 py-0.5 font-mono text-[10px] ${
            isDark ? 'bg-white/[0.06] text-violet-200' : 'bg-zinc-100 text-violet-700'
          }`}
        >
          {sliceText.slice(1, -1)}
        </code>,
      );
      continue;
    }
    // Plain segment — extract bare URLs.
    let inner = 0;
    for (const m of sliceText.matchAll(URL_PATTERN)) {
      if (m.index === undefined) continue;
      if (m.index > inner) out.push(<Fragment key={`t-${key++}`}>{sliceText.slice(inner, m.index)}</Fragment>);
      out.push(buildLink(m[0], m[0], isDark, onJumpToMemory, `u-${key++}`));
      inner = m.index + m[0].length;
    }
    if (inner < sliceText.length) {
      out.push(<Fragment key={`t-${key++}`}>{sliceText.slice(inner)}</Fragment>);
    }
  }

  return out;
}

function buildLink(
  href: string,
  label: string,
  isDark: boolean,
  onJumpToMemory: ((path: string) => void) | undefined,
  reactKey: string,
): ReactNode {
  const trimmedHref = href.trim();
  if (!SAFE_LINK_SCHEME.test(trimmedHref)) {
    return (
      <span
        key={reactKey}
        data-testid="memory-text-blocked-link"
        title={`Blocked link scheme: ${trimmedHref.split(':')[0] || 'unknown'}`}
        className={isDark ? 'text-zinc-400' : 'text-zinc-500'}
      >
        {label}
      </span>
    );
  }
  const memoryMatch = trimmedHref.match(PRISMER_MEMORY_URI);
  if (memoryMatch && onJumpToMemory) {
    const memoryPath = memoryMatch[1];
    return (
      <button
        key={reactKey}
        type="button"
        data-testid="memory-text-internal-link"
        data-memory-path={memoryPath}
        onClick={() => onJumpToMemory(memoryPath)}
        className={`underline decoration-dotted underline-offset-2 transition-colors ${
          isDark ? 'text-violet-300 hover:text-violet-200' : 'text-violet-700 hover:text-violet-900'
        }`}
      >
        {label}
      </button>
    );
  }
  if (trimmedHref.startsWith('prismer://')) {
    return (
      <span
        key={reactKey}
        data-testid="memory-text-prismer-link-uninterceptable"
        className={`underline decoration-dotted underline-offset-2 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
      >
        {label}
      </span>
    );
  }
  return (
    <a
      key={reactKey}
      href={trimmedHref}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="memory-text-external-link"
      className={`underline underline-offset-2 transition-colors ${
        isDark ? 'text-violet-300 hover:text-violet-200' : 'text-violet-700 hover:text-violet-900'
      }`}
    >
      {label}
    </a>
  );
}
