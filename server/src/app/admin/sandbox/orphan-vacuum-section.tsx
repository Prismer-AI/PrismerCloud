'use client';

/**
 * Orphan vacuum section — admin tool for cleaning residue rows whose
 * `workspaceId` (or chain FK) points to a parent that no longer exists.
 *
 * UX flow:
 *   1. Mount → GET /orphan-vacuum returns per-table counts + sample ghost ids
 *   2. User reviews + optionally selects specific tables
 *   3. Click "Vacuum" → POST executes, table reloads with new counts
 *
 * Single screen, no streaming SSE — vacuum is fast (set-based DELETEs)
 * and we report final counts via the POST response.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { getIMClientToken } from '@/lib/im-token';

interface TableReport {
  name: string;
  parentTable: string;
  fkColumn: string;
  orphanCount: number;
  sampleGhostIds: string[];
}

interface PreviewResponse {
  tables: TableReport[];
  totalOrphans: number;
  parentTableCounts: Record<string, number>;
}

interface VacuumResult {
  tables: Array<{ name: string; deleted: number; error?: string }>;
  totalDeleted: number;
  durationMs: number;
}

async function authedFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const token = getIMClientToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(input, { ...init, headers, cache: 'no-store' });
}

export function OrphanVacuumSection(): React.JSX.Element {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<VacuumResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authedFetch('/api/sandboxes/_admin/orphan-vacuum');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreview((await res.json()) as PreviewResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const tablesWithOrphans = preview?.tables.filter((t) => t.orphanCount > 0) ?? [];
  const selectAll = () => {
    if (selected.size === tablesWithOrphans.length) setSelected(new Set());
    else setSelected(new Set(tablesWithOrphans.map((t) => t.name)));
  };

  const runVacuum = useCallback(async () => {
    if (busy || !preview) return;
    const target = selected.size > 0 ? Array.from(selected) : null;
    const label = target ? `${target.length} table(s)` : `all ${tablesWithOrphans.length} table(s)`;
    if (!confirm(`Vacuum orphan rows in ${label}? This permanently deletes rows whose workspaceId (or chain FK) points to a missing parent.`)) {
      return;
    }
    setBusy(true);
    setLastResult(null);
    try {
      const res = await authedFetch('/api/sandboxes/_admin/orphan-vacuum', {
        method: 'POST',
        body: JSON.stringify(target ? { onlyTables: target } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text}`);
      }
      setLastResult((await res.json()) as VacuumResult);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setLastResult({
        tables: [{ name: '(request)', deleted: 0, error: err instanceof Error ? err.message : String(err) }],
        totalDeleted: 0,
        durationMs: 0,
      });
    } finally {
      setBusy(false);
    }
  }, [busy, preview, selected, tablesWithOrphans, refresh]);

  if (error && !preview) {
    const forbidden = /\b403\b/.test(error);
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        {forbidden ? 'Admin access required for orphan vacuum.' : `Vacuum preview unavailable: ${error}`}
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Scanning for orphan rows…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Orphan vacuum</h2>
          <p className="text-xs text-zinc-500">
            {preview.totalOrphans.toLocaleString()} orphan row(s) across {tablesWithOrphans.length} table(s).
            Residue from earlier ad-hoc workspace deletes that didn&apos;t cascade. New deletions via
            <code className="mx-1">/workspace/[id]/settings → Clear workspace</code> already cascade
            correctly; this is for the historical cleanup.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={selectAll}
            disabled={busy || tablesWithOrphans.length === 0}
            className="rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            {selected.size === tablesWithOrphans.length && tablesWithOrphans.length > 0 ? 'Deselect all' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={() => void runVacuum()}
            disabled={busy || tablesWithOrphans.length === 0}
            className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Vacuum {selected.size > 0 ? `(${selected.size})` : '(all)'}
          </button>
        </div>
      </header>

      {lastResult && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            lastResult.tables.some((t) => t.error)
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-1.5">
            {lastResult.tables.some((t) => t.error) ? (
              <AlertCircle className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            <span className="font-medium">
              Vacuum complete · deleted {lastResult.totalDeleted.toLocaleString()} row(s) · {lastResult.durationMs}ms
            </span>
          </div>
          {lastResult.tables.some((t) => t.error) && (
            <details className="mt-1 cursor-pointer">
              <summary>show errors</summary>
              <ul className="mt-1 list-disc pl-4 font-mono">
                {lastResult.tables
                  .filter((t) => t.error)
                  .map((t) => (
                    <li key={t.name}>
                      {t.name}: {t.error}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {tablesWithOrphans.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200">
          <CheckCircle2 className="inline h-4 w-4 mr-1" /> No orphan rows detected. Database is clean.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">
                  <input
                    type="checkbox"
                    checked={selected.size === tablesWithOrphans.length && tablesWithOrphans.length > 0}
                    onChange={selectAll}
                    aria-label="select all tables"
                  />
                </th>
                <th className="px-3 py-2 font-medium">Table</th>
                <th className="px-3 py-2 font-medium">Parent</th>
                <th className="px-3 py-2 font-medium text-right">Orphans</th>
                <th className="px-3 py-2 font-medium">Ghost {`(${'FK column'})`}</th>
              </tr>
            </thead>
            <tbody>
              {tablesWithOrphans.map((t) => (
                <tr
                  key={t.name}
                  className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(t.name)}
                      onChange={() => toggle(t.name)}
                      aria-label={`select ${t.name}`}
                    />
                  </td>
                  <td className="px-3 py-1.5 font-mono">{t.name}</td>
                  <td className="px-3 py-1.5 font-mono text-zinc-500">{t.parentTable}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{t.orphanCount.toLocaleString()}</td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-zinc-500">
                    {t.sampleGhostIds.length > 0
                      ? `${t.fkColumn}: ${t.sampleGhostIds.slice(0, 3).join(', ')}${t.sampleGhostIds.length > 3 ? '…' : ''}`
                      : `${t.fkColumn} (no sample)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
