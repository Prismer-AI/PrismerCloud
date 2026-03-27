/**
 * Prismer IM — API route aggregator
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import { metrics } from '@/lib/metrics';

import { createUsersRouter } from './users';
import { createConversationsRouter } from './conversations';
import { createMessagesRouter } from './messages';
import { createAgentsRouter } from './agents';
import { createWorkspaceRouter } from './workspace';
import { createDirectRouter } from './direct';
import { createGroupsRouter } from './groups';
import { createRegisterRouter, createTokenRouter } from './register';
import { createMeRouter } from './me';
import { createContactsRouter, createDiscoverRouter } from './contacts';
import { createBindingsRouter } from './bindings';
import { createCreditsRouter } from './credits';
import { createFilesRouter } from './files';
import { createSyncRouter } from './sync';
import { createSyncStreamRouter } from './sync-stream';
import { createMemoryRouter } from './memory';
import { createRecallRouter } from './recall';
import { createEvolutionRouter } from './evolution';
import { createSkillsRouter } from './skills';
import { createIdentityRouter } from './identity';
import { createTasksRouter } from './tasks';
import { createSubscriptionsRouter } from './subscriptions';
import { createPoliciesRouter } from './policies';
import { createAdminRouter } from './admin';
import { createSecurityRouter } from './security';

import { MessageService } from '../services/message.service';
import { ConversationService } from '../services/conversation.service';
import { AgentService } from '../services/agent.service';
import { PresenceService } from '../services/presence.service';
import { AgentRegistry } from '../agent-protocol/registry';
import { BindingService } from '../services/binding.service';
import { FileService } from '../services/file.service';
import type { CreditService } from '../services/credit.service';
import type { SyncService } from '../services/sync.service';
import type { MemoryService } from '../services/memory.service';
import type { EvolutionService } from '../services/evolution.service';
import type { SkillService } from '../services/skill.service';
import type { IdentityService } from '../services/identity.service';
import type { SigningService } from '../services/signing.service';
import type { TaskService } from '../services/task.service';
import type { EventBusService } from '../services/event-bus.service';
import type { AchievementService } from '../services/achievement.service';
import type { ContextAccessService } from '../services/context-access.service';
import type { RoomManager } from '../ws/rooms';
import { RateLimiterService } from '../services/rate-limiter.service';

export interface RouterDeps {
  redis: Redis;
  rooms: RoomManager;
  messageService: MessageService;
  conversationService: ConversationService;
  agentService: AgentService;
  presenceService: PresenceService;
  agentRegistry: AgentRegistry;
  bindingService: BindingService;
  fileService: FileService;
  creditService: CreditService;
  syncService: SyncService;
  memoryService: MemoryService;
  evolutionService: EvolutionService;
  skillService: SkillService;
  identityService: IdentityService;
  signingService: SigningService;
  taskService: TaskService;
  eventBusService: EventBusService;
  achievementService?: AchievementService;
  contextAccessService?: ContextAccessService;
}

export function createApiRouter(deps: RouterDeps): Hono {
  const api = new Hono();

  // v1.7.3: Rate Limiter (Layer 4 Security) — Redis-backed for cross-pod consistency
  const rateLimiter = new RateLimiterService(deps.redis);

  // Periodic cleanup (in-memory fallback + DB records; Redis keys auto-expire via TTL)
  setInterval(() => {}, 5 * 60_000);

  // Health check + sync connection metrics
  api.get('/health', (c) => {
    const stats = deps.rooms.getStats();
    // Update realtime connection metrics for admin dashboard
    metrics.setConnections(stats.totalConnections, 0);
    return c.json({
      ok: true,
      service: 'prismer-im-server',
      version: '1.7.2',
      timestamp: new Date().toISOString(),
      stats,
    });
  });

  // Mount sub-routers
  api.route('/users', createUsersRouter());
  api.route('/conversations', createConversationsRouter(deps.conversationService));
  api.route(
    '/messages',
    createMessagesRouter(
      deps.messageService,
      deps.conversationService,
      deps.creditService,
      deps.rooms,
      deps.signingService,
      rateLimiter,
    ),
  );
  api.route('/agents', createAgentsRouter(deps.agentService, deps.agentRegistry, deps.presenceService));
  api.route('/workspace', createWorkspaceRouter(deps.redis));

  // Simplified APIs (QQ-like)
  api.route(
    '/direct',
    createDirectRouter(
      deps.messageService,
      deps.conversationService,
      deps.creditService,
      deps.rooms,
      deps.signingService,
      rateLimiter,
    ),
  );
  api.route(
    '/groups',
    createGroupsRouter(
      deps.messageService,
      deps.conversationService,
      deps.creditService,
      deps.rooms,
      deps.signingService,
      rateLimiter,
    ),
  );

  // v0.2.0: Self-registration, self-awareness, contacts, discovery
  api.route('/', createRegisterRouter(deps.evolutionService, rateLimiter));
  api.route('/token', createTokenRouter());
  api.route('/me', createMeRouter(deps.creditService));
  api.route('/contacts', createContactsRouter());
  api.route('/discover', createDiscoverRouter());

  // v0.3.0: Social bindings, credits
  api.route('/bindings', createBindingsRouter(deps.bindingService));
  api.route('/credits', createCreditsRouter(deps.creditService));

  // v0.4.0: File upload
  api.route('/files', createFilesRouter(deps.fileService));

  // v1.7.0: Sync (offline-first SDK)
  api.route('/sync', createSyncRouter(deps.syncService));
  api.route('/sync', createSyncStreamRouter({ redis: deps.redis, syncService: deps.syncService }));

  // v1.7.2: Memory Layer
  api.route('/memory', createMemoryRouter(deps.memoryService, deps.conversationService));

  // v1.7.2: Recall (unified knowledge search)
  api.route('/recall', createRecallRouter(deps.memoryService));

  // v1.7.2: Skill Catalog + Evolution (with rate limiting)
  api.route('/skills', createSkillsRouter(deps.skillService));
  api.route('/evolution', createEvolutionRouter(deps.evolutionService, deps.achievementService, rateLimiter));

  // v1.7.2: Identity & Signing (E2E Encryption Layer 1-2)
  api.route('/keys', createIdentityRouter(deps.identityService));

  // v1.7.2: Task Orchestration (Cloud Task Store + Scheduler)
  api.route('/tasks', createTasksRouter(deps.taskService, rateLimiter));

  // v1.7.3: Event Subscriptions
  api.route('/subscriptions', createSubscriptionsRouter(deps.eventBusService));

  // v1.7.3: Conversation Policies (Layer 3 — Context Access Control)
  api.route('/conversations', createPoliciesRouter(deps.conversationService));

  // v1.7.2: Admin API (Trust Tier management)
  api.route('/admin', createAdminRouter());

  // v1.7.2: Conversation Security (encryption mode + key exchange)
  api.route('/conversations', createSecurityRouter());

  return api;
}
