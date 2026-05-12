'use client';

/**
 * Inline @mention autocomplete for the message composer.
 *
 * The cookbook's mention parser scans for `@<username>` (cookbook 1 §5,
 * cookbook 3 §3) — display names are NOT what gets resolved. The picker
 * therefore filters by username + displayName but always inserts `@<username>`
 * into the textarea, matching `MentionService.determineRouting`.
 *
 * Keyboard navigation lives in the parent's textarea onKeyDown — it gets
 * a ref to this component and calls `move(±1)` / `commit()` for ↑/↓/⏎/Tab.
 * That way the textarea keeps focus (so the caret stays visible) and we
 * don't need a window-level keydown handler that fights with the editor.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot } from 'lucide-react';
import type { GroupMember } from '../lib/mutations';
import { avatarGradient, avatarInitials, radius, springSnap, springSoft, surface } from '../lib/design';

interface MentionPickerProps {
  isDark: boolean;
  members: GroupMember[];
  /** Current filter token AFTER the leading '@'. Empty string = show all. */
  filter: string;
  onSelect: (member: GroupMember) => void;
  onClose: () => void;
}

export interface MentionPickerHandle {
  /** Move the highlighted row. Wraps around top/bottom. */
  move: (delta: number) => void;
  /** Commit the highlighted row. Returns false if there's nothing to commit. */
  commit: () => boolean;
}

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(function MentionPicker(
  { isDark, members, filter, onSelect, onClose },
  ref,
) {
  // Quick-and-dirty fuzzy: match if the filter is a substring of either the
  // username or the displayName, case-insensitive. Cookbook §3 also supports
  // `@"quoted display name"` but mobile picker UX is "type a fragment of the
  // username" — we follow the same pattern.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return members.slice(0, 8);
    return members
      .filter((m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
      .slice(0, 8);
  }, [members, filter]);

  const [active, setActive] = useState(0);
  // Reset highlight to the top whenever the filter changes — typing a new
  // letter resets the prefix match so the first row is the most relevant.
  useEffect(() => {
    setActive(0);
  }, [filter]);
  // Clamp when the list shrinks past the current index (e.g. typed an extra
  // letter that filtered out the previously-active row).
  useEffect(() => {
    setActive((prev) => (prev >= filtered.length ? Math.max(0, filtered.length - 1) : prev));
  }, [filtered.length]);

  // Stable refs for the imperative handle so the parent's ref identity
  // doesn't churn on every active/filter change.
  const filteredRef = useRef(filtered);
  const activeRef = useRef(active);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    filteredRef.current = filtered;
  }, [filtered]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useImperativeHandle(
    ref,
    () => ({
      move: (delta) => {
        setActive((curr) => {
          const len = filteredRef.current.length;
          if (len === 0) return 0;
          return (curr + delta + len) % len;
        });
      },
      commit: () => {
        const list = filteredRef.current;
        const m = list[activeRef.current];
        if (!m) return false;
        onSelectRef.current(m);
        return true;
      },
    }),
    [],
  );

  // Close on Escape (the composer keeps focus, so we listen at window level).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Scoped scroll: keep the highlighted row inside the picker's overflow
  // window without scrolling outer ancestors (scrollIntoView would also
  // shift the entire workspace when the composer sits near the viewport
  // edge).
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const container = listRef.current;
    const el = itemRefs.current[active];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    if (eRect.top < cRect.top) {
      container.scrollTop += eRect.top - cRect.top;
    } else if (eRect.bottom > cRect.bottom) {
      container.scrollTop += eRect.bottom - cRect.bottom;
    }
  }, [active]);

  if (filtered.length === 0) return null;

  return (
    <motion.div
      ref={listRef}
      data-testid="mention-picker"
      role="listbox"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={springSoft}
      style={{ transformOrigin: 'bottom left' }}
      className={`absolute bottom-full left-2 mb-2 w-72 max-h-60 overflow-y-auto overflow-x-hidden border p-1.5 ${
        surface.modal[isDark ? 'dark' : 'light']
      } ${radius.card}`}
    >
      <div
        className={`flex items-center justify-between px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
          isDark ? 'text-zinc-500' : 'text-zinc-400'
        }`}
      >
        <span>Mention</span>
        <span className={`font-mono normal-case tracking-normal ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          ↑↓ ⏎
        </span>
      </div>
      {filtered.map((m, idx) => {
        // We don't have role-typed (human/agent) on member rows reliably, so
        // fall back to "Bot icon if username has the agent suffix"; otherwise
        // initials. Cookbook §3 doesn't ship role-on-participant in the wire
        // shape, so this is an aesthetic guess only.
        const looksAgent = /agent|bot|claude|hermes|openclaw|codex/i.test(m.username);
        const grad = avatarGradient(m.userId || m.username);
        const isActive = idx === active;
        return (
          <motion.button
            key={m.userId}
            ref={(node) => {
              itemRefs.current[idx] = node;
            }}
            type="button"
            role="option"
            aria-selected={isActive}
            data-testid={`mention-option-${m.username}`}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before we insert.
              e.preventDefault();
              onSelect(m);
            }}
            onMouseEnter={() => setActive(idx)}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springSoft, delay: 0.02 * idx }}
            whileTap={{ scale: 0.97 }}
            className={`group relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
              isActive
                ? isDark
                  ? 'bg-white/[0.07] text-zinc-100'
                  : 'bg-zinc-900/[0.05] text-zinc-900'
                : isDark
                  ? 'text-zinc-200 hover:bg-white/[0.04]'
                  : 'text-zinc-800 hover:bg-zinc-900/[0.03]'
            }`}
          >
            {isActive ? (
              <motion.span
                layoutId="mention-active-rail"
                transition={springSnap}
                className={`absolute inset-y-1 left-0 w-[2px] rounded-full ${
                  isDark ? 'bg-violet-400/70' : 'bg-violet-500/80'
                }`}
              />
            ) : null}
            <span
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-[10px] font-bold text-white shadow-sm"
              style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
              aria-hidden="true"
            >
              {looksAgent ? <Bot className="h-3.5 w-3.5" /> : avatarInitials(m.displayName || m.username)}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-mono text-[12px] ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                @{m.username}
              </span>
              <span className={`block truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {m.displayName}
              </span>
            </span>
            <span
              className={`shrink-0 text-[10px] font-medium transition-opacity ${
                isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-50'
              } ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
            >
              ⏎
            </span>
          </motion.button>
        );
      })}
    </motion.div>
  );
});
