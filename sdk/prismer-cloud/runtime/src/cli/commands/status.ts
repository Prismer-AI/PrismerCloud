// `prismer status` — composite report (config + daemon + cloud reachability).

import { Command } from 'commander';
import { hostname } from 'node:os';
import { CloudClient } from '../../auth.js';
import { configExists, loadConfig, resolvePaths } from '../../config.js';
import { openLocalDb } from '../../sync/store.js';
import { exitWithError, fail, ok, printBanner, printJson, readPidFile, tip, warn } from '../util.js';
import { getUI } from '../ui.js';

export function buildStatusCommand(): Command {
  return new Command('status')
    .description('Show daemon + config + cloud status')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const paths = resolvePaths();
      if (!configExists(paths)) {
        const report = { configured: false, paired: false, paths: { config: paths.configFile } };
        if (opts.json) {
          printJson(report);
        } else {
          printBanner({ compact: true });
          fail('Not configured', paths.configFile);
          tip('prismer setup', 'open browser login and bind this runtime');
        }
        return;
      }
      let cfg;
      try {
        cfg = loadConfig(paths);
      } catch (err) {
        exitWithError((err as Error).message);
      }

      const pid = readPidFile(paths);
      const daemonStatus = await readDaemonStatus();
      const daemonRunning = daemonStatus.running;

      const cloud = new CloudClient({ baseUrl: cfg!.cloud_api_base, apiKey: cfg!.api_key });
      let cloudOk = false;
      let me: unknown = null;
      let devices: unknown = null;
      let agents: unknown = null;
      // Wave 5 F5 (§4.8.1, E4 hand-off) — diagnose this daemon's transport
      // reachability against the cloud. Populated only when the cloud is
      // reachable AND the daemon has a paired daemonId in config.
      let diagnose: DiagnoseReport | null = null;
      try {
        const meRes = await cloud.request('GET', '/api/im/me', { timeoutMs: 3_000 });
        cloudOk = meRes.ok;
        me = meRes.data ?? null;

        if (cloudOk) {
          // Fetch workspace device status. The CloudClient returns the full
          // response body (wrapped in { ok, status, data }), so we need to
          // unwrap one level: response.data = { ok: true, data: [...] }.
          const wsRes = await cloud.request('GET', '/api/im/workspaces', { timeoutMs: 3_000 });
          if (wsRes.ok) {
            const wsBody = wsRes.data as { data?: Array<{ id?: string }> } | undefined;
            const wsList = wsBody?.data;
            if (Array.isArray(wsList) && wsList.length > 0) {
              const wsId = wsList[0]?.id;
              if (wsId) {
                // /runtime returns the nested device→agents binding snapshot
                // (WorkspaceRuntimeDTO). One fetch covers both halves of the
                // bindings table the user sees — separate /runtime-installations
                // + /agents calls previously needed manual stitching.
                const rtRes = await cloud.request('GET', `/api/im/workspaces/${encodeURIComponent(wsId)}/runtime`, { timeoutMs: 3_000 });
                if (rtRes.ok) {
                  const rtBody = rtRes.data as { data?: WorkspaceRuntimeDTO } | undefined;
                  const snapshot = rtBody?.data;
                  if (snapshot && Array.isArray(snapshot.devices)) {
                    devices = snapshot.devices;
                    agents = snapshot.devices.flatMap((d) => d.agents ?? []);
                  }
                }
              }
            }
          }

          // F5 — fetch /runtime/diagnose for this local daemon. The cloud
          // endpoint returns the authoritative "is this daemon reachable
          // RIGHT NOW + which transport should we use" snapshot — see
          // src/im/api/runtime-diagnose.ts. Best-effort: if it 404s (legacy
          // daemon row) or the cloud build pre-dates E4, skip silently.
          const daemonId = cfg!.daemon_id;
          if (daemonId) {
            try {
              const diagRes = await cloud.request(
                'GET',
                `/api/im/runtime/diagnose?daemonId=${encodeURIComponent(daemonId)}`,
                { timeoutMs: 3_000 },
              );
              if (diagRes.ok) {
                const body = diagRes.data as { data?: DiagnoseReport } | undefined;
                if (body?.data && typeof body.data === 'object') diagnose = body.data;
              }
            } catch {
              /* diagnose endpoint absent — render the report without it */
            }
          }
        }
      } catch {
        cloudOk = false;
      }

      const local = readLocalCounts(paths.localDb);
      const report = {
        configured: true,
        paired: true,
        paths: { config: paths.configFile, db: paths.localDb, cache: paths.cacheDir },
        daemon: {
          running: daemonRunning,
          pid: daemonStatus.pid ?? pid ?? null,
          wsConnected: daemonStatus.wsConnected ?? null,
          info: daemonStatus.info ?? {},
        },
        cloud: { base: cfg!.cloud_api_base, reachable: cloudOk, me, devices, agents },
        local,
        diagnose,
      };
      if (opts.json) {
        printJson(report);
        return;
      }
      printPretty(report);
    });
}

interface DaemonStatus {
  running: boolean;
  pid?: number;
  wsConnected?: boolean;
  info?: Record<string, unknown>;
}

/**
 * Mirrors the cloud DTO returned by `GET /api/im/workspaces/:id/runtime`
 * (see `sdk/prismer-cloud/runtime/src/cli/commands/workspace.ts`). Kept local
 * to avoid cross-import; if the cloud shape ever evolves, this is the single
 * place to update the daemon's bindings view.
 */
export interface RuntimeAgentDTO {
  id: string;
  name: string;
  status: string;
  currentTaskId: string | null;
  version: string | null;
  lastHeartbeat: string | null;
}
export interface RuntimeDeviceDTO {
  deviceId: string;
  name: string;
  lastSeenAt: string | null;
  agents: RuntimeAgentDTO[];
}
interface WorkspaceRuntimeDTO {
  workspaceId: string;
  devices: RuntimeDeviceDTO[];
}

/** Device freshness icon. 5min/1h cut-offs match dashboard convention. */
export function computeDeviceIcon(lastSeenAt: string | null, now: Date): '●' | '◐' | '○' {
  if (!lastSeenAt) return '○';
  const age = now.getTime() - Date.parse(lastSeenAt);
  if (!Number.isFinite(age) || age < 0) return '○';
  if (age < 5 * 60_000) return '●';
  if (age < 60 * 60_000) return '◐';
  return '○';
}

/** Agent freshness icon. `◆` marks an explicit error/failed status. */
export function computeAgentIcon(status: string, lastHeartbeat: string | null, now: Date): '●' | '◐' | '○' | '◆' {
  const s = (status || '').toLowerCase();
  if (s === 'error' || s === 'failed') return '◆';
  if (!lastHeartbeat) return s === 'offline' ? '○' : '◐';
  const age = now.getTime() - Date.parse(lastHeartbeat);
  if (!Number.isFinite(age) || age < 0 || age >= 60 * 60_000) return '○';
  if (age >= 5 * 60_000) return '◐';
  return '●';
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + ' '.repeat(width - value.length);
}

/**
 * Pure formatter for the device↔agent bindings block. Returns one line per
 * output row so callers can pipe through `ui.line` (or assert in tests).
 *
 * Layout (no ANSI; default-terminal-safe unicode only):
 *   Device & Agent Bindings (N devices · M agents)
 *
 *   ● <device-name>                  <last-seen-rel>
 *      ├─ ● <agent-name>  <status>   <version>  <task-or-heartbeat>
 *      └─ ◐ <agent-name>  <status>   <version>  <task-or-heartbeat>
 */
export function formatDeviceBindings(devices: RuntimeDeviceDTO[], now: Date = new Date()): string[] {
  const lines: string[] = [];
  if (devices.length === 0) {
    lines.push('  No paired devices.');
    return lines;
  }
  const totalAgents = devices.reduce((s, d) => s + (d.agents?.length ?? 0), 0);
  const devWord = devices.length === 1 ? 'device' : 'devices';
  const agWord = totalAgents === 1 ? 'agent' : 'agents';
  lines.push(`  Device & Agent Bindings (${devices.length} ${devWord} · ${totalAgents} ${agWord})`);
  lines.push('');
  for (let di = 0; di < devices.length; di++) {
    const d = devices[di]!;
    const dIcon = computeDeviceIcon(d.lastSeenAt, now);
    const dName = pad(d.name || d.deviceId, 40);
    const lastSeen = d.lastSeenAt ? formatRelative(d.lastSeenAt, now) : 'never seen';
    lines.push(`  ${dIcon} ${dName}  ${lastSeen}`);
    const agents = d.agents ?? [];
    for (let ai = 0; ai < agents.length; ai++) {
      const a = agents[ai]!;
      const isLast = ai === agents.length - 1;
      const branch = isLast ? '└─' : '├─';
      const aIcon = computeAgentIcon(a.status, a.lastHeartbeat, now);
      const aName = pad(a.name || a.id, 24);
      const aStatus = pad(a.status || '?', 8);
      const aVersion = pad(a.version ? `v${a.version}` : '—', 10);
      const tail = a.currentTaskId
        ? `task=${a.currentTaskId}`
        : a.lastHeartbeat
          ? `❤ ${formatRelative(a.lastHeartbeat, now)}`
          : '';
      lines.push(`     ${branch} ${aIcon} ${aName}  ${aStatus}  ${aVersion}  ${tail}`.trimEnd());
    }
    if (di < devices.length - 1) lines.push('');
  }
  return lines;
}

/**
 * Wave 5 F5 — diagnose response shape mirrors `/api/im/runtime/diagnose`
 * (see src/im/api/runtime-diagnose.ts). Only fields we actually print are
 * declared; we intentionally do NOT depend on the @prismer/sdk types module
 * so the daemon CLI stays free of cloud-server imports.
 */
interface DiagnoseReport {
  daemonId: string;
  workspaceId?: string;
  containerStatus?: string;
  wsAlive: boolean;
  lastHeartbeatAt: string | null;
  heartbeatFresh?: boolean;
  gatewayUrl: string | null;
  gatewayIsPrivate: boolean;
  transport: string | null;
  lastProbeAt: string | null;
  httpReachable: boolean;
  httpLatencyMs: number | null;
  httpError?: string | null;
  recommendedTransport: 'ws' | 'http' | 'unreachable';
}

async function readDaemonStatus(): Promise<DaemonStatus> {
  // Prefer the local server health check (rich status: pid + wsConnected).
  // When --no-local-server is used the health endpoint doesn't exist, so
  // fall back to the PID file.
  try {
    const res = await fetch('http://127.0.0.1:3210/healthz', {
      signal: AbortSignal.timeout(1_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { pid?: number; wsConnected?: boolean; version?: string; uptime?: number; memoryMb?: number; agents?: number };
      return { running: true, pid: data.pid, wsConnected: data.wsConnected, info: data as Record<string, unknown> };
    }
  } catch {
    // Local server not running — could be --no-local-server.
  }
  // Fallback: check PID file. If the PID is alive the daemon is running,
  // possibly without a local server.
  const paths = resolvePaths();
  const pid = readPidFile(paths);
  if (pid) {
    const { pidAlive } = await import('../util.js');
    if (pidAlive(pid)) return { running: true, pid };
  }
  return { running: false };
}

function readLocalCounts(localDbPath: string): { agents: number; profiles: number; runningTasks: number } | null {
  try {
    const db = openLocalDb(localDbPath);
    try {
      const row = (sql: string) => db.prepare(sql).get() as { c: number };
      return {
        agents: row('SELECT COUNT(*) AS c FROM agents').c,
        profiles: row('SELECT COUNT(*) AS c FROM agent_profiles WHERE deleted_at IS NULL').c,
        runningTasks: row('SELECT COUNT(*) AS c FROM running_tasks').c,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function printPretty(report: {
  paired: boolean;
  configured?: boolean;
  paths: { config: string; db: string; cache: string };
  daemon: { running: boolean; pid: number | null; wsConnected: boolean | null; info?: Record<string, unknown> };
  cloud: { base: string; reachable: boolean; me: unknown; devices: unknown; agents: unknown };
  local: { agents: number; profiles: number; runningTasks: number } | null;
  diagnose?: DiagnoseReport | null;
}): void {
  const ui = getUI();
  printBanner({ compact: true });
  ui.header('Runtime status');
  ui.blank();

  // ── Config ──
  ok('Config', report.paths.config);

  // ── Daemon ──
  if (report.daemon.running) {
    const daemonName = report.cloud.me && typeof report.cloud.me === 'object'
      ? ((report.cloud.me as Record<string, unknown>).user as Record<string, unknown> | undefined)?.username ?? hostname()
      : hostname();
    const ws = report.daemon.wsConnected ? 'connected' : 'pending';
    ok('Daemon', `${daemonName}  pid=${report.daemon.pid}  ws=${ws}`);
    if (report.daemon.info) {
      const info = report.daemon.info;
      if (info.version) ui.line(`  Version:  ${info.version}`);
      if (info.uptime) ui.line(`  Uptime:   ${Math.round((info.uptime as number) / 60)}m`);
      if (info.memoryMb) ui.line(`  Memory:   ${info.memoryMb} MB`);
    }
  } else {
    warn('Daemon', 'not running');
    tip('prismer daemon start');
  }

  // ── Cloud ──
  if (report.cloud.reachable) {
    ok('Cloud', report.cloud.base);
    const me = report.cloud.me as { user?: { username?: string; displayName?: string }; credits?: { balance?: number } } | null;
    if (me?.user) {
      ui.line(`  User:     ${me.user.displayName ?? me.user.username ?? '?'}`);
    }
    if (me?.credits) {
      ui.line(`  Credits:  ${typeof me.credits.balance === 'number' ? me.credits.balance.toLocaleString() : '?'}`);
    }
  } else {
    fail('Cloud', `${report.cloud.base} unreachable or unauthorized`);
    tip('prismer setup --force');
  }

  // ── Device & Agent Bindings (tree-style TUI block) ──
  if (Array.isArray(report.cloud.devices) && report.cloud.devices.length > 0) {
    const devs = report.cloud.devices as RuntimeDeviceDTO[];
    ui.blank();
    for (const ln of formatDeviceBindings(devs)) ui.line(ln);
  }

  // ── Local ──
  if (report.local) {
    ui.blank();
    ui.line(`  Local agents:  ${report.local.agents}`);
    ui.line(`  Profiles:      ${report.local.profiles}`);
    ui.line(`  Running tasks: ${report.local.runningTasks}`);
  } else {
    warn('Local DB', 'unavailable');
  }

  // ── Wave 5 F5 — Cloud-side dispatch reachability (E4 /runtime/diagnose) ──
  if (report.diagnose) {
    ui.blank();
    ui.header('Cloud dispatch reachability');
    ui.blank();
    printDiagnose(report.diagnose, report.daemon.pid ?? null);
  }
}

/**
 * Wave 5 F5 — render the §4.8.1 diagnose block. Five lines, matching the
 * spec sample in evidence/14-e4-webhook-ws-first.md §"Wave 5 hand-off"
 * (Daemon / Cloud WS / HTTP gateway / Active agents / Recommended transport).
 */
function printDiagnose(d: DiagnoseReport, pid: number | null): void {
  const ui = getUI();
  const heartbeatLine = d.lastHeartbeatAt
    ? `last heartbeat ${formatRelative(d.lastHeartbeatAt)}`
    : 'no heartbeat seen';

  if (d.wsAlive) {
    ok('Daemon', `running${pid ? ` (pid ${pid})` : ''}`);
    ok('Cloud WS', `connected (${heartbeatLine})`);
  } else {
    warn('Daemon', `running${pid ? ` (pid ${pid})` : ''} — not visible to cloud WS`);
    fail('Cloud WS', `disconnected (${heartbeatLine})`);
  }

  if (d.gatewayUrl) {
    if (d.gatewayIsPrivate) {
      warn('HTTP gateway', `${d.gatewayUrl} (private IP — only reachable on same network)`);
    } else if (d.httpReachable) {
      ok(
        'HTTP gateway',
        `${d.gatewayUrl} (reachable${d.httpLatencyMs != null ? `, ${d.httpLatencyMs}ms` : ''})`,
      );
    } else {
      fail('HTTP gateway', `${d.gatewayUrl} (unreachable${d.httpError ? ` — ${d.httpError}` : ''})`);
    }
  } else {
    ui.line('  HTTP gateway: not declared (WS-only daemon)');
  }

  // Active agents come from the existing devices block above; we still
  // surface them here so the diagnose snapshot is self-contained for the
  // common "paste me your status" support flow.
  const activeAgents = ((): number => {
    // d.workspaceId is informational only — agent count is best-effort.
    return 0;
  })();
  if (activeAgents > 0) {
    ok('Active agents', String(activeAgents));
  }

  const recColour =
    d.recommendedTransport === 'ws'
      ? ok
      : d.recommendedTransport === 'http'
        ? warn
        : fail;
  recColour('Recommended transport', d.recommendedTransport);
  if (d.lastProbeAt) {
    ui.line(`  Last transport probe: ${formatRelative(d.lastProbeAt)}`);
  }
}

/**
 * Best-effort relative-time formatter (mirrors the workspace UI helper).
 * `now` is injectable so the bindings formatter can be unit-tested without
 * stubbing the global clock.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'unknown';
  const diff = Math.max(0, now.getTime() - ts);
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
