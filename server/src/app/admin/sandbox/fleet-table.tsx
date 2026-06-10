'use client';

/**
 * FleetTable — admin fleet inventory with checkbox multi-select + bulk
 * actions. Polls `/api/sandboxes/_admin/fleet` every 10s.
 *
 * Backed by:
 *   - GET  /api/sandboxes/_admin/fleet          (list + drift markers)
 *   - POST /api/sandboxes/_admin/bulk-action    (force-delete / force-stop /
 *                                                 reconcile / delete-orphan-pod)
 *
 * Renders three groupings in one table:
 *   1. Aligned rows (DB + K8s agree)
 *   2. Drifted rows (DB/K8s mismatch — drift column highlighted)
 *   3. Orphan K8s pods (no DB row — separate section, podName as ID)
 *
 * Bulk actions act on whatever's currently checked; "Select drifted" /
 * "Select orphans" presets help the common cleanup flows.
 *
 * RBAC: page-level RBAC on /admin/sandbox already gates this entire surface
 * (notFound for non-admins). Both endpoints additionally re-verify.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getIMClientToken } from '@/lib/im-token';

interface FleetContainer {
  id: string;
  podName: string;
  namespace: string;
  workspaceId: string;
  status: string;
  runtimeKind: string;
  image: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  createdAt: string;
  daemonId: string | null;
  livePhase: string | null;
  liveWaitReason: string | null;
  liveUnschedulable: boolean;
  drift: 'aligned' | 'pod-missing' | 'phase-mismatch' | null;
  ageHours: number;
}

interface OrphanPod {
  name: string;
  namespace: string;
  phase: string;
  ageHours: number;
  containerImage: string | null;
}

interface FleetResponse {
  containers: FleetContainer[];
  orphanPods: OrphanPod[];
  summary: {
    totalRows: number;
    byStatus: Record<string, number>;
    driftCount: number;
    orphanPodCount: number;
    namespace: string;
  };
}

type BulkAction = 'force-delete' | 'force-stop' | 'reconcile' | 'delete-orphan-pod';

interface BulkResult {
  id?: string;
  podName?: string;
  ok: boolean;
  error?: string;
  previousStatus?: string;
}

const POLL_INTERVAL_MS = 10_000;

async function authedFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const token = getIMClientToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(input, { ...init, headers, cache: 'no-store' });
}

export function FleetTable(): React.JSX.Element {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [selectedPods, setSelectedPods] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<string>('');
  const [olderThanHours, setOlderThanHours] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const [lastBulkResult, setLastBulkResult] = useState<BulkResult[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (kindFilter) params.set('kind', kindFilter);
      if (olderThanHours && Number(olderThanHours) > 0) params.set('olderThanHours', olderThanHours);
      const url = `/api/sandboxes/_admin/fleet${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await authedFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as FleetResponse;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [statusFilter, kindFilter, olderThanHours]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleRow = (id: string) =>
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePod = (name: string) =>
    setSelectedPods((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectAllRows = () => {
    if (!data) return;
    if (selectedRows.size === data.containers.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(data.containers.map((c) => c.id)));
  };
  const selectDriftedRows = () => {
    if (!data) return;
    setSelectedRows(new Set(data.containers.filter((c) => c.drift && c.drift !== 'aligned').map((c) => c.id)));
  };
  const selectErroredRows = () => {
    if (!data) return;
    setSelectedRows(new Set(data.containers.filter((c) => c.status === 'errored').map((c) => c.id)));
  };
  const selectStoppedOlder24h = () => {
    if (!data) return;
    setSelectedRows(
      new Set(data.containers.filter((c) => c.status === 'stopped' && c.ageHours >= 24).map((c) => c.id)),
    );
  };
  const selectAllOrphans = () => {
    if (!data) return;
    if (selectedPods.size === data.orphanPods.length) setSelectedPods(new Set());
    else setSelectedPods(new Set(data.orphanPods.map((p) => p.name)));
  };

  const runBulk = useCallback(
    async (action: BulkAction) => {
      if (bulkBusy) return;
      let body: object;
      if (action === 'delete-orphan-pod') {
        if (selectedPods.size === 0) return;
        if (!confirm(`Delete ${selectedPods.size} orphan K8s pod(s)? This permanently removes them.`)) return;
        body = { action, podNames: Array.from(selectedPods) };
      } else {
        if (selectedRows.size === 0) return;
        const verb = action === 'force-delete' ? 'force-delete' : action === 'force-stop' ? 'force-stop' : 'reconcile';
        if (
          !confirm(
            `${verb} ${selectedRows.size} container row(s)? ${
              action === 'force-delete'
                ? 'Permanent: pod + DB row removed.'
                : action === 'force-stop'
                  ? 'Pod terminated, DB row kept as stopped.'
                  : 'DB row updated to match live K8s state.'
            }`,
          )
        )
          return;
        body = { action, containerIds: Array.from(selectedRows) };
      }
      setBulkBusy(action);
      setLastBulkResult(null);
      try {
        const res = await authedFetch('/api/sandboxes/_admin/bulk-action', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${text}`);
        }
        const json = (await res.json()) as { results: BulkResult[] };
        setLastBulkResult(json.results);
        if (action === 'delete-orphan-pod') setSelectedPods(new Set());
        else setSelectedRows(new Set());
        await refresh();
      } catch (err) {
        setLastBulkResult([{ ok: false, error: err instanceof Error ? err.message : String(err) }]);
      } finally {
        setBulkBusy(null);
      }
    },
    [bulkBusy, selectedRows, selectedPods, refresh],
  );

  const bulkSummary = useMemo(() => {
    if (!lastBulkResult) return null;
    const ok = lastBulkResult.filter((r) => r.ok).length;
    const failed = lastBulkResult.length - ok;
    return { ok, failed, total: lastBulkResult.length };
  }, [lastBulkResult]);

  if (error && !data) {
    const forbidden = /\b403\b/.test(error);
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        {forbidden ? (
          <>
            <p className="font-semibold">Admin access required.</p>
            <p className="mt-1 text-xs opacity-80">
              Add this account&apos;s email to <code>ADMIN_EMAILS</code> in the test/prod Nacos config.
            </p>
          </>
        ) : (
          <>Fleet unavailable: {error}</>
        )}
      </div>
    );
  }
  if (!data) {
    return <p className="text-sm text-zinc-500">Loading fleet…</p>;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Fleet · {data.summary.namespace}</h2>
          <p className="text-xs text-zinc-500">
            {data.summary.totalRows} rows · {data.summary.driftCount} drifted · {data.summary.orphanPodCount} orphan pod(s) ·{' '}
            {Object.entries(data.summary.byStatus)
              .map(([s, n]) => `${s}=${n}`)
              .join(' / ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <span className="text-zinc-500">status</span>
            <input
              type="text"
              placeholder="running,errored"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-zinc-500">kind</span>
            <input
              type="text"
              placeholder="k8s,docker"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="rounded border border-zinc-300 bg-white px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-zinc-500">older than (h)</span>
            <input
              type="number"
              min="0"
              value={olderThanHours}
              onChange={(e) => setOlderThanHours(e.target.value)}
              className="w-16 rounded border border-zinc-300 bg-white px-2 py-0.5 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="button"
            onClick={refresh}
            className="rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
        <span className="text-zinc-500">Selection presets:</span>
        <button
          type="button"
          onClick={selectErroredRows}
          className="rounded border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
        >
          Errored
        </button>
        <button
          type="button"
          onClick={selectStoppedOlder24h}
          className="rounded border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
        >
          Stopped &gt; 24h
        </button>
        <button
          type="button"
          onClick={selectDriftedRows}
          className="rounded border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
        >
          Drifted
        </button>
        <span className="ml-2 text-zinc-500">|</span>
        <span className="text-zinc-600 dark:text-zinc-400">
          {selectedRows.size} row(s){selectedPods.size > 0 && ` + ${selectedPods.size} orphan pod(s)`} selected
        </span>
        <span className="grow" />
        <button
          type="button"
          disabled={selectedRows.size === 0 || bulkBusy !== null}
          onClick={() => void runBulk('reconcile')}
          className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Reconcile
        </button>
        <button
          type="button"
          disabled={selectedRows.size === 0 || bulkBusy !== null}
          onClick={() => void runBulk('force-stop')}
          className="rounded bg-amber-600 px-3 py-1 text-white hover:bg-amber-700 disabled:opacity-50"
        >
          Force stop
        </button>
        <button
          type="button"
          disabled={selectedRows.size === 0 || bulkBusy !== null}
          onClick={() => void runBulk('force-delete')}
          className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700 disabled:opacity-50"
        >
          Force delete
        </button>
      </div>

      {bulkSummary && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            bulkSummary.failed === 0
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
          }`}
        >
          Bulk result: {bulkSummary.ok}/{bulkSummary.total} ok
          {bulkSummary.failed > 0 && ` · ${bulkSummary.failed} failed`}
          {bulkSummary.failed > 0 && lastBulkResult && (
            <details className="mt-1 cursor-pointer">
              <summary>show errors</summary>
              <ul className="mt-1 list-disc pl-4 font-mono">
                {lastBulkResult
                  .filter((r) => !r.ok)
                  .slice(0, 10)
                  .map((r, idx) => (
                    <li key={idx}>
                      {r.id ?? r.podName}: {r.error}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">
                <input
                  type="checkbox"
                  checked={data.containers.length > 0 && selectedRows.size === data.containers.length}
                  onChange={selectAllRows}
                  aria-label="select all"
                />
              </th>
              <th className="px-3 py-2 font-medium">Pod / Workspace</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Live phase</th>
              <th className="px-3 py-2 font-medium">Drift</th>
              <th className="px-3 py-2 font-medium">Resources</th>
              <th className="px-3 py-2 font-medium">Age</th>
              <th className="px-3 py-2 font-medium">Image</th>
            </tr>
          </thead>
          <tbody>
            {data.containers.map((c) => (
              <tr
                key={c.id}
                className={`border-t border-zinc-100 dark:border-zinc-800 ${
                  c.drift && c.drift !== 'aligned'
                    ? 'bg-amber-50/50 dark:bg-amber-900/10'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
                }`}
              >
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(c.id)}
                    onChange={() => toggleRow(c.id)}
                    aria-label={`select ${c.podName}`}
                  />
                </td>
                <td className="px-3 py-1.5 font-mono">
                  <div title={c.podName}>{c.podName}</div>
                  <div className="text-[10px] text-zinc-500" title={c.workspaceId}>
                    ws {c.workspaceId.slice(-8)}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono ${
                      c.status === 'running'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : c.status === 'errored'
                          ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                          : c.status === 'stopped'
                            ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-1.5 font-mono">
                  {c.livePhase ?? <span className="text-zinc-400">—</span>}
                  {c.liveUnschedulable && <span className="ml-1 text-red-600 dark:text-red-400">⚠ unschedulable</span>}
                  {c.liveWaitReason && <div className="text-[10px] text-zinc-500">wait: {c.liveWaitReason}</div>}
                </td>
                <td className="px-3 py-1.5 font-mono">
                  {c.drift === 'aligned' || !c.drift ? (
                    <span className="text-zinc-400">aligned</span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300">{c.drift}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
                  {c.cpuRequest}/{c.cpuLimit} · {c.memoryRequest}/{c.memoryLimit}
                </td>
                <td className="px-3 py-1.5 tabular-nums">
                  {c.ageHours < 1 ? '<1h' : c.ageHours < 24 ? `${c.ageHours}h` : `${Math.floor(c.ageHours / 24)}d`}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-500" title={c.image}>
                  {c.image.split('/').pop()}
                </td>
              </tr>
            ))}
            {data.containers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-zinc-500">
                  No containers match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data.orphanPods.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Orphan K8s pods <span className="text-zinc-500">({data.orphanPods.length})</span>
            </h3>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={selectAllOrphans}
                className="rounded border border-zinc-300 bg-white px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              >
                {selectedPods.size === data.orphanPods.length ? 'Deselect all' : 'Select all'}
              </button>
              <button
                type="button"
                disabled={selectedPods.size === 0 || bulkBusy !== null}
                onClick={() => void runBulk('delete-orphan-pod')}
                className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700 disabled:opacity-50"
              >
                Delete orphan pod(s)
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Pod name</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 font-medium">Age</th>
                  <th className="px-3 py-2 font-medium">Image</th>
                </tr>
              </thead>
              <tbody>
                {data.orphanPods.map((p) => (
                  <tr key={p.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selectedPods.has(p.name)}
                        onChange={() => togglePod(p.name)}
                        aria-label={`select ${p.name}`}
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono">{p.name}</td>
                    <td className="px-3 py-1.5 font-mono">{p.phase}</td>
                    <td className="px-3 py-1.5 tabular-nums">
                      {p.ageHours < 1 ? '<1h' : p.ageHours < 24 ? `${p.ageHours}h` : `${Math.floor(p.ageHours / 24)}d`}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-500">
                      {p.containerImage?.split('/').pop() ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
