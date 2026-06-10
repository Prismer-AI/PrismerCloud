'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Clock3, Loader2 } from 'lucide-react';

import { getWorkspaceToken } from '../lib/im-api';
import type { AssetDTO, AssetRevisionListDTO, WorkspaceFileDTO } from '../lib/types';

interface AssetVersionSelectorProps {
  currentAsset: AssetDTO | null;
  currentFile: WorkspaceFileDTO | null;
  selectedAssetId?: string | null;
  isDark: boolean;
  onSelectAsset: (assetId: string) => void;
  className?: string;
}

type HistoryResponse =
  | { ok: true; data: WorkspaceFileDTO[] }
  | { ok: false; error?: string | { code?: string; message?: string }; message?: string };

type RevisionResponse =
  | { ok: true; data: AssetRevisionListDTO }
  | { ok: false; error?: string | { code?: string; message?: string }; message?: string };

/**
 * Minimal WorkspaceFile version selector.
 *
 * This intentionally reads `im_workspace_files` history only. Standalone
 * immutable asset revisions are handled by `AssetRevisionSelector` below.
 */
export function AssetVersionSelector({
  currentAsset,
  currentFile,
  selectedAssetId,
  isDark,
  onSelectAsset,
  className,
}: AssetVersionSelectorProps) {
  const [items, setItems] = useState<WorkspaceFileDTO[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentFile) {
      return;
    }

    const abort = new AbortController();
    void (async () => {
      const token = getWorkspaceToken();
      if (!token) {
        setItems([]);
        setStatus('error');
        setError('Missing workspace token');
        return;
      }

      setStatus('loading');
      setError(null);

      try {
        const res = await fetch(
          `/api/im/workspaces/${encodeURIComponent(currentFile.workspaceId)}/files/${encodeURIComponent(
            currentFile.id,
          )}/history`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: abort.signal,
          },
        );
        const body = (await res.json().catch(() => null)) as HistoryResponse | null;
        if (!body) throw new Error(`Version history failed (${res.status})`);
        if (!res.ok || body.ok !== true) {
          const rawError = body.ok === false ? body.error : null;
          const message =
            typeof rawError === 'string'
              ? rawError
              : rawError?.message ||
                (body.ok === false ? body.message : undefined) ||
                `Version history failed (${res.status})`;
          throw new Error(message);
        }
        setItems(body.data);
        setStatus('ready');
      } catch (err) {
        if (abort.signal.aborted) return;
        setItems([]);
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to load version history');
      }
    })();

    return () => abort.abort();
  }, [currentFile]);

  const history = useMemo(() => {
    if (!currentFile) return [];
    if (items.some((item) => item.id === currentFile.id)) return items;
    return [currentFile, ...items];
  }, [currentFile, items]);

  const basePanel = isDark
    ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100'
    : 'border-zinc-200 bg-zinc-50 text-zinc-900';
  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const buttonBase = isDark
    ? 'border-white/[0.08] bg-zinc-950/30 hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white hover:bg-zinc-100';
  const currentButton = isDark ? 'border-emerald-400/40 bg-emerald-500/10' : 'border-emerald-300 bg-emerald-50';

  if (!currentFile) {
    return (
      <section className={`rounded-2xl border px-4 py-3 ${basePanel} ${className ?? ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Workspace file versions</p>
            <p className={`mt-1 text-xs ${muted}`}>
              Asset revision v{currentAsset?.revision ?? 1} is shown read-only. WorkspaceFile history is unavailable
              without a bound file.
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2 py-1 text-[11px] ${
              isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-600'
            }`}
          >
            read-only
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-2xl border px-4 py-3 ${basePanel} ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Workspace file versions</p>
          <p className={`mt-1 truncate text-xs ${muted}`}>{currentFile.path}</p>
        </div>
        {status === 'loading' ? <Loader2 className={`h-4 w-4 animate-spin ${muted}`} /> : null}
      </div>

      {status === 'error' ? <p className="mt-3 text-xs text-rose-400">{error}</p> : null}

      <div className="mt-3 grid gap-2">
        {history.map((file) => {
          const activeAssetId = selectedAssetId ?? currentAsset?.id ?? null;
          const isCurrent = file.id === currentFile.id;
          const isSelected = file.assetId === activeAssetId;
          const hashChanged = Boolean(currentFile.contentHash && file.contentHash !== currentFile.contentHash);
          const canSelect = Boolean(file.assetId) && !isSelected;

          return (
            <button
              key={file.id}
              type="button"
              disabled={!canSelect}
              onClick={() => {
                if (canSelect) onSelectAsset(file.assetId);
              }}
              className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                isCurrent ? currentButton : buttonBase
              } ${canSelect ? 'cursor-pointer' : 'cursor-default opacity-95'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {isCurrent ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Clock3 className="h-3.5 w-3.5" />}
                  <span className="truncate text-xs font-semibold">v{file.version}</span>
                </span>
                {isCurrent ? (
                  <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                    current
                  </span>
                ) : isSelected ? (
                  <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                    selected
                  </span>
                ) : null}
              </div>
              <div className={`mt-1 grid gap-1 text-[11px] ${muted}`}>
                <p className="truncate">hash {shortHash(file.contentHash)}</p>
                <p className="truncate">updated {formatDateTime(file.updatedAt)}</p>
                {hashChanged ? <p className="text-amber-400">content hash differs from current</p> : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface AssetRevisionSelectorProps {
  currentAsset: AssetDTO | null;
  selectedRevision?: number | null;
  isDark: boolean;
  onSelectRevision: (revision: number | null) => void;
  className?: string;
}

export function AssetRevisionSelector({
  currentAsset,
  selectedRevision,
  isDark,
  onSelectRevision,
  className,
}: AssetRevisionSelectorProps) {
  const [revisionList, setRevisionList] = useState<AssetRevisionListDTO | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentAsset) {
      setRevisionList(null);
      setStatus('idle');
      setError(null);
      return;
    }

    const abort = new AbortController();
    void (async () => {
      const token = getWorkspaceToken();
      if (!token) {
        setRevisionList(null);
        setStatus('error');
        setError('Missing workspace token');
        return;
      }

      setStatus('loading');
      setError(null);

      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(currentAsset.id)}/revisions`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        const body = (await res.json().catch(() => null)) as RevisionResponse | null;
        if (!body) throw new Error(`Asset revisions failed (${res.status})`);
        if (!res.ok || body.ok !== true) {
          const rawError = body.ok === false ? body.error : null;
          const message =
            typeof rawError === 'string'
              ? rawError
              : rawError?.message ||
                (body.ok === false ? body.message : undefined) ||
                `Asset revisions failed (${res.status})`;
          throw new Error(message);
        }
        setRevisionList(body.data);
        setStatus('ready');
      } catch (err) {
        if (abort.signal.aborted) return;
        setRevisionList(null);
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to load asset revisions');
      }
    })();

    return () => abort.abort();
  }, [currentAsset]);

  const basePanel = isDark
    ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100'
    : 'border-zinc-200 bg-zinc-50 text-zinc-900';
  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';
  const buttonBase = isDark
    ? 'border-white/[0.08] bg-zinc-950/30 hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white hover:bg-zinc-100';
  const currentButton = isDark ? 'border-sky-400/40 bg-sky-500/10' : 'border-sky-300 bg-sky-50';

  if (!currentAsset) return null;

  const currentRevision = revisionList?.currentRevision ?? currentAsset.revision ?? 1;
  const activeRevision = selectedRevision ?? currentRevision;
  const revisionItems = revisionList?.items ?? [];
  const revisions =
    revisionItems.length > 0
      ? revisionItems
      : [
          {
            id: `${currentAsset.id}:${currentRevision}`,
            assetId: currentAsset.id,
            workspaceId: currentAsset.workspaceId,
            revision: currentRevision,
            contentHash: currentAsset.contentHash,
            sizeBytes: currentAsset.sizeBytes,
            mime: currentAsset.mime,
            kind: currentAsset.kind,
            filename: currentAsset.filename ?? null,
            folderPath: currentAsset.folderPath ?? null,
            sourceRef: currentAsset.sourceRef ?? null,
            sourceKind: currentAsset.sourceKind ?? null,
            ingestStatus: currentAsset.ingestStatus ?? 'asset-only',
            ingestVersion: currentAsset.ingestVersion ?? 1,
            deletedAt: currentAsset.deletedAt ?? null,
            createdByImUserId: null,
            reason: 'current',
            createdAt: currentAsset.updatedAt ?? currentAsset.createdAt,
          },
        ];

  return (
    <section className={`rounded-2xl border px-4 py-3 ${basePanel} ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Asset revisions</p>
          <p className={`mt-1 truncate text-xs ${muted}`}>current v{currentRevision}</p>
        </div>
        {status === 'loading' ? <Loader2 className={`h-4 w-4 animate-spin ${muted}`} /> : null}
      </div>

      {status === 'error' ? <p className="mt-3 text-xs text-rose-400">{error}</p> : null}

      <div className="mt-3 grid gap-2">
        {revisions.map((revision) => {
          const isCurrent = revision.revision === currentRevision;
          const isSelected = revision.revision === activeRevision;
          const canSelect = !isSelected;
          return (
            <button
              key={`${revision.assetId}:${revision.revision}`}
              type="button"
              disabled={!canSelect}
              onClick={() => onSelectRevision(isCurrent ? null : revision.revision)}
              className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                isCurrent ? currentButton : buttonBase
              } ${canSelect ? 'cursor-pointer' : 'cursor-default opacity-95'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {isCurrent ? <Check className="h-3.5 w-3.5 text-sky-400" /> : <Clock3 className="h-3.5 w-3.5" />}
                  <span className="truncate text-xs font-semibold">v{revision.revision}</span>
                </span>
                {isCurrent ? (
                  <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                    current
                  </span>
                ) : isSelected ? (
                  <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                    selected
                  </span>
                ) : null}
              </div>
              <div className={`mt-1 grid gap-1 text-[11px] ${muted}`}>
                <p className="truncate">hash {shortHash(revision.contentHash)}</p>
                <p className="truncate">created {formatDateTime(revision.createdAt)}</p>
                {revision.reason ? <p className="truncate">reason {revision.reason}</p> : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function shortHash(hash?: string | null): string {
  if (!hash) return '-';
  return hash.length > 16 ? `${hash.slice(0, 16)}...` : hash;
}

function formatDateTime(value?: string | null): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
