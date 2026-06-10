'use client';

/**
 * useProjects — release201/09 Phase 1 + Phase 4.
 *
 * 拉取 workspace 内 active projects + 维护当前 active project filter (per-workspace,
 * localStorage 持久, URL ?project= 同步). 切换时 caller responsibility 是触发
 * 受 filter 影响的资源 list reload.
 *
 * Phase 4 §15.1 — extra surface:
 *   • `archivedProjects` / `archivedLoading` are lazy-loaded only when the
 *     caller flips `showArchived = true` (the "Show archived" toggle in the
 *     ProjectSwitcher dropdown). Default keeps archived rows out of the
 *     payload, satisfying the §15.1 Phase 4 DoD "auto-hide archived".
 *   • If `activeFilter` points at an id that's no longer active (e.g. archived
 *     in another tab), we re-pin to `PROJECT_FILTER_ALL` after the active list
 *     resolves so the rest of the UI doesn't show stale state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listProjects,
  PROJECT_FILTER_ALL,
  PROJECT_FILTER_UNSCOPED,
  readActiveProjectFromStorage,
  writeActiveProjectToStorage,
  type ProjectFilter,
  type ProjectWithCountsDTO,
} from '../lib/projects-api';

interface UseProjectsResult {
  projects: ProjectWithCountsDTO[];
  loading: boolean;
  error: string | null;
  activeFilter: ProjectFilter;
  setActiveFilter: (filter: ProjectFilter) => void;
  reload: () => void;
  /** Phase 4 §15.1 — toggle + payload for the "Show archived" UI bucket. */
  showArchived: boolean;
  setShowArchived: (next: boolean) => void;
  archivedProjects: ProjectWithCountsDTO[];
  archivedLoading: boolean;
}

export function useProjects(workspaceId: string | null): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectWithCountsDTO[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilterState] = useState<ProjectFilter>(PROJECT_FILTER_ALL);
  const [reloadTick, setReloadTick] = useState(0);
  // Phase 4 §15.1 — archived bucket. Not persisted in localStorage; reset
  // every workspace mount so the default surface stays clean.
  const [showArchived, setShowArchivedState] = useState<boolean>(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectWithCountsDTO[]>([]);
  const [archivedLoading, setArchivedLoading] = useState<boolean>(false);

  // Initial active filter resolution: URL ?project= first, then localStorage,
  // else "all" sentinel.
  useEffect(() => {
    if (!workspaceId) {
      setActiveFilterState(PROJECT_FILTER_ALL);
      return;
    }
    let next: ProjectFilter = PROJECT_FILTER_ALL;
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href);
        const qp = url.searchParams.get('project');
        if (qp) next = qp as ProjectFilter;
      } catch {
        /* invalid URL — fall through */
      }
      if (next === PROJECT_FILTER_ALL) {
        const stored = readActiveProjectFromStorage(workspaceId);
        if (stored) next = stored;
      }
    }
    setActiveFilterState(next);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setProjects([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    listProjects({ workspaceId, status: 'active', limit: 100, signal: ac.signal })
      .then((res) => {
        if (res.ok) {
          const items = res.data?.items ?? [];
          setProjects(items);
          // If the persisted active filter points at a project that is no
          // longer in the active list (it was archived in another tab),
          // fall back to "All". Phase 4 §15.1 DoD: archived 不能作 active.
          setActiveFilterState((prev) => {
            if (prev === PROJECT_FILTER_ALL || prev === PROJECT_FILTER_UNSCOPED) return prev;
            return items.some((p) => p.id === prev) ? prev : PROJECT_FILTER_ALL;
          });
        } else if (res.status !== 0) {
          setError(res.message);
        }
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [workspaceId, reloadTick]);

  // Lazy fetch archived list — only on (a) toggle ON and (b) every reload tick
  // while toggle stays ON. Default workspace mount does NOT touch the archived
  // endpoint, keeping the noise-floor at zero.
  useEffect(() => {
    if (!workspaceId || !showArchived) {
      setArchivedProjects([]);
      setArchivedLoading(false);
      return;
    }
    const ac = new AbortController();
    setArchivedLoading(true);
    listProjects({ workspaceId, status: 'archived', limit: 100, signal: ac.signal })
      .then((res) => {
        if (res.ok) setArchivedProjects(res.data?.items ?? []);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // Non-fatal — surface as transient empty list. The active list error
        // path is the primary observability channel.
      })
      .finally(() => setArchivedLoading(false));
    return () => ac.abort();
  }, [workspaceId, showArchived, reloadTick]);

  const setActiveFilter = useCallback(
    (filter: ProjectFilter) => {
      // Phase 4 §15.1 DoD: refuse to set an archived project as the active
      // filter (the UI hides them; but if a caller bypasses the dropdown
      // we still guard here). Sentinels always pass.
      if (
        filter !== PROJECT_FILTER_ALL &&
        filter !== PROJECT_FILTER_UNSCOPED &&
        archivedProjects.some((p) => p.id === filter)
      ) {
        return;
      }
      setActiveFilterState(filter);
      if (workspaceId) {
        writeActiveProjectToStorage(workspaceId, filter);
      }
      if (typeof window !== 'undefined') {
        try {
          const url = new URL(window.location.href);
          if (filter === PROJECT_FILTER_ALL) {
            url.searchParams.delete('project');
          } else {
            url.searchParams.set('project', filter);
          }
          window.history.replaceState(null, '', url.toString());
        } catch {
          /* malformed URL — silently skip the sync; localStorage still holds the value */
        }
      }
    },
    [workspaceId, archivedProjects],
  );

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  const setShowArchived = useCallback((next: boolean) => setShowArchivedState(next), []);

  return useMemo(
    () => ({
      projects,
      loading,
      error,
      activeFilter,
      setActiveFilter,
      reload,
      showArchived,
      setShowArchived,
      archivedProjects,
      archivedLoading,
    }),
    [
      projects,
      loading,
      error,
      activeFilter,
      setActiveFilter,
      reload,
      showArchived,
      setShowArchived,
      archivedProjects,
      archivedLoading,
    ],
  );
}
