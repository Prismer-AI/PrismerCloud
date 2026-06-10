'use client';

/**
 * Wave 3 C2 — Rebalance modal (§4.8.2.3 "Rebalance flow").
 *
 * Lets the user explicitly transfer a contested agent from its current
 * `boundDaemonId` to a target daemon. Surfaces `inFlightTaskCount` after
 * the rebind succeeds so the user understands ongoing dispatches WILL
 * finish on the previous owner (cloud doesn't tear in-flight tasks down).
 *
 * Flow:
 *   1. User opens modal — either via the panel-wide "Rebalance" CTA
 *      (no `focusAgentImUserId`, defaults to first contested) or via
 *      a per-row Rebalance button (`focusAgentImUserId` pre-selects).
 *   2. User picks a target daemon from the workspace's available device
 *      roster.
 *   3. POST /agent-bindings/:agentImUserId/rebind.
 *   4. Modal stays open showing inFlightTaskCount until user closes;
 *      parent's SSE handler picks up `agent.binding.rebound` and
 *      refreshes the panel.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Check } from 'lucide-react';

import { rebindAgent, type AgentBindingDTO, type DaemonKind, type RebindResponse } from '../lib/agent-bindings-api';
import type { WorkspaceRuntimeDTO, RuntimeDeviceDTO } from '../lib/types';
import { radius, surface } from '../lib/design';

export interface RebalanceModalProps {
  isDark: boolean;
  open: boolean;
  bindings: AgentBindingDTO[];
  runtime: WorkspaceRuntimeDTO | null;
  /** When set, the modal preselects this agent. Falsy => first contested in list. */
  focusAgentImUserId?: string | null;
  onClose: () => void;
  onRebound: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type StepState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; response: RebindResponse }
  | { kind: 'error'; message: string };

interface DaemonOption {
  daemonId: string;
  daemonKind: DaemonKind;
  daemonLabel: string;
  online: boolean;
}

export function RebalanceModal({
  isDark,
  open,
  bindings,
  runtime,
  focusAgentImUserId,
  onClose,
  onRebound,
  notify,
}: RebalanceModalProps) {
  const contested = useMemo(() => bindings.filter((b) => b.contested), [bindings]);
  const [selectedAgentImUserId, setSelectedAgentImUserId] = useState<string | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [step, setStep] = useState<StepState>({ kind: 'idle' });

  // Reset selection state whenever modal opens (avoids stale data leaking
  // across consecutive opens for different agents).
  useEffect(() => {
    if (!open) return;
    const seed = focusAgentImUserId ?? contested[0]?.agentImUserId ?? null;
    setSelectedAgentImUserId(seed);
    setSelectedTargetId(null);
    setStep({ kind: 'idle' });
  }, [open, focusAgentImUserId, contested]);

  const selectedBinding = useMemo(
    () => bindings.find((b) => b.agentImUserId === selectedAgentImUserId) ?? null,
    [bindings, selectedAgentImUserId],
  );

  const daemonOptions = useMemo(
    () => buildDaemonOptions(runtime, bindings, selectedBinding?.boundDaemonId ?? null),
    [runtime, bindings, selectedBinding],
  );

  if (!open) return null;

  async function submit() {
    if (!selectedAgentImUserId || !selectedTargetId) return;
    const target = daemonOptions.find((d) => d.daemonId === selectedTargetId);
    setStep({ kind: 'submitting' });
    const res = await rebindAgent(selectedAgentImUserId, {
      targetDaemonId: selectedTargetId,
      reason: 'workspace-rebalance-modal',
      targetDaemonKind: target?.daemonKind,
      targetDaemonLabel: target?.daemonLabel,
    });
    if (!res.ok) {
      setStep({ kind: 'error', message: res.message });
      notify(`Rebind failed: ${res.message}`, 'error');
      return;
    }
    setStep({ kind: 'success', response: res.data });
    notify('Agent ownership updated.', 'success');
    await onRebound();
  }

  return (
    <div
      data-testid="rebalance-modal"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => {
        if (step.kind !== 'submitting') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebalance-modal-title"
        onClick={(event) => event.stopPropagation()}
        className={`relative flex w-full max-w-xl flex-col gap-4 border p-5 ${radius.pane} ${
          surface.modal[isDark ? 'dark' : 'light']
        }`}
      >
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3
              id="rebalance-modal-title"
              className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
            >
              Rebalance agent ownership
            </h3>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
              Pick which daemon should own this agent. The previous owner finishes its in-flight tasks; new tasks
              route immediately to the new owner.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={step.kind === 'submitting'}
            data-testid="rebalance-modal-close"
            className={`shrink-0 rounded-xl p-1.5 transition-colors ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
            aria-label="Close rebalance modal"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {contested.length === 0 ? (
          <p
            data-testid="rebalance-modal-empty"
            className={`rounded-xl border p-4 text-sm ${
              isDark ? 'border-white/[0.06] bg-white/[0.02] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700'
            }`}
          >
            No contested bindings right now. You can still re-pin an agent from the Devices list by picking it
            directly.
          </p>
        ) : null}

        {step.kind === 'success' ? (
          <SuccessPanel
            isDark={isDark}
            response={step.response}
            agentName={selectedBinding?.agentName ?? selectedAgentImUserId ?? ''}
            onClose={onClose}
          />
        ) : (
          <>
            {/* Agent selector — list of contested + currently selected (if any) */}
            <fieldset className="flex flex-col gap-2">
              <legend className={`text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                Agent
              </legend>
              <select
                data-testid="rebalance-modal-agent-select"
                value={selectedAgentImUserId ?? ''}
                onChange={(event) => {
                  setSelectedAgentImUserId(event.target.value || null);
                  setSelectedTargetId(null);
                }}
                disabled={step.kind === 'submitting'}
                className={`w-full rounded-xl border px-3 py-2 text-sm ${
                  isDark
                    ? 'border-white/[0.08] bg-zinc-900/60 text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-900'
                }`}
              >
                <option value="" disabled>
                  Pick an agent…
                </option>
                {(contested.length > 0 ? contested : bindings).map((binding) => (
                  <option key={binding.agentImUserId} value={binding.agentImUserId}>
                    {binding.agentName || binding.agentImUserId}
                    {binding.contested ? '  ⚠ contested' : ''}  — currently {binding.boundDaemonLabel}
                  </option>
                ))}
              </select>
            </fieldset>

            {selectedBinding ? (
              <fieldset className="flex flex-col gap-2">
                <legend
                  className={`text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Target daemon
                </legend>
                <ul className="flex flex-col gap-2" data-testid="rebalance-modal-targets">
                  {daemonOptions.length === 0 ? (
                    <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      No alternate daemons available. Pair another daemon to rebalance.
                    </p>
                  ) : (
                    daemonOptions.map((option) => (
                      <li key={option.daemonId}>
                        <label
                          data-testid={`rebalance-modal-target-${option.daemonId}`}
                          className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${
                            selectedTargetId === option.daemonId
                              ? isDark
                                ? 'border-violet-400/40 bg-violet-500/10'
                                : 'border-violet-300 bg-violet-50'
                              : isDark
                                ? 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                                : 'border-zinc-200 bg-white hover:bg-zinc-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name="rebalance-target"
                            value={option.daemonId}
                            checked={selectedTargetId === option.daemonId}
                            onChange={() => setSelectedTargetId(option.daemonId)}
                            disabled={step.kind === 'submitting'}
                            className="h-3.5 w-3.5"
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={`truncate text-sm font-medium ${
                                isDark ? 'text-zinc-100' : 'text-zinc-900'
                              }`}
                            >
                              {option.daemonLabel}
                            </p>
                            <p
                              className={`mt-0.5 truncate text-[11px] ${
                                isDark ? 'text-zinc-500' : 'text-zinc-500'
                              }`}
                            >
                              {option.daemonKind} · {option.online ? 'online' : 'offline / stale'}
                            </p>
                          </div>
                          {option.online ? (
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                isDark
                                  ? 'bg-emerald-500/15 text-emerald-200'
                                  : 'bg-emerald-100 text-emerald-700'
                              }`}
                            >
                              online
                            </span>
                          ) : null}
                        </label>
                      </li>
                    ))
                  )}
                </ul>
              </fieldset>
            ) : null}

            {step.kind === 'error' ? (
              <p
                data-testid="rebalance-modal-error"
                className={`rounded-xl border px-3 py-2 text-xs ${
                  isDark ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'
                }`}
              >
                {step.message}
              </p>
            ) : null}

            <footer className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={step.kind === 'submitting'}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                  isDark
                    ? 'border-white/[0.08] text-zinc-200 hover:bg-white/[0.04]'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="rebalance-modal-submit"
                onClick={() => void submit()}
                disabled={!selectedAgentImUserId || !selectedTargetId || step.kind === 'submitting'}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
                  isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-500'
                }`}
              >
                {step.kind === 'submitting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Move ownership
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function SuccessPanel({
  isDark,
  response,
  agentName,
  onClose,
}: {
  isDark: boolean;
  response: RebindResponse;
  agentName: string;
  onClose: () => void;
}) {
  const inFlight = response.inFlightTaskCount;
  return (
    <div
      data-testid="rebalance-modal-success"
      data-inflight-count={inFlight}
      className={`flex flex-col gap-3 rounded-xl border p-4 ${
        isDark ? 'border-emerald-400/30 bg-emerald-500/10' : 'border-emerald-200 bg-emerald-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <Check className={`h-4 w-4 ${isDark ? 'text-emerald-200' : 'text-emerald-700'}`} />
        <p className={`text-sm font-semibold ${isDark ? 'text-emerald-100' : 'text-emerald-800'}`}>
          Ownership moved
        </p>
      </div>
      <p className={`text-xs leading-5 ${isDark ? 'text-emerald-100/80' : 'text-emerald-800/85'}`}>
        <strong>{agentName}</strong> is now owned by{' '}
        <strong>{response.binding.boundDaemonLabel}</strong>. New tasks will route to the new owner immediately.
      </p>
      {inFlight > 0 ? (
        <p
          data-testid="rebalance-modal-inflight"
          className={`rounded-lg border px-3 py-2 text-[11px] ${
            isDark
              ? 'border-amber-400/30 bg-amber-500/10 text-amber-100'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {inFlight} in-flight task{inFlight === 1 ? '' : 's'} will hand over to the new owner after the previous
          owner ({response.previousDaemonId}) finishes its current run.
        </p>
      ) : (
        <p className={`text-[11px] ${isDark ? 'text-emerald-100/65' : 'text-emerald-800/70'}`}>
          No in-flight tasks were pending on the previous owner — handover is instant.
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className={`rounded-xl px-3 py-1.5 text-xs font-semibold text-white transition-colors ${
            isDark ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Build the rebind target list — every daemon known to the workspace EXCEPT
 * the current owner. We surface "online" status as a hint but don't block
 * stale daemons (the user may know better than the heartbeat freshness).
 */
export function buildDaemonOptions(
  runtime: WorkspaceRuntimeDTO | null,
  bindings: AgentBindingDTO[],
  excludeDaemonId: string | null,
): DaemonOption[] {
  const seen = new Map<string, DaemonOption>();
  const ONLINE_WINDOW_MS = 90_000;
  const nowTs = Date.now();
  for (const device of runtime?.devices ?? []) {
    if (device.deviceId === excludeDaemonId) continue;
    const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    const online = Number.isFinite(lastSeen) && lastSeen > 0 && nowTs - lastSeen <= ONLINE_WINDOW_MS;
    seen.set(device.deviceId, {
      daemonId: device.deviceId,
      daemonKind: inferKindFromName(device.name, device.deviceId),
      daemonLabel: device.name || device.deviceId,
      online,
    });
  }
  // Also include any daemons referenced by other bindings — sometimes the
  // runtime feed lags behind binding rows (the binding row is authoritative
  // per Wave 2-B2). De-dupe by daemonId.
  for (const binding of bindings) {
    if (binding.boundDaemonId === excludeDaemonId) continue;
    if (seen.has(binding.boundDaemonId)) continue;
    seen.set(binding.boundDaemonId, {
      daemonId: binding.boundDaemonId,
      daemonKind: binding.boundDaemonKind,
      daemonLabel: binding.boundDaemonLabel || binding.boundDaemonId,
      online: false,
    });
  }
  return [...seen.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.daemonLabel.localeCompare(b.daemonLabel));
}

function inferKindFromName(name: string, deviceId: string): DaemonKind {
  const haystack = `${name} ${deviceId}`.toLowerCase();
  if (haystack.includes('k8s') || haystack.includes('pod') || haystack.includes('cluster')) return 'k8s';
  if (haystack.includes('edge')) return 'edge';
  return 'local';
}
