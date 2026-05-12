'use client';

/**
 * §30 B3.5 — Shared member-list row used by ProTileConversation.
 *
 * Each row: checkbox/radio + agent/human icon + name + optional type tag.
 * Extracted so ProTileConversation stays under its 250-line budget.
 */

import { Bot, User } from 'lucide-react';

export interface MemberRow {
  id: string;
  name: string;
  isAgent: boolean;
  typeTag?: string;
}

export function MemberListRow({
  isDark,
  row,
  checked,
  selectType,
  onToggle,
  testIdPrefix,
  inputName,
}: {
  isDark: boolean;
  row: MemberRow;
  checked: boolean;
  selectType: 'radio' | 'checkbox';
  onToggle: () => void;
  testIdPrefix: string;
  inputName?: string;
}) {
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
          checked
            ? isDark
              ? 'bg-violet-500/15 text-violet-200'
              : 'bg-violet-100 text-violet-900'
            : isDark
              ? 'text-zinc-300 hover:bg-white/5'
              : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        <input
          type={selectType}
          name={inputName}
          data-testid={`${testIdPrefix}-${row.id}`}
          checked={checked}
          onChange={onToggle}
          className="accent-violet-500"
        />
        {row.isAgent ? (
          <Bot className="h-3.5 w-3.5 shrink-0 opacity-70" />
        ) : (
          <User className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        <span className="truncate">{row.name}</span>
        {row.typeTag ? <span className="ml-auto shrink-0 text-[10px] uppercase opacity-70">{row.typeTag}</span> : null}
      </label>
    </li>
  );
}
