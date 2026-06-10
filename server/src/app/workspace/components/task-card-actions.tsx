'use client';

/**
 * TaskCardActions — per-column primary/secondary action buttons for a task card.
 *
 * Pure presentational component: derives the "column bucket" from
 * (task.status, task.assigneeId), renders a two-button row (primary filled +
 * secondary ghost), and dispatches callbacks. No API calls, no fetching, no
 * mutations — wiring happens at the integration layer.
 *
 * If a callback for the active bucket's action is not provided, the button is
 * still rendered but disabled, so the card footer keeps a stable layout.
 *
 * Button proportions match the task-card.tsx drawer/menu controls (px-3 py-1.5,
 * text-xs font-semibold, rounded-lg, violet accent for primary), scaled for the
 * card footer.
 */

import type { MouseEvent, ReactNode } from 'react';
import { Play, Pause, Check, X, RotateCcw, User, FolderOpen, PlayCircle, Undo2 } from 'lucide-react';

export interface TaskCardActionsProps {
  task: { id: string; status: string; assigneeId: string | null };
  onStart?: () => void;
  onPause?: () => void;
  onApprove?: () => void;
  onReject?: () => void; // opens reject reason inline or in modal
  onReopen?: () => void;
  onAssign?: () => void; // opens assignee picker
  onReassign?: () => void; // opens picker (different label from assign)
  onViewOutput?: () => void; // for Done column
  onCancel?: () => void; // moved here so it's also accessible inline if needed
  /** P6: BLOCKED → running (assignee / creator / orchestrator). */
  onUnblock?: () => void;
  /** P6: cancelled → pending (restore from recycle bin). */
  onRestore?: () => void;
  disabled?: boolean; // global disable (e.g. during mutation in-flight)
  className?: string;
}

type ColumnBucket = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled' | 'unknown';

type ActionButtonSpec = {
  key: string;
  label: string;
  icon: ReactNode;
  handler?: () => void;
};

function deriveBucket(status: string, assigneeId: string | null): ColumnBucket {
  if (status === 'pending' && !assigneeId) return 'backlog';
  if ((status === 'pending' || status === 'assigned') && assigneeId) return 'todo';
  if (status === 'running' || status === 'in_progress') return 'in_progress';
  if (status === 'review') return 'review';
  if (status === 'blocked') return 'blocked';
  if (status === 'completed' || status === 'failed') return 'done';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

function PrimaryButton({
  spec,
  disabled,
  dataTestId,
}: {
  spec: ActionButtonSpec;
  disabled: boolean;
  dataTestId: string;
}) {
  const noHandler = !spec.handler;
  return (
    <button
      type="button"
      data-testid={dataTestId}
      disabled={disabled || noHandler}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        spec.handler?.();
      }}
      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400"
    >
      {spec.icon}
      <span>{spec.label}</span>
    </button>
  );
}

function SecondaryButton({
  spec,
  disabled,
  dataTestId,
}: {
  spec: ActionButtonSpec;
  disabled: boolean;
  dataTestId: string;
}) {
  const noHandler = !spec.handler;
  return (
    <button
      type="button"
      data-testid={dataTestId}
      disabled={disabled || noHandler}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        spec.handler?.();
      }}
      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/[0.05]"
    >
      {spec.icon}
      <span>{spec.label}</span>
    </button>
  );
}

export function TaskCardActions({
  task,
  onStart,
  onPause,
  onApprove,
  onReject,
  onReopen,
  onAssign,
  onReassign,
  onViewOutput,
  onUnblock,
  onRestore,
  // onCancel is intentionally not rendered inline — lives in the overflow menu.
  // Still accepted in props so callers don't get a type error if they pass it.

  onCancel: _onCancel,
  disabled = false,
  className,
}: TaskCardActionsProps) {
  const bucket = deriveBucket(task.status, task.assigneeId);

  const iconClass = 'w-3.5 h-3.5';

  let primary: ActionButtonSpec | null = null;
  let secondary: ActionButtonSpec | null = null;

  switch (bucket) {
    case 'backlog':
      primary = {
        key: 'assign',
        label: '分配',
        icon: <User className={iconClass} />,
        handler: onAssign,
      };
      break;
    case 'todo':
      primary = {
        key: 'start',
        label: '开始',
        icon: <Play className={iconClass} />,
        handler: onStart,
      };
      // Secondary "Reassign" only shows when not globally disabled.
      if (!disabled) {
        secondary = {
          key: 'reassign',
          label: '改派',
          icon: <User className={iconClass} />,
          handler: onReassign,
        };
      }
      break;
    case 'in_progress':
      primary = {
        key: 'pause',
        label: '暂停',
        icon: <Pause className={iconClass} />,
        handler: onPause,
      };
      break;
    case 'review':
      primary = {
        key: 'approve',
        label: '通过',
        icon: <Check className={iconClass} />,
        handler: onApprove,
      };
      secondary = {
        key: 'reject',
        label: '驳回',
        icon: <X className={iconClass} />,
        handler: onReject,
      };
      break;
    case 'blocked':
      // P6 BLOCKED column — first-class actions: 继续 (Unblock, blocked→running)
      // and 改派 (Reassign, hands the task off without unblocking). Cancel
      // stays in the overflow menu.
      primary = {
        key: 'unblock',
        label: '继续',
        icon: <PlayCircle className={iconClass} />,
        handler: onUnblock,
      };
      if (!disabled) {
        secondary = {
          key: 'reassign',
          label: '改派',
          icon: <User className={iconClass} />,
          handler: onReassign,
        };
      }
      break;
    case 'done':
      primary = {
        key: 'view-output',
        label: '查看产物',
        icon: <FolderOpen className={iconClass} />,
        handler: onViewOutput,
      };
      secondary = {
        key: 'reopen',
        label: '重启',
        icon: <RotateCcw className={iconClass} />,
        handler: onReopen,
      };
      break;
    case 'cancelled':
      // P6 CANCELLED — primary action is 还原 (cancelled→pending). The
      // server enforces creator/owner/admin/orchestrator per the
      // TRANSITIONS matrix; we let the call go through and surface the
      // forbidden error via describeTransitionError if the actor is below
      // that tier.
      primary = {
        key: 'restore',
        label: '还原',
        icon: <Undo2 className={iconClass} />,
        handler: onRestore,
      };
      break;
    case 'unknown':
    default:
      return null;
  }

  if (!primary) return null;

  const rowClass = `flex items-center gap-1.5 ${className ?? ''}`.trim();

  return (
    <div data-testid="task-card-actions" data-bucket={bucket} className={rowClass}>
      <PrimaryButton spec={primary} disabled={disabled} dataTestId={`task-card-actions-primary-${primary.key}`} />
      {secondary ? (
        <SecondaryButton
          spec={secondary}
          disabled={disabled}
          dataTestId={`task-card-actions-secondary-${secondary.key}`}
        />
      ) : null}
    </div>
  );
}

export default TaskCardActions;
