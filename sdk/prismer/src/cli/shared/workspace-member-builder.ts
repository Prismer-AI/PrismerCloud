// release203/15b WS-E4 §7.3 "B" — shared `workspace member` command-builder.
//
// `workspace member (list|add|update|remove)` exists in BOTH CLIs — `prismer`
// (bin, @prismer/runtime, CloudClient + api_key + ui.table output) and `cloud`
// (bin, @prismer/sdk, PrismerClient.workspaces.members + im_token + padded-text
// output). Both hit the SAME endpoints (GET/POST/PATCH/DELETE
// /api/im/workspaces/:id/members), enforce the SAME role contract (admin|member;
// `owner` rejected — ownership transfer is a v2.1+ RFC, release201/16 §5.2), and
// the SAME remove cascade (removing a member also drops their project
// memberships in the workspace). That validation/flow logic was duplicated
// verbatim, so a change to the role contract or the remove cascade had to land
// twice — the exact drift WS-E4 fights.
//
// This module is the single source of that logic. It is **transport- and
// output-agnostic**: it knows nothing about CloudClient / PrismerClient,
// table-vs-text output, or which auth a binary uses. Each binary injects a
// `WorkspaceMemberAdapter` that bridges to its own client + output convention,
// so the role validation + verb wiring live here once.
//
// Why a self-contained module (not a cross-package import edge): @prismer/sdk
// and @prismer/runtime are independently packed/published with no dependency
// edge between them (see the cli-ui.ts mirror note + 15b §2). This file
// therefore imports nothing but `commander`; each binary references it through
// its own bundler (tsup inlines it), keeping both tarballs standalone. See the
// `task-wait-builder.ts` PoC and docs/release203/15b-shared-builder-plan.md.

import { Command } from 'commander';

/** A workspace member row, as both CLIs surface it. */
export interface MemberRecord {
  id: string;
  role: string;
  memberImUserId: string;
  joinedAt: string;
}

/** Result of a member remove — the removed row + cascade count. */
export interface MemberRemoveRecord {
  removed: MemberRecord;
  projectMembershipsRemoved: number;
}

/**
 * The seam each binary fills. Keeps the builder ignorant of transport (which
 * HTTP client), output (table vs padded text), and auth (api_key vs im_token).
 * Each method returns the record on success or throws / calls `fail` to abort
 * in the binary's own convention.
 */
export interface WorkspaceMemberAdapter {
  list(workspaceId: string): Promise<MemberRecord[]>;
  add(workspaceId: string, memberImUserId: string, role: 'admin' | 'member'): Promise<MemberRecord>;
  update(workspaceId: string, memberId: string, role: 'admin' | 'member'): Promise<MemberRecord>;
  remove(workspaceId: string, memberId: string): Promise<MemberRemoveRecord>;
  /** Render a list of members in the binary's convention. */
  emitList(items: MemberRecord[], opts: { json: boolean }): void;
  /** Render a single member (after add/update) in the binary's convention. */
  emitMember(member: MemberRecord, opts: { json: boolean }, verb: 'add' | 'update'): void;
  /** Render a remove result in the binary's convention. */
  emitRemove(result: MemberRemoveRecord, opts: { json: boolean }): void;
  /** Print an error in the binary's convention and exit non-zero. */
  fail(msg: string): never;
}

/**
 * Shared role contract: only `admin` and `member` are settable via CLI. `owner`
 * is rejected because ownership transfer is a v2.1+ RFC (release201/16 §5.2);
 * surfacing it early gives a clearer error than the service 4xx. Lives here once
 * so both binaries reject `--role owner` identically.
 */
function parseAdminMemberRole(raw: string | undefined, fail: (msg: string) => never): 'admin' | 'member' {
  if (raw === 'admin' || raw === 'member') return raw;
  if (raw === undefined) return 'member';
  if (raw === 'owner') {
    fail('--role=owner is not allowed via CLI; use ownership transfer (v2.1+ RFC, release201/16 §5.2)');
  }
  fail('--role must be admin|member');
}

/**
 * Build the `member` sub-namespace (`list|add|update|remove`) as a configured
 * commander `Command` the binary attaches under its own `workspace` parent.
 * Behaviour is identical across binaries; only the injected adapter differs.
 *
 * Flags are the SUPERSET that both CLIs accepted: `add` takes the member id as a
 * positional (prismer) OR `--user` (cloud); both forms are wired so neither
 * binary's existing UX changes. `--json` toggles JSON output.
 */
export function buildWorkspaceMemberCommand(adapter: WorkspaceMemberAdapter): Command {
  const member = new Command('member').description('Manage workspace members (release201/16 Phase 8)');

  // A bare commander `.action` that throws would surface commander's default
  // "<bin>: <error>" handler with a platform-dependent exit code. Route every
  // adapter throw through `adapter.fail` so both binaries keep their own
  // friendly error + non-zero exit (the prismer adapter's `cloud.get`/`request`
  // throw on non-ok; the cloud adapter never throws — it calls `fail` itself).
  const guard = (fn: () => Promise<void>): Promise<void> =>
    fn().catch((err) => adapter.fail(err instanceof Error ? err.message : String(err)));

  member
    .command('list <workspaceId>')
    .description('List workspace members')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, opts: { json?: boolean }) =>
      guard(async () => {
        const items = await adapter.list(workspaceId);
        adapter.emitList(items, { json: opts.json === true });
      }),
    );

  member
    .command('add <workspaceId> [imUserId]')
    .description('Add a workspace member (owner only; human invite flow is `cloud workspace invite create`)')
    .option('--user <imUserId>', 'IM user id of the new member (alias for the positional arg)')
    .option('--role <role>', 'admin | member', 'member')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, imUserIdArg: string | undefined, opts: { user?: string; role?: string; json?: boolean }) =>
      guard(async () => {
        const memberImUserId = (imUserIdArg ?? opts.user ?? '').trim();
        if (!memberImUserId) {
          adapter.fail('member im user id required (pass it as the second argument or via --user)');
        }
        const role = parseAdminMemberRole(opts.role, adapter.fail);
        const m = await adapter.add(workspaceId, memberImUserId, role);
        adapter.emitMember(m, { json: opts.json === true }, 'add');
      }),
    );

  member
    .command('update <workspaceId> <memberId>')
    .description('Change a member role (owner-only; owner role itself is immutable here)')
    .requiredOption('--role <role>', 'admin | member')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, memberId: string, opts: { role: string; json?: boolean }) =>
      guard(async () => {
        const role = parseAdminMemberRole(opts.role, adapter.fail);
        const m = await adapter.update(workspaceId, memberId, role);
        adapter.emitMember(m, { json: opts.json === true }, 'update');
      }),
    );

  member
    .command('remove <workspaceId> <memberId>')
    .description('Remove a member (owner-only; cascades project memberships in the same workspace)')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, memberId: string, opts: { json?: boolean }) =>
      guard(async () => {
        const result = await adapter.remove(workspaceId, memberId);
        adapter.emitRemove(result, { json: opts.json === true });
      }),
    );

  return member;
}
