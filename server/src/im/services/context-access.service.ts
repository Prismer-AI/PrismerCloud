/**
 * Context Access Control — validates prismer:// URI access in messages.
 * Layer 3 of the security model.
 *
 * prismer:// URI format: prismer://{visibility}/{owner}/{contentId}
 *   - visibility: public | unlisted | private
 *   - owner: u_{userId} (user namespace)
 *   - contentId: opaque content identifier
 *
 * Access rules:
 *   - public: always accessible
 *   - unlisted: accessible to anyone with the link
 *   - private: only accessible to the owner
 */

import prisma from '../db';

// Only match valid visibility prefixes: public, unlisted, private
const PRISMER_URI_RE = /prismer:\/\/(?:public|unlisted|private)\/u_[a-z0-9_]+\/c_[a-z0-9_]+/gi;

export class ContextAccessService {
  /**
   * Extract prismer:// URIs from message content and metadata.
   * Only matches well-formed URIs with valid visibility prefix.
   */
  extractContextRefs(content: string, metadata?: Record<string, any>): string[] {
    const fromContent = content.match(PRISMER_URI_RE) || [];
    const fromMetadata: string[] = [];

    if (metadata?.contextUri && typeof metadata.contextUri === 'string') {
      if (PRISMER_URI_RE.test(metadata.contextUri)) {
        PRISMER_URI_RE.lastIndex = 0; // reset regex state
        fromMetadata.push(metadata.contextUri);
      }
    }
    if (metadata?.contextRefs && Array.isArray(metadata.contextRefs)) {
      for (const ref of metadata.contextRefs) {
        if (typeof ref === 'string' && PRISMER_URI_RE.test(ref)) {
          PRISMER_URI_RE.lastIndex = 0;
          fromMetadata.push(ref);
        }
      }
    }
    PRISMER_URI_RE.lastIndex = 0;

    return [...new Set([...fromContent, ...fromMetadata])];
  }

  /**
   * Validate that a user has access to all context refs.
   * Only processes well-formed URIs with known visibility values.
   */
  async validateAccess(userId: string, contextRefs: string[]): Promise<{ allowed: boolean; deniedRefs: string[] }> {
    if (contextRefs.length === 0) return { allowed: true, deniedRefs: [] };

    const deniedRefs: string[] = [];

    for (const uri of contextRefs) {
      const stripped = uri.replace('prismer://', '');
      const parts = stripped.split('/');
      if (parts.length < 3) continue;

      const [visibility, owner] = parts;

      if (visibility === 'public' || visibility === 'unlisted') continue;

      if (visibility === 'private') {
        const ownerUserId = owner.replace('u_', '');
        if (ownerUserId !== userId) {
          deniedRefs.push(uri);
        }
        continue;
      }

      // Regex already filters to valid visibility — this shouldn't be reached
      deniedRefs.push(uri);
    }

    return { allowed: deniedRefs.length === 0, deniedRefs };
  }

  /**
   * Check conversation policy for a specific action.
   * Evaluates ALL deny rules (not just first), then allow rules.
   */
  async checkConversationPolicy(
    conversationId: string,
    userId: string,
    action: string = 'send',
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Check ALL deny rules for this action
    const denyRules = await prisma.iMConversationPolicy.findMany({
      where: { conversationId, rule: 'deny', action },
    });

    for (const rule of denyRules) {
      if (rule.subjectType === 'user' && rule.subjectId === userId) {
        return { allowed: false, reason: `User denied: ${action}` };
      }
      // Future: role/trustTier matching
    }

    // Check allow rules (if any exist, only allowed subjects can proceed)
    const allowRules = await prisma.iMConversationPolicy.findMany({
      where: { conversationId, rule: 'allow', action },
    });

    if (allowRules.length > 0) {
      const isAllowed = allowRules.some((r: any) => {
        if (r.subjectType === 'user') return r.subjectId === userId;
        return false;
      });
      if (!isAllowed) {
        return { allowed: false, reason: `Not in allow list for: ${action}` };
      }
    }

    return { allowed: true };
  }
}
