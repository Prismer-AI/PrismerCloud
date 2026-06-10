'use client';

/**
 * §30 B3.5 — Pro mode 5-picker + sub-panel router.
 *
 * Spec §2.8.5: 5 tiles (144 × 120 px, 2 rows: 3+2) for Workspace / Device /
 * Agent / Profile / Conversation. Click → AnimatePresence slides into the
 * corresponding sub-panel (x: 32 → 0, springSoft). Back returns to picker.
 *
 * Per B0 audit: Workspace has no existing UI today, so it ships DISABLED
 * with a "Coming soon" tooltip. The other 4 tiles wrap copied form bodies
 * from k8s-provision-wizard / new-agent-dialog / new-channel-dialog, with
 * the originals untouched (don't break existing dialogs).
 *
 * B0 Risk #2 (daemon polling lifecycle): the long-running daemon health
 * poll lives inside ProTileAgent and unmounts on Back — never leaks past
 * the picker boundary.
 *
 * a11y: tile picker is `role="menu"`, each tile `role="menuitem"`. Back
 * button has an explicit aria-label.
 */

import { useCallback, useState, type ComponentType, type SVGProps } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { ArrowLeft, Bot, Building2, MessageSquare, Monitor, Settings2, Terminal } from 'lucide-react';

import { radius, s, springSnap, springSoft } from '../../lib/design';
import type { AgentDTO, AgentProfileDTO } from '../../lib/types';
import { ProTileDevice } from './pro/ProTileDevice';
import { ProTileAgent } from './pro/ProTileAgent';
import { ProTileExecutor } from './pro/ProTileExecutor';
import { ProTileProfile } from './pro/ProTileProfile';
import { ProTileConversation } from './pro/ProTileConversation';
import type { UnifiedCreationEvent } from './context';

// ───────────────────────── Public types ─────────────────────────

export type ProEntity = 'workspace' | 'device' | 'agent' | 'executor' | 'profile' | 'conversation';

export interface ProModeFlowProps {
  isDark: boolean;
  workspaceId: string;
  agents: AgentDTO[];
  profiles: AgentProfileDTO[];
  onCreated: (event: UnifiedCreationEvent) => void;
  defaultConversationId?: string;
}

// ───────────────────────── Internals ─────────────────────────

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };

interface TileDef {
  key: ProEntity;
  label: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  disabled?: boolean;
  disabledTooltip?: string;
}

const TILES: readonly TileDef[] = [
  {
    key: 'workspace',
    label: 'Workspace',
    description: 'A new tenant for agents + data.',
    icon: Building2,
    disabled: true,
    disabledTooltip: 'Coming soon — workspaces auto-create per user today',
  },
  { key: 'device', label: 'Device', description: 'Set up a cloud computer.', icon: Monitor },
  { key: 'agent', label: 'Agent', description: 'Register a long-running role.', icon: Bot },
  {
    key: 'executor',
    label: 'Executor',
    description: 'CLI executor (codex/claude-code) — bounded coding tasks.',
    icon: Terminal,
  },
  { key: 'profile', label: 'Profile', description: 'How an agent runs.', icon: Settings2 },
  { key: 'conversation', label: 'Conversation', description: 'Open a 1:1 or group chat.', icon: MessageSquare },
];

// ───────────────────────── Component ─────────────────────────

export function ProModeFlow({
  isDark,
  workspaceId,
  agents,
  profiles: _profiles,
  onCreated,
  defaultConversationId,
}: ProModeFlowProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tSoft: Transition = reduce ? REDUCED : springSoft;
  const tSnap: Transition = reduce ? REDUCED : springSnap;

  const [selected, setSelected] = useState<ProEntity | null>(null);
  const goBack = useCallback(() => setSelected(null), []);

  return (
    <div data-testid="unified-creation-pro" className="min-h-[420px]">
      <AnimatePresence mode="wait" initial={false}>
        {selected === null ? (
          <motion.div
            key="picker"
            initial={{ opacity: 0, x: -32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -32 }}
            transition={tSoft}
            className="grid gap-4"
          >
            <header className="text-center">
              <h2 className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>你要创建什么?</h2>
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                选择一类资源进入对应配置面板。
              </p>
            </header>
            <div
              role="menu"
              aria-label="Create resource"
              data-testid="unified-creation-pro-picker"
              className="mx-auto grid w-full max-w-[480px] grid-cols-3 gap-3"
            >
              {TILES.map((tile) => (
                <Tile
                  key={tile.key}
                  tile={tile}
                  isDark={isDark}
                  theme={theme}
                  transition={tSnap}
                  onSelect={setSelected}
                />
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key={`panel-${selected}`}
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 32 }}
            transition={tSoft}
            className="flex min-h-[420px] flex-col gap-3"
          >
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to picker"
              data-testid="unified-creation-pro-back"
              className={`inline-flex w-fit items-center gap-1.5 px-2 py-1 text-xs font-medium transition-colors ${radius.button} ${
                isDark ? 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <div className="min-h-0 flex-1">
              {selected === 'device' ? (
                <ProTileDevice isDark={isDark} workspaceId={workspaceId} onSuccess={onCreated} onBack={goBack} />
              ) : selected === 'agent' ? (
                <ProTileAgent isDark={isDark} workspaceId={workspaceId} onSuccess={onCreated} onBack={goBack} />
              ) : selected === 'executor' ? (
                <ProTileExecutor isDark={isDark} workspaceId={workspaceId} onSuccess={onCreated} onBack={goBack} />
              ) : selected === 'profile' ? (
                <ProTileProfile
                  isDark={isDark}
                  workspaceId={workspaceId}
                  agents={agents}
                  onSuccess={onCreated}
                  onBack={goBack}
                />
              ) : selected === 'conversation' ? (
                <ProTileConversation
                  isDark={isDark}
                  workspaceId={workspaceId}
                  agents={agents}
                  defaultConversationId={defaultConversationId}
                  onSuccess={onCreated}
                  onBack={goBack}
                />
              ) : (
                <div
                  className={`flex h-full min-h-[280px] flex-col items-center justify-center text-center text-xs ${
                    isDark ? 'text-zinc-400' : 'text-zinc-500'
                  }`}
                  data-testid="unified-creation-pro-workspace-disabled"
                >
                  Workspace creation is coming soon.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ───────────────────────── Tile ─────────────────────────

function Tile({
  tile,
  isDark,
  theme,
  transition,
  onSelect,
}: {
  tile: TileDef;
  isDark: boolean;
  theme: 'dark' | 'light';
  transition: Transition;
  onSelect: (key: ProEntity) => void;
}) {
  const Icon = tile.icon;
  const disabled = !!tile.disabled;
  return (
    <motion.button
      type="button"
      role="menuitem"
      aria-disabled={disabled}
      aria-label={disabled ? `${tile.label} — ${tile.disabledTooltip}` : tile.label}
      title={disabled ? tile.disabledTooltip : undefined}
      data-testid={`unified-creation-pro-tile-${tile.key}`}
      data-disabled={disabled ? 'true' : 'false'}
      whileHover={disabled ? undefined : { scale: 1.02, y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={transition}
      onClick={() => {
        if (!disabled) onSelect(tile.key);
      }}
      className={`relative flex h-[120px] w-[144px] flex-col items-center justify-center gap-1.5 border px-3 py-3 text-center transition-colors ${radius.card} ${
        disabled
          ? isDark
            ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.02] text-zinc-600'
            : 'cursor-not-allowed border-zinc-200/60 bg-zinc-50 text-zinc-400'
          : `${s(theme, 'card')} ${isDark ? 'text-zinc-200 hover:border-violet-400/40' : 'text-zinc-700 hover:border-violet-300'}`
      }`}
    >
      <Icon className="h-6 w-6" />
      <span className="text-sm font-semibold">{tile.label}</span>
      <span className={`text-[10px] leading-tight opacity-70 ${disabled ? 'italic' : ''}`}>
        {disabled ? 'Coming soon' : tile.description}
      </span>
    </motion.button>
  );
}

export default ProModeFlow;
