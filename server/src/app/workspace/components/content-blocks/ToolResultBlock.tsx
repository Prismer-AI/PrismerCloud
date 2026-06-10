'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';

import type { ContentBlock, ContentBlockToolResult } from './types';

/**
 * Renderer signature for nested ContentBlock[] payloads. The parent
 * `MessageContentBlocks` passes itself in via this prop so we can recurse
 * without an explicit `import` (which would form a cycle:
 * MessageContentBlocks → ToolResultBlock → MessageContentBlocks).
 */
export type NestedBlockRenderer = (props: {
  blocks: ContentBlock[];
  isOwn?: boolean;
  isDark?: boolean;
  depth?: number;
}) => ReactNode;

/**
 * `kind='tool_result'` ContentBlock — wraps a tool-call's output payload,
 * which itself is a `ContentBlock[]` (so a tool can return text + images +
 * nested tool_use, etc). Recurses through `renderBlocks` (the
 * `MessageContentBlocks` dispatcher injected by the parent) so each inner
 * block uses the same kind-dispatcher.
 *
 * Folded by default; preview line shows the inner block count so the user
 * knows how much detail is hidden. `depth` is propagated by the parent to
 * cap pathological recursion (see MessageContentBlocks.MAX_NESTING_DEPTH).
 */
export function ToolResultBlock({
  block,
  isOwn = false,
  isDark = false,
  depth = 0,
  renderBlocks,
}: {
  block: ContentBlockToolResult;
  isOwn?: boolean;
  isDark?: boolean;
  depth?: number;
  renderBlocks: NestedBlockRenderer;
}) {
  const [open, setOpen] = useState(true); // default-open: results are usually the answer
  const inner = Array.isArray(block.output) ? block.output : [];
  const countLabel = inner.length === 1 ? '1 item' : `${inner.length} items`;
  return (
    <div
      data-testid="content-block-tool-result"
      data-content-kind="tool_result"
      data-tool-call-id={block.toolCallId}
      data-inner-count={inner.length}
      className={`flex max-w-full flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
        isOwn
          ? 'border-emerald-300/30 bg-emerald-400/10'
          : isDark
            ? 'border-emerald-500/[0.12] bg-emerald-500/[0.04]'
            : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 text-left ${
          isOwn ? 'text-white' : isDark ? 'text-emerald-200' : 'text-emerald-700'
        }`}
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            isOwn
              ? 'bg-white/20 text-white'
              : isDark
                ? 'bg-emerald-500/15 text-emerald-200'
                : 'bg-emerald-100 text-emerald-700'
          }`}
        >
          <CheckCircle2 className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">tool result · {countLabel}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>
      {open ? (
        <div data-testid="content-block-tool-result-body">{renderBlocks({ blocks: inner, isOwn, isDark, depth })}</div>
      ) : null}
    </div>
  );
}
