'use client';

/**
 * Task event subscription.
 *
 * Tries SSE via `/api/im/tasks/events?token=` (auth in query because
 * `EventSource` cannot send custom headers), and falls back to short polling
 * if SSE is unavailable or the platform JWT is missing (e.g. API-key-only
 * sessions where no platform JWT is in localStorage).
 *
 * `onUpdate` is called every time a task event arrives or a poll cycle ends.
 * The returned `connectionState` powers the top-bar sync indicator.
 */

import { useEffect, useState } from 'react';
import { getWorkspaceToken } from './im-api';

export type TaskStreamState = 'connecting' | 'sse' | 'polling' | 'offline';

export function useTaskStream(opts: { workspaceId: string | null; onUpdate: () => void; pollIntervalMs?: number }) {
  const { workspaceId, onUpdate, pollIntervalMs = 8000 } = opts;
  const [state, setState] = useState<TaskStreamState>('connecting');

  useEffect(() => {
    if (!workspaceId) {
      setState('offline');
      return;
    }

    const token = getWorkspaceToken();
    if (!token) {
      setState('offline');
      return;
    }

    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let listeners: Array<readonly [string, () => void]> = [];

    const startPolling = () => {
      if (cancelled || pollTimer) return;
      setState('polling');
      pollTimer = setInterval(onUpdate, pollIntervalMs);
    };

    try {
      es = new EventSource(`/api/im/tasks/events?token=${encodeURIComponent(token)}`);

      es.onopen = () => {
        if (!cancelled) setState('sse');
      };

      const refreshEvents = [
        'task.created',
        'task.assigned',
        'task.progress',
        'task.updated',
        'task.completed',
        'task.failed',
        'task.cancelled',
        'task.claimed',
      ];
      listeners = refreshEvents.map((eventName) => {
        const listener = () => {
          if (!cancelled) onUpdate();
        };
        es?.addEventListener(eventName, listener);
        return [eventName, listener] as const;
      });

      es.onerror = () => {
        // EventSource auto-reconnects on transient failures; only fall back to
        // polling once the browser has given up and closed the connection.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          startPolling();
        }
      };
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      if (es) {
        for (const [eventName, listener] of listeners) {
          es.removeEventListener(eventName, listener);
        }
        es.close();
      }
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [workspaceId, onUpdate, pollIntervalMs]);

  return state;
}
