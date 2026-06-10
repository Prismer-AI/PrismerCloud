// ~/.prismer/config.toml load/save. zod-validated. See 04-daemon-runtime §启动流程.

import * as TOML from '@iarna/toml';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z.object({
  /** API key from `prismer setup`, or env override. */
  api_key: z.string().min(1),
  /** Cloud REST + WS base; `ws://` is derived by stripping `http`. */
  cloud_api_base: z.string().url(),
  /** Stable per-machine daemon identifier. Generated once on first setup. */
  daemon_id: z.string().min(1),
  /** Optional adapter-specific overrides keyed by adapter name. */
  adapters: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  /** Local daemon shell execution. Default disabled. */
  shell: z
    .object({
      enabled: z.boolean().default(false),
      default_cwd: z.string().optional(),
      defaultCwd: z.string().optional(),
      shell: z.enum(['bash', 'zsh', 'sh']).optional(),
      max_timeout_ms: z.number().int().positive().optional(),
      maxTimeoutMs: z.number().int().positive().optional(),
      max_output_bytes: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
      allowed_workspaces: z.array(z.string()).optional(),
      allowedWorkspaces: z.array(z.string()).optional(),
    })
    .optional(),
  /** Local cache settings. */
  cache: z
    .object({
      max_bytes: z.number().int().positive().default(5 * 1024 * 1024 * 1024),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ConfigPaths {
  /** Default `~/.prismer`. */
  root: string;
  configFile: string;
  localDb: string;
  cacheDir: string;
  logsDir: string;
  /**
   * Legacy per-task run scratch dirs (pre-release201/09).
   *
   * Pre-09: `${runsDir}/${taskId}/_outbox|scratch/`.
   * 09 Phase 2 / release202/04: dispatch.ts now writes to
   *   `${root}/workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/{artifacts,scratch}`
   * via `resolveTaskWorkdir()`. `runsDir` is kept as a fallback for tests + a
   * once-off startup migration helper (`runs/<tid>/` → new path; symlink 兜底
   * 90 天兼容期, §9.3.1).
   */
  runsDir: string;
  /**
   * release201/09 Phase 2 root for workspace × project × task scoped scratch:
   * `${root}/workspaces/`. resolveTaskWorkdir() composes the per-task path
   * underneath. Cache GC + project archive scan this root.
   */
  workspacesDir: string;
  /**
   * release201/09 Phase 2 root for device × agent role layer:
   * `${root}/devices/`. v2.0.7 Phase 2 不主动创建,Phase 3 (agent transfer)
   * 才落盘 `profile.json` / `skills/<slug>/` 等内容,本 helper 只解析路径。
   */
  devicesDir: string;
}

/**
 * Resolve paths for the prismer home directory. Honors `PRISMER_HOME` env var;
 * defaults to `~/.prismer`.
 */
export function resolvePaths(home?: string): ConfigPaths {
  const root = home ?? process.env.PRISMER_HOME ?? join(homedir(), '.prismer');
  return {
    root,
    configFile: join(root, 'config.toml'),
    localDb: join(root, 'local.db'),
    cacheDir: join(root, 'cache'),
    logsDir: join(root, 'logs'),
    runsDir: join(root, 'runs'),
    workspacesDir: join(root, 'workspaces'),
    devicesDir: join(root, 'devices'),
  };
}

/**
 * Sentinel used for `projectId IS NULL` tasks (release201/09 §9.6.2).
 *
 * Selected over `_global` to avoid clashing with the `_global` subdir under
 * agent-private memory cache. Cloud + daemon agree on the literal string.
 */
export const UNSCOPED_PROJECT_SENTINEL = '_unscoped';

/**
 * Compose the per-task scratch directory under the new
 * `workspaces/<wid>/projects/<pid|_unscoped>/tasks/<tid>/` layout
 * (release201/09 §9.1; release202/04 §3.1). Caller picks whether to append
 * `artifacts/` or `scratch/`; this helper returns the parent path so both
 * children share a single mkdir + cleanup unit.
 *
 * `projectId` accepts `null | undefined` (NULL projectId case) and folds
 * them into `_unscoped`. Empty string is treated the same — defensive
 * because some callers pass `task.projectId ?? ''`.
 */
export function resolveTaskWorkdir(
  paths: ConfigPaths,
  workspaceId: string,
  projectId: string | null | undefined,
  taskId: string,
): string {
  if (!workspaceId) throw new Error('resolveTaskWorkdir: workspaceId is required');
  if (!taskId) throw new Error('resolveTaskWorkdir: taskId is required');
  const pid = projectId && projectId.length > 0 ? projectId : UNSCOPED_PROJECT_SENTINEL;
  return join(paths.workspacesDir, workspaceId, 'projects', pid, 'tasks', taskId);
}

/**
 * Derive the stable session id (`sid`) for a dispatch (release202/04 §3.1, P1).
 *
 * Design decision: `sid` must be derivable at dispatch time — BEFORE any
 * adapter runs — and stable per conversation. We therefore use the dispatch's
 * `conversationId` directly (a conversation = a session scope). We deliberately
 * do NOT use the hermes `hermesSessionId` from `local_run_sessions`: that id is
 * created lazily by the hermes adapter AFTER dispatch starts and is
 * adapter-specific, so it can't anchor the on-disk scope for every adapter.
 *
 * Returns the conversationId verbatim (already a stable cuid) when present, or
 * `null` when the dispatch has no conversation (pure kanban task /
 * agent-to-agent with no conversation) — in which case the caller falls back to
 * the plain `tasks/<tid>/` layout (no session layer).
 */
export function deriveSessionId(conversationId: string | null | undefined): string | null {
  if (typeof conversationId === 'string' && conversationId.length > 0) {
    return conversationId;
  }
  return null;
}

/**
 * Compose the session-scope directory under the new layout
 * (release202/04 §3.1, P1):
 *   `workspaces/<wid>/projects/<pid|_unscoped>/sessions/<sid>/`
 *
 * Caller appends `artifacts/`, `scratch/`, or `tasks/<tid>/`. The session dir
 * holds cross-turn deliverables (`artifacts/`) and intermediate work
 * (`scratch/`); the per-turn task dir nests underneath via
 * `resolveSessionTaskWorkdir`.
 *
 * `projectId` folds `null | undefined | ''` into `_unscoped` (same rule as
 * `resolveTaskWorkdir`).
 */
export function resolveSessionDir(
  paths: ConfigPaths,
  workspaceId: string,
  projectId: string | null | undefined,
  sessionId: string,
): string {
  if (!workspaceId) throw new Error('resolveSessionDir: workspaceId is required');
  if (!sessionId) throw new Error('resolveSessionDir: sessionId is required');
  const pid = projectId && projectId.length > 0 ? projectId : UNSCOPED_PROJECT_SENTINEL;
  return join(paths.workspacesDir, workspaceId, 'projects', pid, 'sessions', sessionId);
}

/**
 * Compose the per-task workdir nested under a session
 * (release202/04 §3.1, P1):
 *   `workspaces/<wid>/projects/<pid|_unscoped>/sessions/<sid>/tasks/<tid>/`
 *
 * Used when a dispatch carries a conversationId. The task `artifacts/` here is
 * what the ArtifactsWatcher scans + auto-attaches to THIS turn's reply; the
 * parent session `artifacts/` (from `resolveSessionDir`) is cross-turn retained
 * and attached on demand only.
 *
 * When the dispatch has NO conversationId, callers use `resolveTaskWorkdir`
 * (plain `tasks/<tid>/`, no session layer) for backward compatibility.
 */
export function resolveSessionTaskWorkdir(
  paths: ConfigPaths,
  workspaceId: string,
  projectId: string | null | undefined,
  sessionId: string,
  taskId: string,
): string {
  if (!taskId) throw new Error('resolveSessionTaskWorkdir: taskId is required');
  return join(resolveSessionDir(paths, workspaceId, projectId, sessionId), 'tasks', taskId);
}

/**
 * Compose the per-agent device directory: `devices/<did>/agents/<aid>/`
 * (release201/09 §9.1). Used by future Phase 3 (`profile.json` / `skills/`
 * / `memory/` / `artifacts/`); Phase 2 only needs this resolver for tests +
 * the migration helper symlink unit.
 */
export function resolveDeviceAgentDir(
  paths: ConfigPaths,
  daemonId: string,
  agentImUserId: string,
): string {
  if (!daemonId) throw new Error('resolveDeviceAgentDir: daemonId is required');
  if (!agentImUserId) throw new Error('resolveDeviceAgentDir: agentImUserId is required');
  return join(paths.devicesDir, daemonId, 'agents', agentImUserId);
}

export function configExists(paths: ConfigPaths = resolvePaths()): boolean {
  return existsSync(paths.configFile);
}

/**
 * Read and validate config. Env vars override file values for `api_key` and
 * `cloud_api_base` (handy in CI / dev without rewriting config.toml).
 */
export function loadConfig(paths: ConfigPaths = resolvePaths()): Config {
  if (!existsSync(paths.configFile)) {
    throw new Error(
      `Config not found at ${paths.configFile}. Run \`prismer setup\` to create it.`,
    );
  }
  const raw = readFileSync(paths.configFile, 'utf8');
  const parsed = TOML.parse(raw) as Record<string, unknown>;

  const merged = {
    ...parsed,
    api_key: process.env.PRISMER_API_KEY ?? (parsed.api_key as string | undefined),
    cloud_api_base: process.env.PRISMER_BASE_URL ?? (parsed.cloud_api_base as string | undefined),
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid config at ${paths.configFile}: ${detail}`);
  }
  return result.data;
}

export function saveConfig(config: Config, paths: ConfigPaths = resolvePaths()): void {
  if (!existsSync(paths.root)) {
    mkdirSync(paths.root, { recursive: true });
  }
  if (!existsSync(dirname(paths.configFile))) {
    mkdirSync(dirname(paths.configFile), { recursive: true });
  }
  // Validate before writing — refuse to persist garbage.
  ConfigSchema.parse(config);
  writeFileSync(paths.configFile, TOML.stringify(config as unknown as TOML.JsonMap), 'utf8');
}

/** Derive a `wss?://` URL from a `https?://` base. Trailing `/ws` appended. */
export function deriveWsUrl(httpBase: string): string {
  const u = new URL(httpBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws';
  return u.toString();
}
