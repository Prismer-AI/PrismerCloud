'use client';

import { motion } from 'framer-motion';
import { Bot, Check, FolderPlus, Laptop, MessageSquare, Plus, Send, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';

import { radius, springSnap, springSoft, surface } from '../lib/design';

/**
 * release201/20 Gap B (v2.0.8 Wave 1 F2) — 6-step onboarding + full i18n.
 *
 * Steps (in render order):
 *   team    → set up workspace team profile (industry + size)
 *   agent   → create first agent
 *   project → create first project (NEW per doc 20 §2.2 decision)
 *   device  → pair a daemon device
 *   session → open first chat session
 *   task    → dispatch first task
 *
 * Asset step removed per doc 20 §2.2 decision 4 (deferred to v2.1+).
 */
interface OnboardingStep {
  key: 'team' | 'agent' | 'project' | 'device' | 'session' | 'task';
  label: string;
  detail: string;
  done: boolean;
  icon: LucideIcon;
  onClick: () => void;
}

interface WorkspaceOnboardingProps {
  isDark: boolean;
  agentsCount: number;
  projectsCount: number;
  channelsCount: number;
  tasksCount: number;
  devicesCount: number;
  onSetupTeam: () => void;
  onNewAgent: () => void;
  onCreateProject: () => void;
  onPairDevice?: () => void;
  onNewChannel: () => void;
  onNewTask: () => void;
}

export function WorkspaceOnboarding({
  isDark,
  agentsCount,
  projectsCount,
  channelsCount,
  tasksCount,
  devicesCount,
  onSetupTeam,
  onNewAgent,
  onCreateProject,
  onPairDevice,
  onNewChannel,
  onNewTask,
}: WorkspaceOnboardingProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';

  // Step 1: team setup (always first, marked done once any device is paired —
  // device pairing implies the unified setup flow ran).
  const teamStep: OnboardingStep = {
    key: 'team',
    label: t('workspace.onboarding.step.team.label'),
    detail: t('workspace.onboarding.step.team.detail'),
    done: devicesCount > 0,
    icon: Bot,
    onClick: onSetupTeam,
  };

  // Step 2: agent
  const agentStep: OnboardingStep = {
    key: 'agent',
    label: t('workspace.onboarding.step.agent.label'),
    detail:
      agentsCount > 0
        ? t('workspace.onboarding.step.agent.detailCount', { n: agentsCount })
        : t('workspace.onboarding.step.agent.detailEmpty'),
    done: agentsCount > 0,
    icon: Bot,
    onClick: onNewAgent,
  };

  // Step 3: project (NEW — doc 20 §2.2)
  const projectStep: OnboardingStep = {
    key: 'project',
    label: t('workspace.onboarding.step.project.label'),
    detail: t('workspace.onboarding.step.project.detail'),
    done: projectsCount > 0,
    icon: FolderPlus,
    onClick: onCreateProject,
  };

  // Step 4: device
  const deviceStep: OnboardingStep = {
    key: 'device',
    label: t('workspace.onboarding.step.device.label'),
    detail: t('workspace.onboarding.step.device.detail'),
    done: devicesCount > 0,
    icon: Laptop,
    onClick: onPairDevice ?? onSetupTeam,
  };

  // Step 5: session
  const sessionStep: OnboardingStep = {
    key: 'session',
    label: t('workspace.onboarding.step.session.label'),
    detail: t('workspace.onboarding.step.session.detail'),
    done: channelsCount > 0,
    icon: MessageSquare,
    onClick: onNewChannel,
  };

  // Step 6: task
  const taskStep: OnboardingStep = {
    key: 'task',
    label: t('workspace.onboarding.step.task.label'),
    detail: t('workspace.onboarding.step.task.detail'),
    done: tasksCount > 0,
    icon: Send,
    onClick: onNewTask,
  };

  const steps: OnboardingStep[] = [teamStep, agentStep, projectStep, deviceStep, sessionStep, taskStep];
  const totalCount = steps.length;
  const doneCount = steps.filter((step) => step.done).length;
  if (doneCount === totalCount) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springSoft}
      className={`mx-5 mt-4 shrink-0 overflow-hidden border ${radius.pane} ${surface.pane[theme]}`}
      data-testid="workspace-onboarding"
      data-tour-anchor="setup-progress"
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
            <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {t('workspace.onboarding.title')}
            </p>
            <p className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t('workspace.onboarding.subtitle', { done: doneCount, total: totalCount })}
            </p>
          </div>
        </div>

        <div className="grid flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <motion.button
                key={step.key}
                type="button"
                data-testid={`workspace-onboarding-step-${step.key}`}
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
