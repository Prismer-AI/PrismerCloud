// release202/05 C2 — ProviderSessionMapper unit tests.
// In-memory better-sqlite3 db via the real store migrations (which include the
// v8 provider_session_id column). Pure DB round-trip — no spawn, no network.

import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../src/sync/store.js';
import { ProviderSessionMapper } from '../src/daemon/provider-session-mapper.js';

const CONV = 'conv-1';
const AGENT = 'agent-1';

function freshMapper(): ProviderSessionMapper {
  const db = openLocalDb(':memory:');
  return new ProviderSessionMapper(db);
}

describe('ProviderSessionMapper', () => {
  it('get() returns null when empty', () => {
    const mapper = freshMapper();
    expect(mapper.get(CONV, AGENT, 'codex')).toBe(null);
  });

  it('get() guards empty inputs → null', () => {
    const mapper = freshMapper();
    mapper.put(CONV, AGENT, 'codex', 'sess-1');
    expect(mapper.get('', AGENT, 'codex')).toBe(null);
    expect(mapper.get(CONV, '', 'codex')).toBe(null);
    expect(mapper.get(CONV, AGENT, '')).toBe(null);
  });

  it('put() then get() round-trips by (conv, agent, adapter)', () => {
    const mapper = freshMapper();
    mapper.put(CONV, AGENT, 'codex', 'sess-codex-1', {
      taskId: 'task-1',
      workspaceId: 'ws-1',
    });
    expect(mapper.get(CONV, AGENT, 'codex')).toBe('sess-codex-1');
  });

  it('isolates different adapterName for the same (conv, agent)', () => {
    const mapper = freshMapper();
    mapper.put(CONV, AGENT, 'codex', 'sess-codex');
    mapper.put(CONV, AGENT, 'claude-code', 'sess-claude');
    expect(mapper.get(CONV, AGENT, 'codex')).toBe('sess-codex');
    expect(mapper.get(CONV, AGENT, 'claude-code')).toBe('sess-claude');
  });

  it('get() returns the latest by created_at', () => {
    const db = openLocalDb(':memory:');
    const mapper = new ProviderSessionMapper(db);
    // Two rows for the same triple with explicit created_at ordering. We can't
    // rely on Date.now() resolution between two fast put()s, so insert the
    // older row directly with a smaller created_at, then put() the newer one.
    db.prepare(
      `INSERT OR REPLACE INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at,
          provider_session_id)
       VALUES (?, ?, NULL, ?, '', '', NULL, 'codex', ?, ?)`,
    ).run('psession:codex:old', CONV, AGENT, 1000, 'sess-old');
    db.prepare(
      `INSERT OR REPLACE INTO local_run_sessions
         (run_id, conversation_id, task_id, agent_im_user_id, workspace_id,
          profile_name, role_template_slug, adapter_name, created_at,
          provider_session_id)
       VALUES (?, ?, NULL, ?, '', '', NULL, 'codex', ?, ?)`,
    ).run('psession:codex:new', CONV, AGENT, 2000, 'sess-new');
    expect(mapper.get(CONV, AGENT, 'codex')).toBe('sess-new');
  });
});
