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
import { MemoryService } from './services/memory.service';
import { EvolutionService } from './services/evolution.service';
import { AchievementService } from './services/achievement.service';
import { SignalExtractorService } from './services/signal-extractor';
import { SkillService } from './services/skill.service';
import { IdentityService } from './services/identity.service';
import { SigningService } from './services/signing.service';
import { TaskService } from './services/task.service';
import { EventBusService } from './services/event-bus.service';
import { SchedulerService } from './services/scheduler.service';
import { ContextAccessService } from './services/context-access.service';
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
  presenceService: PresenceService;
  schedulerService: SchedulerService;
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

  // ─── Services ────────────────────────────────────────────
  const rooms = new RoomManager(redis);
  const webhookService = new WebhookService(redis);
  const syncService = new SyncService();
  syncService.setRedis(redis);
  const contextAccessService = new ContextAccessService();
  const messageService = new MessageService(redis, webhookService, syncService, contextAccessService);
  const conversationService = new ConversationService(redis, syncService);
  const presenceService = new PresenceService(redis);
  const agentService = new AgentService(redis);
  const streamService = new StreamService();
  const agentRegistry = new AgentRegistry(agentService);
  const bindingService = new BindingService(prisma);
  const creditService = createCreditService(prisma);
  const fileService = new FileService(creditService);
  const memoryService = new MemoryService();
  const achievementService = new AchievementService();
  const signalExtractor = new SignalExtractorService();
  signalExtractor.setRedis(redis);
  const evolutionService = new EvolutionService(creditService, achievementService, signalExtractor);
  const skillService = new SkillService();
  const identityService = new IdentityService();
  const signingService = new SigningService(identityService);
  const eventBusService = new EventBusService({ rooms, syncService });
  const taskService = new TaskService({
    redis,
    rooms,
    messageService,
    conversationService,
    syncService,
    evolutionService,
    eventBusService,
  });
  const schedulerService = new SchedulerService(taskService, undefined, evolutionService);

  // ─── Hono app ────────────────────────────────────────────
  const app = new Hono();

  app.use('*', logger());
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

  // ─── Start scheduler ───────────────────────────────────────
  schedulerService.start();

  // ─── Periodic sweep (agent heartbeat + expired uploads) ──
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
    presenceService,
    schedulerService,
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
  });

  console.log(`WebSocket server on ws://${config.host}:${config.port}/ws`);

  // ─── Graceful shutdown ───────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...');
    result.schedulerService.stop();
    clearInterval(result.sweepInterval);
    wss.close();
    (server as any).close();
    await result.redis.quit();
    console.log('Goodbye');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app: result.app, server, wss, redis: result.redis };
}
