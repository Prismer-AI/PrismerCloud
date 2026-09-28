import { Command } from 'commander';
import type { IMWorkspaceMember } from '../index';
import { PrismerClient } from '../index';
// release203/15b WS-E4 §7.3 "B" — single source of the `workspace member`
// list/add/update/remove logic (role contract + remove cascade), shared with
// `prismer workspace member`. The two CLIs are independently published packages
// with NO npm dependency edge (see the cli-ui.ts mirror note); tsup inlines this
// module into each binary's bundle at build time, so the relative path is a
// build-time source reference, not a runtime cross-package dependency. The
// `cloud`-specific adapter (PrismerClient.workspaces.members transport + padded-
// text output) is built below in `register`. See the `task-wait-builder.ts` PoC
// and docs/release203/15b-shared-builder-plan.md.
import {
  buildWorkspaceMemberCommand,
  type WorkspaceMemberAdapter,
  type MemberRecord,
  type MemberRemoveRecord,
} from './shared/workspace-member-builder';

type ClientFactory = () => PrismerClient;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function printMemberList(items: IMWorkspaceMember[]): void {
  if (items.length === 0) {
    process.stdout.write('No members in this workspace.\n');
    return;
  }
  process.stdout.write(
    'ID'.padEnd(28) + 'ROLE'.padEnd(10) + 'IM_USER_ID'.padEnd(38) + 'JOINED\n',
  );
  for (const m of items) {
    process.stdout.write(
      `${m.id.padEnd(28)}${m.role.padEnd(10)}${m.memberImUserId.padEnd(38)}${m.joinedAt}\n`,
    );
  }
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const workspace = parent
    .command('workspace')
    .description('Workspace management — init, groups, agent assignment, and members (release201/16)');

  // ---------------------------------------------------------------------------
  // workspace init <name>
  // ---------------------------------------------------------------------------
  workspace
    .command('init <name>')
    .description('Initialize a workspace with a user and agent')
    .requiredOption('--user-id <id>', 'User ID')
    .requiredOption('--user-name <name>', 'User display name')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .requiredOption('--agent-name <name>', 'Agent display name')
    .option('--agent-type <type>', 'Agent type', 'assistant')
    .option('--agent-capabilities <caps>', 'Comma-separated list of agent capabilities')
    .option('--json', 'Output raw JSON response')
    .action(async (
      name: string,
      opts: {
        userId: string;
        userName: string;
        agentId: string;
        agentName: string;
        agentType: string;
        agentCapabilities?: string;
        json: boolean;
      },
    ) => {
      const client = getIMClient();
      try {
        const capabilities = opts.agentCapabilities
          ? opts.agentCapabilities.split(',').map((s) => s.trim())
          : undefined;
        const res = await client.im.workspace.init({
          workspaceId: name,
          userId: opts.userId,
          userDisplayName: opts.userName,
          agentName: opts.agentId,
          agentDisplayName: opts.agentName,
          agentType: opts.agentType,
          ...(capabilities !== undefined && { agentCapabilities: capabilities }),
        });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Workspace initialized (workspaceId: ${res.data?.workspaceId})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // workspace init-group <name>
  // ---------------------------------------------------------------------------
  workspace
    .command('init-group <name>')
    .description('Initialize a group workspace with a set of members')
    .requiredOption('--members <json>', 'JSON array of member objects')
    .option('--json', 'Output raw JSON response')
    .action(async (name: string, opts: { members: string; json: boolean }) => {
      const client = getIMClient();
      try {
        let users: Array<{ userId: string; displayName: string }>;
        try {
          const parsed = JSON.parse(opts.members);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          users = parsed;
        } catch {
          process.stderr.write('Error: --members must be a valid JSON array of {userId, displayName}\n');
          process.exit(1);
        }
        const res = await client.im.workspace.initGroup({ workspaceId: name, title: name, users });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Group workspace initialized (workspaceId: ${res.data?.workspaceId})\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // workspace add-agent <workspace-id> <agent-name>
  // ---------------------------------------------------------------------------
  workspace
    .command('add-agent <workspace-id> <agent-name>')
    .description('Create a basic agent identity (low-level; role workflows use the role-builder script)')
    .option('--display-name <name>', 'Agent display name (defaults to agent-name)')
    .option('--type <type>', 'Agent type', 'assistant')
    .option('--json', 'Output raw JSON response')
    .action(async (
      workspaceId: string,
      agentName: string,
      opts: { json: boolean; displayName?: string; type?: string },
    ) => {
      const client = getIMClient();
      try {
        const res = await client.im.workspace.addAgent(workspaceId, {
          agentName,
          agentDisplayName: opts.displayName || agentName,
          agentType: opts.type,
        });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Agent ${agentName} created in workspace ${workspaceId}.\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // workspace agents <workspace-id>
  // ---------------------------------------------------------------------------
  workspace
    .command('agents <workspace-id>')
    .description('List agents in a workspace')
    .option('--json', 'Output raw JSON response')
    .action(async (workspaceId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.workspace.listAgents(workspaceId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        const agents = res.data || [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
          return;
        }
        if (agents.length === 0) {
          process.stdout.write('No agents in this workspace.\n');
          return;
        }
        process.stdout.write('Agent ID'.padEnd(36) + 'Type'.padEnd(14) + 'Name\n');
        for (const a of agents) {
          process.stdout.write(
            `${(a.agentId || a.id || '').padEnd(36)}${(a.agentType || '').padEnd(14)}${a.name || a.displayName || ''}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // workspace member <sub> — release201/16 Phase 8 (v2.0.8)
  // ---------------------------------------------------------------------------
  //
  // Subcommands:
  //   workspace member list   <workspaceId>
  //   workspace member add    <workspaceId> --user <imUserId> [--role admin|member]
  //   workspace member update <workspaceId> <memberId> --role admin|member
  //   workspace member remove <workspaceId> <memberId>
  //
  // role=owner is rejected by service — ownership transfer is a v2.1+ RFC
  // (release201/16 §5.2). Cascade: removing a member also deletes that user's
  // project memberships inside the workspace (16 §3.2.3).

  // release203/15b — list/add/update/remove logic (role contract + remove
  // cascade) is the SHARED `buildWorkspaceMemberCommand` (one source, also used
  // by `prismer workspace member`); only the adapter below is `cloud`-specific
  // (PrismerClient.workspaces.members transport + padded-text output).
  workspace.addCommand(buildWorkspaceMemberCommand(mkMemberAdapter(getIMClient)));
}

/**
 * `cloud`-side adapter for the shared `buildWorkspaceMemberCommand`. Bridges the
 * transport/output-agnostic builder to PrismerClient.workspaces.members
 * (im_token auth) + the `cloud` padded-text output convention. Each method maps
 * a verb to its typed sub-client call and `fail`s (stderr + exit 1) on a non-ok
 * response, matching the prior inline behaviour.
 */
function mkMemberAdapter(getIMClient: ClientFactory): WorkspaceMemberAdapter {
  return {
    async list(workspaceId) {
      const res = await getIMClient().workspaces.members.list(workspaceId);
      if (!res.ok || !res.data) fail(res.error?.message || 'list members failed');
      return res.data as unknown as MemberRecord[];
    },
    async add(workspaceId, memberImUserId, role) {
      const res = await getIMClient().workspaces.members.add(workspaceId, { memberImUserId, role });
      if (!res.ok || !res.data) fail(res.error?.message || 'add member failed');
      return res.data as unknown as MemberRecord;
    },
    async update(workspaceId, memberId, role) {
      const res = await getIMClient().workspaces.members.update(workspaceId, memberId, { role });
      if (!res.ok || !res.data) fail(res.error?.message || 'update member failed');
      return res.data as unknown as MemberRecord;
    },
    async remove(workspaceId, memberId) {
      const res = await getIMClient().workspaces.members.remove(workspaceId, memberId);
      if (!res.ok || !res.data) fail(res.error?.message || 'remove member failed');
      return res.data as unknown as MemberRemoveRecord;
    },
    emitList(items, opts) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(items, null, 2) + '\n');
        return;
      }
      printMemberList(items as unknown as IMWorkspaceMember[]);
    },
    emitMember(member, opts, verb) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(member, null, 2) + '\n');
        return;
      }
      if (verb === 'add') {
        process.stdout.write(`Member added: ${member.memberImUserId} → ${member.role} (${member.id})\n`);
      } else {
        process.stdout.write(`Member ${member.id} role → ${member.role}\n`);
      }
    },
    emitRemove(result, opts) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `Member removed: ${result.removed.memberImUserId} (${result.removed.id}); ` +
          `project memberships cascaded: ${result.projectMembershipsRemoved}\n`,
      );
    },
    fail(msg) {
      fail(msg);
    },
  };
}
