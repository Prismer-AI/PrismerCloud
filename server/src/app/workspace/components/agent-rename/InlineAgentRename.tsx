'use client';

/**
 * §30 B3.8 Q2 — inline rename editor for the agent slug.
 *
 * Drop next to any agent's username display: a pencil icon overlays the
 * label (low opacity until hover); clicking it swaps the label for an
 * `<input>` pre-filled with the current slug. Enter submits, Esc cancels,
 * click-outside cancels. Validation is reactive — input keeps a red border
 * + inline `role="alert"` text while invalid; submit button is disabled
 * until the slug both validates and differs from the current value.
 *
 * After a successful PATCH the editor flashes a check icon for ~1s and
 * calls `onRenamed(newSlug)` so the parent can update its agent cache
 * without a refetch round-trip (the WS `agent.changed` event lands later
 * for cross-device sync).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { renameAgent, validateAgentSlug } from '../../lib/agent-rename';

interface InlineAgentRenameProps {
  agentImUserId: string;
  currentSlug: string;
  isDark?: boolean;
  /** Called on successful PATCH so the parent can update its local cache. */
  onRenamed?: (newSlug: string) => void;
  /**
   * Visual size hint — `sm` is for the compact `DeviceAgentCard` (sits
   * inline next to the displayName), `md` is the Settings row variant.
   */
  size?: 'sm' | 'md';
}

export function InlineAgentRename({
  agentImUserId,
  currentSlug,
  isDark = false,
  onRenamed,
  size = 'sm',
}: InlineAgentRenameProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentSlug);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  // Reset working copy whenever the source slug changes externally (e.g.
  // a WS `agent.changed` from another device).
  useEffect(() => {
    if (!editing) setValue(currentSlug);
  }, [currentSlug, editing]);

  // Focus + select on open so the user can immediately type to overwrite.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const cancel = useCallback(() => {
    setEditing(false);
    setValue(currentSlug);
    setServerError(null);
  }, [currentSlug]);

  // Click-outside cancels (matches Esc semantics — user wanted out without
  // committing). Skipped while submitting so the PATCH can finish cleanly.
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (submitting) return;
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        cancel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing, submitting, cancel]);

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
    setJustSaved(true);
    setEditing(false);
    onRenamed?.(value);
    window.setTimeout(() => setJustSaved(false), 1200);
  }, [agentImUserId, canSubmit, onRenamed, value]);

  if (!editing) {
    return (
      <span ref={wrapperRef} className="inline-flex items-center gap-1">
        <button
          type="button"
          aria-label="Rename"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          className={`opacity-50 transition hover:opacity-100 ${
            size === 'md' ? 'p-1' : 'p-0.5'
          } ${isDark ? 'text-zinc-300 hover:text-white' : 'text-zinc-500 hover:text-zinc-900'}`}
        >
          <Pencil className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} aria-hidden="true" />
        </button>
        {justSaved ? (
          <Check className={`text-emerald-500 ${size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'}`} aria-label="Saved" />
        ) : null}
      </span>
    );
  }

  const showError = !validation.valid && value.length > 0;
  const inputBorder = showError
    ? 'border-red-500'
    : isDark
      ? 'border-white/20 focus:border-cyan-400'
      : 'border-zinc-300 focus:border-cyan-500';

  return (
    <span ref={wrapperRef} className="inline-flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
      <span className="inline-flex items-center gap-1">
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
              cancel();
            }
            e.stopPropagation();
          }}
          className={`rounded border bg-transparent px-1.5 outline-none transition ${inputBorder} ${
            size === 'md' ? 'h-7 text-sm' : 'h-6 text-xs'
          } ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
          style={{ width: `${Math.max(8, Math.min(value.length + 2, 32))}ch` }}
        />
        <button
          type="button"
          aria-label="Save"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className={`p-0.5 transition ${
            canSubmit ? 'text-emerald-500 hover:text-emerald-400' : 'text-zinc-400 opacity-50'
          }`}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label="Cancel"
          onClick={cancel}
          disabled={submitting}
          className="p-0.5 text-zinc-400 transition hover:text-zinc-200"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </span>
      {(showError || serverError) && (
        <span role="alert" className="text-[10px] text-red-500">
          {serverError ?? (!validation.valid && validation.reason)}
        </span>
      )}
    </span>
  );
}
