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

export interface AgentDispatchReplyPayload {
  replyToken: string;
  conversationId: string;
  replyToMessageId: string;
  agentImUserId: string;
  status: AgentDispatchReplyStatus;
  /** Required when status='ok'. */
  replyText?: string;
  attachments?: AgentDispatchReplyAttachment[];
  completedAt: string;
  /** Required when status!='ok'. */
  error?: { code: string; message: string };
}
