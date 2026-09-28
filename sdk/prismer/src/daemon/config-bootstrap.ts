/**
 * ConfigDelivery — daemon bundle fetch + apply module.
 *
 * Design: docs/product209/07-config-delivery-runtime-bootstrap.md §3.4
 *
 * This module is the single writer for Hermes root config. It:
 * 1. Fetches RuntimeConfigBundle from GET /api/im/runtime/bootstrap
 * 2. Validates the bundle schema
 * 3. Compares content-hash for idempotency (same → skip)
 * 4. Applies: writes ~/.hermes/config.yaml + ~/.hermes/.env
 * 5. Updates daemon env overlay (PRISMER_BASE_URL ← providerBase)
 * 6. Handles error codes (404/500 backoff, 401/403 stop)
 * 7. Key rotation recovery trigger (dispatch 401 → re-bootstrap)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  nextBootstrapBackoffMs,
  type RuntimeConfigBundle,
  type ConfigApplyState,
  type MemoryAuthoritySnapshotBundleV1,
} from '../types/runtime-bootstrap.js';
import { hasInFlight, inFlightCount } from '../adapters/persistence/hermes/session-health.js';

// ============================================================================
// Types
// ============================================================================

export interface BootstrapFetchOptions {
  /** Cloud API base URL for the B1 endpoint. */
  cloudBase: string;
  /** API key for authentication (Bearer). */
  apiKey: string;
  /** Workspace ID to request bundle for. */
  workspaceId: string;
  /** Daemon ID. */
  daemonId: string;
  /** Current configVersion the daemon holds (for 304 idempotent check). */
  configVersion?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface BootstrapFetchResult {
  bundle?: RuntimeConfigBundle;
  configVersion?: string;
  status: 'ok' | 'unchanged' | 'error';
  statusCode: number;
  error?: string;
  /** Cloud `error.code` when the failure body carries one (e.g. SETUP_PIN_PENDING). */
  errorCode?: string;
}

export interface BundleApplyResult {
  applied: boolean;
  configVersion: string;
  error?: string;
}

/**
 * ConfigDelivery B1 is a connection lifecycle action, not a credential-change
 * action.  A daemon normally reconnects with the already-persisted API key, so
 * gating bootstrap on `apiKeyChanged` leaves a freshly restarted daemon with
 * no in-memory configVersion and with pre-config Hermes gateways still alive.
 */
export function bootstrapTargetAfterAuthenticated(input: {
  apiKeyChanged: boolean;
  ackWorkspaceId?: string;
  currentWorkspaceId?: string;
}): string | null {
  return input.ackWorkspaceId?.trim() || input.currentWorkspaceId?.trim() || null;
}

// ============================================================================
// Schema validation
// ============================================================================

export function isValidBundle(obj: unknown): obj is RuntimeConfigBundle {
  if (!obj || typeof obj !== 'object') return false;
  const b = obj as Record<string, unknown>;
  if (b.schemaVersion !== 1) return false;
  if (typeof b.configVersion !== 'string' || !b.configVersion) return false;
  if (typeof b.workspaceId !== 'string' || !b.workspaceId) return false;
  if (typeof b.daemonId !== 'string' || !b.daemonId) return false;
  if (!b.env || typeof b.env !== 'object') return false;
  if (typeof b.providerBase !== 'string' || !b.providerBase) return false;
  if (!b.hermes || typeof b.hermes !== 'object') return false;
  const h = b.hermes as Record<string, unknown>;
  if (!h.provider || typeof h.provider !== 'object') return false;
  const hp = h.provider as Record<string, unknown>;
  if (typeof hp.name !== 'string' || !hp.name) return false;
  if (typeof hp.baseUrl !== 'string' || !hp.baseUrl) return false;
  if (typeof hp.keyEnv !== 'string' || !hp.keyEnv) return false;
  if (hp.apiMode !== 'chat_completions' && hp.apiMode !== 'anthropic_messages') return false;
  if (typeof h.model !== 'string' || !h.model) return false;
  return true;
}

// ============================================================================
// Content-hash comparison
// ============================================================================

function contentHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the SEMANTIC config content — comment lines are stripped first.
 * The generated config.yaml embeds traceability metadata as comments
 * (configVersion, workspaceId), which changes on every bundle while the
 * effective provider config stays identical. Comparing semantic content is
 * what lets applyBundle tell "env-only change, no gateway restart needed"
 * apart from real config churn.
 */
function semanticConfigHash(configYaml: string): string {
  const semantic = configYaml
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return contentHash(semantic);
}

/** Refresh at 45m so the fixed 60m authority lease retains a 15m retry margin. */
export const MEMORY_AUTHORITY_REFRESH_INTERVAL_MS = 45 * 60 * 1000;

/**
 * product210 bugfix — did this registration make a memory cap MINTABLE for an
 * actor that could not mint before? `mintCapV2` needs the actor row inside the
 * registered snapshot (cap.ts precondition #3), so a hermes gateway that
 * spawned before its agent appeared in the snapshot (agent binding landed
 * late, workspace rebuilt and re-provisioned, lease momentarily expired) runs
 * with NO `PRISMER_MEMORY_CAP` and every memory RPC fails closed with
 * `memory_cap_required`. The renewal route cannot heal it — `cap/refresh`
 * only re-mints an ALREADY-authentic token (rpc.ts) — and the previous rebind
 * trigger (`previousMemoryAuthority === null`) had already been consumed by
 * the first (actor-less) registration. This predicate detects the exact flip:
 * at least one LOCAL hermes profile actor is mintable under `next` but was
 * not mintable under `previous` (absent registry, absent actor row, or an
 * expired lease). Routine lease renewals (same actors, fresh validUntil) do
 * NOT flip it, so healthy gateways are never killed by the 45-minute refresh.
 */
export function authorityActorMintableGained(
  previous: MemoryAuthoritySnapshotBundleV1 | null,
  next: MemoryAuthoritySnapshotBundleV1,
  actorIds: readonly string[],
): boolean {
  if (actorIds.length === 0) return false;
  const now = Date.now();
  const mintableActors = (snapshot: MemoryAuthoritySnapshotBundleV1 | null): Set<string> => {
    if (!snapshot) return new Set();
    const validUntil = Date.parse(snapshot.validUntil);
    if (!Number.isFinite(validUntil) || now >= validUntil) return new Set();
    return new Set(snapshot.actors.map((actor) => actor.actorId));
  };
  const nextMintable = mintableActors(next);
  const previousMintable = mintableActors(previous);
  return actorIds.some((id) => nextMintable.has(id) && !previousMintable.has(id));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint only values that change a running provider's behavior. Authority
 * snapshots deliberately do not participate: renewing their lease must update
 * the daemon's in-memory registry without rewriting config or killing Hermes.
 */
export function runtimeBehaviorFingerprint(bundle: RuntimeConfigBundle): string {
  return contentHash(stableJson({
    schemaVersion: bundle.schemaVersion,
    workspaceId: bundle.workspaceId,
    daemonId: bundle.daemonId,
    env: bundle.env,
    providerBase: bundle.providerBase,
    hermes: bundle.hermes,
  }));
}

// ============================================================================
// Hermes root path resolution
// ============================================================================

function getHermesRoot(): string {
  // Respect HERMES_HOME if set (tests, sandbox entrypoints)
  const envHome = process.env.HERMES_HOME;
  if (envHome) return envHome;
  return join(homedir(), '.hermes');
}

// ============================================================================
// YAML generation for hermes config.yaml
// ============================================================================

/** Exported for tests — pure YAML rendering of the hermes config. */
export function generateHermesConfigYaml(bundle: RuntimeConfigBundle): string {
  const provider = bundle.hermes.provider;
  const contextLengths = bundle.hermes.modelContextLengths ?? {};
  const modelIds = Object.keys(contextLengths).sort();
  const lines: string[] = [
    '# Generated by ConfigDelivery — do not edit manually.',
    '# Source: cloud GET /api/im/runtime/bootstrap',
    `# configVersion: ${bundle.configVersion}`,
    `# workspaceId: ${bundle.workspaceId}`,
    // NOTE: no appliedAt timestamp here on purpose — the applyBundle
    // content-hash idempotency check compares this file byte-for-byte, and a
    // timestamp would make every apply look "changed", defeating env-only
    // detection and triggering pointless gateway drains/kills.
    '',
    'custom_providers:',
    `  - name: ${provider.name}`,
    `    base_url: ${provider.baseUrl}`,
    `    key_env: ${provider.keyEnv}`,
    `    api_mode: ${provider.apiMode}`,
  ];
  // Per-model `context_length` under the custom provider entry — Hermes'
  // step-0 config override (`get_custom_provider_context_length`). Without
  // it Hermes probes the provider endpoint (~20 GETs, all 404 on our chat-
  // completions-only proxy) on every turn to resolve context length.
  for (const modelId of modelIds) {
    if (modelIds.indexOf(modelId) === 0) lines.push('    models:');
    lines.push(`      ${modelId}:`);
    lines.push(`        context_length: ${contextLengths[modelId]}`);
  }
  lines.push(
    '',
    'model:',
    `  provider: ${provider.name}`,
    `  default: ${bundle.hermes.model}`,
    `  base_url: ${provider.baseUrl}`,
    `  api_mode: ${provider.apiMode}`,
    '',
  );
  return lines.join('\n');
}

// ============================================================================
// Fetch from B1
// ============================================================================

export async function fetchBootstrapBundle(opts: BootstrapFetchOptions): Promise<BootstrapFetchResult> {
  const url = new URL('/api/im/runtime/bootstrap', opts.cloudBase);
  url.searchParams.set('workspaceId', opts.workspaceId);
  url.searchParams.set('daemonId', opts.daemonId);
  if (opts.configVersion) {
    url.searchParams.set('configVersion', opts.configVersion);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: opts.signal,
    });
  } catch (err) {
    return {
      status: 'error',
      statusCode: 0,
      error: `Network error: ${(err as Error).message}`,
    };
  }

  const statusCode = response.status;
  let body: Record<string, unknown> | undefined;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Empty body or non-JSON
  }

  // Handle error status codes
  if (statusCode !== 200) {
    const errObj = body && typeof body === 'object'
      ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined)
      : undefined;
    const errMsg = errObj?.message ? String(errObj.message) : response.statusText;
    const errorCode = errObj?.code ? String(errObj.code) : undefined;
    return { status: 'error', statusCode, error: errMsg, errorCode };
  }

  // Parse the response
  const data = body?.data as Record<string, unknown> | undefined;
  if (!data) {
    return { status: 'error', statusCode: 200, error: 'Empty response data' };
  }

  const respStatus = String(data.status || '');
  if (respStatus === 'unchanged') {
    return { status: 'unchanged', statusCode: 200, configVersion: String(data.configVersion || '') };
  }

  const bundle = data.bundle;
  if (!bundle || !isValidBundle(bundle)) {
    return { status: 'error', statusCode: 200, error: 'Invalid bundle schema in response' };
  }

  return { status: 'ok', statusCode: 200, bundle, configVersion: String(data.configVersion || '') };
}

// ============================================================================
// Apply bundle to filesystem
// ============================================================================

export function applyBundle(bundle: RuntimeConfigBundle, currentState: ConfigApplyState): BundleApplyResult {
  // Content-hash comparison — skip if same version
  if (currentState.configVersion === bundle.configVersion) {
    return { applied: false, configVersion: bundle.configVersion };
  }

  const hermesRoot = getHermesRoot();
  mkdirSync(hermesRoot, { recursive: true });

  const configPath = join(hermesRoot, 'config.yaml');
  const envPath = join(hermesRoot, '.env');

  // Generate config content
  const configYaml = generateHermesConfigYaml(bundle);
  const configHash = semanticConfigHash(configYaml);

  // Detect config.yaml identity FIRST: an env-only bundle change (tuning
  // knobs delivered via bundle.env) leaves the semantic config identical, and
  // the env surfaces below must still apply on that path. `applied` keeps
  // meaning "semantic config changed" — the runner restarts hermes gateways
  // only on true config churn (daemon-side knobs are read from process.env at
  // call time, so a gateway restart is neither needed nor wanted for them).
  let configChanged = true;
  if (existsSync(configPath)) {
    try {
      const existingContent = readFileSync(configPath, 'utf-8');
      if (semanticConfigHash(existingContent) === configHash) {
        configChanged = false;
      }
    } catch {
      // Can't read — proceed with write
    }
  }

  // ── Config backup BEFORE applying new config (09 §4, WP-E) ──────────
  // Red line 2: write authority belongs to daemon. Manager only reads
  // backups and executes rollback_config. Backup location must be
  // group-readable by sandbox-mgr user. Only taken when config.yaml will
  // actually change — an env-only apply must not clobber the rollback copy
  // with the new .env content.
  if (configChanged) {
    try {
      backupCurrentConfig(hermesRoot, currentState.configVersion);
    } catch (err) {
      process.stderr.write(
        `[ConfigDelivery] config backup failed (non-fatal): ${(err as Error).message}\n`,
      );
    }
  }

  // Write .env with all env key-value pairs (atomic: temp file + rename).
  // Runs on EVERY fingerprint flip — not only on config.yaml changes — so
  // hermes python sees fresh env on its next respawn even for env-only
  // bundles.
  try {
    const existingEnv = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    const envLines = existingEnv.split('\n').filter((l) => {
      // Remove old lines for keys we're about to write
      for (const key of Object.keys(bundle.env)) {
        if (l.startsWith(`${key}=`)) return false;
      }
      return true;
    });
    for (const [key, value] of Object.entries(bundle.env)) {
      envLines.push(`${key}=${value}`);
    }
    const tmpPath = envPath + '.tmp';
    writeFileSync(tmpPath, envLines.join('\n') + '\n', 'utf-8');
    renameSync(tmpPath, envPath);
    process.stderr.write(
      `[ConfigDelivery] wrote ${envPath} (${Object.keys(bundle.env).length} env var(s))\n`,
    );
  } catch (err) {
    return { applied: false, configVersion: bundle.configVersion, error: `Failed to write .env: ${(err as Error).message}` };
  }

  // Apply the delivered env to the daemon's OWN process env. extract.ts and
  // resolveBarrierTimeoutMs read their tuning knobs from process.env at call
  // time — this overlay (not the .env file, which only feeds hermes python)
  // is what makes env-only bundles hot. Cloud decides what ships here via an
  // explicit allowlist; every delivered key is authoritative.
  for (const [key, value] of Object.entries(bundle.env)) {
    if (key) process.env[key] = String(value);
  }
  // Update daemon env overlay (§3.9: PRISMER_BASE_URL ← providerBase)
  if (bundle.providerBase) {
    process.env.PRISMER_BASE_URL = bundle.providerBase;
  }

  // Write config.yaml (atomic: temp file + rename) — only when content changed
  if (configChanged) {
    try {
      const tmpConfigPath = configPath + '.tmp';
      writeFileSync(tmpConfigPath, configYaml, 'utf-8');
      renameSync(tmpConfigPath, configPath);
      process.stderr.write(
        `[ConfigDelivery] wrote ${configPath} (configVersion=${bundle.configVersion})\n`,
      );
    } catch (err) {
      return { applied: false, configVersion: bundle.configVersion, error: `Failed to write config.yaml: ${(err as Error).message}` };
    }
  }

  return { applied: configChanged, configVersion: bundle.configVersion };
}

// ============================================================================
// Config backup (09 §4, WP-E — daemon writes backup before apply)
// ============================================================================

/**
 * Backup current Hermes config before applying a new bundle.
 *
 * Backup location: ~/.prismer/config-backup/
 * The sandbox-manager (running as sandbox-mgr) reads these backups
 * for the rollback_config action. Daemon home is /home/user.
 *
 * Backup is atomic: write to temp file, then rename.
 * Non-fatal: if backup fails, applyBundle continues (logs only).
 */
function backupCurrentConfig(hermesRoot: string, currentVersion: string | null): void {
  const home = homedir();
  const backupDir = join(home, '.prismer', 'config-backup');
  mkdirSync(backupDir, { recursive: true });

  const configYamlSrc = join(hermesRoot, 'config.yaml');
  const envSrc = join(hermesRoot, '.env');
  const configTomlSrc = join(home, '.prismer', 'config.toml');

  // Backup config.yaml (Hermes provider config)
  if (existsSync(configYamlSrc)) {
    const dst = join(backupDir, 'config.yaml');
    const tmp = `${dst}.tmp`;
    copyFileSync(configYamlSrc, tmp);
    renameSync(tmp, dst);
  }

  // Backup .env
  if (existsSync(envSrc)) {
    const dst = join(backupDir, '.env');
    const tmp = `${dst}.tmp`;
    copyFileSync(envSrc, tmp);
    renameSync(tmp, dst);
  }

  // Backup config.toml (daemon config — E9)
  if (existsSync(configTomlSrc)) {
    const dst = join(backupDir, 'config.toml');
    const tmp = `${dst}.tmp`;
    copyFileSync(configTomlSrc, tmp);
    renameSync(tmp, dst);
  }

  // Write metadata
  const metaPath = join(backupDir, 'backup.json');
  const metaTmp = `${metaPath}.tmp`;
  const meta = {
    configVersion: currentVersion ?? 'unknown',
    backedUpAt: new Date().toISOString(),
  };
  writeFileSync(metaTmp, JSON.stringify(meta), 'utf-8');
  renameSync(metaTmp, metaPath);

  process.stderr.write(
    `[ConfigDelivery] config backup written to ${backupDir} (version=${meta.configVersion})\n`,
  );
}

// ============================================================================
// Backoff + retry state machine
// ============================================================================

export type BootstrapStopReason = '401' | '403';

export interface BootstrapState {
  /** Current configVersion (null = never successfully fetched). */
  configVersion: string | null;
  /** Hash of runtime-affecting fields; excludes the renewable authority lease. */
  runtimeFingerprint: string | null;
  /** Consecutive failure count (reset on success). */
  failureCount: number;
  /** When to attempt next fetch (0 = immediately). */
  nextAttemptAt: number;
  /** If set, retries are stopped (401/403). */
  stoppedReason: BootstrapStopReason | null;
  /**
   * First time the cloud answered 403 SETUP_PIN_PENDING (the setup runner is
   * still mid-stage and hasn't persisted the canonical key pin). Null when
   * never seen. Bounds the retry window: past SETUP_PIN_RETRY_WINDOW_MS the
   * pin-less 403 becomes terminal like any other 403.
   */
  pinPendingSince: number | null;
  /** Last successful apply timestamp. */
  lastApplyAt: number | null;
  /** Last error message. */
  lastError: string | null;
  /** Whether a bundle is queued behind drain (gateway in-flight). */
  pending: boolean;
  /** Retry timer handle for cleanup. */
  timer: ReturnType<typeof setTimeout> | null;
}

export function createBootstrapState(): BootstrapState {
  return {
    configVersion: null,
    runtimeFingerprint: null,
    failureCount: 0,
    nextAttemptAt: 0,
    stoppedReason: null,
    pinPendingSince: null,
    lastApplyAt: null,
    lastError: null,
    pending: false,
    timer: null,
  };
}

export function resetBootstrapStopped(state: BootstrapState): void {
  state.stoppedReason = null;
  state.failureCount = 0;
  state.nextAttemptAt = 0;
  state.pinPendingSince = null;
}

/** A first B1 fetch can race the Cloud's host-declare persistence on boot.
 *
 * A later `host.acked` is authoritative proof that this exact daemon was
 * accepted. Retry only that narrow transient 403; API-key/workspace 403s stay
 * terminal and never become a heartbeat retry loop.
 */
export function shouldRetryBootstrapAfterAcceptedDeclare(state: BootstrapState): boolean {
  return state.stoppedReason === '403'
    && /Daemon is not registered in this workspace/i.test(state.lastError ?? '');
}

/** How long a 403 SETUP_PIN_PENDING (setup still mid-stage, pin not persisted)
 * may keep the bootstrap retrying before it degrades to a terminal 403. */
export const SETUP_PIN_RETRY_WINDOW_MS = 5 * 60_000;

/**
 * Compute the next backoff or stop based on HTTP status code.
 *
 * - 404/500: exponential backoff (5s → 10s → 30s → 60s cap)
 * - 401: stop retries (key invalid; reset by adoption event)
 * - 403: stop retries (cross-workspace; needs human intervention)
 * - 403 SETUP_PIN_PENDING: backoff while the workspace setup finishes pinning
 *   its canonical API key (the pod boots before the pin persist lands); past
 *   SETUP_PIN_RETRY_WINDOW_MS the pin never arrived → terminal 403
 * - Network error (statusCode=0): backoff
 */
export function computeBootstrapErrorAction(
  statusCode: number,
  state: BootstrapState,
  errorCode?: string,
): { action: 'backoff' | 'stop'; nextDelayMs: number; reason: BootstrapStopReason | null } {
  if (statusCode === 401) {
    return { action: 'stop', nextDelayMs: 0, reason: '401' };
  }
  if (statusCode === 403) {
    if (errorCode === 'SETUP_PIN_PENDING') {
      const now = Date.now();
      state.pinPendingSince ??= now;
      if (now - state.pinPendingSince > SETUP_PIN_RETRY_WINDOW_MS) {
        return { action: 'stop', nextDelayMs: 0, reason: '403' };
      }
      return { action: 'backoff', nextDelayMs: nextBootstrapBackoffMs(state.failureCount), reason: null };
    }
    return { action: 'stop', nextDelayMs: 0, reason: '403' };
  }
  // 404, 500, 0 (network error) → backoff
  const delayMs = nextBootstrapBackoffMs(state.failureCount);
  return { action: 'backoff', nextDelayMs: delayMs, reason: null };
}

export function toApplyState(state: BootstrapState): ConfigApplyState {
  return {
    configVersion: state.configVersion,
    lastApplyAt: state.lastApplyAt ? new Date(state.lastApplyAt).toISOString() : null,
    lastApplyError: state.lastError,
    pending: state.pending,
  };
}

/**
 * product209/07 §3.7.4 — derive a healthz `config` segment snapshot from
 * the daemon's bootstrapStates map.
 *
 * Multiple workspaces: prefers the given `workspaceId`; falls back to
 * the first entry in the map. Returns a zero-state snapshot when the
 * map is empty (callers gate on map.size > 0 to omit the key via spread).
 */
export interface BootstrapConfigSnapshot {
  configVersion: string | null;
  lastApplyAt: string | null;
  lastApplyError: string | null;
  pending: boolean;
}

export function bootstrapConfigSnapshot(
  workspaceId: string | null,
  bootstrapStates: Map<string, BootstrapState>,
): BootstrapConfigSnapshot {
  let state: BootstrapState | undefined;
  if (workspaceId) {
    state = bootstrapStates.get(workspaceId);
  }
  if (!state) {
    const first = bootstrapStates.values().next();
    state = first.done ? undefined : first.value;
  }
  if (!state) {
    return { configVersion: null, lastApplyAt: null, lastApplyError: null, pending: false };
  }
  return {
    configVersion: state.configVersion,
    lastApplyAt: state.lastApplyAt ? new Date(state.lastApplyAt).toISOString() : null,
    lastApplyError: state.lastError,
    pending: state.pending,
  };
}

// ============================================================================
// Drain before gateway kill (§3.4)
// ============================================================================

export interface DrainBeforeKillOptions {
  /** Max time to wait for in-flight turns to complete (ms). Default 5 min. */
  maxWaitMs?: number;
  /** Poll interval (ms). Default 2 000. */
  pollMs?: number;
}

export interface DrainBeforeKillResult {
  drained: boolean;
  waitedMs: number;
  remainingInFlight: number;
}

/**
 * Wait until no hermes sessions have in-flight turns, then resolve.
 * If the max wait time is exceeded, resolve with `drained: false` so the
 * caller can decide whether to force-kill or defer.
 *
 * §3.4: kill gateway MUST drain first — an in-flight turn with a half-written
 * transcript pollutes the session and the next turn returns EMPTY.
 */
export async function drainBeforeGatewayKill(
  opts: DrainBeforeKillOptions = {},
): Promise<DrainBeforeKillResult> {
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
  const pollMs = opts.pollMs ?? 2_000;
  const started = Date.now();

  while (hasInFlight()) {
    const elapsed = Date.now() - started;
    if (elapsed >= maxWaitMs) {
      const remaining = inFlightCount();
      process.stderr.write(
        `[ConfigDelivery] drain timeout (${elapsed}ms, ${remaining} in-flight remaining) — proceeding with kill\n`,
      );
      return { drained: false, waitedMs: elapsed, remainingInFlight: remaining };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const waitedMs = Date.now() - started;
  process.stderr.write(
    `[ConfigDelivery] drain complete (${waitedMs}ms, no in-flight turns)\n`,
  );
  return { drained: true, waitedMs, remainingInFlight: 0 };
}
