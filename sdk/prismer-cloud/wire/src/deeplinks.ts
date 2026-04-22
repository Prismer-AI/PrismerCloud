/**
 * @prismer/wire — prismer:// deep link schema
 *
 * Covers actions needed for §5.6 QR pairing flow + Universal Links:
 *   prismer://u/<userId>              — user profile Universal Link
 *   prismer://chat/<convId>           — conversation deep link
 *   prismer://pair?offer=<base64>    — QR/deep link pairing (offer format)
 *   prismer://invoke?skill=<name>&args=<encoded>
 *   prismer://open?target=<path>
 */

import { z } from 'zod';

/** Zod schema for new format (v1.9.0) — user/chat/pair deeplinks */
export const PrismerDeeplinkNewSchema = z.union([
  z.object({
    scheme: z.literal('prismer'),
    kind: z.literal('user'),
    userId: z
      .string()
      .min(1, 'userId too short')
      .refine((s) => s.trim().length > 0, { message: 'userId too short' }),
  }),
  z.object({
    scheme: z.literal('prismer'),
    kind: z.literal('chat'),
    convId: z
      .string()
      .min(1, 'convId too short')
      .refine((s) => s.trim().length > 0, { message: 'convId too short' }),
  }),
  z.object({
    scheme: z.literal('prismer'),
    kind: z.literal('pair'),
    offer: z.string().min(1, 'offer too short'),
    source: z.enum(['qr', 'paste', 'universal-link']).optional(),
  }),
]);

/** Zod schema for legacy format — invoke/open deeplinks */
export const PrismerDeeplinkLegacySchema = z.union([
  z.object({
    scheme: z.literal('prismer'),
    action: z.literal('invoke'),
    skill: z.string().min(1),
    args: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    scheme: z.literal('prismer'),
    action: z.literal('open'),
    target: z.string().min(1),
    agentId: z.string().optional(),
  }),
]);

/** Combined schema for backward compatibility */
export const PrismerDeeplinkSchema = z.union([
  PrismerDeeplinkNewSchema,
  PrismerDeeplinkLegacySchema,
]);

export type PrismerDeeplink = z.infer<typeof PrismerDeeplinkSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse a prismer:// URI string into a validated PrismerDeeplink object.
 *
 * @throws ZodError if parsed structure is invalid.
 * @throws Error if the URI is malformed or uses a non-prismer scheme.
 */
export function parseDeeplink(uri: string): PrismerDeeplink {
  if (!uri.startsWith('prismer://')) {
    throw new Error(`Expected prismer:// scheme, got: ${uri}`);
  }

  const rest = uri.slice('prismer://'.length);
  const qIdx = rest.indexOf('?');
  const pathPart = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rest.slice(qIdx + 1);

  if (!pathPart) {
    throw new Error(`Missing action/kind in prismer:// URI: ${uri}`);
  }

  // Extract kind/action from path
  const firstSlashIdx = pathPart.indexOf('/');
  const kindOrAction = firstSlashIdx === -1 ? pathPart : pathPart.slice(0, firstSlashIdx);
  const pathValue = firstSlashIdx === -1 ? '' : pathPart.slice(firstSlashIdx + 1);

  // Parse query parameters
  const params: Record<string, string> = {};
  if (query) {
    for (const part of query.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      const v = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1));
      params[k] = v;
    }
  }

  // Determine if this is new 'kind' format or legacy 'action' format
  const isNewFormat = ['u', 'chat', 'pair'].includes(kindOrAction);

  if (isNewFormat) {
    // New format: prismer://u/<userId>, prismer://chat/<convId>, prismer://pair?offer=...
    // Map path-based kinds to canonical kinds: 'u' → 'user', 'chat' → 'chat', 'pair' → 'pair'
    const canonicalKind = kindOrAction === 'u' ? 'user' : kindOrAction;

    // Special case: `prismer://pair` with NO query params at all is semantically
    // "missing the action payload". Distinguish from `prismer://pair?token=...`
    // (present but wrong) which should fall through to Zod and produce a ZodError.
    if (canonicalKind === 'pair' && query === '') {
      throw new Error(
        `Missing action/kind in prismer:// URI: ${uri} (pair requires offer param)`,
      );
    }

    const result: Record<string, unknown> = { scheme: 'prismer', kind: canonicalKind, ...params };

    // Set path-based parameters
    if (canonicalKind === 'user') {
      result.userId = pathValue;
    } else if (canonicalKind === 'chat') {
      result.convId = pathValue;
    }
    // 'pair' uses query params, already in result

    return PrismerDeeplinkNewSchema.parse(result);
  } else {
    // Legacy format: prismer://invoke?skill=..., prismer://open?target=...
    // Path-based form (`prismer://invoke/<skill>`) is an ALTERNATIVE to the
    // query-param form (`prismer://invoke?skill=<skill>`). Only let the path
    // value override the param value when the path actually carries data.
    const result: Record<string, unknown> = { scheme: 'prismer', action: kindOrAction, ...params };

    if (kindOrAction === 'invoke' && pathValue) {
      result.skill = pathValue;
    } else if (kindOrAction === 'open' && pathValue) {
      result.target = pathValue;
    }

    return PrismerDeeplinkLegacySchema.parse(result);
  }
}

/**
 * Serialize a PrismerDeeplink object into a prismer:// URI string.
 */
export function serializeDeeplink(link: PrismerDeeplink): string {
  const { scheme: _scheme, ...rest } = link;
  const params = new URLSearchParams();

  // Handle both 'kind' and 'action' formats
  if ('kind' in link) {
    if ('userId' in rest) {
      return `prismer://u/${(rest as any).userId}`;
    }
    if ('convId' in rest) {
      return `prismer://chat/${(rest as any).convId}`;
    }
    // kind: 'pair' - use query params
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'kind') continue;
      if (v !== undefined) params.set(k, String(v));
    }
    return `prismer://pair${params.toString() ? `?${params.toString()}` : ''}`;
  } else {
    // Legacy format: invoke, open - use query params
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'scheme' || k === 'action') continue;
      if (v !== undefined) params.set(k, String(v));
    }
    const action = (link as any).action;
    return `prismer://${action}${params.toString() ? `?${params.toString()}` : ''}`;
  }
}
