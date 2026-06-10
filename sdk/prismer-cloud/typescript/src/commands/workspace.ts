import { Command } from 'commander';
import type { IMWorkspaceMember } from '../index';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function emitJson(data: unknown, json: boolean, fallback: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  fallback();
}

function parseAdminMemberRole(raw: string | undefined): 'admin' | 'member' {
  // role=owner is rejected by service (ownership transfer is v2.1+ RFC).
  // CLI surfaces this early to give a clearer error.
  if (raw === 'admin' || raw === 'member') return raw;
  if (raw === undefined) return 'member';
  if (raw === 'owner') {
    fail('--role=owner is not allowed via CLI; use ownership transfer (v2.1+ RFC, release201/16 §5.2)');
  }
  fail('--role must be admin|member');
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
  // workspace add-agent <workspace-id> <agent-id>
  // ---------------------------------------------------------------------------
  workspace
    .command('add-agent <workspace-id> <agent-id>')
    .description('Add an agent to a workspace')
    .option('--json', 'Output raw JSON response')
    .action(async (workspaceId: string, agentId: string, opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.workspace.addAgent(workspaceId, agentId);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || JSON.stringify(res.error)}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Agent ${agentId} added to workspace ${workspaceId}.\n`);
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

  const member = workspace.command('member').description('Workspace membership management (release201/16)');

  member
    .command('list <workspaceId>')
    .description('List members of a workspace (any member can read)')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.workspaces.members.list(workspaceId);
      if (!res.ok || !res.data) fail(res.error?.message || 'list members failed');
      emitJson(res.data, opts.json === true, () => printMemberList(res.data as IMWorkspaceMember[]));
    });

  member
    .command('add <workspaceId>')
    .description('Add an existing user to a workspace as admin or member (owner only)')
    .requiredOption('--user <imUserId>', 'IM user id of the new member')
    .option('--role <role>', 'admin | member (default member)')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, opts: { user: string; role?: string; json?: boolean }) => {
      const role = parseAdminMemberRole(opts.role);
      const client = getIMClient();
      const res = await client.workspaces.members.add(workspaceId, {
        memberImUserId: opts.user.trim(),
        role,
      });
      if (!res.ok || !res.data) fail(res.error?.message || 'add member failed');
      emitJson(res.data, opts.json === true, () => {
        const m = res.data as IMWorkspaceMember;
        process.stdout.write(`Member added: ${m.memberImUserId} → ${m.role} (${m.id})\n`);
      });
    });

  member
    .command('update <workspaceId> <memberId>')
    .description('Change a member role (owner only; owner row is immutable)')
    .requiredOption('--role <role>', 'admin | member')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, memberId: string, opts: { role: string; json?: boolean }) => {
      const role = parseAdminMemberRole(opts.role);
      const client = getIMClient();
      const res = await client.workspaces.members.update(workspaceId, memberId, { role });
      if (!res.ok || !res.data) fail(res.error?.message || 'update member failed');
      emitJson(res.data, opts.json === true, () => {
        const m = res.data as IMWorkspaceMember;
        process.stdout.write(`Member ${m.id} role → ${m.role}\n`);
      });
    });

  member
    .command('remove <workspaceId> <memberId>')
    .description('Remove a member (owner only); cascades project memberships in the same workspace')
    .option('--json', 'Output JSON')
    .action(async (workspaceId: string, memberId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.workspaces.members.remove(workspaceId, memberId);
      if (!res.ok || !res.data) fail(res.error?.message || 'remove member failed');
      emitJson(res.data, opts.json === true, () => {
        const r = res.data!;
        process.stdout.write(
          `Member removed: ${r.removed.memberImUserId} (${r.removed.id}); ` +
            `project memberships cascaded: ${r.projectMembershipsRemoved}\n`,
        );
      });
    });
}
