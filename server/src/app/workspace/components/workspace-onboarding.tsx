'use client';

import { motion } from 'framer-motion';
import { Archive, Bot, Check, MessageSquare, Plus, Send, Sparkles } from 'lucide-react';

import { radius, springSnap, springSoft, surface } from '../lib/design';

interface WorkspaceOnboardingProps {
  isDark: boolean;
  agentsCount: number;
  channelsCount: number;
  tasksCount: number;
  assetsCount: number;
  onNewAgent: () => void;
  onNewChannel: () => void;
  onNewTask: () => void;
  onUploadAsset: () => void;
}

export function WorkspaceOnboarding({
  isDark,
  agentsCount,
  channelsCount,
  tasksCount,
  assetsCount,
  onNewAgent,
  onNewChannel,
  onNewTask,
  onUploadAsset,
}: WorkspaceOnboardingProps) {
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const steps = [
    {
      key: 'agent',
      label: 'Create agent',
      detail: agentsCount > 0 ? `${agentsCount} agent${agentsCount === 1 ? '' : 's'}` : 'CEO, engineer, CMO, COO',
      done: agentsCount > 0,
      icon: Bot,
      onClick: onNewAgent,
    },
    {
      key: 'session',
      label: 'Open session',
      detail: channelsCount > 0 ? `${channelsCount} session${channelsCount === 1 ? '' : 's'}` : 'Direct or group chat',
      done: channelsCount > 0,
      icon: MessageSquare,
      onClick: onNewChannel,
    },
    {
      key: 'task',
      label: 'Dispatch task',
      detail: tasksCount > 0 ? `${tasksCount} task${tasksCount === 1 ? '' : 's'}` : 'Track work on the board',
      done: tasksCount > 0,
      icon: Send,
      onClick: onNewTask,
    },
    {
      key: 'asset',
      label: 'Add asset',
      detail: assetsCount > 0 ? `${assetsCount} asset${assetsCount === 1 ? '' : 's'}` : 'Upload workspace files',
      done: assetsCount > 0,
      icon: Archive,
      onClick: onUploadAsset,
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  if (doneCount === steps.length) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springSoft}
      className={`mx-5 mt-4 shrink-0 overflow-hidden border ${radius.pane} ${surface.pane[theme]}`}
      data-testid="workspace-onboarding"
    >
      <div className="flex flex-col gap-3 px-4 py-3 2xl:flex-row 2xl:items-center">
        <div className="flex min-w-0 items-center gap-3 2xl:w-[280px]">
          <div
            className={`flex h-10 w-10 items-center justify-center ${radius.button} ${
              isDark ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-50 text-violet-700'
            }`}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Workspace setup</p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {doneCount}/4 ready for agent work
            </p>
          </div>
        </div>

        <div className="grid flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <motion.button
                key={step.key}
                type="button"
                onClick={step.done ? undefined : step.onClick}
                whileTap={step.done ? undefined : { scale: 0.97 }}
                transition={springSnap}
                className={`flex min-w-0 items-center gap-2 rounded-2xl border px-3 py-2.5 text-left transition-colors ${
                  step.done
                    ? isDark
                      ? 'border-emerald-400/25 bg-emerald-500/12 text-emerald-200'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700 shadow-[0_10px_30px_-24px_rgba(16,185,129,0.65)]'
                    : isDark
                      ? 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05] text-zinc-200'
                      : 'border-zinc-200 bg-white/75 hover:bg-white text-zinc-800 shadow-[0_10px_30px_-26px_rgba(76,29,149,0.45)]'
                }`}
              >
                <span
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                    step.done
                      ? 'bg-emerald-500/15'
                      : isDark
                        ? 'bg-violet-500/15 text-violet-200'
                        : 'bg-violet-50 text-violet-700'
                  }`}
                >
                  {step.done ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold truncate">{step.label}</span>
                  <span
                    className={`block text-[10px] truncate ${step.done ? 'opacity-75' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    {step.detail}
                  </span>
                </span>
                {!step.done ? <Plus className="h-3.5 w-3.5 shrink-0 opacity-60" /> : null}
              </motion.button>
            );
          })}
        </div>
      </div>
    </motion.section>
  );
}
