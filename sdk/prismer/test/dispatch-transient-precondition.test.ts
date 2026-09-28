// release202 (HTTP 404 dispatch postmortem) — classification of dispatch
// PRECONDITION failures (profile / context fetch) into TRANSIENT (warm-up 404,
// rate-limit, network → retry then re-queue) vs PERMANENT (400/401/403 → fail).
//
// Pins the root-cause fix: a freshly-(re)connected daemon's first profile fetch
// can 404 before its api-key-proxy identity is hot. That 404 must be treated as
// transient (retried in-process by resolveProfileResilient, then re-queued by
// the cloud) instead of surfacing the terminal "Agent 失败 … HTTP 404" pill.
import { describe, it, expect } from 'vitest';
import { isTransientPreconditionError, resolveProfileResilient } from '../src/daemon/dispatch.js';
import { CloudError } from '../src/auth.js';
import type { AgentProfile } from '../src/adapters/contract.js';

describe('isTransientPreconditionError', () => {
  it('TRANSIENT: 404 on a precondition fetch (the warm-up identity race)', () => {
    expect(isTransientPreconditionError(new CloudError(404, 'not_found', 'HTTP 404'))).toBe(true);
  });

  it('TRANSIENT: 408 / 429 / 5xx', () => {
    expect(isTransientPreconditionError(new CloudError(408, 'timeout', 'HTTP 408'))).toBe(true);
    expect(isTransientPreconditionError(new CloudError(429, 'rate_limited', 'HTTP 429'))).toBe(true);
    expect(isTransientPreconditionError(new CloudError(500, 'server_error', 'HTTP 500'))).toBe(true);
    expect(isTransientPreconditionError(new CloudError(503, 'unavailable', 'HTTP 503'))).toBe(true);
  });

  it('TRANSIENT: network / abort (no status) and cloud_unreachable', () => {
    expect(isTransientPreconditionError(new CloudError(undefined as unknown as number, 'cloud_unreachable', 'fetch failed'))).toBe(true);
    expect(isTransientPreconditionError(new CloudError(0, 'cloud_unreachable', 'aborted'))).toBe(true);
  });

  it('PERMANENT: 400 / 401 / 403 — real validation / auth failures', () => {
    expect(isTransientPreconditionError(new CloudError(400, 'bad_request', 'HTTP 400'))).toBe(false);
    expect(isTransientPreconditionError(new CloudError(401, 'auth_invalid', 'HTTP 401'))).toBe(false);
    expect(isTransientPreconditionError(new CloudError(403, 'auth_invalid', 'HTTP 403'))).toBe(false);
  });

  it('non-CloudError → not classified as a transient precondition', () => {
    expect(isTransientPreconditionError(new Error('boom'))).toBe(false);
    expect(isTransientPreconditionError('HTTP 404')).toBe(false);
    expect(isTransientPreconditionError(undefined)).toBe(false);
  });
});

// G-C (2026-08-23) — local agent_profiles mirror fallback: standalone /
// disconnected daemons must still resolve profiles after cloud retries are
// exhausted (m4 mirror). Cloud-first stays authoritative; permanent cloud
// errors must NOT be shadowed by a stale local row.
describe('resolveProfileResilient local mirror fallback', () => {
  function makeProfile(id: string): AgentProfile {
    return {
      id,
      workspaceId: 'ws-local',
      agentImUserId: 'agent-local',
      adapterName: 'pi-core',
      name: 'Pi Core',
      config: {},
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const payload = {
    taskId: 'task-local-mirror',
    profileId: 'profile-local',
    agentImUserId: 'agent-local',
  };

  it('cloud success → local mirror is NOT consulted', async () => {
    const profile = makeProfile('profile-cloud');
    const cloud = { get: async () => profile } as never;
    let consulted = false;
    const result = await resolveProfileResilient(payload, cloud, undefined, () => {
      consulted = true;
      return null;
    });
    expect(result.id).toBe('profile-cloud');
    expect(consulted).toBe(false);
  });

  it('cloud transient failures exhausted → local mirror serves the profile', async () => {
    const cloud = {
      get: async () => {
        throw new CloudError(undefined as unknown as number, 'cloud_unreachable', 'fetch failed');
      },
    } as never;
    const localProfile = makeProfile('profile-local');
    const result = await resolveProfileResilient(payload, cloud, undefined, () => localProfile);
    expect(result.id).toBe('profile-local');
  });

  it('persistent 404 (auth warmed, profile genuinely absent) → rethrows, local mirror NOT consulted', async () => {
    // 404 IS retried (the warm-up identity race), but a 404 that SURVIVES all
    // retries is an authenticated "not found" — a deleted/missing profile.
    // Serving a stale local mirror row would mask it and run an agent the
    // cloud has already retired. Only NETWORK-class failures (no status /
    // cloud_unreachable / 5xx) may fall back to the mirror.
    const cloud = {
      get: async () => {
        throw new CloudError(404, 'not_found', 'HTTP 404');
      },
    } as never;
    let consulted = false;
    await expect(
      resolveProfileResilient(payload, cloud, undefined, () => {
        consulted = true;
        return makeProfile('profile-local');
      }),
    ).rejects.toThrow(/404/);
    expect(consulted).toBe(false);
  });

  it('persistent 5xx (server-side outage) → local mirror serves the profile', async () => {
    const cloud = {
      get: async () => {
        throw new CloudError(503, 'internal_error', 'HTTP 503');
      },
    } as never;
    const localProfile = makeProfile('profile-local');
    const result = await resolveProfileResilient(payload, cloud, undefined, () => localProfile);
    expect(result.id).toBe('profile-local');
  });

  it('cloud permanent error (403) → rethrows, local mirror NOT consulted', async () => {
    const cloud = {
      get: async () => {
        throw new CloudError(403, 'auth_invalid', 'HTTP 403');
      },
    } as never;
    let consulted = false;
    await expect(
      resolveProfileResilient(payload, cloud, undefined, () => {
        consulted = true;
        return makeProfile('profile-local');
      }),
    ).rejects.toThrow();
    expect(consulted).toBe(false);
  });

  it('both miss → throws the original cloud error', async () => {
    const cloud = {
      get: async () => {
        throw new CloudError(undefined as unknown as number, 'cloud_unreachable', 'fetch failed');
      },
    } as never;
    await expect(resolveProfileResilient(payload, cloud, undefined, () => null)).rejects.toThrow();
  });
});
