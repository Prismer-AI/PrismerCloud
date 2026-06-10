import prisma from '../db';

export type ConversationViewerAccess = {
  source: 'participant' | 'workspace' | 'none';
  role: string;
  canObserve: boolean;
  canManage: boolean;
  canRename: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canLeave: boolean;
  canPin: boolean;
  canMute: boolean;
  canRead: boolean;
  canAddMember: boolean;
  canRemoveMember: boolean;
  canSendMessage: boolean;
};

type ConversationWithParticipants = {
  workspaceId?: string | null;
  participants?: Array<{ leftAt: Date | null; imUser: { role: string } }>;
};

type ViewerParticipant = {
  role: string;
  leftAt: Date | null;
};

export const NO_CONVERSATION_ACCESS: ConversationViewerAccess = {
  source: 'none',
  role: 'none',
  canObserve: false,
  canManage: false,
  canRename: false,
  canArchive: false,
  canDelete: false,
  canLeave: false,
  canPin: false,
  canMute: false,
  canRead: false,
  canAddMember: false,
  canRemoveMember: false,
  canSendMessage: false,
};

export async function hasWorkspaceConversationAccess(
  workspaceId: string,
  actorImUserId: string,
  roles: string[] = ['owner', 'admin'],
): Promise<boolean> {
  const workspace = await prisma.iMWorkspace.findFirst({
    where: {
      id: workspaceId,
      deletedAt: null,
      OR: [
        { ownerImUserId: actorImUserId },
        { members: { some: { memberImUserId: actorImUserId, role: { in: roles } } } },
      ],
    },
    select: { id: true },
  });
  return Boolean(workspace);
}

export function isAgentOnlyConversation(conversation: ConversationWithParticipants): boolean {
  const participants = conversation.participants?.filter((p) => !p.leftAt) ?? [];
  return participants.length > 0 && participants.every((p) => p.imUser.role === 'agent');
}

export async function canObserveWorkspaceConversation(conversationId: string, actorImUserId: string): Promise<boolean> {
  const access = await resolveConversationViewerAccess(conversationId, actorImUserId);
  return access.canObserve;
}

export async function canManageObservedWorkspaceConversation(
  conversationId: string,
  actorImUserId: string,
): Promise<boolean> {
  const access = await resolveConversationViewerAccess(conversationId, actorImUserId);
  return access.canManage;
}

export function buildConversationViewerAccess(input: {
  participant?: ViewerParticipant | null;
  workspaceCanObserve?: boolean;
  workspaceCanManage?: boolean;
}): ConversationViewerAccess {
  const activeParticipant = input.participant && !input.participant.leftAt ? input.participant : null;
  const participantCanManage = activeParticipant ? ['owner', 'admin'].includes(activeParticipant.role) : false;
  const workspaceCanObserve = Boolean(input.workspaceCanObserve);
  const workspaceCanManage = Boolean(input.workspaceCanManage);
  const canObserve = Boolean(activeParticipant) || workspaceCanObserve;
  const canManage = participantCanManage || workspaceCanManage;
  const canSendMessage = Boolean(activeParticipant);
  const canLeave = Boolean(activeParticipant) && !workspaceCanManage;
  const canDelete = workspaceCanManage || participantCanManage;

  if (!canObserve) return NO_CONVERSATION_ACCESS;

  return {
    source: activeParticipant ? 'participant' : 'workspace',
    role: activeParticipant?.role ?? 'observer',
    canObserve,
    canManage,
    canRename: canManage,
    canArchive: canManage,
    canDelete,
    canLeave,
    canPin: Boolean(activeParticipant),
    canMute: Boolean(activeParticipant),
    canRead: canObserve,
    canAddMember: canManage,
    canRemoveMember: canManage,
    canSendMessage,
  };
}

export async function resolveConversationViewerAccess(
  conversationId: string,
  actorImUserId: string,
): Promise<ConversationViewerAccess> {
  const conversation = await prisma.iMConversation.findUnique({
    where: { id: conversationId },
    select: {
      workspaceId: true,
      participants: {
        where: { imUserId: actorImUserId },
        select: { role: true, leftAt: true },
      },
    },
  });
  if (!conversation) return NO_CONVERSATION_ACCESS;

  const participant = conversation.participants[0] ?? null;
  const [workspaceCanObserve, workspaceCanManage] = conversation.workspaceId
    ? await Promise.all([
        hasWorkspaceConversationAccess(conversation.workspaceId, actorImUserId),
        hasWorkspaceConversationAccess(conversation.workspaceId, actorImUserId, ['owner']),
      ])
    : [false, false];

  return buildConversationViewerAccess({
    participant,
    workspaceCanObserve,
    workspaceCanManage,
  });
}
