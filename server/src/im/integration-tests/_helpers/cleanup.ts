/**
 * Best-effort suite cleanup.
 *
 * The cloud has a hard-delete endpoint (`DELETE /workspaces/:id?confirmName=…`)
 * — see commit cef45d0a `feat(workspace): hard-delete workspace cascade`.
 * It streams SSE progress events; for cleanup we don't care about the stream,
 * we just need the side-effect (cascade delete of workspace + members +
 * conversations + tasks + agent cards + active pods). The stream completes
 * the work even when we discard the body, but we still read it to ensure the
 * server flushes all `progress`/`complete` writes before we move on.
 *
 * Errors are swallowed — cleanup is best-effort; the next test should not
 * fail because a previous one couldn't clear its sandbox.
 */

import { api } from './http';
import type { TestActor } from './bootstrap';

export async function deleteTestWorkspace(workspaceId: string, owner: TestActor): Promise<void> {
  try {
    // We need the workspace `name` for the confirmName guard. Fetch it first.
    const detail = await api<{ ok: boolean; data?: { name: string } }>('GET', `/workspaces/${workspaceId}`, {
      actor: owner,
    });
    if (!detail.data?.ok || !detail.data?.data?.name) {
      return;
    }
    const confirmName = detail.data.data.name;
    await api('DELETE', `/workspaces/${workspaceId}`, {
      actor: owner,
      query: { confirmName },
      headers: { Accept: 'text/event-stream' },
    });
  } catch {
    // Swallow — cleanup is best-effort.
  }
}
