'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '@/contexts/theme-context';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * Highlight `@mentions` as inline chips (chat surfaces). Off by default so
   * docs / other markdown callers don't accidentally chip an email's `@`.
   * Only `@` at a word boundary (not preceded by an alphanumeric) is matched,
   * so `foo@bar.com` stays plain while `@engineer` becomes a chip.
   */
  highlightMentions?: boolean;
}

// ─── katex lazy-load (release202/13 L3) ───────────────────────────────────
// katex.min.js (~276KB) + katex.min.css (~23KB) used to be STATIC imports,
// dragging ~293KB into every surface that pulls this renderer — even for
// messages with no math at all. We now load katex on demand: only content
// that actually contains `$`/`$$`/`\[`/`\(` triggers the dynamic import. The
// module + CSS are cached at module scope so they load exactly once per tab.
type KatexModule = typeof import('katex');
let katexModule: KatexModule | null = null;
let katexLoadPromise: Promise<KatexModule> | null = null;
let katexCssLoaded = false;

function ensureKatexCss(): void {
  if (katexCssLoaded) return;
  katexCssLoaded = true;
  // Side-effect-only dynamic import of the stylesheet; the bundler emits a
  // separate CSS chunk fetched alongside the JS chunk. TS has no module type
  // for a `.css` import expression (the old code used a side-effect `import`
  // *statement*, which TS doesn't type-check) — suppress the resolution error.
  // @ts-expect-error -- side-effect CSS chunk, no JS module shape
  void import('katex/dist/katex.min.css');
}

function loadKatex(): Promise<KatexModule> {
  if (katexModule) return Promise.resolve(katexModule);
  if (!katexLoadPromise) {
    ensureKatexCss();
    katexLoadPromise = import('katex').then((mod) => {
      // `import('katex')` yields a namespace whose `default` is the katex API.
      katexModule = (mod.default ?? mod) as KatexModule;
      return katexModule;
    });
  }
  return katexLoadPromise;
}

// Cheap up-front scan: does this content reference any math at all? Mirrors the
// delimiters `processMath`/`preprocessContent` recognise ($…$, $$…$$, \[ \],
// \( \)) plus the unwrapped-LaTeX heuristic (a backslash command). False
// positives are harmless (we just load katex needlessly); false negatives would
// drop a formula, so we err toward over-detecting.
function contentHasMath(content: string): boolean {
  if (content.includes('$')) return true;
  if (content.includes('\\[') || content.includes('\\(')) return true;
  // Any `\command` token — covers unwrapped-LaTeX lines like `\frac{a}{b}`.
  return /\\[a-zA-Z]/.test(content);
}

// Render LaTeX math to HTML. Until katex resolves, `katex` is null and we keep
// the raw `$…$` text in place; once loaded the component re-renders and this
// produces the real markup (identical to the old synchronous output).
function renderMath(katex: KatexModule | null, tex: string, displayMode: boolean): string {
  if (!katex) {
    // katex not loaded yet — show the raw source (with delimiters) so the user
    // sees the formula text rather than a blank gap during the brief async load.
    return displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      trust: true,
      strict: false,
    });
  } catch (e) {
    console.error('KaTeX error:', e);
    return `<span class="text-red-400">[Math Error: ${tex}]</span>`;
  }
}

// Detect if a line is primarily a LaTeX math expression without $ wrapping
function isUnwrappedLatexLine(text: string): boolean {
  // If already has $ signs, it's handled elsewhere
  if (text.includes('$')) return false;

  // Check for common LaTeX math patterns
  const latexIndicators = [
    /\\mathcal\{/,
    /\\mathbb\{/,
    /\\frac\{/,
    /\\sum/,
    /\\prod/,
    /\\int/,
    /\\underbrace\{/,
    /\\overbrace\{/,
    /\\text\{/,
    /\\lambda/,
    /\\alpha/,
    /\\beta/,
    /\\gamma/,
    /\\cdot/,
    /\^\{[^}]+\}/,
    /_\{[^}]+\}/,
    /\\[a-zA-Z]+\{/, // Any \command{
  ];

  // Must have at least one clear LaTeX indicator
  const hasLatex = latexIndicators.some((pattern) => pattern.test(text));
  if (!hasLatex) return false;

  // Additional heuristic: should have backslashes and braces
  const backslashCount = (text.match(/\\/g) || []).length;
  const braceCount = (text.match(/[{}]/g) || []).length;

  return backslashCount >= 2 || braceCount >= 4;
}

// Wrap an entire unwrapped LaTeX expression
function wrapUnwrappedLatex(text: string): string {
  if (!text.includes('$') && isUnwrappedLatexLine(text)) {
    // Wrap the entire line as block math
    return `$$${text}$$`;
  }
  return text;
}

// Process inline and block math in text. When `hasMath` is false (cheap scan
// said no delimiters), this is a no-op — we never run the regex passes and never
// touch katex. `katex` may be null even when hasMath is true (still loading);
// renderMath then echoes the raw source until the async load triggers re-render.
function processMath(text: string, katex: KatexModule | null, hasMath: boolean): string {
  if (!hasMath) return text;

  // First, try to wrap any unwrapped LaTeX
  let processed = wrapUnwrappedLatex(text);

  // Convert \[...\] to $$...$$ (block math alternative syntax)
  processed = processed.replace(/\\\[([^\]]+)\\\]/g, '$$$$$1$$$$');

  // Convert \(...\) to $...$ (inline math alternative syntax)
  processed = processed.replace(/\\\(([^)]+)\\\)/g, '$$$1$$');

  // Block math: $$...$$
  let result = processed.replace(/\$\$([^$]+)\$\$/g, (_, tex) => {
    return `<div class="my-4 overflow-x-auto">${renderMath(katex, tex.trim(), true)}</div>`;
  });

  // Inline math: $...$  (but not $$ which we already processed)
  result = result.replace(/(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g, (_, tex) => {
    return renderMath(katex, tex.trim(), false);
  });

  return result;
}

// Pre-process content to handle multi-line LaTeX delimiters
function preprocessContent(content: string): string {
  let processed = content;

  // Convert multi-line \[...\] to $$...$$
  processed = processed.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, tex) => {
    return `$$${tex.trim()}$$`;
  });

  // Convert multi-line \(...\) to $...$
  processed = processed.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_, tex) => {
    return `$${tex.trim()}$`;
  });

  // Remove any remaining standalone \[ or \] that might be leftover
  processed = processed.replace(/^\s*\\\[\s*$/gm, '');
  processed = processed.replace(/^\s*\\\]\s*$/gm, '');

  return processed;
}

export default function MarkdownRenderer({
  content,
  className = '',
  highlightMentions = false,
}: MarkdownRendererProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Cheap scan: only content with math delimiters pays the katex cost.
  const hasMath = useMemo(() => contentHasMath(content), [content]);

  // Holds the katex module once loaded. Starts at the module-scope cache so a
  // second math message in the same tab renders synchronously (no flash).
  const [katex, setKatex] = useState<KatexModule | null>(katexModule);
  useEffect(() => {
    if (!hasMath || katex) return;
    let cancelled = false;
    void loadKatex().then((mod) => {
      if (!cancelled) setKatex(mod);
    });
    return () => {
      cancelled = true;
    };
  }, [hasMath, katex]);

  const elements = useMemo(() => {
    // Pre-process to handle multi-line LaTeX
    const preprocessed = preprocessContent(content);
    const lines = preprocessed.split('\n');
    const result: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let codeBlockLang = '';
    let keyCounter = 0;

    const slugify = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    const processInlineFormatting = (text: string): string => {
      let processed = text;
      // Bold
      processed = processed.replace(
        /\*\*([^*]+)\*\*/g,
        `<strong class="${isDark ? 'text-white' : 'text-zinc-900'} font-semibold">$1</strong>`,
      );
      // Italic
      processed = processed.replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>');
      // Inline code
      processed = processed.replace(
        /`([^`]+)`/g,
        `<code class="px-1.5 py-0.5 ${isDark ? 'bg-zinc-800 text-violet-300' : 'bg-zinc-200 text-violet-600'} rounded text-sm font-mono">$1</code>`,
      );
      // Images (must be before links because of similar syntax)
      processed = processed.replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        '<img src="$2" alt="$1" class="max-w-full h-auto rounded-lg my-2" loading="lazy" referrerpolicy="no-referrer" />',
      );
      // Links
      processed = processed.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener" class="text-violet-400 hover:text-violet-300 underline">$1</a>',
      );
      // @mentions (chat surfaces, opt-in). A negative lookbehind blocks ONLY the
      // email / mid-word case (preceded by an ASCII alphanumeric, e.g.
      // `foo@bar.com`), so `@xxx` still chips when it follows a CJK character,
      // punctuation, a quote, or `>` from a preceding tag — the old
      // `(^|[\s(>，。、:：])` boundary silently dropped the chip for LLM replies
      // like `准备好了@ceo` / `"@ceo"` even though the server still routed them.
      // Name = ASCII handle (incl. `-`/`.`/`_`) or CJK run, mirroring the router.
      if (highlightMentions) {
        processed = processed.replace(
          /(?<![A-Za-z0-9])@([A-Za-z0-9._-]+|[一-龥]+)/g,
          (_m, name) =>
            `<span class="px-1 rounded ${isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-700'}">@${name}</span>`,
        );
      }
      // Math
      processed = processMath(processed, katex, hasMath);
      return processed;
    };

    lines.forEach((line, i) => {
      const key = `line-${keyCounter++}`;

      // Handle code block start/end
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = line.replace('```', '').trim();
          codeBlockContent = [];
        } else {
          inCodeBlock = false;
          result.push(
            <div
              key={key}
              className={`my-4 rounded-lg overflow-hidden border ${isDark ? 'border-white/10' : 'border-zinc-300'}`}
            >
              {codeBlockLang && (
                <div
                  className={`px-4 py-2 border-b text-xs font-mono uppercase ${isDark ? 'bg-zinc-800 border-white/10 text-zinc-500' : 'bg-zinc-100 border-zinc-300 text-zinc-600'}`}
                >
                  {codeBlockLang}
                </div>
              )}
              <pre className={`p-4 overflow-x-auto ${isDark ? 'bg-zinc-900/80' : 'bg-zinc-50'}`}>
                <code className={`text-xs font-mono whitespace-pre ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {codeBlockContent.join('\n')}
                </code>
              </pre>
            </div>,
          );
        }
        return;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        return;
      }

      // Block math (standalone line with $$)
      if (line.trim().startsWith('$$') && line.trim().endsWith('$$')) {
        const tex = line.trim().slice(2, -2);
        result.push(
          <div
            key={key}
            className="my-4 overflow-x-auto flex justify-center"
            dangerouslySetInnerHTML={{ __html: renderMath(katex, tex, true) }}
          />,
        );
        return;
      }

      // H1
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        const title = line.replace('# ', '');
        result.push(
          <h1
            key={key}
            id={slugify(title)}
            className={`text-3xl font-bold mt-6 mb-6 pb-3 scroll-mt-4 ${isDark ? 'text-white border-b border-white/10' : 'text-zinc-900 border-b border-zinc-200'}`}
          >
            {title}
          </h1>,
        );
        return;
      }

      // H2
      if (line.startsWith('## ')) {
        const title = line.replace('## ', '');
        result.push(
          <h2
            key={key}
            id={slugify(title)}
            className={`text-2xl font-bold mt-8 mb-4 scroll-mt-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}
          >
            {title}
          </h2>,
        );
        return;
      }

      // H3
      if (line.startsWith('### ')) {
        const title = line.replace('### ', '');
        result.push(
          <h3
            key={key}
            id={slugify(title)}
            className={`text-lg font-semibold mt-6 mb-3 scroll-mt-4 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}
          >
            {title}
          </h3>,
        );
        return;
      }

      // H4
      if (line.startsWith('#### ')) {
        const title = line.replace('#### ', '');
        result.push(
          <h4 key={key} className={`text-base font-semibold mt-4 mb-2 ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
            {title}
          </h4>,
        );
        return;
      }

      // Horizontal rule
      if (line.trim() === '---' || line.trim() === '***') {
        result.push(<hr key={key} className={`my-6 ${isDark ? 'border-white/10' : 'border-zinc-300'}`} />);
        return;
      }

      // Unordered list (with nesting support)
      const ulMatch = line.match(/^(\s*)[*\-]\s(.+)/);
      if (ulMatch) {
        const indent = Math.floor(ulMatch[1].length / 2);
        const content = ulMatch[2];
        result.push(
          <div key={key} className="flex gap-3 mb-2" style={{ marginLeft: `${indent * 20 + 8}px` }}>
            <div
              className={`w-1.5 h-1.5 rounded-full mt-2.5 flex-shrink-0 ${indent === 0 ? 'bg-violet-500' : indent === 1 ? 'bg-violet-400/60' : 'bg-violet-300/40'}`}
            ></div>
            <p
              className={isDark ? 'text-zinc-300' : 'text-zinc-700'}
              dangerouslySetInnerHTML={{ __html: processInlineFormatting(content) }}
            />
          </div>,
        );
        return;
      }

      // Ordered list (with nesting support)
      const orderedMatch = line.match(/^(\s*)(\d+)\.\s(.+)/);
      if (orderedMatch) {
        const indent = Math.floor(orderedMatch[1].length / 2);
        result.push(
          <div key={key} className="flex gap-3 mb-2" style={{ marginLeft: `${indent * 20 + 8}px` }}>
            <span className={`font-mono text-sm w-6 flex-shrink-0 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>
              {orderedMatch[2]}.
            </span>
            <p
              className={isDark ? 'text-zinc-300' : 'text-zinc-700'}
              dangerouslySetInnerHTML={{ __html: processInlineFormatting(orderedMatch[3]) }}
            />
          </div>,
        );
        return;
      }

      // Blockquote
      if (line.startsWith('> ')) {
        const content = line.replace('> ', '');
        result.push(
          <blockquote
            key={key}
            className={`border-l-4 border-violet-500/50 pl-4 my-4 italic ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
          >
            <p dangerouslySetInnerHTML={{ __html: processInlineFormatting(content) }} />
          </blockquote>,
        );
        return;
      }

      // Table row
      if (line.startsWith('|')) {
        const cols = line.split('|').filter((c) => c.trim() !== '');
        // Skip separator row (e.g. |---|---|)
        if (cols.every((c) => /^[\s:-]+$/.test(c))) return;
        const colCount = cols.length;
        // Detect header: next line is a separator, or this is the first table row
        const nextLine = lines[i + 1];
        const isHeader =
          nextLine?.startsWith('|') &&
          nextLine
            .split('|')
            .filter((c) => c.trim() !== '')
            .every((c) => /^[\s:-]+$/.test(c));
        result.push(
          <div
            key={key}
            className={`grid gap-2 py-2 px-1 font-mono text-xs transition-colors ${
              isHeader
                ? isDark
                  ? 'border-b-2 border-violet-500/30 font-semibold'
                  : 'border-b-2 border-violet-300 font-semibold'
                : isDark
                  ? 'border-b border-white/5 hover:bg-white/5'
                  : 'border-b border-zinc-200 hover:bg-zinc-50'
            }`}
            style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
          >
            {cols.map((c, idx) => (
              <div
                key={idx}
                className={`truncate ${
                  isHeader
                    ? isDark
                      ? 'text-zinc-200'
                      : 'text-zinc-800'
                    : idx === 0
                      ? (isDark ? 'text-zinc-400' : 'text-zinc-600') + ' font-medium'
                      : isDark
                        ? 'text-zinc-300'
                        : 'text-zinc-700'
                }`}
              >
                <span dangerouslySetInnerHTML={{ __html: processInlineFormatting(c.trim()) }} />
              </div>
            ))}
          </div>,
        );
        return;
      }

      // Empty line
      if (line.trim() === '') {
        result.push(<div key={key} className="h-2" />);
        return;
      }

      // Image line (standalone image)
      const imageMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageMatch) {
        result.push(
          <figure key={key} className="my-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageMatch[2]}
              alt={imageMatch[1]}
              className={`max-w-full h-auto rounded-lg shadow-lg ${isDark ? 'border border-white/10' : 'border border-zinc-200'}`}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            {imageMatch[1] && (
              <figcaption className={`text-center text-xs mt-2 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
                {imageMatch[1]}
              </figcaption>
            )}
          </figure>,
        );
        return;
      }

      // Check if the line is an unwrapped LaTeX formula (render as block math)
      if (isUnwrappedLatexLine(line.trim())) {
        result.push(
          <div
            key={key}
            className="my-4 overflow-x-auto flex justify-center"
            dangerouslySetInnerHTML={{ __html: renderMath(katex, line.trim(), true) }}
          />,
        );
        return;
      }

      // Regular paragraph
      result.push(
        <p
          key={key}
          className={`mb-3 leading-7 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
          dangerouslySetInnerHTML={{ __html: processInlineFormatting(line) }}
        />,
      );
    });

    return result;
  }, [content, isDark, katex, hasMath]);

  return (
    <div className={`font-sans leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'} ${className}`}>
      {elements}
    </div>
  );
}
