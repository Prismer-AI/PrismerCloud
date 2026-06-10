'use client';

/**
 * Snapshots surface (release201/28 §4.5) — `spatialGrammar.vault` [NEW], sky.
 *
 * Visual metaphor: a Time Machine vault. An agent's versioned restore points sit
 * on a horizontal timeline with a draggable, snap-to-point scrubber; the selected
 * point expands into a sealed "vault card" (definition vN · N skills · ±memory ·
 * size · createdBy · status). Card actions: Restore (AlertDialog confirm) / Clone
 * as agent / Share.
 *
 * Quotes `spatialGrammar.vault` (timeline + card pane). Five states:
 * loading / error / empty / gated / data. Mock-first via MOCK_SNAPSHOTS; the
 * live `GET /:agentId/snapshots` swap is a 0-UI source change.
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Copy, Database, History, RotateCcw, Share2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  grammarAccentClasses,
  radius,
  s,
  spatialGrammar,
  springSoft,
} from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { useTheme } from '@/contexts/theme-context';
import { cn } from '@/lib/utils';

import { STUDIO_MOCK_ENABLED } from '../flags';
import { MOCK_SNAPSHOTS } from '../mock';
import { SectionPlaceholder } from '../section-placeholder';
import type { AgentSnapshot } from '../types';
import { TimelineAxis } from './timeline-axis';

const ACCENT = grammarAccentClasses.sky;
const GRAMMAR = spatialGrammar.vault;

export interface SnapshotsSurfaceProps {
  agentId: string | null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const STATUS_DOT: Record<AgentSnapshot['status'], string> = {
  ready: ACCENT.dot,
  creating: 'bg-amber-400',
  failed: 'bg-rose-400',
};

export function SnapshotsSurface({ agentId }: SnapshotsSurfaceProps) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const reduce = useReducedMotion();
  const isDark = resolvedTheme === 'dark';
  const theme = isDark ? 'dark' : 'light';

  const snapshots = useMemo<AgentSnapshot[]>(
    () => (STUDIO_MOCK_ENABLED && agentId ? (MOCK_SNAPSHOTS[agentId] ?? []) : []),
    [agentId],
  );

  // Reset selection to the latest point whenever the agent / list changes,
  // adjusting state during render (React-recommended over an effect).
  const [selected, setSelected] = useState(0);
  const [trackKey, setTrackKey] = useState(`${agentId}:${snapshots.length}`);
  const currentKey = `${agentId}:${snapshots.length}`;
  if (trackKey !== currentKey) {
    setTrackKey(currentKey);
    setSelected(Math.max(0, snapshots.length - 1));
  }

  // ── Gated: no agent selected ──
  if (!agentId) {
    return (
      <SectionPlaceholder
        section="snapshots"
        icon={History}
        titleKey="evolution.studio.v2.snapshots.title"
        hintKey="evolution.studio.v2.snapshots.gated"
      />
    );
  }

  // ── Empty: agent has no snapshots yet ──
  if (snapshots.length === 0) {
    return (
      <SectionPlaceholder
        section="snapshots"
        icon={History}
        titleKey="evolution.studio.v2.snapshots.title"
        hintKey="evolution.studio.v2.snapshots.empty"
      />
    );
  }

  const point = snapshots[Math.min(selected, snapshots.length - 1)];

  return (
    <div className={cn('flex h-full flex-col px-6 py-6', GRAMMAR.layout)}>
      {/* Header + grammar tag */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className={cn('text-lg font-semibold', isDark ? 'text-zinc-50' : 'text-zinc-900')}>
            {t('evolution.studio.v2.snapshots.title')}
          </h2>
          <p className={cn('mt-0.5 max-w-xl text-sm', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
            {t('evolution.studio.v2.snapshots.hint')}
          </p>
        </div>
        <span
          className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium', ACCENT.bg, ACCENT.text)}
          title={GRAMMAR.primaryMetaphor}
        >
          <span className={cn('size-1.5 rounded-full', ACCENT.dot)} aria-hidden />
          {GRAMMAR.primaryMetaphor.split(' — ')[0]}
        </span>
      </div>

      {/* Timeline (vault grammar) */}
      <div className={cn('border', radius.pane, s(theme, 'pane'))}>
        <TimelineAxis
          isDark={isDark}
          labels={snapshots.map((sn) => sn.label)}
          selectedIndex={Math.min(selected, snapshots.length - 1)}
          onSelect={setSelected}
        />
      </div>

      {/* Selected restore-point card */}
      <div className="min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={point.id}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={reduce ? { duration: 0 } : springSoft}
            className={cn('border p-5', radius.card, s(theme, 'card'))}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className={cn('flex size-10 items-center justify-center rounded-xl border', ACCENT.bg)}>
                  <History className={cn('size-5', ACCENT.text)} aria-hidden />
                </span>
                <div>
                  <h3 className={cn('text-base font-semibold', isDark ? 'text-zinc-50' : 'text-zinc-900')}>
                    {t('evolution.studio.v2.snapshots.title').replace(/s$/, '')} · {point.label}
                  </h3>
                  <p className={cn('text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                    {new Date(point.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <span
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs', s(theme, 'inset'), isDark ? 'text-zinc-300' : 'text-zinc-700')}
                title={t('evolution.studio.v2.snapshots.status')}
              >
                <span className={cn('size-1.5 rounded-full', STATUS_DOT[point.status])} aria-hidden />
                {t('evolution.common.statusAria', { status: point.status })}
              </span>
            </div>

            {/* Meta row */}
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <MetaChip theme={theme} isDark={isDark} label={`${t('evolution.studio.v2.snapshots.definition')} ${point.definitionVersion}`} />
              <MetaChip theme={theme} isDark={isDark} label={`${point.skillCount} ${t('evolution.common.skills').toLowerCase()}`} />
              <MetaChip
                theme={theme}
                isDark={isDark}
                label={point.includeMemory ? t('evolution.studio.v2.snapshots.memory') : t('evolution.studio.v2.snapshots.noMemory')}
              />
              <MetaChip theme={theme} isDark={isDark} icon={<Database className="size-3" aria-hidden />} label={`${t('evolution.studio.v2.snapshots.size')} ${formatSize(point.sizeBytes)}`} />
              <MetaChip theme={theme} isDark={isDark} label={`${t('evolution.studio.v2.snapshots.createdBy')} ${point.createdBy}`} />
            </div>

            {/* Actions */}
            <div className="mt-5 flex flex-wrap gap-2">
              {/* Restore — destructive-ish, confirm via AlertDialog */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="default" disabled={point.status !== 'ready'}>
                    <RotateCcw className="size-4" aria-hidden />
                    {t('evolution.studio.v2.snapshots.restore')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('evolution.studio.v2.snapshots.restoreConfirmTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('evolution.studio.v2.snapshots.restoreConfirmBody')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction>{t('evolution.studio.v2.snapshots.restore')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Clone as agent */}
              <Button size="sm" variant="outline">
                <Copy className="size-4" aria-hidden />
                {t('evolution.studio.v2.snapshots.cloneAsAgent')}
              </Button>

              {/* Share */}
              <Button size="sm" variant="ghost">
                <Share2 className="size-4" aria-hidden />
                {t('evolution.studio.v2.snapshots.share')}
              </Button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function MetaChip({
  theme,
  isDark,
  label,
  icon,
}: {
  theme: 'dark' | 'light';
  isDark: boolean;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium', s(theme, 'inset'), isDark ? 'text-zinc-300' : 'text-zinc-700')}
    >
      {icon}
      {label}
    </span>
  );
}
