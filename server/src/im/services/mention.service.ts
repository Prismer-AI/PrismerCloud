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
  async resolveMentions(mentions: AgentMention[], conversationId: string): Promise<AgentMention[]> {
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
    const byUsername = new Map<string, (typeof participants)[0]>();
    const byDisplayName = new Map<string, (typeof participants)[0]>();

    for (const p of participants) {
      byUsername.set(p.imUser.username.toLowerCase(), p);
      byDisplayName.set(p.imUser.displayName.toLowerCase(), p);
    }

    // Resolve each mention
    const resolved: AgentMention[] = [];
    for (const mention of mentions) {
      const lowerUsername = mention.username.toLowerCase();

      // Try to find by username first, then display name
      const participant = byUsername.get(lowerUsername) || byDisplayName.get(lowerUsername);

      if (participant) {
        resolved.push({
          ...mention,
          userId: participant.imUser.id,
          displayName: participant.imUser.displayName,
          isAgent: participant.imUser.role === 'agent',
        });
        continue;
      }

      // Exact match miss — try Levenshtein-1 fuzzy resolution against
      // active conversation participants. Handles LLM typos like
      // `@custom-role-r6y` → `@custom-role-rd6y`.
      const fuzzy = await this.fuzzyResolveAgainstParticipants(mention.username, conversationId);
      if (fuzzy) {
        // Need the role for isAgent classification — pick from the
        // participant we already loaded.
        const p = byUsername.get(fuzzy.username.toLowerCase());
        resolved.push({
          ...mention,
          userId: fuzzy.userId,
          displayName: fuzzy.displayName,
          isAgent: p?.imUser.role === 'agent',
        });
        continue;
      }

      resolved.push(mention);
    }
    return resolved;
  }

  /**
   * Compute Levenshtein distance between two strings.
   * Inputs are clamped to 50 chars per side as a defensive cap — no
   * legitimate agent username is longer than that, and unbounded input
   * would let a single malformed mention burn O(N*M) CPU.
   */
  private levenshtein(a: string, b: string): number {
    const s = a.length > 50 ? a.slice(0, 50) : a;
    const t = b.length > 50 ? b.slice(0, 50) : b;
    const m = s.length;
    const n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;
    // Two-row DP — we only need the previous row.
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          curr[j - 1] + 1, // insertion
          prev[j] + 1, // deletion
          prev[j - 1] + cost, // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  /**
   * Fuzzy-resolve an @-mention token to a conversation participant
   * within Levenshtein distance 1. Returns the unique match, or null
   * if zero / ambiguous (≥2 ties).
   *
   * Scoped strictly to the conversation roster — we never fuzzy-match
   * against the global user table, since that would route typos to
   * unrelated agents elsewhere on the platform.
   */
  private async fuzzyResolveAgainstParticipants(
    token: string,
    conversationId: string,
  ): Promise<{ userId: string; username: string; displayName: string } | null> {
    const participants = await prisma.iMParticipant.findMany({
      where: { conversationId, leftAt: null },
      include: { imUser: { select: { id: true, username: true, displayName: true } } },
    });
    type Part = (typeof participants)[number];
    const candidates = participants.map((p: Part) => p.imUser).filter((u: Part['imUser']) => !!u);

    const lowerToken = token.toLowerCase();
    const matches = candidates.filter(
      (u: Part['imUser']) => this.levenshtein(u!.username.toLowerCase(), lowerToken) <= 1,
    );

    if (matches.length === 1) {
      const m = matches[0]!;
      console.log(`[mention] fuzzy-resolved @${token} → @${m.username} (dist=1) in conv ${conversationId}`);
      return { userId: m.id, username: m.username, displayName: m.displayName };
    }

    if (matches.length >= 2) {
      console.warn(
        `[mention] fuzzy-ambiguous @${token} in conv ${conversationId}: ${matches.length} candidates (${matches.map((m: Part['imUser']) => m!.username).join(', ')}) — dropping`,
      );
    }
    return null;
  }

  /**
   * Filter self-mentions from a resolved list. LLM agents occasionally
   * hallucinate `@<their-own-name>` in replies; without dropping these,
   * a hopCount-bounded multi-agent system still wastes hops on no-op
   * self-dispatches. Logs a single line per drop so the owner can spot
   * repeat offenders.
   */
  private dropSelfMentions(mentions: AgentMention[], senderId: string): AgentMention[] {
    return mentions.filter((m) => {
      if (m.userId && m.userId === senderId) {
        console.log(`[mention] dropped self-mention from agent ${senderId}`);
        return false;
      }
      return true;
    });
  }

  /**
   * Full parse and resolve workflow.
   *
   * When `senderId` is provided, self-mentions (where the resolved
   * userId equals the sender) are dropped — see [dropSelfMentions].
   */
  async parseAndResolve(content: string, conversationId: string, senderId?: string): Promise<MentionParseResult> {
    // 1. Parse mentions
    const mentions = this.parseMentions(content);

    // 2. Get clean text
    const cleanText = this.getCleanText(content);

    // 3. Resolve mentions
    let resolvedMentions = await this.resolveMentions(mentions, conversationId);

    // 3b. Filter self-mentions (LLM hallucination guard)
    if (senderId) {
      resolvedMentions = this.dropSelfMentions(resolvedMentions, senderId);
    }

    // 4. Categorize
    const resolvedAgents = resolvedMentions.filter((m) => m.userId && m.isAgent);
    const resolvedHumans = resolvedMentions.filter((m) => m.userId && !m.isAgent);
    const unresolvedMentions = resolvedMentions.filter((m) => !m.userId);

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
   *
   * Agent senders are now allowed to @-mention other agents — bounding
   * against runaway loops is enforced via a hopCount cap in
   * MessageService (`MAX_AGENT_HOPS`). The role-based hard-block that
   * used to live here is gone. Self-mentions are filtered at the
   * resolve step (see [parseAndResolve]).
   *
   * When `metadata` carries a structured `mentions` array (produced by
   * an SDK / MCP tool that already knows the target userIds), that is
   * treated as the source of truth and the regex parse is skipped.
   * This avoids LLM agents hallucinating @usernames in the content
   * text — they stamp the structured payload instead and we trust it.
   * Falls through to the regex path when metadata.mentions is absent
   * or empty.
   */
  async determineRouting(
    content: string,
    conversationId: string,
    senderId: string,
    metadata?: unknown,
  ): Promise<RoutingDecision> {
    // 0. Structured-mention override: if the caller stamped a
    //    metadata.mentions array, honor it as authoritative and skip
    //    the regex parse entirely.
    const explicitMentions = readStructuredMentions(metadata);
    if (explicitMentions && explicitMentions.length > 0) {
      const filtered = senderId ? this.dropSelfMentions(explicitMentions, senderId) : explicitMentions;
      if (filtered.length === 0) {
        return {
          mode: 'none',
          targets: [],
          cleanText: content,
          originalMentions: [],
        };
      }
      const targets = await this.getRouteTargets(filtered.map((m) => m.userId!));
      return {
        mode: 'explicit',
        targets,
        // No regex strip — content is authoritative as-is. The agent
        // already produced the text it wants delivered.
        cleanText: content,
        originalMentions: filtered,
      };
    }

    // 1. Parse and resolve mentions (with self-mention filter)
    const result = await this.parseAndResolve(content, conversationId, senderId);

    // 2. Determine routing mode
    if (result.resolvedAgents.length > 0) {
      // Explicit mode: route to mentioned agents
      const targets = await this.getRouteTargets(result.resolvedAgents.map((m) => m.userId!));

      return {
        mode: 'explicit',
        targets,
        cleanText: result.cleanText,
        originalMentions: result.mentions,
      };
    }

    // 3. Check if message looks like a question/command
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

    // 4. Broadcast mode (or none for simple chat)
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
      /\?$/, // Ends with ?
      /^(what|who|when|where|why|how|can|could|would|should|is|are|do|does)/i,
      /帮我|请|搜索|查找|分析|生成|执行|运行|编译/,
      /help|search|find|analyze|generate|execute|run|compile/i,
    ];

    return questionIndicators.some((re) => re.test(content.trim()));
  }

  /**
   * Get route targets by user IDs.
   */
  private async getRouteTargets(userIds: string[]): Promise<RouteTarget[]> {
    const users = await prisma.iMUser.findMany({
      where: { id: { in: userIds } },
    });

    return users.map((u: (typeof users)[number]) => ({
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

    return participants.map((p: (typeof participants)[number]) => ({
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
  async getAutocompleteSuggestions(conversationId: string, query: string, limit = 5): Promise<RouteTarget[]> {
    const participants = await prisma.iMParticipant.findMany({
      where: {
        conversationId,
        leftAt: null,
        OR: [{ imUser: { username: { contains: query } } }, { imUser: { displayName: { contains: query } } }],
      },
      include: {
        imUser: true,
      },
      take: limit,
    });

    return participants.map((p: (typeof participants)[number]) => ({
      userId: p.imUser.id,
      username: p.imUser.username,
      displayName: p.imUser.displayName,
      role: p.imUser.role,
      agentType: p.imUser.agentType ?? undefined,
    }));
  }
}

/**
 * Extract a structured mentions array from message metadata.
 *
 * Wire shape (produced by SDK / MCP tools that already resolved the
 * usernames against the conversation roster):
 *   { mentions: [{raw, userId, username}, ...] }
 *
 * Tolerates two transit shapes for `metadata`:
 *  - object (as it lives in JS at the service layer)
 *  - stringified JSON (as it sometimes arrives from messageModel.list /
 *    Prisma TEXT column readback)
 *
 * Returns null when metadata is missing / malformed / has no mentions
 * — caller treats that as "fall through to regex parse".
 *
 * Each returned mention is reshaped to the `AgentMention` contract
 * `dropSelfMentions` expects: it requires `userId` and `username`, with
 * synthetic `startIndex`/`endIndex` since the structured path has no
 * regex match to anchor against.
 */
function readStructuredMentions(metadata: unknown): AgentMention[] | null {
  if (metadata == null) return null;

  let obj: Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    obj = metadata as Record<string, unknown>;
  } else {
    return null;
  }

  const raw = obj.mentions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: AgentMention[] = [];
  for (const m of raw) {
    if (
      m &&
      typeof m === 'object' &&
      typeof (m as any).userId === 'string' &&
      typeof (m as any).username === 'string' &&
      (m as any).userId.length > 0 &&
      (m as any).username.length > 0
    ) {
      const mm = m as { raw?: unknown; userId: string; username: string };
      out.push({
        raw: typeof mm.raw === 'string' ? mm.raw : `@${mm.username}`,
        username: mm.username,
        userId: mm.userId,
        // No anchor in source text — caller doesn't use these on the
        // structured path, but the AgentMention contract requires them.
        startIndex: -1,
        endIndex: -1,
      });
    }
  }
  return out.length > 0 ? out : null;
}
