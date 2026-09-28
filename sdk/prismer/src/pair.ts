// QR-pair flow. See docs/refactor/04-daemon-runtime.md §Pair flow and
// 03-ws-protocol.md §Pair endpoint.
//
// Flow:
//   1. Generate ephemeral ed25519 keypair (replay-protection only; not stored).
//   2. POST /api/im/pair/offer { devicePub, deviceName } → { nonce, qrUrl }
//   3. Print QR + instructional URL on the terminal.
//   4. Short-poll GET /api/im/pair/poll/:nonce until 200 returns { apiKey }.
//   5. Save api_key + cloud_api_base + freshly-minted daemon_id to config.toml.
//
// LOCAL_ONLY bypass (Wave-6 α): when `asUserEmail` is provided AND
// `LOCAL_ONLY=1`, step 3 is skipped (no QR, no browser) and step 3.5 calls
// POST /api/im/pair/local-only-approve before the poll loop, so the very
// first poll consumes the freshly-minted key. Used by the release54 harness
// to drive the daemon end-to-end without human interaction. Cloud-side gate
// (NODE_ENV !== 'production') makes this physically inaccessible from prod.

import { generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import qrcode from 'qrcode';
import { CloudClient } from './auth.js';
import { type Config, type ConfigPaths, configExists, resolvePaths, saveConfig } from './config.js';
import { newDaemonId } from './daemon-id.js';

export interface PairOptions {
  cloudBaseUrl: string;
  /** Human-readable label visible to the approver in mobile UI. */
  deviceName?: string;
  /** Override config save path (tests). */
  paths?: ConfigPaths;
  /** Number of poll attempts (5 s each). Default 60 → 5 min. */
  maxPollAttempts?: number;
  /** Pluggable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Allow overwriting existing config. Default false. */
  force?: boolean;
  /** Hook for test capture of the QR URL. */
  onQrReady?: (qrUrl: string) => void;
  /**
   * LAN-dev bypass: skip QR + mobile approval and auto-approve the offer
   * as the named human IMUser. Requires `LOCAL_ONLY=1` in this process AND
   * cloud-side `LOCAL_ONLY=1 && NODE_ENV !== 'production'`. Without those
   * env conditions the cloud returns 403 and we surface the error.
   */
  asUserEmail?: string;
  /** Override LOCAL_ONLY env read (tests). */
  isLocalOnly?: () => boolean;
  /** Override poll wait (tests). Default 5_000ms. */
  pollIntervalMs?: number;
}

export interface PairResult {
  config: Config;
  paths: ConfigPaths;
}

interface OfferResponse {
  nonce: string;
  qrUrl: string;
}

interface PollResponse {
  apiKey: string;
}

export async function pair(opts: PairOptions): Promise<PairResult> {
  const paths = opts.paths ?? resolvePaths();
  if (configExists(paths) && !opts.force) {
    throw new Error(
      `Config already exists at ${paths.configFile}. Pass --force to overwrite, or run \`prismer status\` to inspect.`,
    );
  }

  // LAN-dev bypass gate. `--as-user` requires LOCAL_ONLY=1 — otherwise the
  // CLI is being asked to skip the human approver in a context where that
  // would be a privilege escalation. Refuse loudly. The cloud-side check
  // (NODE_ENV !== 'production') is the second line of defense.
  const isLocalOnly = opts.isLocalOnly ?? (() => process.env.LOCAL_ONLY === '1');
  const localOnlyMode = !!opts.asUserEmail;
  if (localOnlyMode && !isLocalOnly()) {
    throw new Error(
      'pair: --as-user requires LOCAL_ONLY=1. ' +
        'Without that gate, this would skip mobile approval and silently mint a key for the named user.',
    );
  }

  // 1. Ephemeral keypair (raw public key serialized as DER hex; cloud only uses
  // this to dedupe replays and bind the offer to a single daemon attempt.
  // We do NOT store the private key — once approval lands the api_key is the
  // long-lived credential).
  const { publicKey } = generateKeyPairSync('ed25519');
  const devicePub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  // 2. Offer
  const cloud = new CloudClient({
    baseUrl: opts.cloudBaseUrl,
    apiKey: 'pending', // not used: we pass auth:false
    fetchImpl: opts.fetchImpl,
  });
  const offerRes = await cloud.request<OfferResponse | { ok?: boolean; data?: OfferResponse }>(
    'POST',
    '/api/im/pair/offer',
    {
      auth: false,
      body: { devicePub, deviceName: opts.deviceName ?? hostname() },
    },
  );
  if (!offerRes.ok) {
    throw new Error(`pair: offer failed (${offerRes.status}): ${offerRes.error?.message}`);
  }
  const offer = unwrapEnvelope<OfferResponse>(offerRes.data);
  if (!offer.nonce || !offer.qrUrl) {
    throw new Error('pair: cloud returned no nonce/qrUrl');
  }

  // 3. Approval path branch.
  if (localOnlyMode) {
    // LAN-dev: the cloud auto-approves on our behalf. Skip QR + mobile
    // entirely. After this returns 200 the offer is approved server-side
    // and the next poll will consume the api key.
    const approveRes = await cloud.request<{ ok?: boolean; error?: { code?: string; message?: string } }>(
      'POST',
      '/api/im/pair/local-only-approve',
      {
        auth: false,
        body: { nonce: offer.nonce, asUserEmail: opts.asUserEmail },
      },
    );
    if (!approveRes.ok) {
      throw new Error(
        `pair: local-only-approve failed (${approveRes.status}): ${approveRes.error?.message ?? 'unknown'}`,
      );
    }
    process.stdout.write(`[pair] LOCAL_ONLY approved as ${opts.asUserEmail} — no QR shown\n`);
  } else {
    // Standard path: print QR for the human approver.
    const qrAscii = await qrcode.toString(offer.qrUrl, { type: 'terminal', small: true });
    process.stdout.write(qrAscii);
    process.stdout.write(`\nScan with Lumin to approve, or open: ${offer.qrUrl}\n\n`);
    opts.onQrReady?.(offer.qrUrl);
  }

  // 4. Poll. Cloud /pair/poll/:nonce requires ?devicePub=… so passive QR
  // observers can't race — only the device that created the offer can
  // redeem it. devicePub here is the same DER-base64 we sent to /offer.
  // In local-only mode the offer is already approved, so the very first
  // poll consumes the api key with no sleep — the harness gate budgets
  // <10s wall time and a 5s pre-sleep would blow that.
  const pollPath = `/api/im/pair/poll/${encodeURIComponent(offer.nonce)}?devicePub=${encodeURIComponent(devicePub)}`;
  const maxAttempts = opts.maxPollAttempts ?? 60;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0 || !localOnlyMode) {
      await sleep(pollIntervalMs);
    }
    const res = await cloud.request<PollResponse | { ok?: boolean; data?: PollResponse }>(
      'GET',
      pollPath,
      { auth: false },
    );
    if (res.ok) {
      const body = unwrapEnvelope<PollResponse>(res.data);
      if (body.apiKey) {
        // 5. Save config
        // F14 (2026-05-20) — stable daemonId per (hostname, apiKey) so the
        // device dedupes on cloud across reset/repair cycles.
        const config: Config = {
          api_key: body.apiKey,
          cloud_api_base: opts.cloudBaseUrl,
          daemon_id: newDaemonId({ apiKey: body.apiKey }),
        };
        saveConfig(config, paths);
        return { config, paths };
      }
    }
    if (res.status === 404 || res.status === 202) {
      // Waiting for approval — keep polling.
      continue;
    }
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`pair: poll failed (${res.status}): ${res.error?.message}`);
    }
  }
  throw new Error('pair: timed out waiting for approval (5 min)');
}

function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'ok' in (raw as object)) {
    const env = raw as { ok: boolean; data?: T };
    if (env.ok && env.data) return env.data;
  }
  return raw as T;
}
