'use client';

/**
 * Project risk card (release201/12 §8c row 6).
 *
 * Fires on `project.metric.snapshot_updated` with status=failing. Shows the
 * metric name + current vs target + deep link to the project's Insights view.
 */

import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import type { ProjectMetricPayload } from '../../lib/business-event-bus';

export interface ProjectRiskCardProps {
  isDark: boolean;
  payload: ProjectMetricPayload;
  /**
   * release201 S12 — Insights moved in-shell. Click handler flips the
   * parent workspace to `activeSurface === 'insights'` and pre-scopes the
   * Project view via URL params. The handler is optional so card-only
   * smoke tests (no shell) still render.
   */
  onOpenProjectInsights?: (projectId: string) => void;
}

export function ProjectRiskCard({ isDark, payload, onOpenProjectInsights }: ProjectRiskCardProps) {
  return (
    <div
      data-testid="biz-card-project-risk"
      className={`flex flex-col gap-2 rounded-2xl border p-3 text-xs ${
        isDark ? 'border-rose-500/25 bg-rose-500/10' : 'border-rose-200 bg-rose-50'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle className={`h-3.5 w-3.5 ${isDark ? 'text-rose-300' : 'text-rose-700'}`} />
        <span className={`min-w-0 truncate font-semibold ${isDark ? 'text-rose-100' : 'text-rose-900'}`}>
          Project metric failing: {payload.name}
        </span>
      </div>
      <p className={`text-[11px] ${isDark ? 'text-rose-200' : 'text-rose-800'}`}>
        current {payload.current ?? '—'} vs target {payload.target ?? '—'}
      </p>
      <button
        type="button"
        data-testid="biz-card-project-risk-open"
        onClick={() => onOpenProjectInsights?.(payload.projectId)}
        disabled={!onOpenProjectInsights}
        className={`inline-flex items-center gap-1 self-end rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
          isDark ? 'text-rose-200 hover:bg-rose-500/15' : 'text-rose-800 hover:bg-rose-100'
        }`}
      >
        Open project insights <ArrowUpRight className="h-3 w-3" />
      </button>
    </div>
  );
}
