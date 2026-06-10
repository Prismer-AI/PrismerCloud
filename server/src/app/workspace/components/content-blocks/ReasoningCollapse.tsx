'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';

import type { ContentBlockReasoning } from './types';

/**
 * `kind='reasoning'` ContentBlock — default-collapsed "thinking" panel. Body
 * renders as markdown when expanded (Claude reasoning + DeepSeek/o1 traces
 * frequently include lists / code blocks). `redacted=true` renders a
 * disabled chip; the trace bytes never reach the FE in that case (server
 * stripped them per upstream contract).
 */
export function ReasoningCollapse({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockReasoning;
  isOwn?: boolean;
  isDark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (block.redacted) {
    return (
      <div
        data-testid="content-block-reasoning"
        data-content-kind="reasoning"
        data-redacted="true"
        className={`flex max-w-full items-center gap-2 rounded-2xl border px-3 py-1.5 text-[11px] italic ${
          isOwn
            ? 'border-white/20 bg-white/10 text-white/70'
            : isDark
              ? 'border-white/[0.06] bg-white/[0.03] text-zinc-500'
              : 'border-zinc-200 bg-zinc-50 text-zinc-500'
        }`}
      >
        <EyeOff className="h-3 w-3 shrink-0" />
        <span>Reasoning hidden (redacted by provider)</span>
      </div>
    );
  }
  const text = block.text ?? '';
  const truncated = text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  return (
    <div
      data-testid="content-block-reasoning"
      data-content-kind="reasoning"
      data-reasoning-open={open ? 'true' : 'false'}
      className={`flex max-w-full flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
        isOwn
          ? 'border-white/20 bg-white/10'
          : isDark
            ? 'border-white/[0.06] bg-white/[0.03]'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="content-block-reasoning-toggle"
        className={`flex items-center gap-2 text-left ${
          isOwn ? 'text-white/85' : isDark ? 'text-zinc-300' : 'text-zinc-700'
        }`}
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            isOwn ? 'bg-white/20' : isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-100 text-violet-700'
          }`}
        >
          <Brain className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">
          Thinking
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>
      {open ? (
        <div
          data-testid="content-block-reasoning-body"
          className={`prose-chat min-w-0 max-w-full break-words text-[12px] leading-relaxed italic opacity-90 [&_p]:m-0 [&_p+p]:mt-1.5 [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:pl-4 [&_ol]:list-decimal ${
            isOwn ? 'text-white/85' : isDark ? 'text-zinc-300' : 'text-zinc-700'
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{truncated}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}
