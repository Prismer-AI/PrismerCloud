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

import type { LocalDb } from '../../sync/store.js';

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

export class HermesSessionMapper {
  constructor(private readonly db: LocalDb) {}

  /**
   * Look up an existing (conversation, agent) → hermesSessionId mapping.
   * Returns null when no session has been created yet (first turn).
   *
   * Reads the latest row (created_at DESC) so a stale row from an earlier
   * session that was forked/garbage-collected on the hermes side doesn't
   * stick around forever — the caller will then create a fresh session.
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
   * POST /api/sessions to create a fresh hermes session and persist the
   * mapping. The `X-Hermes-Session-Key` response header (if present) is
   * captured so subsequent next-turn POSTs can forward it.
   *
   * `model` on the hermes side is the profile name (per §16.12 S6 #4) —
   * `"ceo"`, not the LLM model id.
   */
  async createForConversation(
    baseUrl: string,
    apiKey: string,
    conversationId: string,
    agentImUserId: string,
    profileName: string,
    workspaceId: string = '',
  ): Promise<HermesSessionRow> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: profileName }),
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
