// release201/25 §16.4 A1.2 — hermes session mapping.
//
// Each (conversationId, agentImUserId) pair owns its own hermes session.
// We open §16.9 Open question #2 as: per-agent (composite key), because
// hermes session holds LLM context — different agent roles must NOT
// share it. Cloud conversation participants are independent agents.
//
// Schema lives in `sync/store.ts` v6 migration; this module is the
// adapter-facing surface (get / createForConversation). It deliberately
// stays free of hermes-adapter internals so it can be unit-tested with
// an in-memory SQLite + a fetch mock.

import type { LocalDb } from '../../../sync/store.js';

export interface HermesSessionRow {
  /** Cloud conversation id (im_conversations.id). */
  conversationId: string;
  /** Cloud agent IM user id (im_users.id). */
  agentImUserId: string;
  /** Hermes-side session id returned by POST /api/sessions. */
  hermesSessionId: string;
  /**
   * Optional `X-Hermes-Session-Key` (features.session_continuity_header)
   * that some hermes deployments require on the next-turn POST. Null when
   * hermes doesn't issue one.
   */
  hermesSessionKey: string | null;
}

interface CreateSessionResponse {
  object?: string;
  session?: {
    id?: string;
  };
}

export interface HermesSessionRuntimeSelection {
  model: string;
}

export class HermesSessionMapper {
  constructor(private readonly db: LocalDb) {}

  /**
   * Look up an existing (conversation, agent) → hermesSessionId mapping.
   * Returns null when no session has been created yet (first turn).
   *
   * Reads the latest row (created_at DESC), so once a FRESH session is minted it
   * shadows the older ones.
   *
   * This ordering does NOT make dead sessions self-heal — a claim the previous
   * comment here made, and the reason nothing ever invalidated them. If the
   * newest row is the dead one (e.g. the gateway was restarted after it was
   * written), `get` returns precisely that dead id, forever. A hermes-side 404
   * is the only thing that can tell us a session is gone; `invalidate()` is what
   * the caller must then use.
   */
  get(conversationId: string, agentImUserId: string): HermesSessionRow | null {
    if (!conversationId || !agentImUserId) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT conversation_id, agent_im_user_id, hermes_session_id, hermes_session_key
             FROM local_run_sessions
             WHERE conversation_id = ?
               AND agent_im_user_id = ?
               AND hermes_session_id IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 1`,
        )
        .get(conversationId, agentImUserId) as
        | {
            conversation_id: string;
            agent_im_user_id: string;
            hermes_session_id: string;
            hermes_session_key: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        conversationId: row.conversation_id,
        agentImUserId: row.agent_im_user_id,
        hermesSessionId: row.hermes_session_id,
        hermesSessionKey: row.hermes_session_key,
      };
    } catch (err) {
      process.stderr.write(
        `[hermes-sessions-mapper] get failed conv=${conversationId} agent=${agentImUserId}: ${(err as Error).message}\n`,
      );
      return null;
    }
  }

  /**
   * Drop a mapping whose hermes-side session is GONE (server returned
   * 404 `session_not_found`).
   *
   * Why this has to exist: hermes sessions live in the gateway's memory, but the
   * mapping row is durable (local.db). Anything that restarts the gateway —
   * most routinely `skill-sync`, which kills + respawns it to load newly
   * installed skills — vacates every session while every row survives. `get`
   * then keeps handing back a dead id, the next-turn POST 404s, the daemon
   * retries the SAME dead id 3× and gives up. Net: **installing any skill
   * permanently bricks that (conversation, agent) session** until someone
   * deletes the row by hand (observed 2026-07-15: a council skill install left
   * the owner↔Team Manager DM 404-ing on `api_1784048863_613bf0ec` across every
   * subsequent dispatch).
   *
   * `get`'s "ORDER BY created_at DESC so stale rows don't stick around forever"
   * does NOT save us: when the newest row is itself the stale one, it is exactly
   * what gets returned. Reuse is only safe if someone can say "that session is
   * dead" — this method is how.
   */
  invalidate(conversationId: string, agentImUserId: string, hermesSessionId: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM local_run_sessions
            WHERE conversation_id = ?
              AND agent_im_user_id = ?
              AND hermes_session_id = ?`,
        )
        .run(conversationId, agentImUserId, hermesSessionId);
    } catch (err) {
      process.stderr.write(
        `[hermes-sessions-mapper] invalidate failed conv=${conversationId} session=${hermesSessionId}: ${(err as Error).message}\n`,
      );
    }
  }

  /**
   * POST /api/sessions to create a fresh hermes session and persist the
   * mapping. The `X-Hermes-Session-Key` response header (if present) is
   * captured so subsequent next-turn POSTs can forward it.
   *
   * When provided, runtimeSelection locks Hermes to the actual configured
   * model. The dedicated per-profile gateway has already resolved the
   * authoritative named provider; reasserting that name here is unsafe because
   * Hermes v2026.8.3 canonicalizes custom providers to `custom` before its lock
   * comparison. A Prismer profile name (for example `"ceo"`) remains durable
   * mapping metadata only and must never become an LLM model id.
   */
  async createForConversation(
    baseUrl: string,
    apiKey: string,
    conversationId: string,
    agentImUserId: string,
    profileName: string,
    workspaceId: string = '',
    runtimeSelection?: HermesSessionRuntimeSelection,
  ): Promise<HermesSessionRow> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        runtimeSelection
          ? {
              model: runtimeSelection.model,
              require_model_lock: true,
            }
          : {},
      ),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `hermes POST /api/sessions failed: ${res.status} ${text || '<no body>'}`,
      );
    }
    const body = (await res.json()) as CreateSessionResponse;
    const hermesSessionId = body?.session?.id;
    if (!hermesSessionId || typeof hermesSessionId !== 'string') {
      throw new Error(
        `hermes POST /api/sessions returned no session.id (got ${JSON.stringify(body).slice(0, 200)})`,
      );
    }
    const hermesSessionKey = res.headers.get('x-hermes-session-key');
    const row: HermesSessionRow = {
      conversationId,
      agentImUserId,
      hermesSessionId,
      hermesSessionKey,
    };
    this.persist(row, profileName, workspaceId);
    return row;
  }

  /**
   * Idempotent persist — used by createForConversation and also exposed
   * so callers (e.g. crash recovery from a half-created session) can
   * cache a known good row. Uses a synthetic run_id so the row satisfies
   * the existing PRIMARY KEY constraint on local_run_sessions; this row
   * never participates in the run_id → context reverse lookup used by
   * shell hooks (those queries gate on a real run_<uuid> string).
   */
  private persist(row: HermesSessionRow, profileName: string, workspaceId: string): void {
    const syntheticRunId = `session:${row.hermesSessionId}`;
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO local_run_sessions
             (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
              profile_name, role_template_slug, adapter_name, created_at,
              hermes_session_id, hermes_session_key)
           VALUES (?, ?, NULL, ?, ?, ?, NULL, 'hermes', ?, ?, ?)`,
        )
        .run(
          syntheticRunId,
          row.conversationId,
          row.agentImUserId,
          workspaceId,
          profileName,
          now,
          row.hermesSessionId,
          row.hermesSessionKey,
        );
    } catch (err) {
      process.stderr.write(
        `[hermes-sessions-mapper] persist failed conv=${row.conversationId} session=${row.hermesSessionId}: ${(err as Error).message}\n`,
      );
    }
  }
}

// ---- module-level singleton injection ------------------------------------
//
// Same pattern as RunSessionRegistry — hermes/index.ts and
// sessions-dispatcher.ts are statically imported and have no DI handle
// into the daemon Runner's `db`. Runner constructs the mapper at boot
// via `openLocalDb(...)` and registers it here; adapter consumers read
// via getHermesSessionMapper().
//
// Returns null when no daemon is running (tests / standalone). After
// §16.4 A3 removed the /v1/runs fallback dispatch will fail explicitly
// with `adapter_dispatch_failed` in that case; tests must inject a
// mapper via setHermesSessionMapper() before calling dispatch().

let SINGLETON: HermesSessionMapper | null = null;

export function setHermesSessionMapper(mapper: HermesSessionMapper | null): void {
  SINGLETON = mapper;
}

export function getHermesSessionMapper(): HermesSessionMapper | null {
  return SINGLETON;
}
