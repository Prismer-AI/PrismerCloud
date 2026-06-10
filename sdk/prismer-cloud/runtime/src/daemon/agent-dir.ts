// release201/09 §9.1 — agent 角色层目录:
//   ~/.prismer/devices/<did>/agents/<aid>/
//     ├── profile.json         ← role template + operating principles 快照
//     ├── skills/<slug>/       ← per-agent skill manifest (替换 profile-driven
//     │                          skillsDir;修 latent multi-agent skill 冲突)
//     ├── memory/              ← agent-private memory cache (v2.1+ 才会落地)
//     │   ├── _global/          ← NULL projectId 的 agent-private
//     │   └── projects/<pid>/   ← project × agent-private
//     ├── artifacts/           ← agent-level append-only streams (release202/04:
//     │   ├── sync.jsonl        ← renamed from outbox/; memory write + skill ack
//     │   └── metrics.jsonl     ← release201/11 §7.0 per-agent metric stream
//     └── transfer-manifest.json ← 仅 `prismer agent export` 时存在
//
// 本文件负责把目录骨架立起来 + profile.json 落盘 + artifacts/sync.jsonl 的轻
// 量写入 helper。memory/ 子目录是 stub(v2.1+ 才有实现),但骨架先建好让
// agent transfer tar 时能整体打包不需要补结构。
//
// 不在本文件:
//   - skill 文件本身的同步 → skill-sync.ts (本 PR 改 resolveSkillsRoot 调用)
//   - metric-outbox JSONL 的具体写入逻辑 → agent-outbox.ts
//   - transfer-manifest 生成 → SDK CLI (sdk/prismer-cloud/typescript/.../agent.ts)
//
// Forbidden(§9.7.1 D10):cache/ + local.db 永远不进 agent transfer 单元;
// 它们是 daemon-level 共享池,blob 走 content-hash dedup 重 fetch。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDeviceAgentDir, type ConfigPaths } from '../config.js';

/**
 * Profile snapshot persisted to disk so:
 *  - debug / transfer 不依赖 cloud 在线
 *  - reaper / hook server reverse-lookup 可以读本机文件而非 round-trip cloud
 *  - 用户 grep `~/.prismer/devices/<did>/agents/<aid>/profile.json` 一眼看出每个
 *    device 上有哪些 agent + role template
 *
 * Schema 故意宽松 (Record<string, unknown>) — 不同 adapter 的 config shape
 * 不同,profile.json 是快照而非 contract,后续读者按 adapter 自己 parse。
 */
export interface AgentProfileSnapshot {
  agentId: string;
  agentImUserId: string;
  agentUsername?: string | null;
  workspaceId: string;
  adapterName: string;
  name: string;
  /** Role template slug / agentType / etc — adapter-specific bag from profile.config */
  config: Record<string, unknown>;
  /** Last-known operating principles (string form composed by cloud or adapter). */
  operatingPrinciples?: string | null;
  /** ISO 8601; rewritten on every sync. */
  snapshotAt: string;
}

export interface AgentDirPaths {
  /** `devices/<did>/agents/<aid>/` */
  root: string;
  /** `devices/<did>/agents/<aid>/profile.json` */
  profileFile: string;
  /** `devices/<did>/agents/<aid>/skills/` */
  skillsDir: string;
  /** `devices/<did>/agents/<aid>/memory/` */
  memoryDir: string;
  /** `devices/<did>/agents/<aid>/artifacts/` (release202/04 — renamed from outbox/) */
  artifactsDir: string;
  /** `devices/<did>/agents/<aid>/artifacts/sync.jsonl` */
  syncOutboxFile: string;
  /** `devices/<did>/agents/<aid>/artifacts/metrics.jsonl` */
  metricsOutboxFile: string;
  /** `devices/<did>/agents/<aid>/transfer-manifest.json` (existence implies export) */
  transferManifestFile: string;
}

export function resolveAgentDirPaths(
  paths: ConfigPaths,
  daemonId: string,
  agentImUserId: string,
): AgentDirPaths {
  const root = resolveDeviceAgentDir(paths, daemonId, agentImUserId);
  return {
    root,
    profileFile: join(root, 'profile.json'),
    skillsDir: join(root, 'skills'),
    memoryDir: join(root, 'memory'),
    artifactsDir: join(root, 'artifacts'),
    syncOutboxFile: join(root, 'artifacts', 'sync.jsonl'),
    metricsOutboxFile: join(root, 'artifacts', 'metrics.jsonl'),
    transferManifestFile: join(root, 'transfer-manifest.json'),
  };
}

/**
 * Idempotent — mkdir -p the agent dir + 4 子目录。Caller MUST already have
 * created `devices/<did>/device.json` (via device-dir.ts:writeDeviceJson)。
 */
export function ensureAgentDir(
  paths: ConfigPaths,
  daemonId: string,
  agentImUserId: string,
): AgentDirPaths {
  const dirs = resolveAgentDirPaths(paths, daemonId, agentImUserId);
  mkdirSync(dirs.root, { recursive: true });
  mkdirSync(dirs.skillsDir, { recursive: true });
  mkdirSync(dirs.memoryDir, { recursive: true });
  // memory/ 内部 _global / projects/ 的子结构由 v2.1+ memory 模块自己负责创建。
  mkdirSync(dirs.artifactsDir, { recursive: true });
  return dirs;
}

/**
 * Write `profile.json` (overwrite). Caller decides what to put in `config`
 * — usually the adapter-specific bag verbatim from cloud `IMAgentProfile`.
 *
 * Errors throw; daemon-side caller catches + logs (snapshot is best-effort
 * and must not break dispatch).
 */
export function writeAgentProfileSnapshot(
  paths: ConfigPaths,
  daemonId: string,
  snapshot: AgentProfileSnapshot,
): AgentDirPaths {
  const dirs = ensureAgentDir(paths, daemonId, snapshot.agentImUserId);
  writeFileSync(
    dirs.profileFile,
    JSON.stringify(snapshot, null, 2) + '\n',
    'utf8',
  );
  return dirs;
}
