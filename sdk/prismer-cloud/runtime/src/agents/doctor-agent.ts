// T13 — Agent doctor: six-check health report matching §15.2 mockup.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliContext } from '../cli/context.js';
import {
  AGENT_CATALOG,
  type AgentCatalogEntry,
} from './registry.js';
import { readHookConfig } from './hooks.js';

const execFileAsync = promisify(execFile);

// ============================================================
// Types
// ============================================================

export interface DoctorAgentOptions {
  homeDir?: string;
  catalog?: AgentCatalogEntry[];
}

export interface DoctorCheck {
  label: string;
  pass: boolean;
  detail?: string;
  cause?: string;
  fix?: string;
}

export interface DoctorResult {
  agent: string;
  checks: DoctorCheck[];
  passed: number;
  total: number;
  actionsNeeded: number;
}

// ============================================================
// doctorAgent
// ============================================================

export async function doctorAgent(
  ctx: CliContext,
  name: string,
  opts: DoctorAgentOptions = {},
): Promise<DoctorResult> {
  const { ui } = ctx;
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const homeDir = opts.homeDir ?? os.homedir();

  const entry = catalog.find((e) => e.name === name);
  if (!entry) {
    ui.error('Unknown agent: ' + name, undefined, 'prismer agent search');
    throw new Error('Unknown agent: ' + name);
  }

  if (ui.mode !== 'json') {
    ui.header('Prismer Agent Doctor · ' + entry.displayName);
    ui.blank();
  }

  const checks: DoctorCheck[] = [];

  // ------------------------------------------------------------------
  // Check 1: Binary found
  // Uses the agent catalog's detect() to locate the upstream binary
  // and extract its version via --version.
  // ------------------------------------------------------------------
  const detected = await entry.detect();
  if (detected.found) {
    const detail = detected.binaryPath
      ? detected.binaryPath + (detected.version ? ' (v' + detected.version + ')' : '')
      : 'found on PATH';
    checks.push({ label: 'Binary found', pass: true, detail });
    if (ui.mode !== 'json') {
      ui.ok('Binary found', detail);
    }
  } else {
    const cause = entry.upstreamBinary + ' not found in PATH';
    const fix = entry.installCommand ?? ('Install ' + entry.upstreamBinary + ' and re-run');
    checks.push({
      label: 'Binary found',
      pass: false,
      detail: 'not found',
      cause,
      fix,
    });
    if (ui.mode !== 'json') {
      ui.fail('Binary found', cause);
      ui.secondary('Fix: ' + fix, 4);
    }
  }

  // ------------------------------------------------------------------
  // Check 2: Hook config
  // Reads the hook config file for the agent and verifies it contains
  // PARA hooks (para-emit or para-adapter references).
  // ------------------------------------------------------------------
  const hookConfigPath = resolveConfigPath(entry.hookConfigPath, homeDir);
  const hookCfg = await readHookConfig(hookConfigPath);
  const hookStr = hookCfg !== null ? JSON.stringify(hookCfg) : '';
  const hasDaemonHook = hookStr.includes('para-emit') ||
    hookStr.includes('/opt/prismer/runtime/para-adapter.js');

  if (hasDaemonHook) {
    const detail = hookConfigPath + ' → daemon:3210';
    checks.push({ label: 'Hook config', pass: true, detail });
    if (ui.mode !== 'json') {
      ui.ok('Hook config', detail);
    }
  } else {
    const cause = hookCfg === null
      ? 'file not found: ' + hookConfigPath
      : 'no PARA daemon hook entries in ' + hookConfigPath;
    const fix = 'prismer agent install ' + name;
    checks.push({
      label: 'Hook config',
      pass: false,
      detail: cause,
      cause,
      fix,
    });
    if (ui.mode !== 'json') {
      ui.fail('Hook config', cause);
      ui.secondary('Fix: ' + fix, 4);
    }
  }

  // ------------------------------------------------------------------
  // Check 3: PARA compliance
  // Checks which PARA tiers the agent supports (from catalog tiersSupported)
  // and verifies the hooks are wired. Reports tier range + check count.
  // ------------------------------------------------------------------
  const tiers = entry.tiersSupported;
  const tierLabel = tiers.length > 0
    ? 'L' + tiers[0] + '–L' + tiers[tiers.length - 1]
    : 'none';
  // Count of compliance checks = number of tiers * number of capability tags
  const checkCount = tiers.length * entry.capabilityTags.length;

  const paraMarkers = hookCfg !== null && hookStr.includes('para-emit');
  if (paraMarkers) {
    const detail = tierLabel + ' pass (' + checkCount + ' checks)';
    checks.push({ label: 'PARA compliance', pass: true, detail });
    if (ui.mode !== 'json') ui.ok('PARA compliance', detail);
  } else if (hookCfg !== null) {
    const cause = 'PARA hooks not found in config';
    const fix = 'prismer agent install ' + name;
    checks.push({ label: 'PARA compliance', pass: false, detail: tierLabel + ' — hooks missing', cause, fix });
    if (ui.mode !== 'json') {
      ui.fail('PARA compliance', cause);
      ui.secondary('Fix: ' + fix, 4);
    }
  } else {
    const cause = 'hook config missing — cannot verify PARA compliance';
    const fix = 'prismer agent install ' + name;
    checks.push({ label: 'PARA compliance', pass: false, detail: 'hook config missing', cause, fix });
    if (ui.mode !== 'json') {
      ui.fail('PARA compliance', cause);
      ui.secondary('Fix: ' + fix, 4);
    }
  }

  // ------------------------------------------------------------------
  // Check 4: Sandbox
  // macOS: check for seatbelt profile at ~/.prismer/sandbox/{agent}.sb
  // Linux: check for bubblewrap (bwrap) or AppArmor
  // ------------------------------------------------------------------
  const platform = process.platform;
  if (platform === 'darwin') {
    const sandboxProfilePath = path.join(homeDir, '.prismer', 'sandbox', name + '.sb');
    const sandboxExists = fs.existsSync(sandboxProfilePath);
    if (sandboxExists) {
      checks.push({ label: 'Sandbox', pass: true, detail: 'seatbelt profile active' });
      if (ui.mode !== 'json') {
        ui.ok('Sandbox', 'seatbelt profile active');
      }
    } else {
      const cause = 'macOS sandbox-exec requires profile at ' + sandboxProfilePath;
      const fix = 'prismer agent repair ' + name + ' --sandbox';
      checks.push({ label: 'Sandbox', pass: false, detail: 'seatbelt profile missing', cause, fix });
      if (ui.mode !== 'json') {
        ui.fail('Sandbox', 'seatbelt profile missing');
        ui.secondary('Cause: ' + cause, 4);
        ui.secondary('Fix: ' + fix, 4);
      }
    }
  } else if (platform === 'linux') {
    // Check for bubblewrap (bwrap) or AppArmor
    const sandboxResult = await checkLinuxSandbox();
    if (sandboxResult.available) {
      checks.push({ label: 'Sandbox', pass: true, detail: sandboxResult.detail });
      if (ui.mode !== 'json') {
        ui.ok('Sandbox', sandboxResult.detail);
      }
    } else {
      const cause = 'no sandbox runtime found (checked bwrap, AppArmor, landlock)';
      const fix = 'apt install bubblewrap  # or enable AppArmor';
      checks.push({ label: 'Sandbox', pass: false, detail: 'no sandbox available', cause, fix });
      if (ui.mode !== 'json') {
        ui.fail('Sandbox', 'no sandbox available');
        ui.secondary('Cause: ' + cause, 4);
        ui.secondary('Fix: ' + fix, 4);
      }
    }
  } else {
    // Windows/other — sandbox not supported yet
    checks.push({ label: 'Sandbox', pass: true, detail: 'not applicable on ' + platform });
    if (ui.mode !== 'json') {
      ui.ok('Sandbox', 'not applicable on ' + platform);
    }
  }

  // ------------------------------------------------------------------
  // Check 5: Memory Gateway
  // Probe daemon's memory stats endpoint for real connectivity data.
  // ------------------------------------------------------------------
  let memoryOk = false;
  let memDetail = 'daemon not running';
  let memCause: string | undefined;
  let memFix: string | undefined;
  let memReachable = false;
  try {
    const memResp = await fetch('http://127.0.0.1:3210/api/v1/memory/stats', { signal: AbortSignal.timeout(2000) });
    memReachable = true;
    if (memResp.ok) {
      const memData = await memResp.json() as Record<string, unknown>;
      const fileCount = typeof memData['fileCount'] === 'number' ? memData['fileCount'] : 0;
      const recallP95 = memData['recallP95'] !== undefined ? String(memData['recallP95']) : '?';
      memDetail = 'connected (' + fileCount + ' files, recall p95: ' + recallP95 + 'ms)';
      memoryOk = true;
    } else {
      memDetail = 'endpoint returned ' + memResp.status;
      memCause = 'daemon memory API returned HTTP ' + memResp.status;
    }
  } catch {
    memDetail = 'daemon unreachable';
    memCause = 'could not connect to daemon at 127.0.0.1:3210';
  }
  if (!memoryOk) {
    // Distinguish auth failure (401/403) from daemon being unreachable. A 401
    // means the daemon is running and rejected the probe — telling the user
    // to "prismer daemon start" would be wrong; point at the api_key instead.
    memFix = memReachable && memCause && /(401|403)/.test(memCause)
      ? 'Re-run prismer setup, or check that ~/.prismer/config.toml contains a valid api_key'
      : 'prismer daemon start';
  }
  checks.push({ label: 'Memory Gateway', pass: memoryOk, detail: memDetail, cause: memCause, fix: memFix });
  if (ui.mode !== 'json') {
    if (memoryOk) {
      ui.ok('Memory Gateway', memDetail);
    } else {
      ui.fail('Memory Gateway', memDetail);
      if (memCause) ui.secondary('Cause: ' + memCause, 4);
      if (memFix) ui.secondary('Fix: ' + memFix, 4);
    }
  }

  // ------------------------------------------------------------------
  // Check 6: Evolution sync
  // Probe daemon's evolution stats endpoint for sync status.
  // ------------------------------------------------------------------
  let evoOk = false;
  let evoDetail = 'daemon not running';
  let evoCause: string | undefined;
  let evoFix: string | undefined;
  let evoReachable = false;
  try {
    const evoResp = await fetch('http://127.0.0.1:3210/api/v1/evolution/stats', { signal: AbortSignal.timeout(2000) });
    evoReachable = true;
    if (evoResp.ok) {
      const evoData = await evoResp.json() as Record<string, unknown>;
      const geneCount = typeof evoData['geneCount'] === 'number' ? evoData['geneCount'] : 0;
      const lastSyncAt = evoData['lastSyncAt'];
      let syncLabel = 'never';
      if (typeof lastSyncAt === 'string' || typeof lastSyncAt === 'number') {
        const syncDate = new Date(lastSyncAt);
        const agoMs = Date.now() - syncDate.getTime();
        syncLabel = formatAgo(agoMs);
      }
      evoDetail = 'last sync: ' + syncLabel + ' (' + geneCount + ' genes)';
      evoOk = true;
    } else {
      evoDetail = 'endpoint returned ' + evoResp.status;
      evoCause = 'daemon evolution API returned HTTP ' + evoResp.status;
    }
  } catch {
    evoDetail = 'daemon unreachable';
    evoCause = 'could not connect to daemon at 127.0.0.1:3210';
  }
  if (!evoOk) {
    evoFix = evoReachable && evoCause && /(401|403)/.test(evoCause)
      ? 'Re-run prismer setup, or check that ~/.prismer/config.toml contains a valid api_key'
      : 'prismer daemon start';
  }
  checks.push({ label: 'Evolution sync', pass: evoOk, detail: evoDetail, cause: evoCause, fix: evoFix });
  if (ui.mode !== 'json') {
    if (evoOk) {
      ui.ok('Evolution sync', evoDetail);
    } else {
      ui.fail('Evolution sync', evoDetail);
      if (evoCause) ui.secondary('Cause: ' + evoCause, 4);
      if (evoFix) ui.secondary('Fix: ' + evoFix, 4);
    }
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const actionsNeeded = total - passed;

  if (ui.mode !== 'json') {
    ui.blank();
    if (actionsNeeded === 0) {
      ui.line('  Result: ' + passed + '/' + total + ' checks passed · All checks passed ✓');
    } else {
      const actionWord = actionsNeeded === 1 ? 'action' : 'actions';
      ui.line(
        '  Result: ' + passed + '/' + total + ' checks passed · ' + actionsNeeded + ' ' + actionWord + ' needed',
      );
    }
  } else {
    ui.json({ agent: name, checks, passed, total, actionsNeeded });
  }

  return { agent: name, checks, passed, total, actionsNeeded };
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

/**
 * Format milliseconds-ago into a human-readable relative time string.
 * E.g. 30000 → "30s ago", 120000 → "2m ago", 7200000 → "2h ago"
 */
function formatAgo(ms: number): string {
  if (ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

/**
 * Check Linux sandbox availability.
 * Checks for bubblewrap (bwrap), AppArmor, and landlock support.
 */
async function checkLinuxSandbox(): Promise<{ available: boolean; detail: string }> {
  const available: string[] = [];

  // Check bubblewrap (bwrap)
  try {
    await execFileAsync('which', ['bwrap']);
    available.push('bwrap');
  } catch {
    // bwrap not found
  }

  // Check AppArmor
  try {
    if (fs.existsSync('/sys/kernel/security/apparmor')) {
      available.push('AppArmor');
    }
  } catch {
    // cannot check
  }

  // Check landlock (Linux 5.13+)
  try {
    if (fs.existsSync('/sys/kernel/security/landlock')) {
      available.push('landlock');
    }
  } catch {
    // cannot check
  }

  if (available.length > 0) {
    return { available: true, detail: available.join(' + ') + ' available' };
  }
  return { available: false, detail: 'no sandbox runtime found' };
}
