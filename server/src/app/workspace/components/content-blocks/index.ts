/**
 * Wave 4 E5 — v2.0 §4.6 ContentBlock renderer barrel.
 *
 * See `evidence/14-e5-content-block-ui.md`. Dispatcher is
 * `<MessageContentBlocks blocks={…}>`; per-kind components are exported for
 * direct import (e.g. ImageCard in a non-message surface like the inspector
 * dialog).
 */

export { AudioCard } from './AudioCard';
export { FileCard } from './FileCard';
export { ImageCard } from './ImageCard';
export { MessageContentBlocks } from './MessageContentBlocks';
export { ReasoningCollapse } from './ReasoningCollapse';
export { TextLine } from './TextLine';
export { ToolResultBlock } from './ToolResultBlock';
export { ToolUseCard } from './ToolUseCard';
export type {
  ContentBlock,
  ContentBlockAudio,
  ContentBlockFile,
  ContentBlockImage,
  ContentBlockReasoning,
  ContentBlockText,
  ContentBlockToolResult,
  ContentBlockToolUse,
  ContentBlockVideo,
} from './types';
export { isContentBlock, parseContentBlocks } from './types';
