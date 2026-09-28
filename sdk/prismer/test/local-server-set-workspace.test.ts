// F1-b (2026-07-27) — POST /v1/workspace, the control surface the desktop uses to
// retarget a RUNNING daemon at another workspace.
//
// Why this route exists at all: before it, a live daemon had no way to learn that
// the user switched workspaces. `config.toml` carries no workspace field,
// `PRISMER_WORKSPACE_ID` is frozen at spawn, and `GET /workspaces/sync` has a
// client method with zero callers. The daemon declared into its boot workspace
// forever — a restart was the only escape, and (see j43) not even that worked,
// because cloud pinned it separately.
//
// This test covers the HTTP contract only (framing + validation + the runner hook
// being reached). The end-to-end effect — cloud actually re-binding the device row
// to the new workspace — is `scripts/test203/journeys/j43-daemon-workspace-redeclare.ts`
// against the real cloud + MySQL, because that is where the interesting failure was.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServer, type LocalServerState } from '../src/daemon/local-server.js';
import { boundBaseUrl } from './_helpers/listen-ephemeral.js';

let server: LocalServer | undefined;
let baseUrl = '';
/** Every workspaceId the route handed to the runner hook, in order. */
let seen: string[] = [];

const baseState: LocalServerState = {
  daemonId: 'dev_test',
  daemonVersion: '0.0.0-test',
  cloudBaseUrl: 'http://cloud.test',
  workspaceId: null,
  pid: 99999,
  startedAt: Date.now(),
  wsConnected: false,
  hostedAgents: [],
  runningTaskIds: [],
};

/** Stands in for Runner.setDeclaredWorkspace — same de-dupe semantics. */
function makeHook(initial: string) {
  let current = initial;
  return (workspaceId: string) => {
    seen.push(workspaceId);
    if (workspaceId === current) return { changed: false, workspaceId: current, declared: false };
    current = workspaceId;
    return { changed: true, workspaceId: current, declared: true };
  };
}

async function post(body: unknown, raw?: string) {
  return fetch(`${baseUrl}/v1/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

async function boot(opts: { withHook: boolean }) {
  seen = [];
  server = new LocalServer({
    port: 0,
    getState: () => baseState,
    ...(opts.withHook ? { onSetWorkspace: makeHook('ws_boot') } : {}),
  });
  await server.start();
  baseUrl = boundBaseUrl(server);
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('POST /v1/workspace', () => {
  beforeEach(() => boot({ withHook: true }));

  it('retargets the daemon and reports the change', async () => {
    const res = await post({ workspaceId: 'ws_team_b' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true, workspaceId: 'ws_team_b', declared: true });
    expect(seen).toEqual(['ws_team_b']);
  });

  it('is idempotent — re-pushing the current workspace is a no-op, not a declare', async () => {
    // The desktop fires this on EVERY prefs write, so a non-idempotent route would
    // turn appearance/locale edits into a declare storm against cloud.
    await post({ workspaceId: 'ws_team_b' });
    const res = await post({ workspaceId: 'ws_team_b' });
    expect(await res.json()).toEqual({ changed: false, workspaceId: 'ws_team_b', declared: false });
  });

  it('trims and rejects blank ids without reaching the runner', async () => {
    expect((await post({ workspaceId: '   ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ workspaceId: 42 })).status).toBe(400);
    // The hook must not be called for any of them — a blank push must never clear
    // the daemon's current binding.
    expect(seen).toEqual([]);
    const ok = await post({ workspaceId: '  ws_padded  ' });
    expect((await ok.json()) as { workspaceId: string }).toMatchObject({ workspaceId: 'ws_padded' });
  });

  it('rejects malformed JSON', async () => {
    expect((await post(null, '{not json')).status).toBe(400);
  });
});

describe('POST /v1/workspace without the runner hook', () => {
  beforeEach(() => boot({ withHook: false }));

  it('answers 501 rather than silently accepting', async () => {
    // An embedder that never wired onSetWorkspace must NOT look like it honoured
    // the push — a 200 here would make the desktop believe it retargeted a daemon
    // that in fact kept declaring into its boot workspace.
    const res = await post({ workspaceId: 'ws_team_b' });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'set_workspace_unavailable' });
  });
});
