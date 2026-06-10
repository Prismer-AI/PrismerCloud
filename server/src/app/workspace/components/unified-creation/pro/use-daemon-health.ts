'use client';

/**
 * §30 B3.5 — Daemon health polling hook for ProTileAgent.
 *
 * Wraps the 3-second `getLocalDaemonHealth()` polling pattern from
 * NewAgentDialog.useEffect (lines 210-234) plus derived "bindable" /
 * "workspace mismatch" booleans. Extracted so the hook's lifecycle
 * is co-located with its data and ProTileAgent stays under 250 lines.
 *
 * B0 Risk #2: the interval is cleared via the effect cleanup when the
 * hook unmounts (i.e. when the user navigates Back out of Pro→Agent).
 *
 * v200 K8S device picker (2026-05-19): `useDaemonTargets` is the new
 * multi-source hook that ProTileAgent uses; the older `useDaemonHealth`
 * stays for backward compatibility with any callers outside this folder.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { workspaceFetch } from '../../../lib/im-api';
import { getLocalDaemonHealth } from '../../../lib/mutations';
import type { LocalDaemonHealthDTO, RuntimeInstallationDTO } from '../../../lib/types';
import type { DaemonTarget, K8sDeviceDaemonTarget, LocalHostDaemonTarget } from './daemon-target';

export interface DaemonHealthState {
  daemon: LocalDaemonHealthDTO | null;
  error: string | null;
  ready: boolean;
  workspaceMismatch: boolean;
  bindable: boolean;
}

export function useDaemonHealth(workspaceId: string): DaemonHealthState {
  const [daemon, setDaemon] = useState<LocalDaemonHealthDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const res = await getLocalDaemonHealth();
      if (cancelled) return;
      if (res.ok) {
        setDaemon(res.data);
        setError(null);
      } else {
        setDaemon(null);
        setError(res.message);
      }
    }
    void probe();
    const id = setInterval(() => void probe(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ready = !!daemon?.wsConnected;
  const workspaceMismatch = !!workspaceId && !!daemon?.workspaceId && daemon.workspaceId !== workspaceId;
  const bindable = ready && !workspaceMismatch;
  return { daemon, error, ready, workspaceMismatch, bindable };
}

// ─────────────────────────────────────────────────────────────────────────────
// useDaemonTargets — multi-source host candidate hook (v200 K8S device picker)
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonTargetState {
  /** Sorted: local host first, then K8S devices ordered as the API returns. */
  targets: DaemonTarget[];
  loading: boolean;
  /** Most recent error fetching K8S devices (host failures fall through to a
   *  non-bindable host target rather than an error string). */
  error: string | null;
  /** Force a fresh poll cycle (e.g. after device-create completes elsewhere). */
  refresh: () => void;
}

const HOST_POLL_INTERVAL_MS = 3_000;
const K8S_POLL_INTERVAL_MS = 5_000;

/**
 * Collapse a /healthz result into a LocalHostDaemonTarget. Always returns a
 * target (offline → bindable:false, mismatchReason set). Exported for unit
 * testing the bindability decision matrix without spinning up the hook.
 */
export function buildLocalHostTarget(
  workspaceId: string,
  daemon: LocalDaemonHealthDTO | null,
  hostError: string | null,
): LocalHostDaemonTarget {
  if (!daemon) {
    return {
      source: 'local-host',
      daemonId: '',
      label: 'Local computer (not running)',
      workspaceId: null,
      bindable: false,
      mismatchReason: hostError ? `Local computer unreachable: ${hostError}` : 'Local computer unreachable',
    };
  }
  const wsConnected = !!daemon.wsConnected;
  const wsMatch = !workspaceId || !daemon.workspaceId || daemon.workspaceId === workspaceId;
  const bindable = wsConnected && wsMatch;
  let mismatchReason: string | undefined;
  if (!wsConnected) mismatchReason = 'Not connected to cloud';
  else if (!wsMatch) mismatchReason = `Paired to workspace ${daemon.workspaceId ?? '(none)'}`;
  return {
    source: 'local-host',
    daemonId: daemon.daemonId,
    label: `Local computer (${daemon.daemonId})`,
    workspaceId: daemon.workspaceId ?? null,
    bindable,
    mismatchReason,
  };
}

/**
 * Collapse a RuntimeInstallationDTO into a K8sDeviceDaemonTarget. Filters out
 * non-K8S rows at the call site (see useDaemonTargets). Exported for testing.
 */
export function buildK8sDeviceTarget(row: RuntimeInstallationDTO): K8sDeviceDaemonTarget {
  const statusRunning = row.containerStatus === 'running' || row.status === 'running' || row.status === 'bound';
  const daemonOk = row.daemonStatus === 'connected' || row.daemonStatus === 'stale';
  const hasGateway = !!row.gatewayUrl;
  const bindable = statusRunning && daemonOk && hasGateway;
  let mismatchReason: string | undefined;
  if (!statusRunning) mismatchReason = `Status: ${row.status}`;
  else if (!daemonOk) mismatchReason = 'Device offline';
  else if (!hasGateway) mismatchReason = 'No gateway URL yet';
  return {
    source: 'k8s-device',
    daemonId: row.daemonId ?? null,
    installationId: row.id,
    podName: row.podName,
    label: `K8S device ${row.podName} (${row.status})`,
    status: row.status,
    daemonStatus: row.daemonStatus,
    gatewayUrl: row.gatewayUrl,
    heartbeatAgeMs: row.metrics?.heartbeatAgeMs ?? null,
    bindable,
    mismatchReason,
  };
}

/**
 * Poll BOTH the local host daemon and the workspace's K8S devices. Returns a
 * merged DaemonTarget[] list — host first, then K8S devices. Pollers run
 * independently so a slow host probe doesn't gate the K8S list and vice-versa.
 *
 * Caller (ProTileAgent) renders a radio group; each row's `bindable` is the
 * authoritative gate for whether it can be selected as the agent host.
 */
export function useDaemonTargets(workspaceId: string): DaemonTargetState {
  const [hostDaemon, setHostDaemon] = useState<LocalDaemonHealthDTO | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [k8sRows, setK8sRows] = useState<RuntimeInstallationDTO[]>([]);
  const [k8sError, setK8sError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTickRef = useRef(0);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
    refreshTickRef.current += 1;
    setRefreshTick(refreshTickRef.current);
  }, []);

  // Host /healthz probe — every 3s, plus immediate on mount/refresh.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const res = await getLocalDaemonHealth();
      if (cancelled) return;
      if (res.ok) {
        setHostDaemon(res.data);
        setHostError(null);
      } else {
        setHostDaemon(null);
        setHostError(res.message);
      }
    }
    void probe();
    const id = setInterval(() => void probe(), HOST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshTick]);

  // K8S device list probe — every 5s, plus immediate on mount/refresh.
  // When workspaceId is empty we skip polling entirely; state stays at the
  // initial values (empty rows, no error, loading false after one tick).
  useEffect(() => {
    if (!workspaceId) {
      // Schedule the loading flip async so we don't trigger a cascading render
      // (eslint react-hooks rule: no sync setState inside an effect body).
      const t = setTimeout(() => setLoading(false), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    async function probe() {
      const res = await workspaceFetch<RuntimeInstallationDTO[]>(
        `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: 'GET' },
      );
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setK8sRows(Array.isArray(res.data) ? res.data : []);
        setK8sError(null);
      } else {
        setK8sError(res.message);
      }
    }
    void probe();
    const id = setInterval(() => void probe(), K8S_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId, refreshTick]);

  const targets: DaemonTarget[] = [
    buildLocalHostTarget(workspaceId, hostDaemon, hostError),
    ...k8sRows.filter((row) => (row.runtimeKind ?? 'docker') === 'k8s').map((row) => buildK8sDeviceTarget(row)),
  ];

  return { targets, loading, error: k8sError, refresh };
}
