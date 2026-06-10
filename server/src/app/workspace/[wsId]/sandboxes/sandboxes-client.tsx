'use client';

/**
 * Client component for /workspace/[wsId]/sandboxes.
 *
 * Refreshes container list every 5s via /api/sandboxes?workspaceId=...
 * (cache: no-store). Buttons proxy to /api/sandboxes/:id/{start,stop,snapshot}
 * and DELETE /api/sandboxes/:id.
 *
 * Visual style follows /admin/analytics — raw Tailwind on zinc palette,
 * matching the rest of the app (no Shadcn Card/Table components installed
 * in this codebase as of v1.8.2).
 */

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getWorkspaceToken } from '@/app/workspace/lib/im-api';

/**
 * Helper for /api/sandboxes/** session-bound calls. All routes use
 * authorizeContainer/authorizeWorkspace which require an Authorization
 * Bearer header (NextAuth session or platform JWT or active API key).
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getWorkspaceToken();
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface Container {
  id: string;
  podName: string;
  status: string;
  image: string;
  startedAt: string | null;
}

interface Props {
  workspaceId: string;
  initialContainers: Container[];
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
    case 'bound':
      return 'default';
    case 'pending':
    case 'warming':
    case 'stopping':
      return 'secondary';
    case 'errored':
      return 'destructive';
    default:
      return 'outline';
  }
}

export function SandboxesClient({ workspaceId, initialContainers }: Props) {
  const [containers, setContainers] = useState<Container[]>(initialContainers);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandboxes?workspaceId=${encodeURIComponent(workspaceId)}`, {
        cache: 'no-store',
        headers: authHeaders(),
      });
      if (!res.ok) {
        // 401/403 are non-fatal here — surface to user but don't keep alerting
        setError(`refresh: ${res.status}`);
        return;
      }
      const data = await res.json();
      setContainers((data.containers ?? []) as Container[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function createContainer() {
    setCreating(true);
    try {
      const res = await fetch('/api/sandboxes', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        alert(`Create failed (${res.status}): ${text}`);
      }
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function action(id: string, op: 'start' | 'stop') {
    const res = await fetch(`/api/sandboxes/${encodeURIComponent(id)}/${op}`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      alert(`${op} failed (${res.status}): ${text}`);
    }
    await refresh();
  }

  async function remove(id: string) {
    if (!confirm('Delete this sandbox? Disk will be discarded.')) return;
    const res = await fetch(`/api/sandboxes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      alert(`Delete failed (${res.status}): ${text}`);
    }
    await refresh();
  }

  async function snapshot(id: string) {
    const res = await fetch(`/api/sandboxes/${encodeURIComponent(id)}/snapshot`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      alert(`Snapshot failed (${res.status}): ${text}`);
      return;
    }
    const data = await res.json();
    alert(`Snapshot created: ${data?.snapshot?.imageTag ?? '<unknown>'}`);
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h2 className="text-lg font-semibold">Containers</h2>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <Button onClick={createContainer} disabled={creating}>
          {creating ? 'Creating…' : 'New sandbox'}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/50">
            <tr>
              <th className="px-5 py-2 text-left font-medium">ID</th>
              <th className="px-5 py-2 text-left font-medium">Image</th>
              <th className="px-5 py-2 text-left font-medium">Status</th>
              <th className="px-5 py-2 text-left font-medium">Started</th>
              <th className="px-5 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => (
              <tr
                key={c.id}
                className="border-t border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
              >
                <td className="px-5 py-3 font-mono text-xs">{c.id.slice(0, 8)}</td>
                <td className="px-5 py-3">{c.image}</td>
                <td className="px-5 py-3">
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                </td>
                <td className="px-5 py-3 text-zinc-600 dark:text-zinc-400">
                  {c.startedAt ? new Date(c.startedAt).toLocaleString() : '—'}
                </td>
                <td className="px-5 py-3 text-right space-x-1 whitespace-nowrap">
                  <Button variant="outline" size="sm" onClick={() => action(c.id, 'start')}>
                    Start
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => action(c.id, 'stop')}>
                    Stop
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => snapshot(c.id)}>
                    Snapshot
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(c.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {containers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-12 text-center text-zinc-500 dark:text-zinc-400">
                  No sandboxes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
