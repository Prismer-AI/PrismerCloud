'use client';

/**
 * MobileNav — fixed bottom nav for the /workspace surface on phone-sized
 * viewports (< 768px / Tailwind `md`). Wave-8 W4 audit S4: the desktop
 * layout hides the LeftRail at sub-`lg` breakpoints with no replacement,
 * leaving the workspace effectively unusable on a phone.
 *
 * Five tiles match the surfaces enumerated in the workspace UI/UX plan:
 * Sessions, Tasks, Library, Contacts, Devices.
 */

import { MessageSquare, KanbanSquare, Library, Contact, Cpu } from 'lucide-react';

export type MobileSurface = 'sessions' | 'tasks' | 'library' | 'contacts' | 'runtime';

interface MobileNavProps {
  isDark: boolean;
  active: MobileSurface;
  onSelect: (surface: MobileSurface) => void;
}

interface NavTile {
  key: MobileSurface;
  label: string;
  Icon: typeof MessageSquare;
}

const TILES: NavTile[] = [
  { key: 'sessions', label: 'Sessions', Icon: MessageSquare },
  { key: 'tasks', label: 'Tasks', Icon: KanbanSquare },
  { key: 'library', label: 'Library', Icon: Library },
  { key: 'contacts', label: 'Contacts', Icon: Contact },
  { key: 'runtime', label: 'Devices', Icon: Cpu },
];

export function MobileNav({ isDark, active, onSelect }: MobileNavProps) {
  return (
    <nav
      data-testid="workspace-mobile-nav"
      className={`md:hidden fixed bottom-0 inset-x-0 z-30 border-t flex items-stretch justify-around ${
        isDark ? 'bg-zinc-950/95 border-white/5' : 'bg-white/95 border-zinc-200'
      } backdrop-blur`}
    >
      {TILES.map(({ key, label, Icon }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            data-testid={`mobile-nav-${key}`}
            data-active={isActive ? 'true' : undefined}
            aria-pressed={isActive}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors ${
              isActive ? (isDark ? 'text-violet-300' : 'text-violet-700') : isDark ? 'text-zinc-500' : 'text-zinc-500'
            }`}
          >
            <Icon className={`w-5 h-5 ${isActive ? '' : 'opacity-70'}`} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
