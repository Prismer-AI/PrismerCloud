'use client';

/**
 * LibraryMemoryRecallTrace — Memory Line B / B7.
 *
 * Read-only timeline of recall events for the workspace. Doc 23 §1.5
 * defines the three event classes the UI must surface separately:
 *
 *   - Preload  → eventType `recall_preload` (e.g. INDEX.md inserted at session_start)
 *   - Auto-inject → eventType `recall_inject` (per-turn ranker pulls)
 *   - Pull → eventType `memory.search` / `memory.search_call` triggered by tool
 *
 * v0 surfaces a single thumbs-up/down feedback emitter per row; the
 * actual ranker tuning hook is deferred (plan §"Out of scope: 反馈面板 v0
 * 仅记 feedback event, 不实装权重调优界面").
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { getRecallTrace, type RecallTraceEventDTO } from '../lib/memory-api';

interface LibraryMemoryRecallTraceProps {
  workspaceId: string;
  isDark: boolean;
  /** Pre-fill a sessionId filter (e.g. when the user clicked a session row elsewhere). */
  sessionId?: string | null;
}

type EventClass = 'preload' | 'auto-inject' | 'pull' | 'feedback' | 'other';

function classify(event: RecallTraceEventDTO): EventClass {
  switch (event.eventType) {
    case 'recall_preload':
      return 'preload';
    case 'recall_inject':
      return 'auto-inject';
    case 'memory.search':
    case 'memory.search_call':
    case 'recall_pull':
      return 'pull';
    case 'feedback':
      return 'feedback';
    default:
      return 'other';
  }
}

const SECTION_ORDER: Array<{ key: EventClass; label: string }> = [
  { key: 'preload', label: 'Preload' },
  { key: 'auto-inject', label: 'Auto-inject' },
  { key: 'pull', label: 'Pull' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'other', label: 'Other' },
];

export function LibraryMemoryRecallTrace({
  workspaceId,
  isDark,
  sessionId: sessionIdProp,
}: LibraryMemoryRecallTraceProps) {
  const [sessionId, setSessionId] = useState(sessionIdProp ?? '');
  const [events, setEvents] = useState<RecallTraceEventDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return undefined;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    getRecallTrace({
      workspaceId,
      sessionId: sessionId.trim() || undefined,
      limit: 200,
      signal: ac.signal,
    }).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) {
        setEvents(res.data?.events ?? []);
      } else {
        setError(res.message);
      }
      setLoading(false);
    });
    return () => ac.abort();
  }, [workspaceId, sessionId]);

  const grouped = useMemo(() => {
    const acc: Record<EventClass, RecallTraceEventDTO[]> = {
      preload: [],
      'auto-inject': [],
      pull: [],
      feedback: [],
      other: [],
    };
    for (const e of events) acc[classify(e)].push(e);
    return acc;
  }, [events]);

  const stats = useMemo(() => {
    const uniquePages = new Set(events.map((e) => e.pageId).filter(Boolean));
    let injectedTokens = 0;
    let pullCount = 0;
    for (const e of events) {
      if (classify(e) === 'auto-inject' || classify(e) === 'preload') {
        const tc = e.metricsJson?.tokenCount;
        if (typeof tc === 'number') injectedTokens += tc;
      }
      if (classify(e) === 'pull') pullCount += 1;
    }
    return { uniquePages: uniquePages.size, injectedTokens, pullCount };
  }, [events]);

  return (
    <div data-testid="library-memory-recall-trace" className="flex h-full min-h-0 flex-col">
      <div
        className={`flex items-center gap-2 border-b px-3 py-2 ${
          isDark ? 'border-white/[0.06] bg-zinc-950/30' : 'border-zinc-200 bg-zinc-50/60'
        }`}
      >
        <Search className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
        <input
          data-testid="library-memory-recall-trace-session"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          placeholder="Filter by sessionId (blank → workspace-wide)"
          className={`flex-1 bg-transparent text-xs outline-none ${
            isDark ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-zinc-800 placeholder:text-zinc-400'
          }`}
        />
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] tabular-nums ${
            isDark ? 'bg-white/[0.04] text-zinc-300' : 'bg-zinc-100 text-zinc-700'
          }`}
        >
          {stats.uniquePages} unique pages · {stats.injectedTokens} tokens injected · {stats.pullCount} pulls
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div
            data-testid="library-memory-recall-trace-loading"
            className={`flex items-center gap-2 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading recall events…
          </div>
        ) : error ? (
          <p className={`text-xs ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{error}</p>
        ) : events.length === 0 ? (
          <p
            data-testid="library-memory-recall-trace-empty"
            className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            No recall events recorded yet. Once an agent runs against this workspace, preload / auto-inject / pull
            events will land here in real time.
          </p>
        ) : (
          SECTION_ORDER.map(({ key, label }) =>
            grouped[key].length > 0 ? (
              <section key={key} data-testid={`library-memory-recall-section-${key}`} className="mb-4">
                <header
                  className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${
                    isDark ? 'text-zinc-500' : 'text-zinc-500'
                  }`}
                >
                  <span>{label}</span>
                  <span>· {grouped[key].length}</span>
                </header>
                <ul className="space-y-1">
                  {grouped[key].map((event) => (
                    <li
                      key={event.id}
                      className={`rounded-xl border px-3 py-2 text-[11px] ${
                        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white/60'
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className={`font-mono ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                          {event.eventType}
                        </span>
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>·</span>
                        <span className={`tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          {new Date(event.createdAt).toISOString()}
                        </span>
                        {event.actorImUserId ? (
                          <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>
                            · actor {event.actorImUserId.slice(0, 12)}
                          </span>
                        ) : null}
                      </div>
                      {event.pageId ? (
                        <p className={`mt-0.5 truncate ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          page · {event.pageId}
                        </p>
                      ) : null}
                      {event.query ? (
                        <p className={`mt-0.5 truncate italic ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          query · {event.query}
                        </p>
                      ) : null}
                      {event.metricsJson ? (
                        <pre
                          className={`mt-1 max-h-24 overflow-auto rounded-md px-2 py-1 text-[10px] ${
                            isDark ? 'bg-white/[0.03] text-zinc-400' : 'bg-zinc-50 text-zinc-600'
                          }`}
                        >
                          {JSON.stringify(event.metricsJson, null, 2)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )
        )}
      </div>
    </div>
  );
}
