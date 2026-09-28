// Publish-governance CLI shared layer — product204/21 (M-P W3).
//
// The W1 backend exposes ONE isomorphic wire shape across the three publishable
// assets (skill / role template / workspace blueprint):
//
//   POST <asset>/:id/delist | /unpublish        { reason? }
//   POST <asset>/:id/deprecate                  { reason, successorSlug? }
//   POST <asset>/:id/undeprecate                {}
//   POST <asset>/:id/transfer/{offer,accept,abort}
//   GET  <asset>/mine/published                 -> PublishedAssetRow[]
//   (relist = re-run the asset's OWN publish endpoint; archive = the asset's
//    own retire endpoint + `confirm`)
//
// This module is the ZERO-DEPENDENCY half of the CLI surface: the error-code ->
// human-sentence table and the `mine/published` row formatting. Both CLIs import
// it — `prismer skill|role` (daemon CLI, this package) and `cloud skill|role`
// (agent CLI, sdk/cloud, via a build-time relative import,
// the same trick commands/skill.ts already uses for ../bundle/index).
//
// Keep it PURE (no imports, no I/O, no process access) so either tsup bundle can
// inline it without dragging daemon dependencies into the agent CLI.

/** The badge the management surface renders — mirrors PublishedAssetRow.listingState (21 §2.7). */
export type ListingState = 'listed' | 'delisted' | 'deprecated' | 'taken_down' | 'archived';

/** One row of `GET <asset>/mine/published` — the §2.7 management contract. */
export interface PublishedAssetRow {
  kind: 'skill' | 'role_template' | 'blueprint';
  id: string;
  slug: string;
  name: string;
  status: string;
  listingState: ListingState;
  /** Live consumers: agents with the skill installed / agents built from the role / workspaces built from the blueprint. */
  consumers: number;
  installs: number;
  forkCount: number;
  publishedAt: string | null;
  updatedAt: string | null;
  deprecation?: { reason?: string; successorSlug?: string | null } | null;
  takedown?: { reason?: string; freezeDelivery?: boolean } | null;
  transferOffer?: { toImUserId?: string } | null;
}

/** A non-2xx IM envelope, normalized. `code` is the top-level IM error code. */
export interface LifecycleFailure {
  status?: number;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface LifecycleErrorContext {
  /** Noun used in prose, e.g. `skill` / `role`. */
  noun: string;
  /** What a live consumer of this asset IS, e.g. `agent` (skill/role) / `workspace` (blueprint). */
  consumerNoun: string;
  /** Command prefix used in remediation hints, e.g. `cloud skill` / `prismer role`. */
  cli: string;
  /** The asset the caller named. */
  slug: string;
  /** The verb that failed, e.g. `delist` / `archive`. */
  op: string;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Error code -> one plain sentence that names the cause AND the way out.
 *
 * The rule: never surface a bare code. Every branch below either tells the
 * caller what to re-run or why the door is closed — the CLI is the only surface
 * an agent has, so an unexplained 409 is a dead end for it.
 */
export function humanizeLifecycleError(f: LifecycleFailure, ctx: LifecycleErrorContext): string {
  const { noun, consumerNoun, cli, slug, op } = ctx;
  const server = text(f.message);

  switch (f.code) {
    // ── ownership ──────────────────────────────────────────────────────────
    case 'not_owner':
      return `You are not the owner of this ${noun} (${slug}) — only its owner, or an admin, can ${op} it.`;

    // ── archive consumer door (21 §2.4, 裁决 4) ────────────────────────────
    case 'has_active_consumers': {
      const n = num(f.data?.consumers);
      const who = n === 1 ? `1 ${consumerNoun} is` : `${n ?? 'Some'} ${consumerNoun}s are`;
      return (
        `${who} still using this ${noun} — archiving unbinds ${n === 1 ? 'it' : 'them'}. ` +
        `Re-run with --confirm to archive anyway: ${cli} archive ${slug} --confirm`
      );
    }

    // ── admin takedown lock (21 §2.6) ──────────────────────────────────────
    case 'taken_down': {
      const reason = text((f.data?.takedown as { reason?: unknown } | undefined)?.reason);
      return (
        `This ${noun} was taken down by an administrator and cannot be re-listed` +
        `${reason ? ` — reason: ${reason}` : ''}. An admin must reinstate it first.`
      );
    }

    // ── live-reference guard (21 §2.8 — the load-bearing one) ──────────────
    case 'changelog_required':
      return (
        `A ${noun} is a LIVE reference, not a snapshot: editing its content propagates to every ` +
        `consumer already using it. Re-run with --changelog "<what changed>" to record why.`
      );

    // ── deprecate ─────────────────────────────────────────────────────────
    case 'reason_required':
      return `deprecate needs a reason others can act on: ${cli} deprecate ${slug} --reason "<why>"`;
    case 'successor_not_listed': {
      const successor = text(f.data?.successorSlug);
      return (
        `The successor${successor ? ` '${successor}'` : ''} must itself be a listed (published) ${noun} — ` +
        `publish it first, or drop --successor.`
      );
    }
    case 'invalid_successor':
      return `A ${noun} cannot be its own successor — point --successor at a different ${noun}.`;

    // ── transfer (two-phase, 21 §2.5 / 裁决 5) ─────────────────────────────
    case 'transfer_pending': {
      const to = text((f.data?.transferOffer as { toImUserId?: unknown } | undefined)?.toImUserId);
      return (
        `A transfer offer${to ? ` to ${to}` : ''} is already pending on this ${noun} — ` +
        `abort it first: ${cli} transfer-abort ${slug}`
      );
    }
    case 'not_transfer_target':
      return `Only the person the offer was made to can accept this transfer — you are not the recipient.`;
    case 'not_transfer_party':
      return `Only the current owner or the offer recipient can abort this transfer.`;
    case 'no_pending_transfer':
      return `No transfer offer is pending on this ${noun} — start one: ${cli} transfer ${slug} --to <imUserId>`;
    case 'to_im_user_id_required':
      return `transfer needs a recipient: ${cli} transfer ${slug} --to <imUserId>`;
    case 'invalid_target':
      return `That user already owns this ${noun} — nothing to transfer.`;
    case 'target_not_found':
      return `The transfer recipient is not a known user — pass the recipient's IM user id (not an email or a username).`;

    // ── role: the public dead-end, now with an exit (21 §2.4) ──────────────
    case 'must_delist_first':
      return (
        `A listed (public) ${noun} cannot be archived directly — delist it first, then archive: ` +
        `${cli} delist ${slug} && ${cli} archive ${slug}`
      );

    // ── generic ───────────────────────────────────────────────────────────
    case 'not_found':
      return `No ${noun} named '${slug}' — check the slug with: ${cli} published`;
    case 'admin_required':
      return `That action is admin-only.`;
    default:
      return server ?? `${op} failed${f.status ? ` (HTTP ${f.status})` : ''}.`;
  }
}

/** Compact one-line badge for a `mine/published` row — state plus the reason it is in that state. */
export function describeListingState(row: PublishedAssetRow): string {
  switch (row.listingState) {
    case 'deprecated': {
      const successor = text(row.deprecation?.successorSlug);
      return successor ? `deprecated -> ${successor}` : 'deprecated';
    }
    case 'taken_down':
      return 'taken_down (admin)';
    default:
      return row.listingState;
  }
}

/** `mine/published` -> table rows. Consumers is the blast radius of an archive, so it is always shown. */
export function publishedTableRows(rows: PublishedAssetRow[]): Array<Record<string, string>> {
  return rows.map((r) => ({
    slug: r.slug || '-',
    state: describeListingState(r),
    consumers: String(r.consumers ?? 0),
    installs: String(r.installs ?? 0),
    transfer: r.transferOffer?.toImUserId ? `pending -> ${r.transferOffer.toImUserId}` : '-',
  }));
}
