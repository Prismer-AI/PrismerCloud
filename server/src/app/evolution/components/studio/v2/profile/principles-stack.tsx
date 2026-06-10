'use client';

/**
 * Profile — operating-principles card stack (release201/28 §4 / doc 13 §3.5.1).
 *
 * Each operating principle is a draggable card (Reorder.Group, springDrag) with
 * double-click inline edit. Local-only edits in mock mode (the live PATCH wiring
 * lands with the profile endpoint); reorder/edit mutate a parent-owned array.
 *
 * No bare strings — labels come from i18n via the caller; this component is
 * structural and renders the principle text the parent passes in.
 */

import { useEffect, useRef, useState } from 'react';
import { Reorder, useDragControls, useReducedMotion } from 'framer-motion';
import { GripVertical } from 'lucide-react';

import { grammarAccentClasses, radius, s, springDrag } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

const ACCENT = grammarAccentClasses.rose;

interface PrinciplesStackProps {
  isDark: boolean;
  theme: 'dark' | 'light';
  principles: string[];
  onReorder: (next: string[]) => void;
  onEdit: (index: number, value: string) => void;
}

export function PrinciplesStack({ isDark, theme, principles, onReorder, onEdit }: PrinciplesStackProps) {
  const reduce = useReducedMotion();

  return (
    <Reorder.Group
      axis="y"
      values={principles}
      onReorder={onReorder}
      className="flex flex-col gap-2.5"
      as="ul"
    >
      {principles.map((principle, index) => (
        <PrincipleCard
          key={principle + index}
          value={principle}
          index={index}
          isDark={isDark}
          theme={theme}
          reduce={!!reduce}
          onEdit={onEdit}
        />
      ))}
    </Reorder.Group>
  );
}

interface PrincipleCardProps {
  value: string;
  index: number;
  isDark: boolean;
  theme: 'dark' | 'light';
  reduce: boolean;
  onEdit: (index: number, value: string) => void;
}

function PrincipleCard({ value, index, isDark, theme, reduce, onEdit }: PrincipleCardProps) {
  const { t } = useI18n();
  const controls = useDragControls();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onEdit(index, trimmed);
    else setDraft(value);
    setEditing(false);
  };

  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={controls}
      transition={reduce ? { duration: 0 } : springDrag}
      whileDrag={reduce ? undefined : { scale: 1.02 }}
      className={cn(
        'group flex items-start gap-2 border px-3 py-2.5',
        radius.card,
        s(theme, 'card'),
      )}
      as="li"
    >
      <button
        type="button"
        onPointerDown={(e) => controls.start(e)}
        className={cn(
          'mt-0.5 cursor-grab touch-none rounded-md p-0.5 opacity-40 transition-opacity group-hover:opacity-100 active:cursor-grabbing',
          isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800',
        )}
        aria-label={t('evolution.studio.v2.profiles.reorderPrinciple', { n: index + 1 })}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>

      <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', ACCENT.dot)} aria-hidden />

      {editing ? (
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setDraft(value);
              setEditing(false);
            }
          }}
          className={cn(
            'flex-1 resize-none bg-transparent text-sm leading-snug outline-none',
            isDark ? 'text-zinc-100' : 'text-zinc-900',
          )}
        />
      ) : (
        <p
          onDoubleClick={() => setEditing(true)}
          className={cn('flex-1 cursor-text text-sm leading-snug', isDark ? 'text-zinc-200' : 'text-zinc-800')}
          title={t('evolution.studio.v2.profiles.editPrincipleHint')}
        >
          {value}
        </p>
      )}
    </Reorder.Item>
  );
}
