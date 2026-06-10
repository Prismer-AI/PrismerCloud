/**
 * Release 200 §6.1 — write a single `im_sandbox_resource_samples` row from a
 * healthy `probeDaemon` response.
 *
 * The daemon's `/healthz` response (Release 200 §5.4) carries a `resources`
 * block (`cpu.usagePct`, `mem.usedBytes`, `mem.limitBytes`). The reconciler
 * (S5) calls this helper on every healthy probe (~30s per row).
 *
 * Failure handling — best-effort:
 *   - FK violation (container row deleted between probe + insert): swallowed
 *     silently; the sample is irrelevant once the container is gone.
 *   - Any other DB error: logged at warn level; reconciler keeps going.
 *
 * This helper MUST NOT throw — the reconciler treats sample writes as
 * advisory and a failure here must not block status updates.
 */

import { randomBytes } from 'node:crypto';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { ProbeDaemonResult } from '@/lib/sandbox/types';

// S6/T5 (2026-05-18): 24-char alphanumeric id fits within the varchar(30)
// column. randomUUID() (36 chars + dashes) overflows the schema.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generateSampleId(): string {
  const bytes = randomBytes(24);
  let id = '';
  for (let i = 0; i < 24; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

/**
 * Shape of the daemon `/healthz` response's `resources` block we read.
 * Kept structural (not imported from the daemon types) so the cloud side
 * doesn't pin to a single daemon SDK build — graceful-degrade on missing
 * fields is the explicit contract.
 */
interface ResourcesBlock {
  cpu?: { usagePct?: number };
  mem?: { usedBytes?: number; limitBytes?: number };
}

interface HealthzRaw {
  resources?: ResourcesBlock;
}

export async function writeResourceSample(containerId: string, probe: ProbeDaemonResult): Promise<void> {
  const raw = probe.raw as HealthzRaw | undefined;
  const cpuUsagePct = Number(raw?.resources?.cpu?.usagePct ?? 0);
  const memUsed = Number(raw?.resources?.mem?.usedBytes ?? 0);
  const memLimit = Number(raw?.resources?.mem?.limitBytes ?? 0);

  try {
    await prisma.iMSandboxResourceSample.create({
      data: {
        // S6/T5 fix — see generateSampleId above for rationale (varchar(30) col;
        // randomUUID overflowed silently inside the best-effort catch).
        id: generateSampleId(),
        containerId,
        sampledAt: new Date(),
        cpuUsagePct,
        memUsedBytes: BigInt(Math.max(0, Math.trunc(memUsed))),
        memLimitBytes: BigInt(Math.max(0, Math.trunc(memLimit))),
        daemonRttMs: Math.max(0, Math.trunc(probe.latencyMs)),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FK violation: container row was deleted between probe + insert. This
    // is benign (sample is moot once the container is gone).
    if (/foreign key/i.test(msg)) return;
    logger.warn({ err: msg, containerId }, '[ResourceSample] write failed (best-effort, ignored)');
  }
}
