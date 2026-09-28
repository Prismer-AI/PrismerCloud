// Per-agent scoped memory capability token (memory203 doc 08 — P0.1, F1).
//
// The security spine for daemon memory RPC. The threat (doc 06 §2.2) is
// agent-vs-agent inside a shared agent-rt pod: any local caller could pass an
// arbitrary `workspaceId` and have the daemon load/write/decrypt another
// workspace's memory. A capability ("cap") closes this: the daemon mints a
// signed, scope-bound token at agent-spawn time, injects it into the agent
// process env, and re-verifies it on every memory RPC.
//
// Chosen mechanism = C3 (doc 08 §1): daemon SELF-SIGNS and SELF-VERIFIES with a
// per-boot key. The daemon is both signer (it knows the authoritative
// agent↔workspace binding from the cloud dispatch HMAC — leg 1) and verifier
// (same process holds the key), so verification is offline (µs-level, no JWKS /
// DB round-trip — preserves local-first) yet carries real per-agent scope.
//
// ── Invariants (asserted by cap.test.ts) ────────────────────────────────────
//   - perBootCapKey = crypto.randomBytes(32), generated lazily on first use,
//     held ONLY in this module's memory. It is NEVER written to disk, NEVER
//     placed in an outbox payload, NEVER returned over RPC, NEVER injected into
//     any agent env (only the *minted token* is injected). Daemon restart →
//     fresh key → all prior caps reject; the daemon re-spawns + re-injects
//     agent processes from the same lifecycle, so no cap is left dangling.
//   - An AGENT cap's scope is exactly one workspace (`['ws:'+workspaceId]`).
//     The wildcard `ws:*` is reserved for the daemon-internal SYSTEM cap and is
//     HARD-REJECTED by mintCap — an agent can never obtain cross-workspace
//     scope.
//   - The cap only AUTHORIZES (gate); it is not the AES key. cap pass → daemon
//     unseals with the local `.memkey` and returns content; the cap never
//     touches key bytes (doc 07 §5).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ============================================================================
// product209/16 §8.2/§8.3 — Cloud authority snapshot + cap v2 (MA-1B)
// ============================================================================

export type MemoryRuntimeCapabilityV1 =
  | 'memory-authority-snapshot-v1'
  | 'memory-replica-manifest-v1'
  | 'memory-replica-content-v1';

/** §8.2 — the three v1 runtime capabilities (single constant source; the
 *  daemon declares these on `agent.host.declare` and the Cloud snapshot
 *  bundle carries the same list — values fixed by the spec). */
export const MEMORY_RUNTIME_CAPABILITIES_V1: readonly MemoryRuntimeCapabilityV1[] = [
  'memory-authority-snapshot-v1',
  'memory-replica-manifest-v1',
  'memory-replica-content-v1',
];

/** §8.3 固定产品参数 — agent cap TTL：15 分钟。 */
export const MEMORY_CAP_TTL_MS = 15 * 60 * 1000;

/**
 * §8.2/§15.2 — the FIRST runtime build containing the SQLite V3 scoped
 * replica (Task 12). Same source as the Cloud's
 * `src/im/services/memory-replica-rollout-command.ts::MIN_STRICT_RUNTIME_VERSION`
 * — the two constants must move together in the release pipeline (the value
 * matches the @prismer/runtime package version reported on host.declare via
 * `resolveDaemonVersion()`). Cloud refuses strict-mode legacy sync with 426
 * `MEMORY_RUNTIME_UPGRADE_REQUIRED { minRuntimeVersion,
 * requiredRuntimeCapabilities }`; this is the payload's minRuntimeVersion.
 */
export const MIN_STRICT_RUNTIME_VERSION = '2.2.12';

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

/** Cloud authority snapshot bundle (60m lease) — daemon-side mirror. */
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

/**
 * Canonical stable stringify — byte-identical to the Cloud side's
 * `stableRuntimeBootstrapJson` (src/lib/runtime-bootstrap-config-version.ts):
 * recursive object key sort, arrays preserved. The golden-vector tests on
 * BOTH ends (src/im/tests/memory-authority-snapshot.test.ts /
 * sdk/prismer/test/memory-cap-v2.test.ts) pin the same sha256 — the two
 * implementations must never drift.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key: string, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

/** snapshotHash = sha256 over the canonical body WITHOUT the hash field. */
export function computeMemoryAuthoritySnapshotHash(
  snapshotWithoutHash: Omit<MemoryAuthoritySnapshotBundleV1, 'snapshotHash'>,
): string {
  // Defensive strip: callers may hand the full bundle (with a present-but
  // empty snapshotHash); the canonical body NEVER includes the field.
  const { snapshotHash: _ignored, ...rest } = snapshotWithoutHash as MemoryAuthoritySnapshotBundleV1;
  return `sha256:${createHash('sha256').update(stableStringify(rest)).digest('hex')}`;
}

export function verifyMemoryAuthoritySnapshotHash(snapshot: MemoryAuthoritySnapshotBundleV1): boolean {
  const { snapshotHash, ...rest } = snapshot;
  return typeof snapshotHash === 'string' && computeMemoryAuthoritySnapshotHash(rest) === snapshotHash;
}

// ── snapshot registry (per-boot, in-memory — same lifecycle as the cap key) ──

const snapshotRegistry = new Map<string, MemoryAuthoritySnapshotBundleV1>();

/**
 * The LOCAL daemon id, verified at registration time (the caller — the
 * runner — always passes its own `config.daemon_id`). §8.3 mint
 * precondition #4: workspace/daemon 匹配。One daemon process has exactly one
 * id; a registration attempt under a different id is rejected, and the mint
 * site cross-checks the snapshot's daemonId against this id. Null = nothing
 * verified yet → mint stays closed (fail closed).
 */
let verifiedLocalDaemonId: string | null = null;

const SNAPSHOT_REPLICA_MODES = new Set(['legacy', 'shadow', 'strict']);
const SNAPSHOT_ACTOR_KINDS = new Set(['agent']);
const SNAPSHOT_PRINCIPAL_KINDS = new Set(['human', 'workspace']);
const SNAPSHOT_AUTHORITIES = new Set(['deputy', 'orchestrator', 'specialist']);

function cleanStringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function isValidActorRow(a: unknown): a is MemoryActorAuthoritySnapshotV1 {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const row = a as Record<string, unknown>;
  if (typeof row.actorId !== 'string' || !row.actorId) return false;
  if (!SNAPSHOT_ACTOR_KINDS.has(row.actorKind as string)) return false;
  if (!SNAPSHOT_PRINCIPAL_KINDS.has(row.principalKind as string)) return false;
  if (typeof row.principalId !== 'string' || !row.principalId) return false;
  if (!SNAPSHOT_AUTHORITIES.has(row.authority as string)) return false;
  if (row.bindingId !== undefined && (typeof row.bindingId !== 'string' || !row.bindingId)) return false;
  if (cleanStringList(row.roleSlugs) === null) return false;
  if (cleanStringList(row.taskIds) === null) return false;
  if (cleanStringList(row.councilIds) === null) return false;
  if (typeof row.canCurate !== 'boolean' || typeof row.canReplicate !== 'boolean') return false;
  return true;
}

function isValidSnapshotShape(s: unknown): s is MemoryAuthoritySnapshotBundleV1 {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const row = s as Record<string, unknown>;
  if (row.schemaVersion !== 1) return false;
  if (typeof row.workspaceId !== 'string' || !row.workspaceId) return false;
  if (typeof row.daemonId !== 'string' || !row.daemonId) return false;
  if (!SNAPSHOT_REPLICA_MODES.has(row.replicaMode as string)) return false;
  if (typeof row.minRuntimeVersion !== 'string' || !row.minRuntimeVersion) return false;
  if (typeof row.accessVersion !== 'number' || !Number.isFinite(row.accessVersion)) return false;
  if (typeof row.replicaSubjectHash !== 'string' || !row.replicaSubjectHash) return false;
  if (typeof row.issuedAt !== 'string' || typeof row.validUntil !== 'string') return false;
  if (typeof row.snapshotHash !== 'string' || !row.snapshotHash) return false;
  if (!Array.isArray(row.requiredRuntimeCapabilities)) return false;
  if (!Array.isArray(row.actors) || !row.actors.every(isValidActorRow)) return false;
  return true;
}

/**
 * Register a Cloud authority snapshot for its workspace. Rejects (returns
 * false, registers nothing — fail closed):
 *   - malformed shape / tampered body (snapshotHash mismatch);
 *   - expired (now >= validUntil) — a stale snapshot can never be re-let;
 *   - **daemonId mismatch** (§8.3 mint precondition #4 — workspace/daemon
 *     匹配；`expectedDaemonId` 必须是本进程的 daemon id，runner 传
 *     `config.daemon_id`。One process = one daemon: a later registration
 *     under a different id cannot switch the bound id);
 *   - an epoch regression (accessVersion lower than the currently registered
 *     snapshot) — authority can only move forward.
 * Idempotent re-registration of the same snapshotHash is a no-op success.
 */
export function registerMemoryAuthoritySnapshot(
  snapshot: unknown,
  expectedDaemonId: string,
  now: number = Date.now(),
): boolean {
  if (!expectedDaemonId) return false;
  if (!isValidSnapshotShape(snapshot)) return false;
  if (snapshot.daemonId !== expectedDaemonId) return false;
  if (verifiedLocalDaemonId !== null && verifiedLocalDaemonId !== expectedDaemonId) return false;
  if (!verifyMemoryAuthoritySnapshotHash(snapshot)) return false;
  const validUntil = Date.parse(snapshot.validUntil);
  const issuedAt = Date.parse(snapshot.issuedAt);
  if (!Number.isFinite(validUntil) || now >= validUntil) return false;
  if (!Number.isFinite(issuedAt) || issuedAt > now) return false;
  verifiedLocalDaemonId = expectedDaemonId;
  const existing = snapshotRegistry.get(snapshot.workspaceId);
  if (existing) {
    if (existing.snapshotHash === snapshot.snapshotHash) return true; // idempotent
    if (snapshot.accessVersion < existing.accessVersion) return false; // stale epoch
  }
  snapshotRegistry.set(snapshot.workspaceId, snapshot);
  return true;
}

/** Drop the registered snapshot — after this, no v2 cap can be minted (fail closed). */
export function invalidateMemoryAuthoritySnapshot(workspaceId: string): void {
  snapshotRegistry.delete(workspaceId);
}

export function getMemoryAuthoritySnapshot(workspaceId: string): MemoryAuthoritySnapshotBundleV1 | null {
  return snapshotRegistry.get(workspaceId) ?? null;
}

// ============================================================================
// Cap claims (§8.3) — v2 payload
// ============================================================================

export interface MemoryCapClaimsV2 {
  ver: 2;
  aud: 'memory';
  sub: string;
  principalKind: 'human' | 'workspace';
  principalId: string;
  ws: string;
  verbs: ('read' | 'write' | 'curate')[];
  roleSlugs: string[];
  taskIds: string[];
  councilIds: string[];
  accessVersion: number;
  replicaSubjectHash: string;
  snapshotHash: string;
  iat: number;
  exp: number;
}

/** Verified capability — what handlers receive after the cap gate. */
export interface MemoryCap {
  /** Subject = the agent's IM user id (or `daemon-system` for the system cap). */
  sub: string;
  /** Bound workspace id (`*` only for the system cap). */
  ws: string;
  /** Scope list, e.g. `['ws:<workspaceId>']`; system cap is `['ws:*']`. */
  scope: string[];
  // product204/34 Track 0.1 — role/council membership carried IN the signed cap
  // so the daemon boundary predicate can judge `role:`/`council:` pages LOCALLY
  // (µs, offline, no cloud round-trip — preserves local-first). The daemon is
  // both minter and verifier (per-boot HMAC), so an agent cannot forge these.
  /** The reader's OWN stable role slug(s). Gates `role:<slug>` reads/writes. */
  roleSlugs?: string[];
  /** True for a workspace orchestrator cap — may read/write any `role:<slug>`. */
  isOrchestrator?: boolean;
  /**
   * The council conversation id(s) this cap is a member of. Gates `council:<id>`
   * reads/writes. Membership is dynamic and per-dispatch, so this is only
   * populated by mint sites that know the current dispatch conversationId
   * (spawn adapters via prismer-env). Absent → `council:*` reads fail CLOSED.
   */
  councilIds?: string[];
  // product209/16 §8.3 — cap v2 claims (present ONLY on v2 caps; v1 decode
  // stays byte-compatible for one release cycle, then v1 mint is removed).
  /** Wire version: 2 = snapshot-derived claims; absent = v1 (legacy compat). */
  ver?: 2;
  /** read/write (all agents) + curate (orchestrator). */
  verbs?: ('read' | 'write' | 'curate')[];
  /** Effective principal of the actor (server-derived). NEVER used as `sub`. */
  principalKind?: 'human' | 'workspace';
  principalId?: string;
  /** Active task ids the actor is assigned to (server-derived, epoch-bound). */
  taskIds?: string[];
  /** Authority epoch + subject hash of the snapshot this cap was minted from. */
  accessVersion?: number;
  replicaSubjectHash?: string;
  snapshotHash?: string;
  /** §8.3 claim timestamps (exp already enforced at verify). */
  iat?: number;
  exp?: number;
}

/** Signed payload (pre-HMAC). Internal — not exported. */
interface CapPayload {
  aud: 'memory';
  sub: string;
  ws: string;
  scope: string[];
  iat: number;
  exp: number;
  // product204/34 Track 0.1 — optional membership claims (omitted from the
  // encoded payload when empty, so legacy caps stay byte-compatible).
  roleSlugs?: string[];
  isOrchestrator?: boolean;
  councilIds?: string[];
}

const VERSION = 'v1';
const AUDIENCE = 'memory';
const WILDCARD_SCOPE = 'ws:*';
const SYSTEM_SUB = 'daemon-system';
/** Default cap lifetime. Generous (covers long agent runs); per-boot key
 *  rotation — not exp — is the primary revocation lever (see file header). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ── per-boot key (module singleton, memory-only) ────────────────────────────
let perBootCapKey: Buffer | null = null;

function capKey(): Buffer {
  if (!perBootCapKey) perBootCapKey = randomBytes(32);
  return perBootCapKey;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64: string): string {
  return b64urlEncode(createHmac('sha256', capKey()).update(payloadB64).digest());
}

function scopeFor(ws: string): string {
  return `ws:${ws}`;
}

/** Constant-time string compare; false (not throw) on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * spec16 §8.1 MA-0S — the wildcard scope (`ws:*`) is the daemon-internal
 * SYSTEM subject's EXCLUSIVE grant. The pure invariant both `verifyCap` and
 * `mintCap` enforce: a cap whose scope carries the wildcard under any other
 * subject is rejected outright (an agent can never hold wildcard scope, even
 * if a mint-site bug ever signed one — defense in depth).
 */
export function wildcardScopeRequiresSystemSub(sub: string, scope: string[]): boolean {
  return !scope.includes(WILDCARD_SCOPE) || sub === SYSTEM_SUB;
}

/**
 * spec16 §13.4 — the cap's own `ws` claim must agree with its scope list. A
 * validly-signed token whose ws field does not match its scope (e.g. ws
 * 'ws_a' + scope ['ws:ws_b']) is a cap-layer workspace mismatch ("cap 本身的
 * ws claim 错") and is rejected at verify — a mint-site bug must never
 * produce a cap whose claims disagree. Wildcard ws requires the wildcard
 * scope (the system shape).
 */
export function capWsClaimMatchesScope(ws: string, scope: string[]): boolean {
  if (ws === '*') return scope.includes(WILDCARD_SCOPE);
  return scope.includes(scopeFor(ws));
}

export interface MintCapOptions {
  /** Override the default lifetime. */
  ttlMs?: number;
  /** Clock injection for tests; defaults to Date.now(). */
  now?: number;
  // product204/34 Track 0.1 — membership claims baked into the signed cap so the
  // daemon boundary predicate can gate role/council pages offline (see MemoryCap).
  /** The agent's OWN stable role slug(s), for `role:<slug>` gating. */
  roleSlugs?: string[];
  /** Whether this is a workspace-orchestrator cap (may touch any `role:`). */
  isOrchestrator?: boolean;
  /** The council conversation id(s) this cap is a member of, for `council:` gating. */
  councilIds?: string[];
}

/** Drop empty/blank entries; return undefined when nothing survives (keeps the
 *  encoded payload byte-compatible with legacy caps that carry no membership). */
function cleanSlugList(list: string[] | undefined): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const cleaned = list.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Mint a legacy v1 AGENT cap bound to exactly one workspace.
 *
 * product209/16 §8.3 — LEGACY minter, retained for ONE compat release cycle
 * (v1 tokens already in circulation must still verify). Production mint
 * sites migrated to `mintCapV2` (new mints only emit v2, snapshot-gated);
 * this function has no production callers and is removed with the v1 decode
 * compat cycle.
 *
 * Throws if `workspaceId` is empty or the wildcard `*` — an agent must never
 * obtain `ws:*` (that is the system cap's exclusive scope).
 */
export function mintCap(sub: string, workspaceId: string, opts: MintCapOptions = {}): string {
  if (!sub) throw new Error('mintCap: sub (agentImUserId) is required');
  if (!workspaceId) throw new Error('mintCap: workspaceId is required');
  if (workspaceId === '*') throw new Error('mintCap: refusing to mint wildcard-scope cap for an agent');
  const now = opts.now ?? Date.now();
  const roleSlugs = cleanSlugList(opts.roleSlugs);
  const councilIds = cleanSlugList(opts.councilIds);
  const payload: CapPayload = {
    aud: AUDIENCE,
    sub,
    ws: workspaceId,
    scope: [scopeFor(workspaceId)],
    iat: now,
    exp: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    ...(roleSlugs ? { roleSlugs } : {}),
    ...(opts.isOrchestrator ? { isOrchestrator: true } : {}),
    ...(councilIds ? { councilIds } : {}),
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

export interface MintCapV2Options {
  /** Override the default 15m lifetime (still clamped to snapshot.validUntil). */
  ttlMs?: number;
  /** Clock injection for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * product209/16 §8.3 — mint a cap v2 ONLY from a valid registered Cloud
 * authority snapshot. Returns `null` (and mints NOTHING) when:
 *   - no snapshot is registered for the workspace (fail closed — including
 *     the lease-expired-and-cloud-unreachable window);
 *   - the snapshot expired (now >= validUntil) — never infinite re-let;
 *   - the actor is not in the snapshot's server-derived actor list
 *     (actor 不在 snapshot 不 mint);
 *   - workspace/daemon mismatch (preconditions #3/#4 — the workspace key
 *     AND the process-bound daemon id re-checked at the mint site).
 * Claims come EXCLUSIVELY from the snapshot actor row (server-derived,
 * epoch-bound): the daemon's own per-dispatch hints are intentionally NOT
 * accepted here (a local claim could widen the Cloud's authority snapshot).
 * cap.exp = min(now + 15m, validUntil) — never beyond snapshot expiry.
 */
export function mintCapV2(sub: string, workspaceId: string, opts: MintCapV2Options = {}): string | null {
  if (!sub || !workspaceId || workspaceId === '*') return null;
  const now = opts.now ?? Date.now();
  const snapshot = snapshotRegistry.get(workspaceId);
  if (!snapshot) return null;
  if (snapshot.workspaceId !== workspaceId) return null;
  // §8.3 mint precondition #4 (I1) — workspace/daemon 匹配。The registry only
  // ever holds snapshots registered under the process-bound daemon id, and
  // this mint-site cross-check re-asserts the pairing (defense in depth: an
  // entry could only carry a foreign daemonId via a bug). No verified local
  // daemon id yet → closed.
  if (verifiedLocalDaemonId === null || snapshot.daemonId !== verifiedLocalDaemonId) return null;
  const validUntil = Date.parse(snapshot.validUntil);
  if (!Number.isFinite(validUntil) || now >= validUntil) return null;
  const actor = snapshot.actors.find((a) => a.actorId === sub);
  if (!actor) return null;
  const ttlMs = Math.min(opts.ttlMs ?? MEMORY_CAP_TTL_MS, validUntil - now);
  if (ttlMs <= 0) return null;
  const verbs: MemoryCapClaimsV2['verbs'] = ['read', 'write'];
  if (actor.canCurate) verbs.push('curate');
  const payload: MemoryCapClaimsV2 = {
    ver: 2,
    aud: AUDIENCE,
    sub,
    principalKind: actor.principalKind,
    principalId: actor.principalId,
    ws: workspaceId,
    verbs,
    roleSlugs: [...actor.roleSlugs],
    taskIds: [...actor.taskIds],
    councilIds: [...actor.councilIds],
    accessVersion: snapshot.accessVersion,
    replicaSubjectHash: snapshot.replicaSubjectHash,
    snapshotHash: snapshot.snapshotHash,
    iat: now,
    exp: now + ttlMs,
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `v2.${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Renew a v2 capability presented by a long-running adapter process.
 *
 * The presented token may be expired, but it must still have a valid signature
 * from THIS daemon boot and a well-formed v2 payload. The old claims are never
 * copied into the new token: `mintCapV2` re-resolves the actor against the
 * CURRENT registered Cloud authority snapshot. Consequently actor removal,
 * snapshot expiry/invalidation, daemon restart, payload tampering, and legacy
 * v1 tokens all fail closed.
 */
export function renewCapV2(
  token: string | undefined | null,
  opts: MintCapV2Options = {},
): string | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payloadB64, sig] = parts as [string, string, string];
  if (version !== 'v2' || !safeEqual(sig, sign(payloadB64))) return null;
  const now = opts.now ?? Date.now();
  const presented = verifyCapV2Payload(payloadB64, now, false);
  if (!presented || presented.ver !== 2) return null;
  return mintCapV2(presented.sub, presented.ws, opts);
}

/**
 * Mint the daemon-internal SYSTEM cap (scope `ws:*`). Minted + used ONLY inside
 * the daemon process for internal paths (outbox flush encryption, cloud
 * invalidate write-down) — NEVER injected into any agent env. This is the only
 * cap permitted to carry the wildcard scope.
 */
export function mintSystemCap(opts: MintCapOptions = {}): string {
  const now = opts.now ?? Date.now();
  const payload: CapPayload = {
    aud: AUDIENCE,
    sub: SYSTEM_SUB,
    ws: '*',
    scope: [WILDCARD_SCOPE],
    iat: now,
    exp: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a cap token against the per-boot key. Returns `{sub, ws, scope}` on
 * success, or `null` on ANY failure (malformed, bad version, tampered
 * signature, wrong audience, expired). Constant-time signature compare.
 *
 * product209/16 §8.3 — decodes BOTH v2 (snapshot-derived claims) and v1
 * (legacy, kept for ONE compat release cycle so already-minted caps still
 * verify). v1 mint sites are migrated to v2; the v1 minter itself is
 * retained only as the compat-cycle encoder.
 */
export function verifyCap(token: string | undefined | null, now: number = Date.now()): MemoryCap | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payloadB64, sig] = parts as [string, string, string];

  // Recompute the signature and constant-time compare. safeEqual short-circuits
  // on length mismatch (timingSafeEqual throws on unequal lengths).
  if (!safeEqual(sig, sign(payloadB64))) return null;

  if (version === 'v2') return verifyCapV2Payload(payloadB64, now);
  if (version !== VERSION) return null;
  return verifyCapV1Payload(payloadB64, now);
}

function verifyCapV1Payload(payloadB64: string, now: number): MemoryCap | null {
  let payload: CapPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as CapPayload;
  } catch {
    return null;
  }
  if (!payload || payload.aud !== AUDIENCE) return null;
  if (typeof payload.sub !== 'string' || typeof payload.ws !== 'string') return null;
  if (!Array.isArray(payload.scope)) return null;
  // spec16 §8.1 — a signed wildcard-scope token under a non-system subject is
  // invalid even with a valid signature (agent wildcard fail-closed).
  if (!wildcardScopeRequiresSystemSub(payload.sub, payload.scope)) return null;
  // spec16 §13.4 — the cap's own ws claim must agree with its scope list
  // (cap-layer workspace mismatch at verify → invalid, even with a valid sig).
  if (!capWsClaimMatchesScope(payload.ws, payload.scope)) return null;
  if (typeof payload.exp !== 'number' || now >= payload.exp) return null;

  // product204/34 Track 0.1 — surface the (optional) membership claims. Sanitize
  // defensively: a malformed field degrades to absent (→ fail-closed at the
  // predicate), never to a wider grant.
  const roleSlugs = cleanSlugList(payload.roleSlugs);
  const councilIds = cleanSlugList(payload.councilIds);
  return {
    sub: payload.sub,
    ws: payload.ws,
    scope: payload.scope,
    ...(roleSlugs ? { roleSlugs } : {}),
    ...(payload.isOrchestrator === true ? { isOrchestrator: true } : {}),
    ...(councilIds ? { councilIds } : {}),
  };
}

/**
 * §8.3 — v2 decode. The payload is EXACTLY the claims set (no scope spine);
 * the verify-time scope is derived from the `ws` claim, so
 * capAllowsWorkspace/capWsClaimMatchesScope semantics carry over unchanged.
 * Defensive sanitation: any malformed claim field degrades to absent
 * (fail-closed at the predicate), never to a wider grant. An agent (non-system)
 * v2 cap can never carry `ws: '*'` (the minter refuses, and here a wildcard
 * ws under a non-system shape fails the scope agreement check).
 */
function verifyCapV2Payload(payloadB64: string, now: number, enforceExpiry = true): MemoryCap | null {
  let payload: MemoryCapClaimsV2;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as MemoryCapClaimsV2;
  } catch {
    return null;
  }
  if (!payload || payload.aud !== AUDIENCE || payload.ver !== 2) return null;
  if (typeof payload.sub !== 'string' || typeof payload.ws !== 'string' || payload.ws === '*') return null;
  if (!Array.isArray(payload.verbs) || payload.verbs.length === 0) return null;
  const verbs = cleanVerbList(payload.verbs);
  if (!verbs) return null;
  if (payload.principalKind !== 'human' && payload.principalKind !== 'workspace') return null;
  if (typeof payload.principalId !== 'string' || !payload.principalId) return null;
  if (typeof payload.accessVersion !== 'number' || !Number.isFinite(payload.accessVersion)) return null;
  if (typeof payload.replicaSubjectHash !== 'string' || typeof payload.snapshotHash !== 'string') return null;
  if (
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= payload.iat ||
    (enforceExpiry && now >= payload.exp)
  ) return null;
  const roleSlugs = cleanSlugList(payload.roleSlugs);
  const taskIds = cleanSlugList(payload.taskIds);
  const councilIds = cleanSlugList(payload.councilIds);
  return {
    sub: payload.sub,
    ws: payload.ws,
    scope: [scopeFor(payload.ws)],
    ver: 2,
    verbs,
    principalKind: payload.principalKind,
    principalId: payload.principalId,
    accessVersion: payload.accessVersion,
    replicaSubjectHash: payload.replicaSubjectHash,
    snapshotHash: payload.snapshotHash,
    iat: payload.iat,
    exp: payload.exp,
    ...(roleSlugs ? { roleSlugs } : {}),
    ...(taskIds ? { taskIds } : {}),
    ...(councilIds ? { councilIds } : {}),
    ...(verbs.includes('curate') ? { isOrchestrator: true } : {}),
  };
}

function cleanVerbList(verbs: unknown): MemoryCapClaimsV2['verbs'] | null {
  if (!Array.isArray(verbs)) return null;
  const seen = new Set<string>();
  const out: MemoryCapClaimsV2['verbs'] = [];
  for (const v of verbs) {
    if (v !== 'read' && v !== 'write' && v !== 'curate') return null;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Does this cap authorize the given workspace? True when the cap's scope holds
 * the wildcard (system cap) or the exact `ws:<workspaceId>`. The single gate
 * predicate used by both the RPC scope check (F2) and the key gate (F3).
 */
export function capAllowsWorkspace(cap: MemoryCap, workspaceId: string): boolean {
  if (!workspaceId) return false;
  return cap.scope.includes(WILDCARD_SCOPE) || cap.scope.includes(scopeFor(workspaceId));
}

/** True for the daemon-internal system cap (wildcard scope). */
export function isSystemCap(cap: MemoryCap): boolean {
  return cap.scope.includes(WILDCARD_SCOPE);
}

/**
 * The daemon-internal SYSTEM cap as a verified object (doc 08 §2.3) — for
 * in-process callers (outbox flush encryption, cloud invalidate write-down)
 * that already run inside the daemon and need to pass the key gate without a
 * token round-trip. NEVER injected into any agent env; agents can only present
 * a token via the RPC header, which `verifyCap` checks against the per-boot key
 * (they cannot forge a `ws:*` token). This is the only cap with wildcard scope.
 */
export function systemCap(): MemoryCap {
  return { sub: SYSTEM_SUB, ws: '*', scope: [WILDCARD_SCOPE] };
}

/**
 * Test-only: drop the per-boot key so the next mint/verify uses a fresh key —
 * simulates a daemon restart (all prior caps reject). Also drops the snapshot
 * registry — both are per-boot state (a restart forgets the authority
 * snapshot; fresh bootstrap must re-register before any v2 cap can exist).
 * NOT for production paths.
 */
export function __resetCapKeyForTest(): void {
  perBootCapKey = null;
  snapshotRegistry.clear();
  verifiedLocalDaemonId = null;
}
