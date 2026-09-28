// Hermes 0.20.0 /health/detailed 状态判定回归测试。
//
// 2026-08-16 线上事故:hermes 0.20.0 在磁盘 >= 90% 时把整体 status 报为
// "degraded"(其余全绿:gateway_state=running + api_server connected)。
// 旧判定只认 status === 'ok' → 永远判不健康 → waitForHealthy 30s 超时 →
// stamp 落不下 → 每次 dispatch 误判漂移 → 杀网关重来 → 3 次重试耗尽 →
// task 失败、agent 不回话(本地 kind pod 实测复现)。
//
// 判定契约:gateway_state=running(缺失按旧版 best-effort 放行) +
// platforms.api_server.state=connected 是可用性的两个必要条件;
// 顶层 status 接受 ok|degraded(degraded 是 hermes 自报的运维降级,
// 不影响网关服务会话),其余一律判不健康。

import { describe, expect, it } from 'vitest';
import { evaluateHermesDetailedHealth } from '../src/adapters/persistence/hermes/index.js';

// 真实 hermes 0.20.0 磁盘压力下的完整响应(实测抓取)。
const DEGRADED_DISK_PAYLOAD = {
  status: 'degraded',
  readiness: {
    status: 'degraded',
    checks: {
      state_db: { status: 'ok' },
      config: { status: 'ok' },
      model: { status: 'ok' },
      disk: { status: 'degraded', used_percent: 91.6, free_bytes: 12606226432 },
      gateway: { status: 'ok', state: 'running', connected_platforms: 1, platforms: 1 },
      background_queues: { status: 'ok', active_api_runs: 0, process_completions: 0, active_delegations: 0 },
    },
  },
  platform: 'hermes-agent',
  version: '0.20.0',
  gateway_state: 'running',
  platforms: { api_server: { state: 'connected', error_code: null, error_message: null, updated_at: '2026-08-15T23:50:23.907338+00:00' } },
  active_agents: 0,
  gateway_busy: false,
  gateway_drainable: true,
  exit_reason: null,
  updated_at: '2026-08-15T23:50:23.909098+00:00',
  pid: 273,
};

describe('evaluateHermesDetailedHealth', () => {
  it('判 ok 状态为健康', () => {
    expect(evaluateHermesDetailedHealth({ ...DEGRADED_DISK_PAYLOAD, status: 'ok' })).toBe(true);
  });

  it('判 degraded 状态为健康(磁盘压力降级不应砖掉 agent)', () => {
    expect(evaluateHermesDetailedHealth(DEGRADED_DISK_PAYLOAD)).toBe(true);
  });

  it('gateway_state 非 running 判不健康', () => {
    expect(evaluateHermesDetailedHealth({ ...DEGRADED_DISK_PAYLOAD, gateway_state: 'stopping' })).toBe(false);
  });

  it('api_server 未 connected 判不健康', () => {
    expect(
      evaluateHermesDetailedHealth({
        ...DEGRADED_DISK_PAYLOAD,
        platforms: { api_server: { state: 'connecting' } },
      }),
    ).toBe(false);
  });

  it('api_server 平台缺失判不健康', () => {
    expect(evaluateHermesDetailedHealth({ ...DEGRADED_DISK_PAYLOAD, platforms: {} })).toBe(false);
  });

  it('未知/错误 status 判不健康', () => {
    expect(evaluateHermesDetailedHealth({ ...DEGRADED_DISK_PAYLOAD, status: 'error' })).toBe(false);
    expect(evaluateHermesDetailedHealth({ ...DEGRADED_DISK_PAYLOAD, status: 'critical' })).toBe(false);
    // 旧版无 status 字段:保守判不健康(undefined !== ok|degraded)。
    const { status: _s, ...noStatus } = DEGRADED_DISK_PAYLOAD;
    expect(evaluateHermesDetailedHealth(noStatus as never)).toBe(false);
  });

  it('旧版 gateway_state 缺失 best-effort 放行(只看 api_server)', () => {
    const { gateway_state: _g, ...noGatewayState } = DEGRADED_DISK_PAYLOAD;
    expect(evaluateHermesDetailedHealth({ ...noGatewayState, status: 'ok' } as never)).toBe(true);
  });
});
