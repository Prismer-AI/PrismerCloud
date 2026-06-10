'use client';

import { AudioCard } from './AudioCard';
import { FileCard } from './FileCard';
import { ImageCard } from './ImageCard';
import { ReasoningCollapse } from './ReasoningCollapse';
import { TextLine } from './TextLine';
import { ToolResultBlock } from './ToolResultBlock';
import { ToolUseCard } from './ToolUseCard';
import type { ContentBlock } from './types';

/**
 * v2.0 §4.6 ContentBlock dispatcher — iterates `blocks` and routes each
 * variant to its kind-specific component. Used by `im-channel.tsx` as the
 * preferred renderer when `message.contentBlocks` is populated; the legacy
 * `attachments` + `content` path remains as fallback for the 6-sprint
 * double-write window (migration 406 keeps both columns; `MessageDTO` carries
 * both fields side-by-side).
 *
 * `tool_result` blocks recurse back through this dispatcher so a nested
 * `[{ kind:'text' }, { kind:'image' }, ...]` output renders inline below
 * the tool-call card. Nesting depth is capped at 4 to avoid pathologic
 * recursion if a malformed payload self-references.
 */
const MAX_NESTING_DEPTH = 4;

export function MessageContentBlocks({
  blocks,
  isOwn = false,
  isDark = false,
  depth = 0,
}: {
  blocks: ContentBlock[];
  isOwn?: boolean;
  isDark?: boolean;
  /** Nesting depth — only set internally by ToolResultBlock recursion. */
  depth?: number;
}) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  if (depth > MAX_NESTING_DEPTH) {
    return (
      <span
        data-testid="content-block-depth-overflow"
        className={`text-[10px] italic ${isOwn ? 'text-white/60' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
      >
        (nested content omitted — too deep)
      </span>
    );
  }
  return (
    <div data-testid="content-blocks-root" data-block-count={blocks.length} className="flex flex-col gap-1.5">
      {blocks.map((block, idx) => {
        const key = `block-${idx}-${block.kind}`;
        switch (block.kind) {
          case 'text':
            return <TextLine key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'image':
            return <ImageCard key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'audio':
            return <AudioCard key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'video':
            return <VideoBlockSlot key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'file':
            return <FileCard key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'tool_use':
            return <ToolUseCard key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          case 'tool_result':
            return (
              <ToolResultBlock
                key={key}
                block={block}
                isOwn={isOwn}
                isDark={isDark}
                depth={depth + 1}
                renderBlocks={MessageContentBlocks}
              />
            );
          case 'reasoning':
            return <ReasoningCollapse key={key} block={block} isOwn={isOwn} isDark={isDark} />;
          default:
            return <UnknownBlockSlot key={key} block={block} isOwn={isOwn} isDark={isDark} />;
        }
      })}
    </div>
  );
}

// Lazy import is gnarly; instead delegate the video render to its own slot
// component that simply re-imports VideoCard — this keeps the switch above
// linear and lets the tree-shaker do its job. Same pattern for the unknown
// fallback below.
import { VideoCard } from './VideoCard';

function VideoBlockSlot(props: Parameters<typeof VideoCard>[0] extends infer P ? P : never) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <VideoCard {...(props as any)} />;
}

function UnknownBlockSlot({ block, isOwn, isDark }: { block: ContentBlock; isOwn?: boolean; isDark?: boolean }) {
  const kind = (block as { kind?: string }).kind ?? 'unknown';
  return (
    <span
      data-testid="content-block-unknown"
      data-content-kind={kind}
      className={`text-[10px] italic ${isOwn ? 'text-white/60' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
    >
      [unknown content block: {kind}]
    </span>
  );
}
