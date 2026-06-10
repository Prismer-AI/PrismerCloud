/**
 * Prismer IM — AgentSpec lifecycle service.
 *
 * DB-first implementation for v2.0 agent snapshot / publish / fork. Snapshot
 * opportunistically enriches perAgentDirManifestJson with daemon dump-state
 * when the hosting daemon is reachable; DB-only snapshots remain valid.
 */

import type { AgentStateDumpResult } from '@/lib/k8s-sandbox';
import prisma from '../db';
import { generateIMUserId } from '../utils/id-gen';
import { appendChiefOfStaffClause, prependSkillFirstClauseIfMissing } from '../../lib/role-runtime-policy';

const LOG = '[AgentSpecService]';

type Actor = { imUserId: string; role?: string; resolvedDid?: string };
type AccessMode = 'read' | 'write' | 'publish';

type AgentDaemonContainer = {
  id: string;
  workspaceId: string;
  agentImUserId?: string | null;
  podName: string;
  gatewayUrl?: string | null;
  daemonId?: string | null;
  providerKind?: string | null;
  runtimeKind?: string | null;
  status?: string | null;
};

type DaemonStateCapture =
  | {
      status: 'captured';
      source: 'k8s-daemon' | 'gateway';
      container: Pick<AgentDaemonContainer, 'id' | 'podName' | 'daemonId' | 'providerKind' | 'runtimeKind' | 'status'>;
      manifest: AgentStateDumpResult;
    }
  | {
      status: 'skipped';
      reason: string;
      container?: Pick<AgentDaemonContainer, 'id' | 'podName' | 'daemonId' | 'providerKind' | 'runtimeKind' | 'status'>;
    }
  | {
      status: 'failed';
      reason: string;
      retryable: boolean;
      container?: Pick<AgentDaemonContainer, 'id' | 'podName' | 'daemonId' | 'providerKind' | 'runtimeKind' | 'status'>;
    };

export interface AgentSnapshotOptions {
  includeMemory?: boolean;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentPublishOptions {
  slug?: string;
  version?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  stripMemory?: boolean;
}

export interface AgentForkOptions {
  targetWorkspaceId: string;
  displayName?: string;
  identityOptions?: {
    avatarUrl?: string;
    publicKeyBase64?: string;
  };
}

export interface AgentRestoreOptions {
  snapshotId: string;
  overrideMemory?: boolean;
}

export class AgentLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AgentLifecycleError';
  }
}

export class AgentSpecService {
  async canAccessAgent(actor: Actor, agentImUserId: string, mode: AccessMode = 'read'): Promise<boolean> {
    if (actor.role === 'admin') return true;
    if (actor.imUserId === agentImUserId) return true;

    const [caller, target, card] = await Promise.all([
      prisma.iMUser.findUnique({ where: { id: actor.imUserId }, select: { userId: true } }),
      prisma.iMUser.findUnique({ where: { id: agentImUserId }, select: { role: true, userId: true } }),
      prisma.iMAgentCard.findUnique({ where: { imUserId: agentImUserId }, select: { workspaceId: true } }),
    ]);
    if (target?.role !== 'agent' || !card) return false;
    if (caller?.userId && target.userId === caller.userId) return true;

    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: card.workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!workspace) return false;
    if (workspace.ownerImUserId === actor.imUserId) return true;
    if (mode !== 'read') return false;

    const member = await prisma.iMWorkspaceMember.findUnique({
      where: {
        workspaceId_memberImUserId: {
          workspaceId: card.workspaceId,
          memberImUserId: actor.imUserId,
        },
      },
      select: { id: true },
    });
    return Boolean(member);
  }

  async canUseWorkspace(actor: Actor, workspaceId: string, mode: 'read' | 'create' = 'read'): Promise<boolean> {
    if (actor.role === 'admin') return true;
    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!workspace) return false;
    if (workspace.ownerImUserId === actor.imUserId) return true;
    if (mode === 'create') return false;
    const member = await prisma.iMWorkspaceMember.findUnique({
      where: {
        workspaceId_memberImUserId: {
          workspaceId,
          memberImUserId: actor.imUserId,
        },
      },
      select: { id: true },
    });
    return Boolean(member);
  }

  /**
   * v2.0 B2 — Is this agent the workspace's active Chief of Staff?
   *
   * Reads im_workspaces directly (instead of going through
   * WorkspaceOrchestratorService.getOrchestrator) to avoid an import cycle
   * and to keep this hot read path single-query. Active orchestrator ⇔
   * orchestratorAgentId IS NOT NULL AND orchestratorRevokedAt IS NULL.
   */
  private async isChiefOfStaffForWorkspace(agentImUserId: string, workspaceId: string): Promise<boolean> {
    if (!agentImUserId || !workspaceId) return false;
    try {
      const ws = await prisma.iMWorkspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: { orchestratorAgentId: true, orchestratorRevokedAt: true },
      });
      if (!ws) return false;
      return ws.orchestratorAgentId === agentImUserId && ws.orchestratorRevokedAt === null;
    } catch (err) {
      // Don't sink the whole spec read on a metadata lookup failure.
      console.warn(`${LOG} isChiefOfStaffForWorkspace lookup failed:`, err);
      return false;
    }
  }

  async buildSpec(agentImUserId: string, workspaceId?: string) {
    const agent = await prisma.iMUser.findUnique({
      where: { id: agentImUserId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        role: true,
        primaryDid: true,
        userId: true,
        agentType: true, // v2.0 B1 — drives Skill-first clause variant
      },
    });
    if (!agent || agent.role !== 'agent') throw new AgentLifecycleError('AGENT_NOT_FOUND', 'Agent not found', 404);

    const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentImUserId } });
    if (!card) throw new AgentLifecycleError('AGENT_NOT_FOUND', 'Agent card not found', 404);
    const wsId = workspaceId || card.workspaceId;

    const [profile, skillRows, container] = await Promise.all([
      prisma.iMAgentProfile.findFirst({
        where: { agentImUserId, workspaceId: wsId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.iMAgentSkill.findMany({
        where: { agentId: agentImUserId, status: { not: 'uninstalled' } },
        orderBy: { installedAt: 'asc' },
      }),
      prisma.iMContainer.findFirst({
        where: {
          workspaceId: wsId,
          status: { in: ['bound', 'running', 'provisioning'] },
          OR: [{ agentImUserId }, { agentImUserId: null }],
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const skillIds = skillRows.map((row: any) => row.skillId).filter(Boolean);
    const skills = skillIds.length ? await prisma.iMSkill.findMany({ where: { id: { in: skillIds } } }) : [];
    const skillById = new Map<string, any>(skills.map((skill: any) => [skill.id, skill]));
    const containerSnapshot = container
      ? await prisma.iMContainerSnapshot.findFirst({
          where: { containerId: container.id },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    const profileConfig = parseJsonObject(profile?.config);
    const roleTemplate = parseRecord(profileConfig.roleTemplate);
    const taskAuthority =
      readString(profileConfig.taskAuthority) ?? readString(roleTemplate?.taskAuthority) ?? 'executor';
    const approvalPolicy =
      readString(profileConfig.approvalPolicy) ?? readString(roleTemplate?.approvalPolicy) ?? 'auto-low-risk';

    // v2.0 B2 — Chief-of-Staff dynamic injection.
    // When this agent is the active workspace orchestrator (appointed via
    // WorkspaceOrchestratorService / settings UI), the workspace owner has
    // already granted one-time pre-authorization for routine task dispatch.
    // Append the Chief-of-Staff clause to operatingPrinciples so the agent
    // stops asking per-task approval for routine actions.
    //
    // Derived field — NOT persisted. Each spec read recomputes from the
    // workspace row, so revoke takes effect immediately on the next pull.
    const isChiefOfStaff = await this.isChiefOfStaffForWorkspace(agentImUserId, wsId);
    const baseOperatingPrinciples = profileConfig.operatingPrinciples ?? roleTemplate?.operatingPrinciples ?? null;
    // v2.0 B1 backward-compat — agent profiles created before migration 422
    // have a snapshotted operatingPrinciples without the [Skill-first] block.
    // Inject the clause dynamically at spec read time so existing agents
    // immediately gain skill-first discipline without re-applying the
    // role template. New profiles (from updated use-simple-provisioning.ts
    // and profile-defaults.ts) already include the block — the helper is
    // idempotent (string-search guard).
    const principlesWithSkillFirst = prependSkillFirstClauseIfMissing(
      baseOperatingPrinciples,
      agent.agentType === 'orchestrator',
    );
    const operatingPrinciples = isChiefOfStaff
      ? appendChiefOfStaffClause(principlesWithSkillFirst)
      : principlesWithSkillFirst;

    const agentSkills = skillRows.map((row: any) => {
      const skill = skillById.get(row.skillId);
      const metadata = parseJsonObject(skill?.metadata);
      return {
        skillSlug: skill?.slug ?? row.skillId,
        version: row.version ?? skill?.version ?? '1.0.0',
        source: normalizeSkillSource(skill?.source, metadata),
        config: parseJsonObject(row.config),
        envDeps: parseJsonObject(skill?.requires),
        executable: normalizeExecutable(skill?.executableJson),
      };
    });

    const perAgentDirs = [
      `~/.hermes/profiles/${agent.username || agent.id}/`,
      `~/.openclaw/profiles/${agent.username || agent.id}/`,
      `/workspace/agents/${agent.id}/`,
    ];

    return {
      identity: {
        did: agent.primaryDid ?? card.did ?? null,
        imUserId: agent.id,
        displayName: agent.displayName || card.name || agent.username,
        username: agent.username,
        avatarUrl: agent.avatarUrl ?? undefined,
      },
      definition: {
        roleTemplateSlug: readString(roleTemplate?.slug) ?? undefined,
        operatingPrinciples,
        hermesConfig: roleTemplate?.hermesConfig ?? null,
        openclawConfig: roleTemplate?.openclawConfig ?? null,
        profileConfig,
        taskAuthority,
        approvalPolicy,
      },
      skills: agentSkills,
      memory: {
        scope: 'agent-private',
        storeRef: `workspace:${wsId}:agent:${agent.id}:memory`,
      },
      environment: {
        containerImage: container
          ? `${container.image}:${container.imageTag}`
          : 'dockerhub.services/prismer/sandbox:daemon-v2.0.0',
        containerSnapshot: containerSnapshot?.id ?? null,
        perAgentDirs,
        envVars: parseJsonObject(profileConfig.env),
        quotas: container
          ? {
              cpu: container.cpuLimit,
              memory: container.memoryLimit,
            }
          : {},
      },
      workspaceId: wsId,
      agentCard: {
        id: card.id,
        name: card.name,
        description: card.description,
        agentType: card.agentType,
        capabilities: parseJsonArray(card.capabilities),
        status: card.status,
      },
    };
  }

  async snapshot(agentImUserId: string, actor: Actor, options: AgentSnapshotOptions = {}) {
    const spec = await this.buildSpec(agentImUserId);
    const daemonState = await this.captureDaemonState(agentImUserId, spec.workspaceId);
    const perAgentDirManifest = {
      perAgentDirs: spec.environment.perAgentDirs,
      label: options.label ?? null,
      metadata: options.metadata ?? {},
      createdAt: new Date().toISOString(),
      daemonState,
    };
    const sizeBytes = Buffer.byteLength(JSON.stringify({ spec, perAgentDirManifest }), 'utf8');
    const row = await prisma.iMAgentSnapshot.create({
      data: {
        agentImUserId,
        workspaceId: spec.workspaceId,
        definitionJson: spec.definition as any,
        skillsJson: spec.skills as any,
        containerSnapshotId: spec.environment.containerSnapshot,
        perAgentDirManifestJson: perAgentDirManifest as any,
        memoryDumpRef: options.includeMemory ? spec.memory.storeRef : null,
        includeMemory: Boolean(options.includeMemory),
        createdBy: actor.imUserId,
        status: 'ready',
        sizeBytes: BigInt(sizeBytes),
      },
    });
    console.log(`${LOG} Snapshot created: agent=${agentImUserId} snapshot=${row.id}`);
    return this.toSnapshotDTO(row);
  }

  private async captureDaemonState(agentImUserId: string, workspaceId: string): Promise<DaemonStateCapture> {
    const container = await this.resolveDaemonContainer(agentImUserId, workspaceId);
    if (!container) return { status: 'skipped', reason: 'no_hosting_container' };

    const summary = this.summarizeContainer(container);
    if (container.podName && isK8sContainer(container)) {
      try {
        const { k8sSandbox } = await import('@/lib/k8s-sandbox');
        const manifest = await k8sSandbox.dumpAgentState(container.podName, agentImUserId);
        return { status: 'captured', source: 'k8s-daemon', container: summary, manifest };
      } catch (err) {
        return {
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          retryable: true,
          container: summary,
        };
      }
    }

    if (container.gatewayUrl) {
      try {
        const manifest = await dumpAgentStateViaGateway(container.gatewayUrl, agentImUserId);
        return { status: 'captured', source: 'gateway', container: summary, manifest };
      } catch (err) {
        return {
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
          retryable: true,
          container: summary,
        };
      }
    }

    return { status: 'skipped', reason: 'container_has_no_daemon_endpoint', container: summary };
  }

  private async resolveDaemonContainer(
    agentImUserId: string,
    workspaceId: string,
  ): Promise<AgentDaemonContainer | null> {
    const binding = await (prisma as any).iMAgentBinding?.findUnique?.({
      where: { agentImUserId },
      select: { boundDaemonId: true },
    });
    const boundDaemonId = readString(binding?.boundDaemonId);

    const select = {
      id: true,
      workspaceId: true,
      agentImUserId: true,
      podName: true,
      gatewayUrl: true,
      daemonId: true,
      providerKind: true,
      runtimeKind: true,
      status: true,
    };

    if (boundDaemonId) {
      const bound = await prisma.iMContainer.findFirst({
        where: {
          workspaceId,
          daemonId: boundDaemonId,
          status: { in: ['bound', 'running', 'provisioning'] },
        },
        select,
        orderBy: { updatedAt: 'desc' },
      });
      if (bound) return bound as AgentDaemonContainer;
    }

    const agentContainer = await prisma.iMContainer.findFirst({
      where: {
        workspaceId,
        status: { in: ['bound', 'running', 'provisioning'] },
        OR: [{ agentImUserId }, { agentImUserId: null }],
      },
      select,
      orderBy: { updatedAt: 'desc' },
    });
    return (agentContainer as AgentDaemonContainer | null) ?? null;
  }

  private summarizeContainer(container: AgentDaemonContainer) {
    return {
      id: container.id,
      podName: container.podName,
      daemonId: container.daemonId ?? null,
      providerKind: container.providerKind ?? null,
      runtimeKind: container.runtimeKind ?? null,
      status: container.status ?? null,
    };
  }

  async listSnapshots(agentImUserId: string, cursor?: string, limit = 50) {
    const rows = await prisma.iMAgentSnapshot.findMany({
      where: { agentImUserId, ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100) + 1,
    });
    const page = rows.slice(0, Math.min(Math.max(limit, 1), 100));
    return {
      items: page.map((row: any) => this.toSnapshotDTO(row)),
      nextCursor: rows.length > page.length ? rows[page.length - 1].createdAt.toISOString() : undefined,
    };
  }

  async restore(agentImUserId: string, actor: Actor, options: AgentRestoreOptions) {
    const snapshot = await prisma.iMAgentSnapshot.findFirst({
      where: { id: options.snapshotId, agentImUserId },
    });
    if (!snapshot) throw new AgentLifecycleError('SNAPSHOT_NOT_FOUND', 'Snapshot not found', 404);

    const definition = normalizeJson(snapshot.definitionJson);
    const profileConfig = parseRecord(definition.profileConfig) ?? {};
    const card = await prisma.iMAgentCard.findUnique({ where: { imUserId: agentImUserId } });
    if (!card) throw new AgentLifecycleError('AGENT_NOT_FOUND', 'Agent card not found', 404);

    let profile = await prisma.iMAgentProfile.findFirst({
      where: { agentImUserId, workspaceId: snapshot.workspaceId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
    if (!profile) {
      profile = await prisma.iMAgentProfile.create({
        data: {
          workspaceId: snapshot.workspaceId,
          agentImUserId,
          adapterName: readString(profileConfig.adapterName) ?? 'hermes',
          name: 'default',
          config: JSON.stringify(profileConfig),
        },
      });
    } else {
      await prisma.iMAgentProfile.update({
        where: { id: profile.id },
        data: { config: JSON.stringify(profileConfig), version: { increment: 1 } },
      });
    }

    const skills = Array.isArray(snapshot.skillsJson) ? (snapshot.skillsJson as any[]) : [];
    for (const item of skills) {
      const slug = readString(item?.skillSlug);
      if (!slug) continue;
      const skill = await prisma.iMSkill.findFirst({ where: { slug, status: 'active' } });
      if (!skill) continue;
      await prisma.iMAgentSkill.upsert({
        where: { agentId_skillId: { agentId: agentImUserId, skillId: skill.id } },
        create: {
          agentId: agentImUserId,
          skillId: skill.id,
          workspaceId: snapshot.workspaceId,
          status: 'active',
          version: readString(item?.version) ?? skill.version,
          config: JSON.stringify(parseRecord(item?.config) ?? {}),
        },
        update: {
          status: 'active',
          version: readString(item?.version) ?? skill.version,
          config: JSON.stringify(parseRecord(item?.config) ?? {}),
        },
      });
    }

    console.log(`${LOG} Restored snapshot: agent=${agentImUserId} snapshot=${snapshot.id} by=${actor.imUserId}`);
    return {
      restored: true,
      snapshot: this.toSnapshotDTO(snapshot),
      agentSpec: await this.buildSpec(agentImUserId, snapshot.workspaceId),
      memoryRestored: Boolean(options.overrideMemory && snapshot.includeMemory),
    };
  }

  async publish(agentImUserId: string, actor: Actor, options: AgentPublishOptions = {}) {
    const spec = await this.buildSpec(agentImUserId);
    const slug = slugify(options.slug || spec.identity.username || spec.identity.displayName || agentImUserId);
    if (!slug) throw new AgentLifecycleError('PUBLISH_INVALID_SLUG', 'Package slug is required', 400);

    const publisher = await prisma.iMUser.findUnique({
      where: { id: actor.imUserId },
      select: { primaryDid: true },
    });
    const publisherDid = actor.resolvedDid ?? publisher?.primaryDid ?? spec.identity.did ?? `im:${actor.imUserId}`;
    const environmentJson =
      options.stripMemory === false ? { ...spec.environment, memory: spec.memory } : spec.environment;
    const row = await prisma.iMAgentPackage.create({
      data: {
        slug,
        version: options.version || '1.0.0',
        publisherImUserId: actor.imUserId,
        publisherDid,
        definitionJson: spec.definition as any,
        skillsJson: spec.skills as any,
        environmentJson: environmentJson as any,
        metadataJson: {
          title: spec.identity.displayName,
          description: spec.agentCard.description,
          tags: [],
          ...(options.metadata ?? {}),
        } as any,
        license: options.license || 'proprietary',
        curatedQuality: readString(options.metadata?.curatedQuality) ?? 'review',
        status: 'active',
      },
    });
    console.log(`${LOG} Published package: agent=${agentImUserId} package=${row.id} slug=${row.slug}`);
    return this.toPackageDTO(row);
  }

  async listPackages(options: {
    q?: string;
    curatedQuality?: string;
    license?: string;
    publisherDid?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const where: Record<string, unknown> = { status: 'active' };
    if (options.curatedQuality) where.curatedQuality = options.curatedQuality;
    if (options.license) where.license = options.license;
    if (options.publisherDid) where.publisherDid = options.publisherDid;
    if (options.cursor) where.createdAt = { lt: new Date(options.cursor) };
    if (options.q) {
      where.OR = [{ slug: { contains: options.q } }, { license: { contains: options.q } }];
    }

    const rows = await prisma.iMAgentPackage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row: any) => this.toPackageDTO(row)),
      nextCursor: rows.length > page.length ? rows[page.length - 1].createdAt.toISOString() : undefined,
    };
  }

  async forkPackage(packIdOrSlug: string, actor: Actor, options: AgentForkOptions) {
    const pack = await prisma.iMAgentPackage.findFirst({
      where: {
        status: 'active',
        OR: [{ id: packIdOrSlug }, { slug: packIdOrSlug }],
      },
    });
    if (!pack) throw new AgentLifecycleError('AGENT_PACK_NOT_FOUND', 'Agent pack not found', 404);

    const workspace = await prisma.iMWorkspace.findFirst({
      where: { id: options.targetWorkspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!workspace) throw new AgentLifecycleError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);

    const owner = await prisma.iMUser.findUnique({
      where: { id: workspace.ownerImUserId },
      select: { userId: true },
    });

    const definition = normalizeJson(pack.definitionJson);
    const profileConfig = parseRecord(definition.profileConfig) ?? {};
    const displayName = options.displayName || readString(parseRecord(pack.metadataJson)?.title) || titleize(pack.slug);
    const username = await this.uniqueAgentUsername(slugify(displayName) || pack.slug);
    const newImUserId = generateIMUserId('agent');

    const [user] = await prisma.$transaction([
      prisma.iMUser.create({
        data: {
          id: newImUserId,
          username,
          displayName,
          role: 'agent',
          agentType: readString(definition.taskAuthority) === 'orchestrator' ? 'orchestrator' : 'specialist',
          avatarUrl: options.identityOptions?.avatarUrl,
          userId: owner?.userId ?? null,
          metadata: JSON.stringify({ forkedFromPackageId: pack.id, forkedAt: new Date().toISOString() }),
        },
      }),
      prisma.iMAgentCard.create({
        data: {
          imUserId: newImUserId,
          workspaceId: workspace.id,
          name: displayName,
          description: readString(parseRecord(pack.metadataJson)?.description) ?? '',
          agentType: readString(definition.taskAuthority) === 'orchestrator' ? 'orchestrator' : 'specialist',
          capabilities: JSON.stringify([]),
          metadata: JSON.stringify({ forkedFromPackageId: pack.id }),
          status: 'offline',
        },
      }),
      prisma.iMAgentProfile.create({
        data: {
          workspaceId: workspace.id,
          agentImUserId: newImUserId,
          adapterName: readString(profileConfig.adapterName) ?? 'hermes',
          name: 'default',
          config: JSON.stringify({
            ...profileConfig,
            taskAuthority: definition.taskAuthority ?? profileConfig.taskAuthority ?? 'executor',
            approvalPolicy: definition.approvalPolicy ?? profileConfig.approvalPolicy ?? 'auto-low-risk',
          }),
        },
      }),
    ]);

    const skills = Array.isArray(pack.skillsJson) ? (pack.skillsJson as any[]) : [];
    for (const item of skills) {
      const slug = readString(item?.skillSlug);
      if (!slug) continue;
      const skill = await prisma.iMSkill.findFirst({ where: { slug, status: 'active' } });
      if (!skill) continue;
      await prisma.iMAgentSkill.upsert({
        where: { agentId_skillId: { agentId: newImUserId, skillId: skill.id } },
        create: {
          agentId: newImUserId,
          skillId: skill.id,
          workspaceId: workspace.id,
          status: 'active',
          version: readString(item?.version) ?? skill.version,
          config: JSON.stringify(parseRecord(item?.config) ?? {}),
        },
        update: { status: 'active' },
      });
    }

    console.log(`${LOG} Forked package: package=${pack.id} newAgent=${newImUserId} by=${actor.imUserId}`);
    return {
      agentSpec: await this.buildSpec(newImUserId, workspace.id),
      newDid: user.primaryDid ?? null,
      newImUserId,
      package: this.toPackageDTO(pack),
    };
  }

  async deletePackage(packIdOrSlug: string, actor: Actor) {
    const pack = await prisma.iMAgentPackage.findFirst({
      where: { OR: [{ id: packIdOrSlug }, { slug: packIdOrSlug }] },
    });
    if (!pack) throw new AgentLifecycleError('AGENT_PACK_NOT_FOUND', 'Agent pack not found', 404);
    if (actor.role !== 'admin' && pack.publisherImUserId !== actor.imUserId) {
      throw new AgentLifecycleError('FORBIDDEN', 'Only the publisher can delete this agent pack', 403);
    }
    await prisma.iMAgentPackage.update({ where: { id: pack.id }, data: { status: 'deleted' } });
    return { deleted: true, packageId: pack.id };
  }

  private async uniqueAgentUsername(base: string): Promise<string> {
    const clean = slugify(base).slice(0, 24) || 'agent';
    let candidate = clean;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const exists = await prisma.iMUser.findFirst({ where: { username: candidate }, select: { id: true } });
      if (!exists) return candidate;
      candidate = `${clean}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 31);
    }
    return `${clean}-${Date.now().toString(36)}`.slice(0, 31);
  }

  private toSnapshotDTO(row: any) {
    return {
      id: row.id,
      agentImUserId: row.agentImUserId,
      workspaceId: row.workspaceId,
      definition: normalizeJson(row.definitionJson),
      skills: normalizeJson(row.skillsJson),
      containerSnapshotId: row.containerSnapshotId,
      perAgentDirManifest: normalizeJson(row.perAgentDirManifestJson),
      memoryDumpRef: row.memoryDumpRef,
      includeMemory: row.includeMemory,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
      createdBy: row.createdBy,
      status: row.status,
      sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    };
  }

  private toPackageDTO(row: any) {
    return {
      id: row.id,
      slug: row.slug,
      version: row.version,
      publisherImUserId: row.publisherImUserId,
      publisherDid: row.publisherDid,
      definition: normalizeJson(row.definitionJson),
      skills: normalizeJson(row.skillsJson),
      environment: normalizeJson(row.environmentJson),
      metadata: normalizeJson(row.metadataJson),
      license: row.license,
      curatedQuality: row.curatedQuality,
      status: row.status,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    };
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeJson(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function titleize(value: string): string {
  return (
    value
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ') || 'Forked Agent'
  );
}

function normalizeSkillSource(source: unknown, metadata: Record<string, unknown>): string {
  const value = readString(source) ?? readString(metadata.source) ?? 'community';
  if (value === 'built-in' || value === 'prismer') return 'built-in';
  if (value === 'agent-generated') return 'agent-generated';
  return value;
}

function normalizeExecutable(value: unknown): Record<string, unknown> | undefined {
  const record = parseRecord(value);
  return record ?? undefined;
}

function isK8sContainer(container: AgentDaemonContainer): boolean {
  return container.providerKind === 'k8s' || container.runtimeKind === 'k8s';
}

async function dumpAgentStateViaGateway(gatewayUrl: string, agentImUserId: string): Promise<AgentStateDumpResult> {
  const endpoint =
    gatewayUrl.replace(/\/$/, '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:') +
    `/v1/agents/${encodeURIComponent(agentImUserId)}/dump-state`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`daemon dump-state returned HTTP ${res.status}: ${text.slice(0, 256)}`);
  const parsed = JSON.parse(text) as AgentStateDumpResult;
  if (!parsed || parsed.agentId !== agentImUserId || !Array.isArray(parsed.files) || !Array.isArray(parsed.roots)) {
    throw new Error('daemon dump-state response missing agentId/roots/files');
  }
  return parsed;
}
