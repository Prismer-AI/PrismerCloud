'use client';

/**
 * Studio onboarding panel — shown when the user is missing the precondition
 * for the current view (no paired agent, no installed skill, no drafted
 * skill). Auto-dismisses when all three are satisfied.
 *
 * Uses shadcn `Button` and evolution `glass()`.
 */

import { Check, Cpu, FolderKanban, Package, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { glass } from '../helpers';

export interface OnboardingState {
  hasAgent: boolean;
  hasInstalledSkill: boolean;
  hasDraft: boolean;
  // release201 v2.0.8 F-bug — project 抽象引导
  // Studio 引导新增 "create a project" 步骤, 与 workspace onboarding 保持
  // 一致 (workspace-onboarding 也是 6-step flow 含 project step).
  hasProject: boolean;
}

interface OnboardingProps {
  isDark: boolean;
  state: OnboardingState;
  onNewSkill: () => void;
}

interface Step {
  done: boolean;
  icon: typeof Cpu;
  title: string;
  body: string;
  cta: { label: string; onClick?: () => void; href?: string };
}

export function StudioOnboarding({ isDark, state, onNewSkill }: OnboardingProps) {
  const { t } = useI18n();
  const steps: Step[] = [
    {
      done: state.hasAgent,
      icon: Cpu,
      title: t('evolution.studio.onboarding.pairTitle'),
      body: t('evolution.studio.onboarding.pairBody'),
      cta: { label: t('evolution.studio.onboarding.pairCta'), href: '/workspace?tab=devices' },
    },
    {
      // release201 v2.0.8 F-bug — project 抽象引导. 顺序: pair → project →
      // install → draft. 项目是任务 / 技能的归集容器; 跳到 /workspace 让
      // 用户用 ProjectSwitcher 创建.
      done: state.hasProject,
      icon: FolderKanban,
      title: t('evolution.studio.onboarding.projectTitle'),
      body: t('evolution.studio.onboarding.projectBody'),
      cta: { label: t('evolution.studio.onboarding.projectCta'), href: '/workspace' },
    },
    {
      done: state.hasInstalledSkill,
      icon: Package,
      title: t('evolution.studio.onboarding.installTitle'),
      body: t('evolution.studio.onboarding.installBody'),
      cta: { label: t('evolution.studio.onboarding.installCta'), href: '/evolution?tab=library' },
    },
    {
      done: state.hasDraft,
      icon: Sparkles,
      title: t('evolution.studio.onboarding.authorTitle'),
      body: t('evolution.studio.onboarding.authorBody'),
      cta: { label: t('evolution.studio.onboarding.authorCta'), onClick: onNewSkill },
    },
  ];

  const allDone = steps.every((s) => s.done);
  if (allDone) {
    return (
      <div
        className={`rounded-2xl border p-5 ${
          isDark ? 'border-emerald-500/20 bg-emerald-500/[0.06]' : 'border-emerald-200 bg-emerald-50'
        }`}
      >
        <div className="flex items-start gap-3">
          <Check className={`mt-0.5 h-5 w-5 shrink-0 ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`} />
          <div>
            <p className={`text-sm font-semibold ${isDark ? 'text-emerald-100' : 'text-emerald-900'}`}>
              {t('evolution.studio.onboarding.doneTitle')}
            </p>
            <p className={`mt-1 text-xs ${isDark ? 'text-emerald-200/80' : 'text-emerald-800'}`}>
              {t('evolution.studio.onboarding.doneBody')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl p-5 ${glass(isDark, 'base')}`} data-testid="studio-onboarding">
      <div className="mb-4">
        <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {t('evolution.studio.onboarding.title')}
        </h3>
        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {t('evolution.studio.onboarding.body')}
        </p>
      </div>

      <ol className="space-y-2">
        {steps.map((step, i) => (
          <StepRow key={i} index={i + 1} step={step} isDark={isDark} />
        ))}
      </ol>
    </div>
  );
}

function StepRow({ index, step, isDark }: { index: number; step: Step; isDark: boolean }) {
  const Icon = step.icon;
  const numberClass = step.done
    ? isDark
      ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
      : 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300'
    : isDark
      ? 'bg-white/[0.04] text-zinc-300 ring-1 ring-white/[0.06]'
      : 'bg-white text-zinc-600 ring-1 ring-zinc-200';

  return (
    <li
      className={`flex items-start gap-3 rounded-xl border p-3 ${
        isDark ? 'border-white/[0.04] bg-zinc-950/40' : 'border-zinc-200 bg-white'
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${numberClass}`}
      >
        {step.done ? <Check className="h-3.5 w-3.5" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className={`h-3.5 w-3.5 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`} />
          <p className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{step.title}</p>
        </div>
        <p className={`mt-1 text-xs leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{step.body}</p>
      </div>
      {!step.done && (
        <div className="shrink-0">
          {step.cta.href ? (
            <Button asChild size="sm" variant="default">
              <Link href={step.cta.href}>{step.cta.label}</Link>
            </Button>
          ) : (
            <Button size="sm" onClick={step.cta.onClick}>
              {step.cta.label}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
