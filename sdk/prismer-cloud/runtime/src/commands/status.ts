// T14 — `prismer status` — full-system dashboard

import type { CliContext } from '../cli/context.js';
import { statusDashboard } from './daemon.js';

/**
 * Top-level `prismer status` command — full system overview per §15.2.
 *
 * Distinct from `prismer daemon status`, which is the low-level
 * "is my local daemon alive" probe (PID + port only, no cloud calls).
 * `prismer status` renders the full dashboard: agents, memory, evolution,
 * transport, devices.
 */
export async function statusCommand(
  ctx: CliContext,
  opts?: { pairedDevicesPath?: string; now?: () => number },
): Promise<void> {
  ctx.ui.banner('Runtime CLI v1.9.0');
  await statusDashboard(ctx, opts);
}
