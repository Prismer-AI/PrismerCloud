/**
 * @prismer/wire — Task routing messages
 *
 * Reference: docs/version190/08-task-routing-wire.md §5.7.
 * In-tree consumers aligned:
 *   - src/im/api/tasks.ts                (POST /tasks/:id/route body)
 *   - src/im/services/task.service.ts    (runtimeRoute storage + advanceRouteStep)
 *   - src/im/services/task-router.ts     (assign / stepCompleted paths)
 *
 * The `runtimeRoute` column stores an array of `TaskRouteStep` (status/
 * completion fields filled in by the coordinator). This module defines both
 * the client-provided request shape and the WS events fanned out during
 * step progression.
 */

import { z } from 'zod';

// ─── Route step (POST /tasks/:id/route body element) ─────────────────────

/**
 * One step in a task route. `capability` is required; `assignee` and
 * `deadline` are optional at request time — the coordinator may fill
 * `assignee` later via capability-based matching.
 *
 * The server-side augments each step with `stepIdx`, `status`,
 * `completedBy`, `completedAt` when persisted into `im_tasks.runtimeRoute`.
 */
export const TaskRouteStepSchema = z.object({
  capability: z.string().min(1),
  assignee: z.string().optional(), // e.g. 'agent:claude-code@MacBook' or 'user:tom'
  deadline: z.string().optional(), // ISO-8601 timestamp
});

export type TaskRouteStep = z.infer<typeof TaskRouteStepSchema>;

// ─── Route request body ───────────────────────────────────────────────────

/**
 * POST /tasks/:id/route body. At least one step required; the first step
 * becomes the initial assignment.
 */
export const TaskRouteRequestSchema = z.object({
  steps: z.array(TaskRouteStepSchema).min(1),
});

export type TaskRouteRequest = z.infer<typeof TaskRouteRequestSchema>;

// ─── Persisted runtime-route step (server-side shape) ────────────────────

/** Status of a single runtimeRoute step as tracked by the coordinator. */
export const TaskRouteStepStatusSchema = z.enum([
  'pending',
  'assigned',
  'running',
  'done',
  'failed',
  'skipped',
]);

export type TaskRouteStepStatus = z.infer<typeof TaskRouteStepStatusSchema>;

/** Full persisted step row stored in `im_tasks.runtimeRoute`. */
export const TaskRuntimeRouteStepSchema = TaskRouteStepSchema.extend({
  stepIdx: z.number().int().nonnegative(),
  status: TaskRouteStepStatusSchema,
  assignee: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  completedBy: z.string().optional(),
  completedAt: z.string().optional(), // ISO-8601
});

export type TaskRuntimeRouteStep = z.infer<typeof TaskRuntimeRouteStepSchema>;

// ─── WS events fanned out by the coordinator ─────────────────────────────

/** `task.step.assigned` — coordinator picked (or was given) an assignee. */
export const TaskStepAssignedSchema = z.object({
  taskId: z.string().min(1),
  stepIdx: z.number().int().nonnegative(),
  assigneeId: z.string().min(1).nullable().optional(),
  capability: z.string().min(1),
});

export type TaskStepAssigned = z.infer<typeof TaskStepAssignedSchema>;

/** `task.step.completed` — assignee reported a result for this step. */
export const TaskStepCompletedSchema = z.object({
  taskId: z.string().min(1),
  stepIdx: z.number().int().nonnegative(),
  result: z.unknown(),
  status: z.enum(['ok', 'failed']),
});

export type TaskStepCompleted = z.infer<typeof TaskStepCompletedSchema>;

/** `task.needs_human` — a `human.approve` step surfaced; triggers push. */
export const TaskNeedsHumanSchema = z.object({
  taskId: z.string().min(1),
  prompt: z.string().optional(),
  stepIdx: z.number().int().nonnegative().optional(),
  assignee: z.string().optional(),
  ttlMs: z.number().int().positive(),
});

export type TaskNeedsHuman = z.infer<typeof TaskNeedsHumanSchema>;

// ─── Convenience: event envelope union ────────────────────────────────────

/**
 * Discriminated union matching the WS event payload shape emitted by
 * EventBusService (see src/im/api/tasks.ts). Useful for clients that
 * subscribe to a single task event stream.
 */
export const TaskRouteEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.step.assigned'), data: TaskStepAssignedSchema }),
  z.object({ type: z.literal('task.step.completed'), data: TaskStepCompletedSchema }),
  z.object({ type: z.literal('task.needs_human'), data: TaskNeedsHumanSchema }),
]);

export type TaskRouteEvent = z.infer<typeof TaskRouteEventSchema>;
