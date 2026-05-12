/**
 * Shared slug validation + rename helpers for self and agent surfaces.
 *
 * Slug format mirrors the server-side SLUG_PATTERN in `src/im/api/agents.ts`
 * and the `/me` PATCH validator in `src/im/api/me.ts` so client + server
 * reject the same set of strings.
 */
import { imFetch, type FetchResult } from './im-api';

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

export type SlugValidation = { valid: true } | { valid: false; reason: string };

/**
 * Validate a slug client-side. Surface a precise reason for each failure mode
 * so the editor can show targeted feedback while the user types.
 *
 * Length bounds are inclusive: 3..31 chars (matches the regex {2,30} on a
 * one-character leading anchor).
 */
export function validateSlug(slug: string): SlugValidation {
  if (!slug) return { valid: false, reason: 'Username 不能为空' };
  if (slug.length < 3) return { valid: false, reason: '至少 3 个字符' };
  if (slug.length > 31) return { valid: false, reason: '最多 31 个字符' };
  if (!/^[a-z]/.test(slug)) return { valid: false, reason: '必须以小写字母开头' };
  if (!SLUG_PATTERN.test(slug)) return { valid: false, reason: '只能含小写字母、数字、连字符' };
  return { valid: true };
}

/** Backwards-compatible alias retained for existing agent-rename callers. */
export function validateAgentSlug(slug: string): SlugValidation {
  return validateSlug(slug);
}

/**
 * PATCH /api/im/agents/:agentImUserId — rename the slug (and optionally
 * the displayName). Server enforces format + global uniqueness; this helper
 * keeps the wire shape minimal so callers don't have to remember the route.
 *
 * The route is the same one used for displayName rename (Track A m1); §30
 * B3.8 Q2 extended it to also accept `username`. On 409 the server returns
 * `'Username already taken'`; surface that text back to the caller verbatim
 * so the UI can show it inline.
 */
export async function renameAgent(
  agentImUserId: string,
  patch: { username?: string; displayName?: string },
): Promise<FetchResult<unknown>> {
  return imFetch(`/agents/${encodeURIComponent(agentImUserId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * PATCH /api/im/me — update the caller's own IMUser profile.
 *
 * Wire shape (caller controls which fields to send — only changed fields
 * should be included to avoid unnecessary writes):
 *   { username?: string, displayName?: string, avatarUrl?: string | null }
 *
 * Server contract:
 *   - 200 OK → `{ ok: true, data: { user: {...} } }`
 *   - 400 → `{ ok: false, error: '<format error message>' }` (slug malformed,
 *           displayName empty / too long, avatarUrl too long, etc.)
 *   - 409 → `{ ok: false, error: 'Username already taken' }` on slug collision
 *           with another IMUser globally (`@unique` on IMUser.username)
 *   - 5xx / network → surface via `res.message` for toast
 *
 * The `/me` and `/agents/:id` endpoints are deliberately separate routes —
 * `/me` always acts on `auth.imUserId`, never accepts a target id.
 */
export async function renameSelf(patch: {
  username?: string;
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<FetchResult<unknown>> {
  return imFetch('/me', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}
