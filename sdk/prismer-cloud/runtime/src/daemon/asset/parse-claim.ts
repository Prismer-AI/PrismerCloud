// Daemon-side client for the ingest-claim coordination protocol.
// See src/im/api/ingest-claims.ts on the cloud side.
//
// Typical lifecycle in the daemon parse worker:
//
//   const ctrl = new ParseClaimController({ cloud, deviceId });
//   const result = await ctrl.acquire({ assetId, ingestVersion });
//   if (result.kind === 'claimed_active' || result.kind === 'already_complete') {
//     return; // another daemon owns it, or the work is already complete
//   }
//   const claimId = result.claim.id;
//   const hb = ctrl.startHeartbeat(claimId, { onLost: () => abortParseWork() });
//   try {
//     await runParse(...);
//     await ctrl.complete(claimId);
//   } finally {
//     hb.stop();
//   }

import type { CloudClient } from '../../auth.js';

export interface ParseClaim {
  id: string;
  workspaceId: string;
  assetId: string;
  ingestVersion: number;
  claimantImUserId: string;
  claimantDeviceId: string;
  status: 'active' | 'completed' | 'abandoned';
  claimedAt: string;
  heartbeatAt: string;
  completedAt: string | null;
}

export type AcquireResult =
  | { kind: 'acquired'; claim: ParseClaim }
  | { kind: 'refreshed'; claim: ParseClaim }
  | { kind: 'claimed_active'; current: ParseClaim }
  | { kind: 'already_complete'; current: ParseClaim };

export type ClaimLostReason = 'claim_taken_over' | 'claim_inactive';

/**
 * Thrown by sendHeartbeat / complete when the server returns 410 with a
 * recognized lost-claim code. The heartbeat loop catches this and stops
 * itself; callers of sendHeartbeat directly should branch on `err instanceof
 * ClaimLostError` instead of parsing strings.
 */
export class ClaimLostError extends Error {
  constructor(public readonly reason: ClaimLostReason) {
    super(`Claim lost: ${reason}`);
    this.name = 'ClaimLostError';
  }
}

export interface ParseClaimControllerOptions {
  cloud: CloudClient;
  /** Daemon's persisted device id. Same value across heartbeats / completions. */
  deviceId: string;
  /** Heartbeat interval (ms). Default 10s — well below the 30s server TTL. */
  heartbeatIntervalMs?: number;
}

export interface HeartbeatHandle {
  stop: () => void;
  /**
   * Symbol.dispose so consumers can write `using hb = ctrl.startHeartbeat(...)`
   * once they're on TypeScript 5.2 + Node 22 explicit-resource-management.
   * Without that runtime support the field is harmless dead weight; the
   * explicit `stop()` is the universal contract.
   */
  [Symbol.dispose]: () => void;
}

/**
 * Coordinates a single daemon's asset-parse claims. Owns no global state —
 * callers may run multiple controllers if they share the same device id.
 */
export class ParseClaimController {
  private readonly cloud: CloudClient;
  private readonly deviceId: string;
  private readonly heartbeatIntervalMs: number;

  constructor(opts: ParseClaimControllerOptions) {
    this.cloud = opts.cloud;
    this.deviceId = opts.deviceId;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
  }

  /**
   * Acquire (or refresh) a claim. The return value is a 4-variant tagged
   * union — callers must branch on `kind`. Throws on transport / 5xx / 4xx
   * codes that aren't part of the documented contract (e.g. `claim_race`
   * is mapped to a thrown Error so the worker can retry).
   */
  async acquire(input: { assetId: string; ingestVersion: number }): Promise<AcquireResult> {
    const res = await this.cloud.request<{
      ok: boolean;
      data?: ParseClaim;
      error?: { code: string; message: string };
      meta?: { claim?: ParseClaim };
    }>('POST', '/api/im/ingest/claims', {
      body: {
        assetId: input.assetId,
        ingestVersion: input.ingestVersion,
        deviceId: this.deviceId,
      },
    });

    if (res.ok && res.data?.ok && res.data.data) {
      // 201 fresh acquire vs 200 refresh — both surface .data.data; the
      // server distinguishes via HTTP status. We use 201 → acquired,
      // 200 → refreshed.
      return res.status === 201
        ? { kind: 'acquired', claim: res.data.data }
        : { kind: 'refreshed', claim: res.data.data };
    }

    // Envelope-error path (cloud returned 4xx with ApiResponse error object).
    if (res.status === 409 && res.data && !res.data.ok) {
      const code = res.data.error?.code;
      const current = res.data.meta?.claim;
      if (code === 'claimed_active' && current) return { kind: 'claimed_active', current };
      if (code === 'already_complete' && current) return { kind: 'already_complete', current };
    }

    throw new Error(
      `Claim acquire failed (HTTP ${res.status}): ${res.error?.message ?? res.data?.error?.message ?? 'unknown'}`,
    );
  }

  /**
   * Refresh the heartbeat for an active claim. Throws `ClaimLostError` on
   * HTTP 410 with code `claim_taken_over` or `claim_inactive` — caller
   * should abort the parse work. Throws plain `Error` on any other failure.
   */
  async sendHeartbeat(claimId: string): Promise<ParseClaim> {
    const res = await this.cloud.request<{ ok: boolean; data?: ParseClaim; error?: { code: string; message: string } }>(
      'POST',
      `/api/im/ingest/claims/${encodeURIComponent(claimId)}/heartbeat`,
      { body: { deviceId: this.deviceId } },
    );
    if (res.status === 410 && res.data && !res.data.ok) {
      const code = res.data.error?.code;
      if (code === 'claim_taken_over' || code === 'claim_inactive') {
        throw new ClaimLostError(code);
      }
    }
    if (!res.ok || !res.data?.ok || !res.data.data) {
      throw new Error(
        `Heartbeat failed (HTTP ${res.status}): ${res.error?.message ?? res.data?.error?.message ?? 'unknown'}`,
      );
    }
    return res.data.data;
  }

  /**
   * Mark a claim complete. Throws `ClaimLostError` on 410 (claim was
   * stolen before the worker finished — output should be discarded).
   */
  async complete(claimId: string): Promise<ParseClaim> {
    const res = await this.cloud.request<{ ok: boolean; data?: ParseClaim; error?: { code: string; message: string } }>(
      'POST',
      `/api/im/ingest/claims/${encodeURIComponent(claimId)}/complete`,
      { body: { deviceId: this.deviceId } },
    );
    if (res.status === 410 && res.data && !res.data.ok) {
      const code = res.data.error?.code;
      if (code === 'claim_taken_over' || code === 'claim_inactive') {
        throw new ClaimLostError(code);
      }
    }
    if (!res.ok || !res.data?.ok || !res.data.data) {
      throw new Error(
        `Complete failed (HTTP ${res.status}): ${res.error?.message ?? res.data?.error?.message ?? 'unknown'}`,
      );
    }
    return res.data.data;
  }

  /**
   * Start a heartbeat loop in the background. Returns a handle with `stop()`
   * and a Symbol.dispose alias for the `using` pattern.
   *
   * On 410 (claim taken over or marked inactive) the loop stops itself and
   * invokes `opts.onLost` so the parse worker can abort. Other transient
   * errors (network blip, 5xx) are logged to stderr and the loop retries on
   * the next tick — the server-side TTL (default 30s) will only drop us if
   * the partition outlasts the TTL.
   */
  startHeartbeat(
    claimId: string,
    opts?: { onLost?: (reason: ClaimLostReason) => void },
  ): HeartbeatHandle {
    let stopped = false;
    let handle: NodeJS.Timeout | undefined;
    const stop = () => {
      stopped = true;
      if (handle) clearInterval(handle);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        await this.sendHeartbeat(claimId);
      } catch (err) {
        if (err instanceof ClaimLostError) {
          stop();
          opts?.onLost?.(err.reason);
          return;
        }
        process.stderr.write(`[parse-claim] heartbeat ${claimId} failed: ${(err as Error).message}\n`);
      }
    };
    handle = setInterval(() => void tick(), this.heartbeatIntervalMs);
    return {
      stop,
      [Symbol.dispose]: stop,
    };
  }
}
