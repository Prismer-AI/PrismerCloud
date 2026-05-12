'use client';

/**
 * §30 B3.5 — Add-by-username block for ProTileConversation.
 *
 * Input + lookup button + W8 C5 contact-status chip + manual-members
 * list. Extracted so ProTileConversation stays under its 250-line
 * budget. Behaviour mirrors NewChannelDialog lines 360-455 verbatim,
 * minus the parent-controlled state which threads through props.
 */

import { Loader2 } from 'lucide-react';

import { radius } from '../../../lib/design';
import { MemberListRow, type MemberRow } from './MemberListRow';

// ───────────────────────── ConversationModeTabs ─────────────────────────

export type ConversationMode = 'direct' | 'group';

export function ConversationModeTabs({
  isDark,
  mode,
  onChange,
}: {
  isDark: boolean;
  mode: ConversationMode;
  onChange: (next: ConversationMode) => void;
}) {
  return (
    <div className="flex items-center gap-2" role="tablist" aria-label="Conversation type">
      {(['direct', 'group'] as ConversationMode[]).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`pro-tile-conversation-mode-${m}`}
            onClick={() => onChange(m)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${radius.button} ${
              active
                ? isDark
                  ? 'bg-violet-500/20 text-violet-200'
                  : 'bg-violet-100 text-violet-800'
                : isDark
                  ? 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
            }`}
          >
            {m === 'direct' ? '1:1 chat' : 'Group'}
          </button>
        );
      })}
    </div>
  );
}

export type ContactStatus =
  | 'self'
  | 'friend'
  | 'pending_sent'
  | 'pending_received'
  | 'blocked_by_me'
  | 'blocked_by_them'
  | 'stranger';

export interface ContactStatusInfo {
  status: ContactStatus;
  user: { id: string; username: string; displayName: string; role: string };
}

export function statusLabel(status: ContactStatus): { label: string; tone: 'ok' | 'info' | 'warn' | 'block' } {
  switch (status) {
    case 'self':
      return { label: "That's you", tone: 'info' };
    case 'friend':
      return { label: 'Already friend', tone: 'ok' };
    case 'pending_sent':
      return { label: 'Pending request', tone: 'info' };
    case 'pending_received':
      return { label: 'They sent you a request', tone: 'info' };
    case 'blocked_by_me':
      return { label: 'You blocked them', tone: 'warn' };
    case 'blocked_by_them':
      return { label: 'They blocked you', tone: 'block' };
    case 'stranger':
    default:
      return { label: 'Stranger — request sent on add', tone: 'info' };
  }
}

function chipToneClass(tone: 'ok' | 'info' | 'warn' | 'block', isDark: boolean): string {
  if (tone === 'block') return isDark ? 'bg-red-500/15 text-red-300' : 'bg-red-100 text-red-700';
  if (tone === 'warn') return isDark ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-700';
  if (tone === 'ok') return isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700';
  return isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-700';
}

export interface GroupAddByUsernameProps {
  isDark: boolean;
  labelClass: string;
  inputClass: string;
  usernameInput: string;
  setUsernameInput: (next: string) => void;
  lookupBusy: boolean;
  statusInfo: ContactStatusInfo | null;
  onSubmit: () => void;
  manuallyAddedMembers: MemberRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}

export function GroupAddByUsername({
  isDark,
  labelClass,
  inputClass,
  usernameInput,
  setUsernameInput,
  lookupBusy,
  statusInfo,
  onSubmit,
  manuallyAddedMembers,
  selectedIds,
  onToggle,
}: GroupAddByUsernameProps) {
  const blocked = statusInfo?.status === 'blocked_by_them';
  return (
    <div className="grid gap-1">
      <span className={labelClass}>Add by username</span>
      <div className="flex items-center gap-2">
        <input
          data-testid="pro-tile-conversation-username-input"
          className={inputClass}
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="alice"
          maxLength={64}
        />
        <button
          type="button"
          data-testid="pro-tile-conversation-username-add"
          onClick={onSubmit}
          disabled={!usernameInput.trim() || lookupBusy || blocked}
          className={`inline-flex items-center px-3 py-1 text-xs font-medium ${radius.button} ${
            isDark
              ? 'border border-white/10 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
              : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {lookupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '+'}
        </button>
      </div>
      {statusInfo ? (
        <p
          data-testid={`pro-tile-conversation-username-status-${statusInfo.status}`}
          className={`mt-1 inline-flex items-center self-start px-2 py-0.5 text-[10px] font-medium ${radius.chip} ${chipToneClass(statusLabel(statusInfo.status).tone, isDark)}`}
        >
          {statusLabel(statusInfo.status).label}
          {statusInfo.user.username ? ` · @${statusInfo.user.username}` : null}
        </p>
      ) : null}
      {manuallyAddedMembers.length > 0 ? (
        <div
          className={`mt-1 max-h-32 overflow-y-auto border ${radius.button} ${
            isDark ? 'border-white/10 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          <ul className="py-1">
            {manuallyAddedMembers.map((m) => (
              <MemberListRow
                key={m.id}
                isDark={isDark}
                row={m}
                checked={selectedIds.has(m.id)}
                selectType="checkbox"
                onToggle={() => onToggle(m.id)}
                testIdPrefix="pro-tile-conversation-manual-member"
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
