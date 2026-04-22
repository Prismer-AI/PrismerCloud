/**
 * Type-only contract shim — mirrors the exported types in
 * `@prismer/runtime`'s `adapter-registry.ts` verbatim.
 *
 * We deliberately do NOT `import type { AdapterImpl } from '@prismer/runtime'`
 * because that would require either (a) a pre-built runtime package
 * (fragile during monorepo dev) or (b) TS path-mapping into the runtime
 * source tree (which pulls runtime's strict `noUnusedLocals` errors into
 * this package's typecheck).
 *
 * Source of truth: `sdk/prismer-cloud/runtime/src/adapter-registry.ts`
 * @see https://github.com/Prismer-AI/PrismerCloud/blob/main/sdk/prismer-cloud/runtime/src/adapter-registry.ts
 *
 * If the runtime contract changes, update these interfaces to match.
 * A CI check (planned for v0.1.1) will diff this file against the
 * runtime exports and fail the build on drift.
 */

export interface AdapterDescriptor {
  /** Stable identifier — must match the catalog entry. */
  name: string;
  /** PARA Tier numbers (L1–L10). */
  tiersSupported: number[];
  /** Capability tag vocabulary (e.g. ["code.write", "code.review"]). */
  capabilityTags: string[];
  /** Free-form for telemetry — version, build, etc. */
  metadata?: Record<string, unknown>;
}

export interface AdapterDispatchInput {
  /** Cloud task ID (im_tasks.id). */
  taskId: string;
  /** Step index when the task is multi-step. */
  stepIdx?: number;
  /** Capability the cloud asked for — drives adapter selection. */
  capability: string;
  /** User-facing prompt / instruction. */
  prompt: string;
  /** Free-form metadata passed through to the adapter. */
  metadata?: Record<string, unknown>;
  /** Optional deadline (ms epoch). */
  deadlineAt?: number;
}

export interface AdapterDispatchResult {
  ok: boolean;
  /** Output text (stdout, summary, etc.). */
  output?: string;
  /** Files produced by the adapter. */
  artifacts?: Array<{ path: string; bytes: number; mime?: string }>;
  /** Failure reason — must be set when ok=false. */
  error?: string;
  /** Free-form telemetry — token counts, latency, model, etc. */
  metadata?: Record<string, unknown>;
}

export interface AdapterImpl extends AdapterDescriptor {
  /** Dispatch a task step to this adapter. Should not throw. */
  dispatch(input: AdapterDispatchInput): Promise<AdapterDispatchResult>;
  /** Optional per-adapter health probe. */
  health?(): Promise<{ healthy: boolean; reason?: string }>;
}
