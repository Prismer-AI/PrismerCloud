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
  type RebindResult,
} from './agent-binding.service';
import type { SyncService } from './sync.service';

type PrismaLike = typeof prismaClient;

export interface CeoRuntimeMoveInput {
  workspaceId: string;
  actorImUserId: string;
  targetRuntimeInstallationId?: string;
  targetDaemonId?: string;
  dryRun?: boolean;
  install?: boolean;
  reason?: string;
}

export interface CeoRuntimeMoveResult {
  dryRun: boolean;
  moved: boolean;
  workspaceId: string;
  ceoAgentImUserId: string;
  previousDaemonId: string | null;
  targetDaemonId: string;
  targetRuntimeInstallationId: string | null;
  targetDaemonStatus: string;
  binding: {
    agentImUserId: string;
    boundDaemonId: string;
    boundDaemonKind: string;
    boundDaemonLabel: string;
    boundBy: string;
    boundAt: string;
  } | null;
  inFlightTaskCount: number;
  installResult: unknown | null;
  roleModel: {
    retained: true;
    profileId: string;
    adapterName: string;
    profileName: string;
    profileVersion: number;
    roleTemplateSlug: string | null;
    taskAuthority: string | null;
    reason: string;
  };
  history: {
    retained: true;
    sessionRetained: true;
    conversationRetained: true;
    workspaceSessionModel: 'conversation';
    reason: string;
    conversationCount: number;
    messageCount: number;
  };
  localSessionState: {
    migrated: false;
    status: 'not_migrated';
    reason: string;
  };
}

export class CeoRuntimeMoveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CeoRuntimeMoveError';
  }
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
}

export class CeoRuntimeMoveService {
  constructor(
    private readonly prisma: PrismaLike = prismaClient,
    private readonly syncService?: SyncService,
  ) {}

  async move(input: CeoRuntimeMoveInput): Promise<CeoRuntimeMoveResult> {
    const ws = await this.prisma.iMWorkspace.findFirst({
      where: { id: input.workspaceId, deletedAt: null },
      select: {
        id: true,
        ownerImUserId: true,
        orchestratorAgentId: true,
        orchestratorRevokedAt: true,
      },
    });
    if (!ws) throw new CeoRuntimeMoveError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
    if (ws.ownerImUserId !== input.actorImUserId) {
      throw new CeoRuntimeMoveError('NOT_WORKSPACE_OWNER', 'Only the workspace owner can move the CEO runtime', 403);
    }
    if (!ws.orchestratorAgentId || ws.orchestratorRevokedAt !== null) {
      throw new CeoRuntimeMoveError('CEO_NOT_APPOINTED', 'Workspace has no active CEO/orchestrator appointment', 409);
    }

    const ceoAgentImUserId = ws.orchestratorAgentId;
    const [agent, card, profile] = await Promise.all([
      this.prisma.iMUser.findUnique({
        where: { id: ceoAgentImUserId },
        select: { id: true, role: true, username: true, displayName: true },
      }),
      this.prisma.iMAgentCard.findFirst({
        where: { workspaceId: ws.id, imUserId: ceoAgentImUserId },
        select: { imUserId: true, name: true, capabilities: true },
      }),
      this.prisma.iMAgentProfile.findFirst({
        where: { workspaceId: ws.id, agentImUserId: ceoAgentImUserId, deletedAt: null },
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
      }),
    ]);
    if (!agent || agent.role !== 'agent' || !card) {
      throw new CeoRuntimeMoveError('CEO_AGENT_INVALID', 'The active orchestrator is not a workspace agent', 409);
    }
    if (!profile) {
      throw new CeoRuntimeMoveError(
        'CEO_PROFILE_MISSING',
        'CEO has no active agent profile to install on the target runtime',
        409,
      );
    }
    assertCeoProfile(profile.config);
    const roleModel = buildRoleModelSummary(profile);

    const target = await this.resolveTargetRuntime(input);
    const targetDaemonId = target.daemonId;
    const currentBinding = await this.prisma.iMAgentBinding.findUnique({
      where: { agentImUserId: ceoAgentImUserId },
      select: { boundDaemonId: true },
    });
    const inFlightTaskCount = await this.countInFlightTasks(ceoAgentImUserId);
    const history = await this.loadHistorySummary(ws.id, ceoAgentImUserId);

    if (input.dryRun) {
      return {
        dryRun: true,
        moved: false,
        workspaceId: ws.id,
        ceoAgentImUserId,
        previousDaemonId: currentBinding?.boundDaemonId ?? null,
        targetDaemonId,
        targetRuntimeInstallationId: target.id,
        targetDaemonStatus: target.status,
        binding: null,
        inFlightTaskCount,
        installResult: null,
        roleModel,
        history,
        localSessionState: localSessionStateBoundary(),
      };
    }

    let installResult: unknown | null = null;
    if (input.install !== false) {
      installResult = await k8sSandbox.installAgent(target.podName, {
        workspaceId: ws.id,
        imUserId: ceoAgentImUserId,
        name: agent.displayName ?? card.name,
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
    let rebind: RebindResult;
    try {
      rebind = await bindingService.rebind({
        agentImUserId: ceoAgentImUserId,
        targetDaemonId,
        targetDaemonKind: inferDaemonKind(target),
        targetDaemonLabel: target.podName ?? targetDaemonId,
        actorImUserId: input.actorImUserId,
        reason: input.reason?.trim() || 'ceo-runtime-move',
      });
    } catch (err) {
      if (err instanceof AgentBindingNotFoundError) {
        throw new CeoRuntimeMoveError(
          'CEO_BINDING_MISSING',
          'CEO has no binding row yet; start the daemon once so host.declare creates ownership before moving',
          409,
        );
      }
      throw err;
    }

    await stampAgentCardDaemonBinding({
      prisma: this.prisma as AgentCardDaemonBindingPrisma,
      workspaceId: ws.id,
      agentImUserId: ceoAgentImUserId,
      daemonId: targetDaemonId,
      runtimeInstallationId: target.id ?? undefined,
    });

    return {
      dryRun: false,
      moved: true,
      workspaceId: ws.id,
      ceoAgentImUserId,
      previousDaemonId: rebind.previousDaemonId,
      targetDaemonId,
      targetRuntimeInstallationId: target.id,
      targetDaemonStatus: target.status,
      binding: {
        agentImUserId: rebind.binding.agentImUserId,
        boundDaemonId: rebind.binding.boundDaemonId,
        boundDaemonKind: rebind.binding.boundDaemonKind,
        boundDaemonLabel: rebind.binding.boundDaemonLabel,
        boundBy: rebind.binding.boundBy,
        boundAt: rebind.binding.boundAt.toISOString(),
      },
      inFlightTaskCount: rebind.inFlightTaskCount,
      installResult,
      roleModel,
      history,
      localSessionState: localSessionStateBoundary(),
    };
  }

  private async resolveTargetRuntime(input: CeoRuntimeMoveInput): Promise<TargetRuntime> {
    const targetRuntimeInstallationId = input.targetRuntimeInstallationId?.trim();
    const requestedDaemonId = input.targetDaemonId?.trim();
    if (!targetRuntimeInstallationId && !requestedDaemonId) {
      throw new CeoRuntimeMoveError(
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
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!target) {
      throw new CeoRuntimeMoveError('TARGET_RUNTIME_NOT_FOUND', 'Target runtime/daemon not found in workspace', 404);
    }

    const targetDaemonId = resolveContainerDaemonId(target);
    if (requestedDaemonId && !daemonIdMatchesRequest(requestedDaemonId, targetDaemonId, target)) {
      throw new CeoRuntimeMoveError(
        'TARGET_DAEMON_MISMATCH',
        'targetDaemonId does not match targetRuntimeInstallationId',
        409,
      );
    }

    if (target.stoppedAt || ['stopped', 'stopping', 'errored', 'error', 'failed'].includes(target.status)) {
      throw new CeoRuntimeMoveError('TARGET_RUNTIME_NOT_RUNNING', 'Target runtime is stopped or failed', 409);
    }
    if (target.deviceType !== 'k8s' && target.runtimeKind !== 'k8s' && target.providerKind !== 'k8s') {
      throw new CeoRuntimeMoveError('TARGET_RUNTIME_NOT_K8S', 'CEO move currently requires a k8s runtime target', 409);
    }
    const resolved = { ...target, daemonId: targetDaemonId };
    await this.assertTargetPodLive(resolved);
    return resolved;
  }

  private async assertTargetPodLive(target: TargetRuntime): Promise<void> {
    const verdict = await k8sSandbox.podStatusVerdict(target.podName, target.namespace ?? undefined);
    if (verdict.apiError) {
      throw new CeoRuntimeMoveError(
        'TARGET_RUNTIME_POD_UNAVAILABLE',
        `Target runtime pod cannot be verified: ${verdict.apiError.message}`,
        503,
      );
    }
    if (!verdict.exists) {
      throw new CeoRuntimeMoveError(
        'TARGET_RUNTIME_POD_UNAVAILABLE',
        `Target runtime pod ${target.podName} does not exist in namespace ${verdict.namespace}`,
        409,
      );
    }
    if (verdict.phase !== 'Running' || !verdict.containerStarted) {
      throw new CeoRuntimeMoveError(
        'TARGET_RUNTIME_POD_NOT_READY',
        `Target runtime pod ${target.podName} is not ready (phase=${verdict.phase ?? 'unknown'}, started=${String(
          verdict.containerStarted,
        )})`,
        409,
      );
    }
  }

  private async countInFlightTasks(agentImUserId: string): Promise<number> {
    return this.prisma.iMTask.count({
      where: {
        assigneeId: agentImUserId,
        status: { in: ['pending', 'assigned', 'dispatching', 'running'] },
      },
    });
  }

  private async loadHistorySummary(
    workspaceId: string,
    agentImUserId: string,
  ): Promise<CeoRuntimeMoveResult['history']> {
    const [conversationCount, messageCount] = await Promise.all([
      this.prisma.iMParticipant.count({
        where: {
          imUserId: agentImUserId,
          conversation: { workspaceId },
        },
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
      reason:
        'Workspace sessions are IM conversations. Cloud conversation/session history is keyed by stable conversationId and sender/participant agentImUserId; this move keeps the same CEO agentImUserId.',
      conversationCount,
      messageCount,
    };
  }
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

function assertCeoProfile(rawConfig: string | null): void {
  const config = parseJsonRecord(rawConfig);
  const roleTemplate =
    config.roleTemplate && typeof config.roleTemplate === 'object' && !Array.isArray(config.roleTemplate)
      ? (config.roleTemplate as Record<string, unknown>)
      : {};
  const slug = typeof roleTemplate.slug === 'string' ? roleTemplate.slug : null;
  const authority =
    typeof config.taskAuthority === 'string'
      ? config.taskAuthority
      : typeof roleTemplate.taskAuthority === 'string'
        ? roleTemplate.taskAuthority
        : null;
  if (slug !== 'ceo' && authority !== 'orchestrator') {
    throw new CeoRuntimeMoveError(
      'CEO_PROFILE_NOT_ORCHESTRATOR',
      'Active CEO profile must carry roleTemplate.slug=ceo or taskAuthority=orchestrator',
      409,
    );
  }
}

function buildRoleModelSummary(profile: {
  id: string;
  adapterName: string;
  name: string;
  version: number;
  config: string | null;
}): CeoRuntimeMoveResult['roleModel'] {
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
    reason:
      'CEO role-model data stays in IMAgentProfile and is installed to the target daemon with the same agentImUserId.',
  };
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
  const raw = requestedDaemonId.trim();
  const withoutContainerPrefix = raw.startsWith('container:') ? raw.slice('container:'.length) : raw;
  const prefixed = raw.startsWith('container:') ? raw : `container:${raw}`;
  return (
    raw === targetDaemonId ||
    prefixed === targetDaemonId ||
    withoutContainerPrefix === targetDaemonId ||
    raw === container.agentImUserId ||
    withoutContainerPrefix === container.agentImUserId ||
    raw === container.podName ||
    withoutContainerPrefix === container.podName
  );
}

function localSessionStateBoundary(): CeoRuntimeMoveResult['localSessionState'] {
  return {
    migrated: false,
    status: 'not_migrated',
    reason:
      'Daemon-local LLM session/cache state is runtime-local and is not automatically moved. Cloud conversation/message history is retained separately.',
  };
}
