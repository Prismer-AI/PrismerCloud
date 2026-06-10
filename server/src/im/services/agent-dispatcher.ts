import * as crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { RoomManager } from '../ws/rooms';
import { ServerEvents } from '../ws/events';
import type { MessageService } from './message.service';
import type { AssetAttachment } from '../types/index';
import type { WsRpcService } from './ws-rpc.service';
import { isPrivateIpToCloud, probeHttpReachable } from './ws-rpc.service';

/**
 * Mirror `src/im/ws/handler.ts:63 daemonRouteKey()` — kept inline so this
 * service does not import from the ws/ layer (avoids cyclic deps).
 */
function daemonRouteKey(daemonId: string): string {
  return `daemon:${daemonId}`;
}

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
  replyText?: string;
  attachments?: AgentDispatchReplyAttachment[];
  completedAt: string;
  error?: { code: string; message: string };
}

export interface DispatchReplyPersistDeps {
  messageService: Pick<MessageService, 'send'>;
  getParticipantIds: (conversationId: string) => Promise<string[]>;
  rooms?: Pick<RoomManager, 'sendToUser'>;
}

export interface DispatchReplyPersistResult {
  message: Awaited<ReturnType<MessageService['send']>>['message'];
}

export interface ExternalMessageDispatchInput {
  channelAccountId: string;
  externalUserId: string;
  messageId: string;
  messageText: string;
  externalConversationId?: string;
  externalGroupId?: string;
  attachments?: NormalizedContent[];
  replyToken?: string;
  replyDeadlineMs?: number;
}

/**
 * v2.0 §4.8.1 (Wave 4-E4): when neither WS reverse channel nor HTTP gateway
 * is reachable, the dispatch path returns a structured diagnostics payload
 * so the upstream caller can surface a useful error to the user (and the
 * `/runtime/diagnose` endpoint can show the same shape on demand).
 */
export interface WebhookDispatchDiagnostics {
  daemonId: string | null;
  wsAlive: boolean;
  gatewayUrl: string | null;
  gatewayIsPrivate: boolean;
  httpReachable: boolean;
  recommendedTransport: 'ws' | 'http' | 'unreachable';
  lastProbeAt: string | null;
}

export type DispatchTransportUsed = 'ws' | 'http';

export type AgentDispatchResult =
  | {
      dispatched: true;
      mention: string;
      daemonUrl: string;
      /** v2.0 §4.8.1 — which physical path actually carried the dispatch. */
      transport: DispatchTransportUsed;
      payload: AgentDispatchRequest;
      response: AgentDispatchResponse;
    }
  | {
      dispatched: false;
      reason:
        | 'no_mention'
        | 'routing_not_found'
        | 'agent_not_found'
        | 'daemon_not_found'
        | 'daemon_rejected'
        | 'daemon_unreachable';
      mentions: string[];
      payload?: AgentDispatchRequest;
      response?: AgentDispatchResponse;
      diagnostics?: WebhookDispatchDiagnostics;
    };

export interface AgentDispatcherOptions {
  fetch?: typeof fetch;
  daemonBaseUrl?: string;
  resolveDaemonUrl?: (input: {
    daemonId?: string | null;
    gatewayUrl?: string | null;
    agentImUserId: string;
  }) => string | undefined;
  defaultReplyDeadlineMs?: number;
  /**
   * v2.0 §4.8.1 (Wave 4-E4) — when both `rooms` and `wsRpc` are supplied,
   * dispatchExternalMention prefers the WS reverse channel before falling
   * back to HTTP. Optional so existing tests / dev paths keep working with
   * the legacy HTTP-only behaviour.
   */
  rooms?: Pick<RoomManager, 'getClientConnections'>;
  wsRpc?: Pick<WsRpcService, 'invoke'>;
  /**
   * Override the HTTP gateway probe. Defaults to `probeHttpReachable`
   * (HEAD /healthz with a 1.5s timeout). Tests inject a stub.
   */
  httpProbe?: (gatewayUrl: string) => Promise<{ reachable: boolean; latencyMs: number | null }>;
}

const MENTION_RE = /(^|[\s([{"'，。！？、；：])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
const VALID_REPLY_STATUSES = new Set<AgentDispatchReplyStatus>(['ok', 'agent_offline', 'timeout', 'agent_error']);
const REPLY_TOKEN_PREFIX = 'adr1';
const REPLY_TOKEN_GRACE_MS = 60_000;
const DAEMON_DISPATCH_SIGNATURE_HEADER = 'X-Prismer-Dispatch-Signature';
const DAEMON_DISPATCH_TIMESTAMP_HEADER = 'X-Prismer-Dispatch-Timestamp';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function parseAgentMentions(text: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const mention = match[2];
    const key = mention.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(mention);
    }
  }
  return mentions;
}

export function validateAgentDispatchReplyPayload(raw: unknown): AgentDispatchReplyPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('payload must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const payload: AgentDispatchReplyPayload = {
    replyToken: readRequiredString(obj.replyToken, 'replyToken'),
    conversationId: readRequiredString(obj.conversationId, 'conversationId'),
    replyToMessageId: readRequiredString(obj.replyToMessageId, 'replyToMessageId'),
    agentImUserId: readRequiredString(obj.agentImUserId, 'agentImUserId'),
    status: readStatus(obj.status),
    completedAt: readRequiredString(obj.completedAt, 'completedAt'),
  };

  const replyText = readOptionalString(obj.replyText, 'replyText');
  if (replyText !== undefined) payload.replyText = replyText;
  const attachments = normalizeReplyAttachments(obj.attachments);
  if (attachments !== undefined) payload.attachments = attachments;

  if (payload.status === 'ok') {
    if (!payload.replyText?.trim() && !payload.attachments?.length) {
      throw new Error('replyText or attachments is required when status is ok');
    }
  } else {
    const error = normalizeReplyError(obj.error);
    if (!error) {
      throw new Error('error.code and error.message are required when status is not ok');
    }
    payload.error = error;
  }
  validateAgentDispatchReplyToken(payload);

  return payload;
}

export function createAgentDispatchReplyToken(input: {
  channelAccountId: string;
  conversationId: string;
  messageId: string;
  agentImUserId: string;
  ttlMs: number;
  nowMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const claims = {
    c: input.channelAccountId,
    v: input.conversationId,
    m: input.messageId,
    a: input.agentImUserId,
    exp: nowMs + Math.max(1, input.ttlMs),
    n: crypto.randomBytes(8).toString('hex'),
  };
  const encoded = base64UrlJson(claims);
  return `${REPLY_TOKEN_PREFIX}.${encoded}.${signReplyToken(encoded)}`;
}

export function createDaemonDispatchHeaders(body: string, nowMs = Date.now()): Record<string, string> {
  const timestamp = String(nowMs);
  const signature = createDaemonDispatchSignature(body, timestamp);
  return {
    [DAEMON_DISPATCH_TIMESTAMP_HEADER]: timestamp,
    [DAEMON_DISPATCH_SIGNATURE_HEADER]: signature,
  };
}

export function validateAgentDispatchReplyToken(payload: AgentDispatchReplyPayload): void {
  const parts = payload.replyToken.split('.');
  if (parts.length === 3 && parts[0] === REPLY_TOKEN_PREFIX) {
    const [, encoded, signature] = parts;
    const expected = signReplyToken(encoded);
    if (!timingSafeEqual(signature, expected)) {
      throw new Error('replyToken signature is invalid');
    }
    const claims = parseReplyTokenClaims(encoded);
    if (claims.m !== payload.replyToMessageId) {
      throw new Error('replyToken does not match replyToMessageId');
    }
    if (claims.v !== payload.conversationId) {
      throw new Error('replyToken does not match conversationId');
    }
    if (claims.a !== payload.agentImUserId) {
      throw new Error('replyToken does not match agentImUserId');
    }
    if (claims.exp < Date.now()) {
      throw new Error('replyToken has expired');
    }
    return;
  }

  if (legacyReplyTokenAllowed()) {
    const legacyParts = payload.replyToken.split(':');
    if (
      legacyParts.length >= 3 &&
      legacyParts[legacyParts.length - 2] === payload.replyToMessageId &&
      legacyParts[legacyParts.length - 1] === payload.agentImUserId
    ) {
      return;
    }
  }

  throw new Error('replyToken is invalid');
}

export async function persistAgentDispatchReply(
  payload: AgentDispatchReplyPayload,
  deps: DispatchReplyPersistDeps,
): Promise<DispatchReplyPersistResult> {
  const ok = payload.status === 'ok';
  const attachments = toMessageAttachments(payload.attachments);
  const fallbackContent = `Agent dispatch ${payload.status}: ${payload.error?.message ?? 'No reply was produced.'}`;
  const content = ok
    ? payload.replyText?.trim() ||
      (attachments.length > 0 ? `Sent ${attachments.length} file${attachments.length === 1 ? '' : 's'}` : '')
    : fallbackContent;

  const dispatchReplyKey = dispatchReplyCompositeKey(payload);
  const dispatchReplyIdemKey = dispatchReplyIdempotencyKey(payload);

  const result = await deps.messageService.send({
    conversationId: payload.conversationId,
    senderId: payload.agentImUserId,
    type: ok ? 'text' : 'system_event',
    content,
    metadata: {
      _idempotencyKey: dispatchReplyIdemKey,
      dispatchReplyKey,
      kind: ok ? 'agent_reply' : 'agent_status_event',
      source: 'dispatch_reply',
      triggerMessageId: payload.replyToMessageId,
      replyToMessageId: payload.replyToMessageId,
      agentImUserId: payload.agentImUserId,
      dispatchStatus: payload.status,
      completedAt: payload.completedAt,
      ...(payload.error
        ? {
            errorCode: payload.error.code,
            error: payload.error.message,
          }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  const message = result.message;
  const messageMetadata = parseMessageMetadata(message.metadata);
  const createdAt = message.createdAt instanceof Date ? message.createdAt.toISOString() : String(message.createdAt);
  const event = ServerEvents.messageNew({
    id: message.id,
    conversationId: payload.conversationId,
    senderId: message.senderId,
    type: message.type as any,
    content: message.content,
    metadata: messageMetadata,
    attachments: attachments.length > 0 ? attachments : undefined,
    parentId: message.parentId ?? undefined,
    createdAt,
  });
  const participants = await deps.getParticipantIds(payload.conversationId);
  for (const userId of participants) {
    deps.rooms?.sendToUser(userId, event);
  }

  console.log(
    `[AgentDispatcher] Reply persisted: conversation=${payload.conversationId} agent=${payload.agentImUserId} status=${payload.status}`,
  );
  return { message };
}

export class AgentDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultReplyDeadlineMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: AgentDispatcherOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultReplyDeadlineMs = options.defaultReplyDeadlineMs ?? 30_000;
  }

  async dispatchExternalMention(input: ExternalMessageDispatchInput): Promise<AgentDispatchResult> {
    const mentions = parseAgentMentions(input.messageText);
    if (mentions.length === 0) {
      return { dispatched: false, reason: 'no_mention', mentions };
    }

    const routing = await this.prisma.iMExternalRouting.findFirst({
      where: {
        externalIdentity: {
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
        },
      },
      include: { externalIdentity: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!routing) {
      return { dispatched: false, reason: 'routing_not_found', mentions };
    }

    const mention = mentions[0];
    const participant = await this.prisma.iMParticipant.findFirst({
      where: {
        conversationId: routing.conversationId,
        leftAt: null,
        imUser: {
          role: 'agent',
          OR: [{ username: mention }, { displayName: mention }],
        },
      },
      select: { imUser: { select: { id: true, username: true } } },
    });
    const agent = participant?.imUser;
    if (!agent) {
      return { dispatched: false, reason: 'agent_not_found', mentions };
    }

    const container = await this.prisma.iMContainer.findFirst({
      where: {
        agentImUserId: agent.id,
        status: { in: ['running', 'degraded'] },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        daemonId: true,
        gatewayUrl: true,
        // v2.0 §4.8.1 (Wave 4-E4) — daemon-reported transport diagnostics
        // (migration 409). Drives WS-first / HTTP-fallback decision below.
        transport: true,
        gatewayIsPrivate: true,
        lastProbeAt: true,
      },
    });

    const resolvedGateway =
      this.options.resolveDaemonUrl?.({
        daemonId: container?.daemonId,
        gatewayUrl: container?.gatewayUrl,
        agentImUserId: agent.id,
      }) ??
      container?.gatewayUrl ??
      this.options.daemonBaseUrl ??
      process.env.PRISMER_DAEMON_DISPATCH_URL ??
      null;

    if (!container?.daemonId && !resolvedGateway) {
      return { dispatched: false, reason: 'daemon_not_found', mentions };
    }

    const replyDeadlineMs = input.replyDeadlineMs ?? this.defaultReplyDeadlineMs;
    const payload: AgentDispatchRequest = {
      channelAccountId: input.channelAccountId,
      externalUserId: input.externalUserId,
      conversationId: routing.conversationId,
      mentionedAgentImUserId: agent.id,
      messageText: input.messageText,
      messageId: input.messageId,
      attachments: input.attachments,
      replyToken:
        input.replyToken ??
        createAgentDispatchReplyToken({
          channelAccountId: input.channelAccountId,
          conversationId: routing.conversationId,
          messageId: input.messageId,
          agentImUserId: agent.id,
          ttlMs: replyDeadlineMs + REPLY_TOKEN_GRACE_MS,
        }),
      replyDeadlineMs,
    };

    // ── 1. WS-first reverse channel ──────────────────────────────
    // Prefer the WS reverse channel when a daemonId is known AND a shadow
    // client is currently registered. This is the v2.0 §4.8.1 path — works
    // across NAT because the daemon dialed cloud, not the other way around.
    if (container?.daemonId && this.options.rooms && this.options.wsRpc) {
      const routeKey = daemonRouteKey(container.daemonId);
      const wsAlive = this.options.rooms.getClientConnections(routeKey).size > 0;
      if (wsAlive) {
        const rpcResult = await this.options.wsRpc.invoke<AgentDispatchResponse>(
          routeKey,
          'webhook.dispatch.request',
          payload as unknown as Record<string, unknown>,
          {
            timeoutMs: replyDeadlineMs,
            idempotencyKey: input.messageId,
          },
        );
        if (rpcResult.ok) {
          const response: AgentDispatchResponse = {
            ok: rpcResult.reply.ok,
            acceptedAt: rpcResult.reply.acceptedAt,
            error: rpcResult.reply.error,
          };
          console.log(
            `[AgentDispatcher] Dispatch accepted via WS: message=${input.messageId} agent=${agent.id} daemon=${container.daemonId}`,
          );
          return {
            dispatched: true,
            mention,
            daemonUrl: `ws://daemon/${container.daemonId}`,
            transport: 'ws',
            payload,
            response,
          };
        }
        // WS path failed — surface the failure to the caller. We intentionally
        // do NOT retry over HTTP here: the WS shadow was registered (meaning
        // the daemon is alive and connected) so falling back to HTTP would
        // only cover the rare case "WS works but HTTP is faster", which
        // doesn't apply when daemon is behind NAT. Logging a clear marker
        // helps post-mortem the retry storm risk noted in the §4.8.1 design.
        const rpcErr = rpcResult.error;
        if (rpcErr.kind === 'daemon_error') {
          const response: AgentDispatchResponse = {
            ok: false,
            error: { code: rpcErr.code, message: rpcErr.message },
          };
          return { dispatched: false, reason: 'daemon_rejected', mentions, payload, response };
        }
        // timeout / aborted / unexpected daemon_offline (raced disconnect)
        const diagnostics = await this.collectDiagnostics({
          daemonId: container.daemonId,
          gatewayUrl: container.gatewayUrl ?? resolvedGateway ?? null,
          transport: container.transport ?? null,
          gatewayIsPrivate: container.gatewayIsPrivate ?? null,
          lastProbeAt: container.lastProbeAt ?? null,
        });
        return {
          dispatched: false,
          reason: 'daemon_unreachable',
          mentions,
          payload,
          diagnostics,
        };
      }
    }

    // ── 2. HTTP fallback ─────────────────────────────────────────
    // Only when WS is unavailable (no rooms/wsRpc wired, or no shadow client
    // registered) AND the gateway URL is publicly reachable. Private IPs are
    // skipped because cloud (in the public network) cannot dial them — this
    // is the failure mode §4.8.1 is solving.
    if (resolvedGateway && !isPrivateIpToCloud(resolvedGateway)) {
      const body = JSON.stringify(payload);
      let res: Response;
      try {
        res = await this.fetchImpl(joinUrl(resolvedGateway, '/dispatch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...createDaemonDispatchHeaders(body) },
          body,
        });
      } catch (err) {
        const diagnostics = await this.collectDiagnostics({
          daemonId: container?.daemonId ?? null,
          gatewayUrl: resolvedGateway,
          transport: container?.transport ?? null,
          gatewayIsPrivate: container?.gatewayIsPrivate ?? null,
          lastProbeAt: container?.lastProbeAt ?? null,
        });
        console.warn(
          `[AgentDispatcher] HTTP fallback dial failed message=${input.messageId} url=${resolvedGateway}: ${(err as Error).message}`,
        );
        diagnostics.httpReachable = false;
        return { dispatched: false, reason: 'daemon_unreachable', mentions, payload, diagnostics };
      }
      const response = (await res.json().catch(() => ({
        ok: false,
        error: { code: 'invalid_daemon_response', message: 'Daemon returned non-JSON response' },
      }))) as AgentDispatchResponse;

      if (!res.ok || !response.ok) {
        return { dispatched: false, reason: 'daemon_rejected', mentions, payload, response };
      }

      console.log(
        `[AgentDispatcher] Dispatch accepted via HTTP: message=${input.messageId} agent=${agent.id}`,
      );
      return {
        dispatched: true,
        mention,
        daemonUrl: resolvedGateway,
        transport: 'http',
        payload,
        response,
      };
    }

    // ── 3. Unreachable ───────────────────────────────────────────
    const diagnostics = await this.collectDiagnostics({
      daemonId: container?.daemonId ?? null,
      gatewayUrl: resolvedGateway,
      transport: container?.transport ?? null,
      gatewayIsPrivate: container?.gatewayIsPrivate ?? null,
      lastProbeAt: container?.lastProbeAt ?? null,
    });
    return {
      dispatched: false,
      reason: 'daemon_unreachable',
      mentions,
      payload,
      diagnostics,
    };
  }

  /**
   * v2.0 §4.8.1 — collect a structured snapshot of why the daemon is /
   * isn't reachable. Read by `dispatchExternalMention` on failure and
   * re-used by the `/runtime/diagnose` endpoint for ad-hoc probes.
   */
  async collectDiagnostics(input: {
    daemonId: string | null;
    gatewayUrl: string | null;
    transport: string | null;
    gatewayIsPrivate: boolean | null;
    lastProbeAt: Date | null;
  }): Promise<WebhookDispatchDiagnostics> {
    const wsAlive =
      input.daemonId != null && this.options.rooms
        ? this.options.rooms.getClientConnections(daemonRouteKey(input.daemonId)).size > 0
        : false;
    const gatewayIsPrivate =
      input.gatewayIsPrivate ?? (input.gatewayUrl ? isPrivateIpToCloud(input.gatewayUrl) : true);

    let httpReachable = false;
    if (input.gatewayUrl && !gatewayIsPrivate) {
      try {
        const probe = this.options.httpProbe
          ? await this.options.httpProbe(input.gatewayUrl)
          : await probeHttpReachable(input.gatewayUrl);
        httpReachable = probe.reachable;
      } catch {
        httpReachable = false;
      }
    }

    let recommended: WebhookDispatchDiagnostics['recommendedTransport'];
    if (wsAlive) recommended = 'ws';
    else if (httpReachable) recommended = 'http';
    else recommended = 'unreachable';

    return {
      daemonId: input.daemonId,
      wsAlive,
      gatewayUrl: input.gatewayUrl,
      gatewayIsPrivate,
      httpReachable,
      recommendedTransport: recommended,
      lastProbeAt: input.lastProbeAt ? input.lastProbeAt.toISOString() : null,
    };
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function readStatus(value: unknown): AgentDispatchReplyStatus {
  if (typeof value !== 'string' || !VALID_REPLY_STATUSES.has(value as AgentDispatchReplyStatus)) {
    throw new Error('status must be one of: ok, agent_offline, timeout, agent_error');
  }
  return value as AgentDispatchReplyStatus;
}

function normalizeReplyError(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return {
    code: readRequiredString(obj.code, 'error.code'),
    message: readRequiredString(obj.message, 'error.message'),
  };
}

function normalizeReplyAttachments(value: unknown): AgentDispatchReplyAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  const out: AgentDispatchReplyAttachment[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('attachments entries must be objects');
    }
    const obj = item as Record<string, unknown>;
    const kind = obj.kind;
    if (kind !== 'file' && kind !== 'image') {
      throw new Error('attachment.kind must be file or image');
    }
    const assetId = readRequiredString(obj.assetId, 'attachment.assetId');
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    out.push({ kind, assetId });
  }
  return out.length > 0 ? out : undefined;
}

function toMessageAttachments(attachments: AgentDispatchReplyAttachment[] | undefined): AssetAttachment[] {
  return (attachments ?? []).map((attachment) => ({
    kind: attachment.kind,
    assetId: attachment.assetId,
    role: 'output' as const,
  }));
}

function parseMessageMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

function getReplyTokenSecret(): string {
  const secret = process.env.DISPATCH_REPLY_TOKEN_SECRET || process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET;
  if (secret) return secret;
  if (!legacyReplyTokenAllowed()) {
    throw new Error('DISPATCH_REPLY_TOKEN_SECRET or JWT_SECRET is required for dispatch reply tokens');
  }
  return 'dev-dispatch-reply-secret';
}

function legacyReplyTokenAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.APP_ENV !== 'prod' && process.env.APP_ENV !== 'test';
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signReplyToken(encodedClaims: string): string {
  return crypto.createHmac('sha256', getReplyTokenSecret()).update(encodedClaims).digest('base64url');
}

function createDaemonDispatchSignature(body: string, timestamp: string): string {
  const digest = crypto.createHmac('sha256', getDaemonDispatchSecret()).update(`${timestamp}.${body}`).digest('hex');
  return `v1=${digest}`;
}

function getDaemonDispatchSecret(): string {
  const secret = process.env.DISPATCH_DAEMON_SECRET?.trim();
  if (secret) return secret;
  if (daemonDispatchDevFallbackAllowed()) return 'dev-daemon-dispatch-secret';
  throw new Error('DISPATCH_DAEMON_SECRET is required for daemon dispatch authentication');
}

function daemonDispatchDevFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.NODE_ENV !== 'test' &&
    process.env.APP_ENV !== 'prod' &&
    process.env.APP_ENV !== 'test'
  );
}

function dispatchReplyIdempotencyKey(
  payload: Pick<AgentDispatchReplyPayload, 'conversationId' | 'replyToMessageId' | 'agentImUserId'>,
): string {
  const digest = crypto.createHash('sha256').update(dispatchReplyCompositeKey(payload)).digest('hex').slice(0, 48);
  return `dispatch_reply_${digest}`;
}

function dispatchReplyCompositeKey(
  payload: Pick<AgentDispatchReplyPayload, 'conversationId' | 'replyToMessageId' | 'agentImUserId'>,
): string {
  return `dispatch_reply:${payload.conversationId}:${payload.replyToMessageId}:${payload.agentImUserId}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseReplyTokenClaims(encoded: string): { v: string; m: string; a: string; exp: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('replyToken claims are invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('replyToken claims are invalid');
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.v !== 'string' ||
    typeof obj.m !== 'string' ||
    typeof obj.a !== 'string' ||
    typeof obj.exp !== 'number'
  ) {
    throw new Error('replyToken claims are invalid');
  }
  return { v: obj.v, m: obj.m, a: obj.a, exp: obj.exp };
}
