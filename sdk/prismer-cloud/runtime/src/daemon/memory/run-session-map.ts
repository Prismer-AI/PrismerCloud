// v2.1 §9.5 — daemon-as-hook-intake: run_id ↔ conversationId mapping.
//
// Hermes shell hooks identify sessions only by `session_id = "run_<uuid>"`
// (see docs/release201/03-role-memory-and-standardization.md §9.5.6 live
// experiment payload). That id is allocated by Hermes when daemon calls
// POST /v1/runs and is NOT the cloud conversationId. To stamp memory
// pages with `sourceConversationId` (§4 MemorySourceStamp), the daemon
// hermes adapter registers (runId → context) here as soon as it parses
// `created.run_id`; the hook handler reverse-looks-up by runId.
//
// 60min GC purges stale rows on every register() so a long-tail straggler
// hook arriving after the run completes still resolves, but the table
// stays bounded.

import type { LocalDb } from '../../sync/store.js';

export interface RunSessionContext {
  runId: string;
  conversationId: string | null;
  taskId: string | null;
  agentImUserId: string;
  workspaceId: string;
  profileName: string;
  roleTemplateSlug: string | null;
  adapterName: string;
}

const GC_TTL_MS = 60 * 60 * 1000;

export class RunSessionRegistry {
  constructor(private readonly db: LocalDb) {}

  /**
   * Record a (runId → context) mapping. Idempotent INSERT OR REPLACE.
   * Also GCs rows older than GC_TTL_MS.
   */
  register(ctx: RunSessionContext): void {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_run_sessions
             (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
              profile_name, role_template_slug, adapter_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.runId,
          ctx.conversationId,
          ctx.taskId,
          ctx.agentImUserId,
          ctx.workspaceId,
          ctx.profileName,
          ctx.roleTemplateSlug,
          ctx.adapterName,
          now,
        );
      this.db
        .prepare('DELETE FROM local_run_sessions WHERE created_at < ?')
        .run(now - GC_TTL_MS);
    } catch (err) {
      process.stderr.write(
        `[run-session-map] register failed runId=${ctx.runId}: ${(err as Error).message}\n`,
      );
    }
  }

  /** Reverse lookup runId → context. Returns null if missing or GC'd. */
  lookup(runId: string): RunSessionContext | null {
    if (!runId) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
                  profile_name, role_template_slug, adapter_name
             FROM local_run_sessions
             WHERE run_id = ?`,
        )
        .get(runId) as
        | {
            run_id: string;
            conversation_id: string | null;
            task_id: string | null;
            agent_im_user_id: string;
            workspace_id: string;
            profile_name: string;
            role_template_slug: string | null;
            adapter_name: string;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        agentImUserId: row.agent_im_user_id,
        workspaceId: row.workspace_id,
        profileName: row.profile_name,
        roleTemplateSlug: row.role_template_slug,
        adapterName: row.adapter_name,
      };
    } catch (err) {
      process.stderr.write(
        `[run-session-map] lookup failed runId=${runId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /**
   * Reverse lookup by taskId. Returns the most recently registered row for
   * that task (a redispatched task can re-register with a new runId; we
   * want the latest hermes runId to forward approval to). Returns null
   * when no matching row exists.
   */
  lookupByTaskId(taskId: string): RunSessionContext | null {
    if (!taskId) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
                  profile_name, role_template_slug, adapter_name
             FROM local_run_sessions
             WHERE task_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
        )
        .get(taskId) as
        | {
            run_id: string;
            conversation_id: string | null;
            task_id: string | null;
            agent_im_user_id: string;
            workspace_id: string;
            profile_name: string;
            role_template_slug: string | null;
            adapter_name: string;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        agentImUserId: row.agent_im_user_id,
        workspaceId: row.workspace_id,
        profileName: row.profile_name,
        roleTemplateSlug: row.role_template_slug,
        adapterName: row.adapter_name,
      };
    } catch (err) {
      process.stderr.write(
        `[run-session-map] lookupByTaskId failed taskId=${taskId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /** Drop a single mapping (e.g. on session_end). Best-effort. */
  drop(runId: string): void {
    if (!runId) return;
    try {
      this.db.prepare('DELETE FROM local_run_sessions WHERE run_id = ?').run(runId);
    } catch {
      /* best-effort */
    }
  }
}

// ---- module-level singleton injection ------------------------------------
//
// The hermes adapter is statically imported and has no clean way to reach
// the daemon Runner's `db` handle (no DI container). We expose a thin
// module-level setter that runner.ts wires once at boot, and an accessor
// for the adapter to call.

let SINGLETON: RunSessionRegistry | null = null;

export function setRunSessionRegistry(reg: RunSessionRegistry | null): void {
  SINGLETON = reg;
}

export function getRunSessionRegistry(): RunSessionRegistry | null {
  return SINGLETON;
}
