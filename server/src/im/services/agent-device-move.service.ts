import { k8sSandbox } from '@/lib/k8s-sandbox';
import {
  stampAgentCardDaemonBinding,
  type AgentCardDaemonBindingPrisma,
} from '@/lib/sandbox/agent-card-daemon-binding';
import prismaClient from '../db';
import {
  AgentBindingNotFoundError,
  AgentBindingService,
  type AgentBindingPrismaClient,
  type AgentBindingRecord,
  type RebindResult,
} from './agent-binding.service';
import type { SyncService } from './sync.service';

type PrismaLike = typeof prismaClient;

export interface AgentDeviceMoveInput {
  workspaceId: string;
  actorImUserId: string;
  sourceDaemonId: string;
  targetRuntimeInstallationId?: string;
  targetDaemonId?: string;
  dryRun?: boolean;
  includeCeo?: boolean;
  install?: boolean;
  reason?: string;
}

export interface AgentDeviceMoveResult {
  dryRun: boolean;
  workspaceId: string;
  sourceDaemonId: string;
  targetDaemonId: string;
  targetRuntimeInstallationId: string;
  targetDaemonStatus: string;
  movedCount: number;
  failedCount: number;
  plannedCount: number;
  agents: AgentDeviceMoveAgentResult[];
}

export interface AgentDeviceMoveAgentResult {
  status: 'planned' | 'moved' | 'failed';
  agentImUserId: string;
  agentName: string;
  isCeo: boolean;
  previousDaemonId: string;
  binding: {
    agentImUserId: string;
    boundDaemonId: string;
    boundDaemonKind: string;
    boundDaemonLabel: string;
    boundBy: string;
    boundAt: string;
  } | null;
  installResult: unknown | null;
  inFlightTaskCount: number;
  roleModel: RoleModelSummary | null;
  history: HistorySummary;
  memory: MemorySummary;
  localSessionState: {
    migrated: false;
    status: 'not_migrated';
    reason: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

interface RoleModelSummary {
  retained: true;
  profileId: string;
  adapterName: string;
  profileName: string;
  profileVersion: number;
  roleTemplateSlug: string | null;
  taskAuthority: string | null;
  skillCount: number;
  reason: string;
}

interface HistorySummary {
  retained: true;
  sessionRetained: true;
  conversationRetained: true;
  workspaceSessionModel: 'conversation';
  conversationCount: number;
  messageCount: number;
  reason: string;
}

interface MemorySummary {
  retained: true;
  workspaceSharedCount: number;
  agentPrivateCount: number;
  reason: string;
}

interface WorkspaceRow {
  id: string;
  ownerImUserId: string;
  orchestratorAgentId: string | null;
  orchestratorRevokedAt: Date | null;
}

interface TargetRuntime {
  id: string;
  workspaceId: string;
  podName: string;
  namespace: string | null;
  agentImUserId: string | null;
  daemonId: string;
  status: string;
  stoppedAt: Date | null;
  deviceType: string;
  runtimeKind: string;
  providerKind: string;
  maxAgents: number | null;
}

interface AgentCardRow {
  imUserId: string;
  name: string;
  capabilities: string | null;
}

interface AgentUserRow {
  id: string;
  role: string;
  username: string;
  displayName: string | null;
}

interface AgentProfileRow {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: string;
  version: number;
}

interface PlannedAgent {
  binding: AgentBindingRecord;
  card: AgentCardRow | null;
  user: AgentUserRow | null;
  profile: AgentProfileRow | null;
  isCeo: boolean;
  roleModel: RoleModelSummary | null;
  history: HistorySummary;
  memory: MemorySummary;
  inFlightTaskCount: number;
}

export class AgentDeviceMoveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'AgentDeviceMoveError';
  }
}

export class AgentDeviceMoveService {
  constructor(
    private readonly prisma: PrismaLike = prismaClient,
    private readonly syncService?: SyncService,
  ) {}

  async move(input: AgentDeviceMoveInput): Promise<AgentDeviceMoveResult> {
    const sourceDaemonId = input.sourceDaemonId.trim();
    if (!sourceDaemonId) {
      throw new AgentDeviceMoveError('SOURCE_DAEMON_REQUIRED', 'sourceDaemonId is required', 400);
    }

    const workspace = await this.loadWorkspace(input.workspaceId, input.actorImUserId);
    const target = await this.resolveTargetRuntime(input);
    const sourceVariants = daemonIdVariants(sourceDaemonId);
    if (sourceVariants.has(target.daemonId)) {
      throw new AgentDeviceMoveError('TARGET_EQUALS_SOURCE', 'Target daemon is the same as source daemon', 409);
    }

    const planned = await this.planAgents(workspace, sourceVariants, input.includeCeo !== false);
    if (input.dryRun) {
      const agents = planned.map((agent) => this.toPlannedResult(agent));
      return {
        dryRun: true,
        workspaceId: workspace.id,
        sourceDaemonId,
        targetDaemonId: target.daemonId,
        targetRuntimeInstallationId: target.id,
        targetDaemonStatus: target.status,
        movedCount: 0,
        failedCount: agents.filter((agent) => agent.status === 'failed').length,
        plannedCount: agents.filter((agent) => agent.status === 'planned').length,
        agents,
      };
    }

    const agents: AgentDeviceMoveAgentResult[] = [];
    for (const plannedAgent of planned) {
      agents.push(await this.executeAgentMove(workspace, plannedAgent, target, input));
    }

    return {
      dryRun: false,
      workspaceId: workspace.id,
      sourceDaemonId,
      targetDaemonId: target.daemonId,
      targetRuntimeInstallationId: target.id,
      targetDaemonStatus: target.status,
      movedCount: agents.filter((agent) => agent.status === 'moved').length,
      failedCount: agents.filter((agent) => agent.status === 'failed').length,
      plannedCount: 0,
      agents,
    };
  }

  private async loadWorkspace(workspaceId: string, actorImUserId: string): Promise<WorkspaceRow> {
    const workspace = await this.prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: {
        id: true,
        ownerImUserId: true,
        orchestratorAgentId: true,
        orchestratorRevokedAt: true,
      },
    });
    if (!workspace) throw new AgentDeviceMoveError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
    if (workspace.ownerImUserId !== actorImUserId) {
      throw new AgentDeviceMoveError('NOT_WORKSPACE_OWNER', 'Only the workspace owner can move device agents', 403);
    }
    return workspace;
  }

  private async planAgents(
    workspace: WorkspaceRow,
    sourceDaemonIds: Set<string>,
    includeCeo: boolean,
  ): Promise<PlannedAgent[]> {
    const cards = (await this.prisma.iMAgentCard.findMany({
      where: { workspaceId: workspace.id },
      select: { imUserId: true, name: true, capabilities: true },
    })) as AgentCardRow[];
    if (cards.length === 0) return [];

    const workspaceAgentIds = cards.map((card) => card.imUserId);
    const bindings = (await this.prisma.iMAgentBinding.findMany({
      where: {
        agentImUserId: { in: workspaceAgentIds },
        boundDaemonId: { in: [...sourceDaemonIds] },
      },
      orderBy: { lastHostDeclareAt: 'desc' },
    })) as AgentBindingRecord[];

    const filteredBindings = includeCeo
      ? bindings
      : bindings.filter((binding) => binding.agentImUserId !== workspace.orchestratorAgentId);
    if (filteredBindings.length === 0) return [];

    const agentIds = filteredBindings.map((binding) => binding.agentImUserId);
    const [users, profiles] = await Promise.all([
      this.prisma.iMUser.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, role: true, username: true, displayName: true },
      }) as Promise<AgentUserRow[]>,
      this.prisma.iMAgentProfile.findMany({
        where: { workspaceId: workspace.id, agentImUserId: { in: agentIds }, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          workspaceId: true,
          agentImUserId: true,
          adapterName: true,
          name: true,
          config: true,
          version: true,
        },
      }) as Promise<AgentProfileRow[]>,
    ]);

    const cardByAgentId = new Map(cards.map((card) => [card.imUserId, card] as const));
    const userByAgentId = new Map(users.map((user) => [user.id, user] as const));
    const profileByAgentId = new Map<string, AgentProfileRow>();
    for (const profile of profiles) {
      if (!profileByAgentId.has(profile.agentImUserId)) profileByAgentId.set(profile.agentImUserId, profile);
    }

    return Promise.all(
      filteredBindings.map(async (binding) => {
        const agentImUserId = binding.agentImUserId;
        const card = cardByAgentId.get(agentImUserId) ?? null;
        const user = userByAgentId.get(agentImUserId) ?? null;
        const profile = profileByAgentId.get(agentImUserId) ?? null;
        const skillCount = await this.countSkills(agentImUserId);
        const [history, memory, inFlightTaskCount] = await Promise.all([
          this.loadHistorySummary(workspace.id, agentImUserId),
          this.loadMemorySummary(workspace.id, agentImUserId),
          this.countInFlightTasks(agentImUserId),
        ]);
        return {
          binding,
          card,
          user,
          profile,
          isCeo: workspace.orchestratorAgentId === agentImUserId && workspace.orchestratorRevokedAt === null,
          roleModel: profile ? buildRoleModelSummary(profile, skillCount) : null,
          history,
          memory,
          inFlightTaskCount,
        };
      }),
    );
  }

  private toPlannedResult(planned: PlannedAgent): AgentDeviceMoveAgentResult {
    const validationError = validatePlannedAgent(planned);
    return {
      status: validationError ? 'failed' : 'planned',
      agentImUserId: planned.binding.agentImUserId,
      agentName:
        planned.user?.displayName ?? planned.card?.name ?? planned.user?.username ?? planned.binding.agentImUserId,
      isCeo: planned.isCeo,
      previousDaemonId: planned.binding.boundDaemonId,
      binding: null,
      installResult: null,
      inFlightTaskCount: planned.inFlightTaskCount,
      roleModel: planned.roleModel,
      history: planned.history,
      memory: planned.memory,
      localSessionState: localSessionStateBoundary(),
      ...(validationError ? { error: validationError } : {}),
    };
  }

  private async executeAgentMove(
    workspace: WorkspaceRow,
    planned: PlannedAgent,
    target: TargetRuntime,
    input: AgentDeviceMoveInput,
  ): Promise<AgentDeviceMoveAgentResult> {
    const validationError = validatePlannedAgent(planned);
    if (validationError) {
      return { ...this.toPlannedResult(planned), status: 'failed', error: validationError };
    }

    const agentImUserId = planned.binding.agentImUserId;
    const card = planned.card!;
    const user = planned.user!;
    const profile = planned.profile!;
    let installResult: unknown | null = null;
    try {
      if (input.install !== false) {
        installResult = await k8sSandbox.installAgent(target.podName, {
          workspaceId: workspace.id,
          imUserId: agentImUserId,
          name: user.displayName ?? card.name,
          adapterName: profile.adapterName,
          capabilities: parseCapabilities(card.capabilities),
          profile: {
            id: profile.id,
            name: profile.name,
            adapterName: profile.adapterName,
            config: parseJsonRecord(profile.config),
            version: profile.version,
          },
        });
      }

      const bindingService = new AgentBindingService(this.prisma as AgentBindingPrismaClient, this.syncService);
      const rebind = await bindingService.rebind({
        agentImUserId,
        targetDaemonId: target.daemonId,
        targetDaemonKind: inferDaemonKind(target),
        targetDaemonLabel: target.podName ?? target.daemonId,
        actorImUserId: input.actorImUserId,
        reason: input.reason?.trim() || 'agent-device-move',
      });

      await stampAgentCardDaemonBinding({
        prisma: this.prisma as AgentCardDaemonBindingPrisma,
        workspaceId: workspace.id,
        agentImUserId,
        daemonId: target.daemonId,
        runtimeInstallationId: target.id,
      });

      return {
        ...this.toMovedResult(planned, rebind, installResult),
        status: 'moved',
      };
    } catch (err) {
      return {
        ...this.toPlannedResult(planned),
        status: 'failed',
        installResult,
        error: errorToResult(err),
      };
    }
  }

  private toMovedResult(
    planned: PlannedAgent,
    rebind: RebindResult,
    installResult: unknown | null,
  ): AgentDeviceMoveAgentResult {
    return {
      status: 'moved',
      agentImUserId: planned.binding.agentImUserId,
      agentName:
        planned.user?.displayName ?? planned.card?.name ?? planned.user?.username ?? planned.binding.agentImUserId,
      isCeo: planned.isCeo,
      previousDaemonId: rebind.previousDaemonId,
      binding: {
        agentImUserId: rebind.binding.agentImUserId,
        boundDaemonId: rebind.binding.boundDaemonId,
        boundDaemonKind: rebind.binding.boundDaemonKind,
        boundDaemonLabel: rebind.binding.boundDaemonLabel,
        boundBy: rebind.binding.boundBy,
        boundAt: rebind.binding.boundAt.toISOString(),
      },
      installResult,
      inFlightTaskCount: rebind.inFlightTaskCount,
      roleModel: planned.roleModel,
      history: planned.history,
      memory: planned.memory,
      localSessionState: localSessionStateBoundary(),
    };
  }

  private async resolveTargetRuntime(input: AgentDeviceMoveInput): Promise<TargetRuntime> {
    const targetRuntimeInstallationId = input.targetRuntimeInstallationId?.trim();
    const requestedDaemonId = input.targetDaemonId?.trim();
    if (!targetRuntimeInstallationId && !requestedDaemonId) {
      throw new AgentDeviceMoveError(
        'TARGET_RUNTIME_REQUIRED',
        'targetRuntimeInstallationId or targetDaemonId is required',
        400,
      );
    }

    const where = targetRuntimeInstallationId
      ? { id: targetRuntimeInstallationId, workspaceId: input.workspaceId, taskId: null }
      : {
          workspaceId: input.workspaceId,
          taskId: null,
          OR: buildDaemonLookup(requestedDaemonId!),
        };
    const target = await this.prisma.iMContainer.findFirst({
      where,
      select: {
        id: true,
        workspaceId: true,
        podName: true,
        namespace: true,
        agentImUserId: true,
        daemonId: true,
        status: true,
        stoppedAt: true,
        deviceType: true,
        runtimeKind: true,
        providerKind: true,
        maxAgents: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!target) {
      throw new AgentDeviceMoveError('TARGET_RUNTIME_NOT_FOUND', 'Target runtime/daemon not found in workspace', 404);
    }

    const targetDaemonId = resolveContainerDaemonId(target);
    if (requestedDaemonId && !daemonIdMatchesRequest(requestedDaemonId, targetDaemonId, target)) {
      throw new AgentDeviceMoveError(
        'TARGET_DAEMON_MISMATCH',
        'targetDaemonId does not match targetRuntimeInstallationId',
        409,
      );
    }

    if (target.stoppedAt || ['stopped', 'stopping', 'errored', 'error', 'failed'].includes(target.status)) {
      throw new AgentDeviceMoveError('TARGET_RUNTIME_NOT_RUNNING', 'Target runtime is stopped or failed', 409);
    }
    if (target.deviceType !== 'k8s' && target.runtimeKind !== 'k8s' && target.providerKind !== 'k8s') {
      throw new AgentDeviceMoveError('TARGET_RUNTIME_NOT_K8S', 'Bulk agent move currently requires a k8s target', 409);
    }

    const resolved = { ...target, daemonId: targetDaemonId };
    await this.assertTargetPodLive(resolved);
    return resolved;
  }

  private async assertTargetPodLive(target: TargetRuntime): Promise<void> {
    const verdict = await k8sSandbox.podStatusVerdict(target.podName, target.namespace ?? undefined);
    if (verdict.apiError) {
      throw new AgentDeviceMoveError(
        'TARGET_RUNTIME_POD_UNAVAILABLE',
        `Target runtime pod cannot be verified: ${verdict.apiError.message}`,
        503,
      );
    }
    if (!verdict.exists) {
      throw new AgentDeviceMoveError(
        'TARGET_RUNTIME_POD_UNAVAILABLE',
        `Target runtime pod ${target.podName} does not exist in namespace ${verdict.namespace}`,
        409,
      );
    }
    if (verdict.phase !== 'Running' || !verdict.containerStarted) {
      throw new AgentDeviceMoveError(
        'TARGET_RUNTIME_POD_NOT_READY',
        `Target runtime pod ${target.podName} is not ready (phase=${verdict.phase ?? 'unknown'}, started=${String(
          verdict.containerStarted,
        )})`,
        409,
      );
    }
  }

  private async countSkills(agentImUserId: string): Promise<number> {
    return this.prisma.iMAgentSkill.count({
      where: { agentId: agentImUserId, status: { not: 'uninstalled' } },
    });
  }

  private async countInFlightTasks(agentImUserId: string): Promise<number> {
    return this.prisma.iMTask.count({
      where: {
        assigneeId: agentImUserId,
        status: { in: ['pending', 'assigned', 'dispatching', 'running'] },
      },
    });
  }

  private async loadHistorySummary(workspaceId: string, agentImUserId: string): Promise<HistorySummary> {
    const [conversationCount, messageCount] = await Promise.all([
      this.prisma.iMParticipant.count({
        where: { imUserId: agentImUserId, conversation: { workspaceId } },
      }),
      this.prisma.iMMessage.count({
        where: {
          conversation: {
            workspaceId,
            participants: { some: { imUserId: agentImUserId } },
          },
        },
      }),
    ]);
    return {
      retained: true,
      sessionRetained: true,
      conversationRetained: true,
      workspaceSessionModel: 'conversation',
      conversationCount,
      messageCount,
      reason:
        'Workspace sessions are IM conversations keyed by stable conversationId and participant/sender agentImUserId; this move keeps the same agentImUserId.',
    };
  }

  private async loadMemorySummary(workspaceId: string, agentImUserId: string): Promise<MemorySummary> {
    const [workspaceSharedCount, agentPrivateCount] = await Promise.all([
      this.prisma.iMMemoryFile.count({
        where: { workspaceId, scope: 'workspace-shared' },
      }),
      this.prisma.iMMemoryFile.count({
        where: { workspaceId, scope: 'agent-private', agentImUserId },
      }),
    ]);
    return {
      retained: true,
      workspaceSharedCount,
      agentPrivateCount,
      reason:
        'Memory scope rows are cloud DB records keyed by workspaceId and, for agent-private memory, the stable agentImUserId.',
    };
  }
}

function validatePlannedAgent(planned: PlannedAgent): { code: string; message: string } | null {
  if (!planned.user || planned.user.role !== 'agent') {
    return { code: 'AGENT_USER_INVALID', message: 'Bound identity is not an active agent user' };
  }
  if (!planned.card) {
    return { code: 'AGENT_CARD_MISSING', message: 'Bound agent has no workspace agent card' };
  }
  if (!planned.profile) {
    return { code: 'AGENT_PROFILE_MISSING', message: 'Bound agent has no active profile to install' };
  }
  return null;
}

function errorToResult(err: unknown): { code: string; message: string } {
  if (err instanceof AgentBindingNotFoundError) {
    return { code: 'AGENT_BINDING_MISSING', message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'AGENT_DEVICE_MOVE_FAILED', message: err.message };
  }
  return { code: 'AGENT_DEVICE_MOVE_FAILED', message: String(err) };
}

function buildRoleModelSummary(profile: AgentProfileRow, skillCount: number): RoleModelSummary {
  const config = parseJsonRecord(profile.config);
  const roleTemplate =
    config.roleTemplate && typeof config.roleTemplate === 'object' && !Array.isArray(config.roleTemplate)
      ? (config.roleTemplate as Record<string, unknown>)
      : {};
  const roleTemplateSlug = typeof roleTemplate.slug === 'string' ? roleTemplate.slug : null;
  const taskAuthority =
    typeof config.taskAuthority === 'string'
      ? config.taskAuthority
      : typeof roleTemplate.taskAuthority === 'string'
        ? roleTemplate.taskAuthority
        : null;
  return {
    retained: true,
    profileId: profile.id,
    adapterName: profile.adapterName,
    profileName: profile.name,
    profileVersion: profile.version,
    roleTemplateSlug,
    taskAuthority,
    skillCount,
    reason:
      'Role model data stays in IMAgentProfile/IMAgentSkill and is installed to the target daemon with the same agentImUserId.',
  };
}

function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function inferDaemonKind(target: {
  deviceType: string;
  runtimeKind: string;
  providerKind: string;
}): 'k8s' | 'local' | 'edge' {
  if (target.deviceType === 'edge') return 'edge';
  if (target.deviceType === 'k8s' || target.runtimeKind === 'k8s' || target.providerKind === 'k8s') return 'k8s';
  return 'local';
}

function daemonIdVariants(daemonId: string): Set<string> {
  const raw = daemonId.trim();
  const withoutContainerPrefix = raw.startsWith('container:') ? raw.slice('container:'.length) : raw;
  const prefixed = raw.startsWith('container:') ? raw : `container:${raw}`;
  return new Set([raw, withoutContainerPrefix, prefixed].filter(Boolean));
}

function buildDaemonLookup(requestedDaemonId: string): Array<Record<string, string>> {
  const raw = requestedDaemonId.trim();
  const withoutContainerPrefix = raw.startsWith('container:') ? raw.slice('container:'.length) : raw;
  const prefixed = raw.startsWith('container:') ? raw : `container:${raw}`;
  return [
    { daemonId: raw },
    { daemonId: prefixed },
    { agentImUserId: raw },
    { agentImUserId: withoutContainerPrefix },
    { podName: raw },
    { podName: withoutContainerPrefix },
  ];
}

function resolveContainerDaemonId(container: {
  daemonId: string | null;
  agentImUserId: string | null;
  podName: string;
}): string {
  const persisted = container.daemonId?.trim();
  if (persisted) return persisted;
  const legacyRuntimeId = container.agentImUserId?.trim() || container.podName;
  return legacyRuntimeId.startsWith('container:') ? legacyRuntimeId : `container:${legacyRuntimeId}`;
}

function daemonIdMatchesRequest(
  requestedDaemonId: string,
  targetDaemonId: string,
  container: { agentImUserId: string | null; podName: string },
): boolean {
  const variants = daemonIdVariants(requestedDaemonId);
  return variants.has(targetDaemonId) || variants.has(container.agentImUserId ?? '') || variants.has(container.podName);
}

function localSessionStateBoundary(): AgentDeviceMoveAgentResult['localSessionState'] {
  return {
    migrated: false,
    status: 'not_migrated',
    reason:
      'Daemon-local LLM session/cache state is runtime-local and is not automatically moved. Cloud conversation/message/profile/memory history is retained separately.',
  };
}
