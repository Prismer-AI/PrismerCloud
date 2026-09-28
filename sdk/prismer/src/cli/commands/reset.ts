// `prismer reset` — local runtime unbind/reset.
//
// This is deliberately local-only: it stops the daemon and removes the local
// binding/state so the next `prismer setup` can bind a different account. It
// does not revoke API keys in cloud; revocation is a separate account action.

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolvePaths } from '../../config.js';
import {
  clearPidFile,
  exitWithError,
  pidAlive,
  printJson,
  readPidFile,
  runAction,
} from '../util.js';
import { getUI } from '../ui.js';

interface ResetOptions {
  yes?: boolean;
  check?: boolean;
  wipe?: boolean;
  timeout?: number;
  json?: boolean;
}

interface ResetPlan {
  root: string;
  exists: boolean;
  runningPid: number | null;
  mode: 'archive' | 'wipe';
  archivePath: string | null;
  assetSyncRoot: string;
  assetSyncExists: boolean;
  assetSyncArchivePath: string | null;
  hermesHome: string;
  hermesExists: boolean;
  hermesArchivePath: string | null;
  hermesGatewayPids: number[];
  willStopDaemon: boolean;
  nextStep: string;
}

export function buildResetCommand(): Command {
  return new Command('reset')
    .description('Stop daemon and reset local runtime state so setup can bind another account')
    .option('--yes', 'Actually perform the reset')
    .option('--check', 'Print the reset plan without changing files')
    .option('--wipe', 'Delete local state instead of archiving it')
    .option('--timeout <ms>', 'Time to wait for daemon shutdown (default 5000)', (v) => Number.parseInt(v, 10), 5000)
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[ResetOptions]>(async (opts) => {
      const paths = resolvePaths();
      const pid = readPidFile(paths);
      const runningPid = pid && pidAlive(pid) ? pid : null;
      const archivePath = opts.wipe ? null : `${paths.root}.reset.${timestamp()}`;
      const assetSyncRoot = resolveAssetSyncRoot();
      const assetSyncArchivePath = opts.wipe ? null : `${assetSyncRoot}.reset.${timestamp()}`;
      const hermesHome = resolveHermesHome();
      const hermesArchivePath = opts.wipe ? null : `${hermesHome}.reset.${timestamp()}`;
      const hermesGatewayPids = findHermesGatewayPids();
      const plan: ResetPlan = {
        root: paths.root,
        exists: existsSync(paths.root),
        runningPid,
        mode: opts.wipe ? 'wipe' : 'archive',
        archivePath,
        assetSyncRoot,
        assetSyncExists: existsSync(assetSyncRoot),
        assetSyncArchivePath,
        hermesHome,
        hermesExists: existsSync(hermesHome),
        hermesArchivePath,
        hermesGatewayPids,
        willStopDaemon: runningPid !== null,
        nextStep: 'prismer setup',
      };

      if (opts.check) {
        printPlan(plan, opts.json);
        return;
      }

      if (!opts.yes) {
        exitWithError('Refusing to reset without --yes. Run `prismer reset --check` to preview.', {
          code: 'confirmation_required',
        });
      }

      if (runningPid !== null) {
        await stopDaemon(runningPid, opts.timeout ?? 5000);
        clearPidFile(paths);
      } else if (pid) {
        clearPidFile(paths);
      }

      for (const gatewayPid of hermesGatewayPids) {
        await stopProcess(gatewayPid, opts.timeout ?? 5000, 'Hermes gateway');
      }

      if (existsSync(paths.root)) {
        if (opts.wipe) {
          rmSync(paths.root, { recursive: true, force: true });
        } else {
          if (!archivePath) throw new Error('internal: archivePath missing');
          if (!existsSync(dirname(archivePath))) {
            mkdirSync(dirname(archivePath), { recursive: true });
          }
          renameSync(paths.root, archivePath);
        }
      }
      if (existsSync(assetSyncRoot)) {
        if (opts.wipe) {
          rmSync(assetSyncRoot, { recursive: true, force: true });
        } else {
          if (!assetSyncArchivePath) throw new Error('internal: assetSyncArchivePath missing');
          if (!existsSync(dirname(assetSyncArchivePath))) {
            mkdirSync(dirname(assetSyncArchivePath), { recursive: true });
          }
          renameSync(assetSyncRoot, assetSyncArchivePath);
        }
      }
      if (existsSync(hermesHome)) {
        if (opts.wipe) {
          rmSync(hermesHome, { recursive: true, force: true });
        } else {
          if (!hermesArchivePath) throw new Error('internal: hermesArchivePath missing');
          if (!existsSync(dirname(hermesArchivePath))) {
            mkdirSync(dirname(hermesArchivePath), { recursive: true });
          }
          renameSync(hermesHome, hermesArchivePath);
        }
      }
      mkdirSync(paths.root, { recursive: true });

      if (opts.json) {
        printJson({ ok: true, reset: true, plan });
        return;
      }
      const ui = getUI();
      ui.ok('Runtime reset complete', paths.root);
      if (archivePath) ui.line(`  archived: ${archivePath}`);
      if (assetSyncArchivePath && plan.assetSyncExists) ui.line(`  asset sync archived: ${assetSyncArchivePath}`);
      if (hermesArchivePath && plan.hermesExists) ui.line(`  Hermes archived: ${hermesArchivePath}`);
      if (hermesGatewayPids.length > 0) ui.line(`  stopped Hermes gateway pid(s): ${hermesGatewayPids.join(', ')}`);
      ui.line('  next: prismer setup');
    }, { code: 'reset_failed' }));
}

function printPlan(plan: ResetPlan, json?: boolean): void {
  if (json) {
    printJson({ ok: true, check: true, plan });
    return;
  }
  const ui = getUI();
  ui.header('Runtime reset plan');
  ui.blank();
  ui.line(`  root:        ${plan.root}`);
  ui.line(`  exists:      ${plan.exists ? 'yes' : 'no'}`);
  ui.line(`  daemon:      ${plan.runningPid ? `running pid ${plan.runningPid}` : 'not running'}`);
  ui.line(`  mode:        ${plan.mode}`);
  if (plan.archivePath) ui.line(`  archive:     ${plan.archivePath}`);
  ui.line(`  asset sync:  ${plan.assetSyncExists ? plan.assetSyncRoot : `${plan.assetSyncRoot} (not found)`}`);
  if (plan.assetSyncArchivePath) ui.line(`  asset archive: ${plan.assetSyncArchivePath}`);
  ui.line(`  Hermes:     ${plan.hermesExists ? plan.hermesHome : `${plan.hermesHome} (not found)`}`);
  if (plan.hermesArchivePath) ui.line(`  Hermes archive: ${plan.hermesArchivePath}`);
  ui.line(
    `  Hermes gateway: ${plan.hermesGatewayPids.length > 0 ? `running pid(s) ${plan.hermesGatewayPids.join(', ')}` : 'not running'}`,
  );
  ui.blank();
  ui.line('Run `prismer reset --yes` to apply, then `prismer setup` to bind a new account.');
}

async function stopDaemon(pid: number, timeoutMs: number): Promise<void> {
  await stopProcess(pid, timeoutMs, 'daemon');
}

async function stopProcess(pid: number, timeoutMs: number, label: string): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new Error(`SIGTERM failed for ${label} pid ${pid}: ${(err as Error).message}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    throw new Error(`SIGKILL failed for ${label} pid ${pid}: ${(err as Error).message}`);
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (!pidAlive(pid)) return;
    await sleep(100);
  }
  throw new Error(`${label} pid ${pid} did not exit within ${timeoutMs + 1000}ms`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveAssetSyncRoot(): string {
  const override = process.env.PRISMER_ASSET_SYNC_ROOT;
  if (override) return override;
  const home = homedir();
  const desktop = join(home, 'Desktop');
  const base = existsSync(desktop) ? desktop : home;
  return join(base, 'Prismer Assets');
}

function resolveHermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}

function findHermesGatewayPids(): number[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const current = process.pid;
    return out
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        const match = /^(\d+)\s+(.+)$/.exec(trimmed);
        if (!match) return null;
        const pid = Number.parseInt(match[1]!, 10);
        const command = match[2]!;
        if (!Number.isFinite(pid) || pid === current) return null;
        if (!isHermesGatewayCommand(command)) return null;
        return pid;
      })
      .filter((pid): pid is number => pid !== null);
  } catch {
    return [];
  }
}

function isHermesGatewayCommand(command: string): boolean {
  if (!/\bgateway\b/.test(command) || !/\brun\b/.test(command)) return false;
  return /(^|\s)(?:\S*\/)?hermes(?:\s|$)/.test(command);
}
