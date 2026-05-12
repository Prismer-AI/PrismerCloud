'use client';

/**
 * §30 B3.8 Q2 — Settings → Workspace → Team list-item rename row.
 *
 * **Mount point**: No Settings page exists yet in this app (only `/dashboard`
 * and `/workspace`). When the Settings surface lands, mount this component
 * once per agent in the Team list. Until then it's referenced only by tests
 * + Storybook-style isolation; the inline pencil on the agent card
 * (InlineAgentRename) is the live entry point.
 *
 * Behavior contract:
 *   - Row shows avatar + displayName + `@slug` badge + edit + delete buttons.
 *   - Edit opens a small modal with: validation-rule helper text, input,
 *     Save / Cancel. Same validation + PATCH path as the inline editor.
 *   - Delete is out of scope for B3.8 — left as a stubbed callback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { renameAgent, validateAgentSlug } from '../../lib/agent-rename';

interface SettingsAgentRowProps {
  agentImUserId: string;
  displayName: string;
  currentSlug: string;
  avatarUrl?: string | null;
  isDark?: boolean;
  onRenamed?: (newSlug: string) => void;
  onDelete?: () => void;
}

export function SettingsAgentRename({
  agentImUserId,
  displayName,
  currentSlug,
  avatarUrl,
  isDark = false,
  onRenamed,
  onDelete,
}: SettingsAgentRowProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div
        className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
          isDark ? 'border-white/[0.08] bg-white/[0.025]' : 'border-zinc-200 bg-white/70'
        }`}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
        ) : (
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold ${
              isDark ? 'bg-white/[0.06] text-zinc-200' : 'bg-zinc-100 text-zinc-700'
            }`}
          >
            {displayName.slice(0, 2).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {displayName}
          </div>
          <div className={`truncate font-mono text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            @{currentSlug}
          </div>
        </div>
        <button
          type="button"
          aria-label="Rename"
          onClick={() => setModalOpen(true)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold ${
            isDark
              ? 'border-white/[0.1] text-zinc-300 hover:bg-white/[0.05]'
              : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
          }`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Rename
        </button>
        <button
          type="button"
          aria-label="Delete"
          onClick={onDelete}
          disabled={!onDelete}
          className={`inline-flex h-8 items-center justify-center rounded-xl border px-2 text-xs font-semibold ${
            isDark
              ? 'border-white/[0.1] text-red-300 hover:bg-red-500/10 disabled:opacity-40'
              : 'border-zinc-200 text-red-600 hover:bg-red-50 disabled:opacity-40'
          }`}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {modalOpen ? (
        <RenameModal
          agentImUserId={agentImUserId}
          displayName={displayName}
          currentSlug={currentSlug}
          isDark={isDark}
          onClose={() => setModalOpen(false)}
          onRenamed={(slug) => {
            onRenamed?.(slug);
            setModalOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function RenameModal({
  agentImUserId,
  displayName,
  currentSlug,
  isDark,
  onClose,
  onRenamed,
}: {
  agentImUserId: string;
  displayName: string;
  currentSlug: string;
  isDark: boolean;
  onClose: () => void;
  onRenamed: (slug: string) => void;
}) {
  const [value, setValue] = useState(currentSlug);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const validation = validateAgentSlug(value);
  const unchanged = value === currentSlug;
  const canSubmit = validation.valid && !unchanged && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    const res = await renameAgent(agentImUserId, { username: value });
    setSubmitting(false);
    if (!res.ok) {
      setServerError(res.message || res.error || 'Rename failed');
      return;
    }
    onRenamed(value);
  }, [agentImUserId, canSubmit, onRenamed, value]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Rename agent"
        className={`w-full max-w-md rounded-3xl border p-6 ${
          isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Rename {displayName}</h2>
        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          Username 必须是 3-31 个小写字母 / 数字 / 连字符，且以字母开头。在 workspace 内唯一。
        </p>
        <input
          ref={inputRef}
          type="text"
          aria-label="Agent username"
          value={value}
          maxLength={31}
          disabled={submitting}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          className={`mt-4 w-full rounded-xl border bg-transparent px-3 py-2 font-mono text-sm outline-none transition ${
            !validation.valid && value.length > 0
              ? 'border-red-500'
              : isDark
                ? 'border-white/15 focus:border-cyan-400'
                : 'border-zinc-300 focus:border-cyan-500'
          }`}
        />
        {(!validation.valid && value.length > 0) || serverError ? (
          <p role="alert" className="mt-2 text-xs text-red-500">
            {serverError ?? (!validation.valid && validation.reason)}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
              isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-700 hover:bg-zinc-50'
            }`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className={`rounded-xl px-3 py-2 text-xs font-semibold ${
              canSubmit
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : 'cursor-not-allowed bg-zinc-300 text-zinc-500'
            }`}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
