'use client';

/**
 * ContactPicker — release201/16 Phase 10 (v2.0.8).
 *
 * Combobox-style picker whose source is `workspace members ∩ self contacts`,
 * fetched via `GET /workspaces/:id/members` and `GET /contacts/friends` and
 * intersected client-side (16 §0.2.1 + §3.1.2 + §0.2.4):
 *
 *   - never exposes the email of a workspace member who is not a contact
 *   - excludes the caller themselves
 *   - filters out anyone already a project member (the parent passes the set
 *     of existing principalIds)
 *
 * Visual: a search input over the merged list; rows show display name (from
 * contact data when available) + a faint imUserId beneath. No emails.
 *
 * This component is intentionally generic — both the project member dialog
 * and the Chats People tab "Add to project" affordance use the same picker.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, UserRound } from 'lucide-react';
import { imFetch } from '../lib/im-api';

interface MemberRow {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

interface FriendRow {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAgent: boolean;
  remark: string | null;
}

export interface ContactPickerOption {
  imUserId: string;
  displayName: string;
  avatarUrl: string | null;
  /** True when the user is in caller's contacts — affects which fields the UI
      may safely render (e.g. remark). False = workspace member only. */
  isContact: boolean;
}

export function ContactPicker({
  workspaceId,
  excludePrincipalIds = [],
  excludeSelfId,
  onSelect,
  isDark,
  placeholder = 'Search workspace members…',
}: {
  workspaceId: string;
  excludePrincipalIds?: string[];
  excludeSelfId?: string | null;
  onSelect: (opt: ContactPickerOption) => void;
  isDark: boolean;
  placeholder?: string;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const [mRes, fRes] = await Promise.all([
        imFetch<MemberRow[]>(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
        imFetch<FriendRow[]>(`/contacts/friends`),
      ]);
      if (cancelled) return;
      if (!mRes.ok) {
        setError(mRes.message);
        setLoading(false);
        return;
      }
      setMembers(mRes.data ?? []);
      if (fRes.ok) setFriends(fRes.data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const options = useMemo<ContactPickerOption[]>(() => {
    const friendsByUser = new Map(friends.map((f) => [f.userId, f]));
    const exclude = new Set(excludePrincipalIds);
    if (excludeSelfId) exclude.add(excludeSelfId);

    return (
      members
        .filter((m) => !exclude.has(m.memberImUserId))
        // 16 §3.1 — owner is treated like any other workspace member from a
        // discovery POV; the project may still grant them a non-owner project role.
        .map((m) => {
          const f = friendsByUser.get(m.memberImUserId);
          return {
            imUserId: m.memberImUserId,
            displayName: f?.displayName ?? m.memberImUserId,
            avatarUrl: f?.avatarUrl ?? null,
            isContact: !!f,
          };
        })
    );
  }, [members, friends, excludePrincipalIds, excludeSelfId]);

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.displayName.toLowerCase().includes(q) || o.imUserId.toLowerCase().includes(q));
  }, [options, query]);

  const inputClass = isDark
    ? 'bg-zinc-950 border-zinc-800 text-zinc-100 placeholder-zinc-500'
    : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400';
  const rowHover = isDark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-500';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className={`w-full rounded border ${inputClass} pl-8 pr-3 py-1.5 text-sm`}
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded border border-transparent">
        {loading && (
          <div className={`flex items-center gap-2 px-2 py-2 text-xs ${textMuted}`}>
            <Loader2 className="h-3 w-3 animate-spin" /> Loading members…
          </div>
        )}
        {error && <div className="px-2 py-2 text-xs text-red-500">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className={`px-2 py-2 text-xs ${textMuted}`}>
            {options.length === 0 ? 'No eligible workspace members to add. Invite someone first.' : 'No matches.'}
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <ul className="space-y-0.5">
            {filtered.map((opt) => (
              <li key={opt.imUserId}>
                <button
                  type="button"
                  onClick={() => onSelect(opt)}
                  className={`w-full text-left rounded px-2 py-1.5 ${rowHover} flex items-center gap-2`}
                >
                  <Avatar src={opt.avatarUrl} initial={(opt.displayName || '?').charAt(0).toUpperCase()} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium ${textPrimary} truncate`}>{opt.displayName}</div>
                    <div className={`text-[10px] font-mono ${textMuted} truncate`}>{opt.imUserId}</div>
                  </div>
                  {opt.isContact && (
                    <span
                      className={`text-[9px] uppercase tracking-wide ${
                        isDark ? 'text-emerald-300' : 'text-emerald-600'
                      }`}
                    >
                      contact
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Avatar({ src, initial }: { src: string | null; initial: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-6 w-6 rounded-full object-cover" />;
  }
  return (
    <div className="h-6 w-6 rounded-full flex items-center justify-center bg-zinc-200 text-zinc-700 text-[10px]">
      {initial || <UserRound className="h-3 w-3" />}
    </div>
  );
}
