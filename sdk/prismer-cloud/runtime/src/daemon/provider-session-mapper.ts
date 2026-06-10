// release202/05 C2 — generic per-(conversation × agent × adapter) provider
// session mapping for CLI / interactive adapters.
//
// CLI agents (codex / claude-code, kind:'interactive') currently dispatch
// amnesiacally — every turn starts a fresh provider/CLI session. This mapper
// gives them the same session-continuity primitive HermesSessionMapper gives
// the long-running hermes adapter: a cached (conversationId, agentImUserId,
// adapterName) → providerSessionId so the adapter can `resume` the prior
// provider session instead of re-bootstrapping context every turn.
//
// It is deliberately adapter-agnostic: providerSessionId is whatever id the
// provider hands back (codex thread_id, claude-code session id, ...). The
// triple is keyed on adapterName too so codex / claude-code sessions for the
// same (conversation, agent) stay isolated.
//
// Schema lives in `sync/store.ts` v8 migration (provider_session_id column on
// the existing local_run_sessions table). This module is the adapter-facing
// surface (get / put) and stays free of adapter internals so it can be
// unit-tested with an in-memory SQLite.

import type { LocalDb } from '../sync/store.js';

export class ProviderSessionMapper {
  constructor(private readonly db: LocalDb) {}

  /**
   * Look up the latest (conversation, agent, adapter) → providerSessionId
   * mapping. Returns null when no session has been persisted yet (first turn)
   * or on any read error.
   *
   * Reads the latest row (created_at DESC) so a stale row from an earlier
   * session that the provider forked/garbage-collected doesn't stick around
   * forever — the caller then starts a fresh session.
   */
  get(conversationId: string, agentImUserId: string, adapterName: string): string | null {
    if (!conversationId || !agentImUserId || !adapterName) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT provider_session_id
             FROM local_run_sessions
             WHERE conversation_id = ?
               AND agent_im_user_id = ?
               AND adapter_name = ?
               AND provider_session_id IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 1`,
        )
        .get(conversationId, agentImUserId, adapterName) as
        | { provider_session_id: string }
        | undefined;
      if (!row) return null;
      return row.provider_session_id;
    } catch (err) {
      process.stderr.write(
        `[provider-session-mapper] get failed conv=${conversationId} agent=${agentImUserId} adapter=${adapterName}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /**
   * Persist a (conversation, agent, adapter) → providerSessionId mapping. Uses
   * a synthetic run_id (`psession:<adapter>:<id>`) so the row satisfies the
   * existing PRIMARY KEY constraint on local_run_sessions; this row never
   * participates in the run_id → context reverse lookup used by shell hooks
   * (those queries gate on a real run_<uuid> string). Never throws.
   */
  put(
    conversationId: string,
    agentImUserId: string,
    adapterName: string,
    providerSessionId: string,
    opts?: { taskId?: string; workspaceId?: string },
  ): void {
    if (!conversationId || !agentImUserId || !adapterName || !providerSessionId) return;
    const syntheticRunId = `psession:${adapterName}:${providerSessionId}`;
    const now = Date.now();
    try {
      this.db
        .prepare(
          // profile_name is TEXT NOT NULL in the v5 schema, so we write '' (no
          // meaningful profile for a CLI provider-session row) rather than NULL.
          // role_template_slug is nullable → NULL.
          `INSERT OR REPLACE INTO local_run_sessions
             (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
              profile_name, role_template_slug, adapter_name, created_at,
              provider_session_id)
           VALUES (?, ?, ?, ?, ?, '', NULL, ?, ?, ?)`,
        )
        .run(
          syntheticRunId,
          conversationId,
          opts?.taskId ?? null,
          agentImUserId,
          opts?.workspaceId ?? '',
          adapterName,
          now,
          providerSessionId,
        );
    } catch (err) {
      process.stderr.write(
        `[provider-session-mapper] put failed conv=${conversationId} adapter=${adapterName} session=${providerSessionId}: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * Forget the (conversation, agent, adapter) → provider_session_id mapping.
   * Called when a `resume` fails because the provider's rollout/session is gone
   * (e.g. GC'd, or stored under a different CODEX_HOME) so the next dispatch
   * starts a fresh session instead of looping on a dead session id.
   */
  clear(conversationId: string, agentImUserId: string, adapterName: string): void {
    if (!conversationId || !agentImUserId || !adapterName) return;
    try {
      this.db
        .prepare(
          `DELETE FROM local_run_sessions
             WHERE conversation_id = ? AND agent_im_user_id = ? AND adapter_name = ?
               AND provider_session_id IS NOT NULL`,
        )
        .run(conversationId, agentImUserId, adapterName);
    } catch (err) {
      process.stderr.write(
        `[provider-session-mapper] clear failed conv=${conversationId} adapter=${adapterName}: ${(err as Error).message}\n`,
      );
    }
  }
}

// ---- module-level singleton injection ------------------------------------
//
// Same pattern as HermesSessionMapper — CLI adapters are statically imported
// and have no DI handle into the daemon Runner's `db`. Runner constructs the
// mapper at boot and registers it here; adapter consumers read via
// getProviderSessionMapper(). Returns null when no daemon is running
// (tests / standalone) — adapters then dispatch without resume.

let _mapper: ProviderSessionMapper | null = null;

export function setProviderSessionMapper(m: ProviderSessionMapper | null): void {
  _mapper = m;
}

export function getProviderSessionMapper(): ProviderSessionMapper | null {
  return _mapper;
}
