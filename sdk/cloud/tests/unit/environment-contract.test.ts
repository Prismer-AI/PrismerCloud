/**
 * Unit tests for the EaaS contract mirror (`src/environment-contract.ts`).
 *
 * The mirror must stay field-identical with `src/tenant/contract.ts` (the SDK
 * deliberately does not import cloud src/). These tests pin the exact error
 * code set, the exact type shapes (compile-time via typed literals + runtime
 * spot checks), and the `isEaasErrorEnvelope` guard.
 *
 * Usage:
 *   cd sdk/cloud && npx vitest run tests/unit/environment-contract.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  EAAS_ERROR_CODES,
  EAAS_EVENT_TYPES,
  isEaasErrorEnvelope,
  newIdempotencyKey,
  type EaasApiEnvelope,
  type EaasErrorCode,
  type EaasEventType,
  type EaasRunToolFinishedPayload,
  type EaasRunToolStartedPayload,
  type EnvironmentCreateSpec,
  type EnvironmentStatus,
  type WarmPoolPolicy,
  type WarmPoolStatus,
  type EaasEventEnvelope,
} from '../../src/environment-contract';

describe('EAAS_ERROR_CODES mirror', () => {
  it('carries the exact 22-code set (Global Constraint 5 + Gate B T5/T7 + Gate B+ T7 codes)', () => {
    expect(Object.keys(EAAS_ERROR_CODES).sort()).toEqual(
      [
        'budget_exhausted',
        'capability_denied',
        'capability_unavailable',
        'idempotency_conflict',
        'invalid_asset',
        'invalid_policy',
        'invalid_request',
        'invalid_session',
        'invalid_token',
        'not_owned',
        'pricing_unavailable',
        'provider_unavailable',
        'publishable_key_invalid',
        'quota_exceeded',
        'rate_limited',
        'revision_conflict',
        'runtime_unavailable',
        'scope_denied',
        'session_expired',
        'state_conflict',
        'template_unavailable',
        'warm_capacity_unavailable',
      ].sort(),
    );
  });

  it('maps codes to HTTP statuses exactly as the server contract', () => {
    expect(EAAS_ERROR_CODES.warm_capacity_unavailable).toBe(503);
    expect(EAAS_ERROR_CODES.not_owned).toBe(404);
    expect(EAAS_ERROR_CODES.revision_conflict).toBe(412);
    expect(EAAS_ERROR_CODES.capability_unavailable).toBe(422);
    expect(EAAS_ERROR_CODES.budget_exhausted).toBe(402);
    expect(EAAS_ERROR_CODES.invalid_token).toBe(401);
    expect(EAAS_ERROR_CODES.quota_exceeded).toBe(429);
    expect(EAAS_ERROR_CODES.provider_unavailable).toBe(503);
    // Gate B T5/T7 additions.
    expect(EAAS_ERROR_CODES.invalid_session).toBe(401);
    expect(EAAS_ERROR_CODES.publishable_key_invalid).toBe(401);
    expect(EAAS_ERROR_CODES.session_expired).toBe(401);
    expect(EAAS_ERROR_CODES.capability_denied).toBe(403);
  });

  it('EaasErrorCode keys are usable as envelope error codes (compile-time)', () => {
    const code: EaasErrorCode = 'warm_capacity_unavailable';
    const envelope: EaasApiEnvelope<never> = {
      success: false,
      error: { code, message: 'warm capacity unavailable', details: null },
      requestId: 'req-1',
    };
    expect(envelope.success).toBe(false);
  });
});

describe('type mirror shapes (compile-time via typed literals)', () => {
  it('EnvironmentCreateSpec accepts the full API-draft field set', () => {
    const spec: EnvironmentCreateSpec = {
      projectId: 'prj_abc',
      template: 'ubuntu@sha256:deadbeef',
      profile: '2c4g',
      poolId: 'kind-alt',
      placementId: 'kind-alt-place',
      ttlSeconds: 3600,
      metadata: { team: 'eaas' },
      env: { TOKEN: 'secret' },
      startup: { onWarmMiss: 'fail' },
    };
    expect(spec.profile).toBe('2c4g');
    expect(spec.poolId).toBe('kind-alt');
    expect(spec.startup?.onWarmMiss).toBe('fail');
  });

  it('EnvironmentStatus carries the state machine + readiness projection', () => {
    const status: EnvironmentStatus = {
      environmentId: 'env_abc',
      state: 'running',
      revision: 3,
      epoch: 1,
      readiness: { sandbox: true, services: true, agent: null },
      startupPath: 'warm',
      templateVersion: 'ubuntu@sha256:deadbeef',
      expiresAt: '2026-09-09T00:00:00.000Z',
      milestones: [{ name: 'sandbox_up', at: '2026-09-08T00:00:01.000Z', durationMs: 1200 }],
    };
    expect(status.readiness.agent).toBeNull();
    expect(status.startupPath).toBe('warm');
  });

  it('WarmPoolPolicy + WarmPoolStatus mirror spec §4 fields', () => {
    const policy: WarmPoolPolicy = {
      minReady: 1,
      maxReady: 2,
      idleRetentionSeconds: 600,
      dailyBudgetCredits: '12.500',
      onMiss: 'fail',
    };
    const status: WarmPoolStatus = {
      revision: 2,
      observedRevision: 2,
      desired: policy,
      effective: { state: 'ready', ready: 1, provisioning: 1, terminating: 0 },
      cost: {
        rateVersion: 'r1',
        estimatedHourlyCredits: '0.100',
        spentTodayCredits: '1.000',
        reservedCredits: '0.200',
        remainingTodayCredits: '11.300',
        periodStart: '2026-09-08T00:00:00.000Z',
        periodEnd: '2026-09-09T00:00:00.000Z',
      },
    };
    expect(status.desired.onMiss).toBe('fail');
    expect(status.effective.state).toBe('ready');
  });

  it('EAAS_EVENT_TYPES mirrors src/tenant/events.ts EVENT_TYPES exactly (20 members)', () => {
    // 冻结名单逐字钉住：服务端 ADD/REMOVE 一个类型而这里没同步 → 本行红。
    // 源：src/tenant/events.ts `EVENT_TYPES`（含 2026-09-21 spec §3.4 新增的
    // run.tool_started / run.tool_finished 两个工具事件类型，以及 2026-09-22
    // spec 10 §3.4 / T3-2 新增的五个 run 生命周期类型）。
    expect([...EAAS_EVENT_TYPES]).toEqual([
      'environment.created',
      'environment.state_changed',
      'environment.readiness_changed',
      'environment.deleted',
      'environment.warm_pool.updated',
      'environment.warm_pool.degraded',
      'usage.warning',
      'rate_table.updated',
      'quota_templates.updated',
      'tenant.quota_updated',
      'tenant.frozen',
      'tenant.unfrozen',
      'billing.usage_adjusted',
      'run.started',
      'run.completed',
      'run.failed',
      'run.canceled',
      'run.awaiting_approval',
      'run.tool_started',
      'run.tool_finished',
    ]);
    expect(EAAS_EVENT_TYPES).toHaveLength(20);
    // 无重复成员（镜像集合是 Set 语义）。
    expect(new Set(EAAS_EVENT_TYPES).size).toBe(EAAS_EVENT_TYPES.length);
    // 工具事件两条确实在集合里（spec §3.4 的本轮收敛范围）。
    expect(EAAS_EVENT_TYPES).toContain('run.tool_started');
    expect(EAAS_EVENT_TYPES).toContain('run.tool_finished');
    // run 生命周期五条（T3-2）——含拼写钉住：服务端写入点与 journey 消费方用的
    // 都是 `run.canceled`（spec 正文写 cancelled 是笔误，服务端注释已标注）。
    expect(EAAS_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'run.started',
        'run.completed',
        'run.failed',
        'run.canceled',
        'run.awaiting_approval',
      ]),
    );
    expect(EAAS_EVENT_TYPES).not.toContain('run.cancelled');
  });

  it('EaasEventType is the union of the mirrored set (compile-time)', () => {
    const started: EaasEventType = 'run.tool_started';
    const finished: EaasEventType = 'run.tool_finished';
    expect([started, finished]).toEqual(['run.tool_started', 'run.tool_finished']);
    // @ts-expect-error 未注册的类型名不是合法 EaasEventType（镜像收紧到这里）。
    const bogus: EaasEventType = 'run.tool_exploded';
    expect(String(bogus)).toBeTruthy();
  });

  it('EaasEventEnvelope.type stays `string` — new tool types are additive, no breaking change', () => {
    // 收紧成 EaasEventType 会让「新服务端 + 旧 SDK」在类型层爆掉；这里钉住它是
    // 宽 string，且未知类型同样可赋值（消费方按字符串匹配、忽略未知）。
    const known: EaasEventEnvelope = {
      v: 1,
      eventId: 'tnt_1:77',
      cursor: '77',
      type: 'run.tool_started',
      at: '2026-09-21T02:00:00.000Z',
      environmentId: 'env_abc',
      payload: { runId: 'run_1', tool: 'bash' },
    };
    const unknown: EaasEventEnvelope = { ...known, type: 'conversation.something_new' };
    const widened: string = known.type;
    expect(widened).toBe('run.tool_started');
    expect(unknown.type).toBe('conversation.something_new');
  });

  it('run.tool_* payload mirrors carry the poller-emitted fields', () => {
    const started: EaasRunToolStartedPayload = {
      runId: 'run_1',
      turnId: 'turn_1',
      environmentId: 'env_abc',
      tool: 'bash',
      argsSummary: 'echo eaas-bash-ok',
      sandboxId: 'sbx_1',
    };
    const finished: EaasRunToolFinishedPayload = {
      runId: 'run_1',
      turnId: 'turn_1',
      environmentId: 'env_abc',
      tool: 'bash',
      resultSummary: 'eaas-bash-ok',
      isError: false,
      durationMs: 412,
      sandboxId: 'sbx_1',
    };
    // 摘要不可用 = null（键恒存在，不是缺键）；sandboxId 是 optional（spec §3.4 表格
    // 未列、线上附带——故既不漏也不强制）。
    const missing: EaasRunToolStartedPayload = {
      runId: 'run_1',
      turnId: 'turn_1',
      environmentId: 'env_abc',
      tool: 'bash',
      argsSummary: null,
    };
    // 失败工具如实带 isError=true（T5③ 的消费面）。
    const errored: EaasRunToolFinishedPayload = { ...finished, isError: true, durationMs: null };
    expect(started.tool).toBe('bash');
    expect(finished.durationMs).toBe(412);
    expect(missing.argsSummary).toBeNull();
    expect(missing.sandboxId).toBeUndefined();
    expect(errored.isError).toBe(true);
  });

  it('EaasEventEnvelope mirrors the Global Constraint 13 shape', () => {
    const evt: EaasEventEnvelope = {
      v: 1,
      eventId: 'tnt_1:42',
      cursor: '42',
      type: 'environment.ready',
      at: '2026-09-08T00:00:00.000Z',
      environmentId: 'env_abc',
      projectId: 'prj_abc',
      payload: { reason: 'warm-claim' },
    };
    expect(evt.v).toBe(1);
    expect(evt.cursor).toBe('42');
  });
});

describe('isEaasErrorEnvelope', () => {
  it('accepts the server fail envelope (details key always present, null when empty)', () => {
    expect(
      isEaasErrorEnvelope({
        success: false,
        error: { code: 'warm_capacity_unavailable', message: 'no warm capacity', details: null },
        requestId: 'req-1',
      }),
    ).toBe(true);
  });

  it('accepts a fail envelope with detail payload', () => {
    expect(
      isEaasErrorEnvelope({
        success: false,
        error: { code: 'revision_conflict', message: 'stale revision', details: { expected: 3 } },
        requestId: 'req-2',
      }),
    ).toBe(true);
  });

  it('rejects success envelopes and non-envelope shapes', () => {
    expect(isEaasErrorEnvelope({ success: true, data: {}, requestId: 'req-3' })).toBe(false);
    expect(isEaasErrorEnvelope(null)).toBe(false);
    expect(isEaasErrorEnvelope('warm_capacity_unavailable')).toBe(false);
    expect(isEaasErrorEnvelope({ success: false })).toBe(false);
    expect(isEaasErrorEnvelope({ success: false, error: { code: 'x' }, requestId: 'req-4' })).toBe(false);
    expect(isEaasErrorEnvelope({ success: false, error: null, requestId: 'req-5' })).toBe(false);
  });
});

describe('newIdempotencyKey', () => {
  it('produces unique, non-empty keys', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a.length).toBeGreaterThan(0);
    expect(b).not.toBe(a);
  });
});
