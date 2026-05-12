'use client';

/**
 * LibraryMemoryActions — Memory Line B / B4.
 *
 * Action bar mounted inside the LibraryMemoryPanel detail header. Wires
 * archive / unarchive / visibility / promote / soft-delete / stale toggle
 * against the A3 mutation endpoints.
 *
 * Concurrency: visibility + promote send `If-Match` headers derived from
 * the page version; on 412 the bar clears and re-fetches via the parent's
 * `onMutated` callback.
 */

import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Eye, Loader2, RefreshCcw, ShieldAlert, Trash2 } from 'lucide-react';

import {
  archiveMemoryPage,
  changeMemoryVisibility,
  deleteMemoryPage,
  promoteMemoryPage,
  toggleMemoryStale,
  unarchiveMemoryPage,
  type MemoryPageDetailDTO,
} from '../lib/memory-api';

const VISIBILITY_PRESETS: Array<{ value: string; label: string; ownerOnly?: boolean }> = [
  { value: 'workspace', label: 'workspace' },
  { value: 'human:self', label: 'human · only me', ownerOnly: true },
  { value: 'task:current', label: 'task · current' },
  { value: 'secret-ref', label: 'secret reference', ownerOnly: true },
];

interface LibraryMemoryActionsProps {
  isDark: boolean;
  page: MemoryPageDetailDTO;
  /** Current viewer's IM user id, used to expand `human:self`. */
  myImUserId: string | null;
  /** Whether the viewer is the workspace owner human (gates promote / human:* / secret-ref). */
  isOwnerHuman: boolean;
  /** Active task id (when the workspace surface knows one) — used to expand `task:current`. */
  activeTaskId: string | null;
  /** Called after any successful mutation; parent should refetch list + detail. */
  onMutated: () => void;
  /** Called after a soft-delete so the parent can clear the selected page id. */
  onDeleted: () => void;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function LibraryMemoryActions({
  isDark,
  page,
  myImUserId,
  isOwnerHuman,
  activeTaskId,
  onMutated,
  onDeleted,
  notify,
}: LibraryMemoryActionsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'delete' | null>(null);
  const [staleOpen, setStaleOpen] = useState(false);
  const [staleReason, setStaleReason] = useState('');
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const visibilityRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visibilityOpen) return undefined;
    function onClick(event: MouseEvent) {
      if (!visibilityRef.current) return;
      if (!visibilityRef.current.contains(event.target as Node)) {
        setVisibilityOpen(false);
      }
    }
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [visibilityOpen]);

  async function withBusy(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  function handleApiResult(label: string, result: { ok: true } | { ok: false; status: number; message: string }) {
    if (result.ok) {
      notify?.(`${label} succeeded`, 'success');
      onMutated();
      return true;
    }
    if (result.status === 412) {
      notify?.(`${label}: page changed concurrently — reloading`, 'info');
      onMutated();
      return false;
    }
    notify?.(`${label} failed: ${result.message}`, 'error');
    return false;
  }

  const archived = Boolean(page.archivedAt);

  return (
    <div
      data-testid="library-memory-actions"
      className={`flex flex-wrap items-center gap-1.5 border-t px-4 py-2 ${
        isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-zinc-50/60'
      }`}
    >
      {archived ? (
        <ActionButton
          isDark={isDark}
          testId="library-memory-action-unarchive"
          onClick={() =>
            withBusy('unarchive', async () => {
              const res = await unarchiveMemoryPage(page.id, page.workspaceId);
              handleApiResult('Unarchive', res);
            })
          }
          busy={busy === 'unarchive'}
          icon={<ArchiveRestore className="h-3.5 w-3.5" />}
          label="Unarchive"
        />
      ) : (
        <ActionButton
          isDark={isDark}
          testId="library-memory-action-archive"
          onClick={() =>
            withBusy('archive', async () => {
              const res = await archiveMemoryPage(page.id, page.workspaceId);
              handleApiResult('Archive', res);
            })
          }
          busy={busy === 'archive'}
          icon={<Archive className="h-3.5 w-3.5" />}
          label="Archive"
        />
      )}

      <div ref={visibilityRef} className="relative">
        <ActionButton
          isDark={isDark}
          testId="library-memory-action-visibility"
          onClick={() => setVisibilityOpen((prev) => !prev)}
          busy={busy === 'visibility'}
          icon={<Eye className="h-3.5 w-3.5" />}
          label={`Visibility · ${page.visibility ?? 'workspace'}`}
          trailing={<ChevronDown className="h-3 w-3 opacity-60" />}
        />
        {visibilityOpen ? (
          <div
            data-testid="library-memory-visibility-menu"
            className={`absolute left-0 top-full z-20 mt-1 w-56 rounded-2xl border p-1 shadow-2xl ${
              isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
            }`}
          >
            {VISIBILITY_PRESETS.map((preset) => {
              const expandedValue =
                preset.value === 'human:self' && myImUserId
                  ? `human:${myImUserId}`
                  : preset.value === 'task:current' && activeTaskId
                    ? `task:${activeTaskId}`
                    : preset.value;
              const disabled =
                (preset.ownerOnly && !isOwnerHuman) || (preset.value === 'task:current' && !activeTaskId);
              return (
                <button
                  key={preset.value}
                  type="button"
                  data-testid={`library-memory-visibility-option-${preset.value}`}
                  disabled={disabled}
                  onClick={async () => {
                    setVisibilityOpen(false);
                    await withBusy('visibility', async () => {
                      const res = await changeMemoryVisibility(
                        page.id,
                        { workspaceId: page.workspaceId, visibility: expandedValue },
                        page.version,
                      );
                      handleApiResult('Visibility update', res);
                    });
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs transition-colors ${
                    disabled
                      ? isDark
                        ? 'cursor-not-allowed text-zinc-600'
                        : 'cursor-not-allowed text-zinc-300'
                      : isDark
                        ? 'text-zinc-200 hover:bg-white/[0.05]'
                        : 'text-zinc-800 hover:bg-zinc-100'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {isOwnerHuman && page.visibility && page.visibility !== 'workspace' ? (
        <ActionButton
          isDark={isDark}
          testId="library-memory-action-promote"
          onClick={() =>
            withBusy('promote', async () => {
              const res = await promoteMemoryPage(
                page.id,
                { workspaceId: page.workspaceId, to: 'workspace' },
                page.version,
              );
              handleApiResult('Promote', res);
            })
          }
          busy={busy === 'promote'}
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          label="Promote to workspace"
        />
      ) : null}

      <div className="relative">
        <ActionButton
          isDark={isDark}
          testId="library-memory-action-stale"
          onClick={() => setStaleOpen((prev) => !prev)}
          busy={busy === 'stale'}
          icon={<RefreshCcw className="h-3.5 w-3.5" />}
          label={page.stale ? 'Clear stale' : 'Mark stale'}
        />
        {staleOpen ? (
          <div
            data-testid="library-memory-stale-popup"
            className={`absolute left-0 top-full z-20 mt-1 w-72 rounded-2xl border p-3 shadow-2xl ${
              isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
            }`}
          >
            <p
              className={`mb-1.5 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
            >
              {page.stale ? 'Reason for clearing stale' : 'Reason for marking stale'}
            </p>
            <input
              data-testid="library-memory-stale-reason"
              value={staleReason}
              onChange={(event) => setStaleReason(event.target.value)}
              placeholder="e.g. source archived"
              className={`w-full rounded-lg border px-2 py-1 text-xs outline-none ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100 placeholder:text-zinc-500'
                  : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
            <div className="mt-2 flex justify-end gap-1">
              <button
                type="button"
                onClick={() => {
                  setStaleOpen(false);
                  setStaleReason('');
                }}
                className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                  isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="library-memory-stale-confirm"
                onClick={async () => {
                  const reason = staleReason.trim();
                  setStaleOpen(false);
                  setStaleReason('');
                  await withBusy('stale', async () => {
                    const res = await toggleMemoryStale(page.id, {
                      workspaceId: page.workspaceId,
                      stale: !page.stale,
                      reason: reason || undefined,
                    });
                    handleApiResult(page.stale ? 'Clear stale' : 'Mark stale', res);
                  });
                }}
                className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                  isDark
                    ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                    : 'bg-violet-100 text-violet-900 hover:bg-violet-200'
                }`}
              >
                Apply
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="ml-auto">
        {confirming === 'delete' ? (
          <div className="flex items-center gap-1">
            <span className={`text-[10px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>Delete this page?</span>
            <button
              type="button"
              data-testid="library-memory-action-delete-cancel"
              onClick={() => setConfirming(null)}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="library-memory-action-delete-confirm"
              onClick={async () => {
                setConfirming(null);
                await withBusy('delete', async () => {
                  const res = await deleteMemoryPage(page.id, page.workspaceId);
                  if (handleApiResult('Soft-delete', res)) {
                    onDeleted();
                  }
                });
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                isDark
                  ? 'bg-rose-500/30 text-rose-100 hover:bg-rose-500/40'
                  : 'bg-rose-100 text-rose-900 hover:bg-rose-200'
              }`}
            >
              Delete
            </button>
          </div>
        ) : (
          <ActionButton
            isDark={isDark}
            testId="library-memory-action-delete"
            onClick={() => setConfirming('delete')}
            busy={busy === 'delete'}
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete"
            tone="danger"
          />
        )}
      </div>
    </div>
  );
}

function ActionButton({
  isDark,
  testId,
  onClick,
  busy,
  icon,
  label,
  trailing,
  tone,
}: {
  isDark: boolean;
  testId: string;
  onClick: () => void;
  busy: boolean;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  tone?: 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={busy}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        busy
          ? 'cursor-wait opacity-60'
          : danger
            ? isDark
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
              : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
            : isDark
              ? 'border-white/[0.06] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]'
              : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      <span>{label}</span>
      {trailing}
    </button>
  );
}
