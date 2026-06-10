'use client';

/**
 * Message forward picker — choose one or more target conversations and
 * relay a chat message to each. Replaces the previous quote-to-clipboard
 * shortcut on the bubble action bar.
 *
 * v1 scope:
 *   - Single modal, searchable conversation list
 *   - Multi-select via per-row checkbox
 *   - On confirm: POST a plain text message to each target with a "Forwarded
 *     from {sender} ({timestamp})" prefix
 *   - Reports per-target success/failure aggregated into one toast
 *
 * The source-conversation id is excluded from the picker (forwarding to
 * the same chat is meaningless). The current conversation is also excluded
 * because the user already sees the message there.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Forward, Loader2, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { sendMessage } from '../lib/mutations';
import { cn } from '@/lib/utils';
import type { ConversationDTO } from '../lib/types';

export interface MessageForwardSource {
  /** Source conversation id — excluded from the target picker. */
  conversationId: string;
  messageId: string;
  text: string;
  senderName: string;
  createdAt: string;
}

interface MessageForwardDialogProps {
  open: boolean;
  isDark: boolean;
  source: MessageForwardSource | null;
  conversations: ConversationDTO[];
  onClose: () => void;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

function conversationLabel(c: ConversationDTO): string {
  if (c.displayTitle?.trim()) return c.displayTitle.trim();
  if (c.title?.trim()) return c.title.trim();
  if (c.type === 'direct') return 'Direct session';
  return 'Untitled session';
}

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return d.toLocaleString();
}

/** Build the body that will be posted into each selected target. */
function renderForwardedBody(source: MessageForwardSource): string {
  // Single-line attribution header followed by the original text as-is.
  // We used to prefix every line with `> ` to render as a markdown
  // blockquote — but the chat composer doesn't always parse content as
  // markdown, so the `>` characters leaked through as literal text.
  const header = `↗ Forwarded from ${source.senderName} · ${formatTimestamp(source.createdAt)}`;
  return `${header}\n\n${source.text}`;
}

export function MessageForwardDialog({
  open,
  isDark,
  source,
  conversations,
  onClose,
  notify,
}: MessageForwardDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state on open. Auto-focus the search input so keyboard-driven users
  // can filter immediately.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(new Set());
    setSending(false);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Eligible targets: active conversations the user can post to, excluding
  // the source. Pinned conversations first, then by most-recent activity —
  // matches LeftRail ordering so the picker feels familiar.
  const targets = useMemo(() => {
    const sourceId = source?.conversationId ?? null;
    const filtered = conversations.filter((c) => {
      if (c.id === sourceId) return false;
      if (c.status && c.status !== 'active') return false;
      // If the server tells us we can't send, hide the row up front so we
      // don't fail the POST later.
      if (c.viewerAccess && c.viewerAccess.canSendMessage === false) return false;
      return true;
    });
    const q = query.trim().toLowerCase();
    const matched = q
      ? filtered.filter((c) => {
          const label = conversationLabel(c).toLowerCase();
          return label.includes(q);
        })
      : filtered;
    return matched.sort((a, b) => {
      const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinDiff !== 0) return pinDiff;
      const aTime = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bTime = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return bTime - aTime;
    });
  }, [conversations, source?.conversationId, query]);

  if (!open || !source) return null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    if (!source || selected.size === 0 || sending) return;
    setSending(true);
    const body = renderForwardedBody(source);
    const targetIds = Array.from(selected);
    const results = await Promise.allSettled(
      targetIds.map((conversationId) =>
        sendMessage({
          conversationId,
          type: 'text',
          content: body,
          metadata: {
            forward: {
              sourceConversationId: source.conversationId,
              sourceMessageId: source.messageId,
            },
          },
        }),
      ),
    );
    setSending(false);
    const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length;
    const ok = targetIds.length - failed;
    if (failed === 0) {
      notify?.(`Forwarded to ${ok} ${ok === 1 ? 'chat' : 'chats'}.`, 'success');
    } else if (ok === 0) {
      notify?.(`Forward failed for all ${failed} targets.`, 'error');
    } else {
      notify?.(`Forwarded to ${ok}; failed for ${failed}.`, 'info');
    }
    onClose();
  }

  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';

  return (
    <div data-testid="message-forward-dialog" className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        onClick={onClose}
        className={`absolute inset-0 ${isDark ? 'bg-black/60' : 'bg-zinc-900/30'} backdrop-blur-[2px]`}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal
        aria-label="Forward message to another chat"
        className={`relative w-full max-w-md rounded-2xl border shadow-2xl ${
          isDark ? 'border-white/[0.08] bg-zinc-950/95 text-zinc-100' : 'border-zinc-200 bg-white/95 text-zinc-900'
        }`}
      >
        <header
          className={`flex items-center gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <Forward className={`h-4 w-4 ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
          <p className="text-sm font-bold">Forward to…</p>
          <button
            type="button"
            data-testid="forward-close"
            onClick={onClose}
            className={`ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-4 py-3">
          <label
            className={`flex h-9 items-center gap-2 rounded-xl border px-3 ${
              isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-white'
            }`}
          >
            <Search className={`h-4 w-4 opacity-60 ${muted}`} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              data-testid="forward-search"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
            />
          </label>

          <p className={`mt-3 text-[10px] font-bold uppercase tracking-wider ${muted}`}>Preview</p>
          <pre
            data-testid="forward-preview"
            className={`mt-1 max-h-24 overflow-y-auto rounded-xl border px-3 py-2 text-[11px] leading-relaxed [overflow-wrap:anywhere] ${
              isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
            }`}
          >
            {source.text}
          </pre>

          <div
            className={`mt-3 max-h-64 overflow-y-auto rounded-xl border ${
              isDark ? 'border-white/[0.06] bg-white/[0.01]' : 'border-zinc-200 bg-zinc-50/40'
            }`}
            data-testid="forward-target-list"
          >
            {targets.length === 0 ? (
              <p className={`px-3 py-4 text-center text-xs ${muted}`}>
                {query.trim() ? 'No chats match that search.' : 'No other chats available.'}
              </p>
            ) : (
              <ul className="divide-y divide-transparent">
                {targets.map((c) => {
                  const id = c.id;
                  const active = selected.has(id);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => toggle(id)}
                        data-testid={`forward-target-${id}`}
                        aria-pressed={active}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors',
                          active
                            ? isDark
                              ? 'bg-violet-500/15 text-violet-100'
                              : 'bg-violet-50 text-violet-900'
                            : isDark
                              ? 'hover:bg-white/[0.04]'
                              : 'hover:bg-zinc-100',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                            active
                              ? isDark
                                ? 'border-violet-300/40 bg-violet-400/20 text-violet-100'
                                : 'border-violet-300 bg-violet-100 text-violet-800'
                              : isDark
                                ? 'border-white/[0.10] bg-white/[0.02]'
                                : 'border-zinc-300 bg-white',
                          )}
                        >
                          <Check className={cn('h-3 w-3', active ? 'opacity-100' : 'opacity-0')} />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-semibold">{conversationLabel(c)}</span>
                        {c.pinned ? (
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                              isDark ? 'bg-white/[0.06] text-zinc-400' : 'bg-zinc-200 text-zinc-600'
                            }`}
                          >
                            Pinned
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <footer
          className={`flex items-center justify-between gap-2 border-t px-4 py-3 ${
            isDark ? 'border-white/[0.06]' : 'border-zinc-200'
          }`}
        >
          <p className={`text-[11px] ${muted}`}>
            {selected.size === 0
              ? 'Select one or more chats'
              : `${selected.size} ${selected.size === 1 ? 'chat' : 'chats'} selected`}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="forward-confirm"
              disabled={selected.size === 0 || sending}
              onClick={() => void handleConfirm()}
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Forward className="h-3.5 w-3.5" />}
              Forward
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
