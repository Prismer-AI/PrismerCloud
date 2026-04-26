/**
 * Prismer IM — Context Access Control Service
 *
 * E2E Layer 3: Validates that senders have access to context URIs
 * referenced in their messages, and enforces conversation-level policies.
 */

import prisma from '../db';

// ─── Types ──────────────────────────────────────────────────

export interface ContextRef {
  uri: string;
  type: 'prismer' | 'url' | 'file' | 'unknown';
}

export interface AccessCheckResult {
  allowed: boolean;
  deniedRefs: ContextRef[];
  reason?: string;
}

// ─── Context Ref Extraction ─────────────────────────────────

const PRISMER_URI_RE = /prismer:\/\/ctx\/[a-zA-Z0-9_-]+/g;

/**
 * Extract context references from message content and metadata.
 */
export function extractContextRefs(content: string, metadata?: Record<string, any>): ContextRef[] {
  const refs: ContextRef[] = [];
  const seen = new Set<string>();

  const prismerMatches = content.match(PRISMER_URI_RE) || [];
  for (const uri of prismerMatches) {
    if (!seen.has(uri)) {
      refs.push({ uri, type: 'prismer' });
      seen.add(uri);
    }
  }

  const metadataRefs = metadata?.contextRefs as string[] | undefined;
  if (metadataRefs && Array.isArray(metadataRefs)) {
    for (const uri of metadataRefs) {
      if (!seen.has(uri)) {
        const type = uri.startsWith('prismer://')
          ? 'prismer'
          : uri.startsWith('http')
            ? 'url'
            : uri.startsWith('file:')
              ? 'file'
              : 'unknown';
        refs.push({ uri, type });
        seen.add(uri);
      }
    }
  }

  return refs;
}

// ─── Context Access Service ─────────────────────────────────

export class ContextAccessService {
  /**
   * Instance method for extracting context refs (used by message.service.ts).
   */
  extractContextRefs(content: string, metadata?: Record<string, any>): ContextRef[] {
    return extractContextRefs(content, metadata);
  }

  /**
   * Validate access for a sender to a list of context refs.
   * Compatible with the message.service.ts integration interface.
   */
  async validateAccess(
    senderId: string,
    refs: ContextRef[] | string[],
  ): Promise<{ allowed: boolean; deniedRefs: string[] }> {
    // Normalize: accept either ContextRef[] or string[]
    const contextRefs: ContextRef[] = (refs as any[]).map((r: any) =>
      typeof r === 'string'
        ? { uri: r, type: r.startsWith('prismer://') ? ('prismer' as const) : ('url' as const) }
        : r,
    );
    const result = await this.checkAccess({ senderId, conversationId: '', contextRefs });
    return {
      allowed: result.allowed,
      deniedRefs: result.deniedRefs.map((r) => r.uri),
    };
  }

  /**
   * Check if a sender has access to all context refs in a message.
   *
   * - prismer:// URIs: sender must have previously loaded/referenced this context
   * - URL refs: open by default (public web content)
   * - file: refs: sender must be the uploader
   * - unknown: denied by default
   */
  async checkAccess(params: {
    senderId: string;
    conversationId: string;
    contextRefs: ContextRef[];
  }): Promise<AccessCheckResult> {
    if (params.contextRefs.length === 0) {
      return { allowed: true, deniedRefs: [] };
    }

    const deniedRefs: ContextRef[] = [];

    for (const ref of params.contextRefs) {
      switch (ref.type) {
        case 'prismer': {
          const contextId = ref.uri.replace('prismer://ctx/', '');
          const hasAccess = await this.checkPrismerContextAccess(params.senderId, contextId);
          if (!hasAccess) deniedRefs.push(ref);
          break;
        }
        case 'file': {
          const hasAccess = await this.checkFileAccess(params.senderId, ref.uri);
          if (!hasAccess) deniedRefs.push(ref);
          break;
        }
        case 'url':
          break; // open by default
        case 'unknown':
          deniedRefs.push(ref);
          break;
      }
    }

    if (deniedRefs.length > 0) {
      return {
        allowed: false,
        deniedRefs,
        reason: `Access denied to ${deniedRefs.length} context ref(s): ${deniedRefs.map((r) => r.uri).join(', ')}`,
      };
    }

    return { allowed: true, deniedRefs: [] };
  }

  /**
   * Enforce conversation-level policies on a message.
   */
  async enforcePolicy(params: {
    conversationId: string;
    senderId: string;
    senderType: 'human' | 'agent';
    contentLength: number;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const security = await prisma.iMConversationSecurity.findUnique({
      where: { conversationId: params.conversationId },
    });
    if (!security) return { allowed: true };

    const policy = security.metadata ? JSON.parse(security.metadata as string) : {};

    if (policy.allowedSenderTypes?.length) {
      if (!policy.allowedSenderTypes.includes(params.senderType)) {
        return { allowed: false, reason: `sender_type_${params.senderType}_not_allowed` };
      }
    }

    if (policy.maxMessageLength && params.contentLength > policy.maxMessageLength) {
      return { allowed: false, reason: 'message_too_long' };
    }

    return { allowed: true };
  }

  private async checkPrismerContextAccess(senderId: string, contextId: string): Promise<boolean> {
    try {
      const message = await prisma.iMMessage.findFirst({
        where: { senderId, content: { contains: contextId } },
        select: { id: true },
      });
      return message !== null;
    } catch {
      return false;
    }
  }

  private async checkFileAccess(senderId: string, fileUri: string): Promise<boolean> {
    try {
      const upload = await prisma.iMFileUpload.findFirst({
        where: {
          uploaderId: senderId,
          url: { contains: fileUri.replace('file:', '') },
        },
        select: { id: true },
      });
      return upload !== null;
    } catch {
      return false;
    }
  }
}
