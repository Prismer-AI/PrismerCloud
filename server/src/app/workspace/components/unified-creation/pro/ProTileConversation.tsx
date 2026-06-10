'use client';

/**
 * §30 B3.5 — Pro mode Conversation sub-panel.
 *
 * Copy of NewChannelDialog's form body (direct + group modes, member
 * list, add-by-username with status chip) with chrome rewritten to
 * design.ts tokens. Existing dialog left untouched per B0 audit rule.
 * Direct mode is single-select; group mode preserves the W8 C5 contact-
 * status chip via ./GroupAddByUsername.tsx (helper extracted to stay
 * under the 250-line budget).
 */

import { useEffect, useId, useMemo, useState } from 'react';

import { radius, s } from '../../../lib/design';
import { createDirectConversation, createGroupConversation } from '../../../lib/mutations';
import { imFetch } from '../../../lib/im-api';
import type { AgentDTO } from '../../../lib/types';
import type { UnifiedCreationEvent } from '../context';
import { ConversationModeTabs, GroupAddByUsername } from './GroupAddByUsername';
import type { ContactStatusInfo, ConversationMode } from './GroupAddByUsername';
import { MemberListRow, type MemberRow } from './MemberListRow';
import { inputClass as makeInput, labelClass as makeLabel, PanelFooter, PanelHeader } from './parts';

export interface ProTileConversationProps {
  isDark: boolean;
  workspaceId: string;
  agents: AgentDTO[];
  defaultConversationId?: string;
  onSuccess: (event: UnifiedCreationEvent) => void;
  onBack: () => void;
}

export function ProTileConversation({
  isDark,
  workspaceId,
  agents,
  defaultConversationId,
  onSuccess,
  onBack,
}: ProTileConversationProps) {
  const theme = isDark ? 'dark' : 'light';

  const [mode, setMode] = useState<ConversationMode>('direct');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manuallyAddedMembers, setManuallyAddedMembers] = useState<MemberRow[]>([]);
  const [usernameInput, setUsernameInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [statusInfo, setStatusInfo] = useState<ContactStatusInfo | null>(null);

  useEffect(() => setStatusInfo(null), [usernameInput]);

  const titleId = useId();

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (mode === 'direct') return selected.size === 1;
    return title.trim().length > 0 && selected.size >= 1;
  }, [submitting, mode, selected, title]);

  function toggleMember(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else {
        if (mode === 'direct') next.clear();
        next.add(userId);
      }
      return next;
    });
  }

  async function handleAddByUsername() {
    const typed = usernameInput.trim();
    if (!typed || lookupBusy) return;
    setLookupBusy(true);
    setError(null);
    const cleaned = typed.replace(/^@/, '');
    const res = await imFetch<ContactStatusInfo>(`/contacts/status?username=${encodeURIComponent(cleaned)}`);
    setLookupBusy(false);
    if (!res.ok) {
      setError(res.status === 404 ? `User "${typed}" not found.` : res.message);
      return;
    }
    setStatusInfo(res.data);
    if (res.data.status === 'blocked_by_them') {
      setError(`Cannot add ${res.data.user.displayName}: they have blocked you.`);
      return;
    }
    if (res.data.status === 'self') {
      setError("You can't add yourself.");
      return;
    }
    const u = res.data.user;
    if (manuallyAddedMembers.some((m) => m.id === u.id) || selected.has(u.id)) {
      setUsernameInput('');
      return;
    }
    const isAgent = u.role === 'agent';
    setManuallyAddedMembers((prev) => [
      ...prev,
      { id: u.id, name: u.displayName, isAgent, typeTag: isAgent ? 'agent' : 'human' },
    ]);
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(u.id);
      return next;
    });
    setUsernameInput('');
    setStatusInfo(null);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const memberIds = Array.from(selected);
    if (mode === 'direct') {
      const res = await createDirectConversation(memberIds[0]!, workspaceId);
      setSubmitting(false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      onSuccess({ kind: 'conversation', id: res.data.id });
      return;
    }
    const res = await createGroupConversation({ title: title.trim(), members: memberIds });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess({ kind: 'conversation', id: res.data.groupId });
  }

  const inputClass = makeInput(isDark);
  const labelClass = makeLabel(isDark);

  return (
    <div data-testid="pro-tile-conversation" className="grid gap-3">
      <PanelHeader
        isDark={isDark}
        title="New conversation"
        subtitle={
          <>
            Open a 1:1 or group session; you&apos;ll be added as owner.
            {defaultConversationId ? (
              <span className="ml-2 font-mono text-[10px] opacity-60">ctx: {defaultConversationId.slice(0, 8)}…</span>
            ) : null}
          </>
        }
      />

      <section className={`grid gap-2.5 border p-3 ${radius.card} ${s(theme, 'card')}`}>
        <ConversationModeTabs
          isDark={isDark}
          mode={mode}
          onChange={(m) => {
            setMode(m);
            if (m === 'direct' && selected.size > 1) setSelected(new Set([...selected].slice(0, 1)));
          }}
        />

        {mode === 'group' ? (
          <label className="grid gap-1" htmlFor={titleId}>
            <span className={labelClass}>Group title</span>
            <input
              id={titleId}
              data-testid="pro-tile-conversation-title"
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sprint planning"
              maxLength={120}
            />
          </label>
        ) : null}

        <div className="grid gap-1">
          <span className={labelClass}>{mode === 'direct' ? 'Counterparty' : 'Members'}</span>
          <div
            className={`max-h-44 overflow-y-auto border ${radius.button} ${
              isDark ? 'border-white/10 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-50'
            }`}
          >
            {agents.length === 0 ? (
              <p className={`px-3 py-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                No agents in this workspace yet — create one via the Agent tile.
              </p>
            ) : (
              <ul className="py-1">
                {agents.map((a) => (
                  <MemberListRow
                    key={a.userId}
                    isDark={isDark}
                    row={{ id: a.userId, name: a.name, isAgent: !!a.agentType, typeTag: a.agentType ?? undefined }}
                    checked={selected.has(a.userId)}
                    selectType={mode === 'direct' ? 'radio' : 'checkbox'}
                    inputName="pro-tile-conversation-member"
                    onToggle={() => toggleMember(a.userId)}
                    testIdPrefix="pro-tile-conversation-member"
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {mode === 'group' ? (
          <GroupAddByUsername
            isDark={isDark}
            inputClass={inputClass}
            labelClass={labelClass}
            usernameInput={usernameInput}
            setUsernameInput={setUsernameInput}
            lookupBusy={lookupBusy}
            statusInfo={statusInfo}
            onSubmit={() => void handleAddByUsername()}
            manuallyAddedMembers={manuallyAddedMembers}
            selectedIds={selected}
            onToggle={toggleMember}
          />
        ) : null}

        {error ? (
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <PanelFooter
        isDark={isDark}
        submitting={submitting}
        canSubmit={canSubmit}
        onBack={onBack}
        onSubmit={() => void handleSubmit()}
        submitLabel="Create session"
        testIdBack="pro-tile-conversation-back"
        testIdSubmit="pro-tile-conversation-submit"
      />
    </div>
  );
}

export default ProTileConversation;
