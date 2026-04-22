// T14 — daemon lifecycle CLI commands

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as cp from 'node:child_process';
import type { CliContext } from '../cli/context.js';
import { startDaemonRunner } from '../daemon/runner.js';
import { DaemonProcess } from '../daemon-process.js';
import { loadConfig, ConfigError } from '../config.js';
import { Keychain } from '../keychain.js';
import { readPairedDevices, pairedDevicesPath } from './pair.js';

// ============================================================
// v1.9.0 B.2 — resolve identity for the daemon runner
// ============================================================
// Config values win over env; env is the fallback for PRISMER_API_KEY flows
// (already surfaced by loadConfig()). daemonId/userId both fall back to a
// deterministic hash of the API key so Docker containers (where os.hostname()
// is random) still produce a stable identity across restarts.

function apiKeyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

interface DaemonIdentity {
  apiKey?: string;
  daemonId?: string;
  userId?: string;
  cloudApiBase?: string;
}

export interface ResolveDaemonIdentityOptions {
  /** Override the config file path (defaults to ~/.prismer/config.toml via loadConfig). */
  configPath?: string;
  /** Override the Keychain instance (defaults to a freshly-constructed auto-detecting Keychain). */
  keychain?: Keychain;
}

/**
 * G-19 fix — fall back to env-derived identity when config resolution fails.
 * Kept as a helper so both the ConfigError branch and the catch-all branch
 * produce identical output.
 */
function identityFromEnv(): DaemonIdentity {
  const envKey = process.env['PRISMER_API_KEY'];
  if (envKey !== undefined && envKey.length > 0) {
    return {
      apiKey: envKey,
      daemonId: `daemon:${apiKeyFingerprint(envKey)}`,
      userId: `user:${apiKeyFingerprint(envKey)}`,
      cloudApiBase: process.env['PRISMER_BASE_URL'],
    };
  }
  return {};
}

export async function resolveDaemonIdentity(
  opts?: ResolveDaemonIdentityOptions,
): Promise<DaemonIdentity> {
  // G-19 — real config keys are persisted as $KEYRING:<service>/<account>
  // placeholders, so we MUST pass a keychain to loadConfig and let it walk
  // the tree resolving them. The previous `resolvePlaceholders: false` code
  // path returned the literal placeholder as the Bearer token → heartbeat 401.
  const keychain = opts?.keychain ?? new Keychain();
  try {
    const cfg = await loadConfig({ path: opts?.configPath, keychain });
    const apiKey = (cfg as { apiKey?: string }).apiKey
      ?? (cfg as { default?: { api_key?: string } }).default?.api_key
      ?? process.env['PRISMER_API_KEY'];
    const cloudApiBase = (cfg as { apiBase?: string }).apiBase
      ?? (cfg as { default?: { base_url?: string } }).default?.base_url
      ?? process.env['PRISMER_BASE_URL'];
    const daemonSection = (cfg as { daemon?: { id?: string }; default?: { daemon_id?: string } }).daemon;
    const userSection = (cfg as { user?: { id?: string }; default?: { user_id?: string } }).user;
    const daemonId = daemonSection?.id
      ?? (cfg as { default?: { daemon_id?: string } }).default?.daemon_id
      ?? (apiKey ? `daemon:${apiKeyFingerprint(apiKey)}` : undefined);
    const userId = userSection?.id
      ?? (cfg as { default?: { user_id?: string } }).default?.user_id
      ?? (apiKey ? `user:${apiKeyFingerprint(apiKey)}` : undefined);
    return { apiKey, daemonId, userId, cloudApiBase };
  } catch (err) {
    // ConfigError covers "missing secret: service/account" (placeholder points
    // at an empty keychain slot) and malformed-placeholder syntax. Either way,
    // the env var is the documented escape hatch — fall back silently rather
    // than crashing the daemon.
    if (err instanceof ConfigError) {
      return identityFromEnv();
    }
    // Unknown errors (disk / parser / keychain backend explosion) also fall
    // through to env; degraded-but-running beats a crashed daemon.
    return identityFromEnv();
  }
}

// ============================================================
// Constants
// ============================================================

const HOME = os.homedir();
const DEFAULT_PID_FILE = path.join(HOME, '.prismer', 'daemon.pid');
const DEFAULT_DATA_DIR = path.join(HOME, '.prismer');
const DEFAULT_LOG_DIR = path.join(HOME, '.prismer', 'logs');
const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, 'daemon.log');
const DEFAULT_STARTS_FILE = path.join(HOME, '.prismer', 'daemon.starts.json');
const DEFAULT_PORT = 3210;
const DEFAULT_HOST = '127.0.0.1';
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;
// 10s — cold adapter-register + E2EE keypair generation can exceed 2s on
// low-end hardware; wider window avoids false "failed to start" reports.
const PID_POLL_TIMEOUT_MS = 10_000;

// Crash-loop detection window + threshold per §16.6
const CRASH_WINDOW_MS = 10 * 60 * 1000;       // 10 minutes
const CRASH_BACKOFF_MS = 5 * 60 * 1000;       // 5 minutes
const CRASH_THRESHOLD = 3;
const DEVICE_ONLINE_MS = 60 * 1000;           // last seen within 60s = online

// ============================================================
// Helpers
// ============================================================

function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hours}h ${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

interface HealthResponse {
  status: string;
  daemon: {
    pid: number;
    uptime: number;
    state: string;
    rssBytes?: number;
    port?: number;
  };
  counts: {
    agents: number;
    subscriptions: number;
  };
}

interface AgentsResponse {
  agents: Array<{ id: string; state: string }>;
}

interface MemoryStatsResponse {
  fileCount: number;
  totalSize: number;
}

interface EvolutionStatsResponse {
  geneCount: number;
  signalCount: number;
  lastSyncAt: string | null;
}

export interface TransportStatusResponse {
  status: 'disabled' | 'probing' | 'connected' | 'unreachable';
  // `connected` state includes these
  path?: string | null;
  latencyMs?: number;
  // `unreachable` state includes this
  lastError?: string | null;
  // Detailed transport state — present whenever the manager is up (probing/
  // connected/unreachable). Absent when status=disabled.
  transport?: {
    currentPath: string | null;
    currentEndpoint: string | null;
    connected: boolean;
    latencyMs: number;
    lastHealthCheck: number;
    paths: {
      [key: string]: {
        available: boolean;
        latencyMs: number;
        lastProbed: number;
      };
    };
  };
  message?: string;
}

function httpGet(
  url: string,
  timeoutMs = 3000,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(bearer?: string): Record<string, string> | undefined {
  return bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
}

// Probe the running daemon's HTTP health endpoint (always public — no auth).
async function probeHealth(port: number): Promise<HealthResponse | null> {
  try {
    const r = await httpGet(`http://${DEFAULT_HOST}:${port}/api/v1/health`);
    if (r.status === 200) {
      return JSON.parse(r.body) as HealthResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// Try to probe agents list (requires auth if configured; returns null on failure).
async function probeAgents(port: number, bearer?: string): Promise<AgentsResponse | null> {
  try {
    const r = await httpGet(`http://${DEFAULT_HOST}:${port}/api/v1/agents`, 3000, authHeaders(bearer));
    if (r.status === 200) {
      return JSON.parse(r.body) as AgentsResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// Probe memory stats from the daemon (returns null if endpoint unavailable).
async function probeMemoryStats(port: number, bearer?: string): Promise<MemoryStatsResponse | null> {
  try {
    const r = await httpGet(`http://${DEFAULT_HOST}:${port}/api/v1/memory/stats`, 3000, authHeaders(bearer));
    if (r.status === 200) {
      return JSON.parse(r.body) as MemoryStatsResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// Probe evolution stats from the daemon (returns null if endpoint unavailable).
async function probeEvolutionStats(port: number, bearer?: string): Promise<EvolutionStatsResponse | null> {
  try {
    const r = await httpGet(`http://${DEFAULT_HOST}:${port}/api/v1/evolution/stats`, 3000, authHeaders(bearer));
    if (r.status === 200) {
      return JSON.parse(r.body) as EvolutionStatsResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// Probe transport status from daemon (returns null if endpoint unavailable).
async function probeTransportStatus(port: number, bearer?: string): Promise<TransportStatusResponse | null> {
  try {
    const r = await httpGet(`http://${DEFAULT_HOST}:${port}/api/v1/transport/status`, 3000, authHeaders(bearer));
    if (r.status === 200) {
      return JSON.parse(r.body) as TransportStatusResponse;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// Crash-loop detection helpers
// ============================================================
//
// Semantics: an entry in `attempts` represents a start that did NOT confirm as
// running. We append BEFORE spawn (we don't know the outcome yet) and then
// REMOVE on successful start. So a clean "restart three times" flow leaves no
// residue — only actual failures accumulate and trip §16.6's 3-in-10-min guard.

export interface CrashLoopConfig {
  windowMs?: number;
  backoffMs?: number;
  threshold?: number;
}

export type CrashLoopResult =
  | { blocked: true; lastAttempt: number; recent: number[] }
  | { blocked: false; recent: number[] };

/** Pure decision function — exported for unit testing. */
export function checkCrashLoop(
  attempts: number[],
  now: number,
  cfg?: CrashLoopConfig,
): CrashLoopResult {
  const windowMs = cfg?.windowMs ?? CRASH_WINDOW_MS;
  const backoffMs = cfg?.backoffMs ?? CRASH_BACKOFF_MS;
  const threshold = cfg?.threshold ?? CRASH_THRESHOLD;

  const recent = attempts.filter((ts) => now - ts < windowMs);
  if (recent.length >= threshold) {
    const lastAttempt = recent[recent.length - 1];
    if (now - lastAttempt < backoffMs) {
      return { blocked: true, lastAttempt, recent };
    }
  }
  return { blocked: false, recent };
}

function readStartAttempts(startsFile: string): number[] {
  try {
    const raw = fs.readFileSync(startsFile, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { attempts?: unknown }).attempts)) {
      return ((parsed as { attempts: unknown[] }).attempts)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    }
    return [];
  } catch {
    return [];
  }
}

function writeStartAttempts(startsFile: string, attempts: number[]): void {
  const dir = path.dirname(startsFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = startsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ attempts }, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, startsFile);
}

/** Remove a specific attempt timestamp. Called when the start is confirmed successful. Exported for test. */
export function removeStartAttempt(startsFile: string, ts: number): void {
  const attempts = readStartAttempts(startsFile);
  const filtered = attempts.filter((t) => t !== ts);
  if (filtered.length === attempts.length) return;
  if (filtered.length === 0) {
    try { fs.rmSync(startsFile, { force: true }); } catch { /* best-effort */ }
    return;
  }
  writeStartAttempts(startsFile, filtered);
}

// ============================================================
// daemonStart
// ============================================================

export async function daemonStart(
  ctx: CliContext,
  opts?: {
    port?: number;
    foreground?: boolean;
    startsFile?: string;
    now?: () => number;
    /** Test hook: replace cp.spawn for unit tests. */
    spawnImpl?: typeof cp.spawn;
    /** Test hook: override identity resolution. */
    identityResolver?: () => Promise<DaemonIdentity>;
  },
): Promise<void> {
  const port = opts?.port ?? DEFAULT_PORT;
  const pidFile = DEFAULT_PID_FILE;
  const startsFile = opts?.startsFile ?? DEFAULT_STARTS_FILE;
  const now = opts?.now ?? ((): number => Date.now());

  // --- Degraded-mode detection ---
  // Resolve identity early so we can warn the user BEFORE spawning if no API
  // key is available. This does NOT block the start — local-only mode is valid
  // for dev/docker/identity-less flows.
  const resolveIdentity = opts?.identityResolver ?? resolveDaemonIdentity;
  const earlyIdentity = await resolveIdentity();
  const degradedMode = !earlyIdentity.apiKey;

  if (degradedMode) {
    if (ctx.ui.mode === 'json') {
      // JSON callers learn about degraded mode from the final success response;
      // nothing to emit here (no partial output before the result object).
    } else {
      ctx.ui.warn(
        'No API key configured — starting daemon in local-only mode',
        'Cloud relay, mobile pairing, and event sync will be disabled',
      );
      ctx.ui.secondary('Run: prismer setup (opens browser to sign in) — or PRISMER_API_KEY=sk-... prismer setup');
    }
  }

  // --- Crash-loop detection per §16.6 ---
  // `attempts` entries represent unconfirmed-start records. We remove our own
  // entry on successful start, so this counter only accumulates real failures.
  const nowMs = now();
  const rawAttempts = readStartAttempts(startsFile);
  const crashCheck = checkCrashLoop(rawAttempts, nowMs);

  if (crashCheck.blocked) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: false, error: 'CRASH_LOOP', message: 'Daemon crashed 3 times in 10 minutes. Waiting 5 minutes before retry.', recentCrashes: crashCheck.recent.length, lastAttempt: crashCheck.lastAttempt });
    } else {
      ctx.ui.error(
        'Daemon crashed 3 times in 10 minutes. Waiting 5 minutes before retry.',
        `${crashCheck.recent.length} recent crashes detected (last at ${new Date(crashCheck.lastAttempt).toISOString()})`,
        'prismer daemon logs',
      );
    }
    process.exitCode = 1;
    return;
  }

  // Check if already running
  if (DaemonProcess.isRunning(pidFile)) {
    const pid = readPidFile(pidFile);
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, alreadyRunning: true, pid });
    } else {
      ctx.ui.line(`Prismer daemon is already running (pid ${pid ?? '?'}). Use prismer daemon restart to restart.`);
    }
    return;
  }

  // Record this start attempt (pruned window + new timestamp) BEFORE spawning.
  // Written atomically via .tmp + rename (same pattern as pair.ts writePairedDevices).
  // Removed on successful start below; retained on failure as crash evidence.
  writeStartAttempts(startsFile, [...crashCheck.recent, nowMs]);

  // Stale PID cleanup: if pidfile exists but process is gone, mention it
  if (fs.existsSync(pidFile)) {
    ctx.ui.secondary('Cleaning stale PID file');
    DaemonProcess.cleanupStalePidFile(pidFile);
  }

  if (opts?.foreground) {
    // Foreground mode: run directly in this process; await SIGTERM/SIGINT
    const identity = await resolveDaemonIdentity();
    let handle: Awaited<ReturnType<typeof startDaemonRunner>> | undefined;
    try {
      handle = await startDaemonRunner({
        port,
        pidFile,
        dataDir: DEFAULT_DATA_DIR,
        installSignalHandlers: true,
        apiKey: identity.apiKey,
        daemonId: identity.daemonId,
        userId: identity.userId,
        cloudApiBase: identity.cloudApiBase,
        // v1.9.0 B.2 / B.7.b: reuse the API key as the local Bearer token so
        // evolution-gateway + daemon-http can authorize callers on 127.0.0.1.
        authBearer: identity.apiKey,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('EADDRINUSE') || msg.includes('address already in use')) {
        if (ctx.ui.mode === 'json') {
          ctx.ui.json({ ok: false, error: 'PORT_IN_USE', message: `Port ${port} is in use by another process`, port });
        } else {
          ctx.ui.error(
            `Port ${port} is in use by another process`,
            'Try a different port',
            `prismer daemon start --port ${port + 1}`,
          );
        }
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    // Start confirmed — drop the attempt entry we recorded before spawn.
    removeStartAttempt(startsFile, nowMs);

    ctx.ui.pending(`Daemon running on ${handle.url}. Press Ctrl+C to stop.`);

    // Await termination signals — DaemonProcess installs SIGTERM/SIGINT handlers
    // that call shutdown() internally. We just wait for the process to exit naturally.
    await new Promise<void>((resolve) => {
      // Poll: once daemon process shuts down the handle.pid becomes stale
      // In foreground mode the signal handlers on DaemonProcess will call shutdown()
      // and then process.exit. We just need to keep this promise alive.
      const sigHandler = (): void => {
        resolve();
      };
      process.once('SIGTERM', sigHandler);
      process.once('SIGINT', sigHandler);
      // Also resolve if the daemon PID file disappears (daemon shut itself down)
      const checkInterval = setInterval(() => {
        if (!fs.existsSync(pidFile)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
      checkInterval.unref();
    });
    return;
  }

  ctx.ui.pending(`Starting daemon on ${DEFAULT_HOST}:${port}...`);

  // Background (detached) mode: fork a child process running __daemon-worker
  fs.mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
  const logFd = fs.openSync(DEFAULT_LOG_FILE, 'a');
  const errFd = logFd; // both stdout and stderr go to the same log file

  // Resolve the bin entry point. We derive the runtime package root from
  // process.argv[1] (the script that was invoked). This works in both CJS and ESM.
  // When daemonStart is called from `prismer daemon start`, process.argv[1] is
  // the prismer.js bin path, so `path.resolve(dirname, '..')` gives the dist/
  // directory, and one more `..` gives the package root.
  const binScript = process.argv[1] ?? '';
  const resolvedBinScript = binScript
    ? fs.realpathSync(binScript)
    : '';
  let runtimeDir: string;
  if (resolvedBinScript) {
    // dist/bin/prismer.js → go up to dist/ → go up to package root
    runtimeDir = path.resolve(path.dirname(resolvedBinScript), '..', '..');
  } else {
    runtimeDir = path.join(os.homedir(), '.prismer', 'runtime');
  }
  // Try dist/bin/prismer.js first (built), fall back to src/bin/prismer.ts via tsx
  const distBin = path.join(runtimeDir, 'dist', 'bin', 'prismer.js');
  const srcBin = path.join(runtimeDir, 'src', 'bin', 'prismer.ts');

  let command: string;
  let args: string[];

  if (fs.existsSync(distBin)) {
    command = process.execPath;
    args = [distBin, '__daemon-worker', '--port', String(port)];
  } else {
    // Dev mode: use tsx
    command = 'npx';
    args = ['tsx', srcBin, '__daemon-worker', '--port', String(port)];
  }

  const spawnImpl = opts?.spawnImpl ?? cp.spawn;
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: ['ignore', logFd, errFd],
    env: {
      ...process.env,
      PRISMER_DAEMON_PORT: String(port),
      PRISMER_DAEMON_PID_FILE: pidFile,
      PRISMER_DAEMON_DATA_DIR: DEFAULT_DATA_DIR,
    },
  });

  // Track whether the child exited during the poll window — that is a GENUINE
  // failure. If the poll expires but the child is still alive it is a SLOW
  // start (cold adapter-register / E2EE keygen); we must not count that as a
  // crash-loop entry.
  let childExitedEarly = false;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;

  child.once('exit', (code, signal) => {
    childExitedEarly = true;
    childExitCode = code;
    childExitSignal = signal as NodeJS.Signals | null;
  });

  // unref AFTER attaching the exit listener so the parent CLI can exit without
  // waiting for the child, but the listener fires if child exits in the window.
  child.unref();
  fs.closeSync(logFd);

  // Poll for the PID file to appear (up to PID_POLL_TIMEOUT_MS) OR child exit
  const deadline = Date.now() + PID_POLL_TIMEOUT_MS;
  let actualPid: number | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (DaemonProcess.isRunning(pidFile)) {
      actualPid = readPidFile(pidFile);
      break;
    }
    if (childExitedEarly) break;
  }

  // Race guard: if the child wrote the PID file and fired 'exit' in the same
  // tick, the poll loop may have broken on childExitedEarly before the
  // isRunning() check ran.  One final re-check lets PID file presence win.
  if (actualPid === null && childExitedEarly && DaemonProcess.isRunning(pidFile)) {
    actualPid = readPidFile(pidFile);
  }

  if (actualPid === null) {
    if (childExitedEarly) {
      // Genuine failure: child process terminated — keep attempt in startsFile
      // so crash-loop detection counts this as a real crash.
      const exitDesc = childExitCode !== null
        ? `exit code ${childExitCode}`
        : `signal ${String(childExitSignal)}`;
      // Inspect recent log output for a more specific diagnosis
      let cause = `Daemon process exited early (${exitDesc})`;
      let fix = 'prismer daemon logs';
      try {
        const recentLog = fs.readFileSync(DEFAULT_LOG_FILE, 'utf-8');
        const lastLines = recentLog.split('\n').slice(-20).join('\n');
        if (lastLines.includes('EADDRINUSE') || lastLines.includes('address already in use')) {
          cause = `Port ${port} is in use by another process`;
          fix = `prismer daemon start --port ${port + 1}`;
        }
      } catch {
        // Log file may not exist or be unreadable — keep generic cause
      }
      if (ctx.ui.mode === 'json') {
        ctx.ui.json({ ok: false, error: 'START_FAILED', message: 'Daemon failed to start', cause, port });
      } else {
        ctx.ui.error('Daemon failed to start', cause, fix);
      }
      process.exitCode = 1;
      return;
    }

    // Slow start: child is still alive but PID file hasn't appeared yet.
    // EXIT CODE 0 is intentional — the daemon is running, just initialising.
    // Remove our attempt entry so this doesn't count toward the crash-loop guard.
    removeStartAttempt(startsFile, nowMs);
    if (ctx.ui.mode === 'json') {
      if (degradedMode) {
        ctx.ui.json({ ok: true, slowStart: true, message: 'Daemon starting in background — check status shortly', port, degradedMode: true, warnings: ['NO_API_KEY'] });
      } else {
        ctx.ui.json({ ok: true, slowStart: true, message: 'Daemon starting in background — check status shortly', port });
      }
    } else {
      ctx.ui.ok(
        'Daemon starting in background',
        `check \`prismer daemon status\` or tail \`prismer daemon logs\` in a moment`,
      );
      if (degradedMode) {
        ctx.ui.warn('Running in local-only mode (no cloud features)');
      }
    }
    return;
  }

  // Start confirmed — drop the attempt entry we recorded before spawn.
  removeStartAttempt(startsFile, nowMs);

  if (ctx.ui.mode === 'json') {
    if (degradedMode) {
      ctx.ui.json({ ok: true, pid: actualPid, port, degradedMode: true, warnings: ['NO_API_KEY'] });
    } else {
      ctx.ui.json({ ok: true, pid: actualPid, port });
    }
  } else {
    ctx.ui.ok('Daemon started', `pid ${actualPid}, port ${port}`);
    if (degradedMode) {
      ctx.ui.warn('Running in local-only mode (no cloud features)');
    }
    ctx.ui.tip('prismer status');
  }
}

// ============================================================
// daemonStop
// ============================================================

export async function daemonStop(ctx: CliContext): Promise<void> {
  const pidFile = DEFAULT_PID_FILE;

  const pid = readPidFile(pidFile);
  if (pid === null || !isPidAlive(pid)) {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, wasRunning: false });
    } else {
      ctx.ui.line('No daemon is running.');
    }
    // Clean up stale pidfile if present
    if (fs.existsSync(pidFile)) {
      fs.rmSync(pidFile, { force: true });
    }
    return;
  }

  ctx.ui.pending('Stopping daemon...');

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (ctx.ui.mode === 'json') {
      ctx.ui.json({ ok: true, wasRunning: false });
    } else {
      ctx.ui.line('No daemon is running.');
    }
    return;
  }

  // Poll for exit up to STOP_TIMEOUT_MS
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  let graceful = true;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isPidAlive(pid)) {
      break;
    }
  }

  if (isPidAlive(pid)) {
    // Still alive — SIGKILL
    graceful = false;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone
    }
    // Wait a bit more for SIGKILL to take effect
    await sleep(500);
  }

  // Remove pidfile if daemon didn't clean it up
  if (fs.existsSync(pidFile)) {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // Best effort
    }
  }

  if (ctx.ui.mode === 'json') {
    ctx.ui.json({ ok: true, wasRunning: true, pid, graceful });
  } else if (graceful) {
    ctx.ui.ok('Stopped', 'graceful');
  } else {
    ctx.ui.ok('Stopped', 'forced SIGKILL after 10s');
  }
}

// ============================================================
// daemonRestart
// ============================================================

export async function daemonRestart(
  ctx: CliContext,
  opts?: { port?: number },
): Promise<void> {
  await daemonStop(ctx).catch(() => undefined);
  await daemonStart(ctx, { port: opts?.port });
}

// ============================================================
// daemonStatus / statusDashboard
// ============================================================
//
// `daemonStatus` is the low-level "is my local daemon alive" probe — PID
// liveness, bound port, uptime. It does NOT query the cloud, list agents, or
// report memory/evolution/transport. Those live on `statusDashboard`.
//
// Why the split? `prismer daemon status` and `prismer status` used to print
// the same full dashboard. README §CLI promised PID + port only for the
// daemon command, so we separated them: `daemon status` is cheap and local,
// `status` is the whole-system overview.

export function readPortSidecar(dataDir: string): number {
  const portFile = path.join(dataDir, 'daemon.port');
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch { /* sidecar missing — use default */ }
  return DEFAULT_PORT;
}

export async function daemonStatus(
  ctx: CliContext,
): Promise<void> {
  const pidFile = DEFAULT_PID_FILE;
  const pid = readPidFile(pidFile);
  const isRunning = pid !== null && isPidAlive(pid);
  const isJsonMode = ctx.ui.mode === 'json';

  // When running, try to get uptime from /health (authoritative). Fall back
  // to null if the daemon is technically alive but not yet serving HTTP —
  // the pidfile + port sidecar are still useful signals in that window.
  let uptimeMs: number | null = null;
  let port: number | null = null;
  if (isRunning) {
    port = readPortSidecar(DEFAULT_DATA_DIR);
    const health = await probeHealth(port);
    if (health !== null) {
      uptimeMs = health.daemon.uptime;
    }
  }

  if (isJsonMode) {
    ctx.ui.json({
      running: isRunning,
      pid: isRunning ? pid : null,
      port: isRunning ? port : null,
      uptimeMs: isRunning ? uptimeMs : null,
    });
    return;
  }

  if (isRunning) {
    const uptimeStr = uptimeMs !== null ? `, uptime ${formatUptime(uptimeMs)}` : '';
    const portStr = port !== null ? `, port ${port}` : '';
    ctx.ui.online(`Daemon: running (pid ${pid}${portStr}${uptimeStr})`);
  } else {
    ctx.ui.offline('Daemon: not running');
    ctx.ui.blank();
    ctx.ui.tip('prismer daemon start');
  }
}

// ============================================================
// statusDashboard — the full-system overview used by `prismer status`
// ============================================================

export async function statusDashboard(
  ctx: CliContext,
  opts?: { pairedDevicesPath?: string; now?: () => number },
): Promise<void> {
  const pidFile = DEFAULT_PID_FILE;
  const pid = readPidFile(pidFile);
  const isRunning = pid !== null && isPidAlive(pid);
  const isJsonMode = ctx.ui.mode === 'json';
  const devicesPath = opts?.pairedDevicesPath ?? pairedDevicesPath();
  const now = opts?.now ?? ((): number => Date.now());

  let healthData: HealthResponse | null = null;
  let agentsData: AgentsResponse | null = null;
  let memoryStats: MemoryStatsResponse | null = null;
  let evoStats: EvolutionStatsResponse | null = null;
  let transportStatus: TransportStatusResponse | null = null;

  const actualPort = readPortSidecar(DEFAULT_DATA_DIR);

  if (isRunning) {
    // Read actual port from sidecar (daemon may have been started with --port)
    healthData = await probeHealth(actualPort);
    if (healthData !== null) {
      // Daemon uses the API key as its authBearer (see resolveDaemonIdentity +
      // daemonStart foreground branch). Load it so our probes can authenticate;
      // without this every auth'd endpoint returns 401 → null → the dashboard
      // silently lies about transport state and hides memory / evo stats.
      const identity = await resolveDaemonIdentity().catch(() => ({ apiKey: undefined }));
      const bearer = identity.apiKey;
      // Probe agents, memory, evolution, and transport stats in parallel
      [agentsData, memoryStats, evoStats, transportStatus] = await Promise.all([
        probeAgents(actualPort, bearer),
        probeMemoryStats(actualPort, bearer),
        probeEvolutionStats(actualPort, bearer),
        probeTransportStatus(actualPort, bearer),
      ]);
    }
  }

  // Devices: read paired-devices.json, count online = lastSeenAt within 60s
  const devices = readPairedDevices(devicesPath);
  const devicesPaired = devices.length;
  const nowMs = now();
  const devicesOnline = devices.filter((d) => nowMs - d.lastSeenAt < DEVICE_ONLINE_MS).length;

  if (isJsonMode) {
    const online = agentsData?.agents.filter((a) => a.state === 'running').length ?? 0;
    const stopped = agentsData?.agents.filter((a) => a.state !== 'running').length ?? 0;
    ctx.ui.json({
      daemon: isRunning
        ? {
            state: 'running',
            pid: healthData?.daemon.pid ?? pid,
            port: healthData?.daemon.port ?? actualPort,
            uptimeMs: healthData?.daemon.uptime ?? null,
            rssBytes: healthData?.daemon.rssBytes ?? null,
          }
        : { state: 'stopped', pid: null, port: null, uptimeMs: null, rssBytes: null },
      agents: agentsData
        ? { online, stopped, total: agentsData.agents.length }
        : null,
      memory: memoryStats
        ? { fileCount: memoryStats.fileCount, totalSize: memoryStats.totalSize }
        : null,
      evolution: evoStats
        ? { geneCount: evoStats.geneCount, signalCount: evoStats.signalCount, lastSyncAt: evoStats.lastSyncAt }
        : null,
      transport: transportStatus ?? { status: 'disabled', message: 'Multi-path transport is not enabled' },
      devices: { paired: devicesPaired, online: devicesOnline },
    });
    return;
  }

  // Pretty output per §15.2 mockup
  ctx.ui.header('Prismer Runtime v1.9.0');
  ctx.ui.blank();

  if (isRunning && healthData !== null) {
    const uptimeStr = formatUptime(healthData.daemon.uptime);
    const rssStr = healthData.daemon.rssBytes !== undefined
      ? `, RSS ${formatBytes(healthData.daemon.rssBytes)}`
      : '';
    ctx.ui.online(`Daemon: running (pid ${healthData.daemon.pid}${rssStr}, uptime ${uptimeStr})`);
  } else if (isRunning) {
    ctx.ui.online(`Daemon: running (pid ${pid})`);
  } else {
    ctx.ui.offline('Daemon: not running');
    ctx.ui.blank();
    ctx.ui.tip('prismer daemon start');
  }

  // Agents row
  if (agentsData !== null) {
    const online = agentsData.agents.filter((a) => a.state === 'running').length;
    const stopped = agentsData.agents.filter((a) => a.state !== 'running').length;
    ctx.ui.line(`  Agents:     ${online} online, ${stopped} stopped`);
  } else {
    ctx.ui.line('  Agents:     —');
  }

  // Memory row
  if (
    memoryStats !== null &&
    typeof memoryStats.fileCount === 'number' &&
    typeof memoryStats.totalSize === 'number'
  ) {
    ctx.ui.line(`  Memory:     ${memoryStats.fileCount} files (${formatBytes(memoryStats.totalSize)})`);
  } else {
    ctx.ui.line('  Memory:     unavailable');
  }

  // Evolution row
  if (evoStats !== null) {
    ctx.ui.line(`  Evolution:  ${evoStats.geneCount} genes, ${evoStats.signalCount} signals`);
  } else {
    ctx.ui.line('  Evolution:  unavailable');
  }

  // Transport row — honours the 4-state enum from /api/v1/transport/status.
  //   disabled    → "disabled"
  //   probing     → "probing..."
  //   connected   → "<path> (<endpoint>) (<latency>ms)"
  //   unreachable → "unreachable (<lastError>)"
  if (transportStatus !== null) {
    switch (transportStatus.status) {
      case 'connected': {
        const t = transportStatus.transport;
        if (t) {
          const pathStr = t.currentPath ? `${t.currentPath} (${t.currentEndpoint})` : 'none';
          ctx.ui.line(`  Transport:  ${pathStr} (${t.latencyMs.toFixed(1)}ms)`);
        } else {
          ctx.ui.line('  Transport:  connected');
        }
        break;
      }
      case 'probing':
        ctx.ui.line('  Transport:  probing...');
        break;
      case 'unreachable': {
        const err = transportStatus.lastError ? ` (${transportStatus.lastError})` : '';
        ctx.ui.line(`  Transport:  unreachable${err}`);
        break;
      }
      case 'disabled':
        ctx.ui.line('  Transport:  disabled');
        break;
    }
  } else {
    ctx.ui.line('  Transport:  unavailable');
  }

  // Devices row (wired from paired-devices.json)
  if (devicesPaired === 0) {
    ctx.ui.line('  Devices:    none paired');
  } else {
    ctx.ui.line(`  Devices:    ${devicesPaired} paired (${devicesOnline} online)`);
  }

  ctx.ui.blank();

  // Hint for unavailable subsystems (only when running — otherwise the
  // "Daemon: not running" tip already guides the user).
  if (isRunning && memoryStats === null && evoStats === null) {
    ctx.ui.secondary('Memory / Evolution stats unavailable — daemon may need an update');
  }

  if (devicesPaired === 0) {
    ctx.ui.secondary('prismer pair show   — pair a device');
  }
  ctx.ui.secondary('prismer agent list     — see agent details');
  ctx.ui.secondary('prismer agent doctor   — diagnose issues');
}

// ============================================================
// daemonLogs
// ============================================================

export async function daemonLogs(
  ctx: CliContext,
  opts?: { follow?: boolean; tail?: number },
): Promise<void> {
  const logFile = DEFAULT_LOG_FILE;
  const tailLines = opts?.tail ?? 50;
  const isJson = ctx.ui.mode === 'json';

  if (opts?.follow && isJson) {
    throw new Error(
      'daemonLogs: --follow is incompatible with --json mode. The CLI bin rejects this combination at argv parse time; programmatic callers should not pass both.',
    );
  }

  if (!fs.existsSync(logFile)) {
    if (isJson) {
      ctx.ui.json({ ok: true, lines: [], truncated: false });
    } else {
      ctx.ui.secondary('No log file found at ' + logFile);
    }
    return;
  }

  // Read the file and print last N lines
  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n');
  // Remove trailing empty line from the split
  if (allLines[allLines.length - 1] === '') allLines.pop();
  const last = allLines.slice(-tailLines);
  const truncated = allLines.length > tailLines;

  if (isJson) {
    ctx.ui.json({ ok: true, lines: last, truncated });
    return;
  }

  for (const line of last) {
    ctx.ui.write(line + '\n');
  }

  if (!opts?.follow) {
    return;
  }

  // Follow mode: poll for new content using fs.watchFile
  let offset = fs.statSync(logFile).size;

  await new Promise<void>((resolve) => {
    const watcher = fs.watchFile(logFile, { interval: 500 }, (curr) => {
      if (curr.size > offset) {
        const fd = fs.openSync(logFile, 'r');
        const toRead = curr.size - offset;
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, offset);
        fs.closeSync(fd);
        offset = curr.size;
        const newContent = buf.toString('utf-8');
        ctx.ui.write(newContent);
      }
    });

    const cleanup = (): void => {
      fs.unwatchFile(logFile);
      watcher; // reference to suppress unused warning
      resolve();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });
}
