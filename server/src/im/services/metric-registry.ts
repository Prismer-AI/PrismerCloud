/**
 * Prismer IM — Metric Registry (v2.0.7 release201/11 §4 + §4.1 + §8b)
 *
 * Soft schema validation for emitted metric events. Unknown metrics pass
 * (warning logged); known metrics validate value type + required dims.
 *
 * Strict mode is forbidden in v2.0.7 (release201/11 §0.2.4) — emitting
 * never blocks on registry, only logs warnings via pino so admin can
 * surface drift through /api/sandboxes/_admin/system-logs.
 */

export type MetricValueType = 'numeric' | 'string';

export interface MetricSchema {
  /** numeric → value goes in value_numeric; string → value_string. */
  valueType: MetricValueType;
  /** Dimension keys that must be present on dims (workspaceId is always required). */
  requiredDims: readonly string[];
  /** Human description (registry browsing / docs). */
  description: string;
}

/**
 * The full v2.0.7 registry (§4 table 1-12 + §8 task.metric snapshot + §9
 * skill.draft 13-15). 16 metrics total. workspaceId is always required.
 */
export const METRIC_REGISTRY: ReadonlyMap<string, MetricSchema> = new Map([
  // 1-4. task lifecycle
  [
    'task.created',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'capability', 'creatorId'],
      description: 'Task created.',
    },
  ],
  [
    'task.completed',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'taskId', 'capability', 'assigneeId'],
      description: 'Task completed; value = duration_ms from create→complete.',
    },
  ],
  [
    'task.failed',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'taskId', 'capability'],
      description: 'Task failed terminally (after retry exhaustion).',
    },
  ],
  [
    'task.blocked_duration',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'taskId'],
      description: 'Duration in ms a task spent in blocked state before transitioning to running.',
    },
  ],

  // 5-6. task acceptance (release201/10)
  [
    'task.acceptance.status_changed',
    {
      valueType: 'string',
      requiredDims: ['workspaceId', 'taskId', 'capability'],
      // `assigneeId` is an optional dim (soft schema): emitted when the task
      // has an assignee at status-change time. F5 BFF (getAgentMetrics) filters
      // on dims.assigneeId to produce per-agent acceptanceRate.
      description:
        'Acceptance overall status: passed|failed|partial|none. Optional dim: assigneeId (consumed by getAgentMetrics for per-agent acceptanceRate, release201/20 F5).',
    },
  ],
  [
    'task.criteria.verified',
    {
      valueType: 'string',
      requiredDims: ['workspaceId', 'taskId', 'criterionId', 'verifyMode'],
      description: 'Acceptance criterion verification: passed|failed|n/a.',
    },
  ],
  [
    'task.todo.completion_rate',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'taskId'],
      description: "TODO.md completion rate (0..1) after a tick / add / remove on the assignee's TODO list.",
    },
  ],
  [
    'task.spec.updated_after_assignment',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'taskId', 'status'],
      description:
        'Owner edited SPEC.md after the task was assigned/running/in review — anti-drift counter (value=1 per edit).',
    },
  ],

  // 7-9. skill lifecycle (release201/08)
  [
    'skill.invoked',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'agentId', 'skillId'],
      description: 'Daemon adapter dispatched into a skill.',
    },
  ],
  [
    'skill.published',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'skillId', 'publishScope'],
      description: 'Skill published (workspace / public / org).',
    },
  ],
  [
    'skill.eval.run_finished',
    {
      valueType: 'string',
      requiredDims: ['workspaceId', 'skillId', 'runId'],
      description: 'Skill eval session finished: pass|fail.',
    },
  ],

  // 10. agent dispatch
  [
    'agent.dispatch',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'agentId', 'taskId'],
      description: 'Daemon dispatch duration_ms.',
    },
  ],

  // 11. approval
  [
    'approval.decided',
    {
      valueType: 'string',
      requiredDims: ['workspaceId', 'decisionBy'],
      description: 'Approval decided: approve|reject.',
    },
  ],

  // 12. project (release201/09)
  [
    'project.archived',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'projectId'],
      description: 'Project archived; value = duration_days from create→archive.',
    },
  ],

  // 13-15. skill.draft (release201/07)
  [
    'skill.draft.created',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'skillId', 'sourceKind'],
      description: 'Skill draft created from authoring engine.',
    },
  ],
  [
    'skill.draft.regenerated',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'skillId', 'reason'],
      description: 'Skill draft regenerated (e.g. after eval failure).',
    },
  ],
  [
    'skill.draft.review_assigned',
    {
      valueType: 'numeric',
      requiredDims: ['workspaceId', 'skillId', 'reviewerUserId'],
      description: 'Skill draft assigned to a reviewer.',
    },
  ],

  // 16. task.metric snapshot (release201/11 §8b)
  [
    'task.metric.snapshot_updated',
    {
      valueType: 'string',
      requiredDims: ['workspaceId', 'taskId', 'metricId', 'name'],
      description: 'Task-bound metric snapshot status: passing|failing|unknown.',
    },
  ],
  // release201 S18 — legacy redirect telemetry (v2.0.8 删除 /workspace/insights
  // 兼容 redirect 前的流量观测)。workspaceId 不强制 (未登录用户击中 redirect
  // 时 token 拿不到,emit 会被 client-side 跳过)。
  [
    'legacy_route_hits.workspace_insights',
    {
      valueType: 'numeric',
      requiredDims: [],
      description:
        'Legacy /workspace/insights deep-link hit count. Used by release201 S18 to time the redirect shim removal in v2.0.8.',
    },
  ],
]);

export interface ValidationInput {
  namespace: string;
  name: string;
  value?: number | string | null;
  dims?: Record<string, unknown> | null;
}

export interface ValidationResult {
  ok: boolean;
  warnings: string[];
  /** Looked-up schema if registered; undefined for unknown metrics. */
  schema?: MetricSchema;
}

/**
 * Soft validate an emit. Returns the schema (if known) plus a warning list.
 * Never throws — every emit gets through to the DB; warnings are advisory.
 */
export function validateMetricEmit(input: ValidationInput): ValidationResult {
  const key = `${input.namespace}.${input.name}`;
  const schema = METRIC_REGISTRY.get(key);
  const warnings: string[] = [];

  if (!schema) {
    warnings.push(`unregistered metric: ${key}`);
    return { ok: true, warnings };
  }

  if (input.value !== undefined && input.value !== null) {
    const isNumeric = typeof input.value === 'number';
    const expectedNumeric = schema.valueType === 'numeric';
    if (expectedNumeric !== isNumeric) {
      warnings.push(`${key}: expected ${schema.valueType} value, got ${typeof input.value}`);
    }
  }

  const dims = input.dims ?? {};
  for (const required of schema.requiredDims) {
    const present = dims[required];
    if (present === undefined || present === null || present === '') {
      warnings.push(`${key}: missing required dim "${required}"`);
    }
  }

  return { ok: true, warnings, schema };
}

/** Convenience for tests and CLI tooling. */
export function listRegisteredMetrics(): string[] {
  return Array.from(METRIC_REGISTRY.keys()).sort();
}
