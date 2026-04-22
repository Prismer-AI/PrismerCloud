// T16 — prismer pair show / list / revoke commands

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import QRCode from 'qrcode';
import type { CliContext } from '../cli/context.js';
import { loadConfig } from '../config.js';
import { resolveDaemonIdentity } from './daemon.js';

// ============================================================
// Internal helpers
// ============================================================

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const cfg = await loadConfig().catch(() => ({} as { apiKey?: string }));
    if (cfg.apiKey) {
      return { 'Authorization': `Bearer ${cfg.apiKey}` };
    }
  } catch {
    // Config read failure is non-fatal — proceed without auth header
  }
  return {};
}

// ============================================================
// Public types
// ============================================================

export interface PairOffer {
  offer: string;       // opaque bearer token from the daemon
  uri: string;         // prismer://pair URI to render as QR
  expiresAt: number;   // ms epoch
  relayUrl?: string;   // relay endpoint if online
  lanHost?: string;    // LAN IP daemon is bound to
  lanPort?: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  method: 'qr' | 'api-key';
  transport: 'lan' | 'relay';
  lastSeenAt: number;
  pairedAt: number;
}

// ============================================================
// Internal helpers
// ============================================================

const DEFAULT_TTL_SEC = 300; // 5 minutes
const DEFAULT_DAEMON_PORT = 3210;

export function pairedDevicesPath(homeDir?: string): string {
  const base = homeDir ?? os.homedir();
  return path.join(base, '.prismer', 'data', 'paired-devices.json');
}

export function readPairedDevices(devicesPath: string): PairedDevice[] {
  if (!fs.existsSync(devicesPath)) return [];
  try {
    const raw = fs.readFileSync(devicesPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PairedDevice[];
  } catch {
    return [];
  }
}

function writePairedDevices(devicesPath: string, devices: PairedDevice[]): void {
  const dir = path.dirname(devicesPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = devicesPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(devices, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, devicesPath);
}

function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function daemonBaseUrl(homeDir?: string): string {
  const base = homeDir ?? os.homedir();
  const portFile = path.join(base, '.prismer', 'daemon.port');
  let port = DEFAULT_DAEMON_PORT;
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    }
  } catch {
    // Fall back to the default daemon port.
  }
  return `http://127.0.0.1:${port}`;
}

function normalizeExpiresAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function requestPairOffer(
  ttlSec: number,
  opts?: { homeDir?: string; daemonUrl?: string; fetchImpl?: typeof fetch },
): Promise<PairOffer> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url = `${opts?.daemonUrl ?? daemonBaseUrl(opts?.homeDir)}/api/v1/pair/offer`;
  const authHeaders = await getAuthHeaders();
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ ttlSec }),
    signal: AbortSignal.timeout(2500),
  });

  if (!resp.ok) {
    throw new Error(`daemon returned ${resp.status}`);
  }

  const parsed = (await resp.json()) as Record<string, unknown>;
  const data = (parsed['data'] && typeof parsed['data'] === 'object'
    ? parsed['data']
    : parsed) as Record<string, unknown>;

  const offer = typeof data['offer'] === 'string'
    ? data['offer']
    : typeof data['offerId'] === 'string'
      ? data['offerId']
      : null;
  const expiresAt = normalizeExpiresAt(data['expiresAt']);

  if (!offer || expiresAt === null) {
    throw new Error('daemon returned an invalid pair offer');
  }

  const uri = typeof data['uri'] === 'string'
    ? data['uri']
    : `prismer://pair?offer=${encodeURIComponent(offer)}`;

  return {
    offer,
    uri,
    expiresAt,
    relayUrl: typeof data['relayUrl'] === 'string' ? data['relayUrl'] : undefined,
    lanHost: typeof data['lanHost'] === 'string' ? data['lanHost'] : undefined,
    lanPort: typeof data['lanPort'] === 'number' ? data['lanPort'] : undefined,
  };
}

// ============================================================
// pairShow
// ============================================================

export async function pairShow(
  ctx: CliContext,
  opts?: { ttlSec?: number; homeDir?: string; daemonUrl?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const ttlSec = opts?.ttlSec ?? DEFAULT_TTL_SEC;
  let offer: PairOffer;

  try {
    offer = await requestPairOffer(ttlSec, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isDaemonDown = message.includes('ECONNREFUSED')
      || message.includes('fetch failed')
      || message.includes('connect ECONNREFUSED');
    // The daemon IS up when requestPairOffer gets an HTTP status back — a 401
    // means the pair endpoint rejected the local request, not that the daemon
    // is missing. Detect that explicitly so we don't tell the user to start a
    // daemon their previous `status` output already showed running.
    const is401 = /\breturned 401\b/.test(message) || /\b401\b/.test(message);
    if (ctx.ui.mode === 'json') {
      let errorCode = 'PAIR_OFFER_UNAVAILABLE';
      if (isDaemonDown) errorCode = 'DAEMON_NOT_RUNNING';
      else if (is401) errorCode = 'PAIR_UNAUTHORIZED';
      ctx.ui.json({
        ok: false,
        error: errorCode,
        message: isDaemonDown
          ? 'Cannot generate pairing code: daemon not running'
          : `Unable to create a pairing offer: ${message}`,
      });
    } else if (isDaemonDown) {
      ctx.ui.error(
        'Cannot generate pairing code: daemon not running',
        message,
        'prismer daemon start',
      );
    } else if (is401) {
      ctx.ui.error(
        'Unable to create a pairing offer',
        'daemon returned 401 — the daemon may not have the latest API key',
        'Try: prismer daemon restart',
      );
    } else {
      ctx.ui.error(
        'Unable to create a pairing offer',
        message,
        'Re-run prismer setup (no args, opens browser) to refresh the api_key, or check prismer daemon logs --tail 50 for the underlying transport error.',
      );
    }
    process.exitCode = 1;
    return;
  }

  // --json path: emit and return immediately (no countdown, no QR)
  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, offer: offer.offer, uri: offer.uri, expiresAt: offer.expiresAt });
    return;
  }

  // Pretty path: render QR + countdown
  ctx.ui.header('Prismer Runtime · Pairing Mode');
  ctx.ui.blank();

  // Render QR code
  let qrString: string;
  try {
    qrString = await QRCode.toString(offer.uri, { type: 'terminal', small: true });
  } catch {
    qrString = '';
  }

  if (qrString) {
    ctx.ui.write(qrString);
  }

  ctx.ui.blank();
  ctx.ui.line('Scan with the lumin app, or paste this link:');
  // Print uri dimmed via secondary (2-space indent)
  ctx.ui.secondary(offer.uri);
  ctx.ui.blank();

  // Show relay vs LAN transport availability
  if (offer.relayUrl) {
    ctx.ui.ok('Relay available', offer.relayUrl);
  } else {
    ctx.ui.warn('Cannot reach relay server. LAN pairing still available.');
  }
  if (offer.lanHost && offer.lanPort) {
    ctx.ui.ok('LAN available', offer.lanHost + ':' + offer.lanPort);
  }
  ctx.ui.blank();

  // Countdown: update every second, overwrite line via \r on TTY
  // On non-TTY we just print the initial line (no overwrite).
  const isTTY = (process.stdout as NodeJS.WriteStream).isTTY === true;
  let cancelled = false;
  let connected = false;
  const initialRemainingMs = Math.max(0, offer.expiresAt - Date.now());
  const baseUrl = opts?.daemonUrl ?? daemonBaseUrl(opts?.homeDir);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const authHeaders = await getAuthHeaders();

  // Initial render
  const renderCountdown = (remainingMs: number): void => {
    const label = `Expires in ${formatCountdown(remainingMs)} · Waiting for connection...`;
    if (isTTY) {
      ctx.ui.write('\r' + label + '  ');
    } else {
      ctx.ui.line(label);
    }
  };

  renderCountdown(initialRemainingMs);

  // Poll daemon for pairing confirmation every ~2s during countdown.
  // If the daemon endpoint doesn't exist yet, the poll silently fails and
  // the countdown works exactly as before (graceful degradation).

  let sigintHandler: (() => void) | undefined;

  try {
    await new Promise<void>((resolve) => {
      const startedAt = Date.now();

      const interval = setInterval(async () => {
        const elapsed = Date.now() - startedAt;
        const remaining = offer.expiresAt - Date.now();
        if (remaining <= 0) {
          clearInterval(interval);
          if (isTTY) ctx.ui.write('\n');
          resolve();
          return;
        }
        renderCountdown(remaining);

        // Poll for pairing confirmation every ~2 seconds
        if (elapsed % 2000 < 1100) {
          try {
            const resp = await fetchImpl(
              `${baseUrl}/api/v1/pair/status?offer=${encodeURIComponent(offer.offer)}`,
              { headers: authHeaders, signal: AbortSignal.timeout(1500) },
            );
            if (resp.ok) {
              const data = (await resp.json()) as any;
              if (data.paired) {
                clearInterval(interval);
                connected = true;
                if (isTTY) ctx.ui.write('\n');
                ctx.ui.blank();
                ctx.ui.ok('Connected', data.deviceName || 'device paired successfully');

                // Save to paired-devices.json
                const devicesPath = pairedDevicesPath(opts?.homeDir);
                const devices = readPairedDevices(devicesPath);
                devices.push({
                  id: data.bindingId || crypto.randomUUID(),
                  name: data.deviceName || 'Unknown Device',
                  method: 'qr' as const,
                  transport: 'relay' as const,
                  lastSeenAt: Date.now(),
                  pairedAt: Date.now(),
                });
                writePairedDevices(devicesPath, devices);

                resolve();
                return;
              }
            }
          } catch {
            // Poll failure is non-fatal — daemon may not be running or endpoint may not exist
          }
        }
      }, 1000);

      sigintHandler = (): void => {
        clearInterval(interval);
        cancelled = true;
        if (isTTY) ctx.ui.write('\n');
        resolve();
      };

      process.once('SIGINT', sigintHandler);
    });
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler);
  }

  if (cancelled) {
    ctx.ui.blank();
    ctx.ui.secondary('Pairing cancelled.');
    return;
  }

  if (connected) {
    return;
  }

  if (isTTY) ctx.ui.blank();
  ctx.ui.warn('Pairing code expired');
  ctx.ui.tip('prismer pair show');
}

// ============================================================
// pairList
// ============================================================

export async function pairList(
  ctx: CliContext,
  opts?: { homeDir?: string },
): Promise<void> {
  const devicesPath = pairedDevicesPath(opts?.homeDir);
  const devices = readPairedDevices(devicesPath);

  if (ctx.ui.mode === 'json') {
    ctx.ui.json(devices);
    return;
  }

  if (devices.length === 0) {
    ctx.ui.line('No paired devices.');
    ctx.ui.tip('prismer pair show');
    return;
  }

  // Build table rows per §15.2 mockup: DEVICE, METHOD, TRANSPORT, LAST SEEN
  const rows = devices.map((d) => ({
    DEVICE: d.name,
    ID: d.id,
    METHOD: d.method,
    TRANSPORT: d.transport,
    'LAST SEEN': new Date(d.lastSeenAt).toLocaleString(),
  }));

  ctx.ui.table(rows, { columns: ['DEVICE', 'ID', 'METHOD', 'TRANSPORT', 'LAST SEEN'] });
}

// ============================================================
// Advisory file lock (O_EXCL pattern — no external deps)
// ============================================================

async function withPairedDevicesLock<T>(pairedFile: string, fn: () => Promise<T> | T): Promise<T> {
  const lockFile = pairedFile + '.lock';
  const maxWaitMs = 5000;
  const retryMs = 50;
  const start = Date.now();

  // Ensure directory exists before attempting to create lock file
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw e;

      // On every EEXIST, check immediately if the holder is still alive
      try {
        const holderPid = parseInt(fs.readFileSync(lockFile, 'utf-8'), 10);
        if (holderPid && !isNaN(holderPid)) {
          try { process.kill(holderPid, 0); }
          catch {
            // Holder is dead — clean stale lock and retry immediately
            fs.rmSync(lockFile, { force: true });
            continue;
          }
        }
      } catch { /* ignore read errors — file may have just been removed */ }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(`Timed out waiting for pair-devices lock (${maxWaitMs}ms)`);
      }
      await new Promise<void>((r) => setTimeout(r, retryMs));
    }
  }

  try {
    return await fn();
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  }
}

// ============================================================
// pairRevoke
// ============================================================

export async function pairRevoke(
  ctx: CliContext,
  deviceId: string,
  opts?: {
    homeDir?: string;
    fetchImpl?: typeof fetch;
    identity?: { apiKey?: string; cloudApiBase?: string };
  },
): Promise<void> {
  const devicesPath = pairedDevicesPath(opts?.homeDir);
  const isJson = ctx.ui.mode === 'json';

  let deviceName: string | undefined;

  const found = await withPairedDevicesLock(devicesPath, () => {
    const devices = readPairedDevices(devicesPath);
    const idx = devices.findIndex((d) => d.id === deviceId);
    if (idx < 0) return false;
    deviceName = devices[idx].name;
    const updated = devices.filter((_, i) => i !== idx);
    writePairedDevices(devicesPath, updated);
    return true;
  });

  if (!found) {
    if (isJson) {
      ctx.ui.json({ ok: false, error: 'DEVICE_NOT_FOUND', message: 'No paired device with id: ' + deviceId });
    } else {
      ctx.ui.error(
        'No paired device with id: ' + deviceId,
        undefined,
        'prismer pair list',
      );
    }
    process.exitCode = 1;
    return;
  }

  // Resolve cloud identity (injected for tests, or read from config)
  const resolvedIdentity = opts?.identity !== undefined
    ? opts.identity
    : await resolveDaemonIdentity();
  const apiKey = resolvedIdentity.apiKey;
  const cloudApiBase = resolvedIdentity.cloudApiBase ?? 'https://prismer.cloud';
  const fetchImpl = opts?.fetchImpl ?? fetch;

  let cloudDeleteAttempted = false;
  let cloudDeleteOk = false;
  let cloudError: string | undefined;

  if (!apiKey) {
    // No API key — local-only revoke with a warning
    if (isJson) {
      ctx.ui.json({
        ok: true,
        deviceId,
        name: deviceName,
        cloudDeleteAttempted: false,
        cloudDeleteOk: false,
      });
    } else {
      ctx.ui.ok('Revoked locally', deviceName);
      ctx.ui.warn('Local-only revoke', 'No API key configured; cloud binding will NOT be invalidated until it expires');
    }
    return;
  }

  // Attempt cloud DELETE
  cloudDeleteAttempted = true;
  try {
    const resp = await fetchImpl(
      `${cloudApiBase}/api/im/remote/bindings/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    cloudDeleteOk = resp.ok;
    if (!resp.ok) {
      cloudError = `server returned ${resp.status}`;
    }
  } catch (err) {
    cloudDeleteOk = false;
    cloudError = err instanceof Error ? err.message : String(err);
  }

  if (isJson) {
    const payload: Record<string, unknown> = {
      ok: true,
      deviceId,
      name: deviceName,
      cloudDeleteAttempted,
      cloudDeleteOk,
    };
    if (cloudError !== undefined) {
      payload['cloudError'] = cloudError;
    }
    ctx.ui.json(payload);
  } else {
    if (cloudDeleteOk) {
      ctx.ui.ok('Revoked', (deviceName ?? deviceId) + ' (cloud binding invalidated)');
    } else {
      ctx.ui.ok('Revoked locally', deviceName ?? deviceId);
      ctx.ui.warn(
        'Cloud binding DELETE failed',
        `${cloudError ?? 'unknown error'} — the server sweep will mark it revoked within 90s`,
      );
    }
  }
}
