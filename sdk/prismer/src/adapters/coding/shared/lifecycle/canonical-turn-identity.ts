import { createHash } from 'node:crypto';

export interface CanonicalTurnIdentityInput {
  taskId?: string;
  runId?: string;
  providerTurnId?: string;
}

export interface CanonicalTurnIdentity {
  canonicalTurnId: string;
  runId?: string;
  providerTurnId?: string;
}

export function resolveCanonicalTurnIdentity(_input: CanonicalTurnIdentityInput): CanonicalTurnIdentity {
  const taskId = clean(_input.taskId);
  const requestedRunId = clean(_input.runId);
  const providerTurnId = clean(_input.providerTurnId);
  // Cloud dispatch ids are the cross-process authority. Hermes provider ids
  // (`api_*`) are useful provenance, but must never split the same cloud turn
  // into a second durability job.
  const runId = preferCloudRunId(requestedRunId, taskId);
  const canonicalTurnId = runId ?? taskId ?? providerTurnId;
  if (!canonicalTurnId) throw new Error('canonical turn identity requires taskId, runId, or providerTurnId');
  return {
    canonicalTurnId,
    ...(runId ? { runId } : {}),
    ...(providerTurnId && providerTurnId !== canonicalTurnId ? { providerTurnId } : {}),
  };
}

export function canonicalDurabilityCommitKey(_input: {
  workspaceId: string;
  agentImUserId: string;
  canonicalTurnId: string;
}): string {
  const canonical = [
    clean(_input.workspaceId),
    clean(_input.agentImUserId),
    clean(_input.canonicalTurnId),
  ];
  if (canonical.some((value) => !value)) {
    throw new Error('durability commit key requires workspace, agent, and canonical turn');
  }
  return `durability:${createHash('sha256').update(canonical.join('\u0000')).digest('hex')}`;
}

function preferCloudRunId(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.startsWith('run_')) ?? values.find(Boolean);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
