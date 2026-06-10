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
import { createWorkspacesRouter } from './workspaces';
import { createInvitesRouter } from './invites';
import { createProjectsRouter } from './projects';
import { createWorkspaceFilesRouter } from './workspace-files';
import { createWorkspaceRuntimeRouter } from './workspace-runtime';
import { createAgentProfilesRouter } from './agent-profiles';
import { createAssetsRouter } from './assets';
import { createIngestClaimsRouter } from './ingest-claims';
import { createPairRouter } from './pair';
import { PairService } from '../services/pair.service';
import { createDispatchRouter } from './dispatch';
import { createDirectRouter } from './direct';
import { createGroupsRouter } from './groups';
import { createRegisterRouter, createTokenRouter } from './register';
import { createMeRouter } from './me';
import { createContactsRouter, createDiscoverRouter } from './contacts';
import { createBindingsRouter } from './bindings';
import { createCreditsRouter } from './credits';
import { createRemoteRouter } from './remote';
import { createFilesRouter } from './files';
import { createSyncRouter } from './sync';
import { createSyncStreamRouter } from './sync-stream';
import { createMemoryRouter } from './memory';
import { createRecallRouter } from './recall';
import { createEvolutionRouter } from './evolution';
import { createSkillsRouter } from './skills';
import { createSkillDraftRouter } from './skills-draft';
import { SkillDraftService } from '../services/skill-draft.service';
import { createSkillLifecycleRouter } from './skills-lifecycle';
import { createSkillAuthoringRouter } from './skills-authoring';
import { SkillLifecycleService } from '../services/skill-lifecycle.service';
import { createStudioRouter } from './studio';
import { createRoleTemplatesRouter } from './role-templates';
import { createAgentPacksRouter } from './agent-packs';
import { createIdentityRouter } from './identity';
import { createTasksRouter } from './tasks';
import { createCriteriaTemplatesRouter } from './criteria-templates';
import { createApprovalsRouter } from './approvals';
import { createMetricsRouter } from './metrics';
import { createInsightsRouter } from './insights';
import { createRunsRouter } from './runs';
import { createGoalsRouter } from './goals';
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
import { createAgentBindingsRouter } from './agent-bindings';
import { createAgentTransferRouter } from './agent-transfer';
import { createCeoRuntimeMoveRouter } from './ceo-runtime-move';
import { createAgentDeviceMovesRouter } from './agent-device-moves';
import { createDaemonHealthRouter } from './daemon-health';
import { createRuntimeDiagnoseRouter } from './runtime-diagnose';
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
import { ApprovalService } from '../services/approval.service';
import type { EventBusService } from '../services/event-bus.service';
import type { AchievementService } from '../services/achievement.service';
import type { ContextAccessService } from '../services/context-access.service';
import { KnowledgeLinkService } from '../services/knowledge-link.service';
import { authMiddleware } from '../auth/middleware';
import type { ApiResponse } from '../types/index';
import type { RoomManager } from '../ws/rooms';
import { RateLimiterService } from '../services/rate-limiter.service';
import { RoleTemplateService } from '../services/role-template.service';
import { createCreditBilling } from '../middleware/credit-billing';
import { metricsMiddleware } from '../middleware/metrics';
import { traceIdMiddleware } from '../middleware/trace-id';

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
  /**
   * release201/08 S21 — optional pre-instantiated SkillLifecycleService.
   * When provided, the /api/im/skills/* router reuses it (so TaskService and
   * the route layer share state); otherwise routes.ts builds a fresh one
   * for backward-compat with callers that haven't been updated.
   */
  skillLifecycleService?: SkillLifecycleService;
}

export function createApiRouter(deps: RouterDeps): Hono {
  const api = new Hono();

  // v1.7.3: Rate Limiter (Layer 4 Security) — Redis-backed for cross-pod consistency
  const rateLimiter = new RateLimiterService(deps.redis);

  // v1.8.0: RequestId middleware — generates X-Request-Id for every request
  api.use('/*', requestIdMiddleware());

  // release201/30 §7: TraceId middleware — reads / mints X-Prismer-Trace-Id
  // and exposes it as c.get('traceId') for structured logging + daemon
  // dispatch propagation. Runs after requestId (existing observability anchor)
  // and before metrics / credit-billing / auth so a malformed-auth 401 also
  // surfaces traceId in the response header.
  api.use('/*', traceIdMiddleware());

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
  api.route(
    '/agents',
    createAgentsRouter(deps.agentService, deps.agentRegistry, deps.presenceService, deps.rooms, deps.skillService),
  );
  api.route('/workspace', createWorkspaceRouter(deps.redis));

  // v1.9.x Track A m1: workspace data model (5 new resources)
  api.route('/workspaces', createWorkspacesRouter({ rooms: deps.rooms }));
  api.route('/workspaces', createWorkspaceFilesRouter(deps.rooms, deps.syncService)); // nested paths /:wsId/files
  api.route('/workspaces', createWorkspaceRuntimeRouter(deps.redis)); // /:wsId/runtime + /:wsId/runtime/events

  // release201/09 Phase 1 — Project scope (opt-in 中间层 between workspace and task).
  // Phase 1 不接入任何已有资源 list endpoint;projectId filter 在 Phase 2 才在
  // im_tasks 加列 + 接入 tasks list.
  api.route('/projects', createProjectsRouter());

  // release201/16 Phase 9 — token-bearing invite endpoints (public preview +
  // auth-gated accept/reject). Workspace-scoped CRUD lives under /workspaces.
  api.route('/invites', createInvitesRouter());

  // v2.0 §4.8.2 (Wave 2-B2) — explicit multi-daemon binding ownership.
  // GET /workspaces/:wsId/agent-bindings + POST /agent-bindings/:agentImUserId/rebind
  // GET /daemons/:daemonId/health
  // Mounted at root because the binding API and daemon-health API both
  // namespace their own paths (workspaces/:wsId/agent-bindings,
  // agent-bindings/:id/rebind, daemons/:id/health). Auth is enforced
  // inside each router via workspace owner / orchestrator / admin checks.
  const agentBindingsRouter = createAgentBindingsRouter({ syncService: deps.syncService });
  api.route('/', agentBindingsRouter);
  // release201/09 §9.7 Phase 3 — 3-stage agent transfer protocol (S31 A).
  // Complements the single-shot POST /agent-bindings/transfer with explicit
  // initiate / complete / abort 2PC for distributed SDK coordination.
  api.route('/agent-transfer', createAgentTransferRouter({ syncService: deps.syncService }));
  api.route('/', createCeoRuntimeMoveRouter({ syncService: deps.syncService }));
  api.route('/', createAgentDeviceMovesRouter({ syncService: deps.syncService }));
  const daemonHealthRouter = createDaemonHealthRouter({ redis: deps.redis, rooms: deps.rooms });
  api.route('/', daemonHealthRouter);

  // v2.0 §4.8.1 (Wave 4-E4) — webhook dispatch reachability diagnose +
  // daemon-side transport-probe report sink. Sibling to daemon-health
  // (different perspective: this one is dispatch-path-facing).
  const runtimeDiagnoseRouter = createRuntimeDiagnoseRouter({
    redis: deps.redis,
    rooms: deps.rooms,
  });
  api.route('/', runtimeDiagnoseRouter);
  api.route('/agent_profiles', createAgentProfilesRouter(deps.rooms));
  // WS2: pass TaskService so a late-arriving deliverable asset (daemon outbox
  // flush after the task closed) re-emits the task's rolling completion digest
  // — chat card eventually matches the drawer's resultAssetCount.
  api.route('/assets', createAssetsRouter(deps.rooms, deps.syncService, deps.taskService));
  // Wave-54 B7: multi-daemon coordination for asset parse work.
  api.route('/ingest', createIngestClaimsRouter());

  // v1.9.3 Track C: QR-based daemon ↔ cloud pairing.
  api.route('/pair', createPairRouter(new PairService({ redis: deps.redis })));

  // v2.0 external-channel daemon reply receiver.
  // Wave 3.5 §4.3 — two-phase prepare/commit + legacy /reply (Sunset 2026-09-01).
  api.route(
    '/dispatch',
    createDispatchRouter({
      messageService: deps.messageService,
      taskService: deps.taskService,
      syncService: deps.syncService,
      getParticipantIds: (conversationId) => deps.conversationService.getParticipantIds(conversationId),
      rooms: deps.rooms,
    }),
  );

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
  api.route('/', createRegisterRouter(deps.evolutionService, rateLimiter, deps.redis));
  api.route('/token', createTokenRouter());
  api.route('/me', createMeRouter(deps.creditService));
  api.route('/contacts', createContactsRouter());
  const contactService = new ContactService();
  api.route('/contacts', createFriendRouter(contactService, deps.rooms, deps.syncService));
  api.route('/discover', createDiscoverRouter());

  // v0.3.0: Social bindings, credits
  api.route('/bindings', createBindingsRouter(deps.bindingService));
  api.route('/credits', createCreditsRouter(deps.creditService));

  // Wave-7 ζ: surface paired daemons under /remote/bindings (mobile expects
  // this on app launch). Derived from IMAgentCard.metadata.daemonId until
  // a first-class IMDesktopBinding model lands.
  api.route('/remote', createRemoteRouter());

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
      deps.rooms,
    ),
  );

  // v1.7.2: Recall (unified knowledge search) + v1.8.0: Knowledge Links
  api.route('/recall', createRecallRouter(deps.memoryService, knowledgeLinkService, deps.eventBusService));

  // v1.8.0: Knowledge Links query endpoint
  const knowledgeRouter = new Hono();
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- knowledgeRouter mounted at /knowledge below; wildcard scoped to that prefix
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
  // release201/07: mount skill-draft router at /skills BEFORE the main skills
  // router so `/draft`, `/drafts`, `/:id/draft`, `/:id/draft/regenerate`, and
  // `/draft/:id` resolve to the draft service without the main router's
  // `/:slugOrId` catch-all intercepting them.
  //
  // release201/08 S21 — instantiate lifecycle BEFORE draft so we can inject
  // it as a dep into the draft service (createDraft fans out the
  // `skill.authoring.*` SSE event family through the lifecycle service).
  // ConversationService is also injected so both services can tag the 4
  // skill-dev session roles (business / dev / test / review). Reuse the
  // server-level instance when provided (server.ts wires the same instance
  // into TaskService so /skill-tryout completion emits stay scoped to the
  // same SyncService).
  const skillLifecycleService =
    deps.skillLifecycleService ??
    new SkillLifecycleService({
      sync: deps.syncService,
      conversations: deps.conversationService,
    });
  const skillDraftService = new SkillDraftService({
    lifecycle: skillLifecycleService,
    conversations: deps.conversationService,
  });
  // release201/24 §Phase2 — close the auto-optimize loop: the lifecycle
  // service triggers a real rewrite via the draft service's regenerateDraft
  // (which dispatches a skill-authoring task to the owner agent carrying the
  // failed cases). Wired here to avoid a service-construction cycle.
  skillLifecycleService.setAutoOptimizeRegenerator(async (skillId, ownerAgentId, reason, failedCases) => {
    await skillDraftService.regenerateDraft(skillId, ownerAgentId, { reason, failedCases });
  });
  api.route('/skills', createSkillDraftRouter(skillDraftService));
  // release201/08: mount lifecycle router at /skills BEFORE the main skills
  // router so `/:id/promote`, `/:id/eval/runs`, `/:id/share/snapshot`,
  // `/:id/publish-template`, `/import-snapshot` resolve to the lifecycle
  // service instead of being caught by the main router's `/:slugOrId` rule.
  api.route('/skills', createSkillLifecycleRouter(skillLifecycleService));
  // release201/24 §UX — agent-dispatched authoring (POST /skills/authoring-requests).
  api.route('/skills', createSkillAuthoringRouter({ taskService: deps.taskService }));
  api.route('/skills', createSkillsRouter(deps.skillService, rateLimiter));
  const roleTemplateService = new RoleTemplateService(deps.skillService);
  api.route('/role_templates', createRoleTemplatesRouter(roleTemplateService));
  api.route('/role-templates', createRoleTemplatesRouter(roleTemplateService));
  api.route('/agent-packs', createAgentPacksRouter());
  api.route(
    '/evolution',
    createEvolutionRouter(deps.evolutionService, deps.achievementService, rateLimiter, deps.memoryService),
  );

  // v2.0.7 release201/13: Skill Studio BFF (overview / profile / installed).
  api.route('/studio', createStudioRouter(deps.skillService));

  // v1.7.2: Identity & Signing (E2E Encryption Layer 1-2)
  api.route('/keys', createIdentityRouter(deps.identityService, rateLimiter));

  // v1.7.2: Task Orchestration (Cloud Task Store + Scheduler)
  api.route('/tasks', createTasksRouter(deps.taskService, rateLimiter, deps.eventBusService));
  // v2.0.7 release201/10 — acceptance criteria template store.
  api.route('/criteria-templates', createCriteriaTemplatesRouter());
  // Shared ApprovalService instance — reused by /approvals plus the cockpit
  // BFF (so pendingApprovals counts go through the canonical service path).
  const approvalService = new ApprovalService({ rooms: deps.rooms, taskService: deps.taskService });
  api.route('/approvals', createApprovalsRouter(approvalService));
  api.route('/runs', createRunsRouter(deps.taskService));
  api.route('/goals', createGoalsRouter(deps.taskService));

  // v2.0.7 release201/11 — unified metric data channel.
  api.route('/metrics', createMetricsRouter());

  // v2.0.7 release201/12 — workspace observability surface BFF.
  // Composes 11/aggregate fan-out into 3 view-shaped responses
  // (overview/project/agent). Rate-limited 60/min per user.
  // v2.0.8 — adds /cockpit (one-person company single-pane view).
  api.route('/insights', createInsightsRouter({ rateLimiter, approvalService }));

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
  // eslint-disable-next-line custom/no-wildcard-sub-router-middleware -- presenceRouter mounted at /presence below; wildcard scoped to that prefix
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
