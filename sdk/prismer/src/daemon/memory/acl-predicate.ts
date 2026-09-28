// Daemon-side memory ACL boundary predicate (memory203 doc 08 §2, F5).
//
// The "same ACL predicate, two projections" rule (06 §2.3#5, 07 §5): the daemon
// resolver and the cloud resolver must not drift. The CLOUD holds the FULL
// projection — src/im/services/memory-acl.ts: delegated-agent enumeration,
// orchestrator authority, task:* prefixes, secret-ref policy, the whole aclJson.
// The DAEMON holds the BOUNDARY SUBSET: just what its local subset schema can
// answer cheaply and offline — workspace scope (from the cap) + page-level
// visibility kind (workspace / agent / private). It deliberately does NOT
// re-implement the superset's governance (that stays cloud-side, authoritative
// + auditable). Two layers, no duplication:
//   - daemon: "may this agent touch this workspace's page at all?" (cheap,
//     local, blocks cross-workspace + cross-agent-private leakage)
//   - cloud:  "...and is it allowed under the full aclJson / governance?"
//
// This mirrors the cloud `buildContext().check` shape: workspace-visible pages
// are readable by any in-workspace caller; agent/private pages are readable only
// by their owning subject. The daemon-internal system cap (wildcard scope) sees
// everything — it is the daemon itself, never an agent.

import { capAllowsWorkspace, isSystemCap, type MemoryCap } from './cap.js';
import type { MemoryVisibility } from './types.js';

/** Minimal page shape the boundary predicate needs (subset of MemoryPage). */
export interface BoundaryPage {
  workspaceId: string;
  visibility: MemoryVisibility;
  /**
   * product209/16 §8.3/§9.4 — the Cloud-generated exact actor set of a V3
   * replicated row (parsed `replicaActorIdsJson`). NULL = pre-V3 /
   * local-authored row → normal visibility rules. Non-null = replicated:
   * the cap `sub` must be a member BEFORE any visibility/principal rule
   * applies (empty array = deny all; the exact set can never be widened
   * from local role/task claims or the cap principal).
   */
  replicaActorIds?: readonly string[] | null;
}

/**
 * A memory READER's identity, abstracted from HOW it was authenticated. Both the
 * signed-cap RPC path (canCapReadPage) and the daemon-internal hook recall path
 * (which has no cap — it has the trusted dispatch ctx) project onto this so the
 * per-visibility scope matrix lives in ONE place (canReaderReadVisibility) and
 * cannot drift between paths (product204/34 Track 0.1 / 0.1b).
 */
export interface MemoryReader {
  /** Subject im-user id — owns its `agent:`/`private:` pages. */
  imUserId: string;
  /** The reader's OWN role slug(s) — gates `role:<slug>`. */
  roleSlugs?: string[];
  /** Workspace orchestrator — may read any `role:<slug>`. */
  isOrchestrator?: boolean;
  /** Council conversation id(s) the reader is a member of — gates `council:<id>`. */
  councilIds?: string[];
  /**
   * product209/16 §8.3 — cap v2 claims. Task ids the actor is assigned to
   * (server-derived, epoch-bound) — gates `task:<id>`. v1 caps carry no task
   * claim → `task:` reads FAIL CLOSED (today's behavior).
   */
  taskIds?: string[];
  /**
   * §8.3 — effective principal of the actor (server-derived from the
   * snapshot). A `human` principal grants the actor its bound member's
   * `human:*` pages (modeled as `private:<principalId>`). The principal is
   * NEVER used as the cap `sub` and never widens access to other
   * agents/members (strict id equality).
   */
  principalKind?: 'human' | 'workspace';
  principalId?: string;
  /** Daemon-internal system reader — sees everything (it IS the daemon). */
  isSystem?: boolean;
}

/**
 * The single per-visibility scope matrix (product204/34 Track 0.1). True when
 * `reader` may read a page of the given `visibility`:
 *   - workspace        → any in-workspace reader
 *   - agent / private  → only the owning subject (visibility.imUserId)
 *   - role:<slug>      → the reader owns that role, or is orchestrator
 *   - council:<id>     → the reader is a member (councilIds ∋ id); else DENY
 * role/council FAIL CLOSED: no matching membership → false, NEVER fail-open.
 * The workspace gate (cross-workspace) is applied by the callers that hold a
 * workspace-scoped identity (canCapReadPage); the hook path is already resolved
 * to a single workspace's store, so it calls this directly.
 */
export function canReaderReadVisibility(reader: MemoryReader, visibility: MemoryVisibility): boolean {
  if (reader.isSystem) return true;
  switch (visibility.kind) {
    case 'workspace':
      return true;
    case 'agent':
      return visibility.imUserId === reader.imUserId;
    case 'private':
      // §8.3 actor/principal 双认：a human-principal cap reads its BOUND
      // principal's pages (`human:*` down-synced as `private:<member>`), never
      // other agents/members (strict id equality on the principal claim). The
      // principal is never the cap `sub` — the actor's own pages still gate on
      // imUserId.
      return (
        visibility.imUserId === reader.imUserId ||
        (reader.principalKind === 'human' && visibility.imUserId === reader.principalId)
      );
    case 'role':
      return reader.isOrchestrator === true || (reader.roleSlugs?.includes(visibility.slug) ?? false);
    case 'council':
      return reader.councilIds?.includes(visibility.id) ?? false;
    case 'task':
      // §8.3 — v2 caps carry the server-derived task claim; v1 caps carry none
      // → fail closed (system sync still bypasses via isSystem).
      return reader.taskIds?.includes(visibility.id) ?? false;
    default: {
      const _exhaustive: never = visibility;
      return false;
    }
  }
}

/** Project a verified cap onto the reader abstraction. Exported so non-cap
 *  read surfaces (e.g. the place-context helper) can reuse the ONE scope matrix
 *  with a cap-derived reader instead of re-deriving membership. */
export function capToReader(cap: MemoryCap): MemoryReader {
  if (isSystemCap(cap)) return { imUserId: cap.sub, isSystem: true };
  return {
    imUserId: cap.sub,
    roleSlugs: cap.roleSlugs,
    isOrchestrator: cap.isOrchestrator,
    councilIds: cap.councilIds,
    // §8.3 — v2 snapshot-derived claims (absent on v1 → fail closed at the
    // predicate for task:/human-principal scopes).
    taskIds: cap.taskIds,
    principalKind: cap.principalKind,
    principalId: cap.principalId,
  };
}

/**
 * Boundary projection of the shared memory ACL predicate. True when `cap` may
 * read `page`:
 *   1. the cap authorizes the page's workspace (cross-workspace → false), AND
 *   2. §8.3 — for a V3 REPLICATED row (replicaActorIds != null), the cap
 *      `sub` must be a member of the Cloud-generated exact actor set —
 *      checked BEFORE any visibility/principal rule. Empty set = deny all;
 *      the set can never be widened from local role/task claims or the cap
 *      principal. The daemon-internal system cap bypasses (maintenance
 *      channel only; agent RPC never carries it), AND
 *   3. the per-visibility scope matrix (canReaderReadVisibility) allows it.
 *
 * Full governance (delegated agents, orchestrator, task:* prefixes, secret-ref)
 * is the cloud superset's job and is intentionally NOT decided here.
 */
export function canCapReadPage(cap: MemoryCap, page: BoundaryPage): boolean {
  if (!capAllowsWorkspace(cap, page.workspaceId)) return false;
  const reader = capToReader(cap);
  // §8.3 exact-actor-set pre-check (before visibility/principal rules).
  const actorSet = page.replicaActorIds;
  if (actorSet !== undefined && actorSet !== null) {
    if (reader.isSystem) return true; // system maintenance channel bypass
    if (!Array.isArray(actorSet) || actorSet.length === 0) return false; // empty → deny all
    if (!actorSet.includes(reader.imUserId)) return false;
  }
  return canReaderReadVisibility(reader, page.visibility);
}

/**
 * The asset-ACL attributes the daemon's OWN projection of an `im_assets` row can
 * carry. `im_assets` keeps the full cloud Asset ACL (`visibility` vocabulary,
 * `ownerImUserId`, `aclJson` grants); the daemon mirrors only the two fields its
 * boundary subset can judge (see daemon/asset/metadata-index.ts, which mirrors
 * the cloud `/assets/index` DTO). Both absent/null on a row that was mirrored
 * before the fields existed or by an older cloud ⇒ unverifiable.
 */
export interface AssetAclProjection {
  visibility?: string | null;
  ownerImUserId?: string | null;
}

/**
 * Boundary predicate for an ASSET-derived hit (memory211 fix round, external
 * review P1): a T3 raw/asset chunk hit carries the upload's own text, so it must
 * respect the same cap boundary a page hit does. Before this predicate the RPC
 * search post-filter resolved chunk hits with `loadById(pageId)` — an asset id
 * never has a `memory_pages` row, so every chunk hit kept the "no page row" pass
 * and the lane was fail-OPEN (the hook recall path, by contrast, drops a hit
 * whose page row is missing = fail-CLOSED): a scoped sub-agent cap on a shared
 * daemon could read any materialized asset's raw text.
 *
 * Judged strictly on what the daemon HOLDS (boundary subset — never a
 * re-implementation of the cloud superset):
 *   - system cap   → allow (it IS the daemon; same bypass as canCapReadPage).
 *   - no verdict   → DENY (fail-closed: offline + never-synced asset, pre-existing
 *                    mirror row, or an older cloud that shipped no ACL fields).
 *   - 'workspace'  → allow (any in-workspace reader, mirroring the cloud's
 *                    first clause of the asset read predicate).
 *   - own asset    → allow (`ownerImUserId === cap.sub`).
 *   - anything else → DENY. `user` / `task:<id>` / `quarantined` / aclJson
 *     grants stay cloud-side on purpose: denying is always safe, granting is
 *     not, and the cloud search leg carries the full Asset ACL when online.
 *
 * Like every local verdict this is eventually-consistent with the cloud (the
 * projection refreshes from `/assets/index`, the same channel that feeds
 * `#filename` resolution); a staleness window is inherent to the local-first
 * boundary and is the same trade the down-synced page visibility already makes.
 */
export function canCapReadAsset(cap: MemoryCap, asset: AssetAclProjection | null | undefined): boolean {
  if (isSystemCap(cap)) return true;
  if (!asset) return false;
  if (asset.visibility === 'workspace') return true;
  return !!asset.ownerImUserId && asset.ownerImUserId === cap.sub;
}
