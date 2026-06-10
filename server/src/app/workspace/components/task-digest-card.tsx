'use client';

/**
 * TaskDigestCard — release 200 §9 / P9.
 *
 * Renders the **one-per-task rolling digest** that the cloud writes into
 * the conversation timeline whenever a task transitions. Replaces the
 * pre-P9 per-event `task_status_event` chip with a single card that shows
 * the latest state and the most relevant operator action (Approve/Reject
 * when in review, Unblock when blocked, etc.).
 *
 * Pure presentational + thin action wiring — `transitionTask` is mocked in
 * tests via `vi.mock('../lib/mutations')`.
 *
 * Renderer contract (im-channel.tsx):
 *   - When `message.metadata.taskDigest` is present, dispatch to this
 *     component (skip the regular `MessageRow` + skip the legacy
 *     `TaskStatusEventRow`).
 *   - Pre-P9 system messages without `taskDigest` fall back to the legacy
 *     renderer for backward compat (they still surface as collapsed chips).
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ExternalLink,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { transitionTask } from '../lib/mutations';

export type TaskDigestStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'review'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Wave 3 §4.4.3 — `currentPhase` enum surfaced via task.phase.changed /
 * task.phase.stuck sync events. Disjoint from `TaskDigestStatus` (§12.4
 * invariant: reaper writes phase only, never status).
 *
 * `null`-equivalent: omit the prop / pass `undefined` so PhaseBadge collapses.
 */
export type AgentTaskPhase =
  | 'assigned'
  | 'thinking'
  | 'tool_use'
  | 'reasoning'
  | 'responding'
  | 'waiting_user'
  | 'waiting_dep'
  | 'stuck';

interface PhaseBadgeProps {
  phase?: AgentTaskPhase | null;
  /** Render `tool_use` with the specific tool name when daemon reported it. */
  lastStep?: { toolName?: string | null } | null;
  isDark: boolean;
}

/**
 * Wave 3 §4.4.3 — small inline badge that maps `currentPhase` to glyph +
 * label. Returns `null` for unknown / missing phases so callers can drop
 * it in unconditionally.
 */
export function PhaseBadge({ phase, lastStep, isDark }: PhaseBadgeProps): React.ReactElement | null {
  if (!phase) return null;
  const mapping: Record<AgentTaskPhase, { label: string; tone: 'blue' | 'lightBlue' | 'amber' | 'gray' }> = {
    assigned: { label: '已分配', tone: 'gray' },
    thinking: { label: '思考中', tone: 'blue' },
    tool_use: {
      label: lastStep?.toolName ? `调用 ${lastStep.toolName}` : '调用工具',
      tone: 'blue',
    },
    reasoning: { label: '推理中', tone: 'lightBlue' },
    responding: { label: '生成回复', tone: 'blue' },
    waiting_user: { label: '等待用户', tone: 'amber' },
    waiting_dep: { label: '等依赖', tone: 'gray' },
    stuck: { label: '无响应 >45s', tone: 'amber' },
  };
  const meta = mapping[phase];
  if (!meta) return null;
  const palette = (() => {
    if (meta.tone === 'amber') {
      return isDark ? 'border-amber-300/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800';
    }
    if (meta.tone === 'gray') {
      return isDark ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-200' : 'border-zinc-200 bg-zinc-50 text-zinc-700';
    }
    if (meta.tone === 'lightBlue') {
      return isDark ? 'border-sky-300/30 bg-sky-500/10 text-sky-100' : 'border-sky-200 bg-sky-50 text-sky-700';
    }
    return isDark ? 'border-blue-300/30 bg-blue-500/10 text-blue-100' : 'border-blue-200 bg-blue-50 text-blue-800';
  })();
  return (
    <span
      data-testid={`phase-badge-${phase}`}
      data-phase={phase}
      title={phase === 'stuck' ? '设备可能离线' : meta.label}
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium ${palette}`}
    >
      <span className="max-w-[12rem] truncate">{meta.label}</span>
    </span>
  );
}

interface StuckWarningProps {
  /** ISO timestamp of last accepted heartbeat (may be `null` if never started). */
  lastHeartbeatAt?: string | null;
  isDark: boolean;
  busy?: 'retry' | 'fail' | null;
  /** Triggered by "重试 dispatch" — caller decides backend wiring. */
  onRetry?: () => void | Promise<void>;
  /** Triggered by "标记失败" — must route through force-transition L0/L1. */
  onMarkFailed?: () => void | Promise<void>;
}

/**
 * Wave 3 §4.4.6 — yellow warning bar shown when `currentPhase === 'stuck'`.
 * Always renders the two operator actions so the user knows the system is
 * aware (fail-soft, not "silently stuck").
 */
export function StuckWarning({ lastHeartbeatAt, isDark, busy, onRetry, onMarkFailed }: StuckWarningProps): React.ReactElement {
  const seconds = (() => {
    if (!lastHeartbeatAt) return null;
    const t = Date.parse(lastHeartbeatAt);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.round((Date.now() - t) / 1000));
  })();
  const message =
    seconds == null
      ? 'agent 长时间未响应,设备可能离线'
      : `agent 已 ${seconds} 秒无响应,设备可能离线`;
  return (
    <div
      data-testid="stuck-warning"
      className={`mb-1.5 rounded-lg border px-2 py-1.5 text-[11px] ${
        isDark ? 'border-amber-300/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
        <p className="min-w-0 flex-1 font-medium">{message}</p>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void onRetry?.()}
          data-testid="stuck-warning-retry"
          className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            isDark ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30' : 'bg-amber-200/70 text-amber-900 hover:bg-amber-200'
          }`}
        >
          {busy === 'retry' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span>重试 dispatch</span>
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void onMarkFailed?.()}
          data-testid="stuck-warning-fail"
          className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            isDark ? 'border-white/10 text-zinc-200 hover:bg-white/[0.05]' : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
          }`}
        >
          {busy === 'fail' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          <span>标记失败</span>
        </button>
      </div>
    </div>
  );
}

export interface TaskDigestPayload {
  taskId: string;
  taskTitle: string;
  status: TaskDigestStatus;
  previousStatus?: TaskDigestStatus | null;
  latestTransition?: {
    from: TaskDigestStatus | null;
    to: TaskDigestStatus;
    by?: string | null;
    reason?: string | null;
    at: string;
  };
  creatorId?: string;
  assigneeId?: string | null;
  workspaceId?: string | null;
  error?: string | null;
  outputPreview?: string | null;
  /**
   * B-line (release201/3x) — count of task-bound deliverable assets this run
   * produced (markdown docs, office files, charts, …). When `> 0` the
   * completed digest card renders a compact "N 个产物 →" chip that routes to
   * the drawer Artifacts tab. The full output lives there — chat shows only a
   * teaser, never the inline body. Zero / absent ⇒ no chip (zero-noise).
   */
  resultAssetCount?: number | null;
  /** Up to a few lightweight refs to label the chip (filename teaser). */
  resultAssets?: { assetId: string; filename?: string | null; mime?: string | null }[] | null;
  /**
   * Wave 3 §4.4.3 — phase signal (disjoint from `status`). Sourced from
   * `task.phase.changed` / `task.phase.stuck` SSE events. Null when no
   * heartbeat has been received yet.
   */
  phase?: AgentTaskPhase | null;
  /** Last tool step daemon reported — feeds PhaseBadge `tool_use` label. */
  lastStep?: { toolName?: string | null } | null;
  /** Last heartbeat ISO timestamp — drives StuckWarning copy. */
  lastHeartbeatAt?: string | null;
}

function statusLabel(status: TaskDigestStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'assigned':
      return 'Assigned';
    case 'running':
      return 'Running';
    case 'review':
      return 'In Review';
    case 'blocked':
      return 'Blocked';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function statusIcon(status: TaskDigestStatus) {
  switch (status) {
    case 'completed':
      return CheckCircle2;
    case 'failed':
      return XCircle;
    case 'cancelled':
      return Ban;
    case 'review':
      return Search;
    case 'blocked':
      return AlertTriangle;
    case 'running':
      return Play;
    default:
      return Play;
  }
}

function statusPalette(status: TaskDigestStatus, isDark: boolean): string {
  if (status === 'completed') {
    return isDark
      ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  if (status === 'failed') {
    return isDark
      ? 'border-rose-300/30 bg-rose-500/10 text-rose-100'
      : 'border-rose-200 bg-rose-50 text-rose-800';
  }
  if (status === 'cancelled') {
    return isDark
      ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-200'
      : 'border-zinc-200 bg-zinc-50 text-zinc-700';
  }
  if (status === 'review') {
    return isDark
      ? 'border-amber-300/30 bg-amber-500/10 text-amber-100'
      : 'border-amber-200 bg-amber-50 text-amber-800';
  }
  if (status === 'blocked') {
    return isDark
      ? 'border-orange-300/30 bg-orange-500/10 text-orange-100'
      : 'border-orange-200 bg-orange-50 text-orange-800';
  }
  if (status === 'running') {
    return isDark
      ? 'border-violet-300/30 bg-violet-500/10 text-violet-100'
      : 'border-violet-200 bg-violet-50 text-violet-800';
  }
  return isDark
    ? 'border-cyan-300/30 bg-cyan-500/10 text-cyan-100'
    : 'border-cyan-200 bg-cyan-50 text-cyan-800';
}

/**
 * Map a deliverable's mime / filename to a lucide file glyph so a multi-file
 * product list reads at a glance (doc vs image vs sheet vs code vs binary).
 */
function fileIconFor(mime?: string | null, filename?: string | null) {
  const m = (mime ?? '').toLowerCase();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return FileImage;
  if (m.includes('csv') || m.includes('spreadsheet') || ['csv', 'xlsx', 'xls', 'tsv'].includes(ext)) return FileSpreadsheet;
  if (
    m.includes('json') ||
    m.includes('javascript') ||
    ['json', 'js', 'ts', 'tsx', 'py', 'go', 'rs', 'patch', 'diff', 'sh', 'yaml', 'yml'].includes(ext)
  )
    return FileCode;
  if (m.startsWith('text/') || ['md', 'markdown', 'txt'].includes(ext)) return FileText;
  return File;
}

/** A lightweight deliverable ref — shared by the payload teaser and the
 *  live authoritative list returned by `resolveTaskAssets`. */
export interface TaskDigestAssetRef {
  assetId: string;
  filename?: string | null;
  mime?: string | null;
}

/** How many product rows the card renders inline before collapsing into the
 *  "查看全部 N 个产物" overflow row that routes to the drawer. */
const PRODUCT_LIST_VISIBLE_LIMIT = 8;

interface TaskDigestCardProps {
  digest: TaskDigestPayload;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
  /**
   * B-line (WS1) — live authoritative deliverable resolver. When provided and
   * the card is `completed` with `resultAssetCount > 0`, the card fetches the
   * task-bound assets ONCE on mount (no polling) and overlays the result on
   * top of the payload teaser. The payload `resultAssets` are the instant
   * first-paint fallback (no flicker); the resolver result — which includes
   * late-arriving / orphaned files the completion snapshot missed — becomes
   * the authoritative list once it returns. Resolver failure / absence ⇒ the
   * card silently keeps the payload teaser. The caller (im-channel) wires this
   * to a targeted `/assets?workspaceId=X&taskId=Y&limit=50` fetch — targeted,
   * NOT a filter over the workspace-level 100-cap assets list (drawer坑
   * 2026-05-23).
   */
  resolveTaskAssets?: (taskId: string) => Promise<TaskDigestAssetRef[]>;
  /**
   * Open a specific deliverable asset (workspace inspector). When provided,
   * each product row in the completed card routes to its own asset; when
   * absent, rows fall back to opening the task drawer Artifacts tab.
   */
  onOpenAsset?: (assetId: string) => void;
  /** Notify the parent so other surfaces (task board / review bar) refresh. */
  onTaskChanged?: () => void | Promise<void>;
  /** Lightweight toast hook — defaults to console.warn when absent. */
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
  /**
   * Wave 3 §4.4.6 — invoked when user clicks "重试 dispatch" on the
   * StuckWarning bar. When omitted, the button is still rendered but no-ops
   * (caller decides whether/how to wire to the cloud retry endpoint).
   */
  onRetryDispatch?: (taskId: string) => void | Promise<void>;
}

export function TaskDigestCard({ digest, isDark, onOpenTask, onOpenAsset, onTaskChanged, notify, onRetryDispatch, resolveTaskAssets }: TaskDigestCardProps) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'unblock'>(null);
  const [stuckBusy, setStuckBusy] = useState<'retry' | 'fail' | null>(null);
  // Inline reject reason — mirrors the TaskReviewBar pattern so the user
  // never sees an unstyled `window.prompt`. Only the digest card whose
  // status is currently `review` has a reject form.
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // B-line (WS1) — live authoritative deliverable list. Starts null (payload
  // teaser is shown); once the resolver returns it overlays the payload. Kept
  // null on failure so we fall back to the payload teaser.
  const [liveAssets, setLiveAssets] = useState<TaskDigestAssetRef[] | null>(null);

  const claimsArtifacts = digest.status === 'completed' && (digest.resultAssetCount ?? 0) > 0;

  // Performance guard: only completed cards that *claim* deliverables fetch,
  // and only once per mount (keyed on taskId, no polling). Running cards / cards
  // with no products never touch the network. Loading is silent — the payload
  // teaser is already painted, so there is nothing to spin on.
  useEffect(() => {
    if (!resolveTaskAssets || !claimsArtifacts) {
      setLiveAssets(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const refs = await resolveTaskAssets(digest.taskId);
        if (!cancelled && Array.isArray(refs) && refs.length > 0) setLiveAssets(refs);
      } catch {
        // Keep payload fallback on failure — no toast (the snapshot is still
        // a usable approximation; surfacing a transient fetch error here would
        // be noise on an otherwise-complete card).
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digest.taskId, claimsArtifacts, resolveTaskAssets]);

  const palette = statusPalette(digest.status, isDark);
  const Icon = statusIcon(digest.status);
  const titleText = digest.taskTitle || digest.taskId.slice(-8);
  const label = statusLabel(digest.status);

  const showApprove = digest.status === 'review';
  const showUnblock = digest.status === 'blocked';
  const hasActions = showApprove || showUnblock;

  const tell = (m: string, t: 'success' | 'error' | 'info') => {
    if (notify) notify(m, t);
    else if (t === 'error') console.warn('[TaskDigestCard]', m);
  };

  const approve = async () => {
    setBusy('approve');
    const result = await transitionTask(digest.taskId, { to: 'completed', reason: 'Approved' });
    setBusy(null);
    if (!result.ok) {
      tell(result.message || 'Task approve failed', 'error');
      return;
    }
    tell('Task approved', 'success');
    await onTaskChanged?.();
  };

  const submitReject = async () => {
    const reason = rejectReason.trim();
    if (!reason) {
      tell('请填写驳回原因再提交', 'info');
      return;
    }
    setBusy('reject');
    const result = await transitionTask(digest.taskId, {
      to: 'assigned',
      reason: 'Rejected — needs rework',
      reviewComment: reason,
    });
    setBusy(null);
    if (!result.ok) {
      tell(result.message || 'Task reject failed', 'error');
      return;
    }
    setRejecting(false);
    setRejectReason('');
    tell('Task rejected', 'success');
    await onTaskChanged?.();
  };

  const unblock = async () => {
    setBusy('unblock');
    const result = await transitionTask(digest.taskId, { to: 'running', reason: 'Unblocked' });
    setBusy(null);
    if (!result.ok) {
      tell(result.message || 'Unblock failed', 'error');
      return;
    }
    tell('Task unblocked', 'success');
    await onTaskChanged?.();
  };

  // Wave 3 §4.4.6 — stuck-warning actions. "重试 dispatch" delegates to the
  // parent if it knows how to retry; "标记失败" reuses the existing
  // transitionTask path (status: failed) which the server gates on L0/L1
  // via the standard force-transition permission check.
  const retryDispatch = async () => {
    setStuckBusy('retry');
    try {
      if (onRetryDispatch) {
        await onRetryDispatch(digest.taskId);
        tell('已请求重试 dispatch', 'info');
      } else {
        tell('重试 dispatch 暂未配置', 'info');
      }
    } finally {
      setStuckBusy(null);
    }
  };

  const markFailed = async () => {
    setStuckBusy('fail');
    const result = await transitionTask(digest.taskId, { to: 'failed', reason: 'Marked failed from stuck warning' });
    setStuckBusy(null);
    if (!result.ok) {
      tell(result.message || 'Mark failed unauthorized — needs L0/L1 force-transition', 'error');
      return;
    }
    tell('Task marked failed', 'success');
    await onTaskChanged?.();
  };

  return (
    <div
      className="my-2 flex w-full justify-center"
      data-testid={`task-digest-card-${digest.taskId}`}
      data-status={digest.status}
    >
      <div
        className={`max-w-[90%] min-w-0 rounded-2xl border px-3 py-2 text-xs font-medium backdrop-blur ${palette}`}
      >
        {digest.phase === 'stuck' ? (
          <StuckWarning
            lastHeartbeatAt={digest.lastHeartbeatAt}
            isDark={isDark}
            busy={stuckBusy}
            onRetry={retryDispatch}
            onMarkFailed={markFailed}
          />
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.6} />
          <span className="shrink-0 font-semibold">{label}:</span>
          <button
            type="button"
            onClick={() => onOpenTask?.(digest.taskId)}
            disabled={!onOpenTask}
            className="min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
            title={`Open task ${titleText}`}
          >
            {titleText}
          </button>
          {digest.phase ? (
            <PhaseBadge phase={digest.phase} lastStep={digest.lastStep} isDark={isDark} />
          ) : null}
          {onOpenTask ? (
            <button
              type="button"
              onClick={() => onOpenTask(digest.taskId)}
              data-testid={`task-digest-card-open-${digest.taskId}`}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-current/20 transition-colors hover:bg-current/10"
              title="Open card"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {digest.status === 'failed' && digest.error ? (
          <p className="mt-1.5 text-[11px] opacity-80">· {digest.error}</p>
        ) : null}
        {digest.status === 'blocked' && (digest.latestTransition?.reason || digest.error) ? (
          <p className="mt-1.5 text-[11px] opacity-80">· {digest.latestTransition?.reason ?? digest.error}</p>
        ) : null}
        {/* B-line — completed deliverables surface as a PRODUCT FILE LIST, not
            inline prose. A task can emit several files; each is its own row
            (type glyph + filename) routing to that asset. The digest payload
            carries up to 4 lightweight refs (teaser); when the run produced
            more, an overflow row opens the drawer Artifacts tab for the full
            set. Full file content lives in the asset, never echoed into chat.
            No assets ⇒ nothing (zero-noise). */}
        {claimsArtifacts
          ? (() => {
              // Live list (resolver) is authoritative once it lands — it
              // includes late-arriving / orphaned files the completion snapshot
              // missed. Until then, the payload teaser is the instant
              // first-paint fallback. `count` reflects the authoritative source:
              // live length when live, else the payload's declared count.
              const live = liveAssets;
              const count = live ? live.length : digest.resultAssetCount ?? 0;
              const allRefs = live ?? digest.resultAssets ?? [];
              const refs = allRefs.slice(0, PRODUCT_LIST_VISIBLE_LIMIT);
              const rowClass = isDark
                ? 'border-white/10 bg-zinc-950/40 text-zinc-200 hover:bg-white/[0.06]'
                : 'border-black/[0.08] bg-white/70 text-zinc-700 hover:bg-zinc-100';

              // Refs missing (lookup degraded to count-only) — single summary
              // chip routing to the drawer, preserving the prior affordance.
              if (refs.length === 0) {
                return (
                  <button
                    type="button"
                    onClick={() => onOpenTask?.(digest.taskId)}
                    disabled={!onOpenTask}
                    data-testid={`task-digest-card-artifacts-${digest.taskId}`}
                    data-asset-count={count}
                    title="在任务详情查看产物"
                    className={`mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-default ${rowClass}`}
                  >
                    <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                    <span className="min-w-0 truncate">{count} 个产物</span>
                    <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={1.6} />
                  </button>
                );
              }

              const remaining = count - refs.length;
              return (
                <div
                  className="mt-2 grid gap-1"
                  data-testid={`task-digest-card-artifacts-${digest.taskId}`}
                  data-asset-count={count}
                >
                  <div className={`text-[10px] font-semibold uppercase tracking-wide ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {count} 个产物
                  </div>
                  {refs.map((a) => {
                    const Icon = fileIconFor(a.mime, a.filename);
                    const open = onOpenAsset
                      ? () => onOpenAsset(a.assetId)
                      : onOpenTask
                        ? () => onOpenTask(digest.taskId)
                        : undefined;
                    return (
                      <button
                        key={a.assetId}
                        type="button"
                        onClick={open}
                        disabled={!open}
                        data-testid={`task-digest-card-artifact-${a.assetId}`}
                        title={a.filename || a.assetId}
                        className={`flex w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-default ${rowClass}`}
                      >
                        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                        <span className="min-w-0 flex-1 truncate text-left">{a.filename || a.assetId}</span>
                        <ArrowRight aria-hidden className="h-3 w-3 shrink-0 opacity-50" strokeWidth={1.6} />
                      </button>
                    );
                  })}
                  {remaining > 0 && onOpenTask ? (
                    <button
                      type="button"
                      onClick={() => onOpenTask(digest.taskId)}
                      data-testid={`task-digest-card-artifacts-more-${digest.taskId}`}
                      className={`flex w-full items-center justify-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-medium opacity-70 transition-opacity hover:opacity-100 ${
                        isDark ? 'text-zinc-400' : 'text-zinc-500'
                      }`}
                    >
                      查看全部 {count} 个产物
                      <ArrowRight aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.6} />
                    </button>
                  ) : null}
                </div>
              );
            })()
          : null}
        {hasActions && !rejecting ? (
          <div className="mt-2 flex items-center gap-1.5">
            {showApprove ? (
              <>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void approve()}
                  data-testid={`task-digest-card-approve-${digest.taskId}`}
                  className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400"
                >
                  {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  <span>通过</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setRejecting(true);
                    setRejectReason('');
                  }}
                  data-testid={`task-digest-card-reject-${digest.taskId}`}
                  className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isDark
                      ? 'border-white/10 text-zinc-200 hover:bg-white/[0.05]'
                      : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  <X className="h-3.5 w-3.5" />
                  <span>驳回</span>
                </button>
              </>
            ) : null}
            {showUnblock ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void unblock()}
                data-testid={`task-digest-card-unblock-${digest.taskId}`}
                className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-orange-600 px-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-400"
              >
                {busy === 'unblock' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                <span>恢复执行</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {rejecting ? (
          <div className="mt-2 grid gap-1.5">
            <textarea
              autoFocus
              rows={2}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="驳回原因(必填) — 告诉 assignee 需要补什么"
              data-testid={`task-digest-card-reject-input-${digest.taskId}`}
              className={`w-full resize-none rounded-lg border px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-violet-400 ${
                isDark
                  ? 'border-white/10 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600'
                  : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
              }`}
            />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy === 'reject'}
                onClick={() => {
                  setRejecting(false);
                  setRejectReason('');
                }}
                data-testid={`task-digest-card-reject-cancel-${digest.taskId}`}
                className={`inline-flex h-7 flex-1 items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isDark
                    ? 'border-white/10 text-zinc-300 hover:bg-white/[0.05]'
                    : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy === 'reject' || rejectReason.trim().length === 0}
                onClick={() => void submitReject()}
                data-testid={`task-digest-card-reject-submit-${digest.taskId}`}
                className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-rose-500 dark:hover:bg-rose-400"
              >
                {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                <span>提交驳回</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Best-effort parser. Returns `null` for messages that are not a P9 digest;
 * callers fall back to the legacy `TaskStatusEventRow` renderer for those.
 */
export function readTaskDigestPayload(metadata: unknown): TaskDigestPayload | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const meta = metadata as Record<string, unknown>;
  const digestKindOk = meta.digestKind === 'task_digest' || meta.kind === 'task_digest';
  if (!digestKindOk) return null;
  const td = (meta.taskDigest && typeof meta.taskDigest === 'object'
    ? (meta.taskDigest as Record<string, unknown>)
    : null) ?? meta;
  const taskId = typeof td.taskId === 'string' ? td.taskId : '';
  if (!taskId) return null;
  const status = typeof td.status === 'string' ? (td.status as TaskDigestStatus) : null;
  if (!status) return null;
  const validStatuses: TaskDigestStatus[] = [
    'pending',
    'assigned',
    'running',
    'review',
    'blocked',
    'completed',
    'failed',
    'cancelled',
  ];
  if (!validStatuses.includes(status)) return null;
  const taskTitle = typeof td.taskTitle === 'string' ? td.taskTitle : '';
  const errorRaw = td.error ?? meta.error;
  const error = typeof errorRaw === 'string' ? errorRaw : null;
  const latestTransition =
    td.latestTransition && typeof td.latestTransition === 'object'
      ? (td.latestTransition as TaskDigestPayload['latestTransition'])
      : undefined;
  const previousStatus =
    typeof td.previousStatus === 'string' ? (td.previousStatus as TaskDigestStatus) : null;
  const validPhases: AgentTaskPhase[] = [
    'assigned',
    'thinking',
    'tool_use',
    'reasoning',
    'responding',
    'waiting_user',
    'waiting_dep',
    'stuck',
  ];
  const rawPhase = typeof td.phase === 'string' ? td.phase : null;
  const phase = rawPhase && validPhases.includes(rawPhase as AgentTaskPhase) ? (rawPhase as AgentTaskPhase) : null;
  const lastStepRaw = td.lastStep && typeof td.lastStep === 'object' ? (td.lastStep as Record<string, unknown>) : null;
  const lastStep = lastStepRaw && typeof lastStepRaw.toolName === 'string' ? { toolName: lastStepRaw.toolName } : null;
  const lastHeartbeatAt = typeof td.lastHeartbeatAt === 'string' ? td.lastHeartbeatAt : null;
  const resultAssetCount =
    typeof td.resultAssetCount === 'number' && Number.isFinite(td.resultAssetCount) && td.resultAssetCount > 0
      ? Math.floor(td.resultAssetCount)
      : null;
  const resultAssets = Array.isArray(td.resultAssets)
    ? (td.resultAssets as unknown[])
        .map((a) => {
          if (!a || typeof a !== 'object') return null;
          const ref = a as Record<string, unknown>;
          const assetId = typeof ref.assetId === 'string' ? ref.assetId : '';
          if (!assetId) return null;
          return {
            assetId,
            filename: typeof ref.filename === 'string' ? ref.filename : null,
            mime: typeof ref.mime === 'string' ? ref.mime : null,
          };
        })
        .filter((a): a is { assetId: string; filename: string | null; mime: string | null } => a !== null)
    : null;
  return {
    taskId,
    taskTitle,
    status,
    previousStatus,
    latestTransition,
    creatorId: typeof td.creatorId === 'string' ? td.creatorId : undefined,
    assigneeId: typeof td.assigneeId === 'string' ? td.assigneeId : null,
    workspaceId: typeof td.workspaceId === 'string' ? td.workspaceId : null,
    error,
    outputPreview: typeof td.outputPreview === 'string' ? td.outputPreview : null,
    resultAssetCount,
    resultAssets: resultAssets && resultAssets.length > 0 ? resultAssets : null,
    phase,
    lastStep,
    lastHeartbeatAt,
  };
}
