'use client';

/**
 * SaveAsMemoryModal — Memory Line B / B4.
 *
 * Triggered from the IM channel "Save as memory" affordance on a chat
 * message. Captures:
 *
 *   - the message text (read-only preview)
 *   - an auto-suggested memory path (`memory/notes/<slug>.md`)
 *   - visibility (default `workspace`)
 *
 * On save the modal posts to `/memory/pages` per the A3 cookbook §3 and
 * tells the host to flip the Library surface to the Memory view + select
 * the new page id.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save, Workflow, X } from 'lucide-react';

import { createMemoryPage } from '../lib/memory-api';

export interface SaveAsMemorySource {
  conversationId: string;
  messageId: string;
  authorImUserId?: string | null;
  authorName?: string | null;
  text: string;
  createdAt?: string | null;
}

interface SaveAsMemoryModalProps {
  open: boolean;
  workspaceId: string | null;
  isDark: boolean;
  source: SaveAsMemorySource | null;
  onClose: () => void;
  /** Called after a successful POST. Host navigates to Library/Memory and selects the new page. */
  onSaved: (page: { id: string; path: string }) => void;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const VISIBILITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'workspace', label: 'workspace' },
  { value: 'human:self', label: 'human · only me' },
  { value: 'agent:self', label: 'agent · scoped' },
];

const PAGE_TYPE_OPTIONS = ['leaf', 'hub', 'decision', 'procedure', 'glossary'];

export function SaveAsMemoryModal({
  open,
  workspaceId,
  isDark,
  source,
  onClose,
  onSaved,
  notify,
}: SaveAsMemoryModalProps) {
  const [path, setPath] = useState('');
  const [pageType, setPageType] = useState<string>('leaf');
  const [visibility, setVisibility] = useState<string>('workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const suggestedPath = useMemo(() => {
    if (!source) return '';
    const slug = slugify(source.text).slice(0, 40) || 'untitled';
    const stamp = (source.createdAt ? new Date(source.createdAt) : new Date()).toISOString().slice(0, 10);
    return `memory/notes/${stamp}-${slug}.md`;
  }, [source]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
      return;
    }
    setPath(suggestedPath);
    setPageType('leaf');
    setVisibility('workspace');
    setError(null);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, suggestedPath]);

  if (!open || !source) return null;

  const trimmedPath = path.trim();
  const canSave = Boolean(workspaceId) && trimmedPath.length > 3 && !busy;

  async function handleSave() {
    if (!workspaceId || !source) return;
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const sourceRefs = [`conversation:${source.conversationId}`, `message:${source.messageId}`];
    if (source.authorImUserId) sourceRefs.push(`actor:${source.authorImUserId}`);
    const content = renderMessageMarkdown(source);
    const res = await createMemoryPage({
      workspaceId,
      path: trimmedPath,
      content,
      pageType,
      visibility,
      sourceRefs,
      rationale: 'Saved from chat via Save as memory',
    });
    setBusy(false);
    if (res.ok) {
      const data = res.data;
      if (data) {
        notify?.('Saved to memory', 'success');
        onSaved({ id: data.id, path: data.path });
        onClose();
      } else {
        setError('Save returned no payload');
      }
      return;
    }
    setError(res.message);
    notify?.(`Save failed: ${res.message}`, 'error');
  }

  return (
    <div data-testid="save-as-memory-modal" className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        data-testid="save-as-memory-modal-backdrop"
        onClick={onClose}
        className={`absolute inset-0 ${isDark ? 'bg-black/60' : 'bg-zinc-900/30'} backdrop-blur-[2px]`}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal
        aria-label="Save chat message as memory page"
        className={`relative w-full max-w-xl rounded-2xl border shadow-2xl ${
          isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
        }`}
      >
        <header
          className={`flex items-center gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <Workflow className={`h-4 w-4 ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
          <p className={`text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Save as memory</p>
          <button
            type="button"
            data-testid="save-as-memory-close"
            onClick={onClose}
            className={`ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-4 py-3">
          <p
            className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${
              isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            Captured message
          </p>
          <pre
            data-testid="save-as-memory-preview"
            className={`max-h-32 overflow-y-auto rounded-xl border px-3 py-2 text-xs leading-relaxed ${
              isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
            }`}
          >
            {source.text}
          </pre>

          <div className="mt-3 grid gap-2">
            <div>
              <p
                className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${
                  isDark ? 'text-zinc-500' : 'text-zinc-500'
                }`}
              >
                Path
              </p>
              <input
                ref={inputRef}
                data-testid="save-as-memory-path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="memory/notes/2026-05-08-foo.md"
                className={`w-full rounded-xl border px-3 py-2 text-xs outline-none ${
                  isDark
                    ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100 placeholder:text-zinc-500'
                    : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                }`}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <p
                  className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${
                    isDark ? 'text-zinc-500' : 'text-zinc-500'
                  }`}
                >
                  Page type
                </p>
                <select
                  data-testid="save-as-memory-pagetype"
                  value={pageType}
                  onChange={(event) => setPageType(event.target.value)}
                  className={`w-full rounded-xl border px-3 py-2 text-xs outline-none ${
                    isDark
                      ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100'
                      : 'border-zinc-200 bg-white text-zinc-900'
                  }`}
                >
                  {PAGE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p
                  className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${
                    isDark ? 'text-zinc-500' : 'text-zinc-500'
                  }`}
                >
                  Visibility
                </p>
                <select
                  data-testid="save-as-memory-visibility"
                  value={visibility}
                  onChange={(event) => setVisibility(event.target.value)}
                  className={`w-full rounded-xl border px-3 py-2 text-xs outline-none ${
                    isDark
                      ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100'
                      : 'border-zinc-200 bg-white text-zinc-900'
                  }`}
                >
                  {VISIBILITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {error ? (
            <p
              data-testid="save-as-memory-error"
              className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
                isDark ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer
          className={`flex items-center justify-end gap-2 border-t px-4 py-3 ${
            isDark ? 'border-white/[0.06]' : 'border-zinc-200'
          }`}
        >
          <button
            type="button"
            data-testid="save-as-memory-cancel"
            onClick={onClose}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="save-as-memory-confirm"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold ${
              !canSave
                ? isDark
                  ? 'cursor-not-allowed bg-white/[0.04] text-zinc-600'
                  : 'cursor-not-allowed bg-zinc-100 text-zinc-400'
                : isDark
                  ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                  : 'bg-violet-100 text-violet-900 hover:bg-violet-200'
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save to memory
          </button>
        </footer>
      </div>
    </div>
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function renderMessageMarkdown(source: SaveAsMemorySource): string {
  const lines: string[] = [];
  const author = source.authorName ?? source.authorImUserId ?? 'unknown';
  const stamp = source.createdAt ?? new Date().toISOString();
  lines.push(`# Captured chat message`);
  lines.push('');
  lines.push(`> From **${author}** at ${stamp}`);
  lines.push('');
  lines.push(source.text);
  return lines.join('\n');
}
