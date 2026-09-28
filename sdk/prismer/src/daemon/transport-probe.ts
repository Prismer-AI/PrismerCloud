// Daemon-side transport probe (v2.0 §4.8.1, Wave 4-E4).
//
// At startup the daemon inspects:
//   - whether its WS upstream is alive (always 'ws' available once connected)
//   - whether its local HTTP server is bound and what address it listens on
//   - whether the local server is reachable from outside the host
//
// It then reports the assessment to cloud via
//   POST /api/im/runtime/transport-report
// which updates im_containers.transport / gatewayIsPrivate / lastProbeAt
// so cloud-side dispatchExternalMention can choose the right transport.
//
// This is the daemon's input to §4.8.1's recommendedTransport calculation.
// The cloud-side /runtime/diagnose endpoint reads what we report here AND
// runs its own HEAD /healthz probe so the two perspectives can be compared.

import { networkInterfaces } from 'node:os';
import type { CloudClient } from '../auth.js';

export type TransportKind = 'ws' | 'http' | 'both';

export interface TransportProbeResult {
  transport: TransportKind;
  gatewayUrl: string | null;
  /**
   * RFC1918 / link-local / loopback assessment from the daemon's local
   * network interfaces. Daemons running inside a NAT / private LAN cannot
   * be dialed by cloud over HTTP regardless of what the gateway URL looks
   * like. Cloud uses this to skip the HTTP fallback path.
   */
  gatewayIsPrivate: boolean;
}

/**
 * Decide whether a hostname/IP is private (RFC1918 / link-local / loopback /
 * CGNAT). Mirrors `src/im/services/ws-rpc.service.ts isPrivateIpToCloud`
 * but duplicated here so the daemon SDK does not depend on cloud source.
 */
export function isPrivateAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  const h = String(addr).trim().toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

/**
 * Build a transport-probe report from the daemon's perspective.
 *
 * Heuristic:
 *   - WS is always available (the daemon is only running this code because
 *     ws-client successfully connected to cloud).
 *   - HTTP is available iff `gatewayUrl` is non-null AND its host is NOT a
 *     private address. (We do NOT attempt outbound probes here — the daemon
 *     can't tell whether cloud can reach it from inside its own network;
 *     cloud will run its own HEAD /healthz probe via /runtime/diagnose.)
 *   - When `gatewayUrl` is non-null but private (typical for an end-user
 *     desktop daemon), report `transport='ws'` and `gatewayIsPrivate=true`
 *     so cloud knows HTTP fallback is off the table cross-network.
 *
 * `gatewayUrl` is whatever the daemon would surface in `im_containers.gatewayUrl`
 * (e.g. `http://192.168.1.10:3210`). For a daemon with no inbound HTTP
 * server at all, pass `null`.
 */
export function buildTransportProbe(gatewayUrl: string | null): TransportProbeResult {
  if (!gatewayUrl) {
    return { transport: 'ws', gatewayUrl: null, gatewayIsPrivate: true };
  }
  let host: string | null = null;
  try {
    host = new URL(gatewayUrl).hostname;
  } catch {
    host = null;
  }
  const gatewayIsPrivate = isPrivateAddress(host);
  // The local HTTP server is always serving on the gateway URL — but cloud
  // can only reach it when it's a public IP. We still report 'both' so a
  // same-network deployment (k8s pod with a private cluster IP that cloud
  // CAN reach because cloud is also in-cluster) gets correctly attributed.
  // The cloud-side dispatch path adds its own isPrivateIpToCloud() check
  // anyway, so reporting transport='both' here is informational, not policy.
  return {
    transport: gatewayIsPrivate ? 'ws' : 'both',
    gatewayUrl,
    gatewayIsPrivate,
  };
}

/**
 * Pick a representative local IPv4 address for the daemon to surface as
 * gatewayUrl. Skips loopback and prefers non-internal NICs.
 *
 * Returns null when no usable interface is found (e.g. headless container
 * with no networking — daemon falls back to WS-only mode).
 */
export function pickLocalIPv4(): string | null {
  const nics = networkInterfaces();
  // Prefer non-private addresses (rare on consumer machines but possible
  // for cloud-hosted daemons). Otherwise return the first private IPv4.
  let firstPrivate: string | null = null;
  for (const list of Object.values(nics)) {
    if (!list) continue;
    for (const ni of list) {
      if (ni.internal || ni.family !== 'IPv4') continue;
      if (!isPrivateAddress(ni.address)) return ni.address;
      if (!firstPrivate) firstPrivate = ni.address;
    }
  }
  return firstPrivate;
}

/**
 * POST the probe to cloud. Best-effort — caller logs failures but does NOT
 * abort daemon startup (probe is observability, not a correctness gate).
 */
export async function reportTransportProbe(
  cloud: CloudClient,
  daemonId: string,
  probe: TransportProbeResult,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const body = {
    daemonId,
    transport: probe.transport,
    gatewayUrl: probe.gatewayUrl,
    gatewayIsPrivate: probe.gatewayIsPrivate,
  };
  const res = await cloud.request('POST', '/api/im/runtime/transport-report', {
    body,
    timeoutMs: 5_000,
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error?.message ?? `transport-report failed (${res.status})`,
    };
  }
  return { ok: true, status: res.status };
}
