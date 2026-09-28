import type {
  AgentDispatchReplyContentBlockInput,
  AgentDispatchReplyPkfContentBlockInput,
} from '../types/content-block.js';

export type NormalizedContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'file'; url: string; fileName: string; mime: string }
  | { type: 'voice'; url: string; durationMs: number }
  | { type: 'video'; url: string; caption?: string };

export interface AgentDispatchRequest {
  channelAccountId: string;
  externalUserId: string;
  conversationId: string;
  mentionedAgentImUserId: string;
  messageText: string;
  messageId: string;
  attachments?: NormalizedContent[];
  replyToken: string;
  replyDeadlineMs: number;
  /**
   * runtime210/09 §2.3 — persistent workdir spec (same shape as the WS
   * TaskDispatchRequestPayload.workdir). Optional: absent → the daemon keeps
   * the legacy per-task scratch behavior.
   */
  workdir?: { id: string; cwd: string; source: 'clone' | 'init' | 'host-pick' | 'container-pick'; sourceRef?: string };
}

export interface AgentDispatchResponse {
  ok: boolean;
  /** ISO8601 timestamp. Required when ok=true. */
  acceptedAt?: string;
  error?: { code: string; message: string };
}

export type AgentDispatchReplyStatus = 'ok' | 'agent_offline' | 'timeout' | 'agent_error';

export interface AgentDispatchReplyAttachment {
  kind: 'file' | 'image';
  assetId: string;
}

export type { AgentDispatchReplyContentBlockInput, AgentDispatchReplyPkfContentBlockInput };

/** @deprecated Agent replies are untrusted input; use the explicit Input name. */
export type AgentDispatchReplyPkfContentBlock = AgentDispatchReplyPkfContentBlockInput;

export interface AgentDispatchReplyPayload {
  replyToken: string;
  conversationId: string;
  replyToMessageId: string;
  agentImUserId: string;
  status: AgentDispatchReplyStatus;
  /** Required when status='ok'. */
  replyText?: string;
  attachments?: AgentDispatchReplyAttachment[];
  contentBlocks?: AgentDispatchReplyContentBlockInput[];
  completedAt: string;
  /** Required when status!='ok'. */
  error?: { code: string; message: string };
}
