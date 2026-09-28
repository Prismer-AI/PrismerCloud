// APC Root B (2026-07-25) — skill-sync ack backoff gate.
//
// The ack is re-issued on every sync trigger (per-dispatch / periodic / churny
// host.acked re-declares). Against a slow cloud an ack that just failed used to
// be re-fired on the very next trigger with no spacing. This proves a failed
// ack backs off (skips re-attempts inside its exponential window) and that
// success resets the streak.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ackSkillSync, __resetSkillAckBackoff } from '../src/daemon/skill-sync.js';
import type { CloudClient } from '../src/auth.js';

function mkCloud(request: ReturnType<typeof vi.fn>): CloudClient {
  return { request } as unknown as CloudClient;
}

describe('ackSkillSync backoff (APC Root B)', () => {
  beforeEach(() => {
    __resetSkillAckBackoff();
    delete process.env.PRISMER_DAEMON_ACK_BACKOFF;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PRISMER_DAEMON_ACK_BACKOFF;
  });

  it('skips a re-ack while the backoff window is open, retries after it elapses', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 500, error: { code: 'x', message: 'boom' } }));
    const cloud = mkCloud(request);

    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' });
    expect(request).toHaveBeenCalledTimes(1); // first attempt fires + fails → backoff arms

    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' });
    // MUTATION GUARD: remove the gate and this re-fires → 2.
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_500); // past the 2s base window
    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' });
    expect(request).toHaveBeenCalledTimes(2); // retried once the window elapsed
  });

  it('resets the streak on a successful ack', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, error: { code: 'x', message: 'boom' } })
      .mockResolvedValue({ ok: true, status: 200, data: null });
    const cloud = mkCloud(request);

    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' }); // fail → backoff
    vi.setSystemTime(2_500);
    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' }); // success → reset
    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' }); // immediate: gate is clear
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps per-(agent,slug) backoff independent', async () => {
    const request = vi.fn(async () => ({ ok: false, status: 500, error: { code: 'x', message: 'boom' } }));
    const cloud = mkCloud(request);

    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' }); // fail → a backs off
    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-b' }); // different key → fires
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('honors the PRISMER_DAEMON_ACK_BACKOFF=off kill-switch', async () => {
    process.env.PRISMER_DAEMON_ACK_BACKOFF = 'off';
    const request = vi.fn(async () => ({ ok: false, status: 500, error: { code: 'x', message: 'boom' } }));
    const cloud = mkCloud(request);

    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' });
    await ackSkillSync(cloud, 'agent-1', { slug: 'skill-a' });
    // Gate disabled ⇒ no skipping.
    expect(request).toHaveBeenCalledTimes(2);
  });
});
