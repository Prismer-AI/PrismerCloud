// Cloud-to-daemon delivery for the live recall policy (spec 11 T5-2).
//
// `MemoryRecallHooks` deliberately needs a synchronous policy provider because
// it runs on the dispatch hot path. This module bridges the async workspace
// read into a per-workspace cache: dispatch refreshes it before a session
// lifecycle observation, then the hook reads the freshest successful value.

import type { CloudClient } from '../../auth.js';
import {
  setRecallPolicyProvider,
  type MemoryRecallPolicy,
  type RecallPolicyProvider,
} from './hooks.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRoleDelivery(value: unknown): MemoryRecallPolicy['roleDelivery'] | null {
  if (!isRecord(value)) return null;
  const delivery: MemoryRecallPolicy['roleDelivery'] = {};
  for (const [role, mode] of Object.entries(value)) {
    if (mode !== 'auto-inject' && mode !== 'search-only') return null;
    delivery[role] = mode;
  }
  return delivery;
}

/** Parse only a complete, safe policy. Invalid policy means hooks use defaults. */
export function parseMemoryRecallPolicy(value: unknown): MemoryRecallPolicy | null {
  if (!isRecord(value)) return null;
  const recallInject = value.recallInject;
  if (!isRecord(recallInject)) return null;
  const digestIndexInject = value.digestIndexInject;
  const firstRoundHybrid = value.firstRoundHybrid;
  const enabled = recallInject.enabled;
  const topK = recallInject.topK;
  const minScore = recallInject.minScore;
  const maxBytes = recallInject.maxBytes;
  if (
    typeof digestIndexInject !== 'boolean' ||
    typeof firstRoundHybrid !== 'boolean' ||
    typeof enabled !== 'boolean' ||
    typeof topK !== 'number' ||
    !Number.isSafeInteger(topK) ||
    topK < 1 ||
    typeof minScore !== 'number' ||
    !Number.isFinite(minScore) ||
    minScore < 0 ||
    minScore > 1 ||
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  ) {
    return null;
  }
  const roleDelivery = validRoleDelivery(value.roleDelivery ?? {});
  if (!roleDelivery) return null;
  return {
    digestIndexInject,
    recallInject: {
      enabled,
      topK,
      minScore,
      maxBytes,
    },
    firstRoundHybrid,
    roleDelivery,
  };
}

export interface CloudRecallPolicyProvider {
  /** Synchronous hook-facing policy lookup. */
  readonly policyFor: RecallPolicyProvider;
  /** Fetch the current workspace metadata and replace this workspace's cache entry. */
  refresh(workspaceId: string): Promise<void>;
  /** Drop one cached policy, or all entries when no workspace is provided. */
  clear(workspaceId?: string): void;
}

/**
 * Build an async policy source over the existing workspace detail endpoint.
 * A transport failure intentionally preserves the last known good policy;
 * successful missing/malformed metadata removes it and restores hook defaults.
 */
export function createCloudRecallPolicyProvider(
  cloud: Pick<CloudClient, 'get'>,
): CloudRecallPolicyProvider {
  const policies = new Map<string, MemoryRecallPolicy>();
  const policyFor: RecallPolicyProvider = (workspaceId) => policies.get(workspaceId) ?? null;

  return {
    policyFor,
    async refresh(workspaceId: string): Promise<void> {
      const id = workspaceId.trim();
      if (!id) return;
      try {
        const workspace = await cloud.get<{ metadata?: unknown }>(
          `/api/im/workspaces/${encodeURIComponent(id)}`,
        );
        const metadata = workspace?.metadata;
        const policy = parseMemoryRecallPolicy(isRecord(metadata) ? metadata.memoryRecallPolicy : undefined);
        if (policy) policies.set(id, policy);
        else policies.delete(id);
      } catch {
        // Local-first: a transient Cloud read must not discard a last-known
        // good policy in the middle of a daemon session.
      }
    },
    clear(workspaceId?: string): void {
      if (workspaceId === undefined) policies.clear();
      else policies.delete(workspaceId);
    },
  };
}

let activeProvider: CloudRecallPolicyProvider | null = null;

/** Register the runner-owned provider with both dispatch and live hooks. */
export function setCloudRecallPolicyProvider(provider: CloudRecallPolicyProvider | null): void {
  activeProvider = provider;
  setRecallPolicyProvider(provider?.policyFor ?? null);
}

export function getCloudRecallPolicyProvider(): CloudRecallPolicyProvider | null {
  return activeProvider;
}

/** Best-effort dispatch entry: no registered runner keeps old behavior. */
export async function refreshRecallPolicyForWorkspace(workspaceId: string): Promise<void> {
  await activeProvider?.refresh(workspaceId);
}
