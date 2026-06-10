import prismaClient from '@/lib/prisma';
import { logger as defaultLogger } from '@/lib/logger';

export type AgentCardDaemonBindingPrisma = {
  iMAgentCard: {
    findFirst(args: {
      where: { workspaceId: string; imUserId: string };
      select: { imUserId: true; metadata: true };
    }): Promise<{ imUserId: string; metadata: string | null } | null>;
    update(args: { where: { imUserId: string }; data: { metadata: string } }): Promise<unknown>;
  };
};

type AgentCardDaemonBindingLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
};

export async function stampAgentCardDaemonBinding(input: {
  workspaceId: string;
  agentImUserId: string;
  daemonId: string;
  runtimeInstallationId?: string;
  runtimeInstalledAt?: string | Date;
  prisma?: AgentCardDaemonBindingPrisma;
  logger?: AgentCardDaemonBindingLogger;
}): Promise<boolean> {
  const prisma = input.prisma ?? prismaClient;
  const logger = input.logger ?? defaultLogger;
  const card = await prisma.iMAgentCard.findFirst({
    where: { workspaceId: input.workspaceId, imUserId: input.agentImUserId },
    select: { imUserId: true, metadata: true },
  });
  if (!card) return false;

  let metadata: Record<string, unknown> = {};
  try {
    const parsed = card.metadata ? (JSON.parse(card.metadata) as unknown) : {};
    metadata =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    logger.warn(
      { workspaceId: input.workspaceId, agentImUserId: input.agentImUserId },
      'agent card metadata is malformed; replacing while stamping daemon binding',
    );
  }

  metadata.daemonId = input.daemonId;
  if (input.runtimeInstallationId) {
    metadata.runtimeInstallationId = input.runtimeInstallationId;
    metadata.runtimeInstalledAt =
      input.runtimeInstalledAt instanceof Date
        ? input.runtimeInstalledAt.toISOString()
        : (input.runtimeInstalledAt ?? new Date().toISOString());
  }

  await prisma.iMAgentCard.update({
    where: { imUserId: card.imUserId },
    data: { metadata: JSON.stringify(metadata) },
  });
  return true;
}
