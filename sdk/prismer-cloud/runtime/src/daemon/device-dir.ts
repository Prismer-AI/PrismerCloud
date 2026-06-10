// release201/09 §9.1 — device 角色层根目录:
//   ~/.prismer/devices/<did>/
//     ├── device.json    ← daemon 元数据 (kind / hostname / started_at)
//     └── agents/<aid>/  ← 见 agent-dir.ts
//
// device.json 是 transfer 后目标 device 重建拓扑时的索引,也用于 admin debug
// pipeline 一次性把 device 元数据 surface 出来。本文件只负责 "device 自身"
// 这一层,不涉及 agents/<aid>/(那是 agent-dir.ts 的职责)。
//
// 落盘时机:daemon runner.start() 在 daemon_id 与 paths 解析完后立即调用
// `writeDeviceJson()`,确保任意 agent dir 在 device.json 之后才创建。
// 多次启动 idempotent — 覆盖写,因为 hostname 可能变 (sandbox pod 重排),
// started_at 必须反映本次进程而不是历史值。

import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import type { ConfigPaths } from '../config.js';

export type DeviceKind = 'k8s' | 'local' | 'edge';

export interface DeviceJson {
  daemonId: string;
  kind: DeviceKind;
  hostname: string;
  startedAt: string; // ISO 8601
  /**
   * v2.0.8 doc 20 Gap A (M448) — daemon-side echo of the workspace
   * `IMContainer.projectId` binding. NOT load-bearing for dispatch (per-agent
   * routing still wins, 09 §9.9); used only by admin debug pipeline to
   * surface "this device was provisioned scoped to project X" without
   * round-tripping to cloud. Daemon learns this via the optional
   * `PRISMER_DEVICE_PROJECT_ID` env (cloud-side injection deferred to
   * Phase A.2; today the field stays `null` and is harmless).
   */
  metadata?: { projectScope: string | null };
}

/**
 * Compose the per-device root: `devices/<did>/`.
 */
export function resolveDeviceDir(paths: ConfigPaths, daemonId: string): string {
  if (!daemonId) throw new Error('resolveDeviceDir: daemonId is required');
  return join(paths.devicesDir, daemonId);
}

/**
 * Create `devices/<did>/` and write `device.json`. Idempotent; safe to call
 * on every daemon boot. Errors throw — caller (runner.start) wraps in
 * try/catch so a malformed home dir doesn't kill startup.
 */
export function writeDeviceJson(
  paths: ConfigPaths,
  daemonId: string,
  opts: { kind?: DeviceKind; startedAt?: Date } = {},
): { dir: string; json: DeviceJson } {
  const dir = resolveDeviceDir(paths, daemonId);
  mkdirSync(dir, { recursive: true });
  const kind: DeviceKind = opts.kind ?? inferDeviceKind();
  // M448 — read projectScope from env so the cloud (Phase A.2) can wire it
  // in without breaking earlier daemons. Empty / missing → null (workspace-
  // level), matching the cloud DTO default. Non-empty strings are persisted
  // verbatim; cloud is authoritative and will not honour a daemon-side spoof
  // (cloud only ever filters by `im_containers.project_id`).
  const projectScopeEnv = process.env.PRISMER_DEVICE_PROJECT_ID?.trim();
  const projectScope = projectScopeEnv && projectScopeEnv.length > 0 ? projectScopeEnv : null;

  const json: DeviceJson = {
    daemonId,
    kind,
    hostname: osHostname(),
    startedAt: (opts.startedAt ?? new Date()).toISOString(),
    metadata: { projectScope },
  };
  writeFileSync(join(dir, 'device.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');
  return { dir, json };
}

/**
 * Best-effort device kind detection. K8S pods get `KUBERNETES_SERVICE_HOST`
 * injected; everything else defaults to `local`. `edge` is currently set
 * only via explicit opt-in (env override) — there's no automatic signal we
 * trust.
 */
function inferDeviceKind(): DeviceKind {
  if (process.env.PRISMER_DEVICE_KIND === 'k8s' || process.env.PRISMER_DEVICE_KIND === 'local' || process.env.PRISMER_DEVICE_KIND === 'edge') {
    return process.env.PRISMER_DEVICE_KIND;
  }
  if (process.env.KUBERNETES_SERVICE_HOST) return 'k8s';
  return 'local';
}
