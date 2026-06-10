import type {
  AgentDispatchReplyPayload,
  AgentDispatchReplyStatus,
  AgentDispatchRequest,
  AgentDispatchResponse,
} from '../wire/dispatch-types.js';
import type { TaskResult } from '../adapters/contract.js';

export interface MessageDispatchAgent {
  agentImUserId: string;
  dispatch(input: MessageDispatchTaskInput): Promise<TaskResult>;
}

export interface MessageDispatchTaskInput {
  taskId: string;
  prompt: string;
  metadata: {
    source: 'external-channel';
    channelAccountId: string;
    externalUserId: string;
    conversationId: string;
    messageId: string;
    attachments?: AgentDispatchRequest['attachments'];
  };
  timeoutMs: number;
  signal: AbortSignal;
}

export interface MessageDispatchDeps {
  findAgent(agentImUserId: string): Promise<MessageDispatchAgent | null> | MessageDispatchAgent | null;
  postReply(payload: AgentDispatchReplyPayload): Promise<void> | void;
  now?: () => Date;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onError?: (err: unknown, request: AgentDispatchRequest) => void;
}

export interface MessageDispatchHandle {
  response: AgentDispatchResponse;
  done: Promise<AgentDispatchReplyPayload>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function handleAgentMessageDispatch(
  request: AgentDispatchRequest,
  deps: MessageDispatchDeps,
): MessageDispatchHandle {
  const acceptedAt = (deps.now?.() ?? new Date()).toISOString();
  const response: AgentDispatchResponse = { ok: true, acceptedAt };
  const done = runDispatch(request, deps);
  return { response, done };
}

async function runDispatch(
  request: AgentDispatchRequest,
  deps: MessageDispatchDeps,
): Promise<AgentDispatchReplyPayload> {
  let payload: AgentDispatchReplyPayload;
  try {
    const agent = await deps.findAgent(request.mentionedAgentImUserId);
    if (!agent) {
      payload = buildFallbackReply(request, 'agent_offline', 'agent_offline', 'Agent is offline or not hosted by this daemon.', deps);
      await deps.postReply(payload);
      return payload;
    }

    const result = await dispatchWithTimeout(agent, request, deps);
    if (result.ok) {
      payload = {
        replyToken: request.replyToken,
        conversationId: request.conversationId,
        replyToMessageId: request.messageId,
        agentImUserId: request.mentionedAgentImUserId,
        status: 'ok',
        replyText: result.output ?? '',
        attachments: normalizeAttachments(result),
        completedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
    } else {
      payload = buildFallbackReply(
        request,
        result.error?.code === 'task_cancelled' ? 'timeout' : 'agent_error',
        result.error?.code ?? 'agent_error',
        result.error?.message ?? 'Agent dispatch failed.',
        deps,
      );
    }
  } catch (err) {
    deps.onError?.(err, request);
    payload = buildFallbackReply(
      request,
      isAbortError(err) ? 'timeout' : 'agent_error',
      isAbortError(err) ? 'timeout' : 'agent_error',
      err instanceof Error ? err.message : String(err),
      deps,
    );
  }

  await deps.postReply(payload);
  return payload;
}

async function dispatchWithTimeout(
  agent: MessageDispatchAgent,
  request: AgentDispatchRequest,
  deps: MessageDispatchDeps,
): Promise<TaskResult> {
  const timeoutMs = Math.max(1, request.replyDeadlineMs || DEFAULT_TIMEOUT_MS);
  const ctrl = new AbortController();
  const set = deps.setTimeout ?? setTimeout;
  const clear = deps.clearTimeout ?? clearTimeout;
  const timer = set(() => ctrl.abort(), timeoutMs);
  try {
    return await agent.dispatch({
      taskId: `external:${request.messageId}`,
      prompt: request.messageText,
      metadata: {
        source: 'external-channel',
        channelAccountId: request.channelAccountId,
        externalUserId: request.externalUserId,
        conversationId: request.conversationId,
        messageId: request.messageId,
        ...(request.attachments ? { attachments: request.attachments } : {}),
      },
      timeoutMs,
      signal: ctrl.signal,
    });
  } finally {
    clear(timer);
  }
}

function buildFallbackReply(
  request: AgentDispatchRequest,
  status: Exclude<AgentDispatchReplyStatus, 'ok'>,
  code: string,
  message: string,
  deps: MessageDispatchDeps,
): AgentDispatchReplyPayload {
  return {
    replyToken: request.replyToken,
    conversationId: request.conversationId,
    replyToMessageId: request.messageId,
    agentImUserId: request.mentionedAgentImUserId,
    status,
    completedAt: (deps.now?.() ?? new Date()).toISOString(),
    error: { code, message },
  };
}

function normalizeAttachments(result: TaskResult): AgentDispatchReplyPayload['attachments'] {
  const raw = result.metadata?.assetIds;
  if (!Array.isArray(raw)) return undefined;
  const attachments = raw
    .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0)
    .map((assetId) => ({ kind: 'file' as const, assetId }));
  return attachments.length > 0 ? attachments : undefined;
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError');
}
