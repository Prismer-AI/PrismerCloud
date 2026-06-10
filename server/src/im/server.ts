/**
 * Prismer IM — Hono app + optional standalone HTTP server
 *
 * Two modes:
 *   1. Embedded (Next.js): createApp() — returns Hono app, no port binding
 *   2. Standalone (start.ts): createServer() — binds to port with HTTP + WebSocket
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import Redis from 'ioredis';

import { config } from './config';
import { createApiRouter } from './api/routes';
import { RoomManager } from './ws/rooms';
import { MessageService } from './services/message.service';
import { ConversationService } from './services/conversation.service';
import { PresenceService } from './services/presence.service';
import { AgentService } from './services/agent.service';
import { StreamService } from './services/stream.service';
import { WebhookService } from './services/webhook.service';
import { AgentRegistry } from './agent-protocol/registry';
import { BindingService } from './services/binding.service';
import { FileService } from './services/file.service';
import { createCreditService } from './services/credit.service';
import { SyncService } from './services/sync.service';
import { SyncPublisherService } from './services/sync-publisher.service';
import { MemoryService } from './services/memory.service';
import { EvolutionService } from './services/evolution.service';
import { AchievementService } from './services/achievement.service';
import { SignalExtractorService } from './services/signal-extractor';
import { SkillService } from './services/skill.service';
import { IdentityService } from './services/identity.service';
import { SigningService } from './services/signing.service';
import { TaskService } from './services/task.service';
import { SkillLifecycleService } from './services/skill-lifecycle.service';
import { EventBusService } from './services/event-bus.service';
import { SchedulerService } from './services/scheduler.service';
import { ContextAccessService } from './services/context-access.service';
import { WSAckPersistentService } from './services/ws-ack-persistent.service';
import { createBackplane, type Backplane } from './backplane';
import { WsRpcService } from './services/ws-rpc.service';
import { createEvalDaemonDispatch } from './services/eval-daemon-dispatch';
import prisma from './db';

export interface IMAppResult {
  app: Hono;
  redis: Redis;
  rooms: RoomManager;
  agentService: AgentService;
  sweepInterval: ReturnType<typeof setInterval>;
  streamService: StreamService;
  messageService: MessageService;
  conversationService: ConversationService;
  syncService: SyncService;
  syncPublisher: SyncPublisherService;
  presenceService: PresenceService;
  schedulerService: SchedulerService;
  taskService: TaskService;
  /** Wave-4 E3 (§4.5) — multi-instance backplane + persistent ack tracker. */
  backplane: Backplane;
  wsAckPersistent: WSAckPersistentService;
  /**
   * v2.0 §4.8.1 (Wave 4-E4) — WS reverse-RPC service for webhook dispatch.
   * Wired into the WS handler so daemon-originated `webhook.dispatch.reply`
   * frames are routed to the pending request promise. Surfaced on the
   * IMAppResult so callers (notably the standalone `createServer` entry)
   * can pass it through to `setupWebSocket`.
   */
  wsRpc: WsRpcService;
}

/**
 * Create the Hono IM app and services — NO port binding.
 * Used by Next.js instrumentation for in-process integration.
 */
export async function createApp(): Promise<IMAppResult> {
  // ─── Redis ───────────────────────────────────────────────
  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        console.warn('[Redis] Max retries reached, running without Redis');
        return null;
      }
      return Math.min(times * 200, 5000);
    },
    lazyConnect: true,
  });

  redis.on('error', (err) => console.warn('[Redis] Error (non-fatal):', err.message));
  redis.on('connect', () => console.log('[Redis] Connected'));

  redis.connect().catch((err) => {
    console.warn('[Redis] Connection failed, running in standalone mode:', err.message);
  });

  // ─── Wave-4 E3: Backplane + persistent ack ──────────────
  // §4.5 — replaces ad-hoc pub/sub with typed abstraction (Redis Streams
  // unicast for cross-Pod sendToUser). `BACKPLANE=memory` falls back to
  // single-process EventEmitter so unit tests / dev runs don't need Redis.
  const backplane = createBackplane({ redis });
  const wsAckPersistent = new WSAckPersistentService();

  // ─── Services ────────────────────────────────────────────
  const rooms = new RoomManager(redis);
  rooms.setBackplane(backplane);
  // Register this Pod's inbound unicast channel; sends from other Pods
  // arrive here as { targetUserId, event } JSON.
  rooms
    .registerPodChannel()
    .catch((err) =>
      console.warn('[Backplane] registerPodChannel failed (will retry on next event):', (err as Error).message),
    );
  // v2.0 §4.8.1 (Wave 4-E4) — instantiated early so it can be wired into
  // both the WS handler (for reply correlation) and the webhook dispatch
  // path (when it lands on the createServer integration in a follow-up).
  // No external state: it owns only an in-memory Map of pending RPCs.
  const wsRpc = new WsRpcService(rooms);
  const webhookService = new WebhookService(redis);
  const syncService = new SyncService();
  syncService.setRedis(redis);
  // v2.0 §4.1 — background worker that drains im_sync_events rows with
  // publishedAt=NULL to Redis. Decouples DB write from Redis publish so a
  // publish failure no longer silently drops an event (HU-1 from
  // Wave 1-A3 audit). Independent 50ms tick — does NOT share the scheduler
  // tick (10s/30s) since its latency target is way tighter.
  const syncPublisher = new SyncPublisherService(syncService);
  const contextAccessService = new ContextAccessService();
  const identityService = new IdentityService();
  const signingService = new SigningService(identityService);
  const messageService = new MessageService(redis, webhookService, syncService, contextAccessService, signingService);
  // release202 — wire RoomManager so the file-attach thumbnail derivative path
  // (deriveFileMessageAttachment) can emit a workspace-targeted asset.changed.
  messageService.setRoomManager(rooms);
  const conversationService = new ConversationService(redis, syncService);
  const presenceService = new PresenceService(redis);
  const agentService = new AgentService(redis);
  const streamService = new StreamService();
  // v2.0 §4.4.7 — partial chunks SSE-broadcast via per-recipient Redis pub/sub.
  streamService.setRedis(redis);
  const agentRegistry = new AgentRegistry(agentService);
  const bindingService = new BindingService(prisma);
  const creditService = createCreditService(prisma);
  const fileService = new FileService(creditService);
  const memoryService = new MemoryService();
  const achievementService = new AchievementService();
  const signalExtractor = new SignalExtractorService();
  signalExtractor.setRedis(redis);
  const evolutionService = new EvolutionService(creditService, achievementService, signalExtractor, memoryService);
  const skillService = new SkillService();
  // release201/08 S21 — single SkillLifecycleService instance shared by both
  // TaskService (for `skill-tryout` task completion → sample_task_completed
  // SSE) and the /api/im/skills/* router (for /promote, /eval/runs, etc.).
  const skillLifecycleService = new SkillLifecycleService({
    sync: syncService,
    conversations: conversationService,
    // release201/24 §3 — push queued eval runs to the owner agent's bound
    // daemon over the WS reverse channel (wsRpc + rooms created above).
    dispatchEvalToDaemon: createEvalDaemonDispatch({ rooms, wsRpc }),
  });
  const eventBusService = new EventBusService({ rooms, syncService, redis });
  const taskService = new TaskService({
    redis,
    rooms,
    messageService,
    conversationService,
    syncService,
    evolutionService,
    eventBusService,
    creditService,
    skillLifecycleService,
  });
  // v1.9.x: wire @-mention dispatch (resolves the MessageService ↔ TaskService
  // circular dep via post-construction setter).
  messageService.setTaskService(taskService);
  const schedulerService = new SchedulerService(taskService, undefined, evolutionService);

  // ─── Cross-system Signal Bridge (P3 v1.8.0) ──────────────
  // Listens for task/memory events and auto-generates evolution gene signals.
  // Agents subscribed to "task.*" or "memory.*" already get EventBus notifications;
  // this bridge ensures the evolution network also learns from cross-system outcomes.
  registerCrossSystemSignalBridge(eventBusService, evolutionService);

  // ─── Hono app ────────────────────────────────────────────
  const app = new Hono();

  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- app is the root Hono instance for the IM server; global request logger is intentional
  app.use('*', logger());
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- app is the root Hono instance for the IM server; global CORS middleware is intentional
  app.use(
    '*',
    cors({
      origin: config.cors.origins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }),
  );

  const apiRouter = createApiRouter({
    redis,
    rooms,
    messageService,
    conversationService,
    agentService,
    presenceService,
    agentRegistry,
    bindingService,
    fileService,
    creditService,
    syncService,
    memoryService,
    evolutionService,
    skillService,
    identityService,
    signingService,
    taskService,
    eventBusService,
    achievementService,
    contextAccessService,
    skillLifecycleService,
  });
  app.route('/api', apiRouter);
  // Alias: SDK clients use /api/im/* paths (Next.js proxy convention)
  app.route('/api/im', apiRouter);

  app.get('/', (c) =>
    c.json({
      service: 'prismer-im-server',
      version: '0.4.0',
      docs: '/api/health',
    }),
  );

  // ─── Ensure seed genes in DB ──────────────────────────────
  evolutionService.ensureSeedGenesInTable().catch((err) => {
    console.error('[Evolution] Failed to seed genes:', err);
  });

  // ─── release201/10 §3.3 — seed 4 global criteria templates ────
  // Idempotent: only inserts rows missing from im_task_criteria_templates.
  void import('./services/task-criteria-template.service')
    .then(({ getTaskCriteriaTemplateService }) => getTaskCriteriaTemplateService().seedDefaults())
    .catch((err) => {
      console.warn('[CriteriaTemplate] seedDefaults failed (non-fatal):', (err as Error).message);
    });

  // ─── Start scheduler ───────────────────────────────────────
  schedulerService.start();
  // ─── Start sync publisher worker ───────────────────────────
  syncPublisher.start();

  // ─── Periodic sweep (agent heartbeat + expired uploads) ──
  // release201/26 Phase 1 (task #3) — piggyback the tokenCountCl100k backfill
  // on this loop, but at a far lower cadence than the heartbeat sweep so it
  // doesn't add DB pressure to the hot path. We drain one bounded batch every
  // TOKEN_BACKFILL_EVERY sweeps; one batch keeps the per-tick cost tiny and
  // the table converges over time. tokenCountCl100k is a pure cache column
  // (not signed) so updates are safe (see backfillMessageTokenCounts docs).
  const TOKEN_BACKFILL_EVERY = 10; // every 10th sweep
  // release201/26 Phase 2 — idle L2 compaction sweep. Far lower cadence than the
  // heartbeat: scan conversations silent ≥ idle window and run maybeCompact
  // (which re-derives the idle trigger locally). Bounded + never throws so it
  // can't crash the interval; producer failures fall back extractive (§10).
  const IDLE_COMPACTION_EVERY = 20; // every 20th sweep
  let sweepTick = 0;
  const sweepInterval = setInterval(async () => {
    try {
      const timedOut = await agentService.sweepTimedOut();
      if (timedOut > 0) {
        console.log(`[Agent] Swept ${timedOut} timed-out agents`);
      }
    } catch (err) {
      console.error('[Agent] Sweep error:', err);
    }
    try {
      const cleaned = await fileService.cleanupExpired();
      if (cleaned > 0) {
        console.log(`[FileService] Cleaned ${cleaned} expired uploads`);
      }
    } catch (err) {
      console.error('[FileService] Cleanup error:', err);
    }
    sweepTick += 1;
    if (sweepTick % TOKEN_BACKFILL_EVERY === 0) {
      try {
        const { backfillMessageTokenCounts } = await import('./services/conversation-memory.service');
        const updated = await backfillMessageTokenCounts();
        if (updated > 0) {
          console.log(`[ConversationMemory] token backfill updated ${updated} messages`);
        }
      } catch (err) {
        // backfillMessageTokenCounts never throws, but guard the dynamic import.
        console.error('[ConversationMemory] token backfill error:', (err as Error).message);
      }
    }
    if (sweepTick % IDLE_COMPACTION_EVERY === 0) {
      try {
        const { sweepIdleCompactionCandidates } = await import('./services/conversation-compaction.service');
        const { scanned, produced } = await sweepIdleCompactionCandidates();
        if (produced > 0) {
          console.log(`[ConversationCompaction] idle sweep produced ${produced} segment(s) (scanned ${scanned})`);
        }
      } catch (err) {
        // sweepIdleCompactionCandidates never throws, but guard the dynamic import.
        console.error('[ConversationCompaction] idle sweep error:', (err as Error).message);
      }
    }
  }, config.agent.heartbeatIntervalMs);

  return {
    app,
    redis,
    rooms,
    agentService,
    sweepInterval,
    streamService,
    messageService,
    conversationService,
    syncService,
    syncPublisher,
    presenceService,
    schedulerService,
    taskService,
    backplane,
    wsAckPersistent,
    wsRpc,
  };
}

/**
 * Create a standalone HTTP + WebSocket server.
 * Used by start.ts for standalone dev/testing only.
 */
export async function createServer() {
  const { createServer: createHttpServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { setupWebSocket } = await import('./ws/handler');
  const { handleSSEConnection } = await import('./sse/handler');

  const result = await createApp();

  // ─── HTTP Server (with SSE support) ────────────────────────
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${config.host}:${config.port}`);

    // SSE endpoint
    if (url.pathname === '/sse') {
      handleSSEConnection(req, res, {
        rooms: result.rooms,
        conversationService: result.conversationService,
        presenceService: result.presenceService,
      });
      return;
    }

    // Everything else → Hono
    const bodyStr =
      req.method !== 'GET' && req.method !== 'HEAD'
        ? await new Promise<string>((resolve) => {
            let data = '';
            req.on('data', (c) => {
              data += c;
            });
            req.on('end', () => resolve(data));
          })
        : undefined;
    const honoReq = new Request(url.href, {
      method: req.method,
      headers: req.headers as any,
      body: bodyStr,
      // @ts-expect-error duplex needed for streaming
      duplex: 'half',
    });

    const honoRes = await result.app.fetch(honoReq);
    res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
    const body = await honoRes.arrayBuffer();
    res.end(Buffer.from(body));
  });

  server.listen(config.port, config.host, () => {
    console.log(`Prismer IM Server running on http://${config.host}:${config.port}`);
  });

  // ─── WebSocket Server ────────────────────────────────────
  const wss = new WebSocketServer({
    server: server as any,
    path: '/ws',
  });

  setupWebSocket(wss, {
    redis: result.redis,
    rooms: result.rooms,
    messageService: result.messageService,
    conversationService: result.conversationService,
    presenceService: result.presenceService,
    agentService: result.agentService,
    streamService: result.streamService,
    taskService: result.taskService,
    // v2.0 §4.8.2 (Wave 2-B2) — needed for `agent.binding.contested` sync events
    syncService: result.syncService,
    // Wave-4 E3 (§4.5) — persistent ack tracker for cross-Pod / cross-restart replay
    wsAckPersistent: result.wsAckPersistent,
    // v2.0 §4.8.1 (Wave 4-E4) — webhook dispatch reply correlation
    wsRpc: result.wsRpc,
  });

  console.log(`WebSocket server on ws://${config.host}:${config.port}/ws`);

  // ─── Graceful shutdown ───────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...');
    result.schedulerService.stop();
    result.syncPublisher.stop();
    clearInterval(result.sweepInterval);
    wss.close();
    (server as any).close();
    // §4.5 — close backplane before redis so its duplicate connections
    // can quit cleanly.
    await result.backplane.close().catch((err: unknown) => {
      console.log(`[IM Server] Backplane close skipped: ${err instanceof Error ? err.message : String(err)}`);
    });
    await result.redis.quit().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[IM Server] Redis quit skipped: ${message}`);
    });
    console.log('Goodbye');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app: result.app, server, wss, redis: result.redis };
}

// ─── Cross-system Signal Bridge (P3 v1.8.0) ──────────────────────

const CROSS_SYSTEM_EVENT_MAP: Record<string, { signalType: string; outcome: 'success' | 'failed' }> = {
  'task.completed': { signalType: 'task:completed', outcome: 'success' },
  'task.failed': { signalType: 'task:failed', outcome: 'failed' },
  'memory.dream_completed': { signalType: 'memory:dream_completed', outcome: 'success' },
  'memory.write': { signalType: 'memory:write', outcome: 'success' },
  'memory.recall': { signalType: 'memory:recall', outcome: 'success' },
};

function registerCrossSystemSignalBridge(eventBus: EventBusService, evolutionService: EvolutionService) {
  const originalPublish = eventBus.publish.bind(eventBus);
  eventBus.publish = async (event) => {
    await originalPublish(event);

    const mapping = CROSS_SYSTEM_EVENT_MAP[event.type];
    if (!mapping) return;

    const agentId = (event.data as any)?.assigneeId || (event.data as any)?.agentId;
    const geneId = (event.data as any)?.geneId;
    if (!agentId || !geneId) return;

    // Fire-and-forget: never block publish caller
    void evolutionService
      .recordOutcome(agentId, {
        gene_id: geneId,
        signals: [{ type: mapping.signalType }],
        outcome: mapping.outcome,
        summary: `Cross-system signal from ${event.type}`,
        transition_reason: 'cross_system',
        context_snapshot: { sourceEvent: event.type, ...((event.data || {}) as Record<string, unknown>) },
      })
      .then(() => console.log(`[CrossSystemBridge] ${event.type} → evolution signal for agent ${agentId}`))
      .catch((err) => console.warn(`[CrossSystemBridge] Failed to bridge ${event.type}:`, (err as Error).message));
  };
  console.log('[CrossSystemBridge] Registered for:', Object.keys(CROSS_SYSTEM_EVENT_MAP).join(', '));
}
