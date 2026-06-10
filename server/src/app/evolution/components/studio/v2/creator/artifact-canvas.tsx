'use client';

/**
 * Skill Creator — right Live Artifact Canvas (release201/28 §3.3).
 *
 * Four info layers, top → bottom:
 *   1. Liveness   — skill name/slug + phase status pill (pulsing while active)
 *   2. Artifact   — manifest tree (ManifestTree) + SKILL.md/skill.json preview
 *                   (SKILL.md streams as a typewriter, skill.json via CodeBlock)
 *   3. References — source cards that float in as `source.pulled` arrives
 *   4. Confidence — EvalGauge ring + per-case list
 * Raw tool-calls are tucked into a collapsible "Activity" drawer (default
 * collapsed). Spatial grammar = workshop centre+reference tracks.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Code2, FileText, Globe, Terminal, Wrench } from 'lucide-react';
import { useState } from 'react';

import {
  grammarAccentClasses,
  radius,
  s,
  springLiquid,
  springSnap,
  springSoft,
} from '@/app/workspace/lib/design';
import { CodeBlock } from '@/components/ui/code-block';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import type { EvalCase, ManifestFile, SourceRef } from '../types';
import { EvalGauge } from './eval-gauge';
import { ManifestTree } from './manifest-tree';

import type { CreatorPhase } from './creator-state';

export interface ToolActivity {
  id: string;
  tool: string;
  summary: string;
}

export interface ArtifactCanvasProps {
  phase: CreatorPhase;
  skillName: string;
  skillSlug: string;
  /** Pill label keyed off `status.*` already resolved by the parent. */
  statusLabel: string;
  files: ManifestFile[];
  sources: SourceRef[];
  /** SKILL.md text accumulated so far (streamed). */
  skillMd: string;
  skillJson: string;
  /** true while SKILL.md is still streaming → show the typewriter caret. */
  streaming: boolean;
  evalCases: EvalCase[];
  passRate: number | null;
  activity: ToolActivity[];
}

const PHASE_ACCENT: Record<CreatorPhase, 'amber' | 'cyan' | 'violet' | 'emerald'> = {
  idle: 'violet',
  drafting: 'violet',
  building: 'violet',
  draftReady: 'violet',
  evaluating: 'cyan',
  evaluated: 'cyan',
  published: 'emerald',
};

const SOURCE_ICON = { doc: FileText, code: Code2, service: Globe, inline: Terminal } as const;

export function ArtifactCanvas(props: ArtifactCanvasProps) {
  const {
    phase,
    skillName,
    skillSlug,
    statusLabel,
    files,
    sources,
    skillMd,
    skillJson,
    streaming,
    evalCases,
    passRate,
    activity,
  } = props;
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  const accent = grammarAccentClasses[PHASE_ACCENT[phase]];
  const active = phase === 'building' || phase === 'evaluating' || phase === 'drafting';
  const splat = phase === 'published';

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tab, setTab] = useState<'md' | 'json'>('md');
  const [activityOpen, setActivityOpen] = useState(false);

  const hasPreview = skillMd.length > 0 || skillJson.length > 0;
  const showEval = phase === 'evaluating' || phase === 'evaluated' || phase === 'published';

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      {/* 1 — Liveness */}
      <div className={cn('flex items-center gap-3 border p-3.5', radius.card, s(theme, 'card'))}>
        <motion.div
          initial={reduce ? false : { scale: 0.85 }}
          animate={{ scale: 1 }}
          transition={splat ? { type: 'spring', stiffness: 600, damping: 18, mass: 0.4 } : springSnap}
          className={cn('flex size-11 flex-none items-center justify-center border', radius.small, accent.bg)}
        >
          <Wrench className={cn('size-5', accent.text)} aria-hidden />
        </motion.div>
        <div className="min-w-0 flex-1">
          <h3 className={cn('truncate text-base font-semibold', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
            {skillName}
          </h3>
          <p className={cn('truncate font-mono text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>{skillSlug}</p>
        </div>
        <span
          className={cn(
            'inline-flex flex-none items-center gap-1.5 border px-2.5 py-1 text-xs font-medium',
            radius.chip,
            accent.bg,
            accent.text,
          )}
        >
          <motion.span
            className={cn('size-1.5 rounded-full', accent.dot)}
            animate={active && !reduce ? { opacity: [1, 0.3, 1], scale: [1, 1.3, 1] } : undefined}
            transition={active && !reduce ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : undefined}
            aria-hidden
          />
          {statusLabel}
        </span>
      </div>

      {/* 2 — Artifact: manifest + preview */}
      {files.some((f) => f.status !== 'pending') || files.length > 0 ? (
        <section className="space-y-2">
          <SectionLabel>{t('evolution.studio.v2.creator.manifest')}</SectionLabel>
          <ManifestTree files={files} selectedPath={selectedPath} onSelect={setSelectedPath} />
        </section>
      ) : null}

      {hasPreview ? (
        <section className={cn('overflow-hidden border', radius.card, s(theme, 'inset'))}>
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'md' | 'json')} className="gap-0">
            <TabsList variant="line" className="border-b border-current/[0.06] px-2">
              <TabsTrigger value="md">SKILL.md</TabsTrigger>
              <TabsTrigger value="json">skill.json</TabsTrigger>
            </TabsList>
            <div className="max-h-[320px] overflow-y-auto p-3 text-sm">
              {tab === 'md' ? (
                streaming ? (
                  <pre
                    className={cn(
                      'whitespace-pre-wrap break-words font-mono text-xs leading-relaxed',
                      isDark ? 'text-zinc-300' : 'text-zinc-700',
                    )}
                  >
                    {skillMd}
                    <motion.span
                      className={cn('ml-0.5 inline-block h-3.5 w-1.5 align-middle', accent.dot)}
                      animate={reduce ? undefined : { opacity: [1, 0, 1] }}
                      transition={reduce ? undefined : { duration: 0.9, repeat: Infinity }}
                      aria-hidden
                    />
                  </pre>
                ) : (
                  <MarkdownRenderer content={skillMd} />
                )
              ) : (
                <CodeBlock code={skillJson} language="json" isDark={isDark} />
              )}
            </div>
          </Tabs>
        </section>
      ) : null}

      {/* 3 — References */}
      <AnimatePresence>
        {sources.length > 0 ? (
          <motion.section
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={springSoft}
            className="space-y-2"
          >
            <SectionLabel>{t('evolution.studio.v2.creator.referencesPulled')}</SectionLabel>
            <div className="space-y-1.5">
              {sources.map((src, i) => {
                const Icon = SOURCE_ICON[src.kind];
                return (
                  <motion.div
                    key={`${src.kind}-${src.ref}-${i}`}
                    initial={reduce ? false : { opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={springLiquid}
                    className={cn('flex items-center gap-2.5 border p-2.5', radius.small, s(theme, 'card'))}
                  >
                    <div
                      className={cn(
                        'flex size-8 flex-none items-center justify-center border',
                        radius.small,
                        grammarAccentClasses.violet.bg,
                      )}
                    >
                      <Icon className={cn('size-4', grammarAccentClasses.violet.text)} aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-xs font-medium', isDark ? 'text-zinc-200' : 'text-zinc-800')}>
                        {src.ref}
                      </div>
                      <div className={cn('truncate text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                        {src.meta ?? `${(src.bytes / 1024).toFixed(1)} KB`}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>

      {/* 4 — Confidence */}
      {showEval ? (
        <motion.section
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springSoft}
          className={cn('space-y-3 border p-3.5', radius.card, s(theme, 'card'))}
        >
          <SectionLabel>{t('evolution.studio.v2.creator.evalSession')}</SectionLabel>
          <EvalGauge passRate={passRate} cases={evalCases} />
        </motion.section>
      ) : null}

      {/* Activity drawer (raw tool-calls, collapsed by default) */}
      {activity.length > 0 ? (
        <section className={cn('border', radius.card, s(theme, 'inset'))}>
          <button
            type="button"
            onClick={() => setActivityOpen((o) => !o)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-xs font-medium',
              isDark ? 'text-zinc-400' : 'text-zinc-600',
            )}
          >
            <Terminal className="size-3.5" aria-hidden />
            <span className="flex-1 text-left">
              {t('evolution.studio.v2.creator.activity')} · {activity.length}
            </span>
            <motion.span animate={{ rotate: activityOpen ? 180 : 0 }} transition={springSnap} aria-hidden>
              <ChevronDown className="size-3.5" />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {activityOpen ? (
              <motion.div
                initial={reduce ? false : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={reduce ? undefined : { height: 0, opacity: 0 }}
                transition={springSoft}
                className="overflow-hidden"
              >
                <div className="space-y-1 px-3 pb-2.5">
                  {activity.map((tc) => (
                    <div
                      key={tc.id}
                      className={cn('flex items-center gap-2 font-mono text-[11px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}
                    >
                      <span className={cn('rounded px-1.5 py-0.5', grammarAccentClasses.violet.bg, grammarAccentClasses.violet.text)}>
                        {tc.tool}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{tc.summary}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  return (
    <div className={cn('text-[11px] font-semibold uppercase tracking-wide', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
      {children}
    </div>
  );
}
