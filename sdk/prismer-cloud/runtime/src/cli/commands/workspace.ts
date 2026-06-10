// `prismer workspace (list|create|get|runtime|files)` — workspace management.
//
// CLI-only MVP surface for 54release. Uses the new IM endpoints under
// `/api/im/workspaces` plus runtime and workspace-files snapshots.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

interface WorkspaceDTO {
  id: string;
  ownerImUserId?: string;
  name: string;
  slug?: string;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

interface RuntimeAgentDTO {
  id: string;
  name: string;
  status: string;
  currentTaskId: string | null;
  version: string | null;
  lastHeartbeat: string | null;
}

interface RuntimeDeviceDTO {
  deviceId: string;
  name: string;
  lastSeenAt: string | null;
  agents: RuntimeAgentDTO[];
}

interface WorkspaceRuntimeDTO {
  workspaceId: string;
  devices: RuntimeDeviceDTO[];
}

interface WorkspaceFileDTO {
  id: string;
  workspaceId: string;
  path: string;
  assetId: string;
  contentHash?: string;
  version: number;
  parentVersionId: string | null;
  modifierImUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// release201/16 Phase 8: workspace members. role enum is workspace-scoped
// (owner/admin/member); project memberships use a different enum (16 §5.1).
interface WorkspaceMemberDTO {
  id: string;
  workspaceId: string;
  memberImUserId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

interface WorkspaceMemberRemoveResult {
  removed: WorkspaceMemberDTO;
  projectMembershipsRemoved: number;
}

export function buildWorkspaceCommand(): Command {
  const cmd = new Command('workspace').description('Manage workspaces, runtime snapshots, and workspace files');

  cmd
    .command('list')
    .description('List workspaces')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{ json?: boolean }]>(async (opts) => {
      const cloud = mkCloud();
      const data = await cloud.get<WorkspaceDTO[]>('/api/im/workspaces');
      if (opts.json) {
        printJson(data);
        return;
      }
      printWorkspaceList(data);
    }, { code: 'workspace_list_failed' }));

  cmd
    .command('create')
    .description('Create a workspace')
    .requiredOption('--name <name>', 'Workspace name')
    .option('--description <text>', 'Workspace description')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[{ name: string; description?: string; json?: boolean }]>(async (opts) => {
      const cloud = mkCloud();
      const name = opts.name.trim();
      if (!name) exitWithError('--name is required', { code: 'invalid_argument' });
      const slug = deriveSlug(name);
      const res = await cloud.request('POST', '/api/im/workspaces', {
        body: {
          name,
          slug,
          metadata: opts.description ? { description: opts.description } : {},
        },
      });
      if (!res.ok) exitWithError(`create failed (${res.status}): ${res.error?.message}`, { code: res.error?.code ?? 'workspace_create_failed' });
      const data = unwrapApiResponse<WorkspaceDTO>(res.data);
      if (!data) exitWithError('cloud returned no workspace data', { code: 'workspace_create_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      printWorkspace(data, 'Workspace created');
    }, { code: 'workspace_create_failed' }));

  cmd
    .command('get <workspaceId>')
    .description('Fetch a workspace by id')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (workspaceId, opts) => {
      const cloud = mkCloud();
      const data = await cloud.get<WorkspaceDTO>(`/api/im/workspaces/${encodeURIComponent(workspaceId)}`);
      if (opts.json) {
        printJson(data);
        return;
      }
      printWorkspace(data, 'Workspace');
    }, { code: 'workspace_get_failed' }));

  cmd
    .command('runtime <workspaceId>')
    .description('Fetch a workspace runtime snapshot')
    .option('--events', 'Follow the runtime event stream')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { events?: boolean; json?: boolean }]>(async (workspaceId, opts) => {
      const cloud = mkCloud();
      if (opts.events) {
        await streamRuntimeEvents(cloud, workspaceId, opts.json === true);
        return;
      }
      const data = await cloud.get<WorkspaceRuntimeDTO>(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/runtime`);
      if (opts.json) {
        printJson(data);
        return;
      }
      printRuntimeSnapshot(data);
    }, { code: 'workspace_runtime_failed' }));

  cmd
    .command('files <workspaceId>')
    .description('List workspace files')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (workspaceId, opts) => {
      const cloud = mkCloud();
      const data = await cloud.get<WorkspaceFileDTO[]>(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/files`);
      if (opts.json) {
        printJson(data);
        return;
      }
      printWorkspaceFiles(data);
    }, { code: 'workspace_files_failed' }));

  // release201/16 Phase 8: members management.
  // Enterprise/scripting path; the human invite flow ships in Phase 9.
  cmd.addCommand(buildMemberCommand());

  // release201/16 Phase 9: token-bearing invites (human path).
  cmd.addCommand(buildInviteCommand());

  return cmd;
}

function buildMemberCommand(): Command {
  const member = new Command('member').description('Manage workspace members (release201/16 Phase 8)');

  member
    .command('list <workspaceId>')
    .description('List workspace members')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { json?: boolean }]>(async (workspaceId, opts) => {
      const cloud = mkCloud();
      const data = await cloud.get<WorkspaceMemberDTO[]>(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/members`);
      if (opts.json) {
        printJson(data);
        return;
      }
      printMemberList(data);
    }, { code: 'workspace_member_list_failed' }));

  member
    .command('add <workspaceId> <imUserId>')
    .description('Add a workspace member (owner only; human invite flow is `cloud workspace invite create`)')
    .option('--role <role>', 'admin | member', 'member')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, string, { role: string; json?: boolean }]>(async (workspaceId, imUserId, opts) => {
      if (opts.role !== 'admin' && opts.role !== 'member') {
        exitWithError('--role must be admin or member (owner is set on workspace create, transfer is v2.1+)', {
          code: 'invalid_argument',
        });
      }
      const cloud = mkCloud();
      const res = await cloud.request('POST', `/api/im/workspaces/${encodeURIComponent(workspaceId)}/members`, {
        body: { memberImUserId: imUserId, role: opts.role },
      });
      if (!res.ok) {
        exitWithError(`add failed (${res.status}): ${res.error?.message}`, {
          code: res.error?.code ?? 'workspace_member_add_failed',
        });
      }
      const data = unwrapApiResponse<WorkspaceMemberDTO>(res.data);
      if (!data) exitWithError('cloud returned no member data', { code: 'workspace_member_add_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      const ui = getUI();
      ui.line(`Added member ${data.memberImUserId} as ${data.role} (id=${data.id}).`);
    }, { code: 'workspace_member_add_failed' }));

  member
    .command('update <workspaceId> <memberId>')
    .description('Change a member role (owner-only; owner role itself is immutable here)')
    .requiredOption('--role <role>', 'admin | member')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, string, { role: string; json?: boolean }]>(async (workspaceId, memberId, opts) => {
      if (opts.role !== 'admin' && opts.role !== 'member') {
        exitWithError('--role must be admin or member', { code: 'invalid_argument' });
      }
      const cloud = mkCloud();
      const res = await cloud.request(
        'PATCH',
        `/api/im/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
        { body: { role: opts.role } },
      );
      if (!res.ok) {
        exitWithError(`update failed (${res.status}): ${res.error?.message}`, {
          code: res.error?.code ?? 'workspace_member_update_failed',
        });
      }
      const data = unwrapApiResponse<WorkspaceMemberDTO>(res.data);
      if (!data) exitWithError('cloud returned no member data', { code: 'workspace_member_update_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      const ui = getUI();
      ui.line(`Updated member ${data.memberImUserId} role → ${data.role}.`);
    }, { code: 'workspace_member_update_failed' }));

  member
    .command('remove <workspaceId> <memberId>')
    .description('Remove a member (owner-only; cascades project memberships in the same workspace)')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, string, { json?: boolean }]>(async (workspaceId, memberId, opts) => {
      const cloud = mkCloud();
      const res = await cloud.request(
        'DELETE',
        `/api/im/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
      );
      if (!res.ok) {
        exitWithError(`remove failed (${res.status}): ${res.error?.message}`, {
          code: res.error?.code ?? 'workspace_member_remove_failed',
        });
      }
      const data = unwrapApiResponse<WorkspaceMemberRemoveResult>(res.data);
      if (!data) exitWithError('cloud returned no remove result', { code: 'workspace_member_remove_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      const ui = getUI();
      ui.line(`Removed ${data.removed.memberImUserId} (cascade removed ${data.projectMembershipsRemoved} project membership(s)).`);
    }, { code: 'workspace_member_remove_failed' }));

  return member;
}

// release201/16 Phase 9: invite token system.
interface WorkspaceInviteDTO {
  id: string;
  workspaceId: string;
  inviterUserId: string;
  token: string;
  inviteeEmail: string | null;
  inviteeImUserId: string | null;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function buildInviteCommand(): Command {
  const invite = new Command('invite').description('Mint, list, and revoke workspace invite links (release201/16 Phase 9)');

  invite
    .command('create <workspaceId>')
    .description('Mint an invite (owner/admin). Provide --email OR --imuser; default role member; default TTL 7d.')
    .option('--email <email>', 'Send link to this email address (link-mode invite)')
    .option('--imuser <imUserId>', 'Address invite to a known im user (direct-mode invite)')
    .option('--role <role>', 'admin | member', 'member')
    .option('--days <n>', 'TTL in days (1-30; default 7)', (v) => parseInt(v, 10))
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, { email?: string; imuser?: string; role: string; days?: number; json?: boolean }]>(async (workspaceId, opts) => {
      if (!opts.email && !opts.imuser) {
        exitWithError('Provide --email or --imuser (an invite addressee is required)', { code: 'invalid_argument' });
      }
      if (opts.role !== 'admin' && opts.role !== 'member') {
        exitWithError('--role must be admin or member (owner is v2.1+)', { code: 'invalid_argument' });
      }
      const cloud = mkCloud();
      const body: Record<string, unknown> = { role: opts.role };
      if (opts.email) body.inviteeEmail = opts.email;
      if (opts.imuser) body.inviteeImUserId = opts.imuser;
      if (opts.days !== undefined) body.expiresInDays = opts.days;
      const res = await cloud.request('POST', `/api/im/workspaces/${encodeURIComponent(workspaceId)}/invites`, { body });
      if (!res.ok) {
        exitWithError(`create failed (${res.status}): ${res.error?.message}`, {
          code: res.error?.code ?? 'workspace_invite_create_failed',
        });
      }
      const data = unwrapApiResponse<WorkspaceInviteDTO>(res.data);
      if (!data) exitWithError('cloud returned no invite data', { code: 'workspace_invite_create_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      const ui = getUI();
      ui.line(`Invite minted: ${data.id}`);
      ui.secondary(`token: ${data.token}`);
      ui.secondary(`role: ${data.role}    expires: ${data.expiresAt}`);
      if (data.inviteeEmail) ui.secondary(`addressed to email: ${data.inviteeEmail}`);
      if (data.inviteeImUserId) ui.secondary(`addressed to imUser: ${data.inviteeImUserId}`);
    }, { code: 'workspace_invite_create_failed' }));

  invite
    .command('list <workspaceId>')
    .description('List invites for a workspace (owner/admin)')
    .option('--json', 'Output machine-readable JSON')
    .option(
      '--show-tokens',
      'Include raw invite tokens in the output (treat tokens as secrets — defaults off)',
    )
    .action(runAction<[string, { json?: boolean; showTokens?: boolean }]>(async (workspaceId, opts) => {
      const cloud = mkCloud();
      const data = await cloud.get<WorkspaceInviteDTO[]>(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/invites`);
      // Redact tokens by default; the CLI's primary audience pastes output
      // into terminals / share-screens / tickets. The cookbook treats the
      // token as a bearer secret (release201/16 §0.2.4); opt-in is explicit.
      const view = opts.showTokens ? data : data.map((inv) => ({ ...inv, token: redactToken(inv.token) }));
      if (opts.json) {
        printJson(view);
        return;
      }
      printInviteList(view);
    }, { code: 'workspace_invite_list_failed' }));

  invite
    .command('revoke <workspaceId> <inviteId>')
    .description('Revoke a pending invite (owner/admin). Terminal states are not affected.')
    .option('--json', 'Output machine-readable JSON')
    .action(runAction<[string, string, { json?: boolean }]>(async (workspaceId, inviteId, opts) => {
      const cloud = mkCloud();
      const res = await cloud.request('DELETE', `/api/im/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`);
      if (!res.ok) {
        exitWithError(`revoke failed (${res.status}): ${res.error?.message}`, {
          code: res.error?.code ?? 'workspace_invite_revoke_failed',
        });
      }
      const data = unwrapApiResponse<WorkspaceInviteDTO>(res.data);
      if (!data) exitWithError('cloud returned no invite data', { code: 'workspace_invite_revoke_failed' });
      if (opts.json) {
        printJson(data);
        return;
      }
      const ui = getUI();
      ui.line(`Invite ${data.id} revoked (status=${data.status}).`);
    }, { code: 'workspace_invite_revoke_failed' }));

  return invite;
}

// release201/16 §0.2.4 — tokens are bearer secrets; default CLI output shows
// a short prefix + length so admins can correlate rows with stored copies
// without leaking the live secret to terminal scrollback / screen-share.
function redactToken(token: string): string {
  if (!token) return token;
  const prefix = token.slice(0, 6);
  return `${prefix}…(${token.length}ch, --show-tokens to reveal)`;
}

function printInviteList(items: WorkspaceInviteDTO[]): void {
  const ui = getUI();
  if (items.length === 0) {
    ui.secondary('No invites found.');
    return;
  }
  ui.header(`Invites (${items.length})`);
  ui.blank();
  ui.table(
    items.map((inv) => ({
      id: inv.id,
      status: inv.status,
      role: inv.role,
      addressee: inv.inviteeEmail ?? inv.inviteeImUserId ?? '—',
      expiresAt: inv.expiresAt,
    })),
    { columns: ['id', 'status', 'role', 'addressee', 'expiresAt'] },
  );
}

function printMemberList(items: WorkspaceMemberDTO[]): void {
  const ui = getUI();
  if (items.length === 0) {
    ui.secondary('No members found.');
    return;
  }
  ui.header(`Members (${items.length})`);
  ui.blank();
  ui.table(
    items.map((m) => ({
      id: m.id,
      imUserId: m.memberImUserId,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    { columns: ['id', 'imUserId', 'role', 'joinedAt'] },
  );
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64);
  if (!slug) exitWithError('Could not derive a workspace slug from --name');
  return slug;
}

function unwrapApiResponse<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object' && 'ok' in raw && 'data' in raw) {
    const env = raw as { ok?: boolean; data?: T };
    if (env.ok === false) return null;
    return env.data ?? null;
  }
  return raw as T;
}

function printWorkspaceList(items: WorkspaceDTO[]): void {
  const ui = getUI();
  if (items.length === 0) {
    ui.secondary('No workspaces found.');
    return;
  }
  ui.header(`Workspaces (${items.length})`);
  ui.blank();
  ui.table(
    items.map((ws) => ({
      id: ws.id,
      name: ws.name,
      slug: ws.slug ?? '—',
      default: ws.isDefault ? '●' : '·',
      updated: ws.updatedAt ?? '—',
    })),
    { columns: ['id', 'name', 'slug', 'default', 'updated'] },
  );
}

function printWorkspace(ws: WorkspaceDTO, heading = 'Workspace'): void {
  const ui = getUI();
  const bits = [`${heading}: ${ws.name}`, `id=${ws.id}`];
  if (ws.slug) bits.push(`slug=${ws.slug}`);
  if (ws.isDefault !== undefined) bits.push(ws.isDefault ? 'default=yes' : 'default=no');
  ui.line(bits.join('  '));
  const description = ws.metadata?.description;
  if (typeof description === 'string' && description) {
    ui.secondary(`description: ${description}`);
  }
  if (ws.createdAt) ui.secondary(`createdAt: ${ws.createdAt}`);
  if (ws.updatedAt) ui.secondary(`updatedAt: ${ws.updatedAt}`);
}

function printRuntimeSnapshot(snapshot: WorkspaceRuntimeDTO): void {
  const ui = getUI();
  ui.header(`Workspace runtime: ${snapshot.workspaceId}`);
  ui.blank();
  if (snapshot.devices.length === 0) {
    ui.secondary('No runtime devices found.');
    return;
  }
  for (const device of snapshot.devices) {
    ui.line(`- ${device.name} (${device.deviceId})`);
    if (device.lastSeenAt) ui.secondary(`lastSeenAt: ${device.lastSeenAt}`, 4);
    for (const agent of device.agents) {
      const detail = [
        agent.status,
        agent.currentTaskId ? `task=${agent.currentTaskId}` : null,
        agent.version ? `version=${agent.version}` : null,
        agent.lastHeartbeat ? `heartbeat=${agent.lastHeartbeat}` : null,
      ]
        .filter(Boolean)
        .join('  ');
      ui.line(`  - ${agent.name} (${agent.id})${detail ? `  ${detail}` : ''}`);
    }
  }
}

function printWorkspaceFiles(items: WorkspaceFileDTO[]): void {
  const ui = getUI();
  if (items.length === 0) {
    ui.secondary('No workspace files found.');
    return;
  }
  ui.header(`Workspace files (${items.length})`);
  ui.blank();
  ui.table(
    items.map((file) => ({
      path: file.path,
      id: file.id,
      asset: file.assetId,
      version: `v${file.version}`,
      hash: file.contentHash ?? '—',
    })),
    { columns: ['path', 'id', 'asset', 'version', 'hash'] },
  );
}

async function streamRuntimeEvents(cloud: CloudClient, workspaceId: string, jsonMode: boolean): Promise<void> {
  const res = await cloud.fetchRaw(`/api/im/workspaces/${encodeURIComponent(workspaceId)}/runtime/events`);
  if (!res.ok) {
    const detail = await readResponseError(res);
    exitWithError(`runtime events failed (${res.status}): ${detail}`);
  }
  if (!res.body) exitWithError('runtime events stream unavailable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleSseBlock(block, jsonMode);
    }
  }
}

function handleSseBlock(block: string, jsonMode: boolean): void {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  const raw = dataLines.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep raw text */
  }
  if (jsonMode) {
    printJson({ event, data: parsed });
    return;
  }
  const ui = getUI();
  if (event === 'snapshot') {
    ui.line('Runtime snapshot:');
    printRuntimeSnapshot(parsed as WorkspaceRuntimeDTO);
    return;
  }
  if (event === 'agent.heartbeat') {
    const evt = parsed as {
      agentId?: string;
      deviceId?: string;
      status?: string;
      currentTaskId?: string | null;
      version?: string | null;
      lastHeartbeat?: string | null;
    };
    const parts = [
      evt.agentId ?? 'agent',
      evt.deviceId ? `device=${evt.deviceId}` : null,
      evt.status ? `status=${evt.status}` : null,
      evt.currentTaskId ? `task=${evt.currentTaskId}` : null,
      evt.version ? `version=${evt.version}` : null,
    ].filter(Boolean);
    ui.line(`heartbeat: ${parts.join('  ')}`);
    return;
  }
  ui.line(`${event}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
}

async function readResponseError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return 'unknown error';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) return parsed.error.message;
  } catch {
    /* fall through */
  }
  return text;
}
