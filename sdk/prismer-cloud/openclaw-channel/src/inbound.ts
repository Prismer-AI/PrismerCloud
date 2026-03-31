import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { prismerFetch } from "./api-client.js";
import { detectSignals, hasErrorIndicators } from "./signal-patterns.js";
import {
  isFirstMessage,
  recordMessage,
  recordCleanMessage,
  getStuckSignals,
  setPendingGene,
  consumePendingGene,
  shouldWriteMemory,
  markMemoryWritten,
  markStartupInjected,
  buildConversationSummary,
} from "./conversation-tracker.js";
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
      const jitter = Math.random() * exp * 0.3; // +/-30% jitter
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

// ─── Inbound Message Handler ────────────────────────────────────────────

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
  const conversationId = (msg.conversationId as string) || `dm-${senderId}`;
  const scope = account.scope;

  // ─── L3: Startup Context Injection ─────────────────────────────────
  // On first message in a conversation, fetch memory + evolution context.
  let startupContext = '';
  if (isFirstMessage(conversationId)) {
    startupContext = await fetchStartupContext(account, scope);
    markStartupInjected(conversationId);
  }

  // ─── L2: Auto Gene Feedback ────────────────────────────────────────
  // If previous message injected a gene suggestion, check if this
  // message indicates success (no errors) or failure (still has errors).
  await processAutoGeneFeedback(account, conversationId, content, scope);

  // ─── L1: Full Signal Detection ─────────────────────────────────────
  // Use the shared signal-patterns module for 12+ error pattern types.
  let evolutionHint = '';
  const hasErrors = hasErrorIndicators(content);

  if (hasErrors) {
    const signals = detectSignals(content);
    const state = recordMessage(conversationId, content, signals);

    // ─── L2: Stuck Detection ───────────────────────────────────────
    // Check if any signal type has appeared 2+ times in this conversation.
    const stuckSignals = getStuckSignals(conversationId);

    try {
      const signalObjects = (stuckSignals.length > 0 ? stuckSignals : signals)
        .map(type => ({ type }));

      const query: Record<string, string> = {};
      if (scope) query.scope = scope;

      const result = await prismerFetch(account.apiKey, '/api/im/evolution/analyze', {
        method: 'POST',
        body: { signals: signalObjects },
        baseUrl: account.baseUrl,
        query,
      }) as Record<string, unknown>;

      if (result?.ok && (result.data as Record<string, unknown>)?.action === 'apply_gene') {
        const data = result.data as Record<string, unknown>;
        const confidence = data.confidence as number;
        // Lower threshold when stuck (agent is repeating errors)
        const threshold = stuckSignals.length > 0 ? 0.2 : 0.4;

        if (confidence >= threshold) {
          const gene = data.gene as Record<string, unknown>;
          const strategy = (gene?.strategy || []) as string[];
          const stuckNote = stuckSignals.length > 0
            ? ` (repeated ${state.signalCounts.get(stuckSignals[0]) || 0}x in conversation)`
            : '';

          evolutionHint = `\n\n---\n[Prismer Evolution] Known fix${stuckNote} (${Math.round(confidence * 100)}% confidence): "${gene?.title}"\n` +
            strategy.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n') +
            `\n\nAfter resolving: call prismer_evolve_record with gene_id="${data.gene_id}" and outcome (success/failed). Then call prismer_memory_write to persist learnings.`;

          // Track pending gene for auto-feedback
          setPendingGene(conversationId, {
            geneId: (data.gene_id as string) || (gene?.id as string) || '',
            geneTitle: (gene?.title as string) || '',
            signals,
            suggestedAt: Date.now(),
          });
        }
      } else if (result?.ok && (result.data as Record<string, unknown>)?.action !== 'apply_gene') {
        // No gene matched, but error detected
        evolutionHint = `\n\n[Prismer Evolution] No known fix for this pattern. After resolving, call prismer_evolve_report to teach the system. Call prismer_memory_write to persist learnings.`;
      }
    } catch {
      // Best-effort — don't break message flow
    }

    // ─── L3: Periodic Memory Write ─────────────────────────────────
    if (shouldWriteMemory(conversationId)) {
      writeConversationMemory(account, conversationId, scope).catch(() => {});
    }
  } else {
    // No errors in this message — just track it
    recordCleanMessage(conversationId, content);
  }

  // ─── Build MsgContext for OpenClaw's reply pipeline ────────────────
  const enrichedContent = startupContext + content + evolutionHint;

  const msgCtx = {
    Body: enrichedContent,
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

// ─── L2: Auto Gene Feedback ──────────────────────────────────────────

/**
 * After an evolution hint is injected and the agent's NEXT response arrives,
 * automatically record success/failure based on whether error signals are present.
 */
async function processAutoGeneFeedback(
  account: ResolvedPrismerAccount,
  conversationId: string,
  content: string,
  scope: string,
): Promise<void> {
  const pending = consumePendingGene(conversationId);
  if (!pending) return;

  const hasErrors = hasErrorIndicators(content);
  const outcome = hasErrors ? 'failed' : 'success';

  try {
    const query: Record<string, string> = {};
    if (scope) query.scope = scope;

    await prismerFetch(account.apiKey, '/api/im/evolution/record', {
      method: 'POST',
      body: {
        gene_id: pending.geneId,
        signals: pending.signals,
        outcome,
        summary: `Auto-feedback: gene "${pending.geneTitle}" ${outcome} (conversation ${conversationId.slice(0, 8)})`,
      },
      baseUrl: account.baseUrl,
      query,
    });
  } catch {
    // Best-effort — don't break message flow
  }
}

// ─── L3: Startup Context Injection ───────────────────────────────────

/**
 * Fetch memory summary + evolution context for the start of a conversation.
 * Returns a context prefix to prepend to the first message.
 */
async function fetchStartupContext(
  account: ResolvedPrismerAccount,
  scope: string,
): Promise<string> {
  const parts: string[] = [];

  try {
    // Fetch memory summary
    const memQuery: Record<string, string> = {};
    if (scope) memQuery.scope = scope;

    const [memResult, evolResult] = await Promise.allSettled([
      prismerFetch(account.apiKey, '/api/im/memory/load', {
        query: memQuery,
        baseUrl: account.baseUrl,
      }),
      prismerFetch(account.apiKey, '/api/im/evolution/sync', {
        method: 'POST',
        body: { pull: { since: 0, scope } },
        baseUrl: account.baseUrl,
      }),
    ]);

    // Memory context
    if (memResult.status === 'fulfilled') {
      const mem = memResult.value as Record<string, unknown>;
      if (mem?.ok) {
        const data = mem.data as Record<string, unknown>;
        const content = data?.content as string;
        if (content && content.trim().length > 10) {
          const truncated = content.length > 1500
            ? content.slice(0, 1500) + '\n...(truncated)'
            : content;
          parts.push(`[Prismer Memory]\n${truncated}`);
        }
      }
    }

    // Evolution context — top proven genes
    if (evolResult.status === 'fulfilled') {
      const evol = evolResult.value as Record<string, unknown>;
      if (evol?.ok) {
        const data = evol.data as Record<string, unknown>;
        const pulled = data?.pulled as Record<string, unknown>;
        const genes = (pulled?.genes || []) as Record<string, unknown>[];

        const topGenes = genes
          .filter(g => {
            const total = ((g.successCount as number) || 0) + ((g.failureCount as number) || 0);
            return total >= 3;
          })
          .sort((a, b) => {
            const aTotal = Math.max(((a.successCount as number) || 0) + ((a.failureCount as number) || 0), 1);
            const bTotal = Math.max(((b.successCount as number) || 0) + ((b.failureCount as number) || 0), 1);
            const aRate = ((a.successCount as number) || 0) / aTotal;
            const bRate = ((b.successCount as number) || 0) / bTotal;
            return bRate - aRate;
          })
          .slice(0, 5);

        if (topGenes.length > 0) {
          const lines = topGenes.map(g => {
            const total = ((g.successCount as number) || 0) + ((g.failureCount as number) || 0);
            const rate = Math.round(((g.successCount as number) || 0) / Math.max(total, 1) * 100);
            return `  - "${g.title}" (${rate}% success, ${total} runs)`;
          });
          parts.push(`[Prismer Evolution] Scope: ${scope}\nProven strategies:\n${lines.join('\n')}`);
        }
      }
    }
  } catch {
    // Best-effort — don't block first message
  }

  if (parts.length === 0) return '';
  return parts.join('\n\n') + '\n\n---\n\n';
}

// ─── L3: Conversation Memory Write ───────────────────────────────────

/**
 * Write a conversation summary to memory. Fire-and-forget.
 */
async function writeConversationMemory(
  account: ResolvedPrismerAccount,
  conversationId: string,
  scope: string,
): Promise<void> {
  const summary = buildConversationSummary(conversationId);
  if (!summary) return;

  try {
    await prismerFetch(account.apiKey, '/api/im/memory/files', {
      method: 'POST',
      body: {
        path: `conversations/${conversationId.slice(0, 12)}.md`,
        content: summary,
        scope: scope || 'global',
      },
      baseUrl: account.baseUrl,
    });

    markMemoryWritten(conversationId);
  } catch {
    // Best-effort
  }
}
