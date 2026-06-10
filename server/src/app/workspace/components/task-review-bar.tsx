'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { transitionTask } from '../lib/mutations';
import { imFetch } from '../lib/im-api';
import type { TaskDTO } from '../lib/types';

interface TaskReviewBarProps {
  isDark: boolean;
  tasks: TaskDTO[];
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  onOpenTask?: (taskId: string) => void;
  onTaskChanged?: () => void | Promise<void>;
}

/**
 * release201/10 rev 2 §8.5 — TODO summary chip for the review bar.
 *
 * Lazy fetches `/tasks/:id/todo` for the in-review task so the bar can
 * surface "5/10 TODOs" + a colour-coded chip (≥80% green / 50-79% amber
 * / <50% red). Cached in module scope by taskId so re-mounts inside a
 * single workspace session don't re-fire the request — board scroll +
 * review bar both consume the same task id and we don't want N+1.
 *
 * The cache is intentionally tiny (Map<string, summary>) and never
 * evicts during a session — TODO progress changes via SSE
 * (`task.todo.changed`) but the review bar only needs a single
 * snapshot for the soft-gate decision; the drawer's TODO tab is the
 * canonical surface for live updates.
 */
type TodoSummary = {
  doneCount: number;
  totalCount: number;
  progressPct: number;
};

const todoCache = new Map<string, TodoSummary | null>();

function useTodoSummary(taskId: string): TodoSummary | null {
  // `version` is a poor-man's signal — bumped after the lazy fetch resolves
  // so the parent re-reads `todoCache`. We avoid calling setState() with the
  // cached value (which React 19's lint flags as a cascading-render smell);
  // the cache itself is the source of truth and we just trigger one re-render
  // when it changes.
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (todoCache.has(taskId)) return;
    let cancelled = false;
    void (async () => {
      const res = await imFetch<TodoSummary>(`/tasks/${encodeURIComponent(taskId)}/todo`);
      if (cancelled) return;
      const summary = res.ok ? (res.data ?? null) : null;
      todoCache.set(taskId, summary);
      setVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return todoCache.get(taskId) ?? null;
}

function chipColour(kind: 'todo' | 'acceptance', pct: number, status: string | null, isDark: boolean): string {
  if (kind === 'acceptance') {
    if (status === 'passed') return isDark ? 'bg-emerald-500/15 text-emerald-200' : 'bg-emerald-50 text-emerald-700';
    if (status === 'failed') return isDark ? 'bg-rose-500/15 text-rose-200' : 'bg-rose-50 text-rose-700';
    return isDark ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-50 text-amber-700';
  }
  // TODO progress thresholds per release201/10 §8.4 — ≥80% green / 50-79% amber / <50% red
  if (pct >= 0.8) return isDark ? 'bg-emerald-500/15 text-emerald-200' : 'bg-emerald-50 text-emerald-700';
  if (pct >= 0.5) return isDark ? 'bg-amber-500/15 text-amber-200' : 'bg-amber-50 text-amber-700';
  return isDark ? 'bg-rose-500/15 text-rose-200' : 'bg-rose-50 text-rose-700';
}

function TodoSummaryChip({ taskId, isDark }: { taskId: string; isDark: boolean }) {
  const todo = useTodoSummary(taskId);
  if (!todo || todo.totalCount === 0) return null;
  const pct = Math.round(todo.progressPct * 100);
  return (
    <span
      data-testid={`task-review-bar-todo-chip-${taskId}`}
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chipColour(
        'todo',
        todo.progressPct,
        null,
        isDark,
      )}`}
      title={`TODO: ${pct}% complete`}
    >
      {todo.doneCount}/{todo.totalCount} TODO
    </span>
  );
}

export function TaskReviewBar({ isDark, tasks, notify, onOpenTask, onTaskChanged }: TaskReviewBarProps) {
  const [decidedTaskIds, setDecidedTaskIds] = useState<Set<string>>(() => new Set());
  const reviewTasks = useMemo(
    () => tasks.filter((task) => task.status === 'review' && !decidedTaskIds.has(task.id)),
    [decidedTaskIds, tasks],
  );
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  // P6 — inline reject reason. Replaces the unstyled `window.prompt()` so
  // the user can compose the comment without leaving the review bar. Only
  // one task can be in "reject-editing" mode at a time.
  const [rejectingTaskId, setRejectingTaskId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // release201/10 §8.5 — confirm modal payload. Surfaces when:
  //   (a) acceptance is partial/failed/pending (soft gate, §4.4) OR
  //   (b) TODO completion < 80% (§0.2.3 — same threshold as the server
  //       transition guard)
  // Replaces the previous window.confirm() so the message can wrap +
  // explain BOTH conditions and the user can read at glance.
  const [confirmPayload, setConfirmPayload] = useState<{
    task: TaskDTO;
    acceptanceBlock: { status: string; done: number; total: number } | null;
    todoBlock: TodoSummary | null;
  } | null>(null);

  if (reviewTasks.length === 0 && !confirmPayload) return null;

  const proceedApprove = async (task: TaskDTO) => {
    setBusyTaskId(task.id);
    const result = await transitionTask(task.id, { to: 'completed', reason: 'Approved' });
    setBusyTaskId(null);
    if (!result.ok) {
      notify(result.message || 'Task approve failed', 'error');
      return;
    }
    setDecidedTaskIds((prev) => new Set(prev).add(task.id));
    notify('Task approved', 'success');
    await onTaskChanged?.();
  };

  const approve = async (task: TaskDTO) => {
    // release201/10 §4.4 + §0.2.3 — Two soft-gate conditions that surface
    // the confirm modal: acceptance not passed (existing) OR TODO < 80%
    // (new in S35). We MUST resolve TODO snapshot before deciding because
    // the user might have approved without ever looking at the drawer.
    const overall = task.acceptanceStatus ?? 'none';
    const total = task.acceptanceTotalCount ?? 0;
    const acceptanceBlocks = total > 0 && overall !== 'passed' && overall !== 'none';
    const acceptanceBlock = acceptanceBlocks
      ? { status: overall, done: task.acceptanceCompletedCount ?? 0, total }
      : null;

    // Cached fetch — same Map TodoSummaryChip uses, so a chip render +
    // approve click never duplicate the request.
    let todoSummary: TodoSummary | null = todoCache.get(task.id) ?? null;
    if (!todoCache.has(task.id)) {
      const res = await imFetch<TodoSummary>(`/tasks/${encodeURIComponent(task.id)}/todo`);
      todoSummary = res.ok ? (res.data ?? null) : null;
      todoCache.set(task.id, todoSummary);
    }
    const todoBlocks = todoSummary && todoSummary.totalCount > 0 && todoSummary.progressPct < 0.8;
    const todoBlock = todoBlocks ? todoSummary : null;

    if (acceptanceBlock || todoBlock) {
      setConfirmPayload({ task, acceptanceBlock, todoBlock });
      return;
    }
    await proceedApprove(task);
  };

  const submitReject = async (task: TaskDTO) => {
    const reason = rejectReason.trim();
    if (!reason) {
      // P6 §7.1 — reject must carry a reviewComment. Empty submit is a no-op,
      // not an error; keep the textarea open so the user can fill it in.
      notify('请填写驳回原因再提交', 'info');
      return;
    }
    setBusyTaskId(task.id);
    const result = await transitionTask(task.id, {
      to: 'assigned',
      reason: 'Rejected — needs rework',
      reviewComment: reason,
    });
    setBusyTaskId(null);
    if (!result.ok) {
      notify(result.message || 'Task reject failed', 'error');
      return;
    }
    setDecidedTaskIds((prev) => new Set(prev).add(task.id));
    setRejectingTaskId(null);
    setRejectReason('');
    notify('Task rejected', 'success');
    await onTaskChanged?.();
  };

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ type: 'spring', stiffness: 360, damping: 32, mass: 0.8 }}
        className={`mb-2 rounded-2xl border px-3 py-2.5 shadow-[0_18px_60px_-32px_rgba(124,58,237,0.35)] backdrop-blur-2xl ${
          isDark
            ? 'border-white/10 bg-white/[0.06]'
            : 'border-zinc-200/80 bg-white/72 supports-[backdrop-filter]:bg-white/58'
        }`}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {reviewTasks.length === 1 ? '1 task pending review' : `${reviewTasks.length} tasks pending review`}
          </p>
        </div>
        <div className="grid gap-1.5">
          {reviewTasks.slice(0, 3).map((task) => {
            const busy = busyTaskId === task.id;
            const isRejecting = rejectingTaskId === task.id;
            const acceptanceTotal = task.acceptanceTotalCount ?? 0;
            return (
              <div
                key={task.id}
                data-testid={`task-review-bar-card-${task.id}`}
                className={`min-w-0 rounded-xl border px-2.5 py-2 backdrop-blur-xl ${
                  isDark
                    ? 'border-white/10 bg-black/14'
                    : 'border-white/80 bg-white/72 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.45)]'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(task.id)}
                    className={`min-w-0 flex-1 truncate text-left text-xs font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
                    title={task.title}
                  >
                    {task.title}
                  </button>
                  {/* release201/10 §8.5 — TODO + Acceptance chips side by
                      side. Both are lazy / conditional: TODO renders only
                      when the task has at least one TODO.md item; the
                      acceptance chip only when criteria exist. */}
                  <TodoSummaryChip taskId={task.id} isDark={isDark} />
                  {acceptanceTotal > 0 ? (
                    <span
                      data-testid={`task-review-bar-acceptance-chip-${task.id}`}
                      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chipColour(
                        'acceptance',
                        0,
                        task.acceptanceStatus ?? 'none',
                        isDark,
                      )}`}
                      title={`Acceptance: ${task.acceptanceStatus ?? 'none'}`}
                    >
                      {task.acceptanceCompletedCount ?? 0}/{acceptanceTotal} acceptance
                    </span>
                  ) : null}
                  {onOpenTask ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(task.id)}
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        isDark
                          ? 'border-white/10 text-zinc-200 hover:bg-white/[0.06]'
                          : 'border-zinc-200 bg-white/70 text-zinc-600 hover:bg-zinc-50'
                      }`}
                      title="Open card"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                {isRejecting ? (
                  // Inline reject form — textarea + cancel/submit. Closes
                  // automatically after a successful submit (see submitReject).
                  <div className="mt-2 grid gap-1.5">
                    <textarea
                      autoFocus
                      rows={2}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="驳回原因(必填) — 告诉 assignee 需要补什么"
                      data-testid={`task-review-bar-reject-input-${task.id}`}
                      className={`w-full resize-none rounded-lg border px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-violet-400 ${
                        isDark
                          ? 'border-white/10 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600'
                          : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                      }`}
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRejectingTaskId(null);
                          setRejectReason('');
                        }}
                        data-testid={`task-review-bar-reject-cancel-${task.id}`}
                        className={`inline-flex h-8 min-w-0 flex-1 items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          isDark
                            ? 'border-white/10 text-zinc-300 hover:bg-white/[0.05]'
                            : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
                        }`}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={busy || rejectReason.trim().length === 0}
                        onClick={() => void submitReject(task)}
                        data-testid={`task-review-bar-reject-submit-${task.id}`}
                        className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-rose-500 dark:hover:bg-rose-400"
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                        <span>提交驳回</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={Boolean(busyTaskId)}
                      onClick={() => void approve(task)}
                      data-testid={`task-review-bar-approve-${task.id}`}
                      className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-2.5 text-xs font-semibold text-white shadow-sm shadow-violet-500/20 transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400"
                      title="Approve"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      <span>通过</span>
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busyTaskId)}
                      onClick={() => {
                        setRejectingTaskId(task.id);
                        setRejectReason('');
                      }}
                      data-testid={`task-review-bar-reject-${task.id}`}
                      className={`inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDark
                          ? 'border-white/10 text-zinc-200 hover:bg-white/[0.05]'
                          : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
                      }`}
                      title="Reject"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                      <span>驳回</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>

      {confirmPayload ? (
        <ForceApproveConfirm
          isDark={isDark}
          task={confirmPayload.task}
          acceptanceBlock={confirmPayload.acceptanceBlock}
          todoBlock={confirmPayload.todoBlock}
          onCancel={() => setConfirmPayload(null)}
          onConfirm={async () => {
            const t = confirmPayload.task;
            setConfirmPayload(null);
            await proceedApprove(t);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * release201/10 §0.2.3 — Force-approve confirm modal. Surfaces both blocking
 * conditions in one sheet so the reviewer makes an informed override.
 *
 * Uses an inline backdrop + portal-less dialog (matches the project's
 * existing modal aesthetic in task-card.tsx CardEditPopover). NOT
 * `window.confirm()` (10 doc §8.10 forbids it).
 */
function ForceApproveConfirm({
  isDark,
  task,
  acceptanceBlock,
  todoBlock,
  onCancel,
  onConfirm,
}: {
  isDark: boolean;
  task: TaskDTO;
  acceptanceBlock: { status: string; done: number; total: number } | null;
  todoBlock: TodoSummary | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div
      data-testid={`task-review-bar-confirm-${task.id}`}
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4"
    >
      <div
        className={`absolute inset-0 ${isDark ? 'bg-black/60' : 'bg-zinc-900/40'} backdrop-blur-sm`}
        onClick={onCancel}
        aria-hidden
      />
      <div
        className={`relative z-10 w-[440px] max-w-full rounded-2xl border p-5 shadow-2xl ${
          isDark ? 'border-white/10 bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`}
      >
        <h3 className="text-sm font-semibold">强制通过任务？</h3>
        <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          以下验收前置未达标。确认通过将作为 reviewer override 记录到审计日志（doc-10 §4.4 soft gate）。
        </p>
        <ul className="mt-3 space-y-1.5 text-xs">
          {todoBlock ? (
            <li
              data-testid={`task-review-bar-confirm-todo-${task.id}`}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${
                isDark ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              <span className="font-semibold">TODO</span>
              <span className="flex-1">
                完成度 {Math.round(todoBlock.progressPct * 100)}% （{todoBlock.doneCount}/{todoBlock.totalCount}）— 阈值
                80%
              </span>
            </li>
          ) : null}
          {acceptanceBlock ? (
            <li
              data-testid={`task-review-bar-confirm-acceptance-${task.id}`}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${
                isDark
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : 'border-amber-200 bg-amber-50 text-amber-700'
              }`}
            >
              <span className="font-semibold uppercase">Acceptance</span>
              <span className="flex-1">
                状态 {acceptanceBlock.status} ({acceptanceBlock.done}/{acceptanceBlock.total} verified)
              </span>
            </li>
          ) : null}
        </ul>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid={`task-review-bar-confirm-cancel-${task.id}`}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
              isDark
                ? 'border-white/10 text-zinc-300 hover:bg-white/[0.05]'
                : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            data-testid={`task-review-bar-confirm-force-${task.id}`}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400"
          >
            强制通过
          </button>
        </div>
      </div>
    </div>
  );
}

// Exported for test isolation — clears the in-process TODO cache so a
// fresh fetch fires after each test case.
export function __resetTodoCacheForTests(): void {
  todoCache.clear();
}
