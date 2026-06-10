'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';

import type { ContentBlockToolUse } from './types';

/**
 * `kind='tool_use'` ContentBlock — folded display of the tool name plus a
 * collapsed preview of the JSON args. Click toggles a full pretty-printed
 * view (read-only `<pre>`). Mirrors the ActionRow styling already used in
 * the workspace MessageActionBar so the visual vocabulary stays consistent.
 */
export function ToolUseCard({
  block,
  isOwn = false,
  isDark = false,
}: {
  block: ContentBlockToolUse;
  isOwn?: boolean;
  isDark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = formatPreview(block.inputJson);
  const pretty = formatPretty(block.inputJson);

  return (
    <div
      data-testid="content-block-tool-use"
      data-content-kind="tool_use"
      data-tool-call-id={block.toolCallId}
      className={`flex max-w-full flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
        isOwn
          ? 'border-white/20 bg-white/15'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04]'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 text-left ${
          isOwn ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
        }`}
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            isOwn ? 'bg-white/20' : isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-100 text-violet-700'
          }`}
        >
          <Wrench className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{block.toolName || 'tool'}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>
      {!open ? (
        <span
          className={`truncate text-[11px] ${
            isOwn ? 'text-white/75' : isDark ? 'text-zinc-400' : 'text-zinc-600'
          }`}
        >
          {preview}
        </span>
      ) : (
        <pre
          data-testid="content-block-tool-use-pretty"
          className={`max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl p-2 font-mono text-[11px] leading-relaxed ${
            isOwn ? 'bg-white/10 text-white/90' : isDark ? 'bg-black/30 text-zinc-200' : 'bg-white text-zinc-700'
          }`}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}

function formatPreview(inputJson: unknown): string {
  if (inputJson == null) return '(no args)';
  if (typeof inputJson === 'string') return inputJson.length > 80 ? `${inputJson.slice(0, 80)}…` : inputJson;
  try {
    const oneLine = JSON.stringify(inputJson);
    if (!oneLine) return '(no args)';
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
  } catch {
    return '(unserialisable args)';
  }
}

function formatPretty(inputJson: unknown): string {
  if (inputJson == null) return '(no args)';
  if (typeof inputJson === 'string') return inputJson;
  try {
    return JSON.stringify(inputJson, null, 2);
  } catch {
    return String(inputJson);
  }
}
