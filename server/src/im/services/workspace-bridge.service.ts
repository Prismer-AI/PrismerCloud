/**
 * Prismer IM — Workspace Bridge Service
 *
 * Bridges the IM system with workspace concepts.
 * Supports:
 * - Workspace ↔ IMConversation binding
 * - Agent token generation for container agents
 * - Multi-agent workspace setup
 */

import prisma from '../db';
import { ConversationService } from './conversation.service';
import { signToken } from '../auth/jwt';
import type Redis from 'ioredis';
import type { AgentType } from '../types/index';
import { generateAgentId, generateUserId } from '../utils/id-gen';

export interface WorkspaceIMBindingInput {
  workspaceId: string;
  imUserId: string; // IM User ID (already created)
  agentImUserId?: string; // Optional agent IM User ID
}

export interface CreateAgentForWorkspaceInput {
  workspaceId: string;
  agentName: string;
  agentDisplayName: string;
  agentType?: AgentType;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentTokenResult {
  token: string;
  agentUserId: string;
  conversationId: string;
  expiresIn: string;
}

export class WorkspaceBridgeService {
  private conversationService: ConversationService;

  constructor(redis: Redis) {
    this.conversationService = new ConversationService(redis);
  }

  /**
   * Force-delete an existing workspace: conversation, participants, messages, read cursors.
   * Used when `force: true` is passed to init endpoints during testing.
   */
  async destroyWorkspace(workspaceId: string): Promise<boolean> {
    const existing = await prisma.iMConversation.findUnique({
      where: { workspaceId },
      include: { participants: true },
    });
    if (!existing) return false;

    const convId = existing.id;
    console.log(`[WorkspaceBridge] Force-destroying workspace ${workspaceId} (conversation ${convId})`);

    // Delete in dependency order
    await prisma.iMReadCursor.deleteMany({ where: { conversationId: convId } });
    await prisma.iMMessage.deleteMany({ where: { conversationId: convId } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: convId } });
    await prisma.iMConversation.delete({ where: { id: convId } });

    return true;
  }

  /**
   * Get or create an IM conversation for a workspace.
   */
  async getOrCreateWorkspaceConversation(input: WorkspaceIMBindingInput & { force?: boolean }) {
    const { workspaceId, imUserId, agentImUserId, force } = input;

    // 1. Check if workspace already has a conversation
    const existing = await prisma.iMConversation.findUnique({
      where: { workspaceId },
      include: {
        participants: { include: { imUser: true } },
      },
    });

    if (existing) {
      if (force) {
        // Force mode: destroy existing and recreate
        await this.destroyWorkspace(workspaceId);
      } else {
        return existing;
      }
    }

    // 2. Verify IMUser exists
    const imUser = await prisma.iMUser.findUnique({
      where: { id: imUserId },
    });

    if (!imUser) {
      throw new Error('IMUser not found');
    }

    // 3. Create the conversation
    const conversation = await prisma.iMConversation.create({
      data: {
        type: agentImUserId ? 'direct' : 'channel',
        title: `Workspace Chat`,
        createdById: imUser.id,
        workspaceId,
        metadata: JSON.stringify({
          workspaceId,
        }),
      },
    });

    // 4. Add participants
    await prisma.iMParticipant.create({
      data: {
        conversationId: conversation.id,
        imUserId: imUser.id,
        role: 'owner',
      },
    });

    if (agentImUserId) {
      await prisma.iMParticipant.create({
        data: {
          conversationId: conversation.id,
          imUserId: agentImUserId,
          role: 'member',
        },
      });
    }

    return prisma.iMConversation.findUnique({
      where: { id: conversation.id },
      include: {
        participants: { include: { imUser: true } },
      },
    });
  }

  /**
   * Get the IM conversation for a workspace.
   */
  async getWorkspaceConversation(workspaceId: string) {
    return prisma.iMConversation.findUnique({
      where: { workspaceId },
      include: {
        participants: { include: { imUser: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
  }

  /**
   * Get the IMUser by ID.
   */
  async getIMUser(id: string) {
    return prisma.iMUser.findUnique({
      where: { id },
    });
  }

  /**
   * Get recent messages for a workspace.
   */
  async getWorkspaceMessages(workspaceId: string, limit = 50) {
    const conversation = await prisma.iMConversation.findUnique({
      where: { workspaceId },
    });

    if (!conversation) {
      return [];
    }

    return prisma.iMMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sender: true,
      },
    });
  }

  /**
   * Add participant to workspace conversation.
   */
  async addParticipantToWorkspace(workspaceId: string, imUserId: string) {
    const conversation = await prisma.iMConversation.findUnique({
      where: { workspaceId },
    });

    if (!conversation) {
      throw new Error('Workspace conversation not found');
    }

    // Add as participant
    return prisma.iMParticipant.upsert({
      where: {
        conversationId_imUserId: {
          conversationId: conversation.id,
          imUserId: imUserId,
        },
      },
      update: { leftAt: null },
      create: {
        conversationId: conversation.id,
        imUserId: imUserId,
        role: 'member',
      },
    });
  }

  /**
   * Create an agent user and add to workspace, returning JWT token.
   * This is used for container agents that need to connect via Channel Plugin.
   */
  async createAgentForWorkspace(input: CreateAgentForWorkspaceInput): Promise<AgentTokenResult> {
    const { workspaceId, agentName, agentDisplayName, agentType, capabilities, metadata } = input;

    // 1. Get workspace conversation
    const conversation = await prisma.iMConversation.findUnique({
      where: { workspaceId },
    });

    if (!conversation) {
      throw new Error('Workspace conversation not found. Create workspace first.');
    }

    // 2. Check if agent already exists
    let agentUser = await prisma.iMUser.findUnique({
      where: { username: agentName },
    });

    if (!agentUser) {
      // 3. Create agent IMUser
      agentUser = await prisma.iMUser.create({
        data: {
          id: generateAgentId(),
          username: agentName,
          displayName: agentDisplayName,
          role: 'agent',
          agentType: agentType ?? 'assistant',
          metadata: JSON.stringify(metadata ?? {}),
        },
      });
    }

    // 4. Add agent as participant (if not already)
    await prisma.iMParticipant.upsert({
      where: {
        conversationId_imUserId: {
          conversationId: conversation.id,
          imUserId: agentUser.id,
        },
      },
      update: { leftAt: null },
      create: {
        conversationId: conversation.id,
        imUserId: agentUser.id,
        role: 'member',
      },
    });

    // 5. Create or update agent card with capabilities
    await prisma.iMAgentCard.upsert({
      where: { imUserId: agentUser.id },
      update: {
        capabilities: JSON.stringify(capabilities ?? []),
        metadata: JSON.stringify(metadata ?? {}),
      },
      create: {
        imUserId: agentUser.id,
        name: agentDisplayName,
        description: `Agent for workspace ${workspaceId}`,
        agentType: agentType ?? 'assistant',
        capabilities: JSON.stringify(capabilities ?? []),
        metadata: JSON.stringify(metadata ?? {}),
      },
    });

    // 6. Generate JWT token for agent
    const token = signToken({
      sub: agentUser.id,
      username: agentUser.username,
      role: 'agent',
      agentType: (agentUser.agentType ?? 'assistant') as AgentType,
    });

    return {
      token,
      agentUserId: agentUser.id,
      conversationId: conversation.id,
      expiresIn: '7d',
    };
  }

  /**
   * Generate a new token for an existing agent.
   */
  async generateAgentToken(agentUserId: string): Promise<string> {
    const agent = await prisma.iMUser.findUnique({
      where: { id: agentUserId },
    });

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.role !== 'agent') {
      throw new Error('User is not an agent');
    }

    return signToken({
      sub: agent.id,
      username: agent.username,
      role: 'agent',
      agentType: (agent.agentType ?? 'assistant') as AgentType,
    });
  }

  /**
   * Initialize a workspace with user and optionally an agent.
   * Returns all necessary info for frontend and container.
   */
  async initializeWorkspace(input: {
    workspaceId: string;
    userId: string;
    userDisplayName: string;
    agentName?: string;
    agentDisplayName?: string;
    agentType?: AgentType;
    agentCapabilities?: string[];
    force?: boolean;
  }) {
    const { workspaceId, userId, userDisplayName, agentName, agentDisplayName, agentType, agentCapabilities, force } =
      input;

    // 1. Get or create user IMUser (userId is not unique — use findFirst)
    let userImUser = await prisma.iMUser.findFirst({
      where: { userId },
    });

    if (!userImUser) {
      userImUser = await prisma.iMUser.create({
        data: {
          id: generateUserId(),
          username: `user_${userId}`,
          displayName: userDisplayName,
          role: 'human',
          userId,
        },
      });
    }

    // 2. Get or create workspace conversation (force=true destroys existing first)
    const conversation = await this.getOrCreateWorkspaceConversation({
      workspaceId,
      imUserId: userImUser.id,
      force,
    });

    // 3. Create agent if specified
    let agentResult: AgentTokenResult | null = null;
    if (agentName) {
      agentResult = await this.createAgentForWorkspace({
        workspaceId,
        agentName,
        agentDisplayName: agentDisplayName ?? agentName,
        agentType,
        capabilities: agentCapabilities,
      });
    }

    // 4. Generate user token
    const userToken = signToken({
      sub: userImUser.id,
      username: userImUser.username,
      role: 'human',
    });

    return {
      conversationId: conversation!.id,
      user: {
        imUserId: userImUser.id,
        token: userToken,
      },
      agent: agentResult,
    };
  }

  /**
   * Initialize a GROUP workspace with multiple users and agents.
   * Returns all tokens for frontend/agents to connect.
   */
  async initializeGroupWorkspace(input: {
    workspaceId: string;
    title: string;
    description?: string;
    force?: boolean;
    users: Array<{
      userId: string;
      displayName: string;
    }>;
    agents: Array<{
      name: string;
      displayName: string;
      type?: AgentType;
      capabilities?: string[];
    }>;
  }) {
    const { workspaceId, title, description, force, users, agents } = input;

    if (users.length === 0) {
      throw new Error('At least one user is required');
    }

    // 1. Check if workspace already has a conversation
    const existingConv = await prisma.iMConversation.findUnique({
      where: { workspaceId },
    });
    if (existingConv) {
      if (force) {
        await this.destroyWorkspace(workspaceId);
      } else {
        throw new Error(
          `Workspace ${workspaceId} already has a conversation. Use addParticipant to add more members, or pass force:true to recreate.`,
        );
      }
    }

    // 2. Create or get all user IMUsers
    const userResults: Array<{
      userId: string;
      imUserId: string;
      username: string;
      displayName: string;
      token: string;
    }> = [];

    for (const user of users) {
      let imUser = await prisma.iMUser.findFirst({
        where: { userId: user.userId },
      });

      if (!imUser) {
        imUser = await prisma.iMUser.create({
          data: {
            id: generateUserId(),
            username: `user_${user.userId}`,
            displayName: user.displayName,
            role: 'human',
            userId: user.userId,
          },
        });
      }

      const token = signToken({
        sub: imUser.id,
        username: imUser.username,
        role: 'human',
      });

      userResults.push({
        userId: user.userId,
        imUserId: imUser.id,
        username: imUser.username,
        displayName: imUser.displayName,
        token,
      });
    }

    // 3. Create GROUP conversation
    const conversation = await prisma.iMConversation.create({
      data: {
        type: 'group',
        title,
        description,
        createdById: userResults[0].imUserId,
        workspaceId,
        metadata: JSON.stringify({
          workspaceId,
          createdAt: new Date().toISOString(),
        }),
      },
    });

    // 4. Add all users as participants
    for (let i = 0; i < userResults.length; i++) {
      await prisma.iMParticipant.create({
        data: {
          conversationId: conversation.id,
          imUserId: userResults[i].imUserId,
          role: i === 0 ? 'owner' : 'member',
        },
      });
    }

    // 5. Create all agents and add as participants
    const agentResults: Array<{
      name: string;
      imUserId: string;
      username: string;
      displayName: string;
      type: string;
      capabilities: string[];
      token: string;
    }> = [];

    for (const agent of agents) {
      // Create or get agent IMUser
      let agentUser = await prisma.iMUser.findUnique({
        where: { username: agent.name },
      });

      if (!agentUser) {
        agentUser = await prisma.iMUser.create({
          data: {
            id: generateAgentId(),
            username: agent.name,
            displayName: agent.displayName,
            role: 'agent',
            agentType: agent.type ?? 'assistant',
            metadata: JSON.stringify({}),
          },
        });
      }

      // Add as participant
      await prisma.iMParticipant.create({
        data: {
          conversationId: conversation.id,
          imUserId: agentUser.id,
          role: 'member',
        },
      });

      // Create or update agent card
      await prisma.iMAgentCard.upsert({
        where: { imUserId: agentUser.id },
        update: {
          capabilities: JSON.stringify(agent.capabilities ?? []),
        },
        create: {
          imUserId: agentUser.id,
          name: agent.displayName,
          description: `Agent for workspace ${workspaceId}`,
          agentType: agent.type ?? 'assistant',
          capabilities: JSON.stringify(agent.capabilities ?? []),
          metadata: JSON.stringify({}),
        },
      });

      // Generate token
      const token = signToken({
        sub: agentUser.id,
        username: agentUser.username,
        role: 'agent',
        agentType: (agentUser.agentType ?? 'assistant') as AgentType,
      });

      agentResults.push({
        name: agent.name,
        imUserId: agentUser.id,
        username: agentUser.username,
        displayName: agentUser.displayName,
        type: agentUser.agentType ?? 'assistant',
        capabilities: agent.capabilities ?? [],
        token,
      });
    }

    return {
      conversationId: conversation.id,
      conversationType: 'group',
      title,
      description,
      users: userResults,
      agents: agentResults,
    };
  }

  /**
   * List all agents in a workspace conversation.
   */
  async listWorkspaceAgents(workspaceId: string) {
    const conversation = await prisma.iMConversation.findUnique({
      where: { workspaceId },
      include: {
        participants: {
          include: {
            imUser: {
              include: {
                agentCard: true,
              },
            },
          },
        },
      },
    });

    if (!conversation) {
      return [];
    }

    type Participant = NonNullable<typeof conversation>['participants'][number];
    return conversation.participants
      .filter((p: Participant) => p.imUser.role === 'agent')
      .map((p: Participant) => ({
        userId: p.imUser.id,
        username: p.imUser.username,
        displayName: p.imUser.displayName,
        agentType: p.imUser.agentType,
        capabilities: p.imUser.agentCard?.capabilities ? JSON.parse(p.imUser.agentCard.capabilities) : [],
        status: p.imUser.agentCard?.status ?? 'offline',
      }));
  }
}
