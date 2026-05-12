'use client';

/**
 * MobileSessionsList — full-width list of sessions for the mobile Sessions
 * surface. Equivalent to LeftRail's "Channels" section without the device
 * tree underneath; the device tree is exposed on the Runtime tile instead.
 *
 * Wave-8 W4 audit S4: phone users currently see no nav and no session list
 * at all (LeftRail is `hidden lg:flex`). This component fills that gap and
 * doubles as the back-target when a session is opened full-screen.
 */

import { Hash, Plus, Pin, BellOff, Inbox } from 'lucide-react';
import type { ConversationDTO } from '../lib/types';

interface MobileSessionsListProps {
  isDark: boolean;
  conversations: ConversationDTO[];
  onSelect: (id: string) => void;
  onNewChannel?: () => void;
}

function conversationLabel(conv: ConversationDTO): string {
  if (conv.title?.trim()) return conv.title.trim();
  if (conv.type === 'direct') return 'Direct chat';
  return 'Untitled channel';
}

export function MobileSessionsList({ isDark, conversations, onSelect, onNewChannel }: MobileSessionsListProps) {
  return (
    <div
      data-testid="mobile-sessions-list"
      className={`flex-1 overflow-y-auto ${isDark ? 'bg-zinc-950/30' : 'bg-zinc-50/60'}`}
    >
      <div
        className={`flex items-center justify-between px-4 py-3 border-b ${
          isDark ? 'border-white/5' : 'border-zinc-200'
        }`}
      >
        <p className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          Sessions
        </p>
        {onNewChannel ? (
          <button
            type="button"
            onClick={onNewChannel}
            data-testid="mobile-sessions-new"
            className={`p-1 rounded ${
              isDark
                ? 'text-zinc-400 hover:text-violet-300 hover:bg-white/5'
                : 'text-zinc-500 hover:text-violet-700 hover:bg-zinc-200/60'
            }`}
            title="New channel"
          >
            <Plus className="w-4 h-4" />
          </button>
        ) : null}
      </div>
      {conversations.length === 0 ? (
        <div
          className={`px-6 py-12 flex flex-col items-center text-center ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          <Inbox className="w-8 h-8 mb-2 opacity-40" />
          <p className="text-sm">No sessions yet.</p>
          <p className="text-xs mt-1 max-w-xs">
            Tap <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>+</span> to start one with an agent or
            human.
          </p>
        </div>
      ) : (
        <ul>
          {conversations.map((conv) => (
            <li key={conv.id}>
              <button
                type="button"
                onClick={() => onSelect(conv.id)}
                data-testid={`mobile-session-${conv.id}`}
                className={`w-full flex items-center gap-2 px-4 py-3 border-b text-sm text-left ${
                  isDark
                    ? 'border-white/5 text-zinc-200 hover:bg-white/5'
                    : 'border-zinc-100 text-zinc-800 hover:bg-zinc-100/60'
                }`}
              >
                {conv.pinned ? (
                  <Pin className="w-3.5 h-3.5 shrink-0 opacity-60" />
                ) : (
                  <Hash className="w-3.5 h-3.5 shrink-0 opacity-60" />
                )}
                <span className={`flex-1 truncate ${conv.muted ? 'opacity-60' : ''}`}>{conversationLabel(conv)}</span>
                {conv.muted ? <BellOff className="w-3 h-3 shrink-0 opacity-50" /> : null}
                {conv.unreadCount && conv.unreadCount > 0 ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300">
                    {conv.unreadCount}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
