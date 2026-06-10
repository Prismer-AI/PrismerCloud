/**
 * Kanban column-label/hint config (8 columns + the optional recycle-bin
 * 9th). Pulled out of `index.tsx` so the orchestration file isn't 70
 * lines of i18n key strings.
 *
 * release 200 P6 — `blocked` is its own column so agent-self-reported
 * stuck tasks surface immediately instead of hiding inside `in_progress`.
 * The recycle bin (`cancelled`) is hidden behind a toggle.
 */

import type { TranslationKey } from '@/lib/i18n';
import type { KanbanColumnKey } from '../../lib/types';

type TFunction = (key: TranslationKey, values?: Record<string, string | number>) => string;

export interface KanbanColumnConfig {
  key: KanbanColumnKey;
  label: string;
  hint: string;
}

export function buildKanbanColumns(t: TFunction, showRecycleBin: boolean): KanbanColumnConfig[] {
  const base: KanbanColumnConfig[] = [
    {
      key: 'backlog',
      label: t('workspace.taskBoard.columns.backlog.label'),
      hint: t('workspace.taskBoard.columns.backlog.hint'),
    },
    {
      key: 'todo',
      label: t('workspace.taskBoard.columns.todo.label'),
      hint: t('workspace.taskBoard.columns.todo.hint'),
    },
    {
      key: 'in_progress',
      label: t('workspace.taskBoard.columns.inProgress.label'),
      hint: t('workspace.taskBoard.columns.inProgress.hint'),
    },
    {
      key: 'review',
      label: t('workspace.taskBoard.columns.review.label'),
      hint: t('workspace.taskBoard.columns.review.hint'),
    },
    {
      key: 'blocked',
      label: t('workspace.taskBoard.columns.blocked.label'),
      hint: t('workspace.taskBoard.columns.blocked.hint'),
    },
    {
      key: 'completed',
      label: t('workspace.taskBoard.columns.completed.label'),
      hint: t('workspace.taskBoard.columns.completed.hint'),
    },
    {
      key: 'failed',
      label: t('workspace.taskBoard.columns.failed.label'),
      hint: t('workspace.taskBoard.columns.failed.hint'),
    },
  ];
  if (showRecycleBin) {
    base.push({
      key: 'cancelled',
      label: t('workspace.taskBoard.columns.cancelled.label'),
      hint: t('workspace.taskBoard.columns.cancelled.hint'),
    });
  }
  return base;
}
