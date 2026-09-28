// `prismer skill ...` — built-in skill install/sync/ack lifecycle helpers.
//
// Covers catalog inspection, install/uninstall, bundle create/validate/package,
// a local manual sync that reuses the daemon dispatch-time SkillSync path, and
// (product204/16 §2.2) the explicit `publish` action that flips a skill from
// the private domain (publishScope='workspace', the create default) to the
// public Marketplace ('marketplace').

import { Command } from 'commander';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CloudClient } from '../../auth.js';
import type { AgentProfile } from '../../adapters/contract.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { openLocalDb } from '../../sync/store.js';
import {
  BundleError,
  buildSkillCreateBody,
  matchAcceptanceCriteria,
  packageBundle,
  readBundle,
  validateBundle,
  type AcceptanceCriterion,
  type ReadBundleResult,
} from '../../bundle/index.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';
import { registerLifecycleCommands, SKILL_LIFECYCLE } from './lifecycle.js';
import { markCloudOwnedCompatibilityCommand } from '../shared/compatibility-warning.js';

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

  // ── config (inspect declared config schema) — product204/29 agent loop ──────
  // "检查 skill 配置": surface the config keys a skill DECLARES (from its
  // SKILL.md frontmatter `config:`, persisted as im_skills.metadata.configSchema).
  // This is what an agent needs BEFORE binding values into a role's `skillConfig`
  // — it shows the keys, types, defaults, and which binding levels each accepts
  // (global/role/agent). Read-only; no resolution (the 3-tier agent→role→global
  // resolution is a runtime concern, surfaced at dispatch, not via this CLI).
  interface ConfigDecl {
    key: string;
    type?: string;
    required?: boolean;
    default?: string | null;
    bindable?: string[];
    description?: string;
    values?: string[];
  }
  cmd
    .command('config <slugOrId>')
    .description('Show the config keys a skill declares (metadata.configSchema) — what to fill into a role skillConfig. Read-only.')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const data = await cloud.get<SkillInfo>(`/api/im/skills/${encodeURIComponent(slugOrId)}`);
        const meta = data.metadata as Record<string, unknown> | undefined;
        let schema = Array.isArray(meta?.configSchema) ? (meta!.configSchema as ConfigDecl[]) : [];
        // Tolerate metadata returned as a raw JSON string.
        if (schema.length === 0 && typeof data.metadata === 'string') {
          try {
            const parsed = JSON.parse(data.metadata as string);
            schema = Array.isArray(parsed?.configSchema) ? parsed.configSchema : [];
          } catch {
            /* none */
          }
        }
        if (opts.json) {
          printJson({ slug: slugOrId, configSchema: schema });
          return;
        }
        const ui = getUI();
        if (schema.length === 0) {
          ui.ok('Skill declares no config keys', String(slugOrId));
          ui.secondary('(no `config:` block in SKILL.md → no skillConfig values to bind for this skill)');
          return;
        }
        ui.header(`Skill config · ${slugOrId} (${schema.length} key${schema.length === 1 ? '' : 's'})`);
        ui.table(
          schema.map((d) => ({
            key: d.key,
            type: d.type ?? '—',
            required: d.default ? 'no (has default)' : d.required ? 'yes' : 'no',
            default: d.default ?? '—',
            bindable: (d.bindable ?? []).join('/') || '—',
            description: (d.description ?? '').slice(0, 60),
          })),
          { columns: ['key', 'type', 'required', 'default', 'bindable', 'description'] },
        );
        ui.secondary('bind into a role via: cloud role edit <slug> --field skillConfig=\'{"<skillSlug>":{"<KEY>":"<value>"}}\'');
      }, { code: 'skill_config_failed' }),
    );

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
    .command('create <bundleDir>')
    .description(
      'Ingest a SS-01 skill bundle directory into the catalog (POST /api/im/skills). ' +
        'Lands PRIVATE + active + installable, NO human review. ' +
        'For the review-gated path (not installable until promoted) use `cloud skill draft create`.',
    )
    .option('--install', 'Install the new skill onto an agent after create')
    .option('--agent <imUserId>', 'Target agent for --install (default: authenticated agent)')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { install?: boolean; agent?: string; json?: boolean }]>(async (bundleDir, opts) => {
        const bundle = readSkillBundle(bundleDir);
        const cloud = mkCloud();
        const created = await cloud.request<{ ok?: boolean; data?: SkillInfo; error?: string }>(
          'POST',
          '/api/im/skills',
          { body: bundle.createBody },
        );
        if (created.status === 409) {
          exitWithError(`slug "${bundle.slug}" already exists (409). Use update or a new name.`, {
            code: 'skill_slug_conflict',
          });
        }
        if (created.status !== 201 || created.data?.ok === false) {
          const msg = created.error?.message ?? created.data?.error ?? 'request failed';
          exitWithError(`create failed (${describeStatus(created.status)}): ${msg}`, {
            code: 'skill_create_failed',
          });
        }
        const skill = created.data?.data as SkillInfo;
        const result: Record<string, unknown> = {
          id: skill?.id,
          slug: skill?.slug,
          rev: bundle.revision,
          files: bundle.fileCount,
          installed: false as boolean | string,
        };

        if (opts.install) {
          const path = opts.agent
            ? `/api/im/agents/${encodeURIComponent(opts.agent)}/skills`
            : `/api/im/skills/${encodeURIComponent(skill.slug ?? bundle.slug)}/install`;
          const body = opts.agent ? { skillId: skill.slug ?? bundle.slug } : {};
          const inst = await cloud.request<{ ok?: boolean; error?: string }>('POST', path, { body });
          if (inst.status >= 200 && inst.status < 300 && inst.data?.ok !== false) {
            result.installed = opts.agent ?? true;
          } else {
            result.installError = `${describeStatus(inst.status)}: ${inst.error?.message ?? inst.data?.error ?? 'install failed'}`;
          }
        }

        if (opts.json) {
          // create succeeded but the follow-on install failed → non-zero exit
          // (exitWithError emits the {ok:false,error} json payload with details).
          if (result.installError) {
            exitWithError(`skill created but install failed: ${String(result.installError)}`, {
              code: 'skill_install_failed',
              details: result,
            });
          }
          printJson(result);
          return;
        }
        const ui = getUI();
        ui.ok('Skill ingested', String(result.slug));
        ui.line(`id=${result.id}  rev=${result.rev}  files=${result.files}  installed=${String(result.installed)}`);
        if (result.installError) ui.secondary(`install error: ${String(result.installError)}`);
        ui.secondary(`verify: cloud skill show ${result.slug} --content`);
        // A create that was asked to --install but couldn't must not exit 0.
        if (result.installError) {
          exitWithError(`skill created but install failed: ${String(result.installError)}`, {
            code: 'skill_install_failed',
          });
        }
      }, { code: 'skill_create_failed' }),
    );

  // ── publish (product204/16 §2.2(c)) — explicit workspace→marketplace flip ───
  // `skill create` lands in the PRIVATE domain (publishScope='workspace' — not
  // visible in marketplace search). Going public is this explicit owner action:
  // POST /api/im/skills/:id/publish-template { scope:'marketplace' }.
  cmd
    .command('publish <slugOrId>')
    .description(
      'Publish a skill to the public Marketplace (flips publishScope workspace→marketplace; owner-only). License required — pass --license if the skill has none.',
    )
    .option('--license <spdx>', 'License to record at publish time (e.g. MIT)')
    .option('--changelog <text>', 'Changelog note for this publish')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { license?: string; changelog?: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        // publish-template addresses skills by id — resolve slug → id first.
        const detail = await cloud.get<SkillInfo>(`/api/im/skills/${encodeURIComponent(slugOrId)}`);
        const skillId = detail?.id;
        if (!skillId) {
          exitWithError(`skill not found: ${slugOrId}`, { code: 'skill_not_found' });
          return;
        }
        const res = await cloud.request<{
          ok?: boolean;
          data?: {
            skillId?: string;
            publishScope?: string;
            publishedAt?: string;
            // product204/16 §2.1 — when an AGENT publishes, the server defers to a
            // human approval instead of flipping. HTTP 202 + { pending, approval }.
            pending?: boolean;
            approval?: { id?: string };
          };
          error?: string;
        }>('POST', `/api/im/skills/${encodeURIComponent(skillId)}/publish-template`, {
          body: {
            scope: 'marketplace',
            ...(opts.license ? { license: opts.license } : {}),
            ...(opts.changelog ? { changelog: opts.changelog } : {}),
            includeBoilerplateTask: false,
          },
        });
        if (res.status < 200 || res.status >= 300 || res.data?.ok === false) {
          const msg = res.error?.message ?? res.data?.error ?? 'request failed';
          exitWithError(`publish failed (${describeStatus(res.status)}): ${msg}`, { code: 'skill_publish_failed' });
        }
        // product204/16 §2.1 — agent publish is NOT done; it awaits the Team Manager's
        // approval in their 待审区. Report that, don't claim "published".
        if (res.status === 202 || res.data?.data?.pending) {
          if (opts.json) {
            printJson(res.data?.data ?? { pending: true });
            return;
          }
          const ui = getUI();
          ui.ok('Publish requested — awaiting human approval', String(detail.slug ?? slugOrId));
          ui.secondary(`the workspace owner must approve it in their 待审区 (approval ${res.data?.data?.approval?.id ?? '?'}) before it goes live`);
          return;
        }
        if (opts.json) {
          printJson(res.data?.data ?? { skillId, publishScope: 'marketplace' });
          return;
        }
        const ui = getUI();
        ui.ok('Skill published to Marketplace', String(detail.slug ?? slugOrId));
        ui.secondary(`verify: cloud skill show ${String(detail.slug ?? slugOrId)}`);
      }, { code: 'skill_publish_failed' }),
    );

  // ── ② validate (dry-run, NO network) — doc 16 §5.2 ──────────────────────────
  cmd
    .command('validate <bundleDir>')
    .description('Dry-run validate a SS-01 skill bundle (frontmatter/slug/manifest). No network.')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (bundleDir, opts) => {
        const bundle = readBundleOrExit(bundleDir);
        const v = validateBundle(bundle);
        if (opts.json) {
          printJson({ ok: v.ok, slug: bundle.frontmatter.name ?? null, files: bundle.files.length, errors: v.errors, warnings: v.warnings });
          if (!v.ok) process.exit(1);
          return;
        }
        const ui = getUI();
        if (v.ok) {
          ui.ok('Skill bundle valid', `${bundle.files.length} file(s)`);
        } else {
          ui.fail('Skill bundle invalid', `${v.errors.length} error(s)`);
        }
        for (const e of v.errors) ui.line(`  ✗ ${e}`);
        for (const w of v.warnings) ui.secondary(`! ${w}`);
        if (!v.ok) process.exit(1);
      }, { code: 'skill_validate_failed' }),
    );

  // ── ④ package (tarball + merkle, local only) — doc 16 §5.2 ──────────────────
  cmd
    .command('package <bundleDir>')
    .description('Package a SS-01 skill bundle into a .tar.gz + print merkle. Local only, no network.')
    .option('-o, --out <file>', 'Output tarball path (default: <slug>.tgz)')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { out?: string; json?: boolean }]>(async (bundleDir, opts) => {
        const bundle = readBundleOrExit(bundleDir);
        const v = validateBundle(bundle);
        if (!v.ok) {
          exitWithError(`bundle invalid (run \`cloud skill validate\`): ${v.errors.join('; ')}`, {
            code: 'skill_package_invalid',
          });
        }
        const slug = typeof bundle.frontmatter.name === 'string' ? bundle.frontmatter.name : basename(bundleDir);
        const out = opts.out ?? `${slug}.tgz`;
        const pkg = packageBundle(bundle);
        try {
          writeFileSync(out, pkg.bytes);
        } catch (err) {
          exitWithError(`could not write ${out}: ${(err as Error).message}`, { code: 'skill_package_write_failed' });
        }
        if (opts.json) {
          printJson({ slug, out, rev: pkg.revision, files: pkg.fileCount, bytes: pkg.bytes.byteLength });
          return;
        }
        const ui = getUI();
        ui.ok('Skill packaged', out);
        ui.line(`slug=${slug}  rev=${pkg.revision}  files=${pkg.fileCount}  bytes=${pkg.bytes.byteLength}`);
      }, { code: 'skill_package_failed' }),
    );

  // ── ③ test (real dispatch + acceptanceCriteria) — doc 16 §5.2 / §9 dec3 ──────
  cmd
    .command('test <bundleDir>')
    .description('Dispatch skill.json sampleTasks[] to an agent and score acceptanceCriteria[]')
    .requiredOption('--agent <imUserId>', 'Target agent IMUser.id to run the sample tasks')
    .option('--timeout-ms <ms>', 'Per-task dispatch timeout', (v) => Number.parseInt(v, 10))
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { agent: string; timeoutMs?: number; json?: boolean }]>(async (bundleDir, opts) => {
        const bundle = readBundleOrExit(bundleDir);
        const spec = readSkillTestSpec(bundle);
        if (!spec || spec.sampleTasks.length === 0) {
          // doc 16 §5.2: "if absent, skip with clear msg" — not a failure.
          const msg = 'no skill.json sampleTasks[] found — nothing to test (add sampleTasks + acceptanceCriteria to skill.json)';
          if (opts.json) {
            printJson({ skipped: true, reason: msg });
            return;
          }
          getUI().warn('Skill test skipped', msg);
          return;
        }

        const cloud = mkCloud();
        const taskResults: SkillTestTaskResult[] = [];
        for (let i = 0; i < spec.sampleTasks.length; i++) {
          const task = spec.sampleTasks[i]!;
          const output = await dispatchSampleTask(cloud, opts.agent, task.prompt, opts.timeoutMs);
          const matched = matchAcceptanceCriteria(task.acceptanceCriteria, output.text);
          taskResults.push({
            index: i,
            prompt: task.prompt,
            taskStatus: output.status,
            output: output.text,
            results: matched.results,
            ok: output.status === 'completed' && matched.ok,
          });
        }

        const overallOk = taskResults.every((t) => t.ok);
        if (opts.json) {
          printJson({ ok: overallOk, agent: opts.agent, tasks: taskResults });
          if (!overallOk) process.exit(1);
          return;
        }
        printSkillTestReport(taskResults, overallOk);
        if (!overallOk) process.exit(1);
      }, { code: 'skill_test_failed' }),
    );

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

  // ── draft create (review-gated draft tier) — product204/29 ──────────────────
  // The skill-* docs teach `cloud skill draft create` as the DRAFT tier
  // (status=draft, human review in Studio before it goes anywhere). This is
  // that command. Mirrors `skill create`'s bundle reading but POSTs to
  // /api/im/skills/draft (manifest v1: SKILL.md + skill.json + scripts), which
  // runs the 7 draft gates + opens a skill-review task for the workspace owner.
  // NOT the direct-publish path — use `cloud skill create` for that (lands
  // private/active, no review). Promote a draft to marketplace via Studio
  // Lifecycle (review → publish), then `cloud skill publish`.
  const draft = cmd.command('draft').description('Review-gated draft tier (status=draft, human Studio review before publish)');
  draft
    .command('create <bundleDir>')
    .description(
      'Ingest a skill bundle as a DRAFT for human review (POST /api/im/skills/draft — manifest v1: SKILL.md + skill.json + scripts). ' +
        'Review-gated: NOT installable until promoted via Studio Lifecycle. ' +
        'For the direct path (private + active + installable, no review) use `cloud skill create`.',
    )
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { workspaceId?: string; json?: boolean }]>(async (bundleDir, opts) => {
        const bundle = readBundleOrExit(bundleDir);
        // product204/30 A4 — run the client validateBundle BEFORE the network
        // POST so authoring fails fast locally (same [50,1024] description rule
        // the server enforces) instead of trial-and-error against HTTP 400.
        const validation = validateBundle(bundle);
        if (!validation.ok) {
          exitWithError(validation.errors.join('; '), { code: 'skill_bundle_invalid' });
        }
        const built = buildSkillCreateBody(bundle);
        const files = bundle.files.map((f) => ({
          path: f.path,
          contentBase64: f.bytes.toString('base64'),
        }));
        const body = {
          slug: built.slug,
          name: built.createBody.name,
          description: built.createBody.description,
          files,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        };
        const cloud = mkCloud();
        const res = await cloud.request<{ ok?: boolean; data?: { id?: string; slug?: string }; error?: string }>(
          'POST',
          '/api/im/skills/draft',
          { body },
        );
        if (res.status === 409) {
          exitWithError(`slug "${built.slug}" already exists (409). Use a new slug.`, { code: 'skill_slug_conflict' });
        }
        if (res.status === 403) {
          exitWithError('draft create returned 403 — API key does not resolve to an IM user.', {
            code: 'skill_draft_forbidden',
          });
        }
        if (res.status !== 201 || res.data?.ok === false) {
          const msg = res.error?.message ?? res.data?.error ?? 'request failed';
          exitWithError(`draft create failed (${res.status === 0 ? 'network error' : `HTTP ${res.status}`}): ${msg}`, {
            code: 'skill_draft_failed',
          });
        }
        const draftSkill = res.data?.data;
        const result = { id: draftSkill?.id, slug: draftSkill?.slug ?? built.slug, status: 'draft', review: 'pending human review in Studio' };
        if (opts.json) {
          printJson(result);
          return;
        }
        const ui = getUI();
        ui.ok('Skill draft created', String(result.slug));
        ui.line(`id=${result.id}  status=draft  files=${files.length}`);
        ui.secondary('not installable until promoted via Studio Lifecycle (review → publish)');
      }, { code: 'skill_draft_failed' }),
    );

  // product204/21 (M-P W3) — publish-governance verbs: delist / relist /
  // deprecate / undeprecate / archive / transfer* / published. Shared factory,
  // because the backend gives skill + role one isomorphic wire shape.
  registerLifecycleCommands(cmd, SKILL_LIFECYCLE('prismer skill'), mkCloud);

  return markCloudOwnedCompatibilityCommand(cmd);
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

// ── SS-01 bundle reader (thin wrapper over runtime/src/bundle) ────────────────
// `create` keeps its original {slug,revision,fileCount,createBody} contract; the
// read/validate/manifest logic now lives in the shared bundle lib (P1, doc 16
// §6.1) so the CLI verbs and ingest*.mjs share ONE representation + a merkle that
// is byte-identical to cloud src/im/skills/manifest.ts.
interface SkillBundle {
  slug: string;
  revision: string;
  fileCount: number;
  createBody: Record<string, unknown>;
}

function readSkillBundle(bundleDir: string): SkillBundle {
  const bundle = readBundleOrExit(bundleDir);
  const validation = validateBundle(bundle);
  if (!validation.ok) {
    exitWithError(validation.errors.join('; '), { code: 'skill_bundle_invalid' });
  }
  return buildSkillCreateBody(bundle);
}

/** Read a bundle dir, mapping BundleError → exitWithError (preserves codes). */
function readBundleOrExit(bundleDir: string): ReadBundleResult {
  try {
    return readBundle(bundleDir);
  } catch (err) {
    if (err instanceof BundleError) exitWithError(err.message, { code: err.code });
    throw err;
  }
}

// ── skill test: spec parsing + dispatch (doc 16 §5.2 / §9 decision 3) ─────────
interface SampleTask {
  prompt: string;
  acceptanceCriteria: AcceptanceCriterion[];
}
interface SkillTestSpec {
  sampleTasks: SampleTask[];
}
interface SkillTestTaskResult {
  index: number;
  prompt: string;
  taskStatus: string;
  output: string;
  results: ReturnType<typeof matchAcceptanceCriteria>['results'];
  ok: boolean;
}

/**
 * Parse `skill.json` from a bundle into a normalised test spec. Accepts either:
 *   { sampleTasks: [{ prompt|task, acceptanceCriteria: [...] }] }
 * acceptanceCriteria entries may be raw strings (→ substring match) or objects
 * { match|substring|regex|label|type|flags|required }. Returns undefined when
 * skill.json is absent or has no sampleTasks (caller treats as skip).
 */
function readSkillTestSpec(bundle: ReadBundleResult): SkillTestSpec | undefined {
  const file = bundle.files.find((f) => f.path === 'skill.json');
  if (!file) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString('utf8'));
  } catch (err) {
    exitWithError(`skill.json is not valid JSON: ${(err as Error).message}`, { code: 'skill_test_bad_json' });
  }
  const root = parsed as Record<string, unknown>;
  const rawTasks = Array.isArray(root.sampleTasks) ? root.sampleTasks : [];
  const sampleTasks: SampleTask[] = [];
  for (const raw of rawTasks) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const prompt = typeof t.prompt === 'string' ? t.prompt : typeof t.task === 'string' ? t.task : '';
    if (!prompt) continue;
    const criteriaRaw = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
    const acceptanceCriteria = criteriaRaw.map(normalizeCriterion).filter((c): c is AcceptanceCriterion => c !== null);
    sampleTasks.push({ prompt, acceptanceCriteria });
  }
  return { sampleTasks };
}

function normalizeCriterion(raw: unknown): AcceptanceCriterion | null {
  if (typeof raw === 'string') return { match: raw, type: 'substring' };
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.regex === 'string') {
    return {
      match: c.regex,
      type: 'regex',
      ...(typeof c.flags === 'string' ? { flags: c.flags } : {}),
      ...(typeof c.label === 'string' ? { label: c.label } : {}),
      ...(typeof c.required === 'boolean' ? { required: c.required } : {}),
    };
  }
  const match = typeof c.match === 'string' ? c.match : typeof c.substring === 'string' ? c.substring : '';
  if (!match) return null;
  // `structured` criteria carry `checker` + `args`, which the substring/regex
  // shape below would drop — the criterion would then be scored as a plain
  // substring and go permanently red. Preserve them so the real
  // `cloud skill test` path scores what the bundle actually declares.
  if (c.type === 'structured') {
    return {
      match,
      type: 'structured',
      ...(typeof c.checker === 'string' ? { checker: c.checker } : {}),
      ...(c.args && typeof c.args === 'object' ? { args: c.args as Record<string, unknown> } : {}),
      ...(typeof c.label === 'string' ? { label: c.label } : {}),
      ...(typeof c.required === 'boolean' ? { required: c.required } : {}),
    };
  }
  return {
    match,
    type: c.type === 'regex' ? 'regex' : 'substring',
    ...(typeof c.flags === 'string' ? { flags: c.flags } : {}),
    ...(typeof c.label === 'string' ? { label: c.label } : {}),
    ...(typeof c.required === 'boolean' ? { required: c.required } : {}),
  };
}

interface DispatchOutcome {
  status: string;
  text: string;
}

/**
 * Dispatch one sample-task prompt to the agent and poll until terminal —
 * reuses the same `POST /api/im/tasks` + poll shape as `cloud task create`
 * (doc 16 §9 decision 3: CLI direct dispatch, NOT a cloud eval-run).
 */
async function dispatchSampleTask(
  cloud: CloudClient,
  agent: string,
  prompt: string,
  timeoutMs?: number,
): Promise<DispatchOutcome> {
  // The task-based dispatch path can't close against Hermes agents on the
  // current stack: synthetic (conversation-less) tasks are rejected
  // (release201/25 §16.4 A3 removed the /v1/runs fallback), and even a
  // conversation-bound task can't have its result written back by the agent's
  // daemon ("Access denied for task: you do not have access to this task"), so
  // it sits `running` and never yields output. The PROVEN path is chat: a
  // direct message to the agent auto-dispatches and the agent replies WITH A
  // MESSAGE. Create a throwaway DM, send the prompt, poll for the agent reply.
  const dm = await cloud.request<{ data?: { id?: string }; id?: string }>('POST', '/api/im/conversations/direct', {
    body: { otherUserId: agent },
  });
  const conversationId = dm.data?.data?.id ?? dm.data?.id;
  if (!dm.ok || !conversationId) {
    exitWithError(
      `could not create test conversation for agent ${agent} (${describeStatus(dm.status)}): ${dm.error?.message ?? ''}`,
      { code: 'skill_test_no_conversation' },
    );
  }
  // Client-side floor before the send, fallback if server doesn't echo createdAt.
  const sentFloor = new Date(Date.now() - 1_000).toISOString();
  const sent = await cloud.request<{ message?: { createdAt?: string }; data?: { message?: { createdAt?: string } } }>(
    'POST',
    `/api/im/messages/${encodeURIComponent(conversationId!)}`,
    { body: { type: 'text', content: prompt } },
  );
  if (!sent.ok) {
    exitWithError(`could not send sample prompt (${describeStatus(sent.status)}): ${sent.error?.message ?? ''}`, {
      code: 'skill_test_send_failed',
    });
  }
  // apc/11 §0.17 gap #2 (end-to-end anchor, mirror of typescript/src/commands/
  // skill.ts). The DM is reused across runs → a prior run's good reply gets
  // returned on the first poll before the agent answers THIS prompt (falsely
  // green mumble runs). Only accept replies strictly newer than the prompt.
  const afterIso = sent.data?.data?.message?.createdAt ?? sent.data?.message?.createdAt ?? sentFloor;

  const deadline = Date.now() + (timeoutMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    await sleep(2_000);
    const res = await cloud.request<unknown>('GET', `/api/im/messages/${encodeURIComponent(conversationId!)}?limit=20`);
    if (!res.ok) {
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        exitWithError(`poll failed (${res.status}): ${res.error?.message ?? ''}`, { code: 'skill_test_poll_failed' });
      }
      continue;
    }
    const reply = extractAgentReply(res.data, agent, afterIso);
    if (reply) return { status: 'completed', text: reply };
  }
  return { status: 'timeout', text: '' };
}

// Find the target agent's reply message in a GET /api/im/messages response.
// The reply lands as a normal chat message (senderId === agent); the DM is
// fresh so the agent's first non-empty message is the answer to our prompt.
// apc/11 §0.17 gap #2 (mirror of typescript/src/commands/skill.ts) — skip infra
// message types (system_event/system) and take the LATEST agent row, else a
// stale system_event returned in ASC order shadows the real reply forever.
// `afterIso` anchors the reply to be strictly newer than the prompt just sent,
// so a reused DM's prior-run reply can't falsely close a mumble run.
function extractAgentReply(raw: unknown, agent: string, afterIso?: string | null): string | null {
  const data = raw && typeof raw === 'object' && 'data' in (raw as object) ? (raw as { data?: unknown }).data : raw;
  const arr: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { messages?: unknown[] }).messages)
      ? (data as { messages: unknown[] }).messages
      : [];
  const afterMs = afterIso ? Date.parse(afterIso) : NaN;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type === 'system_event' || type === 'system') continue; // infra, not a reply
    const sender = typeof msg.senderId === 'string' ? msg.senderId : '';
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (sender !== agent || !content.trim()) continue;
    if (!Number.isNaN(afterMs)) {
      const createdAt = typeof msg.createdAt === 'string' ? Date.parse(msg.createdAt) : NaN;
      if (Number.isNaN(createdAt) || createdAt <= afterMs) continue;
    }
    return content;
  }
  return null;
}

function printSkillTestReport(tasks: SkillTestTaskResult[], overallOk: boolean): void {
  const ui = getUI();
  ui.header(`Skill test (${tasks.length} sample task(s))`);
  for (const t of tasks) {
    ui.line(`\n[task ${t.index}] status=${t.taskStatus}  ${t.prompt.slice(0, 60)}`);
    if (t.results.length === 0) {
      ui.secondary('no acceptanceCriteria — task ran but is unscored');
    }
    ui.table(
      t.results.map((r) => ({
        criterion: r.label,
        type: r.type,
        required: r.required ? 'yes' : 'no',
        result: r.pass ? 'PASS' : 'FAIL',
        error: r.error ?? '',
      })),
      { columns: ['criterion', 'type', 'required', 'result', 'error'] },
    );
  }
  ui.blank();
  if (overallOk) ui.ok('Skill test passed', `${tasks.length} task(s)`);
  else ui.fail('Skill test failed', 'one or more required criteria missed');
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
