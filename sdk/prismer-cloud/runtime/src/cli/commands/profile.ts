// `prismer profile (list|create|edit|remove + --from-template + templates)` — AgentProfile.
//
// Profiles are the cloud's IMAgentProfile table. CLI here POSTs / PATCHes via
// /api/im/agent_profiles; the daemon mirrors locally on host.acked sync.

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { getRoleTemplate, listRoleTemplates } from '../../templates/index.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

export function buildProfileCommand(): Command {
  const cmd = new Command('profile').description('Manage AgentProfile (per-agent adapter config)');

  cmd
    .command('templates')
    .description('List built-in role templates (PM / Engineer / CEO …)')
    .option('--json', 'Output JSON (default)')
    .action(() => {
      printJson(listRoleTemplates());
    });

  cmd
    .command('list')
    .description('List profiles for an agent')
    .requiredOption('--agent <imUserId>', 'IMUser.id of the agent')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ agent: string }]>(async (opts) => {
      const cloud = mkCloud();
      const data = await cloud.get(`/api/im/agent_profiles?agentId=${encodeURIComponent(opts.agent)}`);
      printJson(data);
    }, { code: 'profile_list_failed' }));

  cmd
    .command('create')
    .description('Create an AgentProfile')
    .requiredOption('--agent <imUserId>', 'Agent IMUser.id this profile belongs to')
    .requiredOption('--name <name>', 'Profile display name (unique within workspace+agent)')
    .option('--adapter <name>', 'Adapter name (defaults to template.applicableAdapters[0] or hermes)')
    .option('--config <jsonOrPath>', 'Inline JSON or @path/to/file containing adapter config')
    .option('--from-template <name>', 'Use a built-in role template (run `prismer profile templates` to list)')
    .option('--model <name>', 'Model id (overrides template default; fetched from cloud if omitted)')
    .option('--workspace-id <id>', 'Workspace id (cloud derives Personal default if omitted)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ agent: string; name: string; adapter?: string; config?: string; fromTemplate?: string; model?: string; workspaceId?: string }]>(async (opts) => {
      let configObj: Record<string, unknown> = {};
      let adapterName = opts.adapter ?? 'hermes';
      if (opts.fromTemplate) {
        const tpl = getRoleTemplate(opts.fromTemplate);
        if (!tpl) exitWithError(`Unknown template: ${opts.fromTemplate}. Run \`prismer profile templates\`.`, { code: 'unknown_template' });
        configObj = { ...(tpl!.configSchema as Record<string, unknown>) };
        if (!opts.adapter && tpl!.applicableAdapters.length > 0) adapterName = tpl!.applicableAdapters[0]!;
      }
      if (opts.config) {
        const inline = readJsonArg(opts.config);
        configObj = { ...configObj, ...inline };
      }
      // --model flag: override configObj.model even if template or --config set it.
      // If omitted, keep whatever template/--config set (or undefined).
      if (opts.model) {
        configObj.model = opts.model;
      }
      const cloud = mkCloud();
      const wsId = opts.workspaceId ?? (await resolveDefaultWorkspaceId(cloud));
      const res = await cloud.request('POST', '/api/im/agent_profiles', {
        body: {
          agentImUserId: opts.agent,
          adapterName,
          name: opts.name,
          config: configObj,
          workspaceId: wsId,
        },
      });
      if (!res.ok) exitWithError(`create failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'profile_create_failed' });
      printJson(res.data ?? { ok: true });
    }, { code: 'profile_create_failed' }));

  cmd
    .command('edit <profileId>')
    .description('Edit a profile in $EDITOR (config field only)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (profileId) => {
      const cloud = mkCloud();
      const profile = await cloud.get<{ config: Record<string, unknown>; version: number }>(
        `/api/im/agent_profiles/${encodeURIComponent(profileId)}`,
      );
      const tmpFile = join(tmpdir(), `prismer-profile-${profileId}.json`);
      writeFileSync(tmpFile, JSON.stringify(profile.config, null, 2), 'utf8');
      const editor = process.env.EDITOR || 'vi';
      const ed = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
      if (ed.status !== 0) exitWithError(`editor exited ${ed.status}`, { code: 'editor_failed' });
      const newConfig = JSON.parse(readFileSync(tmpFile, 'utf8'));
      const res = await cloud.request('PATCH', `/api/im/agent_profiles/${encodeURIComponent(profileId)}`, {
        body: { config: newConfig, version: profile.version },
      });
      if (!res.ok) exitWithError(`update failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'profile_update_failed' });
      printJson({ ok: true });
    }, { code: 'profile_edit_failed' }));

  cmd
    .command('remove <profileId>')
    .description('Soft-delete a profile')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (profileId) => {
      const cloud = mkCloud();
      const res = await cloud.request('DELETE', `/api/im/agent_profiles/${encodeURIComponent(profileId)}`);
      if (!res.ok) exitWithError(`delete failed (${res.status}): ${res.error?.message ?? 'request failed'}`, { code: res.error?.code ?? 'profile_delete_failed' });
      printJson({ ok: true });
    }, { code: 'profile_remove_failed' }));

  return cmd;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function readJsonArg(arg: string): Record<string, unknown> {
  if (arg.startsWith('@')) {
    const path = arg.slice(1);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  return JSON.parse(arg);
}

async function resolveDefaultWorkspaceId(cloud: CloudClient): Promise<string> {
  const list = await cloud.get<Array<{ id: string; isDefault?: boolean }>>('/api/im/workspaces');
  const def = list.find((w) => w.isDefault) ?? list[0];
  if (!def) throw new Error('No workspace found for current account');
  return def.id;
}
