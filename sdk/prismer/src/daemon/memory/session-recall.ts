// Session-scoped recall wiring — spec 11 T5-1 (D10 裁决：复活).
//
// `hooks.ts` declares two content producers — `onSessionStart` (INDEX preload)
// and `onIdleRecallHint` (idle-time `<memory-context>` fence) — and until this
// module landed nothing in the daemon ever called them (spec 10 §3.6 ⑤ 断点①:
// "hooks.ts onSessionStart/onIdleRecallHint 无调用者（死组件）"). This module is
// the JUDGMENT layer + registration seam that connects them to the dispatch
// session lifecycle:
//
//   • session_start    → the FIRST dispatch seen for a (workspace, agent,
//                        session) triple in this daemon process →
//                        `onSessionStart` (INDEX preload + one
//                        `recall_preload` observation).
//   • idle_recall_hint → a later dispatch whose gap since the previous one on
//                        the same session is ≥ `idleAfterMs` → the session was
//                        resumed after the human walked away →
//                        `onIdleRecallHint` (top-K fence + one `recall_inject`
//                        observation per hit).
//   • active           → a turn INSIDE the idle window → nothing at all. This
//                        is the negative control: an ordinary back-and-forth
//                        turn behaves exactly as it did before this wiring.
//
// Session identity = the dispatch's session id, which is the cloud
// conversationId (`config.ts deriveSessionId`). A dispatch that carries no
// conversation is not a session (pure kanban task / agent-to-agent run) →
// `no_session`, hooks not called.
//
// Idle judgment: `gap ≥ idleAfterMs` on the SAME session, measured in-process.
// It is deliberately not a per-turn hook (hooks.ts:166-178 — "the default
// Hermes / CC / OpenClaw / Codex wiring does NOT call it on every turn"): one
// dispatch after a real absence is a deliberate signal, a rapid second turn is
// not. Losing the in-memory table (daemon restart) degrades to a session_start
// on the next dispatch — the correct answer for a fresh session, never a
// duplicate hint.
//
// WHAT THIS DOES *NOT* DO (deliberate — see the T5-1 report):
//   The hooks return injectable content (`content` / `fence`). This wiring fires
//   them for their designed SIDE EFFECT — the outbox observation rows — and does
//   NOT push the returned text into any prompt. Which prompt slot gets what is
//   the ADAPTER owner's call (hooks.ts:17-21), the injection DESTINATION is spec
//   11 T5-4's scope, and on the hermes lane the stable digest (digest.ts) already
//   owns the INDEX spine. The returned content stays on `SessionRecallOutcome`
//   so a destination can be added without re-plumbing the judgment.
//
// Transport: `slot.outbox.enqueue(...)` inside the hooks — the same memory
// outbox → MemoryOutboxWorker → cloud `/api/im/memory/sync/inbox` channel every
// other recall observation uses. No new transport and no LLM: this module only
// CONSUMES the existing recall面 (「agent-driven 云端零 LLM」— extraction lives in
// the runtime, nothing here calls a model).

import type { ActorKind } from './types.js';
import { MemoryRecallHooks } from './hooks.js';

const LOG = '[memory.session-recall]';

/**
 * Gap after which a returning turn counts as an idle RESUME rather than an
 * active conversation. 30 min: long enough that ordinary back-and-forth never
 * earns a hint, short enough to cover "walked away, came back to the same piece
 * of work" — the case D10 revived the hook for.
 */
export const DEFAULT_IDLE_RECALL_AFTER_MS = 30 * 60 * 1000;

/** Same bound hook-server.ts uses when it turns an incoming message into a
 *  recall query (keep FTS5 biased toward content tokens). */
const MAX_QUERY_CHARS = 240;

/** Bound on the tracked-session table over a daemon lifetime. Eviction is
 *  lossless in effect: the evicted session's next dispatch is treated as a
 *  session start, which is the correct fallback for a session this stale. */
const MAX_TRACKED_SESSIONS = 1000;

export type SessionRecallBranch =
  | 'session_start'
  | 'idle_recall_hint'
  | 'active'
  | 'no_session'
  | 'unwired';

export interface SessionRecallContext {
  workspaceId: string;
  agentImUserId: string;
  actorKind: ActorKind;
  /** Dispatch session id (== cloud conversationId). null / '' ⇒ no session. */
  sessionId: string | null;
  /** This turn's incoming message — the idle hint's query source. */
  prompt: string;
}

export interface SessionRecallOutcome {
  branch: SessionRecallBranch;
  /**
   * Injectable text the hook produced (INDEX preload content / recall fence),
   * or null when the branch produced none. See the module header: this wiring
   * does not consume it — it is surfaced for the destination work.
   */
  content: string | null;
  /** Hits the idle hint produced (0 on every other branch). */
  hits: number;
}

export interface SessionRecallCoordinatorOptions {
  /** Override the idle threshold (tests). */
  idleAfterMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

function outcome(branch: SessionRecallBranch, content: string | null = null, hits = 0): SessionRecallOutcome {
  return { branch, content, hits };
}

/**
 * Session lifecycle → recall hook judgment. One instance per daemon wiring;
 * holds only the (session → last turn) table needed to tell a session start and
 * an idle resume apart from an ordinary turn.
 */
export class SessionRecallCoordinator {
  private readonly idleAfterMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, { lastTurnAt: number; turnCount: number }>();

  constructor(
    private readonly hooks: MemoryRecallHooks,
    opts: SessionRecallCoordinatorOptions = {},
  ) {
    this.idleAfterMs = opts.idleAfterMs ?? DEFAULT_IDLE_RECALL_AFTER_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Note one dispatch against its session and run whichever hook the lifecycle
   * calls for. Returns the branch taken. NEVER throws — recall is advisory and
   * must not be able to break a dispatch (local-first: memory is best-effort).
   */
  noteDispatch(ctx: SessionRecallContext): SessionRecallOutcome {
    const workspaceId = (ctx.workspaceId ?? '').trim();
    const agentImUserId = (ctx.agentImUserId ?? '').trim();
    const sessionId = (ctx.sessionId ?? '').trim();
    if (!workspaceId || !agentImUserId || !sessionId) return outcome('no_session');

    // `::`-joined — neither a workspace id nor an im_user id nor a cuid
    // conversation id can contain it, so no id shape can forge a collision
    // into another session's table row.
    const key = `${workspaceId}::${agentImUserId}::${sessionId}`;
    const now = this.now();
    const prev = this.sessions.get(key);
    try {
      if (!prev) {
        this.track(key, { lastTurnAt: now, turnCount: 1 });
        const preload = this.hooks.onSessionStart({
          workspaceId,
          agentImUserId,
          actorKind: ctx.actorKind,
          sessionId,
        });
        return outcome('session_start', preload?.content ?? null);
      }

      const gapMs = now - prev.lastTurnAt;
      prev.lastTurnAt = now;
      prev.turnCount += 1;
      if (gapMs < this.idleAfterMs) return outcome('active');

      const query = (ctx.prompt ?? '').trim().slice(0, MAX_QUERY_CHARS);
      if (!query) return outcome('active');
      const hint = this.hooks.onIdleRecallHint({
        workspaceId,
        agentImUserId,
        actorKind: ctx.actorKind,
        sessionId,
        // 0-based index of this turn within the session.
        turnIndex: prev.turnCount - 1,
        query,
      });
      if (!hint) return outcome('active');
      return outcome('idle_recall_hint', hint.fence, hint.results.length);
    } catch (err) {
      process.stderr.write(
        `${LOG} recall hook failed ws=${workspaceId} session=${sessionId}: ${(err as Error).message}\n`,
      );
      return outcome('active');
    }
  }

  private track(key: string, state: { lastTurnAt: number; turnCount: number }): void {
    if (!this.sessions.has(key) && this.sessions.size >= MAX_TRACKED_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of this.sessions) {
        if (entry.lastTurnAt < oldestAt) {
          oldestAt = entry.lastTurnAt;
          oldestKey = candidate;
        }
      }
      if (oldestKey !== null) this.sessions.delete(oldestKey);
    }
    this.sessions.set(key, state);
  }
}

// ---- module-level singleton injection ------------------------------------
//
// Same pattern as run-session-map / provider-session-mapper / the memory digest
// provider: the daemon runner wiring owns the MemoryRuntime, so it constructs
// the coordinator and registers it here; the dispatch path (statically
// imported, no DI handle into the runner) reads it via
// `noteDispatchRecall()`. Unregistered (standalone adapter / unit tests) ⇒
// 'unwired' ⇒ the pre-wiring behaviour, byte for byte.

let coordinator: SessionRecallCoordinator | null = null;

/** Register the process-wide coordinator (the daemon runner wiring does this). */
export function setSessionRecallCoordinator(next: SessionRecallCoordinator | null): void {
  coordinator = next;
}

export function getSessionRecallCoordinator(): SessionRecallCoordinator | null {
  return coordinator;
}

/**
 * The dispatch path's fire-and-forget entry. Returns the branch taken so the
 * caller (or a test) can see what the lifecycle decided; 'unwired' when no
 * daemon registered a coordinator.
 */
export function noteDispatchRecall(ctx: SessionRecallContext): SessionRecallOutcome {
  const current = coordinator;
  if (!current) return outcome('unwired');
  return current.noteDispatch(ctx);
}
