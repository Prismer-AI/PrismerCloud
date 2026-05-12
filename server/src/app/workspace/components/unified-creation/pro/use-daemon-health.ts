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
 */

import { useEffect, useState } from 'react';

import { getLocalDaemonHealth } from '../../../lib/mutations';
import type { LocalDaemonHealthDTO } from '../../../lib/types';

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
