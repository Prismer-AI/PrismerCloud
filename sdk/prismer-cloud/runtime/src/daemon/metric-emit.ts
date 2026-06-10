// release201/11 §3.2 §4 — daemon-side metric emit helper.
//
// daemon 没有自己的 DB；上报路径是 `POST /api/im/metrics/batch`。
// 该 helper:
//
//   1. fire-and-forget 上报 (caller 不 await)，失败 silent — 永远不阻塞
//      dispatch 主流程
//   2. 自动注入 source / sourceId 在 cloud 端 (POST /metrics/batch 路由会
//      根据登录身份覆盖 source='daemon'，daemon 客户端不需要传)
//   3. 离线 fallback: cloud 不可达时,写一行到 per-agent metrics.jsonl
//      (release201/11 §7.0)。v2.0.8 引入的 metric-pump worker 会回放。
//
// 入参形态与 §3.1 metricEmit 对齐 — namespace/name/value/dims/ts。dims
// 必须含 workspaceId (cloud /batch 强制校验,缺失会被拒); 这里不重复校
// 验,把责任留给 cloud (一次真相)。
//
// Forbidden log patterns (§0.2.4):
//   - "[metric] queue dropped"
//   - "[metric] dim missing workspaceId"
// 本文件用中性 phrasing。

import type { CloudClient } from '../auth.js';
import type { ConfigPaths } from '../config.js';
import { appendAgentMetricOutbox } from './agent-outbox.js';

export interface DaemonMetricEmit {
  namespace: string;
  name: string;
  value?: number | string | null;
  dims: Record<string, string | number | boolean | null | undefined>;
  /** Business time (defaults to now on cloud side). */
  ts?: Date | string;
}

export interface DaemonMetricEmitContext {
  cloud: CloudClient;
  /** Per-agent outbox path resolution. Optional — when omitted, offline
   *  fallback is disabled (in-memory only). */
  paths?: ConfigPaths;
  daemonId?: string;
  agentImUserId?: string | null;
  /** Abort the emit when dispatch is reaper-killed; cloud retries on next
   *  dispatch via the outbox replay (v2.0.8 metric-pump). */
  signal?: AbortSignal;
}

function dimToSerialisable(
  dims: DaemonMetricEmit['dims'],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(dims)) {
    if (v === undefined) continue;
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Fire-and-forget batch emit. Returns the in-flight promise so tests can
 * await — production callers should NOT await (cloud round-trip would
 * delay dispatch.reply by ~1 RTT). The promise never rejects: cloud
 * failure falls through to outbox JSONL append.
 */
export function daemonMetricEmit(
  events: DaemonMetricEmit[],
  ctx: DaemonMetricEmitContext,
): Promise<void> {
  if (events.length === 0) return Promise.resolve();

  const sanitised = events.map((ev) => {
    const dims = dimToSerialisable(ev.dims);
    return {
      namespace: ev.namespace,
      name: ev.name,
      value: ev.value ?? undefined,
      dims,
      ts:
        ev.ts instanceof Date
          ? ev.ts.toISOString()
          : typeof ev.ts === 'string'
            ? ev.ts
            : undefined,
    };
  });

  return ctx.cloud
    .request('POST', '/api/im/metrics/batch', {
      body: { events: sanitised },
      signal: ctx.signal,
      timeoutMs: 5_000,
    })
    .then((res) => {
      if (res.ok) return;
      // Cloud unreachable / non-2xx — fall back to per-agent outbox so the
      // v2.0.8 metric-pump worker can replay. Without outbox ctx we can
      // only drop on the floor (best-effort by design).
      writeOutboxFallback(sanitised, ctx);
    })
    .catch(() => {
      writeOutboxFallback(sanitised, ctx);
    });
}

function writeOutboxFallback(
  events: Array<{
    namespace: string;
    name: string;
    value?: number | string | null;
    dims: Record<string, string | number | boolean | null>;
    ts?: string;
  }>,
  ctx: DaemonMetricEmitContext,
): void {
  if (!ctx.paths || !ctx.daemonId || !ctx.agentImUserId) return;
  for (const ev of events) {
    try {
      const workspaceId =
        typeof ev.dims.workspaceId === 'string' ? ev.dims.workspaceId : null;
      const projectId =
        typeof ev.dims.projectId === 'string' ? ev.dims.projectId : null;
      const taskId =
        typeof ev.dims.taskId === 'string' ? ev.dims.taskId : null;
      appendAgentMetricOutbox(ctx.paths, ctx.daemonId, ctx.agentImUserId, {
        eventType: `${ev.namespace}.${ev.name}`,
        workspaceId,
        projectId,
        taskId,
        ts: ev.ts,
        payload: {
          value: ev.value ?? null,
          dims: ev.dims,
        },
      });
    } catch {
      // Outbox write is best-effort — disk full / fs error is non-fatal.
    }
  }
}
