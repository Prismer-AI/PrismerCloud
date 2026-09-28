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
  /** Provider-owned conversation/session id for this exact native run. */
  providerSessionId?: string | null;
  conversationId: string | null;
  taskId: string | null;
  messageId?: string | null;
  agentImUserId: string;
  workspaceId: string;
  profileId?: string | null;
  profileName: string;
  roleTemplateSlug: string | null;
  adapterName: string;
  /** Configured routing intent captured when the run starts. */
  model?: string | null;
  proxyProvider?: string | null;
  /** Terminal response evidence, written only after the adapter completes SSE. */
  servedModel?: string | null;
  servedProvider?: string | null;
  routingEvidenceSource?: 'adapter' | null;
}

const GC_TTL_MS = 60 * 60 * 1000;

// release203/15c §4 — in-flight window for lookupActiveByAgent(). A dispatch's
// `cloud deliver` fires within the same dispatch, seconds-to-minutes after the
// run registers; 15min is a conservative window that covers long runs while
// avoiding reverse-lookup onto a stale, already-finished run.
const ACTIVE_TTL_MS = 15 * 60 * 1000;

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
              profile_name, role_template_slug, adapter_name, created_at,
              message_id, profile_id, model, proxy_provider,
              served_model, served_provider, routing_evidence_source,
              provider_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ctx.messageId ?? null,
          ctx.profileId ?? null,
          ctx.model ?? null,
          ctx.proxyProvider ?? null,
          ctx.servedModel ?? null,
          ctx.servedProvider ?? null,
          ctx.routingEvidenceSource ?? null,
          ctx.providerSessionId ?? null,
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
                  profile_name, role_template_slug, adapter_name,
                  message_id, profile_id, model, proxy_provider,
                  served_model, served_provider, routing_evidence_source,
                  provider_session_id
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
            message_id: string | null;
            profile_id: string | null;
            model: string | null;
            proxy_provider: string | null;
            served_model: string | null;
            served_provider: string | null;
            routing_evidence_source: string | null;
            provider_session_id: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        providerSessionId: row.provider_session_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        messageId: row.message_id,
        agentImUserId: row.agent_im_user_id,
        workspaceId: row.workspace_id,
        profileId: row.profile_id,
        profileName: row.profile_name,
        roleTemplateSlug: row.role_template_slug,
        adapterName: row.adapter_name,
        model: row.model,
        proxyProvider: row.proxy_provider,
        servedModel: row.served_model,
        servedProvider: row.served_provider,
        routingEvidenceSource: row.routing_evidence_source === 'adapter' ? 'adapter' : null,
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
                  profile_name, role_template_slug, adapter_name,
                  message_id, profile_id, model, proxy_provider,
                  served_model, served_provider, routing_evidence_source,
                  provider_session_id
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
            message_id: string | null;
            profile_id: string | null;
            model: string | null;
            proxy_provider: string | null;
            served_model: string | null;
            served_provider: string | null;
            routing_evidence_source: string | null;
            provider_session_id: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        runId: row.run_id,
        providerSessionId: row.provider_session_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        messageId: row.message_id,
        agentImUserId: row.agent_im_user_id,
        workspaceId: row.workspace_id,
        profileId: row.profile_id,
        profileName: row.profile_name,
        roleTemplateSlug: row.role_template_slug,
        adapterName: row.adapter_name,
        model: row.model,
        proxyProvider: row.proxy_provider,
        servedModel: row.served_model,
        servedProvider: row.served_provider,
        routingEvidenceSource: row.routing_evidence_source === 'adapter' ? 'adapter' : null,
      };
    } catch (err) {
      process.stderr.write(
        `[run-session-map] lookupByTaskId failed taskId=${taskId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /**
   * release203/15c WS-E3 — reverse-lookup the agent's CURRENT in-flight
   * dispatch by agent identity (NOT runId). Used by the deliver proxy when a
   * hermes agent runs `cloud deliver` with no `--run-id` (hermes has no
   * per-dispatch env — §1.2/§2): the daemon auto-completes taskId(=runId)/
   * conversationId from the most-recently-registered active row for that agent.
   *
   * Race-safety (§5): rows are narrowed by `adapterName` and, when supplied,
   * `conversationId` (sessions path serialises one hermes session per
   * (conversation, agent), so a conversation-narrowed lookup is unambiguous).
   * Only rows within `ttlMs` of now (the in-flight window) are considered.
   *
   * Returns:
   *   - null              → 0 active rows (caller keeps the "pass --run-id" 400)
   *   - RunSessionContext → exactly 1 active row (auto-complete)
   *   - { ambiguous }     → >1 active row with no narrowing key → caller returns
   *                         409, NEVER silently mis-attaches.
   */
  lookupActiveByAgent(
    agentImUserId: string,
    opts?: {
      adapterName?: string;
      conversationId?: string;
      ttlMs?: number;
      /** Exclude continuity-cache rows while retaining other task-less artifact rows. */
      excludeProviderCacheRows?: boolean;
    },
  ): RunSessionContext | { ambiguous: true; candidates: RunSessionContext[] } | null {
    if (!agentImUserId) return null;
    const ttlMs = opts?.ttlMs ?? ACTIVE_TTL_MS;
    const cutoff = Date.now() - ttlMs;
    try {
      const where: string[] = ['agent_im_user_id = ?', 'created_at > ?'];
      const params: unknown[] = [agentImUserId, cutoff];
      if (opts?.adapterName) {
        where.push('adapter_name = ?');
        params.push(opts.adapterName);
      }
      if (opts?.conversationId) {
        where.push('conversation_id = ?');
        params.push(opts.conversationId);
      }
      if (opts?.excludeProviderCacheRows) {
        // Provider continuity cache rows are identified by their explicit
        // provider-session columns, not merely task_id=NULL: desktop artifact
        // journeys intentionally use other task-less rows as real run folders.
        where.push('NOT (task_id IS NULL AND (hermes_session_id IS NOT NULL OR provider_session_id IS NOT NULL))');
      }
      const rows = this.db
        .prepare(
          `SELECT run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
                  profile_name, role_template_slug, adapter_name,
                  message_id, profile_id, model, proxy_provider,
                  served_model, served_provider, routing_evidence_source,
                  provider_session_id
             FROM local_run_sessions
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC`,
        )
        .all(...params) as Array<{
        run_id: string;
        conversation_id: string | null;
        task_id: string | null;
        agent_im_user_id: string;
        workspace_id: string;
        profile_name: string;
        role_template_slug: string | null;
        adapter_name: string;
        message_id: string | null;
        profile_id: string | null;
        model: string | null;
        proxy_provider: string | null;
        served_model: string | null;
        served_provider: string | null;
        routing_evidence_source: string | null;
        provider_session_id: string | null;
      }>;
      if (rows.length === 0) return null;
      const toCtx = (row: (typeof rows)[number]): RunSessionContext => ({
        runId: row.run_id,
        providerSessionId: row.provider_session_id,
        conversationId: row.conversation_id,
        taskId: row.task_id,
        messageId: row.message_id,
        agentImUserId: row.agent_im_user_id,
        workspaceId: row.workspace_id,
        profileId: row.profile_id,
        profileName: row.profile_name,
        roleTemplateSlug: row.role_template_slug,
        adapterName: row.adapter_name,
        model: row.model,
        proxyProvider: row.proxy_provider,
        servedModel: row.served_model,
        servedProvider: row.served_provider,
        routingEvidenceSource: row.routing_evidence_source === 'adapter' ? 'adapter' : null,
      });
      // Multiple distinct runs in flight with no conversation narrowing →
      // ambiguous. Collapse to distinct run_ids so a single run re-registered
      // (e.g. session-key backfill) doesn't read as a false collision.
      const distinct = new Map<string, RunSessionContext>();
      for (const row of rows) {
        if (!distinct.has(row.run_id)) distinct.set(row.run_id, toCtx(row));
      }
      const candidates = [...distinct.values()];
      if (candidates.length > 1) {
        return { ambiguous: true, candidates };
      }
      return candidates[0]!;
    } catch (err) {
      process.stderr.write(
        `[run-session-map] lookupActiveByAgent failed agent=${agentImUserId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /** Resolve a provider lifecycle hook onto one real dispatch, never a cache row. */
  lookupByProviderSession(providerSessionId: string): RunSessionContext | null {
    if (!providerSessionId) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT run_id
             FROM local_run_sessions
            WHERE provider_session_id = ?
              AND run_id NOT LIKE 'session:%'
              AND run_id NOT LIKE 'psession:%'
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(providerSessionId) as { run_id: string } | undefined;
      return row ? this.lookup(row.run_id) : null;
    } catch (err) {
      process.stderr.write(
        `[run-session-map] lookupByProviderSession failed: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /**
   * Stamp terminal served routing after the adapter has consumed the provider
   * lifecycle stream. Configured model/proxyProvider are intentionally left
   * untouched and can never satisfy the terminal-evidence gate.
   */
  recordTerminalRouting(
    runId: string,
    evidence: {
      servedModel?: string | null;
      servedProvider?: string | null;
      routingEvidenceSource: 'adapter';
    },
  ): void {
    if (!runId) return;
    const servedModel = evidence.servedModel?.trim() || null;
    const servedProvider = evidence.servedProvider?.trim() || null;
    if (!servedModel || !servedProvider) return;
    try {
      this.db
        .prepare(
          `UPDATE local_run_sessions
              SET served_model = COALESCE(?, served_model),
                  served_provider = COALESCE(?, served_provider),
                  routing_evidence_source = ?
            WHERE run_id = ?`,
        )
        .run(
          servedModel,
          servedProvider,
          evidence.routingEvidenceSource,
          runId,
        );
    } catch (err) {
      process.stderr.write(
        `[run-session-map] terminal routing update failed runId=${runId}: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * Stamp terminal routing on the exact real run bound to a provider session.
   * Returns false for unknown sessions; it never falls back to agent identity.
   */
  recordTerminalRoutingByProviderSession(
    providerSessionId: string,
    evidence: {
      servedModel?: string | null;
      servedProvider?: string | null;
      routingEvidenceSource: 'adapter';
    },
  ): boolean {
    if (!providerSessionId) return false;
    const servedModel = evidence.servedModel?.trim() || null;
    const servedProvider = evidence.servedProvider?.trim() || null;
    if (!servedModel || !servedProvider) return false;
    try {
      const result = this.db
        .prepare(
          `UPDATE local_run_sessions
              SET served_model = ?, served_provider = ?, routing_evidence_source = ?
            WHERE run_id = (
              SELECT run_id
                FROM local_run_sessions
               WHERE provider_session_id = ?
                 AND run_id NOT LIKE 'session:%'
                 AND run_id NOT LIKE 'psession:%'
               ORDER BY created_at DESC
               LIMIT 1
            )`,
        )
        .run(
          servedModel,
          servedProvider,
          evidence.routingEvidenceSource,
          providerSessionId,
        );
      return result.changes === 1;
    } catch (err) {
      process.stderr.write(
        `[run-session-map] terminal routing update by provider session failed: ${(err as Error).message}\n`,
      );
      return false;
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
