/**
 * Prismer IM — API route aggregator
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import { metrics } from '@/lib/metrics';
import { VERSION } from '@/lib/version';
import { requestIdMiddleware } from '../middleware/request-id';

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
import { createReportsRouter } from './reports';
import { createModerationRouter } from './admin-moderation';
import { createDelegationRouter } from './delegation';
import { createCredentialsRouter } from './credentials';
import { createCommunityRouter } from './community';
import { createCommunityBoardRouter } from './community-board';
import { createCommunityProfileRouter } from './community-profile';
import { createFriendRouter } from './friend';
import { ReportService } from '../services/report.service';
import { DelegationService } from '../services/delegation.service';
import { CredentialService } from '../services/credential.service';
import { CommunityService } from '../services/community.service';
import { CommunitySearchService } from '../services/community-search.service';
import { CommunityAutoService } from '../services/community-auto.service';
import { CommunityBoardService } from '../services/community-board.service';
import { CommunityProfileService } from '../services/community-profile.service';
import { CommunityDraftService } from '../services/community-draft.service';
import { CommunityFollowService } from '../services/community-follow.service';
import { CommunityGdprService } from '../services/community-gdpr.service';
import { ContactService } from '../services/contact.service';
import { prisma } from '@/lib/prisma';

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
import { KnowledgeLinkService } from '../services/knowledge-link.service';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { RoomManager } from '../ws/rooms';
import { RateLimiterService } from '../services/rate-limiter.service';
import { createCreditBilling } from '../middleware/credit-billing';
import { metricsMiddleware } from '../middleware/metrics';

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

  // v1.8.0: RequestId middleware — generates X-Request-Id for every request
  api.use('/*', requestIdMiddleware());

  // v1.8.0: Metrics middleware — records latency + status for ALL IM endpoints
  api.use('/*', metricsMiddleware());

  // v1.7.4: Unified credit billing middleware — deducts credits for write operations
  const billing = createCreditBilling(deps.creditService);
  api.use('/*', billing);

  // v1.8.0: Global write-operation rate limit — catches routers without explicit rl()
  // Uses independent action 'api.write' to avoid double-counting with per-router
  // 'message.send' / 'tool_call' limits on messages/direct/groups/evolution/tasks.
  api.use('/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'OPTIONS' || c.req.method === 'HEAD') {
      return next();
    }
    const user = c.get('user');
    if (!user?.imUserId) return next();
    const minTier = parseInt(process.env.RATE_LIMIT_MIN_TIER || '0', 10) || 0;
    const trustTier = Math.max(user.trustTier ?? 0, minTier);
    const result = await rateLimiter.checkAndConsume(user.imUserId, 'api.write', trustTier);
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { ok: false, error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Retry in ${retryAfter}s.` } },
        429,
      );
    }
    return next();
  });

  // Health check + sync connection metrics
  api.get('/health', (c) => {
    const stats = deps.rooms.getStats();
    // Update realtime connection metrics for admin dashboard
    metrics.setConnections(stats.totalConnections, 0);
    return c.json({
      ok: true,
      service: 'prismer-im-server',
      version: VERSION,
      timestamp: new Date().toISOString(),
      stats,
    });
  });

  // Mount sub-routers
  api.route('/users', createUsersRouter());
  api.route('/conversations', createConversationsRouter(deps.conversationService, deps.rooms));
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
  const contactService = new ContactService();
  api.route('/contacts', createFriendRouter(contactService, deps.rooms));
  api.route('/discover', createDiscoverRouter());

  // v0.3.0: Social bindings, credits
  api.route('/bindings', createBindingsRouter(deps.bindingService));
  api.route('/credits', createCreditsRouter(deps.creditService));

  // v0.4.0: File upload
  api.route('/files', createFilesRouter(deps.fileService, rateLimiter));

  // v1.7.0: Sync (offline-first SDK)
  api.route('/sync', createSyncRouter(deps.syncService));
  api.route('/sync', createSyncStreamRouter({ redis: deps.redis, syncService: deps.syncService }));

  // v1.7.2: Memory Layer + v1.8.0: Knowledge Links
  const knowledgeLinkService = new KnowledgeLinkService();
  api.route(
    '/memory',
    createMemoryRouter(
      deps.memoryService,
      deps.conversationService,
      knowledgeLinkService,
      rateLimiter,
      deps.eventBusService,
    ),
  );

  // v1.7.2: Recall (unified knowledge search) + v1.8.0: Knowledge Links
  api.route('/recall', createRecallRouter(deps.memoryService, knowledgeLinkService, deps.eventBusService));

  // v1.8.0: Knowledge Links query endpoint
  const knowledgeRouter = new Hono();
  knowledgeRouter.use('*', authMiddleware);
  knowledgeRouter.get('/links', async (c) => {
    const entityType = c.req.query('entityType') as 'memory' | 'gene' | 'capsule' | 'signal';
    const entityId = c.req.query('entityId');
    if (!entityType || !entityId) {
      return c.json({ ok: false, error: 'entityType and entityId required' } as ApiResponse, 400);
    }
    const validTypes = ['memory', 'gene', 'capsule', 'signal'];
    if (!validTypes.includes(entityType)) {
      return c.json({ ok: false, error: `entityType must be one of: ${validTypes.join(', ')}` } as ApiResponse, 400);
    }
    const links = await knowledgeLinkService.findAllRelated(entityType, entityId);
    return c.json({ ok: true, data: links } as ApiResponse);
  });
  api.route('/knowledge', knowledgeRouter);

  // v1.7.3: Content Reports (Data Governance)
  const reportService = new ReportService(deps.creditService);
  api.route('/reports', createReportsRouter(reportService));

  // v1.7.3: Admin Moderation (Data Governance)
  api.route('/admin/moderation', createModerationRouter(reportService, deps.creditService));

  // v1.7.2: Skill Catalog + Evolution (with rate limiting)
  api.route('/skills', createSkillsRouter(deps.skillService, rateLimiter));
  api.route(
    '/evolution',
    createEvolutionRouter(deps.evolutionService, deps.achievementService, rateLimiter, deps.memoryService),
  );

  // v1.7.2: Identity & Signing (E2E Encryption Layer 1-2)
  api.route('/keys', createIdentityRouter(deps.identityService, rateLimiter));

  // v1.7.2: Task Orchestration (Cloud Task Store + Scheduler)
  api.route('/tasks', createTasksRouter(deps.taskService, rateLimiter, deps.eventBusService));

  // v1.7.3: Event Subscriptions
  api.route('/subscriptions', createSubscriptionsRouter(deps.eventBusService));

  // v1.7.3: Conversation Policies (Layer 3 — Context Access Control)
  api.route('/conversations', createPoliciesRouter(deps.conversationService));

  // v1.7.2: Admin API (Trust Tier management)
  api.route('/admin', createAdminRouter());

  // v1.7.2: Conversation Security (encryption mode + key exchange)
  api.route('/conversations', createSecurityRouter());

  // v1.7.3: AIP Delegation & Credentials (Layer 6-7)
  const delegationService = new DelegationService();
  const credentialService = new CredentialService();
  api.route('/delegation', createDelegationRouter(delegationService));
  api.route('/credentials', createCredentialsRouter(credentialService));

  // v1.8.0 P9: Presence batch query
  const presenceRouter = new Hono();
  presenceRouter.use('*', authMiddleware);
  presenceRouter.post('/batch', async (c) => {
    const body = await c.req.json();
    const { userIds } = body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return c.json({ ok: false, error: 'userIds[] is required' } as ApiResponse, 400);
    }
    if (userIds.length > 100) {
      return c.json({ ok: false, error: 'Maximum 100 userIds per request' } as ApiResponse, 400);
    }
    const presenceMap = await deps.presenceService.getMultipleStatus(userIds);
    const data = userIds.map((uid: string) => {
      const info = presenceMap.get(uid);
      return {
        userId: uid,
        status: info?.status ?? 'offline',
        lastSeenAt: info?.lastSeen ? new Date(info.lastSeen).toISOString() : null,
      };
    });
    return c.json({ ok: true, data } as ApiResponse);
  });
  api.route('/presence', presenceRouter);

  // v1.8.0 P8: Community Forum (shared service + WS push via RoomManager)
  const communityService = new CommunityService(deps.rooms);
  const communitySearchService = new CommunitySearchService();
  const communityAutoService = new CommunityAutoService(prisma as any, communityService);
  const communityBoardService = new CommunityBoardService();
  const communityProfileService = new CommunityProfileService();
  const communityDraftService = new CommunityDraftService();
  const communityFollowService = new CommunityFollowService(prisma as any);
  const communityGdprService = new CommunityGdprService(prisma as any);
  api.route(
    '/community',
    createCommunityRouter(
      communityService,
      rateLimiter,
      communitySearchService,
      communityAutoService,
      communityGdprService,
    ),
  );
  api.route('/community/boards', createCommunityBoardRouter(communityBoardService, rateLimiter));
  api.route(
    '/community',
    createCommunityProfileRouter(communityProfileService, communityDraftService, communityFollowService, rateLimiter),
  );

  return api;
}
