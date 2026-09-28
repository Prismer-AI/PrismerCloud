// release201/09 §9.1 — agent-level outbox JSONL writers.
//
// `devices/<did>/agents/<aid>/artifacts/` 持有两条 per-agent append-only 流:
//
//   sync.jsonl     ← memory write outbox + skill ack outbox 的 agent 子集
//                    (与 daemon-level `local.db` 不冲突 — local.db 仍是
//                     daemon 级 SyncQueue 真相源,本文件只 mirror 出 agent
//                     视角的子集,方便 transfer + 离线 debug)
//
//   metrics.jsonl  ← release201/11 §7.0 — agent-level metric 落盘
//                    (S2 现在直接 POST cloud /api/im/metrics;本 PR 引入
//                     本地落盘 + flush loop hook,留出离线 buffer 能力。
//                     上 cloud 的实际批量 flush 留给 metric.service 或后
//                     续 metric-pump worker — 本文件只负责 *写*。)
//
// 设计要点:
//   - **Append-only** — 永不 mutate 已有行,避免与并发 reader 抢锁。
//   - **One JSON object per line**,标准 NDJSON,可直接喂 jq / `cat | wc -l`。
//   - **Atomic write** — 每行单次 `appendFileSync` 调用,Node fs 在常见
//     OS 上对 < PIPE_BUF (4 KiB) 的单 write 保证原子性。超长行 (>4KiB)
//     仍是 best-effort,行内 partial-write 不会影响其它行边界。
//   - **不做 rotation** — v2.0.7 不引入 logrotate;v2.0.8 评估 (与 11 doc
//     metric-pump worker 协调:flush 成功后 truncate)。本 PR 只确保单文件
//     1 GiB 内顺畅 append。
//   - **不开 fd 缓存** — 每次调用 open + write + close。低频 (metric per
//     dispatch + sync per memory write,日数千级别);开销可忽略,但避免
//     fd 泄漏更重要。
//
// 与 daemon-level local.db 的关系:
//   - local.db 是 SyncQueue 真相源,daemon 重启后 rehydrate 用。
//   - sync.jsonl 是 *镜像快照*,transfer tar 时随 agent 走;新 device 收
//     到 tar 后,sync.jsonl 用于补齐 cloud 端缺失的 memory write 事件,
//     不依赖 local.db (那是 daemon-level,不进 tar)。
//   - 写入路径:memory write / skill ack 时,SyncQueue.push() 旁路写一份
//     到 agent sync.jsonl (本 PR 留 hook,实际接入随 v2.0.8 memory cache
//     完整化)。

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveAgentDirPaths, type AgentDirPaths } from './agent-dir.js';
import type { ConfigPaths } from '../config.js';

export type AgentSyncOutboxKind =
  | 'memory.write'
  | 'memory.invalidate'
  | 'skill.ack'
  | 'skill.uninstall';

export interface AgentSyncOutboxEntry {
  kind: AgentSyncOutboxKind;
  ts: string; // ISO 8601
  payload: Record<string, unknown>;
}

export interface AgentMetricOutboxEntry {
  kind: 'metric.event';
  ts: string;
  /** Numeric or stringly-typed event name; matches IMMetricEvent.eventType. */
  eventType: string;
  /** Workspace + project + task scope mirrored from §9.9 env. */
  workspaceId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  /** Free-form payload (dispatch latency / token cost / approval count ...). */
  payload: Record<string, unknown>;
}

/** Ensure outbox dir exists before append. mkdir is cheap; outbox is single-dir. */
function ensureOutboxDirFor(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function appendLine(file: string, obj: unknown): void {
  ensureOutboxDirFor(file);
  appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Append one entry to `devices/<did>/agents/<aid>/artifacts/sync.jsonl`.
 *
 * `ts` is auto-stamped from process clock if not in entry. Caller must
 * provide kind + payload; this helper does NOT validate payload shape
 * (the cloud-side intake validates on flush).
 */
export function appendAgentSyncOutbox(
  paths: ConfigPaths,
  daemonId: string,
  agentImUserId: string,
  entry: Omit<AgentSyncOutboxEntry, 'ts'> & { ts?: string },
): void {
  const dirs = resolveAgentDirPaths(paths, daemonId, agentImUserId);
  const out: AgentSyncOutboxEntry = {
    kind: entry.kind,
    ts: entry.ts ?? new Date().toISOString(),
    payload: entry.payload,
  };
  appendLine(dirs.syncOutboxFile, out);
}

/**
 * Append one metric event to `devices/<did>/agents/<aid>/artifacts/metrics.jsonl`.
 *
 * release201/11 §7.0 — metric-outbox is per-agent JSONL on disk. The actual
 * cloud flush is owned by the metric-pump worker (v2.0.8); this PR only
 * lands the write-side so dispatch loop / heartbeat / step recorder can
 * start emitting now without waiting on the worker.
 */
export function appendAgentMetricOutbox(
  paths: ConfigPaths,
  daemonId: string,
  agentImUserId: string,
  entry: Omit<AgentMetricOutboxEntry, 'kind' | 'ts'> & { ts?: string },
): void {
  const dirs = resolveAgentDirPaths(paths, daemonId, agentImUserId);
  const out: AgentMetricOutboxEntry = {
    kind: 'metric.event',
    ts: entry.ts ?? new Date().toISOString(),
    eventType: entry.eventType,
    workspaceId: entry.workspaceId ?? null,
    projectId: entry.projectId ?? null,
    taskId: entry.taskId ?? null,
    payload: entry.payload,
  };
  appendLine(dirs.metricsOutboxFile, out);
}

/**
 * Best-effort size probe for transfer manifest authoring. Returns 0 when
 * the file doesn't exist yet (agent never emitted), so manifest authors
 * can safely include the path regardless.
 */
export function agentOutboxSize(dirs: AgentDirPaths): { sync: number; metrics: number } {
  return {
    sync: safeSize(dirs.syncOutboxFile),
    metrics: safeSize(dirs.metricsOutboxFile),
  };
}

function safeSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
