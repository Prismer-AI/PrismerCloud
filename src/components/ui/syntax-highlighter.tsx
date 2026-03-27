'use client';

import { useState, useEffect } from 'react';

interface SyntaxHighlighterProps {
  code: string;
  language?: string;
}

export function SyntaxHighlighter({ code, language }: SyntaxHighlighterProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const highlight = (text: string) => {
    const html = text
      // Escape HTML
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // JSON/Code Keys (blue/purple)
      .replace(/"(\w+)":/g, '<span class="text-violet-400">"$1"</span>:')
      // Strings (green)
      .replace(/: "([^"]*)"/g, ': <span class="text-emerald-400">"$1"</span>')
      .replace(/'([^']*)'/g, '<span class="text-emerald-400">\'$1\'</span>')
      // Keywords (purple)
      .replace(
        /\b(import|from|const|let|var|function|return|async|await|if|else|true|false|null)\b/g,
        '<span class="text-violet-400 font-bold">$1</span>'
      )
      // Numbers (orange) - avoid matching tailwind classes
      .replace(/(?<![-\w])(\d+)(?![-\w])/g, '<span class="text-amber-400">$1</span>')
      // Comments (gray)
      .replace(/(\/\/.*)/g, '<span class="text-zinc-500 italic">$1</span>');

    return { __html: html };
  };

  // During SSR and initial hydration, render plain code to avoid mismatch
  if (!mounted) {
    return (
      <code className={`language-${language}`}>
        {code}
      </code>
    );
  }

  return (
    <code
      className={`language-${language}`}
      dangerouslySetInnerHTML={highlight(code)}
    />
  );
}

