/**
 * Evolution Studio v2 — `AuthoringEvent` SSE bus (release201/28 §6.1).
 *
 * The Skill Creator canvas subscribes to a normalised `AuthoringEvent` union
 * rather than parsing raw `/api/im/sync/stream` envelopes itself. This mirrors
 * `src/app/workspace/lib/business-event-bus.ts`:
 *
 *   - one shared EventSource (first subscribe opens it, last unsubscribe closes
 *     it) — fixes the old studio's per-component EventSource SSE leak
 *     (authoring-view.tsx:314 had no unmount cleanup)
 *   - raw → union mapping happens once on receipt, so every canvas layer reads
 *     a stable schema
 *
 * The emit side (runtime → daemon outbox → cloud SSE) is declare-first (doc 28
 * §3.3.4 + §7): this file locks the SUBSCRIBE shape so the canvas can be built
 * + mock-driven now and wired to the live stream later with 0 UI changes. Under
 * `FF_STUDIO_MOCK` the canvas uses the simulated generator in `./mock` instead
 * of this stream.
 */

import { useEffect, useState } from 'react';

import { getWorkspaceToken } from '@/app/workspace/lib/im-api';

// ─── Public event union (doc 28 §6.1) ────────────────────────────────────────

export type AuthoringPhase = 'intent' | 'fetch' | 'compose' | 'eval' | 'done';

export type AuthoringFailureKind =
  | 'needs_input'
  | 'requires_unavailable'
  | 'validation_failed'
  | 'smoke_failed'
  | 'review_blocked';

export interface AuthoringQuickReply {
  label: string;
  action: string;
}

export type AuthoringEvent =
  | { type: 'authoring.phase'; draftId: string; phase: AuthoringPhase; sub?: string }
  | {
      type: 'authoring.message';
      draftId: string;
      role: 'agent';
      text: string;
      quickReplies?: AuthoringQuickReply[];
    }
  | {
      type: 'authoring.source.pulled';
      draftId: string;
      kind: 'doc' | 'code' | 'service' | 'inline';
      ref: string;
      bytes: number;
    }
  | { type: 'authoring.file.writing'; draftId: string; path: string }
  | {
      type: 'authoring.file.written';
      draftId: string;
      path: string;
      size: number;
      sha256: string;
    }
  | { type: 'authoring.preview.delta'; draftId: string; path: string; chunk: string }
  | { type: 'authoring.tool'; draftId: string; tool: string; summary: string }
  | {
      type: 'eval.progress';
      draftId: string;
      runId: string;
      caseIndex: number;
      total: number;
      passed: boolean;
      ms: number;
    }
  | { type: 'eval.finished'; draftId: string; runId: string; passRate: number; revision: string }
  | { type: 'authoring.failed'; draftId: string; kind: AuthoringFailureKind; reason: string };

export type AuthoringEventListener = (event: AuthoringEvent) => void;

// ─── Raw → union mapping ──────────────────────────────────────────────────────

interface RawSseEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** SSE event-type tags this bus listens for. */
const HANDLED_RAW_TYPES = [
  'authoring.phase',
  'authoring.message',
  'authoring.source.pulled',
  'authoring.file.writing',
  'authoring.file.written',
  'authoring.preview.delta',
  'authoring.tool',
  'eval.progress',
  'eval.finished',
  'authoring.failed',
];

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

/** Map a raw SSE envelope (event-type already known) to an `AuthoringEvent`. */
export function mapRawToAuthoringEvent(eventName: string, p: Record<string, unknown>): AuthoringEvent | null {
  const draftId = str(p.draftId ?? p.draft_id);
  switch (eventName) {
    case 'authoring.phase':
      return { type: 'authoring.phase', draftId, phase: (str(p.phase, 'intent') as AuthoringPhase), sub: typeof p.sub === 'string' ? p.sub : undefined };
    case 'authoring.message':
      return {
        type: 'authoring.message',
        draftId,
        role: 'agent',
        text: str(p.text),
        quickReplies: Array.isArray(p.quickReplies) ? (p.quickReplies as AuthoringQuickReply[]) : undefined,
      };
    case 'authoring.source.pulled':
      return {
        type: 'authoring.source.pulled',
        draftId,
        kind: (str(p.kind, 'doc') as 'doc' | 'code' | 'service' | 'inline'),
        ref: str(p.ref),
        bytes: num(p.bytes),
      };
    case 'authoring.file.writing':
      return { type: 'authoring.file.writing', draftId, path: str(p.path) };
    case 'authoring.file.written':
      return { type: 'authoring.file.written', draftId, path: str(p.path), size: num(p.size), sha256: str(p.sha256) };
    case 'authoring.preview.delta':
      return { type: 'authoring.preview.delta', draftId, path: str(p.path), chunk: str(p.chunk) };
    case 'authoring.tool':
      return { type: 'authoring.tool', draftId, tool: str(p.tool), summary: str(p.summary) };
    case 'eval.progress':
      return {
        type: 'eval.progress',
        draftId,
        runId: str(p.runId),
        caseIndex: num(p.caseIndex),
        total: num(p.total),
        passed: Boolean(p.passed),
        ms: num(p.ms),
      };
    case 'eval.finished':
      return { type: 'eval.finished', draftId, runId: str(p.runId), passRate: num(p.passRate), revision: str(p.revision) };
    case 'authoring.failed':
      return { type: 'authoring.failed', draftId, kind: (str(p.kind, 'requires_unavailable') as AuthoringFailureKind), reason: str(p.reason, 'unknown failure') };
    default:
      return null;
  }
}

// ─── Shared EventSource ───────────────────────────────────────────────────────

const listeners = new Set<AuthoringEventListener>();
let es: EventSource | null = null;
let activeSubs = 0;

function emit(event: AuthoringEvent): void {
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      // keep other listeners alive
    }
  }
}

function applyRaw(eventName: string, raw: MessageEvent): void {
  let env: RawSseEnvelope;
  try {
    env = JSON.parse(raw.data) as RawSseEnvelope;
  } catch {
    return;
  }
  const payload = env.payload ?? env.data ?? {};
  const mapped = mapRawToAuthoringEvent(eventName, payload);
  if (mapped) emit(mapped);
}

function open(): void {
  if (es) return;
  if (typeof window === 'undefined') return;
  const token = getWorkspaceToken();
  if (!token) return;
  const url = `/api/im/sync/stream?token=${encodeURIComponent(token)}`;
  try {
    es = new EventSource(url);
  } catch {
    return;
  }
  for (const type of HANDLED_RAW_TYPES) {
    es.addEventListener(type, (raw) => applyRaw(type, raw as MessageEvent));
  }
}

function close(): void {
  if (!es) return;
  es.close();
  es = null;
}

/**
 * Subscribe to normalised authoring events. Opens the shared EventSource on the
 * first subscriber and closes it on the last unsubscribe (no SSE leak).
 */
export function subscribeAuthoringEvents(listener: AuthoringEventListener): () => void {
  listeners.add(listener);
  activeSubs += 1;
  if (activeSubs === 1) open();
  return () => {
    listeners.delete(listener);
    activeSubs = Math.max(0, activeSubs - 1);
    if (activeSubs === 0) close();
  };
}

/**
 * React hook: collects authoring events for a given draft into an ordered list.
 * When `enabled` is false (e.g. mock mode drives the canvas directly), this is
 * inert and opens no connection.
 */
export function useAuthoringEvents(draftId: string | null, enabled = true): AuthoringEvent[] {
  // Keyed by draftId so switching drafts resets the accumulation without a
  // synchronous setState in the effect (avoids the cascading-render lint).
  const [state, setState] = useState<{ key: string | null; events: AuthoringEvent[] }>({
    key: null,
    events: [],
  });

  useEffect(() => {
    if (!enabled || !draftId) return;
    const unsub = subscribeAuthoringEvents((ev) => {
      if (ev.draftId !== draftId) return;
      setState((prev) => (prev.key === draftId ? { key: draftId, events: [...prev.events, ev] } : { key: draftId, events: [ev] }));
    });
    return unsub;
  }, [draftId, enabled]);

  // Return an empty list until the first event arrives for the current draft.
  return state.key === draftId && enabled ? state.events : [];
}

/** Test/mock-only: inject an event without going through SSE. */
export function __emitAuthoringEventForTests(event: AuthoringEvent): void {
  emit(event);
}
