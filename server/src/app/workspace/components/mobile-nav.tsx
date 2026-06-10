'use client';

/**
 * MobileNav — fixed bottom nav for the /workspace surface on phone-sized
 * viewports (< 768px / Tailwind `md`). Wave-8 W4 audit S4: the desktop
 * layout hides the LeftRail at sub-`lg` breakpoints with no replacement,
 * leaving the workspace effectively unusable on a phone.
 *
 * Four tiles match the chat-first workspace shell:
 * Chats, Tasks, Assets, Devices. Contacts live inside Chats as People.
 */

import { MessageSquare, KanbanSquare, Library, Cpu, LineChart } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';

export type MobileSurface = 'chats' | 'tasks' | 'library' | 'runtime' | 'insights';

interface MobileNavProps {
  isDark: boolean;
  active: MobileSurface;
  onSelect: (surface: MobileSurface) => void;
}

interface NavTile {
  key: MobileSurface;
  Icon: typeof MessageSquare;
}

/**
 * release201 S12 — Insights is a peer surface (no longer a separate route),
 * so its tile uses onSelect like the other surfaces. Order matches the
 * desktop left-rail: Insights → Chats → Tasks → Library → Devices.
 */
const TILES: NavTile[] = [
  { key: 'insights', Icon: LineChart },
  { key: 'chats', Icon: MessageSquare },
  { key: 'tasks', Icon: KanbanSquare },
  { key: 'library', Icon: Library },
  { key: 'runtime', Icon: Cpu },
];

export function MobileNav({ isDark, active, onSelect }: MobileNavProps) {
  const { t } = useI18n();
  const labelFor = (key: MobileSurface) => {
    if (key === 'chats') return t('workspace.shell.chats');
    if (key === 'tasks') return t('workspace.leftRail.tasks');
    if (key === 'library') return t('workspace.leftRail.assets');
    if (key === 'insights') return 'Insights';
    return t('workspace.leftRail.devices');
  };

  return (
    <nav
      data-testid="workspace-mobile-nav"
      className={`md:hidden fixed bottom-0 inset-x-0 z-30 border-t flex items-stretch justify-around ${
        isDark ? 'bg-zinc-950/95 border-white/5' : 'bg-white/95 border-zinc-200'
      } backdrop-blur`}
    >
      {TILES.map(({ key, Icon }) => {
        const isActive = key === active;
        const label = labelFor(key);
        const baseCls = `flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors ${
          isActive ? (isDark ? 'text-violet-300' : 'text-violet-700') : isDark ? 'text-zinc-500' : 'text-zinc-500'
        }`;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            data-testid={`mobile-nav-${key}`}
            data-active={isActive ? 'true' : undefined}
            aria-pressed={isActive}
            className={baseCls}
          >
            <Icon className={`w-5 h-5 ${isActive ? '' : 'opacity-70'}`} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
