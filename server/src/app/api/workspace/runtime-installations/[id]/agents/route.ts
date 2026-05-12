/**
 * Install an existing workspace agent/profile onto a managed runtime daemon.
 *
 * This endpoint is the cloud-side orchestrator for:
 *   Workspace RuntimeInstallation -> in-pod daemon local SQLite -> declare.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { K8sSandboxError, k8sSandbox } from '@/lib/k8s-sandbox';
import {
  emitRuntimeInstallVerifiedNotification,
  emitRuntimeInstallFailedNotification,
} from '@/lib/notification-emitter';
import { authorizeContainer } from '../../../../sandboxes/_helpers';

export const dynamic = 'force-dynamic';

const Body = z.object({
  agentImUserId: z.string().min(1),
  profileId: z.string().min(1).optional(),
  adapterName: z.string().trim().min(1).default('hermes'),
  profileName: z.string().trim().min(1).max(80).default('default'),
  config: z.record(z.string(), z.unknown()).default({}),
});

type AgentCardRow = {
  imUserId: string;
  workspaceId: string | null;
  name: string;
  capabilities: string | null;
  imUser: {
    id: string;
    userId: string | null;
    displayName: string | null;
    username: string;
  };
};

type ProfileRow = {
  id: string;
  workspaceId: string;
  agentImUserId: string;
  adapterName: string;
  name: string;
  config: string;
  version: number;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await authorizeContainer(req, id);
  if (!auth.ok) return auth.response;

  const { container, workspace } = auth.data;
  if (container.taskId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_runtime_installation',
          message: 'Agents can only be installed onto long-running runtime installations.',
        },
      },
      { status: 409 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'invalid_body', details: parsed.error.flatten() }, { status: 400 });
  }

  const agent = (await prisma.iMAgentCard.findFirst({
    where: {
      imUserId: parsed.data.agentImUserId,
      workspaceId: workspace.id,
      imUser: { role: 'agent' },
    },
    include: {
      imUser: { select: { id: true, userId: true, displayName: true, username: true } },
    },
  })) as AgentCardRow | null;

  if (!agent) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'agent_not_found',
          message: 'Agent is not registered in this workspace.',
        },
      },
      { status: 404 },
    );
  }

  const profile = await resolveOrCreateProfile({
    workspaceId: workspace.id,
    agentImUserId: agent.imUserId,
    profileId: parsed.data.profileId,
    adapterName: parsed.data.adapterName,
    profileName: parsed.data.profileName,
    config: parsed.data.config,
  });

  const capabilities = parseCapabilities(agent.capabilities);
  try {
    const installArgs = {
      workspaceId: workspace.id,
      imUserId: agent.imUserId,
      name: agent.imUser.displayName ?? agent.name,
      adapterName: profile.adapterName,
      capabilities,
      profile: {
        id: profile.id,
        name: profile.name,
        adapterName: profile.adapterName,
        config: parseConfig(profile.config),
        version: profile.version,
      },
    };
    const result = await k8sSandbox.installAgent(container.podName, installArgs);

    await stampRuntimeInstallMetadata(agent.imUserId, container.agentImUserId ?? container.podName, container.id);

    logger.info(
      {
        runtimeInstallationId: container.id,
        podName: container.podName,
        agentImUserId: agent.imUserId,
        profileId: profile.id,
      },
      'agent installed onto workspace runtime',
    );

    // Wave-8 W9: confirmation row in the workspace owner's Bell. The label
    // prefers the user-facing displayName so the message reads naturally;
    // falls back to the AgentCard.name we already loaded for capabilities.
    void emitRuntimeInstallVerifiedNotification({
      ownerImUserId: workspace.ownerImUserId,
      workspaceId: workspace.id,
      runtimeInstallationId: container.id,
      daemonId: container.agentImUserId ?? container.podName,
      podName: container.podName,
      agentImUserId: agent.imUserId,
      agentLabel: agent.imUser.displayName ?? agent.name,
    });

    return NextResponse.json({
      ok: true,
      data: {
        runtimeInstallationId: container.id,
        podName: container.podName,
        result,
        profile: {
          id: profile.id,
          agentImUserId: profile.agentImUserId,
          adapterName: profile.adapterName,
          name: profile.name,
          version: profile.version,
        },
      },
    });
  } catch (err) {
    if (err instanceof K8sSandboxError) {
      logger.warn(
        { status: err.status, body: err.body, containerId: container.id, podName: container.podName },
        'install agent k8s error',
      );
      // Wave-8 W9: Bell row so the operator sees the failure even if they
      // closed the install dialog before the controller responded.
      void emitRuntimeInstallFailedNotification({
        ownerImUserId: workspace.ownerImUserId,
        workspaceId: workspace.id,
        runtimeInstallationId: container.id,
        daemonId: container.agentImUserId ?? container.podName,
        podName: container.podName,
        agentLabel: agent.imUser.displayName ?? agent.name,
        reason: err.body || `controller_error_${err.status}`,
      });
      return NextResponse.json(
        { ok: false, error: { code: 'controller_error', message: err.body, status: err.status } },
        { status: 502 },
      );
    }
    logger.error({ err, containerId: container.id, podName: container.podName }, 'install agent failed');
    void emitRuntimeInstallFailedNotification({
      ownerImUserId: workspace.ownerImUserId,
      workspaceId: workspace.id,
      runtimeInstallationId: container.id,
      daemonId: container.agentImUserId ?? container.podName,
      podName: container.podName,
      agentLabel: agent.imUser.displayName ?? agent.name,
      reason: err instanceof Error ? err.message : 'Internal error',
    });
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'install_agent_failed', message: err instanceof Error ? err.message : 'Internal error' },
      },
      { status: 500 },
    );
  }
}

async function resolveOrCreateProfile(input: {
  workspaceId: string;
  agentImUserId: string;
  profileId?: string;
  adapterName: string;
  profileName: string;
  config: Record<string, unknown>;
}): Promise<ProfileRow> {
  if (input.profileId) {
    const existing = (await prisma.iMAgentProfile.findFirst({
      where: {
        id: input.profileId,
        workspaceId: input.workspaceId,
        agentImUserId: input.agentImUserId,
        deletedAt: null,
      },
    })) as ProfileRow | null;
    if (!existing) {
      throw new Error('Profile not found for selected agent/runtime workspace');
    }
    return existing;
  }

  const existing = (await prisma.iMAgentProfile.findFirst({
    where: {
      workspaceId: input.workspaceId,
      agentImUserId: input.agentImUserId,
      adapterName: input.adapterName,
      name: input.profileName,
      deletedAt: null,
    },
  })) as ProfileRow | null;
  if (existing) return existing;

  return (await prisma.iMAgentProfile.create({
    data: {
      workspaceId: input.workspaceId,
      agentImUserId: input.agentImUserId,
      adapterName: input.adapterName,
      name: input.profileName,
      config: JSON.stringify(input.config ?? {}),
    },
  })) as ProfileRow;
}

async function stampRuntimeInstallMetadata(
  agentImUserId: string,
  runtimeInstanceId: string,
  runtimeInstallationId: string,
) {
  const card = (await prisma.iMAgentCard.findUnique({
    where: { imUserId: agentImUserId },
    select: { metadata: true },
  })) as { metadata: string | null } | null;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = card?.metadata ? (JSON.parse(card.metadata) as Record<string, unknown>) : {};
  } catch {
    metadata = {};
  }
  metadata.daemonId = runtimeInstanceId.startsWith('container:') ? runtimeInstanceId : `container:${runtimeInstanceId}`;
  metadata.runtimeInstallationId = runtimeInstallationId;
  metadata.runtimeInstalledAt = new Date().toISOString();
  await prisma.iMAgentCard.updateMany({
    where: { imUserId: agentImUserId },
    data: { metadata: JSON.stringify(metadata) },
  });
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

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
