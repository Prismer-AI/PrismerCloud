import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const workspace = parent
    .command('workspace')
    .description('Workspace management — init, groups, and agent assignment');

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
          name,
          userId: opts.userId,
          userName: opts.userName,
          agentId: opts.agentId,
          agentName: opts.agentName,
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
        let members: unknown;
        try {
          members = JSON.parse(opts.members);
        } catch {
          process.stderr.write('Error: --members must be a valid JSON array\n');
          process.exit(1);
        }
        const res = await client.im.workspace.initGroup({ name, members });
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
}
