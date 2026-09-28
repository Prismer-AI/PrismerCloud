import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismerClient } from '../index';
// SS-01 bundle validation/package logic is Cloud-owned and pure-local. Runtime
// keeps its own compatibility implementation; the packages do not import each
// other's source trees.
import {
  BundleError,
  buildSkillCreateBody,
  matchAcceptanceCriteria,
  packageBundle,
  readBundle,
  validateBundle,
  type AcceptanceCriterion,
  type ReadBundleResult,
} from '../internal/bundle/index';
import { registerLifecycleCommands } from './lifecycle';

type ClientFactory = () => PrismerClient;
interface SkillEnvelope<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string | { code?: string; message?: string };
}

function skillError(res: SkillEnvelope, fallback: string): string {
  return typeof res.error === 'string' ? res.error : (res.error?.message ?? fallback);
}
type SkillLocalPlatform = 'claude-code' | 'openclaw' | 'opencode' | 'plugin';
const SKILL_LOCAL_PLATFORMS = new Set<SkillLocalPlatform>(['claude-code', 'openclaw', 'opencode', 'plugin']);

function parsePlatforms(raw: string): SkillLocalPlatform[] | undefined {
  if (raw === 'all') return undefined;
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!SKILL_LOCAL_PLATFORMS.has(value as SkillLocalPlatform)) {
      throw new Error(`Invalid platform "${value}". Expected claude-code, openclaw, opencode, plugin, or all.`);
    }
  }
  return values as SkillLocalPlatform[];
}

function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function formatTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const cols = rows[0].length;
  const widths: number[] = Array(cols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? '').length);
    }
  }
  return rows
    .map(row => row.map((cell, i) => padEnd(cell ?? '', widths[i])).join('  '))
    .join('\n');
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const skill = parent
    .command('skill')
    .description('Browse, install, and manage skills');

  // skill find [query]
  skill
    .command('find [query]')
    .description('Search the skill marketplace')
    .option('-c, --category <category>', 'filter by category')
    .option('-n, --limit <n>', 'max results to return', '20')
    .option('--json', 'output raw JSON response')
    .action(async (query: string | undefined, opts: { category?: string; limit: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const limit = parseInt(opts.limit, 10);
        const res = await client.im.evolution.searchSkills({
          query,
          category: opts.category,
          limit,
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const skills: unknown[] = Array.isArray(res) ? res : ((res as { skills?: unknown[] })?.skills ?? []);
        if (skills.length === 0) {
          process.stdout.write('No skills found.\n');
          return;
        }

        const header = ['Slug', 'Name', 'Installs', 'Category'];
        const rows = skills.map((s: unknown) => {
          const sk = s as Record<string, unknown>;
          return [
            String(sk.slug ?? sk.id ?? ''),
            String(sk.name ?? ''),
            String(sk.installCount ?? sk.installs ?? '0'),
            String(sk.category ?? ''),
          ];
        });

        process.stdout.write(formatTable([header, ...rows]) + '\n');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill install <slug>
  skill
    .command('install <slug>')
    .description('Install a skill')
    .option('--platform <platform>', 'target platform: claude-code, openclaw, opencode, or all', 'all')
    .option('--project <path>', 'project directory for local file writes')
    .option('--no-local', 'cloud-only install, do not write local files')
    .option('--json', 'output raw JSON response')
    .action(async (slug: string, opts: { platform: string; project?: string; local: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        let res: unknown;
        if (!opts.local) {
          res = await client.im.evolution.installSkill(slug);
        } else {
          const platforms = parsePlatforms(opts.platform);
          res = await client.im.evolution.installSkillLocal(slug, {
            platforms,
            project: Boolean(opts.project),
            projectRoot: opts.project,
          });
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { ok?: boolean; data?: { skill?: Record<string, unknown>; localPaths?: string[] } };
        if (result?.ok === false) {
          process.stderr.write(`Install failed.\n`);
          process.exit(1);
        }

        const skillData = result?.data?.skill ?? {};
        const name = String((skillData as Record<string, unknown>).name ?? slug);
        process.stdout.write(`Installed: ${name}\n`);

        const localPaths: string[] = result?.data?.localPaths ?? [];
        if (localPaths.length > 0) {
          process.stdout.write('Local files written:\n');
          for (const p of localPaths) {
            process.stdout.write(`  ${p}\n`);
          }
        } else if (!opts.local) {
          process.stdout.write('Cloud-only install complete (no local files written).\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill list
  skill
    .command('list')
    .description('List installed skills')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.evolution.installedSkills();

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        // `_r` returns the full envelope `{ok, data, error}`; the installed list
        // lives under `.data`. Fall back to raw-array / `.skills` for older
        // shapes that some test fixtures still produce.
        const envelope = res as { data?: unknown[]; skills?: unknown[] };
        const records: unknown[] = Array.isArray(envelope.data)
          ? envelope.data
          : Array.isArray(res)
            ? (res as unknown[])
            : Array.isArray(envelope.skills)
              ? envelope.skills
              : [];
        if (records.length === 0) {
          process.stdout.write('No skills installed.\n');
          return;
        }

        const header = ['Slug', 'Name', 'Installs', 'Category'];
        const rows = records.map((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const sk = (rec.skill ?? rec) as Record<string, unknown>;
          return [
            String(sk.slug ?? sk.id ?? ''),
            String(sk.name ?? ''),
            String(sk.installCount ?? sk.installs ?? '0'),
            String(sk.category ?? ''),
          ];
        });

        process.stdout.write(formatTable([header, ...rows]) + '\n');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // skill show <slug>
  skill
    .command('show <slugOrId>')
    .description('Show skill content and details')
    .option('--content', 'include full SKILL.md/package content')
    .option('--json', 'output raw JSON response')
    .action(async (slugOrId: string, opts: { content?: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        const suffix = opts.content ? '/content' : '';
        const res = await client.im.request<SkillEnvelope<Record<string, unknown>>>(
          'GET',
          `/api/im/skills/${encodeURIComponent(slugOrId)}${suffix}`,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${skillError(res, `skill not found: ${slugOrId}`)}\n`);
          process.exit(1);
          return;
        }
        const result = res.data as { content?: string; files?: string[]; packageUrl?: string; checksum?: string };

        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }

        if (!opts.content) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        if (result?.packageUrl) {
          process.stdout.write(`Package URL: ${result.packageUrl}\n`);
        }
        if (result?.checksum) {
          process.stdout.write(`Checksum:    ${result.checksum}\n`);
        }
        if (result?.files && result.files.length > 0) {
          process.stdout.write(`Files:\n`);
          for (const f of result.files) {
            process.stdout.write(`  ${f}\n`);
          }
        }
        if (result?.content) {
          process.stdout.write(`\n${result.content}\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // Owner/workspace inventory. Marketplace `find` intentionally excludes
  // private skills; authoring needs this separate round-trip surface.
  skill
    .command('mine')
    .description("List skills owned by the caller's workspace (including private active skills and drafts)")
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<SkillEnvelope<Record<string, unknown>[]>>('GET', '/api/im/skills/created');
        if (!res.ok || !Array.isArray(res.data)) {
          process.stderr.write(`Error: ${skillError(res, 'could not list owned skills')}\n`);
          process.exit(1);
          return;
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`My skills (${res.data.length})\n`);
        for (const item of res.data) {
          process.stdout.write(
            `  ${String(item.slug ?? item.id ?? '—')}\tstatus=${String(item.status ?? '—')}\tscope=${String(item.publishScope ?? '—')}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // skill publish <slug> — product204/16 §2.2(c): the explicit owner action
  // that flips a skill from the private domain (publishScope='workspace', the
  // create default) to the public Marketplace ('marketplace').
  skill
    .command('publish <slugOrId>')
    .description(
      'Publish a skill to the public Marketplace (flips publishScope workspace→marketplace; owner-only). License required — pass --license if the skill has none.',
    )
    .option('--license <spdx>', 'License to record at publish time (e.g. MIT)')
    .option('--changelog <text>', 'Changelog note for this publish')
    .option('--json', 'output raw JSON response')
    .action(async (slugOrId: string, opts: { license?: string; changelog?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        // publish-template addresses skills by id — resolve slug → id first.
        const detail = await client.im.request<{ ok?: boolean; data?: { id?: string; slug?: string } }>(
          'GET',
          `/api/im/skills/${encodeURIComponent(slugOrId)}`,
        );
        const skillId = detail?.data?.id;
        if (!skillId) {
          process.stderr.write(`Error: skill not found: ${slugOrId}\n`);
          process.exit(1);
          return;
        }
        const res = await client.im.request<{
          ok?: boolean;
          data?: { skillId?: string; publishScope?: string; publishedAt?: string };
          error?: { message?: string };
        }>('POST', `/api/im/skills/${encodeURIComponent(skillId)}/publish-template`, {
          scope: 'marketplace',
          ...(opts.license ? { license: opts.license } : {}),
          ...(opts.changelog ? { changelog: opts.changelog } : {}),
          includeBoilerplateTask: false,
        });
        if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message ?? 'publish failed'}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Skill published to Marketplace: ${detail?.data?.slug ?? slugOrId}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // skill uninstall <slug>
  skill
    .command('uninstall <slug>')
    .description('Uninstall a skill')
    .option('--no-local', 'cloud-only uninstall, do not remove local files')
    .option('--json', 'output raw JSON response')
    .action(async (slug: string, opts: { local: boolean; json: boolean }) => {
      const client = getIMClient();
      try {
        let res: unknown;
        if (!opts.local) {
          res = await (client.im.evolution as unknown as Record<string, (s: string) => Promise<unknown>>).uninstallSkill(slug);
        } else {
          res = await client.im.evolution.uninstallSkillLocal(slug);
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { ok?: boolean; data?: { uninstalled?: boolean; removedPaths?: string[] } };
        if (result?.ok === false) {
          process.stderr.write(`Uninstall failed.\n`);
          process.exit(1);
        }

        process.stdout.write(`Uninstalled: ${slug}\n`);

        const removedPaths: string[] = result?.data?.removedPaths ?? [];
        if (removedPaths.length > 0) {
          process.stdout.write('Local files removed:\n');
          for (const p of removedPaths) {
            process.stdout.write(`  ${p}\n`);
          }
        } else if (!opts.local) {
          process.stdout.write('Cloud-only uninstall complete (no local files removed).\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // Authoring direct-create tier. The server returns the canonical catalog
  // slug (community-* for user-authored skills); callers must persist that
  // value rather than reconstructing it from the directory name.
  skill
    .command('create <bundleDir>')
    .description('Create a private active SS-01 skill from a bundle directory (workspace scope, installable immediately)')
    .option('--install', 'install the created skill after create')
    .option('--agent <imUserId>', 'target agent for --install (default: authenticated agent)')
    .option('--json', 'output raw JSON response')
    .action(async (bundleDir: string, opts: { install?: boolean; agent?: string; json?: boolean }) => {
      const bundle = readBundleOrExit(bundleDir);
      const validation = validateBundle(bundle);
      if (!validation.ok) {
        process.stderr.write(`Error: bundle invalid: ${validation.errors.join('; ')}\n`);
        process.exit(1);
        return;
      }
      const built = buildSkillCreateBody(bundle);
      const client = getIMClient();
      try {
        const created = await client.im.request<SkillEnvelope<Record<string, unknown>>>(
          'POST',
          '/api/im/skills',
          built.createBody,
        );
        if (!created.ok || !created.data) {
          process.stderr.write(`Error: ${skillError(created, 'skill create failed')}\n`);
          process.exit(1);
          return;
        }
        const canonicalSlug = String(created.data.slug ?? built.slug);
        const result: Record<string, unknown> = {
          id: created.data.id,
          slug: canonicalSlug,
          requestedSlug: built.slug,
          rev: built.revision,
          files: built.fileCount,
          publishScope: created.data.publishScope ?? 'workspace',
          status: created.data.status ?? 'active',
          installed: false,
        };
        if (opts.install) {
          const installPath = opts.agent
            ? `/api/im/agents/${encodeURIComponent(opts.agent)}/skills`
            : `/api/im/skills/${encodeURIComponent(canonicalSlug)}/install`;
          const installBody = opts.agent ? { skillId: canonicalSlug } : {};
          const installed = await client.im.request<SkillEnvelope>(
            'POST',
            installPath,
            installBody,
          );
          if (!installed.ok) {
            process.stderr.write(
              `Error: skill ${canonicalSlug} was created, but install failed: ${skillError(installed, 'install failed')}\n`,
            );
            process.exit(1);
            return;
          }
          result.installed = opts.agent ?? true;
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Skill created: ${canonicalSlug}\n`);
        process.stdout.write(`verify: cloud skill show ${canonicalSlug} --content\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // skill sync
  skill
    .command('sync')
    .description('Re-sync all installed skills to local filesystem')
    .option('--platform <platform>', 'target platform: claude-code, openclaw, opencode, or all', 'all')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { platform: string; json: boolean }) => {
      const client = getIMClient();
      try {
        const platforms = parsePlatforms(opts.platform);
        const res = await client.im.evolution.syncSkillsLocal({ platforms });

        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
          return;
        }

        const result = res as { synced?: number; failed?: number; paths?: string[] };
        const synced = result?.synced ?? 0;
        const failed = result?.failed ?? 0;
        process.stdout.write(`Synced: ${synced} skill(s)`);
        if (failed > 0) {
          process.stdout.write(`, failed: ${failed}`);
        }
        process.stdout.write('\n');

        const paths: string[] = result?.paths ?? [];
        if (paths.length > 0) {
          process.stdout.write('Files written:\n');
          for (const p of paths) {
            process.stdout.write(`  ${p}\n`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // ── skill validate <bundleDir> — dry-run, NO network ────────────────────────
  // Agent-facing port of `prismer skill validate`. Pure-local via the shared
  // bundle lib; SKILL.md frontmatter / slug / category checks. Exit 1 on invalid.
  skill
    .command('validate <bundleDir>')
    .description('Dry-run validate a SS-01 skill bundle (frontmatter/slug/manifest). No network.')
    .option('--json', 'output raw JSON response')
    .action((bundleDir: string, opts: { json?: boolean }) => {
      const bundle = readBundleOrExit(bundleDir);
      const v = validateBundle(bundle);
      const slug = typeof bundle.frontmatter.name === 'string' ? bundle.frontmatter.name : null;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            { ok: v.ok, slug, files: bundle.files.length, errors: v.errors, warnings: v.warnings },
            null,
            2,
          ) + '\n',
        );
        if (!v.ok) process.exit(1);
        return;
      }
      if (v.ok) {
        process.stdout.write(`Skill bundle valid: ${bundle.files.length} file(s)\n`);
      } else {
        process.stderr.write(`Skill bundle invalid: ${v.errors.length} error(s)\n`);
      }
      for (const e of v.errors) process.stderr.write(`  ✗ ${e}\n`);
      for (const w of v.warnings) process.stdout.write(`  ! ${w}\n`);
      if (!v.ok) process.exit(1);
    });

  // ── skill package <bundleDir> [-o <out>] — tarball + merkle, NO network ──────
  // Agent-facing port of `prismer skill package`. Validates first, then writes a
  // deterministic .tar.gz and prints the merkle revision. Pure-local.
  skill
    .command('package <bundleDir>')
    .description('Package a SS-01 skill bundle into a .tar.gz + print merkle. Local only, no network.')
    .option('-o, --out <file>', 'output tarball path (default: <slug>.tgz)')
    .option('--json', 'output raw JSON response')
    .action((bundleDir: string, opts: { out?: string; json?: boolean }) => {
      const bundle = readBundleOrExit(bundleDir);
      const v = validateBundle(bundle);
      if (!v.ok) {
        process.stderr.write(`Error: bundle invalid (run \`cloud skill validate\`): ${v.errors.join('; ')}\n`);
        process.exit(1);
      }
      const slug = typeof bundle.frontmatter.name === 'string' ? bundle.frontmatter.name : basename(bundleDir);
      const out = opts.out ?? `${slug}.tgz`;
      const pkg = packageBundle(bundle);
      try {
        writeFileSync(out, pkg.bytes);
      } catch (err) {
        process.stderr.write(`Error: could not write ${out}: ${(err as Error).message}\n`);
        process.exit(1);
      }
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ slug, out, rev: pkg.revision, files: pkg.fileCount, bytes: pkg.bytes.byteLength }, null, 2) +
            '\n',
        );
        return;
      }
      process.stdout.write(`Skill packaged: ${out}\n`);
      process.stdout.write(`slug=${slug}  rev=${pkg.revision}  files=${pkg.fileCount}  bytes=${pkg.bytes.byteLength}\n`);
    });

  // ── skill test <bundleDir> --agent <imUserId> — real chat-path dispatch ──────
  // Agent-facing port of `prismer skill test`. Dispatches each skill.json
  // sampleTasks[].prompt to the agent over the CHAT path (DM → message → poll
  // for reply) and scores acceptanceCriteria[]. Mirrors runtime/skill.ts: the
  // task-API path can't close against Hermes (synthetic tasks rejected; daemon
  // can't write results back — see release203/19 §A), so chat is the proven path.
  skill
    .command('test <bundleDir>')
    .description('Dispatch skill.json sampleTasks[] to an agent and score acceptanceCriteria[]')
    .requiredOption('--agent <imUserId>', 'target agent IMUser.id to run the sample tasks')
    .option('--timeout-ms <ms>', 'per-task dispatch timeout', (v) => Number.parseInt(v, 10))
    .option('--json', 'output raw JSON response')
    .action(async (bundleDir: string, opts: { agent: string; timeoutMs?: number; json?: boolean }) => {
      const bundle = readBundleOrExit(bundleDir);
      const spec = readSkillTestSpec(bundle);
      if (!spec || spec.sampleTasks.length === 0) {
        // doc 16 §5.2: "if absent, skip with clear msg" — not a failure.
        const msg =
          'no skill.json sampleTasks[] found — nothing to test (add sampleTasks + acceptanceCriteria to skill.json)';
        if (opts.json) {
          process.stdout.write(JSON.stringify({ skipped: true, reason: msg }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Skill test skipped: ${msg}\n`);
        return;
      }

      const client = getIMClient();
      try {
        const taskResults: SkillTestTaskResult[] = [];
        for (let i = 0; i < spec.sampleTasks.length; i++) {
          const t = spec.sampleTasks[i]!;
          const output = await dispatchSampleTask(client, opts.agent, t.prompt, { timeoutMs: opts.timeoutMs });
          const matched = matchAcceptanceCriteria(t.acceptanceCriteria, output.text);
          taskResults.push({
            index: i,
            prompt: t.prompt,
            taskStatus: output.status,
            runId: output.runId,
            output: output.text,
            results: matched.results,
            // `completed` is the ONLY status that can be ok. dispatch_not_created
            // / no_reply / timeout are hard failures (no proven run side effect),
            // never scored green regardless of acceptanceCriteria text.
            ok: output.status === 'completed' && matched.ok,
          });
        }

        const overallOk = taskResults.every((t) => t.ok);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: overallOk, agent: opts.agent, tasks: taskResults }, null, 2) + '\n');
          if (!overallOk) process.exit(1);
          return;
        }
        printSkillTestReport(taskResults, overallOk);
        if (!overallOk) process.exit(1);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // ── apc/04 §2 层1 — skill invocation receipt (`cloud skill ack`) ──────────
  //
  // Thin wrapper over `POST /api/im/tasks/:id/event` (src/im/api/tasks.ts:2486)
  // → `im.tasks.postEvent()` (src/index.ts:920). Lands ONE `im_task_logs` row
  // with action `skill_ack` and metadata `{code, skillSlug, taskId, agentId, ts}`.
  // The receipt is a DB side effect, not chat text — that is the whole point
  // (apc/04 §2: "oracle 读 DB 回执行——这是副作用不是文本").
  //
  // ⚠️ TWO LOAD-BEARING LIMITS, both stated in --help because pretending they
  // don't exist is how the previous round shipped a ghost command:
  //
  //   1. **assignee-only.** The endpoint authorises `task.assigneeId ===
  //      user.imUserId` (tasks.ts:2510-2514) and 403s everyone else — including
  //      the task creator/orchestrator. An ack can therefore only be produced by
  //      the agent that is executing the task.
  //   2. **no task context ⇒ no receipt exists.** Skills that run outside a
  //      dispatched task (env-doctor, release-preflight from a human shell, …)
  //      have no `PRISMER_TASK_ID`; there is nothing to attach a receipt to and
  //      this command CANNOT fabricate one. It exits 3 (`no_task_context`) —
  //      a distinct, documented state, deliberately NOT exit 0, so a missing
  //      receipt can never be mistaken for a landed one.
  //
  // Exit codes: 0 receipt landed · 1 request failed · 3 no task context
  //             · 4 rejected (caller is not the task assignee).
  skill
    .command('ack <slug>')
    .description('Record a skill-invocation receipt on a task (apc/04 §2 layer 1)')
    .option('--task <taskId>', 'target task id; defaults to PRISMER_TASK_ID env')
    .option('--note <text>', 'optional human-readable note stored on the log row')
    .option('--json', 'output raw JSON response')
    .addHelpText(
      'after',
      [
        '',
        'Contract (apc/04 §2 layer 1) — read before relying on this:',
        '  • Only the task ASSIGNEE may post. The server 403s the creator /',
        '    orchestrator / anyone else (POST /api/im/tasks/:id/event).',
        '  • A skill with NO task context (env-doctor, human-shell runs, chat',
        '    dispatch runs that only get PRISMER_RUN_ID) CANNOT produce a receipt.',
        '    That is a contract limit, not a bug — this command exits 3 instead of',
        '    silently succeeding.',
        '  • The receipt proves the skill was INVOKED. It does not prove the skill',
        '    did its job — that is each skill\'s own acceptanceCriteria job.',
        '',
        'Exit codes: 0 receipt landed · 1 failed · 3 no task context · 4 not assignee',
      ].join('\n'),
    )
    .action(async (slug: string, opts: { task?: string; note?: string; json?: boolean }) => {
      const taskId = opts.task ?? process.env.PRISMER_TASK_ID;
      if (!taskId) {
        const detail =
          'no task context: pass --task <taskId> or run inside a dispatched task (PRISMER_TASK_ID). ' +
          'Skills without a task (env-doctor, human-shell runs) cannot produce an invocation receipt.';
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: { code: 'no_task_context', message: detail } }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`Error: ${detail}\n`);
        }
        process.exit(3);
        return;
      }
      // A `run_…` id is a chat-dispatch run, which has no kanban task row and
      // hence no task-event endpoint. Same guard shape as `cloud task attach`.
      if (taskId.startsWith('run_')) {
        const detail =
          `'${taskId}' is a run id (run_…); chat-dispatch runs have no task row, so no invocation receipt exists.`;
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: { code: 'no_task_context', message: detail } }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`Error: ${detail}\n`);
        }
        process.exit(3);
        return;
      }

      const client = getIMClient();
      // The exit code is computed inside and applied AFTER the try/catch. A
      // `process.exit()` raised inside the try would otherwise be swallowed by
      // this function's own catch under any harness where exit throws, and the
      // distinct code 4 would silently degrade to 1 — the exact kind of
      // "looks fine, reports the wrong thing" bug this verb exists to avoid.
      let exitCode = 0;
      try {
        // `agentId` here is the daemon-injected self id (claim). The AUTHORITATIVE
        // actor is the server-written `im_task_logs.actorId`, resolved from the
        // credential — never from this payload.
        const agentId = process.env.PRISMER_AGENT_IM_USER_ID || undefined;
        const res = await client.im.tasks.postEvent(taskId, {
          code: 'SKILL_ACK',
          message: opts.note ?? `skill ${slug} invoked`,
          payload: { skillSlug: slug, taskId, ...(agentId ? { agentId } : {}), ts: new Date().toISOString() },
        });

        if (!res.ok) exitCode = isNotAssigneeError(res.error) ? 4 : 1;
        if (opts.json) {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        } else if (!res.ok) {
          process.stderr.write(`Error: ${res.error?.message || 'Unknown error'}\n`);
          if (exitCode === 4) {
            process.stderr.write(
              'Hint: only the task ASSIGNEE may post an invocation receipt (apc/04 §2 layer 1).\n',
            );
          }
        } else {
          process.stdout.write(`Ack recorded: skill ${slug} → task ${taskId} (action skill_ack)\n`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        exitCode = 1;
      }
      if (exitCode !== 0) process.exit(exitCode);
    });

  // product204/21 (M-P W3) — publish-governance verbs: delist / relist /
  // deprecate / undeprecate / archive / transfer* / published. Shared factory,
  // because the backend gives skill + role one isomorphic wire shape.
  registerLifecycleCommands(skill, 'skill', getIMClient);
}

/**
 * The task-event endpoint answers a non-assignee with `accessErr(...)` →
 * `{code:'TASK_ACCESS_DENIED', message:'only the task assignee can post task
 * events'}` / HTTP 403 (tasks.ts:139 + :2514). It is the ONLY `accessErr` on
 * that route (a missing task is a separate 404 `TASK_NOT_FOUND`), so the code
 * alone identifies the rejection; the message is matched as a fallback in case
 * a future revision of the route adds a second denial reason.
 */
function isNotAssigneeError(err: { code?: string; message?: string } | undefined): boolean {
  if (!err) return false;
  return err.code === 'TASK_ACCESS_DENIED' || /only the task assignee/i.test(err.message ?? '');
}

// ── SS-01 bundle reader (shared lib) ──────────────────────────────────────────
/** Read a bundle dir, mapping BundleError → clean stderr + exit (preserves msg). */
function readBundleOrExit(bundleDir: string): ReadBundleResult {
  try {
    return readBundle(bundleDir);
  } catch (err) {
    if (err instanceof BundleError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

// ── skill test: spec parsing + dispatch (mirror runtime/skill.ts) ─────────────
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
  runId: string | null;
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
    process.stderr.write(`Error: skill.json is not valid JSON: ${(err as Error).message}\n`);
    process.exit(1);
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
    const acceptanceCriteria = criteriaRaw
      .map(normalizeCriterion)
      .filter((c): c is AcceptanceCriterion => c !== null);
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
  // Mirror of runtime/src/cli/commands/skill.ts — `structured` criteria carry
  // `checker` + `args`; dropping them degrades the criterion to a plain
  // substring match that can never pass.
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
  // 'completed' — a run was created for THIS prompt AND it produced a reply
  //   bound to that run (the only success state).
  // 'dispatch_not_created' — no im_task_runs row was ever created for THIS
  //   prompt (agent unroutable / no profile / daemon never picked it up). This
  //   is the state that MUST NOT be mistaken for success: apc/11 §0.28 gap ②
  //   — a stale cross-run reply in a reused DM used to score this falsely green.
  // 'no_reply' — the run was created but produced no bound reply before the
  //   deadline (still a failure — nothing to score).
  // 'timeout' — never observed either (kept for parity; folds into no-run path).
  status: 'completed' | 'dispatch_not_created' | 'no_reply' | 'timeout';
  text: string;
  runId: string | null;
}

/**
 * Dispatch one sample-task prompt to the agent over the CHAT path and score the
 * result on REAL SIDE EFFECTS, not on "the DM has an agent message newer than a
 * timestamp" (apc/11 §0.28 gap ②: that false-greened zero-run negative controls
 * by adopting a prior run's stale reply). Two side-effect gates, BOTH required
 * for `completed`:
 *
 *   1. **A run exists for THIS dispatch.** The chat-dispatch run is created with
 *      `im_task_runs.triggerMessageId === <this prompt's message id>`
 *      (message.service.ts:2649 → createTaskRun, creatorId = prompt sender = us).
 *      We poll `GET /tasks/runs?conversationId=&mine=created` for it. No such row
 *      by the deadline ⇒ `dispatch_not_created` — never `completed`.
 *   2. **The reply is bound to THIS run.** The agent reply stamps
 *      `metadata.replyToMessageId === <this prompt's message id>`
 *      (dispatch-reply.service.ts:322-340, kind='agent_reply'). A cross-run
 *      stale reply carries a DIFFERENT trigger id and is rejected, even if its
 *      createdAt is newer.
 *
 * Mirrors the chat path from runtime/skill.ts: the task-API path can't close
 * against Hermes. The cloud `client.im` calls return the PARSED `{ ok, data,
 * error }` body directly (no HTTP `.status`).
 */
export async function dispatchSampleTask(
  client: PrismerClient,
  agent: string,
  prompt: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<DispatchOutcome> {
  const dm = await client.im.request<{ ok?: boolean; data?: { id?: string }; error?: { message?: string } }>(
    'POST',
    '/api/im/conversations/direct',
    { otherUserId: agent },
  );
  const conversationId = dm?.data?.id;
  if (dm?.ok === false || !conversationId) {
    throw new Error(
      `could not create test conversation for agent ${agent}: ${dm?.error?.message ?? 'no conversation id returned'}`,
    );
  }

  // Client-side floor captured BEFORE the send, as a fallback if the server
  // doesn't echo the created row's timestamp.
  const sentFloor = new Date(Date.now() - 1_000).toISOString();
  const sent = await client.im.request<{
    ok?: boolean;
    data?: { message?: { id?: string; createdAt?: string } };
    error?: { message?: string };
  }>('POST', `/api/im/messages/${encodeURIComponent(conversationId)}`, { type: 'text', content: prompt });
  if (sent?.ok === false) {
    throw new Error(`could not send sample prompt: ${sent?.error?.message ?? 'send failed'}`);
  }
  // The prompt message id is the anchor for BOTH side-effect gates: the run's
  // triggerMessageId and the reply's replyToMessageId are keyed to it. Without
  // it we cannot bind to THIS dispatch, so refuse rather than guess.
  const triggerMessageId = sent?.data?.message?.id;
  if (!triggerMessageId) {
    throw new Error(
      'could not read the sent prompt message id from the send response — cannot bind the run/reply to this dispatch',
    );
  }
  // Secondary anchor: only accept agent replies strictly NEWER than the prompt.
  const afterIso = sent?.data?.message?.createdAt ?? sentFloor;

  const deadline = Date.now() + (opts?.timeoutMs ?? 5 * 60_000);
  const pollIntervalMs = opts?.pollIntervalMs ?? 2_000;
  // Once we have SEEN a run for our trigger message we remember it, so a run
  // that later disappears from the (bounded) list page can't downgrade a real
  // dispatch back to `dispatch_not_created`.
  let sawRun: { id: string; status: string } | null = null;

  // Query-first loop: a run + bound reply that are already present resolve on
  // the first pass with no sleep (keeps the acceptance tests fast and lets a
  // real dispatch settle over the deadline).
  while (Date.now() < deadline) {
    const runsRes = await client.im
      .request('GET', '/api/im/tasks/runs', undefined, { conversationId, mine: 'created', limit: '50' })
      .catch(() => undefined);
    const run = findRunForTrigger(runsRes, triggerMessageId);
    if (run) sawRun = run;

    let msgRes: { ok?: boolean; data?: unknown; error?: { message?: string } } | undefined;
    try {
      msgRes = await client.im.request(
        'GET',
        `/api/im/messages/${encodeURIComponent(conversationId)}`,
        undefined,
        { limit: '20' },
      );
    } catch {
      msgRes = undefined; // transient — keep polling
    }
    const reply =
      msgRes?.ok === false ? null : extractAgentReply(msgRes?.data ?? msgRes, agent, afterIso, triggerMessageId);

    // GATE: a run for THIS prompt AND a reply bound to THIS prompt. Either alone
    // is insufficient — that is the whole apc/11 §0.28 lesson.
    if (sawRun && reply) return { status: 'completed', text: reply, runId: sawRun.id };

    if (Date.now() + pollIntervalMs < deadline) await sleep(pollIntervalMs);
    else break;
  }

  if (!sawRun) return { status: 'dispatch_not_created', text: '', runId: null };
  return { status: 'no_reply', text: '', runId: sawRun.id };
}

/**
 * Find the run created by THIS dispatch in a `GET /tasks/runs` response. The
 * chat-dispatch run is keyed by `triggerMessageId === <our prompt message id>`
 * (message.service.ts:2649). Returns the run id + status, or null when no row
 * for our trigger message is present yet. Exported for the acceptance tests.
 */
export function findRunForTrigger(
  raw: unknown,
  triggerMessageId: string,
): { id: string; status: string } | null {
  const data =
    raw && typeof raw === 'object' && 'data' in (raw as object) ? (raw as { data?: unknown }).data : raw;
  const arr: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { runs?: unknown[] }).runs)
      ? (data as { runs: unknown[] }).runs
      : [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    if (row.triggerMessageId === triggerMessageId && typeof row.id === 'string') {
      return { id: row.id, status: typeof row.status === 'string' ? row.status : 'unknown' };
    }
  }
  return null;
}

/**
 * True when this message is a reply BOUND to the prompt we dispatched — i.e. its
 * metadata references our trigger message id. The two-phase chat-dispatch reply
 * stamps `metadata.replyToMessageId` (and mirror `triggerMessageId`) with the
 * id of the message that triggered the run (dispatch-reply.service.ts:335-336).
 * A cross-run stale reply references a DIFFERENT trigger id → false. Metadata
 * arrives as an object or a JSON string depending on the read path.
 */
function messageRepliesTo(msg: Record<string, unknown>, expectedTriggerMessageId: string): boolean {
  const rawMeta = msg.metadata;
  let meta: Record<string, unknown> | undefined;
  if (rawMeta && typeof rawMeta === 'object') meta = rawMeta as Record<string, unknown>;
  else if (typeof rawMeta === 'string' && rawMeta.trim()) {
    try {
      meta = JSON.parse(rawMeta) as Record<string, unknown>;
    } catch {
      meta = undefined;
    }
  }
  if (!meta) return false;
  return meta.replyToMessageId === expectedTriggerMessageId || meta.triggerMessageId === expectedTriggerMessageId;
}

// Find the target agent's reply message in a GET /api/im/messages response.
// The reply lands as a normal chat message (senderId === agent); the DM is
// fresh so the agent's first non-empty message is the answer to our prompt.
// Exported for unit test (apc/11 §0.17 gap #2 regression guard).
// apc/11 §0.17 gap #2 — this used to (a) never filter by message `type` and
// (b) return the FIRST agent-authored row in ASC order, so a stale
// `system_event` the agent emitted earlier (e.g. "no AgentProfile") was
// returned forever and the real reply was never seen. Fix: skip infrastructure
// types (`system_event`/`system`, per message.service.ts:621) and take the
// LATEST matching row (iterate in reverse — messages come back ASC by seq).
// `afterIso` (optional) anchors the reply to be strictly NEWER than the prompt
// just sent — without it, a reused DM's prior-run reply is returned on the
// first poll before the agent answers this prompt (falsely green mumble runs).
// `expectedTriggerMessageId` (optional, apc/11 §0.28 gap ②) is the STRONG bind:
// when given, only a reply whose metadata references THIS prompt's message id is
// accepted, so a cross-run stale reply (different trigger id) is refused even if
// its timestamp is newer than the anchor. dispatchSampleTask always passes it;
// the anchor-only path is kept for the pre-existing regression tests.
export function extractAgentReply(
  raw: unknown,
  agent: string,
  afterIso?: string | null,
  expectedTriggerMessageId?: string | null,
): string | null {
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
    // Strong bind: the reply must reference THIS dispatch's prompt. A stale
    // cross-run reply carries a different trigger id and is rejected here.
    if (expectedTriggerMessageId && !messageRepliesTo(msg, expectedTriggerMessageId)) continue;
    // Anchor: when a floor is given, only accept a reply created after the
    // prompt. A row missing/older-than the floor is a stale prior-run reply.
    if (!Number.isNaN(afterMs)) {
      const createdAt = typeof msg.createdAt === 'string' ? Date.parse(msg.createdAt) : NaN;
      if (Number.isNaN(createdAt) || createdAt <= afterMs) continue;
    }
    return content;
  }
  return null;
}

function printSkillTestReport(tasks: SkillTestTaskResult[], overallOk: boolean): void {
  process.stdout.write(`Skill test (${tasks.length} sample task(s))\n`);
  for (const t of tasks) {
    const runTag = t.runId ? ` run=${t.runId}` : '';
    process.stdout.write(`\n[task ${t.index}] status=${t.taskStatus}${runTag}  ${t.prompt.slice(0, 60)}\n`);
    if (t.taskStatus === 'dispatch_not_created') {
      process.stdout.write(
        '  ✗ no run was created for this prompt (agent unroutable / no profile / never dispatched) — not scored\n',
      );
    } else if (t.taskStatus === 'no_reply' || t.taskStatus === 'timeout') {
      process.stdout.write('  ✗ a run was created but produced no reply bound to this prompt — not scored\n');
    }
    if (t.results.length === 0) {
      process.stdout.write('  no acceptanceCriteria — task ran but is unscored\n');
    }
    const header = ['Criterion', 'Type', 'Required', 'Result', 'Error'];
    const rows = t.results.map((r) => [
      r.label,
      r.type,
      r.required ? 'yes' : 'no',
      r.pass ? 'PASS' : 'FAIL',
      r.error ?? '',
    ]);
    process.stdout.write(formatTable([header, ...rows]) + '\n');
  }
  process.stdout.write('\n');
  if (overallOk) process.stdout.write(`Skill test passed: ${tasks.length} task(s)\n`);
  else process.stderr.write('Skill test failed: one or more required criteria missed\n');
}
