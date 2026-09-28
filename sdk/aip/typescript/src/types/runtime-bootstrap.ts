/**
 * ConfigDelivery — RuntimeConfigBundle protocol types.
 *
 * Mirrored for AIP SDK consumers. The bundle `signature` field (ed25519) is
 * defined in schemaVersion 1 and reserved for P3 (AIP signing).
 * Design: docs/product209/07-config-delivery-runtime-bootstrap.md §3.3
 *
 * Keep in sync with: sdk/prismer/src/types/runtime-bootstrap.ts
 * and sdk/cloud/src/types/runtime-bootstrap.ts.
 * Protocol fields must match across all three packages.
 */

export interface HermesProviderConfig {
  name: string;
  baseUrl: string;
  keyEnv: string;
  apiMode: 'chat_completions' | 'anthropic_messages';
}

export interface HermesBundleConfig {
  provider: HermesProviderConfig;
  model: string;
  models?: Record<string, string>;
  /**
   * Model id → authoritative context window (tokens). Written to
   * `~/.hermes/config.yaml` as `custom_providers[].models.<id>.context_length`
   * — Hermes' step-0 config override, which short-circuits the per-turn
   * endpoint-probe pipeline for context-length resolution.
   */
  modelContextLengths?: Record<string, number>;
}

export type MemoryRuntimeCapabilityV1 =
  | 'memory-authority-snapshot-v1'
  | 'memory-replica-manifest-v1'
  | 'memory-replica-content-v1';

export interface MemoryActorAuthoritySnapshotV1 {
  actorId: string;
  actorKind: 'agent';
  principalKind: 'human' | 'workspace';
  principalId: string;
  authority: 'deputy' | 'orchestrator' | 'specialist';
  bindingId?: string;
  roleSlugs: readonly string[];
  taskIds: readonly string[];
  councilIds: readonly string[];
  canCurate: boolean;
  canReplicate: boolean;
}

export interface MemoryAuthoritySnapshotBundleV1 {
  schemaVersion: 1;
  workspaceId: string;
  daemonId: string;
  replicaMode: 'legacy' | 'shadow' | 'strict';
  minRuntimeVersion: string;
  requiredRuntimeCapabilities: readonly MemoryRuntimeCapabilityV1[];
  accessVersion: number;
  replicaSubjectHash: string;
  issuedAt: string;
  validUntil: string;
  actors: readonly MemoryActorAuthoritySnapshotV1[];
  snapshotHash: string;
}

export interface RuntimeConfigBundle {
  schemaVersion: 1;
  configVersion: string;
  workspaceId: string;
  daemonId: string;
  /** AIP ed25519 signature over configVersion + canonical body (P3). */
  signature?: string;
  env: Record<string, string>;
  providerBase: string;
  hermes: HermesBundleConfig;
  /** product209/16 §8.2 — optional Cloud authority snapshot (MA-1B). */
  memoryAuthority?: MemoryAuthoritySnapshotBundleV1;
}

export interface BootstrapResponse {
  bundle?: RuntimeConfigBundle;
  configVersion: string;
  status: 'ok' | 'unchanged' | 'not_ready' | 'forbidden' | 'unauthorized' | 'error';
}
