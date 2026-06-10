'use client';

/**
 * Two modal dialogs owned by TaskBoard:
 *   - ExecutionMoveDialog — confirm a drag that touches an execution
 *     status (assigned/running/review/completed); user can opt-in to
 *     suppress the warning.
 *   - AssigneePickerDialog — inline assignee picker that opens when a
 *     drag lands an unassigned task in a column requiring an assignee.
 *
 * Extracted from `index.tsx` to keep that file's render() readable.
 * All state lives in the parent; this file is presentation + callbacks.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

import { useI18n } from '@/contexts/i18n-context';
import { surface, radius, avatarGradient, avatarInitials } from '../../lib/design';
import { classifyAgent, AGENT_KIND_PRESETS, type AgentKind } from '../../lib/agent-kind';
import type { AgentDTO, KanbanColumnKey } from '../../lib/types';

import type { PendingAssignmentMove, PendingExecutionMove } from './types';

interface ExecutionMoveDialogProps {
  isDark: boolean;
  theme: 'dark' | 'light';
  pendingExecutionMove: PendingExecutionMove | null;
  pendingTargetLabel: string | null;
  pendingAgentKind: AgentKind | undefined;
  skipFutureExecutionWarnings: boolean;
  setSkipFutureExecutionWarnings: (skip: boolean) => void;
  getColumnLabel: (column: KanbanColumnKey) => string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExecutionMoveDialog({
  isDark,
  theme,
  pendingExecutionMove,
  pendingTargetLabel,
  pendingAgentKind,
  skipFutureExecutionWarnings,
  setSkipFutureExecutionWarnings,
  getColumnLabel,
  onConfirm,
  onCancel,
}: ExecutionMoveDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open={!!pendingExecutionMove}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className={`${surface.modal[theme]} ${radius.pane} border`} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
            {t('workspace.taskBoard.executionTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('workspace.taskBoard.executionDescription', {
              column: pendingTargetLabel ?? t('workspace.taskBoard.thisColumn'),
            })}
          </DialogDescription>
        </DialogHeader>

        <div
          className={`rounded-lg border p-3 text-sm ${
            isDark ? 'border-white/[0.08] bg-white/[0.03] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
          }`}
        >
          {pendingExecutionMove?.toCol === 'in_progress' ? (
            <p>{t('workspace.taskBoard.executionInProgress')}</p>
          ) : pendingExecutionMove?.toCol === 'backlog' || pendingExecutionMove?.toCol === 'todo' ? (
            <p>
              {t('workspace.taskBoard.executionBackToPending', {
                column: pendingExecutionMove?.toCol === 'backlog' ? getColumnLabel('backlog') : getColumnLabel('todo'),
              })}
            </p>
          ) : (
            <p>{t('workspace.taskBoard.executionForce')}</p>
          )}
          {pendingAgentKind === 'long-running' ? (
            <p className="mt-2 text-xs opacity-80">{t('workspace.taskBoard.executionLongRunning')}</p>
          ) : null}
        </div>

        <label className={`flex items-center gap-2 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          <input
            type="checkbox"
            checked={skipFutureExecutionWarnings}
            onChange={(event) => setSkipFutureExecutionWarnings(event.currentTarget.checked)}
            className="h-3.5 w-3.5 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
          />
          {t('workspace.taskBoard.executionSkipWarning')}
        </label>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.close')}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t('workspace.taskBoard.changeStatus')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AssigneePickerDialogProps {
  isDark: boolean;
  theme: 'dark' | 'light';
  pendingAssignmentMove: PendingAssignmentMove | null;
  agents: AgentDTO[] | undefined;
  onPick: (assigneeId: string) => void | Promise<void>;
  onCancel: () => void;
}

export function AssigneePickerDialog({
  isDark,
  theme,
  pendingAssignmentMove,
  agents,
  onPick,
  onCancel,
}: AssigneePickerDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open={!!pendingAssignmentMove}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className={`${surface.modal[theme]} ${radius.pane} border`} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {pendingAssignmentMove?.toCol === 'in_progress'
              ? t('workspace.taskBoard.assignBeforeInProgress')
              : t('workspace.taskBoard.assignBeforeTodo')}
          </DialogTitle>
          <DialogDescription>
            {pendingAssignmentMove
              ? `"${pendingAssignmentMove.task.title || pendingAssignmentMove.task.id.slice(-8)}"`
              : null}
          </DialogDescription>
        </DialogHeader>

        <div
          className={`max-h-72 overflow-y-auto rounded-lg border ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/70'}`}
        >
          {(agents ?? []).length === 0 ? (
            <div className={`px-3 py-6 text-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t('workspace.taskBoard.noAgentsAvailable')}
            </div>
          ) : (
            <ul className="p-1">
              {(agents ?? []).map((agent) => {
                const kind = classifyAgent({ adapterName: agent.agentType ?? null });
                const kindPreset = AGENT_KIND_PRESETS[kind];
                const initials = avatarInitials(agent.name ?? agent.userId);
                const grad = avatarGradient(agent.name || agent.userId);
                return (
                  <li key={agent.userId}>
                    <button
                      type="button"
                      onClick={() => void onPick(agent.userId)}
                      data-testid={`task-board-assign-pick-${agent.userId}`}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left text-[13px] transition-colors ${
                        isDark ? 'text-zinc-200 hover:bg-white/[0.05]' : 'text-zinc-800 hover:bg-zinc-100'
                      }`}
                    >
                      <span
                        className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[10px] font-bold text-white shadow-sm"
                        style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
                      >
                        {initials}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-medium">{agent.name}</span>
                        {kindPreset ? (
                          <span className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                            {kindPreset.shortLabel}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
