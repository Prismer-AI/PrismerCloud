'use client';

/**
 * ApprovalCard — release 200 §4.4.8 redo (Wave 3 C3).
 *
 * Before: 3 pending approvals → ~300px of vertical real estate above the
 *   composer (screenshot evidence 2026-05-21, COO workgroup).
 * After:
 *   - Default state: 32px collapsed banner — count + soonest-expiring hint.
 *   - Expanded state: bottom sheet (covers the upper half of the chat
 *     scroll region, never compresses the composer).
 *   - Urgency colour-coded (🔴 <30m / ⚠️ <2h / ⏳ <8h / 🕐 ≥8h).
 *   - Approve is single-click (one intent, one affordance — user memory
 *     `feedback_one_intent_one_affordance.md`). Reject still uses an
 *     inline reason-required input because we need the human's "why",
 *     not because we doubt the click.
 *   - If two pending approvals share an `intentHash`, second one shows
 *     "Similar to above — dedup proposed" + sheet footer offers
 *     "Approve all similar (N)" batch action.
 *
 * `intentHash` is part of ApprovalDTO (migration 411 added the column),
 * but the service-side compute is deferred (Wave 3.5 hand-off). When the
 * field is null on every row, the dedup UI silently disappears.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { CheckCircle2, ChevronUp, Clock3, Loader2, XCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { decideApproval, listApprovals } from '../lib/mutations';
import type { ApprovalDTO } from '../lib/types';
import { imFetch } from '../lib/im-api';

// release201/08 §9.2.1 + release201/13 §3.3 (S22): when the skill-publish
// variant is mounted inside `/evolution → Studio`, render the 9-section
// EvidencePanel via this lazy wrapper. The component lives in evolution to
// avoid pulling the entire Studio module graph into the workspace bundle.
const ApprovalCardSkillPublish = dynamic(
  () =>
    import('@/app/evolution/components/studio/lifecycle/approval-card-skill-publish').then(
      (m) => m.ApprovalCardSkillPublish,
    ),
  { ssr: false },
);

interface ApprovalCardProps {
  isDark: boolean;
  workspaceId?: string | null;
  conversationId?: string | null;
  refreshKey?: number;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  /**
   * release201/08 §9.2 — kind variant.
   *   - 'task' (default): the generic task-level approval card. Works
   *     anywhere it's mounted today (workspace task-detail-drawer).
   *   - 'skill-publish' | 'skill-revoke': skill-lifecycle decision variants.
   *     They MUST only be rendered inside Studio Lifecycle Evidence panel —
   *     workspace surfaces forbid these variants (forbidden patterns
   *     `[approval-card] skill-publish variant in workspace`).
   * The variant prop controls labelling + telemetry tagging only; the
   * underlying ApprovalDTO list filter still applies.
   */
  kind?: 'task' | 'skill-publish' | 'skill-revoke';
}

type Urgency = 'critical' | 'high' | 'medium' | 'low' | 'none';

// release201/25 §16.4 A6 — hermes-native HITL choices. Replaces the
// legacy 2-option (approve / reject) layout when the approval row carries
// the default option set, because hermes /v1/runs/{id}/approval accepts
// 4 choices (once / session / always / deny). Each renders as a single
// affordance per user-memory `feedback_one_intent_one_affordance.md`,
// except `deny` which still surfaces the required-reason input — we
// genuinely need the reviewer's "why" before persisting a denial.
//
// Detection: a row whose options list is exactly the legacy default
// (`approve` + `reject`) is treated as "hermes-native, no custom
// options" and gets the 4-choice rendering. Rows with custom options
// (e.g. multi-choice user prompts, skill-publish variants) keep their
// caller-provided options verbatim.
const HERMES_NATIVE_CHOICES: Array<{ value: 'once' | 'session' | 'always' | 'deny'; label: string }> = [
  { value: 'once', label: '批准（本次）' },
  { value: 'session', label: '本会话批准' },
  { value: 'always', label: '永久批准' },
  { value: 'deny', label: '拒绝' },
];

function isLegacyDefaultOptions(options: ApprovalDTO['options']): boolean {
  if (options.length !== 2) return false;
  const values = new Set(options.map((o) => o.value));
  return values.has('approve') && values.has('reject');
}

/**
 * Per-row option list rendered by the card. When the approval row
 * carries the legacy default (approve / reject), substitute the 4
 * hermes-native HITL choices. Custom option lists pass through.
 */
function renderableOptions(approval: ApprovalDTO): Array<{ value: string; label: string }> {
  if (isLegacyDefaultOptions(approval.options)) {
    return HERMES_NATIVE_CHOICES.map((c) => ({ value: c.value, label: c.label }));
  }
  return approval.options.map((o) => ({ value: o.value, label: o.label }));
}

/**
 * Single-step buttons vs. inline-reason-required buttons. `deny`
 * (hermes-native) and `reject` (legacy) both need a reason; everything
 * else fires immediately.
 */
function requiresReason(value: string): boolean {
  return value === 'deny' || value === 'reject';
}

interface UrgencyInfo {
  urgency: Urgency;
  /** Minutes until expiry; `null` when no expiresAt set. */
  minutesLeft: number | null;
  /** Short human label, e.g. "12m", "1h", "4h", "—". */
  label: string;
  /** Decorative glyph by urgency tier. */
  glyph: string;
}

function classifyUrgency(approval: ApprovalDTO, now: number = Date.now()): UrgencyInfo {
  if (!approval.expiresAt) {
    return { urgency: 'none', minutesLeft: null, label: '—', glyph: '⏳' };
  }
  const t = Date.parse(approval.expiresAt);
  if (Number.isNaN(t)) {
    return { urgency: 'none', minutesLeft: null, label: '—', glyph: '⏳' };
  }
  const minutesLeft = Math.round((t - now) / 60_000);
  if (minutesLeft < 30) {
    return { urgency: 'critical', minutesLeft, label: minutesLeft <= 0 ? 'expired' : `${minutesLeft}m`, glyph: '🔴' };
  }
  if (minutesLeft < 120) {
    return {
      urgency: 'high',
      minutesLeft,
      label: `${Math.round((minutesLeft / 60) * 10) / 10}h`.replace('.0h', 'h'),
      glyph: '⚠️',
    };
  }
  if (minutesLeft < 480) {
    return { urgency: 'medium', minutesLeft, label: `${Math.round(minutesLeft / 60)}h`, glyph: '⏳' };
  }
  return { urgency: 'low', minutesLeft, label: `${Math.round(minutesLeft / 60)}h`, glyph: '🕐' };
}

function urgencyRank(u: Urgency): number {
  switch (u) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    case 'none':
      return 4;
  }
}

function urgencyTextClass(u: Urgency, isDark: boolean): string {
  if (u === 'critical') return isDark ? 'text-rose-200' : 'text-rose-700';
  if (u === 'high') return isDark ? 'text-amber-200' : 'text-amber-800';
  if (u === 'medium') return isDark ? 'text-cyan-200' : 'text-cyan-800';
  return isDark ? 'text-zinc-300' : 'text-zinc-600';
}

function urgencyBorderClass(u: Urgency, isDark: boolean): string {
  if (u === 'critical') return isDark ? 'border-rose-400/30' : 'border-rose-200';
  if (u === 'high') return isDark ? 'border-amber-400/30' : 'border-amber-200';
  if (u === 'medium') return isDark ? 'border-cyan-400/20' : 'border-cyan-200';
  return isDark ? 'border-zinc-700/40' : 'border-zinc-200';
}

function ageString(createdAt: string, now: number = Date.now()): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return '';
  const ageMin = Math.max(0, Math.round((now - t) / 60_000));
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  if (ageMin < 60 * 24) return `${Math.round(ageMin / 60)}h ago`;
  return `${Math.round(ageMin / (60 * 24))}d ago`;
}

export function ApprovalCard({
  isDark,
  workspaceId,
  conversationId,
  refreshKey = 0,
  notify,
  kind = 'task',
}: ApprovalCardProps) {
  // release201/08 §9.2 — defensive guard. Workspace surfaces (chat / library /
  // task-drawer) must NOT render the skill-* variants. If a workspace mount
  // ever leaks the skill-publish / skill-revoke kind, short-circuit so the
  // UI silently no-ops — these variants belong to /evolution Studio Lifecycle
  // Evidence panel only. We deliberately do NOT log here: doc 08 §0.2.4 lists
  // the forbidden pattern `[approval-card] skill-publish variant in workspace`
  // as a grep gate; any runtime log would flag a clean defensive guard as a
  // regression. The component still computes the flag (typeof window check
  // is hooks-safe) and bails after this point, before hooks run any work.
  const skillVariantInWorkspace = (() => {
    if (typeof window === 'undefined' || kind === 'task') return false;
    return !window.location.pathname.startsWith('/evolution');
  })();
  // release201/13 §3.3 (S22) — when the skill-publish variant IS in the
  // Studio surface, hand off to the EvidencePanel wrapper (9 sections).
  const skillVariantInStudio = (() => {
    if (typeof window === 'undefined' || kind === 'task') return false;
    return window.location.pathname.startsWith('/evolution');
  })();
  const [approvals, setApprovals] = useState<ApprovalDTO[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** Two-stage confirm: which row+action is currently armed. */
  const [armed, setArmed] = useState<{ id: string; value: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const query = useMemo(
    () => ({
      workspaceId: workspaceId ?? undefined,
      conversationId: conversationId ?? undefined,
      status: 'pending',
    }),
    [workspaceId, conversationId],
  );

  const load = useCallback(async () => {
    if (!query.workspaceId && !query.conversationId) {
      setApprovals([]);
      return;
    }
    const result = await listApprovals(query);
    setApprovals(result.ok ? (result.data ?? []) : []);
  }, [query]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!query.workspaceId && !query.conversationId) return;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, query]);

  // Sort: urgency asc (critical first), then createdAt asc.
  const sortedApprovals = useMemo(() => {
    const now = Date.now();
    return approvals
      .map((a) => ({ approval: a, urgency: classifyUrgency(a, now) }))
      .sort((a, b) => {
        const r = urgencyRank(a.urgency.urgency) - urgencyRank(b.urgency.urgency);
        if (r !== 0) return r;
        return Date.parse(a.approval.createdAt) - Date.parse(b.approval.createdAt);
      });
  }, [approvals]);

  // Dedup: count occurrences of each intentHash (>=2 → marked).
  const intentCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of approvals) {
      if (!a.intentHash) continue;
      map.set(a.intentHash, (map.get(a.intentHash) ?? 0) + 1);
    }
    return map;
  }, [approvals]);

  // Per-row "is this a follow-up duplicate of an earlier row in sortedApprovals?"
  // Position-based: the first occurrence in sorted order is the "canonical",
  // subsequent ones get the dedup hint.
  const dedupFollower = useMemo(() => {
    const seen = new Set<string>();
    const follower = new Set<string>();
    for (const { approval } of sortedApprovals) {
      if (!approval.intentHash) continue;
      if (seen.has(approval.intentHash)) follower.add(approval.id);
      else seen.add(approval.intentHash);
    }
    return follower;
  }, [sortedApprovals]);

  /** All similar (intentHash count >= 2) — used by "Approve all similar". */
  const similarApprovals = useMemo(
    () => approvals.filter((a) => a.intentHash && (intentCounts.get(a.intentHash) ?? 0) >= 2),
    [approvals, intentCounts],
  );

  if (skillVariantInWorkspace) return null;

  // Studio surface — render EvidencePanel via the lazy evolution wrapper.
  // We pick the skillId off the first pending skill-publish approval's
  // metadata; if no pending approvals exist the wrapper still mounts so the
  // reviewer can see "no skills awaiting publish" inside the panel context.
  if (skillVariantInStudio) {
    const skillId = ((): string | null => {
      for (const a of approvals) {
        const meta = (a.metadata as Record<string, unknown> | undefined) ?? {};
        const candidate = meta.skillId ?? meta.skill_id;
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return null;
    })();
    if (!skillId) return null;
    return <ApprovalCardSkillPublish isDark={isDark} skillId={skillId} />;
  }

  if (approvals.length === 0) return null;

  const summary = sortedApprovals[0];
  const summaryUrgency = summary?.urgency;

  const closeSheet = () => {
    setExpanded(false);
    setArmed(null);
    setRejectReason('');
  };

  const performDecide = async (approval: ApprovalDTO, selectedValue: string, comment?: string) => {
    setBusyId(approval.id);
    const result = await decideApproval(approval.id, selectedValue, comment);
    setBusyId(null);
    if (!result.ok) {
      notify(result.message || 'Approval decision failed', 'error');
      return false;
    }
    setApprovals((prev) => prev.filter((item) => item.id !== approval.id));
    notify('Approval decision recorded', 'success');
    return true;
  };

  const handleArmedConfirm = async (approval: ApprovalDTO, value: string) => {
    if (requiresReason(value)) {
      const comment = rejectReason.trim();
      if (!comment) {
        notify('请填写驳回原因再提交', 'info');
        return;
      }
      const ok = await performDecide(approval, value, comment);
      if (ok) {
        setArmed(null);
        setRejectReason('');
      }
      return;
    }
    const ok = await performDecide(approval, value);
    if (ok) setArmed(null);
  };

  const approveAllSimilar = async () => {
    if (similarApprovals.length === 0) return;
    setBatching(true);
    let okCount = 0;
    for (const a of similarApprovals) {
      // §16.4 A6 — pick the row's approval-class option in priority order:
      //   1. hermes-native `once` (single-turn approve)
      //   2. legacy `approve`
      // Rows that expose only custom options are skipped — batch approve
      // can't disambiguate caller-defined values.
      const rendered = renderableOptions(a);
      const approveValue =
        rendered.find((o) => o.value === 'once')?.value ??
        rendered.find((o) => o.value === 'approve')?.value ??
        null;
      if (!approveValue) continue;
      const result = await decideApproval(a.id, approveValue);
      if (result.ok) {
        okCount += 1;
        setApprovals((prev) => prev.filter((item) => item.id !== a.id));
      }
    }
    setBatching(false);
    if (okCount > 0) {
      notify(`Approved ${okCount} similar approval${okCount === 1 ? '' : 's'}`, 'success');
    } else {
      notify('No similar approvals could be approved', 'error');
    }
  };

  const bannerTextClass = summaryUrgency ? urgencyTextClass(summaryUrgency.urgency, isDark) : '';
  const summaryGlyph = summaryUrgency?.glyph ?? '⏳';
  const summaryLabel =
    summaryUrgency && summaryUrgency.minutesLeft != null
      ? summaryUrgency.minutesLeft <= 0
        ? 'soonest expired'
        : `1 expires in ${summaryUrgency.label}`
      : 'no expiry set';

  return (
    <>
      {/* Collapsed 32px banner. */}
      <motion.button
        type="button"
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        onClick={() => setExpanded(true)}
        data-testid="approval-card-banner"
        data-approval-count={approvals.length}
        className={`mb-2 flex h-8 w-full items-center justify-between gap-2 rounded-xl border px-3 text-[12px] backdrop-blur-xl transition-colors ${
          isDark
            ? 'border-cyan-200/18 bg-cyan-200/[0.08] hover:bg-cyan-200/[0.12]'
            : 'border-cyan-200/70 bg-cyan-50/45 hover:bg-cyan-100/60'
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden>{summaryGlyph}</span>
          <span className={`font-semibold ${isDark ? 'text-cyan-100' : 'text-cyan-950'}`}>
            {approvals.length === 1 ? '1 approval waiting' : `${approvals.length} approvals waiting`}
          </span>
          <span className={`truncate ${bannerTextClass}`}>· {summaryLabel}</span>
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${isDark ? 'text-cyan-100' : 'text-cyan-800'}`}
        >
          Review
          <ChevronUp className="h-3.5 w-3.5" />
        </span>
      </motion.button>

      {/* Expanded bottom sheet. */}
      <AnimatePresence>
        {expanded ? (
          <>
            {/* Backdrop — clicks dismiss. */}
            <motion.div
              key="approval-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeSheet}
              data-testid="approval-sheet-backdrop"
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            />
            {/* Sheet — anchored bottom but above composer; chooses bottom-32
                so it sits over the chat region, not the input area. */}
            <motion.div
              key="approval-sheet"
              layout
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32, mass: 0.8 }}
              role="dialog"
              aria-label="Pending approvals"
              data-testid="approval-sheet"
              className={`fixed inset-x-2 bottom-28 z-50 max-h-[60vh] overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-2xl sm:inset-x-6 ${
                isDark ? 'border-white/10 bg-zinc-950/85' : 'border-zinc-200 bg-white/95'
              }`}
            >
              <div
                className={`flex items-center justify-between border-b px-4 py-2.5 ${isDark ? 'border-white/10' : 'border-zinc-200/70'}`}
              >
                <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  {approvals.length} approval{approvals.length === 1 ? '' : 's'} · sorted by urgency
                </p>
                <button
                  type="button"
                  onClick={closeSheet}
                  data-testid="approval-sheet-close"
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                    isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-600 hover:bg-zinc-100'
                  }`}
                  aria-label="Close approvals"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[44vh] overflow-y-auto">
                {sortedApprovals.map(({ approval, urgency }) => {
                  const busy = busyId === approval.id;
                  const isFollower = dedupFollower.has(approval.id);
                  const isArmedHere = armed?.id === approval.id;
                  const armedValue = isArmedHere ? armed?.value : null;
                  return (
                    <div
                      key={approval.id}
                      data-testid={`approval-row-${approval.id}`}
                      data-urgency={urgency.urgency}
                      className={`border-b px-4 py-3 ${urgencyBorderClass(urgency.urgency, isDark)} last:border-b-0 ${
                        isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-zinc-50/60'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span aria-hidden className="mt-0.5 text-[14px]">
                          {urgency.glyph}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`flex items-baseline gap-2 text-sm font-semibold ${isDark ? 'text-zinc-50' : 'text-zinc-950'}`}
                          >
                            <span
                              className={`shrink-0 text-[11px] font-bold uppercase ${urgencyTextClass(urgency.urgency, isDark)}`}
                            >
                              {urgency.minutesLeft != null && urgency.minutesLeft <= 0 ? 'expired' : urgency.label} left
                            </span>
                            <span className="truncate">{approval.title}</span>
                          </p>
                          <p className={`mt-0.5 text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                            {approval.category}
                            {approval.requestedByName ? ` · ${approval.requestedByName}` : ''}
                            {` · ${ageString(approval.createdAt)}`}
                            {approval.taskId ? ` · task ${approval.taskId.slice(-6)}` : ''}
                          </p>
                          {approval.context ? (
                            <p
                              className={`mt-1 line-clamp-2 text-[12px] ${isDark ? 'text-zinc-300/90' : 'text-zinc-700'}`}
                            >
                              {approval.context}
                            </p>
                          ) : null}
                          {isFollower ? (
                            <p
                              data-testid={`approval-dedup-hint-${approval.id}`}
                              className={`mt-1 text-[11px] font-medium ${isDark ? 'text-amber-200/90' : 'text-amber-700'}`}
                            >
                              ⚠ Similar to above — dedup proposed
                            </p>
                          ) : null}
                          {approval.taskId ? <AcceptancePeek taskId={approval.taskId} isDark={isDark} /> : null}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {renderableOptions(approval).map((option) => {
                          // §16.4 A6 — `deny` (hermes-native) joins `reject`
                          // (legacy) as the reason-required class; everything
                          // else (approve / once / session / always / custom)
                          // is single-click.
                          const isReject = requiresReason(option.value);
                          const isApprove =
                            option.value === 'approve' || option.value === 'once';
                          // Bug 2 (2026-05-29): one intent = one affordance.
                          //   - 'approve' fires immediately on click (no
                          //     "Confirm approve?" inline confirm row).
                          //   - 'reject' opens an inline reason-required
                          //     input, because we genuinely need the
                          //     reviewer's "why" before persisting the
                          //     decision (not because we doubt the click).
                          //   - All other custom option values (multi-choice
                          //     approvals) fire immediately as well.
                          const isThisBusy = busyId === approval.id;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              disabled={Boolean(busyId)}
                              data-testid={`approval-action-${approval.id}-${option.value}`}
                              onClick={() => {
                                if (isReject) {
                                  setArmed({ id: approval.id, value: option.value });
                                  setRejectReason('');
                                  return;
                                }
                                void performDecide(approval, option.value);
                              }}
                              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                isReject
                                  ? isDark
                                    ? 'border-rose-300/30 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
                                    : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                  : isApprove
                                    ? isDark
                                      ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
                                      : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                    : isDark
                                      ? 'border-white/10 text-zinc-200 hover:bg-white/[0.05]'
                                      : 'border-zinc-200 bg-white/50 text-zinc-700 hover:bg-zinc-100'
                              }`}
                            >
                              {isThisBusy && !isReject ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : isReject ? (
                                <XCircle className="h-3 w-3" />
                              ) : isApprove ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : null}
                              <span>{option.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {/* Bug 2 (2026-05-29) — inline confirm row is now
                          reject-only. Approve fires immediately on its
                          action button click; the reason input below only
                          appears when the reviewer chose to reject.
                          §16.4 A6 — hermes-native `deny` joins `reject`
                          as the reason-required armed state. */}
                      {isArmedHere && armedValue != null && requiresReason(armedValue) ? (
                        <div
                          data-testid={`approval-confirm-${approval.id}`}
                          className={`mt-2 rounded-lg border px-2.5 py-2 ${
                            isDark ? 'border-white/10 bg-white/[0.04]' : 'border-zinc-200 bg-zinc-50'
                          }`}
                        >
                          <textarea
                            autoFocus
                            rows={2}
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="驳回原因(必填)"
                            data-testid={`approval-reject-input-${approval.id}`}
                            className={`w-full resize-none rounded-md border px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-cyan-400 ${
                              isDark
                                ? 'border-white/10 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600'
                                : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
                            }`}
                          />
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setArmed(null);
                                setRejectReason('');
                              }}
                              data-testid={`approval-confirm-cancel-${approval.id}`}
                              className={`inline-flex h-6 flex-1 items-center justify-center rounded-md border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                isDark
                                  ? 'border-white/10 text-zinc-300 hover:bg-white/[0.05]'
                                  : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100'
                              }`}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={busy || rejectReason.trim().length === 0}
                              onClick={() => void handleArmedConfirm(approval, armedValue)}
                              data-testid={`approval-confirm-submit-${approval.id}`}
                              className="inline-flex h-6 flex-1 items-center justify-center gap-1 rounded-md bg-rose-600 px-2 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-rose-500 dark:hover:bg-rose-400"
                            >
                              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              Submit rejection
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {similarApprovals.length >= 2 ? (
                <div
                  className={`flex items-center justify-between border-t px-4 py-2 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'}`}
                >
                  <span className={`text-[11px] ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                    {similarApprovals.length} approvals share a dedup hash
                  </span>
                  <button
                    type="button"
                    disabled={batching || Boolean(busyId)}
                    onClick={() => void approveAllSimilar()}
                    data-testid="approval-approve-similar"
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400"
                  >
                    {batching ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    Approve all similar ({similarApprovals.length})
                  </button>
                </div>
              ) : (
                <div
                  className={`flex items-center justify-end border-t px-4 py-2 ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'}`}
                >
                  <span
                    className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
                  >
                    <Clock3 className="mr-1 inline h-3 w-3" /> auto-refreshes every 30s
                  </span>
                </div>
              )}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * release201/10 §8.3 — embedded acceptance peek for task-acceptance variant.
 * Fetches /tasks/:id/acceptance lazily and renders a 1-line summary + first
 * 3 criteria so reviewer sees the criteria table before approving.
 */
function AcceptancePeek({ taskId, isDark }: { taskId: string; isDark: boolean }) {
  type CriteriaItem = {
    id: string;
    status: string;
    expectation: string;
    verifyMode: string;
    verifierAgentId: string | null;
    required?: boolean;
  };
  const [data, setData] = useState<{
    overall: string;
    completedCount: number;
    totalCount: number;
    criteria: CriteriaItem[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await imFetch<typeof data>(`/tasks/${encodeURIComponent(taskId)}/acceptance`);
        if (!cancelled && res.ok) setData(res.data ?? null);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!data || data.totalCount === 0) return null;
  const chipColour =
    data.overall === 'passed'
      ? isDark
        ? 'bg-emerald-500/15 text-emerald-200'
        : 'bg-emerald-50 text-emerald-700'
      : data.overall === 'failed'
        ? isDark
          ? 'bg-rose-500/15 text-rose-200'
          : 'bg-rose-50 text-rose-700'
        : isDark
          ? 'bg-amber-500/15 text-amber-200'
          : 'bg-amber-50 text-amber-700';
  return (
    <div
      className={`mt-1.5 rounded-md border px-2 py-1.5 text-[11px] ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'}`}
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${chipColour}`}>
          {data.overall} {data.completedCount}/{data.totalCount}
        </span>
        <span className={isDark ? 'text-zinc-400' : 'text-zinc-500'}>acceptance criteria</span>
      </div>
      <ul className={`mt-1 space-y-0.5 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
        {data.criteria.slice(0, 3).map((c) => {
          const mark = c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : c.status === 'n/a' ? '·' : '◯';
          return (
            <li key={c.id} className="flex items-start gap-1.5">
              <span aria-hidden>{mark}</span>
              <span className="truncate">
                {c.expectation}
                <span className={`ml-1 text-[10px] uppercase ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  [{c.verifyMode}
                  {c.verifierAgentId ? ` → @${c.verifierAgentId.slice(-6)}` : ''}]
                </span>
              </span>
            </li>
          );
        })}
        {data.criteria.length > 3 ? (
          <li className={`italic ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>+ {data.criteria.length - 3} more</li>
        ) : null}
      </ul>
    </div>
  );
}
