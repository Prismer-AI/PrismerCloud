// T13 — List agents: status table matching §15.2 mockup.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliContext } from '../cli/context.js';
import {
  AGENT_CATALOG,
  type AgentCatalogEntry,
} from './registry.js';
import { readHookConfig } from './hooks.js';
import { readAgentsRegistry } from './agents-registry.js';

// ============================================================
// Types
// ============================================================

export interface ListAgentsOptions {
  homeDir?: string;
  catalog?: AgentCatalogEntry[];
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AgentListRow {
  name: string;
  displayName: string;
  status: 'online' | 'stopped' | 'not-installed';
  tiers: string;
  lastActive: string;
}

// ============================================================
// Daemon port helper (mirrors pair.ts:daemonBaseUrl, duplicated for locality)
// ============================================================

const DEFAULT_DAEMON_PORT = 3210;

function daemonBaseUrl(homeDir: string): string {
  const portFile = path.join(homeDir, '.prismer', 'daemon.port');
  let port = DEFAULT_DAEMON_PORT;
  try {
    const raw = fs.readFileSync(portFile, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    }
  } catch {
    // fall back to default
  }
  return `http://127.0.0.1:${port}`;
}

// ============================================================
// lastActive formatting
// ============================================================

function formatRelativeTime(tsMs: number): string {
  const diffMs = Date.now() - tsMs;
  if (diffMs < 0) return 'just now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  // More than 24h — return ISO
  return new Date(tsMs).toISOString();
}

/**
 * Query the daemon for agent status. Returns the `startedAt` timestamp (ms)
 * if available, or undefined if the daemon is unreachable / agent not found.
 */
async function queryDaemonLastActive(
  agentId: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<number | undefined> {
  try {
    const resp = await fetchImpl(
      `${baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as Record<string, unknown>;
    // AgentStatus.startedAt is a number (ms epoch)
    const startedAt = data.startedAt;
    if (typeof startedAt === 'number' && startedAt > 0) return startedAt;
    return undefined;
  } catch {
    // ECONNREFUSED, timeout, parse error — all treated as daemon unreachable
    return undefined;
  }
}

// ============================================================
// listAgents
// ============================================================

export async function listAgents(
  ctx: CliContext,
  opts: ListAgentsOptions = {},
): Promise<AgentListRow[]> {
  const { ui } = ctx;
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const homeDir = opts.homeDir ?? os.homedir();
  const fetchFn = opts.fetchImpl ?? fetch;

  const registry = readAgentsRegistry(homeDir);
  const baseUrl = daemonBaseUrl(homeDir);

  const rows: AgentListRow[] = [];

  for (const entry of catalog) {
    const detected = await entry.detect();

    const hookConfigPath = resolveConfigPath(entry.hookConfigPath, homeDir);
    const hookCfg = await readHookConfig(hookConfigPath);
    const hookStr = hookCfg !== null ? JSON.stringify(hookCfg) : '';

    // Prefer registry for installed-state: a registry entry means prismer installed this agent.
    const registryEntry = registry.find((r) => r.name === entry.name);

    // Fallback hook-fingerprint for pre-registry installs ("detected-legacy").
    const hasDaemonHook = hookStr.includes('para-emit') ||
      hookStr.includes('/opt/prismer/runtime/para-adapter.js');

    const isPrismerInstalled = Boolean(registryEntry) || hasDaemonHook;

    let status: AgentListRow['status'];
    if (!detected.found) {
      status = 'not-installed';
    } else if (isPrismerInstalled) {
      status = 'online';
    } else {
      status = 'stopped';
    }

    // Query daemon for real lastActive when online.
    let lastActive = '—';
    if (status === 'online') {
      const agentId = entry.name + '@' + os.hostname();
      const startedAt = await queryDaemonLastActive(agentId, baseUrl, fetchFn);
      if (startedAt !== undefined) {
        lastActive = formatRelativeTime(startedAt);
      }
    }

    rows.push({
      name: entry.name,
      displayName: registryEntry?.displayName ?? entry.displayName,
      status,
      tiers: entry.tiersSupported.length > 0
        ? 'L' + entry.tiersSupported[0] + '–L' + entry.tiersSupported[entry.tiersSupported.length - 1]
        : 'none',
      lastActive,
    });
  }

  // Render table.
  const detectedCount = rows.filter((r) => r.status !== 'not-installed').length;
  const onlineCount = rows.filter((r) => r.status === 'online').length;
  const stoppedCount = rows.filter((r) => r.status === 'stopped').length;

  if (ui.mode !== 'json') {
    const headerSuffix = onlineCount > 0
      ? `${formatCount(onlineCount, 'agent')} online · ${stoppedCount} stopped · daemon v1.9.0`
      : detectedCount > 0
        ? `${detectedCount} agent${detectedCount === 1 ? '' : 's'} detected · daemon v1.9.0`
        : 'no agents detected · daemon v1.9.0';
    ui.header('Prismer Runtime · ' + headerSuffix);
    ui.blank();

    const tableRows = rows.map((r) => {
      const statusLabel = r.status === 'online'
        ? '● online'
        : r.status === 'stopped'
          ? '○ stopped'
          : '· not installed';
      return {
        AGENT: r.name,
        STATUS: statusLabel,
        TIERS: r.tiers,
        'LAST ACTIVE': r.lastActive,
      };
    });

    ui.table(tableRows, { columns: ['AGENT', 'STATUS', 'TIERS', 'LAST ACTIVE'] });
    ui.blank();

    // Tip if any agents not installed
    const notInstalled = rows.filter((r) => r.status === 'not-installed');
    if (notInstalled.length > 0 && detectedCount === 0) {
      ui.line('  No supported agent CLI found on PATH. Get started:');
      ui.blank();
      for (const r of notInstalled.slice(0, 3)) {
        ui.line('    prismer agent install ' + r.name + ' --install-agent');
      }
      ui.blank();
    } else if (stoppedCount > 0) {
      const firstStopped = rows.find((r) => r.status === 'stopped');
      if (firstStopped) {
        ui.tip('prismer agent install ' + firstStopped.name + '   — wire detected agent to the daemon');
      }
    } else if (notInstalled.length > 0) {
      const first = notInstalled[0];
      const catalogEntry = catalog.find((e) => e.name === first.name);
      ui.tip('prismer agent install ' + first.name + ' --install-agent');
      if (catalogEntry?.localSourcePath) {
        ui.secondary('Source detected: ' + catalogEntry.localSourcePath);
      }
      if (catalogEntry?.installCommand) {
        ui.secondary('Agent install: ' + catalogEntry.installCommand);
      }
    }
  } else {
    ui.json(rows);
  }

  return rows;
}

// ============================================================
// Helpers
// ============================================================

function resolveConfigPath(raw: string, homeDir: string): string {
  if (raw.startsWith('~/')) {
    return path.join(homeDir, raw.slice(2));
  }
  return raw;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

// Expose for test use
export { resolveConfigPath };
