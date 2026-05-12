'use client';

/**
 * LibraryProposalReviewModal — Memory Line B / B7.
 *
 * Surfaces agent-authored proposals for owner review. Lists pending
 * proposals grouped by sessionId; clicking a row opens an inline diff
 * preview with Approve / Reject (with reason) / Bulk-approve-this-session
 * actions. baseVersion drift (HTTP 409) renders an explicit warning so
 * the user knows the agent must re-author rather than blind-merging.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Loader2, RotateCcw, X, XCircle } from 'lucide-react';

import {
  approveProposal,
  bulkApproveProposals,
  listProposals,
  rejectProposal,
  type MemoryProposalDTO,
} from '../lib/memory-api';

/**
 * D6: classify proposal source for the review modal.
 *
 * Memory proposals only have two ingest paths in the current cloud:
 *   - Agent skill — agents in a chat session call POST /memory/proposals;
 *     `proposingAgentId` is the agent's imUserId.
 *   - Dream extract — the page-dream cron writes proposals with a
 *     `__dream__` sentinel when no session agent is known
 *     (see `memory-page-dream.service.ts`).
 *
 * "Save as memory" (the user-driven path) does NOT enter the proposal
 * queue — it writes pages directly via POST /memory/pages — so it has no
 * representation here. The 3rd category sometimes mentioned in design
 * docs is informational only.
 */
type ProposalSource = 'agent-skill' | 'dream-extract';
const DREAM_SENTINEL = '__dream__';

function classifyProposalSource(p: MemoryProposalDTO): ProposalSource {
  const id = p.proposingAgentId ?? p.proposingAgentImUserId ?? '';
  return id === DREAM_SENTINEL ? 'dream-extract' : 'agent-skill';
}

const SOURCE_LABEL: Record<ProposalSource, string> = {
  'agent-skill': 'Agent skill',
  'dream-extract': 'Dream extract',
};

// Higher = earlier in default sort. Per design: user-active proposals
// outrank background-derived ones. Save-as-memory would be highest but
// doesn't appear here.
const SOURCE_PRIORITY: Record<ProposalSource, number> = {
  'agent-skill': 1,
  'dream-extract': 0,
};

interface LibraryProposalReviewModalProps {
  open: boolean;
  workspaceId: string | null;
  isDark: boolean;
  onClose: () => void;
  /** Tells the parent when an approve/reject succeeds so it can refresh badge counters. */
  onChanged: () => void;
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function LibraryProposalReviewModal({
  open,
  workspaceId,
  isDark,
  onClose,
  onChanged,
  notify,
}: LibraryProposalReviewModalProps) {
  const [proposals, setProposals] = useState<MemoryProposalDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [driftFor, setDriftFor] = useState<{ id: string; currentVersion: number | null } | null>(null);

  useEffect(() => {
    if (!open || !workspaceId) return undefined;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setDriftFor(null);
    listProposals({ workspaceId, status: 'pending', limit: 100, signal: ac.signal }).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) {
        setProposals(res.data ?? []);
      } else {
        setError(res.message);
      }
      setLoading(false);
    });
    return () => ac.abort();
  }, [open, workspaceId]);

  const grouped = useMemo(() => {
    const acc = new Map<string, MemoryProposalDTO[]>();
    for (const p of proposals) {
      const key = p.sessionId ?? '(no session)';
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key)!.push(p);
    }
    return Array.from(acc.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [proposals]);

  if (!open) return null;

  function refetch() {
    if (!workspaceId) return;
    setLoading(true);
    listProposals({ workspaceId, status: 'pending', limit: 100 }).then((res) => {
      if (res.ok) setProposals(res.data ?? []);
      setLoading(false);
    });
  }

  async function handleApprove(p: MemoryProposalDTO) {
    if (!workspaceId) return;
    setBusyId(p.id);
    setDriftFor(null);
    const res = await approveProposal(p.id, workspaceId);
    setBusyId(null);
    if (res.ok) {
      notify?.('Proposal approved', 'success');
      setProposals((prev) => prev.filter((entry) => entry.id !== p.id));
      onChanged();
      return;
    }
    if (res.status === 409) {
      const meta = (res.raw as { meta?: { currentVersion?: number } } | undefined)?.meta;
      const currentVersion = typeof meta?.currentVersion === 'number' ? meta.currentVersion : null;
      setDriftFor({ id: p.id, currentVersion });
      notify?.(
        currentVersion != null
          ? `Page version drifted to v${currentVersion} — agent must re-author against v${currentVersion}`
          : 'Page version drifted — agent must re-author',
        'info',
      );
      return;
    }
    notify?.(`Approve failed: ${res.message}`, 'error');
  }

  async function handleReject(p: MemoryProposalDTO) {
    if (!workspaceId) return;
    const reason = rejectReason.trim();
    if (!reason) {
      notify?.('Reject needs a reason', 'error');
      return;
    }
    setBusyId(p.id);
    const res = await rejectProposal(p.id, { workspaceId, reason });
    setBusyId(null);
    if (res.ok) {
      notify?.('Proposal rejected', 'success');
      setProposals((prev) => prev.filter((entry) => entry.id !== p.id));
      setRejectReason('');
      onChanged();
      return;
    }
    notify?.(`Reject failed: ${res.message}`, 'error');
  }

  async function handleBulkApprove(sessionId: string) {
    if (!workspaceId) return;
    setBusyId(`bulk-${sessionId}`);
    const realSessionId = sessionId === '(no session)' ? undefined : sessionId;
    const res = await bulkApproveProposals({ workspaceId, sessionId: realSessionId });
    setBusyId(null);
    if (res.ok) {
      const data = res.data;
      notify?.(`Bulk approve: ${data?.approved.length ?? 0} approved, ${data?.skipped.length ?? 0} skipped`, 'success');
      onChanged();
      refetch();
      return;
    }
    notify?.(`Bulk approve failed: ${res.message}`, 'error');
  }

  return (
    <div
      data-testid="library-proposal-review-modal"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div
        data-testid="library-proposal-review-modal-backdrop"
        onClick={onClose}
        className={`absolute inset-0 ${isDark ? 'bg-black/60' : 'bg-zinc-900/30'} backdrop-blur-[2px]`}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal
        aria-label="Memory proposal review"
        className={`relative z-10 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${
          isDark ? 'border-white/[0.08] bg-zinc-950/95' : 'border-zinc-200 bg-white/95'
        }`}
        style={{ maxHeight: '80vh' }}
      >
        <header
          className={`flex items-center gap-2 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <p className={`text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            Memory proposals · {proposals.length} pending
          </p>
          <button
            type="button"
            data-testid="library-proposal-modal-close"
            onClick={onClose}
            className={`ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside
            className={`min-h-0 overflow-y-auto border-r px-2 py-2 ${
              isDark ? 'border-white/[0.06]' : 'border-zinc-200'
            }`}
          >
            {loading ? (
              <div
                className={`flex items-center gap-2 px-3 py-3 text-[11px] ${
                  isDark ? 'text-zinc-400' : 'text-zinc-500'
                }`}
              >
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <p className={`px-3 py-3 text-xs ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{error}</p>
            ) : grouped.length === 0 ? (
              <p
                data-testid="library-proposal-empty"
                className={`px-3 py-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
              >
                No pending proposals.
              </p>
            ) : (
              grouped.map(([sessionId, list]) => (
                <div key={sessionId} className="mb-3">
                  <div
                    data-testid={`library-proposal-session-${slug(sessionId)}`}
                    className={`mb-1 flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${
                      isDark ? 'text-zinc-500' : 'text-zinc-500'
                    }`}
                  >
                    <span className="flex-1 truncate">{sessionId}</span>
                    <button
                      type="button"
                      data-testid={`library-proposal-bulk-approve-${slug(sessionId)}`}
                      onClick={() => void handleBulkApprove(sessionId)}
                      className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                        isDark
                          ? 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                          : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      }`}
                    >
                      Bulk approve
                    </button>
                  </div>
                  {list
                    .slice()
                    .sort((a, b) => {
                      // D6: agent-skill proposals before dream-extract,
                      // then confidence desc within the same source.
                      const sa = SOURCE_PRIORITY[classifyProposalSource(a)];
                      const sb = SOURCE_PRIORITY[classifyProposalSource(b)];
                      if (sa !== sb) return sb - sa;
                      return b.confidence - a.confidence;
                    })
                    .map((p) => {
                      const isSelected = p.id === selectedId;
                      const source = classifyProposalSource(p);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          data-testid={`library-proposal-row-${p.id}`}
                          data-confidence-tier={p.confidence >= 0.9 ? 'high' : p.confidence >= 0.7 ? 'mid' : 'low'}
                          data-proposal-source={source}
                          onClick={() => {
                            setSelectedId(p.id);
                            setRejectReason('');
                            setDriftFor(null);
                          }}
                          className={`mb-1 flex w-full flex-col gap-0.5 rounded-xl px-2.5 py-1.5 text-left transition-colors ${
                            isSelected
                              ? isDark
                                ? 'bg-violet-500/14 ring-1 ring-violet-400/40'
                                : 'bg-violet-100/70 ring-1 ring-violet-300/70'
                              : isDark
                                ? 'hover:bg-white/[0.04]'
                                : 'hover:bg-zinc-100'
                          }`}
                        >
                          <span className="flex items-center gap-1.5">
                            <ProposalSourcePill source={source} isDark={isDark} />
                            <span
                              className={`min-w-0 flex-1 truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
                            >
                              {p.pagePath}
                            </span>
                          </span>
                          <span className={`truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                            {p.operation} · base v{p.baseVersion} · conf {p.confidence.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))
            )}
          </aside>

          <section className="min-h-0 overflow-y-auto px-4 py-3">
            {selectedId ? (
              <ProposalDetail
                isDark={isDark}
                proposal={proposals.find((p) => p.id === selectedId) ?? null}
                busyId={busyId}
                drift={driftFor?.id === selectedId ? driftFor : null}
                rejectReason={rejectReason}
                setRejectReason={setRejectReason}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            ) : (
              <div
                className={`flex h-full items-center justify-center text-center text-xs ${
                  isDark ? 'text-zinc-500' : 'text-zinc-500'
                }`}
              >
                Pick a proposal from the left to review the diff.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProposalDetail({
  isDark,
  proposal,
  busyId,
  drift,
  rejectReason,
  setRejectReason,
  onApprove,
  onReject,
}: {
  isDark: boolean;
  proposal: MemoryProposalDTO | null;
  busyId: string | null;
  drift: { id: string; currentVersion: number | null } | null;
  rejectReason: string;
  setRejectReason: (value: string) => void;
  onApprove: (p: MemoryProposalDTO) => void;
  onReject: (p: MemoryProposalDTO) => void;
}) {
  if (!proposal) return null;
  const busy = busyId === proposal.id;
  const driftActive = Boolean(drift);
  const agentId = proposal.proposingAgentId ?? proposal.proposingAgentImUserId ?? '';
  const source = classifyProposalSource(proposal);
  // Dream-extract proposals carry the __dream__ sentinel — that's a category
  // label, not an agent identity, so don't render it as a truncated id.
  const agentLabel =
    source === 'dream-extract'
      ? 'background cron'
      : agentId
        ? `${agentId.slice(0, 12)}…`
        : 'unknown agent';
  return (
    <div data-testid="library-proposal-detail" data-proposal-source={source} className="space-y-3">
      <div>
        <p className={`truncate text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {proposal.pagePath}
        </p>
        <p
          className={`mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] ${
            isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          <ProposalSourcePill source={source} isDark={isDark} />
          <span>
            {proposal.operation} against base v{proposal.baseVersion} · confidence {proposal.confidence.toFixed(2)} ·
            authored {agentLabel}
          </span>
        </p>
      </div>

      {proposal.rationale ? (
        <div
          className={`rounded-xl border px-3 py-2 text-[11px] ${
            isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          <p
            className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
          >
            Rationale
          </p>
          <p className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{proposal.rationale}</p>
        </div>
      ) : null}

      {drift ? (
        <div
          data-testid="library-proposal-drift-warning"
          data-current-version={drift.currentVersion ?? undefined}
          className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] ${
            isDark
              ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
              : 'border-amber-300 bg-amber-50 text-amber-700'
          }`}
        >
          <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Page version drifted since this proposal was authored
            {drift.currentVersion != null ? (
              <>
                {' — current is '}
                <span data-testid="library-proposal-drift-current-version" className="font-mono font-semibold">
                  v{drift.currentVersion}
                </span>
                {', proposal targets '}
                <span className="font-mono font-semibold">v{proposal.baseVersion}</span>
              </>
            ) : (
              <> — current version differs from this proposal&apos;s base</>
            )}
            . The agent must re-author against the current version — approval is not safe.
          </span>
        </div>
      ) : null}

      <div>
        <p
          className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          Diff
        </p>
        <pre
          data-testid="library-proposal-diff"
          className={`max-h-64 overflow-auto rounded-xl border px-3 py-2 font-mono text-[11px] leading-relaxed ${
            isDark
              ? 'border-white/[0.06] bg-white/[0.02] text-emerald-200'
              : 'border-zinc-200 bg-zinc-50 text-emerald-700'
          }`}
        >
          {proposal.contentDiff.split('\n').map((line, idx) => (
            <span key={idx}>
              <ChevronRight className="mr-1 inline h-3 w-3 align-[-2px]" />
              {line || ' '}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>

      <div className={`rounded-xl border px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
        <p
          className={`mb-1 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
        >
          Reject reason (required for reject)
        </p>
        <input
          data-testid="library-proposal-reject-reason"
          value={rejectReason}
          onChange={(event) => setRejectReason(event.target.value)}
          placeholder="e.g. duplicate of INDEX/decisions.md"
          className={`w-full rounded-lg border px-2 py-1 text-xs outline-none ${
            isDark
              ? 'border-white/[0.08] bg-white/[0.03] text-zinc-100 placeholder:text-zinc-500'
              : 'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400'
          }`}
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="library-proposal-reject"
          disabled={busy || !rejectReason.trim()}
          onClick={() => onReject(proposal)}
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold ${
            busy || !rejectReason.trim()
              ? isDark
                ? 'cursor-not-allowed border-white/[0.06] text-zinc-600'
                : 'cursor-not-allowed border-zinc-200 text-zinc-400'
              : isDark
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
          }`}
        >
          <XCircle className="h-3.5 w-3.5" /> Reject
        </button>
        <button
          type="button"
          data-testid="library-proposal-approve"
          disabled={busy || driftActive}
          onClick={() => onApprove(proposal)}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold ${
            busy || driftActive
              ? isDark
                ? 'cursor-not-allowed bg-white/[0.04] text-zinc-600'
                : 'cursor-not-allowed bg-zinc-100 text-zinc-400'
              : isDark
                ? 'bg-emerald-500/30 text-emerald-100 hover:bg-emerald-500/40'
                : 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200'
          }`}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Approve
        </button>
      </div>
    </div>
  );
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '') || 'none'
  );
}

function ProposalSourcePill({ source, isDark }: { source: ProposalSource; isDark: boolean }) {
  // Two tones: cyan for agent-skill (active session work) and indigo for
  // dream-extract (background-derived). Both readable against the modal's
  // violet selection ring.
  const tone =
    source === 'agent-skill'
      ? isDark
        ? 'bg-cyan-500/15 text-cyan-200'
        : 'bg-cyan-50 text-cyan-700'
      : isDark
        ? 'bg-indigo-500/15 text-indigo-200'
        : 'bg-indigo-50 text-indigo-700';
  return (
    <span
      data-testid={`library-proposal-source-pill-${source}`}
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone}`}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}
