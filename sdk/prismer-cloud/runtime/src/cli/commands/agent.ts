// `prismer agent (list|register|rename|remove|doctor)` — manage agent inventory.
//
// list   — calls cloud GET /api/im/agents (subset visible to caller).
// register — calls cloud POST /api/im/register {type:'agent',...} via daemon's
//            API key (auto-bound to caller's human cloud user); returns the
//            new IMUser.id and mirrors row into ~/.prismer/local.db. Pass
//            --im-user-id to skip cloud call (advanced: re-attach existing).
// rename — PATCH /api/im/agents/:id { displayName }.
// remove — local-only by default; --cloud also DELETEs /api/im/agents/:id.
// doctor — checks local daemon, local mirror, cloud visibility, profile, adapter.

import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { openLocalDb } from '../../sync/store.js';
import { exitWithError, pidAlive, printJson, readPidFile, runAction } from '../util.js';
import { getUI } from '../ui.js';

interface LocalAgentRow {
  im_user_id: string;
  workspace_id: string;
  name: string;
  adapter_name: string;
  capabilities: string;
  status: string;
  version: number;
  synced_at: number | null;
  dirty: number;
}

interface LocalProfileRow {
  id: string;
  workspace_id: string;
  agent_im_user_id: string;
  adapter_name: string;
  name: string;
  version: number;
  dirty: number;
  deleted_at: number | null;
}

interface CloudAgentLike {
  id?: string;
  imUserId?: string;
  im_user_id?: string;
  userId?: string;
  name?: string;
  displayName?: string;
  username?: string;
  adapterName?: string;
  adapter_name?: string;
  metadata?: { adapter?: string; adapterName?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface DoctorCheck {
  ok: boolean;
  status: 'ok' | 'warn' | 'fail';
  detail?: unknown;
  fix?: string;
}

const ADAPTER_BINARY: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  hermes: 'hermes',
  openclaw: 'openclaw',
};

const LOCAL_SERVER = 'http://127.0.0.1:3210';

export function buildAgentCommand(): Command {
  const cmd = new Command('agent').description('Manage hosted agents');

  cmd
    .command('list')
    .description('List agents visible to this account')
    .option('--local', 'Only show daemon-local registrations (no cloud call)')
    .option('--json', 'Output JSON')
    .action(runAction<[{ local?: boolean }]>(async (opts) => {
      const paths = resolvePaths();
      const ui = getUI();
      if (opts.local) {
        const localOnly = readLocalAgents(paths.localDb);
        ui.result(
          () => {
            ui.header(`Local agents (${localOnly.length})`);
            ui.blank();
            if (localOnly.length === 0) {
              ui.secondary('No local hosted agents. Use `prismer agent register` to add one.');
              return;
            }
            ui.table(
              localOnly.map((a) => ({
                imUserId: a.im_user_id,
                name: a.name ?? '—',
                adapter: a.adapter_name ?? '—',
                workspace: a.workspace_id ?? '—',
                status: a.status ?? '—',
                version: String(a.version ?? '—'),
              })),
              { columns: ['imUserId', 'name', 'adapter', 'workspace', 'status', 'version'] },
            );
          },
          localOnly,
        );
        return;
      }
      const cfg = loadConfig(paths);
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      try {
        const local = readLocalAgents(paths.localDb);
        const cloudAgents = normalizeCloudAgents(await cloud.get<unknown>('/api/im/agents'));
        const localById = new Map(local.map((a) => [a.im_user_id, a]));
        const cloudById = new Map(cloudAgents.map((a) => [cloudAgentId(a), a]).filter((v): v is [string, CloudAgentLike] => Boolean(v[0])));
        const ids = new Set([...localById.keys(), ...cloudById.keys()]);
        const merged = Array.from(ids).sort().map((id) => {
          const l = localById.get(id);
          const c = cloudById.get(id);
          return {
            imUserId: id,
            name: l?.name ?? c?.displayName ?? c?.name ?? c?.username ?? null,
            adapter: l?.adapter_name ?? cloudAgentAdapter(c) ?? null,
            local: l
              ? {
                  hosted: true,
                  workspaceId: l.workspace_id,
                  status: l.status,
                  capabilities: parseJsonArray(l.capabilities),
                  version: l.version,
                  syncedAt: l.synced_at,
                  dirty: Boolean(l.dirty),
                }
              : { hosted: false },
            cloud: c ? { visible: true, agent: c } : { visible: false },
          };
        });
        ui.result(
          () => {
            ui.header(`Agents — local ${local.length} / cloud ${cloudAgents.length}`);
            ui.blank();
            if (merged.length === 0) {
              ui.secondary('No agents visible. Use `prismer agent register` to add one.');
              return;
            }
            ui.table(
              merged.map((a) => ({
                imUserId: a.imUserId,
                name: a.name ?? '—',
                adapter: a.adapter ?? '—',
                hosted: a.local.hosted ? '● local' : '·',
                cloud: a.cloud.visible ? '● cloud' : '·',
              })),
              { columns: ['imUserId', 'name', 'adapter', 'hosted', 'cloud'] },
            );
          },
          { localCount: local.length, cloudCount: cloudAgents.length, agents: merged },
        );
      } catch (err) {
        exitWithError((err as Error).message, { code: 'agent_list_failed' });
      }
    }, { code: 'agent_list_failed' }));

  cmd
    .command('register')
    .description('Register a new agent on cloud (or attach existing) and mirror locally')
    .requiredOption('--adapter <name>', 'Adapter name (hermes | claude-code | …)')
    .option('--display-name <name>', 'Human-readable display name (e.g. "Product Manager")')
    .option('--name <name>', 'Alias for --display-name (legacy)')
    .option('--username <name>', 'Cloud username (3-32 alnum/_/-). Auto-derived from display-name if omitted')
    .option('--im-user-id <id>', 'Skip cloud register; just attach to existing IMUser (advanced)')
    .option('--capabilities <list>', 'Comma-separated capability tags', '')
    .option('--agent-type <type>', 'agent type (assistant | specialist | orchestrator | tool | bot)', 'assistant')
    .option('--workspace-id <id>', 'Workspace id (defaults to cloud-resolved Personal)', '')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{
      imUserId?: string;
      name?: string;
      displayName?: string;
      username?: string;
      adapter: string;
      agentType: string;
      capabilities: string;
      workspaceId: string;
    }]>(async (opts) => {
      const paths = resolvePaths();
      const cfg = loadConfig(paths);
      const displayName = opts.displayName ?? opts.name;
      if (!displayName) exitWithError('--display-name required (or legacy --name)');
      const capsArray = opts.capabilities
        ? opts.capabilities.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      let imUserId = opts.imUserId;
      if (!imUserId) {
        const username = opts.username ?? slugifyUsername(displayName!);
        const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
        const res = await cloud.request<{ ok?: boolean; imUserId?: string; data?: { imUserId?: string }; error?: { message?: string } }>(
          'POST',
          '/api/im/register',
          {
            body: {
              type: 'agent',
              username,
              displayName,
              agentType: opts.agentType,
              capabilities: capsArray,
              metadata: { adapter: opts.adapter },
            },
          },
        );
        if (!res.ok) {
          exitWithError(`Cloud register failed (${res.status}): ${res.error?.message ?? 'unknown'}`);
        }
        // /register returns { ok: true, imUserId, ... } at top level (legacy envelope)
        const body = res.data;
        imUserId = body?.imUserId ?? body?.data?.imUserId;
        if (!imUserId) exitWithError('Cloud register returned no imUserId');
      }

      const db = openLocalDb(paths.localDb);
      try {
        db.prepare(
          `INSERT OR REPLACE INTO agents
           (im_user_id, workspace_id, name, adapter_name, capabilities, status, version, synced_at, dirty)
           VALUES (?, ?, ?, ?, ?, 'offline', 1, ?, 0)`,
        ).run(
          imUserId!,
          opts.workspaceId || '',
          displayName!,
          opts.adapter,
          JSON.stringify(capsArray),
          Date.now(),
        );
        printJson({ ok: true, imUserId, displayName, adapter: opts.adapter });
      } finally {
        db.close();
      }
    }, { code: 'agent_register_failed' }));

  function slugifyUsername(name: string): string {
    // Cloud register requires /^[a-zA-Z0-9_-]{3,32}$/.
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    if (slug.length < 3) {
      return `${slug}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
    }
    return slug;
  }

  cmd
    .command('rename <imUserId> <newName>')
    .description("Rename agent's display name (PATCH /api/im/agents/:id)")
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, string]>(async (imUserId, newName) => {
      const paths = resolvePaths();
      const cfg = loadConfig(paths);
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      const res = await cloud.request('PATCH', `/api/im/agents/${encodeURIComponent(imUserId)}`, {
        body: { displayName: newName },
      });
      if (!res.ok) exitWithError(`rename failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'agent_rename_failed' });
      // Local mirror update too (best-effort).
      const db = openLocalDb(paths.localDb);
      try {
        db.prepare('UPDATE agents SET name = ?, dirty = 0 WHERE im_user_id = ?').run(newName, imUserId);
      } finally {
        db.close();
      }
      printJson({ ok: true });
    }, { code: 'agent_rename_failed' }));

  cmd
    .command('remove <imUserId>')
    .description('Remove agent from local hosting (cloud row preserved unless --cloud)')
    .option('--cloud', 'Also delete the cloud agent row before removing local hosting')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { cloud?: boolean }]>(async (imUserId, opts) => {
      const paths = resolvePaths();
      let cloudRemoved: boolean | null = null;
      if (opts.cloud) {
        const cfg = loadConfig(paths);
        const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
        const res = await cloud.request('DELETE', `/api/im/agents/${encodeURIComponent(imUserId)}`);
        if (!res.ok) exitWithError(`cloud remove failed (${res.status}): ${res.error?.message ?? 'unknown'}`, { code: res.error?.code ?? 'agent_remove_failed' });
        cloudRemoved = true;
      }
      const db = openLocalDb(paths.localDb);
      try {
        const r = db.prepare('DELETE FROM agents WHERE im_user_id = ?').run(imUserId);
        printJson({ ok: true, cloudRemoved, localRemoved: r.changes });
      } finally {
        db.close();
      }
    }, { code: 'agent_remove_failed' }));

  cmd
    .command('doctor [target]')
    .description('Diagnose agent lifecycle wiring (target is imUserId or adapter name)')
    .option('--json', 'Print JSON (default)')
    .action(runAction<[string | undefined]>(async (target) => {
      const paths = resolvePaths();
      let cfg: ReturnType<typeof loadConfig> | null = null;
      let configError: string | null = null;
      try {
        cfg = loadConfig(paths);
      } catch (err) {
        configError = (err as Error).message;
      }

      const localAgents = readLocalAgents(paths.localDb);
      const localProfiles = readLocalProfiles(paths.localDb);
      const localMatch = resolveLocalMatch(localAgents, target);
      const adapterName = localMatch?.adapter_name ?? (target && ADAPTER_BINARY[target] ? target : target ?? '');
      const imUserId = localMatch?.im_user_id ?? (target && !ADAPTER_BINARY[target] ? target : undefined);

      const cloud = cfg ? new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key }) : null;
      const [cloudAgentsResult, cloudProfilesResult, localServerResult] = await Promise.all([
        cloud ? fetchCloudAgents(cloud) : Promise.resolve({ ok: false as const, error: configError ?? 'config missing' }),
        cloud && imUserId ? fetchCloudProfiles(cloud, imUserId) : Promise.resolve({ ok: true as const, profiles: [] as unknown[] }),
        fetchLocalServer(),
      ]);

      const cloudAgents = cloudAgentsResult.ok ? cloudAgentsResult.agents : [];
      const cloudMatch = resolveCloudMatch(cloudAgents, { target, imUserId, adapterName });
      const effectiveImUserId = imUserId ?? (cloudMatch ? cloudAgentId(cloudMatch) : undefined);
      const effectiveAdapter = adapterName || localMatch?.adapter_name || cloudAgentAdapter(cloudMatch) || '';
      const binaryName = ADAPTER_BINARY[effectiveAdapter] ?? effectiveAdapter;
      const binaryPath = binaryName ? whichBinary(binaryName) : null;
      const adapterRecord = cfg?.adapters?.[effectiveAdapter] ?? null;
      const localHostedByServer = effectiveImUserId
        ? localServerResult.agents.some((a) => a.imUserId === effectiveImUserId)
        : effectiveAdapter
          ? localServerResult.agents.some((a) => a.adapterName === effectiveAdapter)
          : false;
      const localProfileMatches = effectiveImUserId
        ? localProfiles.filter((p) => p.agent_im_user_id === effectiveImUserId && !p.deleted_at)
        : [];
      const cloudProfileCount = cloudProfilesResult.ok ? cloudProfilesResult.profiles.length : 0;

      const checks: Record<string, DoctorCheck> = {
        binary: binaryName
          ? binaryPath
            ? { ok: true, status: 'ok', detail: { binary: binaryName, path: binaryPath } }
            : {
                ok: false,
                status: 'fail',
                detail: { binary: binaryName },
                fix: `Install or expose the adapter binary on PATH. Try: prismer adapter install ${effectiveAdapter || '<adapter>'}`,
              }
          : {
              ok: false,
              status: 'fail',
              detail: { target: target ?? null },
              fix: 'Pass an imUserId already registered locally, or pass a known adapter name.',
            },
        adapterHealth: adapterRecord || binaryPath
          ? { ok: true, status: 'ok', detail: { adapter: effectiveAdapter || null, recorded: adapterRecord, binaryPath } }
          : {
              ok: false,
              status: 'warn',
              detail: { adapter: effectiveAdapter || null, recorded: null },
              fix: `Run \`prismer adapter install ${effectiveAdapter || '<adapter>'}\` or add [adapters.${effectiveAdapter || '<adapter>'}] to config.toml.`,
            },
        localHosting: localMatch
          ? {
              ok: localHostedByServer || !localServerResult.ok,
              status: localHostedByServer ? 'ok' : localServerResult.ok ? 'warn' : 'ok',
              detail: { db: localMatch, daemonHosting: localServerResult.ok ? localHostedByServer : null },
              fix: localHostedByServer || !localServerResult.ok ? undefined : 'Restart the daemon so it reloads the local agents table.',
            }
          : {
              ok: false,
              status: 'fail',
              detail: { target: target ?? null },
              fix: 'Run `prismer agent register --adapter <name> --display-name <name>` or attach an existing IM user with --im-user-id.',
            },
        cloudVisibility: cloudMatch
          ? { ok: true, status: 'ok', detail: cloudMatch }
          : {
              ok: false,
              status: cloudAgentsResult.ok ? 'fail' : 'warn',
              detail: cloudAgentsResult.ok ? { visibleAgents: cloudAgents.length } : { error: cloudAgentsResult.error },
              fix: cfg
                ? 'Check API key/account visibility, or run `prismer agent register` to create the cloud IM agent.'
                : 'Run `prismer setup` to create config.toml before checking cloud visibility.',
            },
        profileExistence:
          localProfileMatches.length > 0 || cloudProfileCount > 0
            ? {
                ok: true,
                status: 'ok',
                detail: { localCount: localProfileMatches.length, cloudCount: cloudProfileCount, localProfiles: localProfileMatches },
              }
            : {
                ok: false,
                status: 'warn',
                detail: cloudProfilesResult.ok ? { localCount: 0, cloudCount: 0 } : { localCount: 0, error: cloudProfilesResult.error },
                fix: effectiveImUserId
                  ? `Create one with \`prismer profile create --agent ${effectiveImUserId} --name <name> --adapter ${effectiveAdapter || '<adapter>'}\`.`
                  : 'Register or select an agent first, then create a profile for it.',
              },
        daemonLocalServerHealth: localServerResult.ok
          ? {
              ok: true,
              status: 'ok',
              detail: { health: localServerResult.health, agents: localServerResult.agents },
            }
          : {
              ok: false,
              status: 'warn',
              detail: { error: localServerResult.error },
              fix: 'Start the daemon with `prismer daemon start` and keep the local server enabled on port 3210.',
            },
      };

      printJson({
        ok: Object.values(checks).every((c) => c.ok),
        target: target ?? null,
        resolved: { imUserId: effectiveImUserId ?? null, adapter: effectiveAdapter || null },
        checks,
      });
    }, { code: 'agent_doctor_failed' }));

  cmd
    .command('install-skill <slugOrId>')
    .description('Install a skill to an agent (alias for `prismer skill install --agent`)')
    .requiredOption('--agent <imUserId>', 'Target agent IMUser.id')
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { agent: string; workspaceId?: string; json?: boolean }]>(async (slugOrId, opts) => {
      const cfg = loadConfig(resolvePaths());
      const cloud = new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
      const res = await cloud.request<{ ok?: boolean; data?: unknown; error?: { message?: string; code?: string } }>(
        'POST',
        `/api/im/agents/${encodeURIComponent(opts.agent)}/skills`,
        { body: { skillId: slugOrId, workspaceId: opts.workspaceId } },
      );
      if (!res.ok || res.data?.ok === false) {
        const message = res.error?.message ?? res.data?.error?.message ?? 'request failed';
        exitWithError(`install-skill failed (${res.status === 0 ? 'network error' : `HTTP ${res.status}`}): ${message}`, {
          code: res.error?.code ?? res.data?.error?.code ?? 'agent_install_skill_failed',
        });
      }
      const data = res.data && typeof res.data === 'object' && 'data' in res.data ? res.data.data : res.data;
      if (opts.json) {
        printJson(data);
        return;
      }
      getUI().ok('Skill install requested', `agent=${opts.agent} skill=${slugOrId}`);
    }, { code: 'agent_install_skill_failed' }));

  cmd
    .command('snapshot <imUserId>')
    .description('Create an agent-level snapshot')
    .option('--include-memory', 'Include memory dump reference')
    .option('--label <label>', 'Snapshot label')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { includeMemory?: boolean; label?: string; json?: boolean }]>(async (imUserId, opts) => {
      const cloud = makeCloudClient();
      const data = await requestEnvelope(cloud, 'POST', `/api/im/agents/${encodeURIComponent(imUserId)}/snapshot`, {
        includeMemory: Boolean(opts.includeMemory),
        label: opts.label,
      }, 'agent_snapshot_failed');
      if (opts.json) {
        printJson(data);
        return;
      }
      const rec = data as Record<string, unknown>;
      getUI().ok('Snapshot created', String(rec.id ?? '<unknown>'));
      getUI().line(`agent=${String(rec.agentImUserId ?? imUserId)} memory=${rec.includeMemory ? 'included' : 'stripped'}`);
    }, { code: 'agent_snapshot_failed' }));

  cmd
    .command('publish <imUserId>')
    .description('Publish an agent as an Agent Pack')
    .requiredOption('--slug <slug>', 'Agent Pack slug')
    .option('--version <version>', 'Package version', '1.0.0')
    .option('--license <license>', 'Package license', 'proprietary')
    .option('--title <title>', 'Display title metadata')
    .option('--description <description>', 'Description metadata')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { slug: string; version?: string; license?: string; title?: string; description?: string; json?: boolean }]>(async (imUserId, opts) => {
      const cloud = makeCloudClient();
      const data = await requestEnvelope(cloud, 'POST', `/api/im/agents/${encodeURIComponent(imUserId)}/publish`, {
        slug: opts.slug,
        version: opts.version,
        license: opts.license,
        metadata: {
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        },
        stripMemory: true,
      }, 'agent_publish_failed');
      if (opts.json) {
        printJson(data);
        return;
      }
      const rec = data as Record<string, unknown>;
      getUI().ok('Agent Pack published', `${String(rec.slug ?? opts.slug)}@${String(rec.version ?? opts.version ?? '1.0.0')}`);
      getUI().line(`package=${String(rec.id ?? '<unknown>')}`);
    }, { code: 'agent_publish_failed' }));

  cmd
    .command('fork <packIdOrSlug>')
    .description('Fork an Agent Pack into a workspace')
    .requiredOption('--workspace-id <id>', 'Target workspace id')
    .option('--display-name <name>', 'New agent display name')
    .option('--json', 'Output JSON')
    .action(runAction<[string, { workspaceId: string; displayName?: string; json?: boolean }]>(async (packIdOrSlug, opts) => {
      const cloud = makeCloudClient();
      const data = await requestEnvelope(cloud, 'POST', `/api/im/agent-packs/${encodeURIComponent(packIdOrSlug)}/fork`, {
        targetWorkspaceId: opts.workspaceId,
        displayName: opts.displayName,
      }, 'agent_fork_failed');
      if (opts.json) {
        printJson(data);
        return;
      }
      const rec = data as Record<string, unknown>;
      getUI().ok('Agent Pack forked', `newAgent=${String(rec.newImUserId ?? '<unknown>')}`);
      getUI().line(`did=${String(rec.newDid ?? 'not issued')}`);
    }, { code: 'agent_fork_failed' }));

  // ── skill sub-command tree (release201/13 §3.4) ─────────────────────
  //
  // `prismer agent skill list|install|uninstall|config` — per-agent skill
  // ops. Mirrors @prismer/sdk client.agents.skills.* methods. The `config`
  // subcommand is the 13-P2 PATCH endpoint we just landed.
  const skillCmd = new Command('skill').description('Manage skills installed on an agent');

  skillCmd
    .command('list <agentId>')
    .description('List installed skills for an agent')
    .option('--workspace-id <id>', 'Filter to a workspace')
    .option('--include-inactive', 'Include disabled/uninstalled rows', false)
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { workspaceId?: string; includeInactive?: boolean }]>(async (agentId, opts) => {
      const cloud = makeCloudClient();
      const params = new URLSearchParams();
      if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
      if (opts.includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      const data = await requestEnvelope(
        cloud,
        'GET',
        `/api/im/agents/${encodeURIComponent(agentId)}/skills${qs ? `?${qs}` : ''}`,
        undefined,
        'agent_skill_list_failed',
      );
      printJson(data);
    }, { code: 'agent_skill_list_failed' }));

  skillCmd
    .command('config <agentId> <skillId>')
    .description("Update an agent's per-skill config (PATCH /agents/:id/skills/:id, release201/13 §3.4)")
    .option('--config <json>', 'Config blob as inline JSON')
    .option('--config-file <path>', 'Read config blob from a JSON file')
    .option('--workspace-id <id>', 'Workspace scope hint (optional)')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, string, { config?: string; configFile?: string; workspaceId?: string }]>(
        async (agentId, skillId, opts) => {
          let parsed: Record<string, unknown> | null = null;
          if (opts.configFile) {
            const { readFileSync } = await import('node:fs');
            const raw = readFileSync(opts.configFile, 'utf8');
            try {
              parsed = JSON.parse(raw);
            } catch (err) {
              exitWithError(`--config-file is not valid JSON: ${(err as Error).message}`, {
                code: 'agent_skill_config_invalid_json',
              });
            }
          } else if (opts.config) {
            try {
              parsed = JSON.parse(opts.config);
            } catch (err) {
              exitWithError(`--config is not valid JSON: ${(err as Error).message}`, {
                code: 'agent_skill_config_invalid_json',
              });
            }
          } else {
            exitWithError('--config or --config-file is required', {
              code: 'agent_skill_config_missing',
            });
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            exitWithError('config must be a JSON object', { code: 'agent_skill_config_invalid_shape' });
            return;
          }
          const cloud = makeCloudClient();
          const data = await requestEnvelope(
            cloud,
            'PATCH',
            `/api/im/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
            { config: parsed, workspaceId: opts.workspaceId },
            'agent_skill_config_failed',
          );
          printJson({ ok: true, data });
        },
        { code: 'agent_skill_config_failed' },
      ),
    );

  cmd.addCommand(skillCmd);

  return cmd;
}

function makeCloudClient(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

async function requestEnvelope(
  cloud: CloudClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  code: string,
): Promise<unknown> {
  const res = await cloud.request<{ ok?: boolean; data?: unknown; error?: { message?: string; code?: string } }>(
    method,
    path,
    body === undefined ? undefined : { body },
  );
  if (!res.ok || res.data?.ok === false) {
    const message = res.error?.message ?? res.data?.error?.message ?? 'request failed';
    exitWithError(`${path} failed (${res.status === 0 ? 'network error' : `HTTP ${res.status}`}): ${message}`, {
      code: res.error?.code ?? res.data?.error?.code ?? code,
    });
  }
  return res.data && typeof res.data === 'object' && 'data' in res.data ? res.data.data : res.data;
}

function readLocalAgents(localDb: string): LocalAgentRow[] {
  const db = openLocalDb(localDb);
  try {
    return db.prepare('SELECT * FROM agents ORDER BY name ASC, im_user_id ASC').all() as LocalAgentRow[];
  } finally {
    db.close();
  }
}

function readLocalProfiles(localDb: string): LocalProfileRow[] {
  const db = openLocalDb(localDb);
  try {
    return db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC, id ASC').all() as LocalProfileRow[];
  } finally {
    db.close();
  }
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeCloudAgents(data: unknown): CloudAgentLike[] {
  if (Array.isArray(data)) return data as CloudAgentLike[];
  if (data && typeof data === 'object') {
    const obj = data as { agents?: unknown; data?: unknown };
    if (Array.isArray(obj.agents)) return obj.agents as CloudAgentLike[];
    if (Array.isArray(obj.data)) return obj.data as CloudAgentLike[];
  }
  return [];
}

function cloudAgentId(agent?: CloudAgentLike): string | undefined {
  return agent?.imUserId ?? agent?.im_user_id ?? agent?.id ?? agent?.userId;
}

function cloudAgentAdapter(agent?: CloudAgentLike): string | undefined {
  return agent?.adapterName ?? agent?.adapter_name ?? agent?.metadata?.adapter ?? agent?.metadata?.adapterName;
}

function resolveLocalMatch(rows: LocalAgentRow[], target?: string): LocalAgentRow | undefined {
  if (!target) return rows[0];
  return rows.find((a) => a.im_user_id === target) ?? rows.find((a) => a.adapter_name === target);
}

function resolveCloudMatch(
  rows: CloudAgentLike[],
  opts: { target?: string; imUserId?: string; adapterName?: string },
): CloudAgentLike | undefined {
  if (opts.imUserId) {
    const byId = rows.find((a) => cloudAgentId(a) === opts.imUserId);
    if (byId) return byId;
  }
  if (opts.target) {
    const byTarget = rows.find((a) => cloudAgentId(a) === opts.target);
    if (byTarget) return byTarget;
  }
  if (opts.adapterName) return rows.find((a) => cloudAgentAdapter(a) === opts.adapterName);
  return rows[0];
}

async function fetchCloudAgents(cloud: CloudClient): Promise<{ ok: true; agents: CloudAgentLike[] } | { ok: false; error: string }> {
  try {
    return { ok: true, agents: normalizeCloudAgents(await cloud.get<unknown>('/api/im/agents')) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function fetchCloudProfiles(cloud: CloudClient, imUserId: string): Promise<{ ok: true; profiles: unknown[] } | { ok: false; error: string }> {
  try {
    const data = await cloud.get<unknown>(`/api/im/agent_profiles?agentId=${encodeURIComponent(imUserId)}`);
    if (Array.isArray(data)) return { ok: true, profiles: data };
    if (data && typeof data === 'object') {
      const obj = data as { profiles?: unknown; data?: unknown };
      if (Array.isArray(obj.profiles)) return { ok: true, profiles: obj.profiles };
      if (Array.isArray(obj.data)) return { ok: true, profiles: obj.data };
    }
    return { ok: true, profiles: [] };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function fetchLocalServer(): Promise<
  | { ok: true; health: unknown; agents: Array<{ imUserId: string; name: string; adapterName: string }> }
  | { ok: false; error: string; agents: [] }
> {
  const paths = resolvePaths();
  const pid = readPidFile(paths);
  if (!pid || !pidAlive(pid)) return { ok: false, error: 'daemon process is not running', agents: [] };
  try {
    const [healthRes, agentsRes] = await Promise.all([
      fetch(`${LOCAL_SERVER}/healthz`, { signal: AbortSignal.timeout(1_000) }),
      fetch(`${LOCAL_SERVER}/agents`, { signal: AbortSignal.timeout(1_000) }),
    ]);
    if (!healthRes.ok) return { ok: false, error: `/healthz returned HTTP ${healthRes.status}`, agents: [] };
    const health = await healthRes.json();
    const agentsBody = agentsRes.ok ? await agentsRes.json() : { agents: [] };
    const agents = Array.isArray((agentsBody as { agents?: unknown }).agents)
      ? ((agentsBody as { agents: Array<{ imUserId: string; name: string; adapterName: string }> }).agents)
      : [];
    return { ok: true, health, agents };
  } catch (err) {
    return { ok: false, error: (err as Error).message, agents: [] };
  }
}

function whichBinary(bin: string): string | null {
  const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}
