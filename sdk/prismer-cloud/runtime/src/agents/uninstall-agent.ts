// T13 — Uninstall agent: restore hooks via rollback, remove sandbox profile.
//
// Keychain entries (prismer-config/*) are preserved — user may reinstall.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliContext } from '../cli/context.js';
import { promptConfirm } from '../cli/confirm.js';
import {
  AGENT_CATALOG,
  type AgentCatalogEntry,
} from './registry.js';
import { rollbackHooks } from './hooks.js';
import { removeAgent } from './agents-registry.js';

// ============================================================
// Types
// ============================================================

export interface UninstallAgentOptions {
  yes?: boolean;
  homeDir?: string;
  catalog?: AgentCatalogEntry[];
}

export interface UninstallAgentResult {
  agent: string;
  hooksRestored: boolean;
  sandboxRemoved: boolean;
}

// Thrown when the user explicitly declines the confirmation prompt.
// The CLI layer treats this as a clean cancellation (exit 0 in pretty mode).
export class UninstallCancelledError extends Error {
  constructor() {
    super('Uninstall cancelled by user');
    this.name = 'UninstallCancelledError';
  }
}

// ============================================================
// uninstallAgent
// ============================================================

export async function uninstallAgent(
  ctx: CliContext,
  name: string,
  opts: UninstallAgentOptions = {},
): Promise<UninstallAgentResult> {
  const { ui } = ctx;
  const catalog = opts.catalog ?? AGENT_CATALOG;
  const homeDir = opts.homeDir ?? os.homedir();

  const entry = catalog.find((e) => e.name === name);
  if (!entry) {
    ui.error('Unknown agent: ' + name, undefined, 'prismer agent search');
    throw new Error('Unknown agent: ' + name);
  }

  const hookConfigPath = resolveConfigPath(entry.hookConfigPath, homeDir);
  const sandboxProfilePath = path.join(homeDir, '.prismer', 'sandbox', name + '.sb');

  // -------------------------------------------------------
  // Confirmation gate — must happen before any destructive work.
  // -------------------------------------------------------
  if (!opts.yes) {
    if (ui.mode === 'json') {
      // Machine callers must pass --yes; we cannot prompt in JSON mode.
      throw Object.assign(
        new Error('--yes required in JSON/non-interactive mode'),
        { code: 'CONFIRMATION_REQUIRED' },
      );
    }

    const stdin = process.stdin as NodeJS.ReadStream;
    if (!stdin.isTTY) {
      throw new Error('Confirmation required: pass --yes for non-interactive use');
    }

    // Interactive TTY: prompt the user.
    process.stderr.write(
      `Remove ${entry.displayName}?\n` +
      `  - Hooks in ${hookConfigPath} will be rolled back to the pre-install backup.\n` +
      `  - Sandbox profile at ${sandboxProfilePath} will be deleted.\n`,
    );
    const confirmed = await promptConfirm('Confirm [y/N]: ');
    if (!confirmed) {
      ui.secondary('Cancelled');
      throw new UninstallCancelledError();
    }
  }

  if (ui.mode !== 'json') {
    ui.header('Uninstalling ' + entry.displayName);
    ui.blank();
  }

  // Step 1: Restore hooks via rollback
  const rollbackResult = await rollbackHooks(hookConfigPath);

  let hooksRestored = false;
  if (rollbackResult.restored) {
    hooksRestored = true;
    const fromBackup = rollbackResult.fromBackup ?? 'backup';
    ui.ok('Hooks restored', 'from ' + path.basename(fromBackup));
  } else {
    ui.secondary('No hook backup found — hooks unchanged');
  }

  // Step 2: Remove sandbox profile if it exists (macOS only)
  let sandboxRemoved = false;
  if (fs.existsSync(sandboxProfilePath)) {
    try {
      fs.unlinkSync(sandboxProfilePath);
      sandboxRemoved = true;
      ui.ok('Sandbox profile removed', sandboxProfilePath);
    } catch (err) {
      ui.fail('Failed to remove sandbox profile', String(err));
    }
  } else {
    ui.secondary('No sandbox profile found');
  }

  // Step 3: Remove version sidecar so stale markers don't linger after reinstall.
  const versionFilePath = path.join(homeDir, '.prismer', 'agents', name + '.version');
  try {
    fs.unlinkSync(versionFilePath);
  } catch {
    // Missing sidecar is fine — ignore
  }

  // Step 4: Remove from agents.json registry.
  removeAgent(homeDir, name);

  ui.blank();
  ui.line(entry.displayName + ' uninstalled.');

  return { agent: name, hooksRestored, sandboxRemoved };
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

