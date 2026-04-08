/**
 * Prismer Daemon — background process for persistent evolution sync.
 *
 * Provides:
 *   startDaemon()   — fork a detached daemon process, write PID/port files
 *   stopDaemon()    — read daemon.pid, send SIGTERM
 *   daemonStatus()  — check if daemon is running, print health info
 *   appendToOutbox  — append an outcome entry to the local outbox file (cap 500)
 */

import * as fs from 'fs';
import * as path from 'path';
import { join, dirname } from 'path';
import * as os from 'os';
import { homedir } from 'os';
import * as http from 'http';
import { createServer } from 'http';
import { execSync } from 'child_process';
// @ts-ignore — no type declarations for @iarna/toml
import * as TOML from '@iarna/toml';

// ============================================================================
// Paths
// ============================================================================

const CONFIG_DIR = path.join(os.homedir(), '.prismer');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');
const PID_PATH = path.join(CONFIG_DIR, 'daemon.pid');
const PORT_PATH = path.join(CONFIG_DIR, 'daemon.port');
const CACHE_DIR = path.join(CONFIG_DIR, 'cache');
const EVOLUTION_CACHE_PATH = path.join(CACHE_DIR, 'evolution.json');
const OUTBOX_PATH = path.join(CACHE_DIR, 'outbox.json');

const MAX_OUTBOX_SIZE = 500;
const SYNC_INTERVAL_MS = 60_000;
const FLUSH_INTERVAL_MS = 30_000;
const API_TIMEOUT_MS = 10_000;

const EVENTS_FILE = join(CACHE_DIR, 'events.json');
const MAX_EVENTS = 1000;

// ============================================================================
// Config helpers
// ============================================================================

interface DaemonConfig {
  apiKey: string;
  baseUrl: string;
}

function loadConfig(): DaemonConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = TOML.parse(raw) as any;
    const apiKey = parsed?.default?.api_key || '';
    const baseUrl = parsed?.default?.base_url || 'https://prismer.cloud';
    if (!apiKey) return null;
    return { apiKey, baseUrl };
  } catch {
    return null;
  }
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ============================================================================
// Outbox helpers (usable by external callers without starting daemon)
// ============================================================================

/**
 * Append an evolution outcome entry to the local outbox file.
 * External callers (hooks, plugins) use this to queue outcomes for the daemon.
 * Capped at MAX_OUTBOX_SIZE entries; oldest entries are dropped when full.
 */
export function appendToOutbox(entry: Record<string, unknown>): void {
  ensureCacheDir();
  let entries: Record<string, unknown>[] = [];
  if (fs.existsSync(OUTBOX_PATH)) {
    try {
      entries = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf-8'));
      if (!Array.isArray(entries)) entries = [];
    } catch {
      entries = [];
    }
  }
  entries.push({ ...entry, _queuedAt: Date.now() });
  // Drop oldest when over cap
  if (entries.length > MAX_OUTBOX_SIZE) {
    entries = entries.slice(entries.length - MAX_OUTBOX_SIZE);
  }
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(entries, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ============================================================================
// Event router helpers
// ============================================================================

interface DaemonEvent {
  type: string;
  source: 'im' | 'community' | 'evolution' | 'billing';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  title: string;
  body: string;
  timestamp: number;
  actionUrl?: string;
}

function loadEvents(): DaemonEvent[] {
  try {
    return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function appendEvent(event: DaemonEvent): void {
  const events = loadEvents();
  events.push(event);
  // Keep only last MAX_EVENTS
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events), { encoding: 'utf-8', mode: 0o600 });
}

// Called by sync when notable changes detected
function emitSyncEvent(genesCount: number): void {
  if (genesCount > 0) {
    appendEvent({
      type: 'evolution.sync',
      source: 'evolution',
      priority: 'low',
      title: 'Evolution sync complete',
      body: `${genesCount} genes updated`,
      timestamp: Date.now(),
    });
  }
}

// ============================================================================
// PID helpers
// ============================================================================

function readPid(): number | null {
  if (!fs.existsSync(PID_PATH)) return null;
  try {
    const raw = fs.readFileSync(PID_PATH, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function readPort(): number | null {
  if (!fs.existsSync(PORT_PATH)) return null;
  try {
    const raw = fs.readFileSync(PORT_PATH, 'utf-8').trim();
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(pid: number): void {
  ensureCacheDir();
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(PID_PATH, String(pid), { encoding: 'utf-8', mode: 0o600 });
}

function writePort(port: number): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(PORT_PATH, String(port), { encoding: 'utf-8', mode: 0o600 });
}

function cleanupPidFiles(): void {
  try { if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH); } catch {}
  try { if (fs.existsSync(PORT_PATH)) fs.unlinkSync(PORT_PATH); } catch {}
}

// ============================================================================
// HTTP fetch with timeout
// ============================================================================

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = API_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Daemon process (runs in-process when spawned with PRISMER_DAEMON=1)
// ============================================================================

async function runDaemonProcess(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write('[prismer-daemon] No config found. Run "prismer setup" first.\n');
    process.exit(1);
  }

  ensureCacheDir();

  // State
  let lastSync = 0;
  let syncCount = 0;
  let evolutionCursor = 0;

  // Load persisted cursor from cache
  if (fs.existsSync(EVOLUTION_CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(EVOLUTION_CACHE_PATH, 'utf-8'));
      if (typeof cached?.cursor === 'number') evolutionCursor = cached.cursor;
    } catch {}
  }

  // ── Health HTTP server on random port ──
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      let outboxSize = 0;
      if (fs.existsSync(OUTBOX_PATH)) {
        try {
          const entries = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf-8'));
          if (Array.isArray(entries)) outboxSize = entries.length;
        } catch {}
      }
      const body = JSON.stringify({
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        lastSync,
        syncCount,
        outboxSize,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const events = loadEvents();
      // Return last 50 events
      res.end(JSON.stringify(events.slice(-50)));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    const port = addr.port;
    writePid(process.pid);
    writePort(port);
    process.stdout.write(`[prismer-daemon] Started. PID=${process.pid} port=${port}\n`);
  });

  // ── Graceful shutdown ──
  const shutdown = (): void => {
    process.stdout.write('[prismer-daemon] Shutting down.\n');
    cleanupPidFiles();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Evolution sync (every 60s) ──
  const doEvolutionSync = async (): Promise<void> => {
    try {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}/api/im/evolution/sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({ pull: { since: evolutionCursor, scope: 'global' } }),
        },
      );
      if (res.ok) {
        const data = await res.json() as any;
        lastSync = Date.now();
        syncCount++;
        // Advance cursor if server returns one
        if (typeof data?.data?.cursor === 'number') {
          evolutionCursor = data.data.cursor;
        } else if (typeof data?.cursor === 'number') {
          evolutionCursor = data.cursor;
        }
        ensureCacheDir();
        const pulled = data?.data || data;
        fs.writeFileSync(
          EVOLUTION_CACHE_PATH,
          JSON.stringify({ cursor: evolutionCursor, lastSync, data: pulled }, null, 2),
          { encoding: 'utf-8', mode: 0o600 },
        );
        emitSyncEvent(pulled?.genes?.length || 0);
      }
    } catch {
      // Non-fatal — retry on next tick
    }
  };

  // ── Outbox flush (every 30s) ──
  const doOutboxFlush = async (): Promise<void> => {
    if (!fs.existsSync(OUTBOX_PATH)) return;
    let entries: Record<string, unknown>[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf-8'));
      if (!Array.isArray(entries) || entries.length === 0) return;
    } catch {
      return;
    }

    try {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}/api/im/evolution/sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            push: { outcomes: entries },
            pull: { since: 0 },
          }),
        },
      );
      if (res.ok) {
        // Clear outbox on success
        fs.writeFileSync(OUTBOX_PATH, '[]', { encoding: 'utf-8', mode: 0o600 });
      }
    } catch {
      // Non-fatal — entries remain in outbox for next flush
    }
  };

  // Initial syncs
  await doEvolutionSync();
  await doOutboxFlush();

  // Recurring intervals (save handles for cleanup)
  const syncTimer = setInterval(doEvolutionSync, SYNC_INTERVAL_MS);
  const flushTimer = setInterval(doOutboxFlush, FLUSH_INTERVAL_MS);

  // Override shutdown to clear timers
  const originalShutdown = shutdown;
  const fullShutdown = (): void => {
    clearInterval(syncTimer);
    clearInterval(flushTimer);
    originalShutdown();
  };
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  process.on('SIGINT', fullShutdown);
  process.on('SIGTERM', fullShutdown);
}

// ============================================================================
// Public API: startDaemon / stopDaemon / daemonStatus
// ============================================================================

/**
 * Start the daemon as a detached background process.
 * Prevents duplicates by checking existing PID.
 */
export async function startDaemon(): Promise<void> {
  const existingPid = readPid();
  if (existingPid !== null && isProcessRunning(existingPid)) {
    const port = readPort();
    console.log(`Daemon already running. PID=${existingPid}${port ? ` port=${port}` : ''}`);
    return;
  }

  // Stale PID file — clean up
  cleanupPidFiles();

  // Check config before spawning
  const cfg = loadConfig();
  if (!cfg) {
    console.error('No API key found. Run "prismer setup" first.');
    process.exit(1);
  }

  // If we're already inside the daemon process, just run inline
  if (process.env['PRISMER_DAEMON'] === '1') {
    await runDaemonProcess();
    return;
  }

  // Spawn a detached child process
  const { spawn } = require('child_process') as typeof import('child_process');

  const child = spawn(process.execPath, [process.argv[1], 'daemon', 'start'], {
    env: { ...process.env, PRISMER_DAEMON: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait briefly for PID file to appear
  let waited = 0;
  while (waited < 3000) {
    await new Promise<void>((r) => setTimeout(r, 100));
    waited += 100;
    const pid = readPid();
    const port = readPort();
    if (pid !== null && port !== null) {
      console.log(`Daemon started. PID=${pid} port=${port}`);
      return;
    }
  }

  console.log('Daemon spawned (PID file not yet written — may take a moment).');
}

/**
 * Stop the running daemon by sending SIGTERM.
 */
export function stopDaemon(): void {
  const pid = readPid();
  if (pid === null || !isProcessRunning(pid)) {
    console.log('Daemon: not running');
    cleanupPidFiles();
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Daemon stopped (PID=${pid})`);
    cleanupPidFiles();
  } catch (err: any) {
    console.error(`Failed to stop daemon: ${err.message}`);
  }
}

/**
 * Print daemon status. If running, query the health endpoint.
 */
export function daemonStatus(): void {
  const pid = readPid();
  if (pid === null || !isProcessRunning(pid)) {
    console.log('Daemon: not running');
    cleanupPidFiles();
    return;
  }

  const port = readPort();
  if (!port) {
    console.log(`Daemon: running (PID=${pid}, port unknown)`);
    return;
  }

  // Query health endpoint
  const req = http.request(
    { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 3000 },
    (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const health = JSON.parse(body);
          console.log(`Daemon: running`);
          console.log(`  PID:        ${health.pid}`);
          console.log(`  Uptime:     ${health.uptime}s`);
          console.log(`  Last sync:  ${health.lastSync ? new Date(health.lastSync).toISOString() : 'never'}`);
          console.log(`  Sync count: ${health.syncCount}`);
          console.log(`  Outbox:     ${health.outboxSize} entries`);
          console.log(`  Port:       ${port}`);
        } catch {
          console.log(`Daemon: running (PID=${pid} port=${port})`);
        }
      });
    },
  );
  req.on('error', () => {
    console.log(`Daemon: running (PID=${pid} port=${port}, health check failed)`);
  });
  req.end();
}


// ============================================================================
// Service registration: launchd (macOS) / systemd (Linux)
// ============================================================================

function resolveNpxPath(): string {
  try {
    return execSync('which npx', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    for (const p of ['/usr/local/bin/npx', '/opt/homebrew/bin/npx', `${homedir()}/.nvm/current/bin/npx`]) {
      try { fs.accessSync(p); return p; } catch {}
    }
    return 'npx';
  }
}

function installLaunchd(): void {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'cloud.prismer.daemon.plist');
  const npxPath = resolveNpxPath();
  const nodePath = process.execPath;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.prismer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npxPath}</string>
    <string>@prismer/sdk</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRISMER_DAEMON</key>
    <string>1</string>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.prismer', 'daemon.stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.prismer', 'daemon.stderr.log')}</string>
</dict>
</plist>`;

  fs.mkdirSync(dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });

  try {
    execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' });
    console.log('[prismer] Daemon service installed and started (launchd)');
    console.log(`  Plist: ${plistPath}`);
  } catch {
    console.log('[prismer] Plist written. Load manually: launchctl load ' + plistPath);
  }
}

function uninstallLaunchd(): void {
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'cloud.prismer.daemon.plist');
  try { execSync(`launchctl unload ${plistPath}`, { stdio: 'pipe' }); } catch {}
  try { fs.unlinkSync(plistPath); } catch {}
  console.log('[prismer] Daemon service uninstalled (launchd)');
}

function installSystemd(): void {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(serviceDir, 'prismer-daemon.service');

  const npxPath = resolveNpxPath();
  const nodePath = process.execPath;

  const unit = `[Unit]
Description=Prismer Daemon — background evolution sync
After=network-online.target

[Service]
Type=simple
Environment=PRISMER_DAEMON=1
Environment=PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin
ExecStart=${npxPath} @prismer/sdk daemon start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(servicePath, unit, { mode: 0o644 });

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable prismer-daemon', { stdio: 'pipe' });
    execSync('systemctl --user start prismer-daemon', { stdio: 'pipe' });
    console.log('[prismer] Daemon service installed and started (systemd)');
    console.log(`  Service: ${servicePath}`);
  } catch {
    console.log('[prismer] Service file written. Enable manually:');
    console.log('  systemctl --user enable --now prismer-daemon');
  }
}

function uninstallSystemd(): void {
  try { execSync('systemctl --user stop prismer-daemon', { stdio: 'pipe' }); } catch {}
  try { execSync('systemctl --user disable prismer-daemon', { stdio: 'pipe' }); } catch {}
  const servicePath = join(homedir(), '.config', 'systemd', 'user', 'prismer-daemon.service');
  try { fs.unlinkSync(servicePath); } catch {}
  try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
  console.log('[prismer] Daemon service uninstalled (systemd)');
}

/**
 * Install the daemon as a persistent system service (launchd on macOS, systemd on Linux).
 * The service will auto-start on login and restart on failure.
 */
export function installDaemonService(): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    installLaunchd();
  } else if (platform === 'linux') {
    installSystemd();
  } else {
    console.log(`Daemon auto-start not supported on ${platform}. Use: prismer daemon start`);
  }
}

/**
 * Uninstall the daemon system service.
 */
export function uninstallDaemonService(): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    uninstallLaunchd();
  } else if (platform === 'linux') {
    uninstallSystemd();
  } else {
    console.log(`No daemon service to uninstall on ${platform}.`);
  }
}

// ============================================================================
// Entry point: called when spawned with PRISMER_DAEMON=1
// ============================================================================

if (process.env['PRISMER_DAEMON'] === '1') {
  runDaemonProcess().catch((err) => {
    process.stderr.write(`[prismer-daemon] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
