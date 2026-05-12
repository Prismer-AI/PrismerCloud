'use client';

/**
 * SessionSettingsMenu — the ⋮ dropdown that lives in ImChannel header.
 *
 * Wave-8 W4: pulls the session-management actions out of the LeftRail row
 * hover overflow (which the W4 spec audit flagged as half-hidden / not
 * discoverable) and exposes them on the open conversation header instead.
 *
 * Items (group only unless noted):
 *   - Add member          (group only)
 *   - Rename
 *   - Mute / Unmute       (toggle, ✓ when muted)
 *   - Pin / Unpin         (toggle, ✓ when pinned)
 *   - Archive
 *   - Leave               (group, non-owner)
 *   - Delete              (owner only, destructive)
 *
 * Mute/pin are participant-level flags (per `IMParticipant.pinned/muted`),
 * never `IMConversation` columns. The component reads them from props so
 * the parent owns the source of truth (page.tsx conversations list, which
 * already enriches each row with `myRole / pinned / muted` from the list
 * endpoint — see `src/im/api/conversations.ts` GET / handler).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreVertical,
  UserPlus,
  Pencil,
  Bell,
  BellOff,
  Pin,
  PinOff,
  Archive,
  LogOut,
  Trash2,
  Check,
} from 'lucide-react';

export interface SessionSettingsMenuProps {
  isDark: boolean;
  isGroup: boolean;
  /** Caller's role on the participant row — drives Leave/Delete visibility. */
  myRole: string | undefined;
  pinned: boolean;
  muted: boolean;
  onAddMember: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onArchive: () => void;
  onLeave: () => void;
  onDelete: () => void;
}

export function SessionSettingsMenu({
  isDark,
  isGroup,
  myRole,
  pinned,
  muted,
  onAddMember,
  onRename,
  onTogglePin,
  onToggleMute,
  onArchive,
  onLeave,
  onDelete,
}: SessionSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Portal target only available client-side.
  useEffect(() => {
    setPortalReady(true);
  }, []);

  // Position the portaled dropdown beneath the toggle, anchored to its right
  // edge — matches the previous `right-0 top-full mt-1` look. Recompute on
  // open + on scroll/resize so it tracks the toggle while open.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const btn = wrapRef.current?.querySelector<HTMLButtonElement>('[data-testid="session-settings-toggle"]');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4, // mt-1 (~4px)
        right: window.innerWidth - rect.right,
      });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Close on outside click / Escape — single shared handler keeps the menu
  // light (no Radix dependency, since this is a small inline overlay).
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      const insideToggle = wrapRef.current?.contains(target);
      const insideMenu = menuRef.current?.contains(target);
      if (!insideToggle && !insideMenu) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isOwner = myRole === 'owner';

  function close<T extends () => void>(fn: T): () => void {
    return () => {
      setOpen(false);
      fn();
    };
  }

  const itemBase = `w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors`;
  const itemIdle = isDark ? 'text-zinc-200 hover:bg-white/5' : 'text-zinc-800 hover:bg-zinc-100';
  const itemDestructive = isDark ? 'text-red-300 hover:bg-red-500/10' : 'text-red-600 hover:bg-red-50';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="session-settings-toggle"
        title="Session settings"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`p-1 rounded-md ${
          open
            ? isDark
              ? 'bg-white/10 text-zinc-100'
              : 'bg-zinc-200 text-zinc-900'
            : isDark
              ? 'text-zinc-400 hover:bg-white/5'
              : 'text-zinc-600 hover:bg-zinc-100'
        }`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && portalReady && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              data-testid="session-settings-menu"
              style={{
                position: 'fixed',
                top: menuPos.top,
                right: menuPos.right,
                zIndex: 100,
              }}
              className={`w-56 rounded-md border shadow-lg overflow-hidden ${
                isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
              }`}
            >
              {isGroup ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-settings-add-member"
                  onClick={close(onAddMember)}
                  className={`${itemBase} ${itemIdle}`}
                >
                  <UserPlus className="w-3.5 h-3.5 opacity-70" />
                  Add member
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                data-testid="session-settings-rename"
                onClick={close(onRename)}
                className={`${itemBase} ${itemIdle}`}
              >
                <Pencil className="w-3.5 h-3.5 opacity-70" />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="session-settings-mute"
                onClick={close(onToggleMute)}
                className={`${itemBase} ${itemIdle}`}
              >
                {muted ? <BellOff className="w-3.5 h-3.5 opacity-70" /> : <Bell className="w-3.5 h-3.5 opacity-70" />}
                <span className="flex-1">{muted ? 'Unmute' : 'Mute'}</span>
                {muted ? <Check className="w-3.5 h-3.5 opacity-80" /> : null}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="session-settings-pin"
                onClick={close(onTogglePin)}
                className={`${itemBase} ${itemIdle}`}
              >
                {pinned ? <PinOff className="w-3.5 h-3.5 opacity-70" /> : <Pin className="w-3.5 h-3.5 opacity-70" />}
                <span className="flex-1">{pinned ? 'Unpin' : 'Pin'}</span>
                {pinned ? <Check className="w-3.5 h-3.5 opacity-80" /> : null}
              </button>
              <div className={`my-1 border-t ${isDark ? 'border-white/5' : 'border-zinc-100'}`} />
              <button
                type="button"
                role="menuitem"
                data-testid="session-settings-archive"
                onClick={close(onArchive)}
                className={`${itemBase} ${itemIdle}`}
              >
                <Archive className="w-3.5 h-3.5 opacity-70" />
                Archive
              </button>
              {isGroup && !isOwner ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-settings-leave"
                  onClick={close(onLeave)}
                  className={`${itemBase} ${itemIdle}`}
                >
                  <LogOut className="w-3.5 h-3.5 opacity-70" />
                  Leave
                </button>
              ) : null}
              {isOwner ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-settings-delete"
                  onClick={close(onDelete)}
                  className={`${itemBase} ${itemDestructive}`}
                >
                  <Trash2 className="w-3.5 h-3.5 opacity-70" />
                  Delete
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
