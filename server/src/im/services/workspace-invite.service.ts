/**
 * WorkspaceInviteService — release201/16 Phase 9 (v2.0.8).
 *
 * Token-based invite flow that bridges "I want to add someone" with
 * "this person clicked accept". See 16 doc §3.2.1 / §3.3.2 / §0.2.3.
 *
 * Two flows in one schema:
 *   1. Link invite: inviteeEmail set, inviteeImUserId null → emailed link.
 *      Anyone logged-in can accept; the trade-off is documented in 16 §5.4.
 *   2. Direct request: inviteeImUserId set → in-app notification; only that
 *      imUser can accept.
 *
 * Endpoint surface (16 §3.3.2):
 *   POST   /workspaces/:id/invites            — owner/admin create
 *   GET    /workspaces/:id/invites            — owner/admin list
 *   DELETE /workspaces/:id/invites/:inviteId  — owner/admin revoke
 *   GET    /invites/:token                    — public preview (no auth)
 *   POST   /invites/:token/accept             — logged-in user
 *   POST   /invites/:token/reject             — logged-in user
 *
 * Invariants (16 §0.2.3):
 *   - token is 32-byte base64url (no padding), single-use, unguessable
 *   - status state machine: pending → accepted|rejected|revoked|expired (terminal)
 *   - accept writes member row AND flips invite status in the same transaction
 *   - duplicate pending invites for (workspace, email-or-imuser) → 409
 *   - IMBlock between inviter ↔ invitee at create-time → 422 PRINCIPAL_BLOCKED
 *   - expiresAt past + status='pending' → lazy-flipped to 'expired' on read
 *
 * Not in v2.0.8 (16 §5.2):
 *   - role='owner' (ownership transfer is v2.1+ RFC)
 *   - email send (queue integration deferred; service just creates the row +
 *     returns the token URL for the API layer to enqueue)
 *   - background sweeper for expired tokens (lazy-expire on accept/preview)
 */

import { randomBytes } from 'crypto';
import prisma from '../db';
import { ContactService } from './contact.service';

const DEFAULT_TTL_DAYS = 7;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 30;

export type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
export type InviteRole = 'admin' | 'member';

export interface WorkspaceInviteDTO {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: InviteRole;
  status: InviteStatus;
  expiresAt: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Public preview — only safe-to-leak fields. 16 §0.2.4 forbids exposing
// member counts, asset counts, or any workspace aggregate here.
export interface InvitePreviewDTO {
  workspaceName: string;
  inviterDisplayName: string;
  inviterAvatar: string | null;
  role: InviteRole;
  status: InviteStatus;
  expiresAt: string;
  // The address this invite was emailed to. Safe to expose to a token holder:
  // the unguessable token was delivered to this mailbox, so possessing it is
  // proof of access. Used by the landing/auth surfaces to prefill + bind the
  // new account's email (P0.1). Null for direct (imUser-bound) invites.
  inviteeEmail: string | null;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class InviteValidationError extends Error {
  code = 'INVITE_VALIDATION';
  status = 400 as const;
  constructor(reason: string) {
    super(reason);
  }
}
export class InviteForbiddenError extends Error {
  code = 'INVITE_FORBIDDEN';
  status = 403 as const;
  constructor(reason: string) {
    super(reason);
  }
}
export class InviteNotFoundError extends Error {
  code = 'INVITE_NOT_FOUND';
  status = 404 as const;
  constructor() {
    super('Invite not found');
  }
}
export class InviteExpiredError extends Error {
  code = 'INVITE_EXPIRED';
  status = 410 as const;
  constructor() {
    super('Invite has expired');
  }
}
export class InviteAlreadyUsedError extends Error {
  code = 'INVITE_ALREADY_USED';
  status = 410 as const;
  constructor(public terminalStatus: InviteStatus) {
    super(`Invite is no longer pending (status=${terminalStatus})`);
  }
}
export class InviteRevokedError extends Error {
  code = 'INVITE_REVOKED';
  status = 410 as const;
  constructor() {
    super('Invite was revoked');
  }
}
// release201/19 D2 — 16 §3.4 expects 410 for terminal-state previews so the
// landing page never renders "rejected/accepted" as if the invite were still
// actionable. Mirrors the revoke/expired posture above.
export class InviteRejectedError extends Error {
  code = 'INVITE_REJECTED';
  status = 410 as const;
  constructor() {
    super('Invite was rejected');
  }
}
export class InviteAcceptedError extends Error {
  code = 'INVITE_ACCEPTED';
  status = 410 as const;
  constructor() {
    super('Invite was already accepted');
  }
}
export class DuplicatePendingInviteError extends Error {
  code = 'DUPLICATE_PENDING_INVITE';
  status = 409 as const;
  constructor() {
    super('A pending invite already exists for this invitee in this workspace');
  }
}
export class PrincipalBlockedError extends Error {
  code = 'PRINCIPAL_BLOCKED';
  status = 422 as const;
  constructor() {
    super('Block relationship prevents this invite');
  }
}
export class WorkspaceNotFoundError extends Error {
  code = 'WORKSPACE_NOT_FOUND';
  status = 404 as const;
  constructor(id: string) {
    super(`Workspace ${id} not found`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateToken(): string {
  // 32 bytes base64url ≈ 43 chars, ~256 bits of entropy. The column is
  // VARCHAR(128) so length is not load-bearing — leave room for future
  // versioning prefixes (e.g. `wi1_<base64url>`) without a migration.
  return randomBytes(32).toString('base64url');
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidRole(role: unknown): role is InviteRole {
  return role === 'admin' || role === 'member';
}

function isValidStatus(status: unknown): status is InviteStatus {
  return (
    status === 'pending' ||
    status === 'accepted' ||
    status === 'rejected' ||
    status === 'revoked' ||
    status === 'expired'
  );
}

function toDTO(row: {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: string;
  status: string;
  expiresAt: Date;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceInviteDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    inviterUserId: row.inviterUserId,
    token: row.token,
    inviteeEmail: row.inviteeEmail,
    inviteeImUserId: row.inviteeImUserId,
    role: isValidRole(row.role) ? row.role : 'member',
    status: isValidStatus(row.status) ? row.status : 'pending',
    expiresAt: row.expiresAt.toISOString(),
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

export class WorkspaceInviteService {
  constructor(private contacts: ContactService = new ContactService()) {}

  /**
   * Owner / admin creates an invite. 16 §3.3.2.
   */
  async create(
    workspaceId: string,
    actorImUserId: string,
    params: {
      inviteeEmail?: string;
      inviteeImUserId?: string;
      role?: InviteRole;
      expiresInDays?: number;
    },
  ): Promise<WorkspaceInviteDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    // owner OR admin
    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new InviteForbiddenError('Only workspace owner/admin can create invites');
    }

    const email = params.inviteeEmail?.trim() || null;
    const imUserId = params.inviteeImUserId?.trim() || null;
    if (!email && !imUserId) {
      throw new InviteValidationError('Either inviteeEmail or inviteeImUserId is required');
    }
    if (email && !isValidEmail(email)) {
      throw new InviteValidationError('inviteeEmail is not a valid email address');
    }

    const role: InviteRole = params.role ?? 'member';
    if (!isValidRole(role)) {
      throw new InviteValidationError('role must be admin or member (owner is v2.1+)');
    }

    const ttlDays = params.expiresInDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isInteger(ttlDays) || ttlDays < MIN_TTL_DAYS || ttlDays > MAX_TTL_DAYS) {
      throw new InviteValidationError(`expiresInDays must be an integer in [${MIN_TTL_DAYS}, ${MAX_TTL_DAYS}]`);
    }

    // IMBlock guard (16 §0.2.3): if either side has blocked the other, abort.
    // Only meaningful when we have an imUserId to compare against; pure-email
    // invites bypass this check because we don't yet know who will accept.
    if (imUserId) {
      const inviterBlockedInvitee = await this.contacts.isBlocked(actorImUserId, imUserId);
      const inviteeBlockedInviter = await this.contacts.isBlocked(imUserId, actorImUserId);
      if (inviterBlockedInvitee || inviteeBlockedInviter) {
        throw new PrincipalBlockedError();
      }

      // Already a member? Don't bother with an invite.
      const already = await prisma.iMWorkspaceMember.findUnique({
        where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: imUserId } },
        select: { id: true },
      });
      if (already) {
        throw new InviteValidationError('User is already a member of this workspace');
      }
    }

    // Business-unique: at most one pending invite per (workspace, invitee identity).
    if (imUserId) {
      const dup = await prisma.iMWorkspaceInvite.findFirst({
        where: { workspaceId, inviteeImUserId: imUserId, status: 'pending' },
        select: { id: true },
      });
      if (dup) throw new DuplicatePendingInviteError();
    }
    if (email) {
      const dup = await prisma.iMWorkspaceInvite.findFirst({
        where: { workspaceId, inviteeEmail: email, status: 'pending' },
        select: { id: true },
      });
      if (dup) throw new DuplicatePendingInviteError();
    }

    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    // Token UNIQUE collision is astronomically unlikely (256 bits) — single
    // attempt is fine; if it ever fires, the caller can retry.
    const token = generateToken();

    const created = await prisma.iMWorkspaceInvite.create({
      data: {
        workspaceId,
        inviterUserId: actorImUserId,
        token,
        inviteeEmail: email,
        inviteeImUserId: imUserId,
        role,
        status: 'pending',
        expiresAt,
      },
    });
    return toDTO(created);
  }

  /**
   * List invites for a workspace — owner/admin only. Returns all statuses;
   * the UI can filter. Tokens are returned to admins (they can resend the
   * link) but the public preview never exposes the workspace owner identity
   * beyond the inviter avatar.
   */
  async list(workspaceId: string, actorImUserId: string): Promise<WorkspaceInviteDTO[]> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      // 404 to avoid telling outsiders the workspace exists (anti-enumeration).
      throw new WorkspaceNotFoundError(workspaceId);
    }

    const rows = await prisma.iMWorkspaceInvite.findMany({
      where: { workspaceId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDTO);
  }

  /**
   * Revoke (only pending invites can be revoked; terminal states stay).
   */
  async revoke(workspaceId: string, actorImUserId: string, inviteId: string): Promise<WorkspaceInviteDTO> {
    const ws = await prisma.iMWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { ownerImUserId: true },
    });
    if (!ws) throw new WorkspaceNotFoundError(workspaceId);

    const actorMember = await prisma.iMWorkspaceMember.findUnique({
      where: { workspaceId_memberImUserId: { workspaceId, memberImUserId: actorImUserId } },
      select: { role: true },
    });
    const isOwner = ws.ownerImUserId === actorImUserId;
    const isAdmin = actorMember?.role === 'admin';
    if (!isOwner && !isAdmin) {
      throw new InviteForbiddenError('Only workspace owner/admin can revoke invites');
    }

    const existing = await prisma.iMWorkspaceInvite.findUnique({ where: { id: inviteId } });
    if (!existing || existing.workspaceId !== workspaceId) throw new InviteNotFoundError();
    if (existing.status !== 'pending') {
      throw new InviteAlreadyUsedError(existing.status as InviteStatus);
    }

    const updated = await prisma.iMWorkspaceInvite.update({
      where: { id: inviteId },
      data: { status: 'revoked' },
    });
    return toDTO(updated);
  }

  /**
   * Public preview — no auth required. 16 §3.3.2.
   * Returns only the four declared fields plus status+expiresAt; never leaks
   * workspace size, member identities, or asset counts.
   *
   * Lazy-expires the row if pending & past expiresAt — keeps surface tidy
   * without a background sweeper.
   *
   * release201/19 D2 — 16 §3.4 terminal-state guard: revoked/rejected/expired/
   * accepted previews return 410 with the matching error code instead of
   * 200 + status, so landing pages can't surface "click to accept" on a
   * dead link.
   */
  async preview(token: string): Promise<InvitePreviewDTO> {
    const row = await prisma.iMWorkspaceInvite.findUnique({ where: { token } });
    if (!row) throw new InviteNotFoundError();

    const status = await this.maybeLazyExpire(row);

    if (status === 'revoked') throw new InviteRevokedError();
    if (status === 'expired') throw new InviteExpiredError();
    if (status === 'rejected') throw new InviteRejectedError();
    if (status === 'accepted') throw new InviteAcceptedError();

    const [ws, inviter] = await Promise.all([
      prisma.iMWorkspace.findUnique({
        where: { id: row.workspaceId },
        select: { name: true },
      }),
      prisma.iMUser.findUnique({
        where: { id: row.inviterUserId },
        select: { displayName: true, username: true, avatarUrl: true },
      }),
    ]);
    if (!ws || !inviter) throw new InviteNotFoundError();

    return {
      workspaceName: ws.name,
      inviterDisplayName: inviter.displayName ?? inviter.username,
      inviterAvatar: inviter.avatarUrl ?? null,
      role: isValidRole(row.role) ? row.role : 'member',
      status,
      expiresAt: row.expiresAt.toISOString(),
      inviteeEmail: row.inviteeEmail,
    };
  }

  /**
   * Accept — writes the workspace member row AND flips status atomically.
   * 16 §0.2.3: three writes (invite status, acceptedByUserId, member row)
   * must share one transaction; failure rolls back all of them.
   *
   * Concurrency-safe (release201 v2.0.7.1 hotfix B3): the entire flow runs
   * inside `prisma.$transaction` and the status flip uses `updateMany` with
   * `where: { id, status: 'pending' }` — the DB enforces single-use by
   * row-locking the invite row in the UPDATE. If two callers race, only the
   * first txn matches the WHERE; the second sees count===0 and throws
   * INVITE_ALREADY_USED (410). Without this guard both txns could observe
   * `pending` on the pre-transaction read, both flip to accepted, and both
   * insert a member row (the in-tx findUnique race-loses on the member
   * uniqueness check).
   */
  async accept(token: string, actorImUserId: string): Promise<WorkspaceInviteDTO> {
    // Pre-flight contact-block check (uses non-tx prisma — fine, it's read-only
    // and the result is stable for the duration of the txn). Done outside the
    // transaction to keep the txn body tight: we only want DB writes inside
    // the row-lock window.
    //
    // We still need to read the invite once outside the txn to know which
    // inviter to feed to isBlocked() — but the *authoritative* status check
    // happens inside the txn via the `updateMany WHERE status='pending'` guard.
    const preview = await prisma.iMWorkspaceInvite.findUnique({
      where: { token },
      select: {
        id: true,
        workspaceId: true,
        inviterUserId: true,
        inviteeEmail: true,
        inviteeImUserId: true,
        role: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!preview) throw new InviteNotFoundError();

    // Fast-fail on obviously-terminal states so callers get the right code.
    // The txn body's updateMany() is the final authority — these checks are
    // ergonomic shortcuts, not the race-safe gate.
    if (preview.status === 'revoked') throw new InviteRevokedError();
    if (preview.status === 'expired') throw new InviteExpiredError();
    if (preview.status !== 'pending') {
      throw new InviteAlreadyUsedError(preview.status as InviteStatus);
    }
    if (preview.expiresAt.getTime() <= Date.now()) {
      // Lazy-flip so the UI's message matches state. Best-effort; failure
      // here doesn't change the outcome (we still throw expired below).
      await prisma.iMWorkspaceInvite.update({ where: { id: preview.id }, data: { status: 'expired' } }).catch(() => {});
      throw new InviteExpiredError();
    }
    if (preview.inviteeImUserId && preview.inviteeImUserId !== actorImUserId) {
      throw new InviteForbiddenError('This invite is addressed to another user');
    }

    // Email-bound invite (P0.2): link-mode invites carry inviteeEmail but no
    // inviteeImUserId. Require the accepting actor's account email to match
    // (case-insensitive) so "who joins" is deterministic — closes the
    // "anyone with the link can accept" hole (16 §5.4 trade-off retired).
    // Skip when the invite was already bound to a specific imUser (direct
    // request), which the check above already authorized.
    if (preview.inviteeEmail && !preview.inviteeImUserId) {
      const actor = await prisma.iMUser.findUnique({
        where: { id: actorImUserId },
        select: { email: true },
      });
      const actorEmail = actor?.email?.trim().toLowerCase() ?? '';
      const inviteeEmail = preview.inviteeEmail.trim().toLowerCase();
      if (!actorEmail || actorEmail !== inviteeEmail) {
        throw new InviteForbiddenError('This invite was sent to a different email address');
      }
    }

    const inviterBlockedAcceptor = await this.contacts.isBlocked(preview.inviterUserId, actorImUserId);
    const acceptorBlockedInviter = await this.contacts.isBlocked(actorImUserId, preview.inviterUserId);
    if (inviterBlockedAcceptor || acceptorBlockedInviter) {
      throw new PrincipalBlockedError();
    }

    // Already a member of this workspace? Mark invite accepted but skip
    // the duplicate insert. The pre-existing member row already satisfies
    // the intent of "this user is in the workspace". We INTENTIONALLY DO
    // NOT promote a member→admin even if the invite role is admin: role
    // upgrades are an owner-only PATCH action with audit trail; allowing
    // them through invite-accept would bypass that gate (the invite path
    // is owner/admin-creatable but accept is anyone-with-the-token, which
    // is a weaker authorization context). If the inviter genuinely wants
    // to promote, they can PATCH the member row after the accept.
    const role: InviteRole = isValidRole(preview.role) ? preview.role : 'member';

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const updated = await prisma.$transaction(async (tx: any) => {
      // CRITICAL: gate the flip on status='pending'. updateMany returns a
      // count instead of throwing P2025; count===0 means another concurrent
      // accept already won the row → surface INVITE_ALREADY_USED.
      const { count } = await tx.iMWorkspaceInvite.updateMany({
        where: { id: preview.id, status: 'pending' },
        data: {
          status: 'accepted',
          acceptedByUserId: actorImUserId,
          acceptedAt: new Date(),
        },
      });
      if (count === 0) {
        // Re-read to give the caller the terminal status; if the row vanished
        // between pre-read and now we degrade to ALREADY_USED (closest match).
        const final = await tx.iMWorkspaceInvite.findUnique({
          where: { id: preview.id },
          select: { status: true },
        });
        const terminal = (final?.status ?? 'accepted') as InviteStatus;
        if (terminal === 'revoked') throw new InviteRevokedError();
        if (terminal === 'expired') throw new InviteExpiredError();
        throw new InviteAlreadyUsedError(terminal);
      }

      const existingMember = await tx.iMWorkspaceMember.findUnique({
        where: {
          workspaceId_memberImUserId: {
            workspaceId: preview.workspaceId,
            memberImUserId: actorImUserId,
          },
        },
        select: { id: true },
      });
      if (!existingMember) {
        await tx.iMWorkspaceMember.create({
          data: {
            workspaceId: preview.workspaceId,
            memberImUserId: actorImUserId,
            role,
          },
        });
      }

      // Return the freshly-flipped row.
      return tx.iMWorkspaceInvite.findUniqueOrThrow({ where: { id: preview.id } });
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    return toDTO(updated);
  }

  /**
   * Resolve an email-link invite's bound email, SERVER-SIDE, for the
   * skip-verification register path (P0.1). Returns the invitee email ONLY
   * when the token is a valid, pending, non-expired, EMAIL-link invite
   * (inviteeEmail set, inviteeImUserId null). Returns null otherwise so the
   * caller falls back to the normal (code-required) register flow.
   *
   * SECURITY: this is the authority that lets registration skip the email
   * verification code. The returned email is the ONLY email the caller may
   * assign to the new account — never trust a client-supplied email on this
   * path. Direct (imUser-bound) invites are intentionally NOT eligible: a
   * brand-new account can't already be the bound imUser.
   */
  async resolveEmailInvite(token: string): Promise<{ inviteeEmail: string; workspaceName: string } | null> {
    if (!token || token.length < 16) return null;
    const row = await prisma.iMWorkspaceInvite.findUnique({
      where: { token },
      select: {
        id: true,
        workspaceId: true,
        inviteeEmail: true,
        inviteeImUserId: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!row) return null;
    if (row.status !== 'pending') return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (!row.inviteeEmail || row.inviteeImUserId) return null;
    const ws = await prisma.iMWorkspace.findUnique({
      where: { id: row.workspaceId },
      select: { name: true },
    });
    return { inviteeEmail: row.inviteeEmail.trim().toLowerCase(), workspaceName: ws?.name ?? '' };
  }

  /**
   * Reject — terminal status, no member row, no cascade. The link goes dead
   * for everyone (16 §5.4: link-mode invites are workspace-scoped not
   * person-scoped; once one acceptor rejects we treat the intent as resolved).
   *
   * Race-safe (B3 hotfix): same `updateMany WHERE status='pending'` guard
   * as accept(), so concurrent accept+reject can't both land — exactly one
   * caller flips the row and the other sees INVITE_ALREADY_USED.
   */
  async reject(token: string, actorImUserId: string): Promise<WorkspaceInviteDTO> {
    const row = await prisma.iMWorkspaceInvite.findUnique({ where: { token } });
    if (!row) throw new InviteNotFoundError();

    if (row.status === 'revoked') throw new InviteRevokedError();
    if (row.status === 'expired') throw new InviteExpiredError();
    if (row.status !== 'pending') throw new InviteAlreadyUsedError(row.status as InviteStatus);
    if (row.expiresAt.getTime() <= Date.now()) {
      await prisma.iMWorkspaceInvite.update({ where: { id: row.id }, data: { status: 'expired' } }).catch(() => {});
      throw new InviteExpiredError();
    }
    if (row.inviteeImUserId && row.inviteeImUserId !== actorImUserId) {
      throw new InviteForbiddenError('This invite is addressed to another user');
    }

    const { count } = await prisma.iMWorkspaceInvite.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'rejected', acceptedByUserId: actorImUserId, acceptedAt: new Date() },
    });
    if (count === 0) {
      const final = await prisma.iMWorkspaceInvite.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      const terminal = (final?.status ?? 'rejected') as InviteStatus;
      if (terminal === 'revoked') throw new InviteRevokedError();
      if (terminal === 'expired') throw new InviteExpiredError();
      throw new InviteAlreadyUsedError(terminal);
    }
    const updated = await prisma.iMWorkspaceInvite.findUniqueOrThrow({ where: { id: row.id } });
    return toDTO(updated);
  }

  // ── private ─────────────────────────────────────────────────────────────

  private async maybeLazyExpire(row: { id: string; status: string; expiresAt: Date }): Promise<InviteStatus> {
    if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
      await prisma.iMWorkspaceInvite.update({
        where: { id: row.id },
        data: { status: 'expired' },
      });
      return 'expired';
    }
    return isValidStatus(row.status) ? row.status : 'pending';
  }
}
