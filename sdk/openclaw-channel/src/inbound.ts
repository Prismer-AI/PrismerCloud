import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { prismerFetch } from "./api-client.js";
import type { CoreConfig, ResolvedPrismerAccount } from "./types.js";

// WebSocket reconnect config: exponential backoff with jitter
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

/**
 * Register the agent on Prismer IM and start a WebSocket connection
 * for inbound messages.
 */
export async function startPrismerGateway(
  ctx: ChannelGatewayContext<ResolvedPrismerAccount>,
): Promise<{ stop: () => void }> {
  const account = ctx.account;

  if (!account.apiKey) {
    throw new Error(
      `Prismer is not configured for account "${account.accountId}" (need apiKey in channels.prismer).`,
    );
  }

  ctx.log?.info(
    `[${account.accountId}] registering agent on Prismer IM (${account.baseUrl})`,
  );

  // Self-register the agent — must succeed for gateway to work
  let userId: string;
  let token: string;
  try {
    const regResult = (await prismerFetch(account.apiKey, "/api/im/register", {
      method: "POST",
      body: {
        username: account.agentName,
        displayName: account.agentName,
        type: "agent",
      },
      baseUrl: account.baseUrl,
    })) as Record<string, unknown>;

    if (!regResult.ok) {
      throw new Error(`Registration failed: ${JSON.stringify(regResult.error || regResult)}`);
    }
    const data = regResult.data as Record<string, unknown>;
    userId = (data.imUserId ?? data.userId) as string;
    token = data.token as string;
    if (!userId || !token) {
      throw new Error(`Registration returned incomplete data (userId=${userId}, token=${!!token})`);
    }
    ctx.log?.info(`[${account.accountId}] registered as user ${userId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log?.error(`[${account.accountId}] registration failed: ${msg}`);
    throw new Error(`Prismer gateway cannot start: agent registration failed — ${msg}`);
  }

  // Register agent capabilities
  if (userId) {
    try {
      await prismerFetch(account.apiKey, "/api/im/agents/register", {
        method: "POST",
        body: {
          name: account.agentName,
          description: account.description,
          agentType: "assistant",
          capabilities: account.capabilities.map((c) => ({ name: c })),
          protocolVersion: "1.0.0",
        },
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] agent card registered`);
    } catch (err) {
      ctx.log?.warn(
        `[${account.accountId}] agent card warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Connect WebSocket for inbound messages
  let ws: WebSocket | null = null;
  let aborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  if (token) {
    const wsUrl = account.baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const wsEndpoint = `${wsUrl}/api/im/ws?token=${token}`;

    /** Compute delay with exponential backoff + jitter */
    const getReconnectDelay = () => {
      const exp = Math.min(WS_RECONNECT_BASE_MS * 2 ** reconnectAttempt, WS_RECONNECT_MAX_MS);
      const jitter = Math.random() * exp * 0.3; // ±30% jitter
      return Math.floor(exp + jitter);
    };

    const connect = () => {
      if (aborted) return;

      try {
        ws = new WebSocket(wsEndpoint);

        ws.onopen = () => {
          reconnectAttempt = 0; // Reset backoff on successful connect
          ctx.log?.info(`[${account.accountId}] WebSocket connected`);
          ctx.setStatus({
            accountId: account.accountId,
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(String(event.data));
            if (data.type === "message" && data.payload) {
              handleInboundMessage(ctx, account, userId, data.payload);
            }
          } catch (err) {
            ctx.log?.error(
              `[${account.accountId}] message parse error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };

        ws.onclose = () => {
          ctx.log?.info(`[${account.accountId}] WebSocket disconnected`);
          ctx.setStatus({
            accountId: account.accountId,
            running: !aborted,
            connected: false,
            lastStopAt: Date.now(),
          });
          if (!aborted) {
            const delay = getReconnectDelay();
            reconnectAttempt++;
            ctx.log?.info(`[${account.accountId}] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
            reconnectTimer = setTimeout(connect, delay);
          }
        };

        ws.onerror = (err) => {
          ctx.log?.error(`[${account.accountId}] WebSocket error: ${String(err)}`);
        };
      } catch (err) {
        ctx.log?.error(
          `[${account.accountId}] WebSocket connect error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!aborted) {
          const delay = getReconnectDelay();
          reconnectAttempt++;
          reconnectTimer = setTimeout(connect, delay);
        }
      }
    };

    connect();
  }

  // Listen for abort signal
  ctx.abortSignal.addEventListener("abort", () => {
    aborted = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  });

  return {
    stop: () => {
      aborted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

async function handleInboundMessage(
  ctx: ChannelGatewayContext<ResolvedPrismerAccount>,
  account: ResolvedPrismerAccount,
  selfUserId: string,
  msg: Record<string, unknown>,
): Promise<void> {
  const senderId = msg.senderId as string;
  // Skip messages sent by self
  if (senderId === selfUserId) return;

  const content = msg.content as string;
  if (!content) return;

  const isGroup = (msg.conversationType as string) === "group";
  const messageId = msg.id as string;
  const senderName = (msg.senderName as string) || senderId;
  const conversationId = msg.conversationId as string;

  // Evolution suggest: check if message contains error signals → inject recommendation.
  // NOTE: Outcome recording (success/failure) is handled by the agent via the
  // prismer_evolve_record tool, which has full conversation context and avoids
  // false positives from regex-based heuristics on chat messages.
  const ERROR_RE = /error|fail|timeout|crash|exception|denied|refused|oom|panic/i;
  let evolutionHint = '';
  try {
    if (ERROR_RE.test(content)) {
      const signals = [];
      if (/timeout/i.test(content)) signals.push({ type: 'error:timeout' });
      else if (/oom|memory/i.test(content)) signals.push({ type: 'error:oom' });
      else if (/denied|permission|403/i.test(content)) signals.push({ type: 'error:permission_error' });
      else signals.push({ type: 'error:generic' });

      const result = await prismerFetch(account.apiKey, '/api/im/evolution/analyze', {
        method: 'POST',
        body: { signals },
        baseUrl: account.baseUrl,
      }) as any;

      if (result?.ok && result.data?.action === 'apply_gene' && result.data?.confidence > 0.4) {
        const gene = result.data.gene;
        const strategy = gene?.strategy || [];
        evolutionHint = `\n\n---\n[Prismer Evolution] Known fix (${Math.round(result.data.confidence * 100)}% confidence): "${gene?.title}"\n` +
          strategy.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
      }
    }
  } catch {
    // Best-effort — don't break message flow
  }

  // Build MsgContext for OpenClaw's reply pipeline
  const msgCtx = {
    Body: content + evolutionHint,
    From: senderId,
    To: isGroup ? conversationId : selfUserId,
    ChatType: isGroup ? "group" : "direct",
    Provider: "prismer",
    OriginatingChannel: "prismer",
    OriginatingTo: senderId,
    AccountId: account.accountId,
    MessageSid: messageId,
    SenderName: senderName,
    SenderId: senderId,
    Timestamp: Date.now(),
  };

  if (ctx.channelRuntime) {
    ctx.channelRuntime.reply
      .dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgCtx,
        cfg: ctx.cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            const text = payload.text;
            if (!text) return;
            try {
              await prismerFetch(
                account.apiKey,
                `/api/im/direct/${senderId}/messages`,
                {
                  method: "POST",
                  body: { content: text },
                  baseUrl: account.baseUrl,
                },
              );
            } catch (err) {
              ctx.log?.error(
                `[${account.accountId}] reply send error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        },
      })
      .catch((err: unknown) => {
        ctx.log?.error(
          `[${account.accountId}] reply dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  } else {
    // Without channelRuntime, just log the message
    ctx.log?.info(
      `[${account.accountId}] inbound from ${senderName}: ${content.slice(0, 100)}`,
    );
  }
}
