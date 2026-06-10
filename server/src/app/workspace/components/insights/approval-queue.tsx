'use client';

/**
 * InsightsApprovalQueue — pending approvals rendered inline alongside the
 * visualization cards so the user can see workspace state AND clear the
 * approval backlog from a single surface.
 *
 * Each row is one approval. Approve = single primary action (one intent,
 * one affordance — `feedback-one-intent-one-affordance` memory). Reject
 * collapses into a reason input; we always require a "why" because the
 * person who acted needs to leave a note for the requester.
 *
 * No backdrop, no bottom sheet — this is an embedded section, not a chat
 * overlay (the `ApprovalCard` component in workspace/components/ is for
 * the chat-composer use case and stays separate).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Clock3, Inbox, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { decideApproval, listApprovals } from '../../lib/mutations';
import type { ApprovalDTO } from '../../lib/types';

interface ApprovalQueueProps {
  isDark: boolean;
  workspaceId: string | null;
  refreshNonce?: number;
  notify?: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

type RejectingState = { id: string; reason: string } | null;

export function InsightsApprovalQueue({ isDark, workspaceId, refreshNonce, notify }: ApprovalQueueProps) {
  const [items, setItems] = useState<ApprovalDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RejectingState>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      return;
    }
    setLoading(true);
    const res = await listApprovals({ workspaceId, status: 'pending' });
    if (res.ok && res.data) {
      setItems(res.data.filter((a) => a.status === 'pending'));
    } else if (!res.ok) {
      setItems([]);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  const approve = useCallback(
    async (approval: ApprovalDTO) => {
      const approveOption =
        approval.options.find((o) => o.value === 'approve') ??
        approval.options.find((o) => o.value === 'approved') ??
        approval.options.find((o) => o.value === 'yes') ??
        approval.options[0];
      if (!approveOption) {
        notify?.('没有可用的通过选项', 'error');
        return;
      }
      setBusyId(approval.id);
      const res = await decideApproval(approval.id, approveOption.value);
      setBusyId(null);
      if (res.ok) {
        notify?.('已通过', 'success');
        await load();
      } else {
        notify?.(res.message ?? '通过失败', 'error');
      }
    },
    [load, notify],
  );

  const reject = useCallback(
    async (approval: ApprovalDTO, reason: string) => {
      const rejectOption =
        approval.options.find((o) => o.value === 'reject') ??
        approval.options.find((o) => o.value === 'rejected') ??
        approval.options.find((o) => o.value === 'no') ??
        approval.options[1] ??
        approval.options[0];
      if (!rejectOption) {
        notify?.('没有可用的驳回选项', 'error');
        return;
      }
      setBusyId(approval.id);
      const res = await decideApproval(approval.id, rejectOption.value, reason);
      setBusyId(null);
      setRejecting(null);
      if (res.ok) {
        notify?.('已驳回', 'success');
        await load();
      } else {
        notify?.(res.message ?? '驳回失败', 'error');
      }
    },
    [load, notify],
  );

  return (
    <section
      data-testid="insights-approval-queue"
      className={`flex h-full min-h-0 flex-col rounded-2xl border ${
        isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/85'
      }`}
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200/80'}`}>
        <div className="min-w-0">
          <h3 className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            待审批
          </h3>
          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            看 + 做完，统一在此
          </p>
        </div>
        {items.length > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {items.length}
          </Badge>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && items.length === 0 ? (
          <Skeleton isDark={isDark} />
        ) : items.length === 0 ? (
          <EmptyState isDark={isDark} />
        ) : (
          <ul className="space-y-2">
            {items.map((approval) => (
              <ApprovalRow
                key={approval.id}
                isDark={isDark}
                approval={approval}
                busy={busyId === approval.id}
                rejecting={rejecting?.id === approval.id ? rejecting : null}
                onApprove={() => void approve(approval)}
                onStartReject={() => setRejecting({ id: approval.id, reason: '' })}
                onCancelReject={() => setRejecting(null)}
                onChangeReason={(reason) => setRejecting({ id: approval.id, reason })}
                onConfirmReject={() =>
                  rejecting?.reason.trim() ? void reject(approval, rejecting.reason.trim()) : void 0
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function ApprovalRow({
  isDark,
  approval,
  busy,
  rejecting,
  onApprove,
  onStartReject,
  onCancelReject,
  onChangeReason,
  onConfirmReject,
}: {
  isDark: boolean;
  approval: ApprovalDTO;
  busy: boolean;
  rejecting: { id: string; reason: string } | null;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onChangeReason: (reason: string) => void;
  onConfirmReject: () => void;
}) {
  const urgency = useMemo(() => urgencyForExpiry(approval.expiresAt), [approval.expiresAt]);
  const [contextOpen, setContextOpen] = useState(false);

  return (
    <li
      data-testid="approval-queue-row"
      data-approval-id={approval.id}
      className={`rounded-xl border ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200/80 bg-white'
      }`}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${urgency.dot}`}
          aria-hidden
          title={urgency.label}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className={`truncate text-[13px] font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {approval.title}
            </p>
            <span className={`shrink-0 text-[10px] tabular-nums ${urgency.text}`}>{urgency.label}</span>
          </div>
          <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            <span className="font-mono">{approval.category}</span>
            {approval.requestedByName ? ` · ${approval.requestedByName}` : null}
            {' · '}
            {formatAge(approval.createdAt)}
          </p>

          {approval.context ? (
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              className={`mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium ${
                isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${contextOpen ? 'rotate-180' : ''}`} />
              {contextOpen ? '收起上下文' : '查看上下文'}
            </button>
          ) : null}
          {contextOpen && approval.context ? (
            <p
              className={`mt-1 whitespace-pre-wrap text-[11px] leading-relaxed ${
                isDark ? 'text-zinc-400' : 'text-zinc-600'
              }`}
            >
              {approval.context}
            </p>
          ) : null}
        </div>
      </div>

      {rejecting ? (
        <div className={`border-t px-3 py-2 ${isDark ? 'border-white/[0.05]' : 'border-zinc-200/80'}`}>
          <textarea
            value={rejecting.reason}
            onChange={(e) => onChangeReason(e.target.value)}
            placeholder="驳回原因（必填）"
            autoFocus
            rows={2}
            className={`w-full resize-none rounded-lg border px-2 py-1.5 text-[12px] outline-none ${
              isDark
                ? 'border-white/[0.08] bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600 focus:border-rose-400/50'
                : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400 focus:border-rose-500'
            }`}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button variant="ghost" size="xs" onClick={onCancelReject} disabled={busy}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={onConfirmReject}
              disabled={busy || !rejecting.reason.trim()}
              data-testid="approval-queue-reject-confirm"
            >
              {busy ? <Loader2 className="animate-spin" /> : <X />}
              驳回
            </Button>
          </div>
        </div>
      ) : (
        <div className={`flex items-center justify-end gap-1.5 border-t px-3 py-2 ${isDark ? 'border-white/[0.05]' : 'border-zinc-200/80'}`}>
          <Button
            variant="ghost"
            size="xs"
            onClick={onStartReject}
            disabled={busy}
            data-testid="approval-queue-reject"
          >
            驳回
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={onApprove}
            disabled={busy}
            data-testid="approval-queue-approve"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            通过
          </Button>
        </div>
      )}
    </li>
  );
}

function EmptyState({ isDark }: { isDark: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
      <Inbox className={`h-6 w-6 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
      <p className={`mt-2 text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
        没有待审批的事项
      </p>
      <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        所有需要人决策的项都已处理
      </p>
    </div>
  );
}

function Skeleton({ isDark }: { isDark: boolean }) {
  return (
    <ul className="space-y-2">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className={`h-20 rounded-xl ${isDark ? 'bg-white/[0.03]' : 'bg-zinc-100/70'}`}
          aria-hidden
        />
      ))}
    </ul>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function urgencyForExpiry(expiresAt: string | null): { dot: string; text: string; label: string } {
  if (!expiresAt) return { dot: 'bg-zinc-400', text: 'text-zinc-500', label: '' };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return { dot: 'bg-zinc-400', text: 'text-zinc-500', label: '' };
  if (ms < 0) return { dot: 'bg-rose-500', text: 'text-rose-500', label: 'overdue' };
  if (ms < 30 * 60_000) return { dot: 'bg-rose-500', text: 'text-rose-500', label: `${Math.ceil(ms / 60_000)}m` };
  if (ms < 2 * 3_600_000) return { dot: 'bg-amber-500', text: 'text-amber-500', label: `${Math.ceil(ms / 60_000)}m` };
  if (ms < 8 * 3_600_000)
    return { dot: 'bg-sky-500', text: 'text-sky-500', label: `${Math.ceil(ms / 3_600_000)}h` };
  return { dot: 'bg-emerald-500', text: 'text-emerald-500', label: `${Math.ceil(ms / 3_600_000)}h` };
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// re-export icons used in stubs for future test discovery
export { Clock3 };
