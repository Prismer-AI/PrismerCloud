'use client';

import { useState, useEffect, useRef } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Highlighter } from 'shiki';

// Module-level highlighter cache — created once, reused across all CodeBlock instances
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['vitesse-dark', 'vitesse-light'],
        langs: ['typescript', 'python', 'go', 'bash', 'json', 'yaml'],
      })
    );
  }
  return highlighterPromise;
}

// Normalize language names for shiki
function normalizeLang(lang: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    js: 'typescript',
    javascript: 'typescript',
    py: 'python',
    golang: 'go',
    sh: 'bash',
    shell: 'bash',
    curl: 'bash',
  };
  return map[lang] || lang;
}

interface CodeBlockProps {
  code: string;
  language?: string;
  isDark?: boolean;
  className?: string;
}

export function CodeBlock({ code, language = 'typescript', isDark = true, className = '' }: CodeBlockProps) {
  const [html, setHtml] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const lang = normalizeLang(language);
  const theme = isDark ? 'vitesse-dark' : 'vitesse-light';

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then(highlighter => {
      if (cancelled) return;
      try {
        const result = highlighter.codeToHtml(code.trim(), {
          lang,
          theme,
        });
        setHtml(result);
      } catch {
        // Language not loaded — render plain
        setHtml('');
      }
    });
    return () => { cancelled = true; };
  }, [code, lang, theme]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code.trim());
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`relative group ${className}`}>
      <button
        onClick={handleCopy}
        className={`absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10 ${
          isDark
            ? 'bg-zinc-700/80 hover:bg-zinc-600 text-zinc-300'
            : 'bg-zinc-200/80 hover:bg-zinc-300 text-zinc-600'
        }`}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>

      {html ? (
        <div
          className="[&>pre]:!rounded-xl [&>pre]:!p-4 [&>pre]:!text-xs [&>pre]:!leading-relaxed [&>pre]:overflow-x-auto [&>pre]:!m-0"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={`rounded-xl p-4 text-xs leading-relaxed overflow-x-auto m-0 ${
          isDark ? 'bg-[#121212] text-zinc-300' : 'bg-[#fafafa] text-zinc-700'
        }`}>
          <code>{code.trim()}</code>
        </pre>
      )}
    </div>
  );
}
