// `prismer skill ...` — built-in skill install/sync/ack lifecycle helpers.
//
// v2.0 deliberately excludes publish/workspace-sharing. This CLI only covers
// catalog inspection, install/uninstall, and a local manual sync that reuses
// the daemon dispatch-time SkillSync path.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import type { AgentProfile } from '../../adapters/contract.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { openLocalDb } from '../../sync/store.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

interface SkillInfo {
  id?: string;
  slug?: string;
  name?: string;
  category?: string;
  source?: string;
  status?: string;
  installs?: number;
  updatedAt?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface AgentSkillRecord {
  agentSkill?: {
    id?: string;
    skillId?: string;
    status?: string;
    installedRevision?: string | null;
    lastSyncedAt?: string | null;
    lastSyncError?: string | null;
  };
  skill?: SkillInfo | null;
  expectedRevision?: string | null;
  syncState?: string;
}

interface ProfileRow {
  id: string;
  workspace_id: string;
  agent_im_user_id: string;
  adapter_name: string;
  name: string;
  config: string;
  version: number;
  synced_at: number | null;
}

export function buildSkillCommand(): Command {
  const cmd = new Command('skill').description('Inspect, install, and sync built-in skills');

  cmd
    .command('list')
    .description('List catalog skills or skills installed on an agent')
    .option('--agent <imUserId>', 'List skills installed on this agent')
    .option('--installed', 'List installed skills for --agent')
    .option('--include-inactive', 'Include disabled/uninstalled agent-skill records')
    .option('--workspace-id <id>', 'Workspace scope for installed skill records')
    .option('--query <text>', 'Catalog search query')
    .option('--category <name>', 'Catalog category filter')
    .option('--source <name>', 'Catalog source filter')
    .option('--limit <n>', 'Max catalog items', parsePositiveInt, 20)
    .option('--json', 'Output JSON')
    .action(runAction<[
      {
        agent?: string;
        installed?: boolean;
        includeInactive?: boolean;
        workspaceId?: string;
        query?: string;
        category?: string;
        source?: string;
        limit: number;
        json?: boolean;
      },
    ]>(async (opts) => {
      const cloud = mkCloud();
      if (opts.agent || opts.installed) {
        if (!opts.agent) exitWithError('--agent is required with --installed', { code: 'invalid_argument' });
        const params = new URLSearchParams();
        if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
        if (opts.includeInactive) params.set('includeInactive', 'true');
        const suffix = params.size > 0 ? `?${params.toString()}` : '';
        const data = await cloud.get<AgentSkillRecord[]>(
          `/api/im/agents/${encodeURIComponent(opts.agent)}/skills${suffix}`,
        );
        if (opts.json) {
          printJson(data);
          return;
        }
        printInstalledSkills(data, opts.agent);
        return;
      }

      const params = new URLSearchParams();
      if (opts.query) params.set('query', opts.query);
      if (opts.category) params.set('category', opts.category);
      if (opts.source) params.set('source', opts.source);
      params.set('limit', String(opts.limit));
      const data = await cloud.get<SkillInfo[]>(`/api/im/skills/search?${params.toString()}`);
      if (opts.json) {
        printJson(data);
        return;
      }
      printCatalogSkills(data);
    }, { code: 'skill_list_failed' }));

  cmd
    .command('show <slugOrId>')
    .description('Show a skill detail record')
    .option('--content', 'Include full SKILL.md content')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { content?: boolean; json?: boolean }]>(async (slugOrId, opts) => {
      const cloud = mkCloud();
      const path = opts.content
        ? `/api/im/skills/${encodeURIComponent(slugOrId)}/content`
        : `/api/im/skills/${encodeURIComponent(slugOrId)}`;
      const data = await cloud.get<SkillInfo>(path);
      if (opts.json) {
        printJson(data);
        return;
      }
      printSkill(data, opts.content === true);
    }, { code: 'skill_show_failed' }));

  cmd
    .command('install <slugOrId>')
    .description('Install a skill to an agent; omit --agent to install for the authenticated agent')
    .option('--agent <imUserId>', 'Target agent IMUser.id')
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--version <version>', 'Requested skill version')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { agent?: string; workspaceId?: string; version?: string; json?: boolean }]>(async (slugOrId, opts) => {
      const cloud = mkCloud();
      const path = opts.agent
        ? `/api/im/agents/${encodeURIComponent(opts.agent)}/skills`
        : `/api/im/skills/${encodeURIComponent(slugOrId)}/install`;
      const body = opts.agent
        ? { skillId: slugOrId, workspaceId: opts.workspaceId, version: opts.version }
        : { workspaceId: opts.workspaceId, version: opts.version };
      const data = await requestEnvelope<unknown>(cloud, 'POST', path, body, 'skill_install_failed');
      if (opts.json) {
        printJson(data);
        return;
      }
      getUI().ok('Skill install requested', opts.agent ? `agent=${opts.agent} skill=${slugOrId}` : slugOrId);
    }, { code: 'skill_install_failed' }));

  cmd
    .command('uninstall <slugOrId>')
    .description('Uninstall or disable a skill for an agent; omit --agent to uninstall for the authenticated agent')
    .option('--agent <imUserId>', 'Target agent IMUser.id')
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { agent?: string; workspaceId?: string; json?: boolean }]>(async (slugOrId, opts) => {
      const cloud = mkCloud();
      const path = opts.agent
        ? `/api/im/agents/${encodeURIComponent(opts.agent)}/skills`
        : `/api/im/skills/${encodeURIComponent(slugOrId)}/install`;
      const body = opts.agent ? { skillId: slugOrId, workspaceId: opts.workspaceId } : undefined;
      const data = await requestEnvelope<unknown>(cloud, 'DELETE', path, body, 'skill_uninstall_failed');
      if (opts.json) {
        printJson(data);
        return;
      }
      getUI().ok('Skill uninstall requested', opts.agent ? `agent=${opts.agent} skill=${slugOrId}` : slugOrId);
    }, { code: 'skill_uninstall_failed' }));

  cmd
    .command('sync')
    .description('Sync installed skills for ALL local profiles (default) or scoped subset')
    .option('--agent <imUserId>', 'Restrict to this agent (default: all local agents)')
    .option('--profile <profileId>', 'Restrict to this profile id (requires --agent)')
    .option('--json', 'Output JSON')
    .action(runAction<[{ agent?: string; profile?: string; json?: boolean }]>(async (opts) => {
      if (opts.profile && !opts.agent) {
        exitWithError('--profile requires --agent (profile id is scoped per agent)', {
          code: 'invalid_argument',
        });
      }
      const paths = resolvePaths();
      const cfg = loadConfig(paths);
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      // F16 (2026-05-20): default to ALL local profiles. Previous behaviour
      // required --agent and forced operators to look up the agent's
      // imUserId before they could sync — common cause of "Cli told me my
      // skills are stale but I can't figure out which agent to type".
      const profiles = opts.agent
        ? readLocalProfiles(opts.agent, opts.profile)
        : readAllLocalProfiles();
      if (profiles.length === 0) {
        exitWithError(
          opts.agent
            ? 'No local profile found for this agent. Run `prismer agent register` or wait for daemon profile sync.'
            : 'No local profiles found at all. Has the daemon paired + finished its first host.acked round?',
          { code: 'skill_sync_no_profile' },
        );
      }
      const { syncAllAgentSkills } = await import('../../daemon/skill-sync.js');
      // release201/09 §9.3.2 disconnect fix (2026-05-29) — CLI sync was
      // omitting `skillsRootCtx`, so files landed in the LEGACY hermes
      // profile dir (`~/.hermes/profiles/<name>/skills/`) instead of the
      // per-agent dir (`devices/<did>/agents/<aid>/skills/`) that
      // dispatch.ts injects into HermesService at spawn time. Result:
      // `prismer skill sync` "succeeded" but the running adapter never
      // saw the files — operators papered over this with manual cp.
      //
      // Now passing paths + daemon_id matches the daemon-side periodic
      // sync (runner.ts:677 syncAllSkillsBackground) so CLI + daemon
      // converge on the same on-disk layout.
      const { totals, byProfile } = await syncAllAgentSkills(profiles, cloud, {
        concurrency: 3,
        skillsRootCtx: { paths, daemonId: cfg.daemon_id },
      });
      if (opts.json) {
        printJson({ agent: opts.agent ?? null, totals, byProfile });
        return;
      }
      const ui = getUI();
      ui.header(`Skill sync (${opts.agent ?? 'all agents'})`);
      ui.table(
        byProfile.map((r) => ({
          profile: r.profileId,
          agent: r.agentImUserId,
          adapter: r.adapter,
          ok: r.ok ? 'yes' : 'NO',
          synced: String(r.result?.synced ?? 0),
          unchanged: String(r.result?.unchanged ?? 0),
          skipped: String(r.result?.skipped ?? 0),
          // 2026-05-29 — new column. Visible when an agent had 0 installed
          // skills + cloud install-builtins repair failed (workspaceId
          // missing on agentCard, SKILL_ACK_AUTH_MODE rejected caller,
          // network error, etc). Empty when backfill wasn't needed or
          // succeeded; surfaces "FAIL" otherwise so operators see WHY
          // synced=0 instead of paper-over via manual cp.
          backfill: r.result?.backfill
            ? r.result.backfill.ok
              ? `ok(${r.result.backfill.installed ?? 0})`
              : `FAIL(${r.result.backfill.status ?? '?'}): ${r.result.backfill.message ?? ''}`
            : '',
          error: r.error ?? '',
        })),
        { columns: ['profile', 'agent', 'adapter', 'ok', 'synced', 'unchanged', 'skipped', 'backfill', 'error'] },
      );
      ui.line(
        `\nTotals: profiles=${totals.profiles}  synced=${totals.synced}  unchanged=${totals.unchanged}  skipped=${totals.skipped}  failed=${totals.failed}  backfillFailed=${totals.backfillFailed}`,
      );
    }, { code: 'skill_sync_failed' }));

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

async function requestEnvelope<T>(
  cloud: CloudClient,
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  code: string,
): Promise<T> {
  const res = await cloud.request<{ ok?: boolean; data?: T; error?: { message?: string; code?: string } }>(method, path, {
    body,
  });
  if (!res.ok) {
    exitWithError(`${method} ${path} failed (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`, {
      code: res.error?.code ?? code,
    });
  }
  const envelope = res.data;
  if (envelope && typeof envelope === 'object' && envelope.ok === false) {
    exitWithError(envelope.error?.message ?? `${method} ${path} failed`, { code: envelope.error?.code ?? code });
  }
  return (envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : envelope) as T;
}

function readAllLocalProfiles(): AgentProfile[] {
  // F16 (2026-05-20) — `prismer skill sync` with no args reads every live
  // agent_profiles row. Used when the operator wants a one-shot "sync
  // whatever the daemon knows about" without remembering each agent id.
  const paths = resolvePaths();
  const db = openLocalDb(paths.localDb);
  try {
    const rows = db
      .prepare(`SELECT * FROM agent_profiles WHERE deleted_at IS NULL`)
      .all() as ProfileRow[];
    return rows.map(rowToProfile);
  } finally {
    db.close();
  }
}

function readLocalProfiles(agentImUserId: string, profileId?: string): AgentProfile[] {
  const paths = resolvePaths();
  const db = openLocalDb(paths.localDb);
  try {
    const rows = db
      .prepare(
        profileId
          ? `SELECT * FROM agent_profiles WHERE agent_im_user_id = ? AND id = ? AND deleted_at IS NULL`
          : `SELECT * FROM agent_profiles WHERE agent_im_user_id = ? AND deleted_at IS NULL`,
      )
      .all(profileId ? [agentImUserId, profileId] : [agentImUserId]) as ProfileRow[];
    return rows.map(rowToProfile);
  } finally {
    db.close();
  }
}

function rowToProfile(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentImUserId: row.agent_im_user_id,
    adapterName: row.adapter_name,
    name: row.name,
    config: parseJsonObject(row.config),
    version: row.version,
    createdAt: new Date(row.synced_at ?? Date.now()),
    updatedAt: new Date(row.synced_at ?? Date.now()),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    exitWithError('Expected a positive integer', { code: 'invalid_argument' });
  }
  return parsed;
}

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

function printCatalogSkills(items: SkillInfo[]): void {
  const ui = getUI();
  ui.header(`Skills (${items.length})`);
  if (items.length === 0) {
    ui.secondary('No skills found.');
    return;
  }
  ui.table(
    items.map((skill) => ({
      slug: skill.slug ?? skill.id ?? '—',
      name: skill.name ?? '—',
      category: skill.category ?? '—',
      source: skill.source ?? '—',
      installs: String(skill.installs ?? 0),
    })),
    { columns: ['slug', 'name', 'category', 'source', 'installs'] },
  );
}

function printInstalledSkills(items: AgentSkillRecord[], agentId: string): void {
  const ui = getUI();
  ui.header(`Installed skills: ${agentId} (${items.length})`);
  if (items.length === 0) {
    ui.secondary('No installed skills found.');
    return;
  }
  ui.table(
    items.map((item) => ({
      slug: item.skill?.slug ?? item.agentSkill?.skillId ?? '—',
      name: item.skill?.name ?? '—',
      status: item.agentSkill?.status ?? '—',
      sync: item.syncState ?? '—',
      ack: item.agentSkill?.installedRevision ? item.agentSkill.installedRevision.slice(0, 8) : '—',
      error: item.agentSkill?.lastSyncError ?? '—',
    })),
    { columns: ['slug', 'name', 'status', 'sync', 'ack', 'error'] },
  );
}

function printSkill(skill: SkillInfo, includeContent: boolean): void {
  const ui = getUI();
  ui.header(skill.name ?? skill.slug ?? skill.id ?? 'Skill');
  ui.line(`id=${skill.id ?? '—'}  slug=${skill.slug ?? '—'}  category=${skill.category ?? '—'}`);
  ui.line(`source=${skill.source ?? '—'}  status=${skill.status ?? '—'}  installs=${skill.installs ?? 0}`);
  if (skill.updatedAt) ui.secondary(`updatedAt: ${skill.updatedAt}`);
  if (includeContent && skill.content) {
    ui.blank();
    ui.line(skill.content);
  }
}
