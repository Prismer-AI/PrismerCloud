'use client';

/**
 * ChiefOfStaffSection — workspace settings card for orchestrator agent
 * appointment / revocation (release 200 §4.4).
 *
 * Two states:
 *   - active: shows the current orchestrator (name, authorized by, date) +
 *             [Revoke] (red, with confirm)
 *   - empty:  shows an agent picker + [Appoint]
 *
 * The component owns its own fetch + mutation lifecycle; consumers only need
 * to pass `workspaceId` and optionally `isOwner` (gates the action buttons —
 * non-owners see the current state but no controls).
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { imFetch } from '../lib/im-api';

interface OrchestratorInfo {
  agentImUserId: string;
  agentUsername: string;
  agentDisplayName: string;
  authorizedAt: string;
  authorizedByImUserId: string;
  authorizedByDisplayName: string;
}

interface WorkspaceAgentRow {
  agentId: string;
  userId: string;
  username: string;
  displayName: string;
}

interface OrchestratorEnvelope {
  workspace: { id: string; name: string; ownerImUserId: string };
  orchestrator: OrchestratorInfo | null;
}

interface Props {
  workspaceId: string;
  isOwner: boolean;
  isDark?: boolean;
}

export function ChiefOfStaffSection({ workspaceId, isOwner, isDark = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orchestrator, setOrchestrator] = useState<OrchestratorInfo | null>(null);
  const [agents, setAgents] = useState<WorkspaceAgentRow[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    const orchRes = await imFetch<OrchestratorEnvelope>(
      `/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`,
    );
    if (!orchRes.ok) {
      setError(orchRes.message);
      setLoading(false);
      return;
    }
    setOrchestrator(orchRes.data.orchestrator);

    // Agents in workspace — needed for the appoint picker. The agents list
    // endpoint already powers other parts of the workspace UI.
    const agentsRes = await imFetch<WorkspaceAgentRow[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
    );
    if (agentsRes.ok) {
      setAgents(agentsRes.data ?? []);
    }
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const onAppoint = useCallback(async () => {
    if (!selectedAgentId) return;
    setBusy(true);
    setError(null);
    const res = await imFetch<{ orchestrator: OrchestratorInfo | null }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`,
      { method: 'POST', body: JSON.stringify({ agentImUserId: selectedAgentId }) },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOrchestrator(res.data.orchestrator);
    setSelectedAgentId('');
  }, [workspaceId, selectedAgentId]);

  const onRevoke = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await imFetch(`/workspaces/${encodeURIComponent(workspaceId)}/orchestrator`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOrchestrator(null);
    setConfirmingRevoke(false);
  }, [workspaceId]);

  const surface = isDark ? 'bg-zinc-900/60 border-zinc-800' : 'bg-white border-zinc-200';
  const textPrimary = isDark ? 'text-zinc-100' : 'text-zinc-900';
  const textMuted = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const inputCls = isDark
    ? 'bg-zinc-950 border-zinc-700 text-zinc-100'
    : 'bg-white border-zinc-300 text-zinc-900';

  return (
    <section
      className={`rounded-lg border ${surface} p-5`}
      data-testid="chief-of-staff-section"
    >
      <header className="mb-3 flex items-center justify-between">
        <h2 className={`text-base font-semibold ${textPrimary}`}>Chief of Staff</h2>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : null}
      </header>
      <p className={`mb-4 text-sm ${textMuted}`}>
        Appoint an agent in this workspace as your deputy. They can dispatch tasks to any member,
        approve or reject submissions, and edit or cancel any task. They cannot use the
        emergency force-transition or manage workspace settings.
      </p>

      {error ? (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      ) : null}

      {loading ? null : orchestrator ? (
        <div
          className={`rounded-md border ${isDark ? 'border-zinc-800 bg-zinc-950/50' : 'border-zinc-200 bg-zinc-50'} p-4`}
          data-testid="orchestrator-active"
        >
          <div className={`text-sm ${textPrimary}`}>
            <div className="font-medium">
              {orchestrator.agentDisplayName}{' '}
              <span className={textMuted}>(@{orchestrator.agentUsername})</span>
            </div>
            <div className={`mt-1 text-xs ${textMuted}`}>
              Authorized by {orchestrator.authorizedByDisplayName} on{' '}
              {new Date(orchestrator.authorizedAt).toLocaleDateString()}
            </div>
          </div>
          {isOwner ? (
            <div className="mt-3 flex items-center gap-2">
              {confirmingRevoke ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onRevoke}
                    className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    data-testid="confirm-revoke-button"
                  >
                    {busy ? 'Revoking…' : 'Confirm revoke'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingRevoke(false)}
                    className={`rounded border px-3 py-1.5 text-sm ${isDark ? 'border-zinc-700 text-zinc-300' : 'border-zinc-300 text-zinc-700'}`}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRevoke(true)}
                  className="rounded border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/20"
                  data-testid="revoke-button"
                >
                  Revoke
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          className={`rounded-md border ${isDark ? 'border-zinc-800 bg-zinc-950/50' : 'border-zinc-200 bg-zinc-50'} p-4`}
          data-testid="orchestrator-empty"
        >
          {isOwner ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                disabled={busy || agents.length === 0}
                className={`rounded border px-2 py-1.5 text-sm ${inputCls} flex-1`}
                data-testid="agent-picker"
              >
                <option value="">
                  {agents.length === 0 ? 'No agents in this workspace' : 'Select an agent…'}
                </option>
                {agents.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.displayName} (@{a.username})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !selectedAgentId}
                onClick={onAppoint}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="appoint-button"
              >
                {busy ? 'Appointing…' : 'Appoint'}
              </button>
            </div>
          ) : (
            <p className={`text-sm ${textMuted}`}>
              No Chief of Staff appointed. Only the workspace owner can appoint one.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
