/**
 * Prismer IM — Mention Service
 *
 * Parses @mentions in messages and resolves them to participants.
 * Supports:
 * - @username format
 * - @"Display Name" format (with quotes for names with spaces)
 */

import prisma from '../db';

export interface AgentMention {
  /** Raw mention text including @ symbol */
  raw: string;
  /** Extracted username or display name */
  username: string;
  /** Resolved user ID (if found) */
  userId?: string;
  /** User's display name (if found) */
  displayName?: string;
  /** Whether this is an agent */
  isAgent?: boolean;
  /** Start index in original text */
  startIndex: number;
  /** End index in original text */
  endIndex: number;
}

export interface MentionParseResult {
  /** List of parsed mentions */
  mentions: AgentMention[];
  /** Text with @mentions removed */
  cleanText: string;
  /** Whether any mentions were found */
  hasMentions: boolean;
  /** Mentions that were resolved to agents */
  resolvedAgents: AgentMention[];
  /** Mentions that were resolved to humans */
  resolvedHumans: AgentMention[];
  /** Mentions that could not be resolved */
  unresolvedMentions: AgentMention[];
}

export interface RouteTarget {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  agentType?: string;
}

export type RoutingMode = 'explicit' | 'capability' | 'broadcast' | 'none';

export interface RoutingDecision {
  mode: RoutingMode;
  targets: RouteTarget[];
  cleanText: string;
  originalMentions: AgentMention[];
}

export class MentionService {
  /**
   * Regex to match @mentions:
   * - @username (alphanumeric, underscore, hyphen)
   * - @"Display Name" (quoted string)
   * - @'Display Name' (single-quoted string)
   */
  private readonly mentionRegex = /@([a-zA-Z0-9_-]+|"[^"]+"|'[^']+')/g;

  /**
   * Parse @mentions from message content.
   */
  parseMentions(content: string): AgentMention[] {
    const mentions: AgentMention[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    this.mentionRegex.lastIndex = 0;

    while ((match = this.mentionRegex.exec(content)) !== null) {
      const raw = match[0];
      // Remove quotes if present
      const username = match[1].replace(/^["']|["']$/g, '');

      mentions.push({
        raw,
        username,
        startIndex: match.index,
        endIndex: match.index + raw.length,
      });
    }

    return mentions;
  }

  /**
   * Remove @mentions from content, returning clean text.
   */
  getCleanText(content: string): string {
    return content.replace(this.mentionRegex, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Resolve mentions to conversation participants.
   */
  async resolveMentions(
    mentions: AgentMention[],
    conversationId: string
  ): Promise<AgentMention[]> {
    if (mentions.length === 0) {
      return [];
    }

    // Get all participants in the conversation
    const participants = await prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null, // Only active participants
      },
      include: {
        imUser: true,
      },
    });

    // Create lookup maps
    const byUsername = new Map<string, typeof participants[0]>();
    const byDisplayName = new Map<string, typeof participants[0]>();

    for (const p of participants) {
      byUsername.set(p.imUser.username.toLowerCase(), p);
      byDisplayName.set(p.imUser.displayName.toLowerCase(), p);
    }

    // Resolve each mention
    return mentions.map(mention => {
      const lowerUsername = mention.username.toLowerCase();

      // Try to find by username first, then display name
      const participant = byUsername.get(lowerUsername) || byDisplayName.get(lowerUsername);

      if (participant) {
        return {
          ...mention,
          userId: participant.imUser.id,
          displayName: participant.imUser.displayName,
          isAgent: participant.imUser.role === 'agent',
        };
      }

      return mention;
    });
  }

  /**
   * Full parse and resolve workflow.
   */
  async parseAndResolve(
    content: string,
    conversationId: string
  ): Promise<MentionParseResult> {
    // 1. Parse mentions
    const mentions = this.parseMentions(content);

    // 2. Get clean text
    const cleanText = this.getCleanText(content);

    // 3. Resolve mentions
    const resolvedMentions = await this.resolveMentions(mentions, conversationId);

    // 4. Categorize
    const resolvedAgents = resolvedMentions.filter(m => m.userId && m.isAgent);
    const resolvedHumans = resolvedMentions.filter(m => m.userId && !m.isAgent);
    const unresolvedMentions = resolvedMentions.filter(m => !m.userId);

    return {
      mentions: resolvedMentions,
      cleanText,
      hasMentions: mentions.length > 0,
      resolvedAgents,
      resolvedHumans,
      unresolvedMentions,
    };
  }

  /**
   * Determine routing decision based on message content.
   */
  async determineRouting(
    content: string,
    conversationId: string,
    senderId: string
  ): Promise<RoutingDecision> {
    // 1. Parse and resolve mentions
    const result = await this.parseAndResolve(content, conversationId);

    // 2. Get sender info
    const sender = await prisma.iMUser.findUnique({
      where: { id: senderId },
    });

    // If sender is an agent, don't route to other agents (prevent loops)
    if (sender?.role === 'agent') {
      return {
        mode: 'none',
        targets: [],
        cleanText: result.cleanText,
        originalMentions: result.mentions,
      };
    }

    // 3. Determine routing mode
    if (result.resolvedAgents.length > 0) {
      // Explicit mode: route to mentioned agents
      const targets = await this.getRouteTargets(
        result.resolvedAgents.map(m => m.userId!)
      );

      return {
        mode: 'explicit',
        targets,
        cleanText: result.cleanText,
        originalMentions: result.mentions,
      };
    }

    // 4. Check if message looks like a question/command
    if (this.looksLikeQuestion(content)) {
      // Capability mode: will be handled by capability router (P2)
      // For now, broadcast to all agents
      const allAgents = await this.getConversationAgents(conversationId);

      return {
        mode: 'capability',
        targets: allAgents,
        cleanText: result.cleanText,
        originalMentions: result.mentions,
      };
    }

    // 5. Broadcast mode (or none for simple chat)
    return {
      mode: 'broadcast',
      targets: [], // No specific targets, broadcast to all
      cleanText: result.cleanText,
      originalMentions: result.mentions,
    };
  }

  /**
   * Check if message looks like a question or command.
   */
  private looksLikeQuestion(content: string): boolean {
    const questionIndicators = [
      /\?$/,                    // Ends with ?
      /^(what|who|when|where|why|how|can|could|would|should|is|are|do|does)/i,
      /帮我|请|搜索|查找|分析|生成|执行|运行|编译/,
      /help|search|find|analyze|generate|execute|run|compile/i,
    ];

    return questionIndicators.some(re => re.test(content.trim()));
  }

  /**
   * Get route targets by user IDs.
   */
  private async getRouteTargets(userIds: string[]): Promise<RouteTarget[]> {
    const users = await prisma.iMUser.findMany({
      where: { id: { in: userIds } },
    });

    return users.map((u: typeof users[number]) => ({
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      agentType: u.agentType ?? undefined,
    }));
  }

  /**
   * Get all agents in a conversation.
   */
  private async getConversationAgents(conversationId: string): Promise<RouteTarget[]> {
    const participants = await prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null,
        imUser: { role: 'agent' },
      },
      include: {
        imUser: true,
      },
    });

    return participants.map((p: typeof participants[number]) => ({
      userId: p.imUser.id,
      username: p.imUser.username,
      displayName: p.imUser.displayName,
      role: p.imUser.role,
      agentType: p.imUser.agentType ?? undefined,
    }));
  }

  /**
   * Format mention for display (e.g., for UI).
   */
  formatMention(username: string): string {
    // If username contains spaces, wrap in quotes
    if (/\s/.test(username)) {
      return `@"${username}"`;
    }
    return `@${username}`;
  }

  /**
   * Get autocomplete suggestions for @mentions.
   */
  async getAutocompleteSuggestions(
    conversationId: string,
    query: string,
    limit = 5
  ): Promise<RouteTarget[]> {
    const participants = await prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null,
        OR: [
          { imUser: { username: { contains: query } } },
          { imUser: { displayName: { contains: query } } },
        ],
      },
      include: {
        imUser: true,
      },
      take: limit,
    });

    return participants.map((p: typeof participants[number]) => ({
      userId: p.imUser.id,
      username: p.imUser.username,
      displayName: p.imUser.displayName,
      role: p.imUser.role,
      agentType: p.imUser.agentType ?? undefined,
    }));
  }
}
