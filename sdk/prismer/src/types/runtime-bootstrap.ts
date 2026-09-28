/**
 * ConfigDelivery — RuntimeConfigBundle type definitions.
 *
 * Cloud-side assembly produces this bundle, daemon-side applies it.
 * SchemaVersion 1 is the initial version; the providerBase field is
 * included from the start (§3.9 protocol seam — coding agent support
 * plane).
 *
 * Design: docs/product209/07-config-delivery-runtime-bootstrap.md §3.3
 *
 * Keep in sync with: sdk/cloud/src/types/runtime-bootstrap.ts
 * and sdk/aip/typescript/src/types/runtime-bootstrap.ts.
 * Protocol fields must match across all three packages.
 */

// ============================================================================
// Hermes provider config (sub-object of the bundle)
// ============================================================================

export interface HermesProviderConfig {
  /** Provider name as registered in hermes custom_providers (e.g. "prismer"). */
  name: string;
  /** Full base URL for the provider endpoint (chain suffix resolved by cloud). */
  baseUrl: string;
  /** Env var name that holds the API key (e.g. "PRISMER_API_KEY"). */
  keyEnv: string;
  /** Hermes api_mode: "chat_completions" (OpenAI-compatible) or "anthropic_messages". */
  apiMode: 'chat_completions' | 'anthropic_messages';
}

export interface HermesBundleConfig {
  /** Provider definition (base_url / key_env / api_mode). */
  provider: HermesProviderConfig;
  /** Workspace-level default model. */
  model: string;
  /** Optional per-profile/per-role model overrides (desktop multi-workspace). */
  models?: Record<string, string>;
  /**
   * Model id → authoritative context window (tokens). Written to
   * `~/.hermes/config.yaml` as `custom_providers[].models.<id>.context_length`
   * — Hermes' step-0 config override, which short-circuits the per-turn
   * endpoint-probe pipeline for context-length resolution.
   */
  modelContextLengths?: Record<string, number>;
}

// ============================================================================
// product209/16 §8.2 — Memory authority snapshot (MA-1B, Task 10)
// ============================================================================

export type MemoryRuntimeCapabilityV1 =
  | 'memory-authority-snapshot-v1'
  | 'memory-replica-manifest-v1'
  | 'memory-replica-content-v1';

/** Server-derived actor authority row. Cloud generates; daemon NEVER submits. */
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

/**
 * Cloud authority snapshot bundle (60m lease). Delivered as the optional
 * `memoryAuthority` field of RuntimeConfigBundle; the daemon mints cap v2
 * ONLY from a valid (unexpired, hash-correct, workspace/daemon-matching)
 * snapshot. `snapshotHash` = sha256 of the canonical body WITHOUT this
 * field (stable key-sorted JSON); it is part of the bundle body and
 * therefore covered by `configVersion`.
 */
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

// ============================================================================
// RuntimeConfigBundle — the full configuration package
// ============================================================================

export interface RuntimeConfigBundle {
  /** Protocol version (1 = initial). */
  schemaVersion: 1;
  /** Content-hash version (sha256 of canonical JSON body). */
  configVersion: string;
  /** Workspace this bundle belongs to. */
  workspaceId: string;
  /** Target daemon (container:<hostname> or desktop UUID). */
  daemonId: string;
  /** AIP signature over configVersion + body (P3 — reserved, not validated in P1). */
  signature?: string;
  /** Env vars to write to ~/.hermes/.env (e.g. PRISMER_API_KEY). */
  env: Record<string, string>;
  /**
   * Cloud root URL (coding agent projection input).
   * §3.9 protocol seam — coding agents read this for base_url construction.
   */
  providerBase: string;
  /** Hermes-specific provider + model config. */
  hermes: HermesBundleConfig;
  /**
   * product209/16 §8.2 — optional Cloud authority snapshot (MA-1B).
   * Absent ⇒ legacy bundle: the daemon mints NO cap v2 and agent Memory RPC
   * fails closed (missing cap → 401). Never required for the config-delivery
   * half of the bundle.
   */
  memoryAuthority?: MemoryAuthoritySnapshotBundleV1;
}

// ============================================================================
// B1 request/response types
// ============================================================================

export interface BootstrapRequest {
  workspaceId: string;
  daemonId: string;
  /** Current configVersion the daemon holds — server returns 304 if same. */
  configVersion?: string;
}

export interface BootstrapResponse {
  /** The bundle, present on 200; undefined on 304 (unchanged). */
  bundle?: RuntimeConfigBundle;
  /** Always echoed back. */
  configVersion: string;
  /** HTTP-level status the daemon should interpret. */
  status: 'ok' | 'unchanged' | 'not_ready' | 'forbidden' | 'unauthorized' | 'error';
}

// ============================================================================
// Daemon-side application state
// ============================================================================

export interface ConfigApplyState {
  /** Last successfully applied configVersion. */
  configVersion: string | null;
  /** ISO timestamp of last successful apply. */
  lastApplyAt: string | null;
  /** Error message from last failed apply, if any. */
  lastApplyError: string | null;
  /** Whether a configVersion ≠ current is pending (queued behind drain). */
  pending: boolean;
}

// ============================================================================
// Backoff helpers
// ============================================================================

/** Backoff schedule per §3.4: 5s → 10s → 30s → 60s cap. */
export const BOOTSTRAP_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000] as const;

export function nextBootstrapBackoffMs(attemptCount: number): number {
  const idx = Math.min(attemptCount, BOOTSTRAP_BACKOFF_MS.length - 1);
  return BOOTSTRAP_BACKOFF_MS[idx]!;
}
