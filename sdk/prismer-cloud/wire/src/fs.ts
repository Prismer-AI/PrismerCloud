/**
 * @prismer/wire — FS Sandbox API messages
 *
 * Wire schemas for the FS Sandbox API exposed by the runtime daemon
 * (reference: docs/version190/04-sandbox-permissions.md). The runtime itself
 * lives in @prismer/sandbox-runtime (see `fs-adapter.ts` for the op set);
 * this module defines the on-the-wire JSON request / response envelope so
 * adapters, mobile clients, and mcp-server validate the same shape.
 *
 * Op set aligned with sandbox-runtime/fs-adapter.ts:
 *   read | write | delete | edit | list | search
 */

import { z } from 'zod';

// ─── Op union ─────────────────────────────────────────────────────────────

export const FsOpSchema = z.enum(['read', 'write', 'delete', 'edit', 'list', 'search']);
export type FsOp = z.infer<typeof FsOpSchema>;

// ─── Per-op request shapes ───────────────────────────────────────────────

const FsReadRequestSchema = z.object({
  op: z.literal('read'),
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

const FsWriteRequestSchema = z.object({
  op: z.literal('write'),
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
});

const FsDeleteRequestSchema = z.object({
  op: z.literal('delete'),
  path: z.string().min(1),
});

const FsEditRequestSchema = z.object({
  op: z.literal('edit'),
  path: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

const FsListRequestSchema = z.object({
  op: z.literal('list'),
  path: z.string().min(1),
  maxDepth: z.number().int().positive().optional(),
});

const FsSearchRequestSchema = z.object({
  op: z.literal('search'),
  query: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
});

/** Discriminated union of all FS sandbox requests. */
export const FsRequestSchema = z.discriminatedUnion('op', [
  FsReadRequestSchema,
  FsWriteRequestSchema,
  FsDeleteRequestSchema,
  FsEditRequestSchema,
  FsListRequestSchema,
  FsSearchRequestSchema,
]);

export type FsRequest = z.infer<typeof FsRequestSchema>;

// ─── Success responses ────────────────────────────────────────────────────

const FsReadOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('read'),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']),
});

const FsWriteOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('write'),
  bytes: z.number().int().nonnegative(),
});

const FsDeleteOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('delete'),
  deleted: z.boolean(),
});

const FsEditOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('edit'),
  bytes: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
});

const FsListEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative().optional(),
});

const FsListOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('list'),
  entries: z.array(FsListEntrySchema),
});

const FsSearchMatchSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  snippet: z.string().optional(),
});

const FsSearchOkSchema = z.object({
  ok: z.literal(true),
  op: z.literal('search'),
  matches: z.array(FsSearchMatchSchema),
});

const FsOkResponseSchema = z.discriminatedUnion('op', [
  FsReadOkSchema,
  FsWriteOkSchema,
  FsDeleteOkSchema,
  FsEditOkSchema,
  FsListOkSchema,
  FsSearchOkSchema,
]);

// ─── Error response ───────────────────────────────────────────────────────

/**
 * Common FS error codes. `permission_denied` corresponds to the sandbox
 * `PermissionDeniedError`; `outside_sandbox` to `OutsideSandboxError`;
 * `approval_required` to the `ask` decision path (caller should prompt).
 */
export const FsErrorCodeSchema = z.enum([
  'permission_denied',
  'outside_sandbox',
  'approval_required',
  'not_found',
  'io_error',
  'invalid_arg',
  'unc_path',
  'symlink_refused',
  'frozen_path',
]);

export type FsErrorCode = z.infer<typeof FsErrorCodeSchema>;

const FsErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: FsErrorCodeSchema,
  error: z.string(),
  op: FsOpSchema.optional(),
  path: z.string().optional(),
});

/**
 * Specialised "approval needed" response. Emitted when the permission engine
 * returns `ask` and no approval-gate is configured (or the gate bounced the
 * decision to the user). Callers display this to the user and, if approved,
 * re-send the original request possibly with a session-scoped rule.
 */
export const FsPermissionDeniedSchema = z.object({
  ok: z.literal(false),
  code: z.literal('approval_required'),
  error: z.string(),
  toolName: z.string(),
  path: z.string(),
  reason: z.string(),
});

export type FsPermissionDenied = z.infer<typeof FsPermissionDeniedSchema>;

// ─── Union response ───────────────────────────────────────────────────────

/** Full response: either a typed success for the requested op, or an error. */
export const FsResponseSchema = z.union([FsOkResponseSchema, FsErrorResponseSchema]);
export type FsResponse = z.infer<typeof FsResponseSchema>;

// ─── Re-exports ───────────────────────────────────────────────────────────

export {
  FsReadRequestSchema,
  FsWriteRequestSchema,
  FsDeleteRequestSchema,
  FsEditRequestSchema,
  FsListRequestSchema,
  FsSearchRequestSchema,
  FsReadOkSchema,
  FsWriteOkSchema,
  FsDeleteOkSchema,
  FsEditOkSchema,
  FsListOkSchema,
  FsSearchOkSchema,
  FsOkResponseSchema,
  FsErrorResponseSchema,
  FsListEntrySchema,
  FsSearchMatchSchema,
};
