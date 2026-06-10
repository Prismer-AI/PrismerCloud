'use client';

/**
 * Skill Creator — left Steering pane (release201/28 §3.2).
 *
 * Conversational steering: agent (left) / user (right) bubbles mirroring
 * `im-channel.tsx`, a three-dot typing indicator, quick-reply chips, a 4-kind
 * source bench (Inline / Doc URL / Code / Service) and an auto-growing composer
 * (Enter sends, Shift+Enter newlines). Spatial grammar = workshop (steering
 * variant); the source-bench keeps the amber accent.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { AlignLeft, Code2, FileText, Globe, MessageSquare, Send, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springSnap,
  springSoft,
} from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import type { CreatorSourceKind } from '../types';

export interface SteeringMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  quickReplies?: { label: string; action: string }[];
}

export interface SteeringPaneProps {
  /** Authoring actor identity (workspace orchestrator or selected agent). */
  agentHandle: string;
  agentType: string;
  messages: SteeringMessage[];
  typing: boolean;
  /** Composer is disabled while the agent owns a turn (building / evaluating). */
  busy: boolean;
  onSend: (text: string) => void;
  onSource: (kind: CreatorSourceKind) => void;
  onQuickReply: (action: string) => void;
}

const SOURCE_ORDER: { kind: CreatorSourceKind; icon: typeof AlignLeft }[] = [
  { kind: 'inline', icon: AlignLeft },
  { kind: 'doc', icon: FileText },
  { kind: 'code', icon: Code2 },
  { kind: 'service', icon: Globe },
];

export function SteeringPane({
  agentHandle,
  agentType,
  messages,
  typing,
  busy,
  onSend,
  onSource,
  onQuickReply,
}: SteeringPaneProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const a = grammarAccentClasses.violet;

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  const autoGrow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const submit = () => {
    const el = inputRef.current;
    if (!el) return;
    const value = el.value.trim();
    if (!value) return;
    el.value = '';
    el.style.height = 'auto';
    onSend(value);
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden border', radius.pane, s(theme, 'pane'))}>
      {/* head — Steering title + authoring agent identity */}
      <div className="flex shrink-0 items-start gap-3 border-b border-current/[0.06] px-4 py-3.5">
        <div className={cn('flex size-9 flex-none items-center justify-center border', radius.small, a.bg)}>
          <MessageSquare className={cn('size-4', a.text)} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('text-sm font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
              {t('evolution.studio.v2.creator.steeringTitle')}
            </span>
            <span
              className={cn(
                'inline-flex min-w-0 items-center gap-1 truncate border px-2 py-0.5 text-[11px] font-medium',
                radius.chip,
                a.bg,
                a.text,
              )}
            >
              <Sparkles className="size-3 flex-none" aria-hidden />
              <span className="truncate">{agentHandle}</span>
            </span>
          </div>
          <div className={cn('mt-0.5 truncate text-xs leading-snug', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {agentType} · {t('evolution.studio.v2.creator.steeringHint')}
          </div>
        </div>
      </div>

      {/* thread */}
      <div ref={threadRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <Bubble key={m.id} message={m} reduce={!!reduce} onQuickReply={onQuickReply} />
        ))}
        {typing ? <Typing reduce={!!reduce} /> : null}
      </div>

      {/* composer + source bench — pinned at the pane bottom, always visible */}
      <div className={cn('shrink-0 border-t border-current/[0.06] px-3 pb-3 pt-2.5', s(theme, 'inset'))}>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SOURCE_ORDER.map(({ kind, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              onClick={() => onSource(kind)}
              className={cn(
                'inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium transition-colors',
                radius.button,
                a.bg,
                a.text,
                isDark ? 'hover:bg-amber-500/20' : 'hover:bg-amber-500/15',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(`evolution.studio.v2.creator.sources.${kind}` as `evolution.${string}`)}
            </button>
          ))}
        </div>
        <div
          className={cn(
            'flex items-end gap-2 border px-2.5 py-1.5',
            radius.card,
            s(theme, 'inset'),
            'focus-within:ring-1',
            a.ring,
          )}
        >
          <textarea
            ref={inputRef}
            rows={1}
            disabled={busy}
            onInput={autoGrow}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t('evolution.studio.v2.creator.composerPlaceholder')}
            className={cn(
              'max-h-[120px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-sm outline-none',
              'placeholder:text-zinc-500',
              isDark ? 'text-zinc-100' : 'text-zinc-900',
              busy && 'opacity-50',
            )}
          />
          <motion.button
            type="button"
            onClick={submit}
            disabled={busy}
            whileTap={reduce ? undefined : { scale: 0.92 }}
            transition={springSnap}
            className={cn(
              'flex size-8 flex-none items-center justify-center text-white shadow-lg',
              radius.button,
              'bg-[var(--prismer-primary)] disabled:opacity-40',
            )}
            aria-label={t('evolution.studio.v2.createSkill')}
          >
            <Send className="size-4" aria-hidden />
          </motion.button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  message,
  reduce,
  onQuickReply,
}: {
  message: SteeringMessage;
  reduce: boolean;
  onQuickReply: (action: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  const a = grammarAccentClasses.violet;
  const isAgent = message.role === 'agent';

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={springSoft}
      className={cn('flex w-full', isAgent ? 'justify-start' : 'justify-end')}
    >
      <div className={cn('flex max-w-[88%] flex-col gap-1.5', isAgent ? 'items-start' : 'items-end')}>
        <div
          className={cn(
            'whitespace-pre-wrap break-words border px-3 py-2 text-sm leading-relaxed',
            radius.card,
            isAgent
              ? cn(s(theme, 'card'), isDark ? 'text-zinc-200' : 'text-zinc-800')
              : cn('border-transparent text-white', 'bg-[var(--prismer-primary)]'),
          )}
        >
          {message.text}
        </div>
        {message.quickReplies?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {message.quickReplies.map((q, i) => (
              <motion.button
                key={q.action}
                type="button"
                onClick={() => onQuickReply(q.action)}
                initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ ...springSnap, delay: reduce ? 0 : i * 0.05 }}
                className={cn(
                  'border px-2.5 py-1 text-xs font-medium transition-colors',
                  radius.chip,
                  i === 0 ? cn(a.bg, a.text) : cn(s(theme, 'inset'), isDark ? 'text-zinc-300' : 'text-zinc-700'),
                )}
              >
                {q.label}
              </motion.button>
            ))}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function Typing({ reduce }: { reduce: boolean }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';
  return (
    <div className="flex justify-start">
      <div className={cn('flex items-center gap-1 border px-3.5 py-3', radius.card, s(theme, 'card'))}>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className={cn('size-1.5 rounded-full', isDark ? 'bg-zinc-400' : 'bg-zinc-500')}
            animate={reduce ? undefined : { y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
            transition={reduce ? undefined : { duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
            aria-hidden
          />
        ))}
      </div>
    </div>
  );
}
