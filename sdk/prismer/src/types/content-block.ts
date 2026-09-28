/**
 * Untrusted rich-reply ContentBlock input accepted from a hosted Runtime.
 *
 * This union is recursively closed over the Input boundary: neither a top-level
 * nor a nested tool result can claim Cloud-owned PKF locator/authority fields.
 */
export type AgentDispatchReplyContentBlockTextInput = { kind: 'text'; text: string };
export type AgentDispatchReplyContentBlockImageInput = {
  kind: 'image';
  assetId: string;
  mediaType: string;
  alt?: string;
};
export type AgentDispatchReplyContentBlockAudioInput = {
  kind: 'audio';
  assetId: string;
  mediaType: string;
  durationMs?: number;
};
export type AgentDispatchReplyContentBlockVideoInput = {
  kind: 'video';
  assetId: string;
  mediaType: string;
  durationMs?: number;
  thumbnailUrl?: string;
};
export type AgentDispatchReplyContentBlockFileInput = {
  kind: 'file';
  assetId: string;
  mediaType: string;
  filename: string;
};
export type AgentDispatchReplyContentBlockToolUseInput = {
  kind: 'tool_use';
  toolCallId: string;
  toolName: string;
  inputJson: unknown;
};
export type AgentDispatchReplyContentBlockReasoningInput = {
  kind: 'reasoning';
  text: string;
  redacted?: boolean;
};
export interface AgentDispatchReplyPkfContentBlockInput {
  kind: 'pkf';
  source: string;
  title?: string;
}
export type AgentDispatchReplyContentBlockToolResultInput = {
  kind: 'tool_result';
  toolCallId: string;
  output: AgentDispatchReplyContentBlockInput[];
  isError?: boolean;
  errorMessage?: string;
};

export type AgentDispatchReplyContentBlockInput =
  | AgentDispatchReplyContentBlockTextInput
  | AgentDispatchReplyContentBlockImageInput
  | AgentDispatchReplyContentBlockAudioInput
  | AgentDispatchReplyContentBlockVideoInput
  | AgentDispatchReplyContentBlockFileInput
  | AgentDispatchReplyContentBlockToolUseInput
  | AgentDispatchReplyContentBlockToolResultInput
  | AgentDispatchReplyContentBlockReasoningInput
  | AgentDispatchReplyPkfContentBlockInput;
