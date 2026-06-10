/**
 * `cloud project ...` — Project scope CLI (release201/09 Phase 1, v2.0.7).
 *
 * Subcommands (§7.2):
 *   cloud project list        --workspace <id> [--status active|archived] [--search q]
 *   cloud project create      --workspace <id> --slug <s> --name <n> [--description <d>]
 *   cloud project show        <id>
 *   cloud project update      <id> [--name <n>] [--description <d>] [--archive|--unarchive]
 *   cloud project delete      <id> [--cascade null|hard]  (default cascade=archive soft-delete)
 *
 *   cloud project members list   <id>
 *   cloud project members add    <id> --principal user:<uid>|agent:<aid> [--role owner|contributor|observer]
 *   cloud project members update <id> <membershipId> --role owner|contributor|observer
 *   cloud project members remove <id> <membershipId>
 */

import { Command } from 'commander';
import type {
  PrismerClient,
  IMProject,
  IMProjectWithCounts,
  IMProjectMembership,
  ProjectListResult,
  ProjectStatus,
  ProjectMembershipRole,
  ProjectPrincipalKind,
  ProjectDeleteCascade,
} from '../index';

type ClientFactory = () => PrismerClient;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function emit(data: unknown, json: boolean, lines: () => void): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  lines();
}

function parsePrincipal(raw: string): { kind: ProjectPrincipalKind; id: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0) fail('--principal must be `user:<id>` or `agent:<id>`');
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1).trim();
  if (kind !== 'user' && kind !== 'agent') fail('principal kind must be user|agent');
  if (!id) fail('principal id must be non-empty');
  return { kind, id };
}

function parseRole(raw: string | undefined): ProjectMembershipRole | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'owner' || raw === 'contributor' || raw === 'observer') return raw;
  fail('--role must be owner|contributor|observer');
}

function printProjectList(items: IMProjectWithCounts[]): void {
  if (items.length === 0) {
    process.stdout.write('No projects found.\n');
    return;
  }
  process.stdout.write(
    'ID'.padEnd(28) + 'SLUG'.padEnd(20) + 'STATUS'.padEnd(10) + 'MEMBERS'.padEnd(10) + 'NAME\n',
  );
  for (const p of items) {
    process.stdout.write(
      `${p.id.padEnd(28)}${p.slug.padEnd(20)}${p.status.padEnd(10)}${String(p.memberCount).padEnd(10)}${p.name}\n`,
    );
  }
}

function printProject(p: IMProject | IMProjectWithCounts, heading = 'Project'): void {
  process.stdout.write(`${heading}: ${p.name}\n`);
  process.stdout.write(`  id           ${p.id}\n`);
  process.stdout.write(`  slug         ${p.slug}\n`);
  process.stdout.write(`  workspaceId  ${p.workspaceId}\n`);
  process.stdout.write(`  status       ${p.status}\n`);
  process.stdout.write(`  owner        ${p.ownerUserId}\n`);
  if ('memberCount' in p) process.stdout.write(`  members      ${p.memberCount}\n`);
  if (p.description) process.stdout.write(`  description  ${p.description}\n`);
  if (p.archivedAt) process.stdout.write(`  archivedAt   ${p.archivedAt}\n`);
  process.stdout.write(`  createdAt    ${p.createdAt}\n`);
  process.stdout.write(`  updatedAt    ${p.updatedAt}\n`);
}

function printMemberList(items: IMProjectMembership[]): void {
  if (items.length === 0) {
    process.stdout.write('No members in this project.\n');
    return;
  }
  process.stdout.write(
    'ID'.padEnd(28) + 'KIND'.padEnd(8) + 'PRINCIPAL'.padEnd(38) + 'ROLE'.padEnd(14) + 'JOINED\n',
  );
  for (const m of items) {
    process.stdout.write(
      `${m.id.padEnd(28)}${m.principalKind.padEnd(8)}${m.principalId.padEnd(38)}${m.role.padEnd(14)}${m.joinedAt}\n`,
    );
  }
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const project = parent
    .command('project')
    .description('Project scope (release201/09) — CRUD + membership management');

  // ── list ───────────────────────────────────────────────────────────────
  project
    .command('list')
    .description('List projects in a workspace')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--status <status>', 'Filter by status: active|archived')
    .option('--search <q>', 'Search name/slug substring')
    .option('--limit <n>', 'Page size (1-200)', (v) => Number(v))
    .option('--offset <n>', 'Page offset', (v) => Number(v))
    .option('--json', 'Output JSON')
    .action(async (opts: {
      workspace: string;
      status?: string;
      search?: string;
      limit?: number;
      offset?: number;
      json?: boolean;
    }) => {
      if (opts.status && opts.status !== 'active' && opts.status !== 'archived') {
        fail('--status must be active|archived');
      }
      const client = getIMClient();
      const res = await client.projects.list({
        workspaceId: opts.workspace,
        status: opts.status as ProjectStatus | undefined,
        search: opts.search,
        limit: opts.limit,
        offset: opts.offset,
      });
      if (!res.ok || !res.data) fail(res.error?.message || 'list failed');
      const data = res.data as ProjectListResult;
      emit(data, opts.json === true, () => {
        printProjectList(data.items);
        process.stdout.write(`\nTotal: ${data.total}\n`);
      });
    });

  // ── create ─────────────────────────────────────────────────────────────
  project
    .command('create')
    .description('Create a project in a workspace')
    .requiredOption('--workspace <id>', 'Workspace id')
    .requiredOption('--slug <slug>', 'Project slug (1-64 chars, [a-z0-9-])')
    .requiredOption('--name <name>', 'Project display name')
    .option('--description <text>', 'Project description')
    .option('--json', 'Output JSON')
    .action(async (opts: {
      workspace: string;
      slug: string;
      name: string;
      description?: string;
      json?: boolean;
    }) => {
      const client = getIMClient();
      const res = await client.projects.create({
        workspaceId: opts.workspace,
        slug: opts.slug,
        name: opts.name,
        description: opts.description ?? null,
      });
      if (!res.ok || !res.data) fail(res.error?.message || 'create failed');
      emit(res.data, opts.json === true, () => printProject(res.data as IMProject, 'Project created'));
    });

  // ── show ───────────────────────────────────────────────────────────────
  project
    .command('show <projectId>')
    .description('Show a project (with member count)')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.projects.get(projectId);
      if (!res.ok || !res.data) fail(res.error?.message || 'show failed');
      emit(res.data, opts.json === true, () => printProject(res.data as IMProjectWithCounts));
    });

  // ── update ─────────────────────────────────────────────────────────────
  project
    .command('update <projectId>')
    .description('Update project name / description / status')
    .option('--name <name>', 'New display name')
    .option('--description <text>', 'New description (empty string to clear)')
    .option('--archive', 'Set status=archived')
    .option('--unarchive', 'Set status=active')
    .option('--json', 'Output JSON')
    .action(async (
      projectId: string,
      opts: { name?: string; description?: string; archive?: boolean; unarchive?: boolean; json?: boolean },
    ) => {
      if (opts.archive && opts.unarchive) fail('--archive and --unarchive are mutually exclusive');
      const patch: { name?: string; description?: string | null; status?: ProjectStatus } = {};
      if (opts.name !== undefined) patch.name = opts.name;
      if (opts.description !== undefined) patch.description = opts.description === '' ? null : opts.description;
      if (opts.archive) patch.status = 'archived';
      if (opts.unarchive) patch.status = 'active';
      if (Object.keys(patch).length === 0) fail('Nothing to update — pass --name / --description / --archive / --unarchive');
      const client = getIMClient();
      const res = await client.projects.update(projectId, patch);
      if (!res.ok || !res.data) fail(res.error?.message || 'update failed');
      emit(res.data, opts.json === true, () => printProject(res.data as IMProject, 'Project updated'));
    });

  // ── delete ─────────────────────────────────────────────────────────────
  project
    .command('delete <projectId>')
    .description('Soft-delete a project (default cascade=archive). cascade=hard is reserved for v2.0.8+.')
    .option('--cascade <mode>', 'archive | null | hard', 'archive')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { cascade?: string; json?: boolean }) => {
      const cascade = (opts.cascade ?? 'archive') as ProjectDeleteCascade;
      if (cascade !== 'archive' && cascade !== 'null' && cascade !== 'hard') {
        fail('--cascade must be archive|null|hard');
      }
      const client = getIMClient();
      const res = await client.projects.delete(projectId, { cascade });
      if (!res.ok) fail(res.error?.message || 'delete failed');
      emit(res.data, opts.json === true, () => {
        if (res.data) {
          printProject(res.data as IMProject, 'Project archived');
        } else {
          process.stdout.write(`Project ${projectId} archived.\n`);
        }
      });
    });

  // ── members sub-commands ───────────────────────────────────────────────
  const members = project.command('members').description('Manage project memberships');

  members
    .command('list <projectId>')
    .description('List members of a project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.projects.members.list(projectId);
      if (!res.ok || !res.data) fail(res.error?.message || 'list members failed');
      emit(res.data, opts.json === true, () => printMemberList(res.data as IMProjectMembership[]));
    });

  members
    .command('add <projectId>')
    .description('Add a user or agent to the project')
    .requiredOption('--principal <p>', 'Principal in `user:<id>` or `agent:<id>` form')
    .option('--role <role>', 'owner | contributor | observer (default contributor)')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { principal: string; role?: string; json?: boolean }) => {
      const { kind, id } = parsePrincipal(opts.principal);
      const role = parseRole(opts.role);
      const client = getIMClient();
      const res = await client.projects.members.add(projectId, { principalKind: kind, principalId: id, role });
      if (!res.ok || !res.data) fail(res.error?.message || 'add member failed');
      emit(res.data, opts.json === true, () => {
        const m = res.data as IMProjectMembership;
        process.stdout.write(`Member added: ${m.principalKind}:${m.principalId} → ${m.role} (${m.id})\n`);
      });
    });

  members
    .command('update <projectId> <membershipId>')
    .description('Change a member role')
    .requiredOption('--role <role>', 'owner | contributor | observer')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, membershipId: string, opts: { role: string; json?: boolean }) => {
      const role = parseRole(opts.role);
      if (!role) fail('--role is required');
      const client = getIMClient();
      const res = await client.projects.members.update(projectId, membershipId, { role });
      if (!res.ok || !res.data) fail(res.error?.message || 'update member failed');
      emit(res.data, opts.json === true, () => {
        const m = res.data as IMProjectMembership;
        process.stdout.write(`Member ${m.id} role → ${m.role}\n`);
      });
    });

  members
    .command('remove <projectId> <membershipId>')
    .description('Remove a member from the project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, membershipId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      const res = await client.projects.members.remove(projectId, membershipId);
      if (!res.ok) fail(res.error?.message || 'remove member failed');
      emit({ ok: true }, opts.json === true, () => {
        process.stdout.write(`Membership ${membershipId} removed.\n`);
      });
    });
}
