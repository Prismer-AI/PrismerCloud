// `cloud role ...` — role-template ingest/apply lifecycle (SS-02).
//
// Agent-facing port of `prismer role` (the `role` namespace previously existed
// only on the daemon CLI). Companion to `cloud skill` (SS-01). Where `skill
// create` ingests a skill bundle, `role create` ingests a role template JSON and
// `role apply` projects it onto a live agent (installs requiredSkills + writes
// profile.config).
//
// product204/16 §2.2 — creation defaults to the PRIVATE domain:
//   • `role create` POSTs /role-templates/mine (owner-scoped private role, any
//     authenticated key). Going public is an EXPLICIT action: `--publish`
//     (create → POST /:slug/publish) or a later `role publish <slug>`.
//   • `--admin-catalog` keeps the old direct-to-public-catalog path (admin
//     email required server-side; non-admin gets a 403).
// APPLY is admin OR the target agent's workspace owner. The CLI just surfaces the
// server error — it does not pre-check.
//
// Unlike the daemon CloudClient (which returns an HTTP-result wrapper exposing
// `.status`), the cloud `client.im.request<T>()` returns the PARSED RESPONSE BODY
// directly. So we inspect the `{ ok, data, error }` envelope instead of HTTP
// status codes, and surface `error.message` best-effort.

import { Command } from 'commander';
import { PrismerClient } from '../index';
// Pure-local role authoring validation is owned by the Cloud CLI. Runtime keeps
// an independent compatibility implementation, so neither package imports the
// other's source tree.
import { readRoleBundle, validateRoleBundle, BundleError } from '../internal/bundle/index';
import { registerLifecycleCommands } from './lifecycle';

type ClientFactory = () => PrismerClient;

interface RoleTemplate {
  id?: string;
  slug?: string;
  agentType?: string;
  taskAuthority?: string;
  category?: string;
  status?: string;
  requiredSkills?: unknown;
}

interface RoleEnvelope<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string | { code?: string; message?: string };
}

type SkillResolutionEnvelope = RoleEnvelope<Record<string, unknown>>;

function roleError(res: RoleEnvelope, fallback: string): string {
  return typeof res.error === 'string' ? res.error : (res.error?.message ?? fallback);
}

function collectField(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const role = parent.command('role').description('Ingest and apply role templates (SS-02)');

  role
    .command('create <pathOrDir>')
    .description(
      'Ingest a SS-02 role.json or role bundle directory as a PRIVATE role owned by the caller (POST /role-templates/mine — default). Use --publish to also publish to the public Marketplace, --admin-catalog for the admin direct-to-public path.',
    )
    .option('--mine', '(deprecated — private /mine is now the default) kept for backward compat')
    .option('--publish', 'After create, publish the role to the public Marketplace (POST /:slug/publish)')
    .option('--admin-catalog', 'Create directly on the admin public catalog path (admin email required)')
    .option('--apply', 'Apply the new role to an agent after create')
    .option('--agent <imUserId>', 'Target agent for --apply')
    .option('--workspace-id <id>', 'Workspace scope for --apply')
    .option('--json', 'Output JSON')
    .action(
      async (
        pathOrDir: string,
        opts: {
          mine?: boolean;
          publish?: boolean;
          adminCatalog?: boolean;
          apply?: boolean;
          agent?: string;
          workspaceId?: string;
          json?: boolean;
        },
      ) => {
        if (opts.apply && !opts.agent) {
          process.stderr.write('Error: --apply requires --agent <imUserId>\n');
          process.exit(1);
        }

        let bundle;
        try {
          bundle = readRoleBundle(pathOrDir);
        } catch (err) {
          process.stderr.write(`Error: could not read role from ${pathOrDir}: ${(err as Error).message}\n`);
          process.exit(1);
          return;
        }
        const validation = validateRoleBundle(bundle);
        if (!validation.ok) {
          process.stderr.write(`Error: role invalid: ${validation.errors.join('; ')}\n`);
          process.exit(1);
          return;
        }
        const role = bundle.role;
        if (role.requiredSkills && !Array.isArray(role.requiredSkills)) {
          process.stderr.write('Error: requiredSkills must be an array of { skillSlug, required }\n');
          process.exit(1);
        }

        const client = getIMClient();
        try {
          // product204/16 §2.2 — DEFAULT is the owner-scoped PRIVATE path
          // (/role-templates/mine; any authenticated key). The admin public
          // catalog path is opt-in via --admin-catalog.
          const useAdminCatalog = Boolean(opts.adminCatalog);
          const created = await client.im.request<RoleEnvelope<RoleTemplate>>(
            'POST',
            useAdminCatalog ? '/api/im/role-templates' : '/api/im/role-templates/mine',
            role,
          );
          if (!created.ok || !created.data) {
            const msg =
              roleError(created, '') ||
              (useAdminCatalog
                ? 'create failed (--admin-catalog is admin-only — API key must map to an admin email; slug may already exist)'
                : 'create failed (API key does not resolve to an IM user, or slug already exists)');
            process.stderr.write(`Error: ${msg}\n`);
            process.exit(1);
          }
          const tpl = created.data;
          const result: Record<string, unknown> = {
            slug: tpl?.slug,
            agentType: tpl?.agentType,
            taskAuthority: tpl?.taskAuthority,
            requiredSkills: Array.isArray(role.requiredSkills) ? role.requiredSkills.length : 0,
            domain: useAdminCatalog ? 'marketplace (admin catalog)' : 'workspace (private, in `cloud role mine`)',
            published: false as boolean | string,
            applied: false as boolean | string,
          };

          // --publish: the explicit human action that takes the private role
          // public (16 §2.1). Runs the server publish gate (RO-11 + RO-6).
          if (opts.publish && !useAdminCatalog) {
            const pub = await client.im.request<RoleEnvelope>(
              'POST',
              `/api/im/role-templates/${encodeURIComponent(tpl?.slug ?? '')}/publish`,
              {},
            );
            if (pub.ok && pub.data) {
              result.published = true;
              result.domain = 'marketplace (published)';
            } else {
              result.publishError = roleError(pub, 'publish failed');
            }
          } else if (opts.publish && useAdminCatalog) {
            result.published = 'n/a (--admin-catalog already lands public)';
          }

          if (opts.apply) {
            const apply = await client.im.request<RoleEnvelope>(
              'POST',
              `/api/im/role-templates/${encodeURIComponent(tpl.slug ?? '')}/apply`,
              { agentId: opts.agent, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
            );
            if (apply.ok && apply.data) {
              result.applied = opts.agent ?? true;
            } else {
              result.applyError = roleError(apply, 'apply failed (need admin or the target agent workspace owner)');
            }
          }

          if (opts.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            if (result.publishError || result.applyError) process.exit(1);
            return;
          }
          process.stdout.write(`Role template ingested: ${String(result.slug)}\n`);
          process.stdout.write(
            `type=${result.agentType}  authority=${result.taskAuthority}  skills=${result.requiredSkills}  applied=${String(result.applied)}\n`,
          );
          process.stdout.write(`domain=${String(result.domain)}  published=${String(result.published)}\n`);
          if (result.publishError) process.stdout.write(`publish error: ${String(result.publishError)}\n`);
          if (result.applyError) process.stdout.write(`apply error: ${String(result.applyError)}\n`);
          process.stdout.write(`verify: cloud role show ${String(result.slug)}\n`);
          if (result.publishError || result.applyError) process.exit(1);
        } catch (err: unknown) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      },
    );

  // ── role validate <pathOrDir> — dry-run, NO network ─────────────────────────
  // Agent-facing port of `prismer role validate`. Pure-local via the shared
  // bundle lib. Accepts a single role.json OR a role bundle directory (role.json
  // + optional SOUL.md → operatingPrinciples, per release203/16 P4). Exit 1 on
  // invalid.
  role
    .command('validate <pathOrDir>')
    .description(
      'Dry-run validate a role: a single role.json OR a bundle dir (role.json present + valid; SOUL.md optional, non-empty if present). No network.',
    )
    .option('--json', 'Output JSON')
    .action((pathOrDir: string, opts: { json?: boolean }) => {
      let bundle;
      try {
        bundle = readRoleBundle(pathOrDir);
      } catch (err) {
        const message =
          err instanceof BundleError ? err.message : `could not read role from ${pathOrDir}: ${(err as Error).message}`;
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, slug: null, errors: [message], warnings: [] }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`Error: ${message}\n`);
        }
        process.exit(1);
        return;
      }
      const roleObj = bundle.role;
      const v = validateRoleBundle(bundle);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: v.ok,
              slug: roleObj.slug ?? null,
              bundleDir: bundle.isDir,
              soul: Boolean(bundle.soulMd),
              errors: v.errors,
              warnings: v.warnings,
            },
            null,
            2,
          ) + '\n',
        );
        if (!v.ok) process.exit(1);
        return;
      }
      const shape = bundle.isDir ? (bundle.soulMd ? 'dir+SOUL.md' : 'dir') : 'role.json';
      if (v.ok) {
        process.stdout.write(`Role valid: ${String(roleObj.slug ?? '')} (${shape})\n`);
      } else {
        process.stderr.write(`Role invalid: ${v.errors.length} error(s)\n`);
      }
      for (const e of v.errors) process.stderr.write(`  ✗ ${e}\n`);
      for (const w of v.warnings) process.stdout.write(`  ! ${w}\n`);
      if (!v.ok) process.exit(1);
    });

  role
    .command('test <pathOrDir>')
    .description(
      'Read-only preflight: validate the role bundle and resolve every required skill. Does not apply the role or mutate an agent.',
    )
    .option('--json', 'Output JSON')
    .action(async (pathOrDir: string, opts: { json?: boolean }) => {
      let bundle;
      try {
        bundle = readRoleBundle(pathOrDir);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
        return;
      }
      const validation = validateRoleBundle(bundle);
      if (!validation.ok) {
        const result = { ok: false, shapeOk: false, errors: validation.errors, skills: [] };
        if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else process.stderr.write(`Role invalid: ${validation.errors.join('; ')}\n`);
        process.exit(1);
        return;
      }

      const client = getIMClient();
      const required = Array.isArray(bundle.role.requiredSkills)
        ? (bundle.role.requiredSkills as Array<{ skillSlug?: string }>)
        : [];
      const skills: Array<{ slug: string; resolved: boolean; transient?: boolean; detail?: string }> = [];
      for (const item of required) {
        const slug = item?.skillSlug;
        if (!slug) {
          skills.push({ slug: '—', resolved: false, detail: 'malformed skillSlug' });
          continue;
        }
        const res = await client.im.request<SkillResolutionEnvelope>(
          'GET',
          `/api/im/skills/${encodeURIComponent(slug)}`,
        );
        const resolved = res.ok !== false && Boolean(res.data);
        const detail = resolved ? undefined : roleError(res, 'skill resolution failed');
        const code = typeof res.error === 'object' ? res.error?.code : undefined;
        const missing = !resolved && /not.?found/i.test(`${code ?? ''} ${detail ?? ''}`);
        skills.push({ slug, resolved, ...(!resolved && !missing ? { transient: true } : {}), detail });
      }
      const missing = skills.filter((item) => !item.resolved && !item.transient);
      const unreachable = skills.filter((item) => item.transient);
      const ok = missing.length === 0 && unreachable.length === 0;
      const result = {
        ok,
        shapeOk: true,
        slug: bundle.role.slug ?? null,
        skills,
        missing: missing.map((item) => item.slug),
        unreachable: unreachable.map((item) => item.slug),
      };
      if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      else if (ok)
        process.stdout.write(`Role test passed: ${String(bundle.role.slug)} · ${skills.length} skill(s) resolve\n`);
      else {
        process.stderr.write(
          `Role test failed: missing=${result.missing.join(',') || 'none'} unreachable=${result.unreachable.join(',') || 'none'}\n`,
        );
      }
      if (!ok) process.exit(unreachable.length > 0 && missing.length === 0 ? 2 : 1);
    });

  role
    .command('apply <slugOrId>')
    .description('Apply an existing role template to an agent (POST /role-templates/:slug/apply)')
    .requiredOption('--agent <imUserId>', 'Target agent IMUser.id')
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--json', 'Output JSON')
    .action(async (slugOrId: string, opts: { agent: string; workspaceId?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const apply = await client.im.request<RoleEnvelope>(
          'POST',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}/apply`,
          { agentId: opts.agent, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
        );
        if (!apply.ok || !apply.data) {
          const msg = roleError(apply, 'apply failed (need admin or the target agent workspace owner)');
          process.stderr.write(`Error: ${msg}\n`);
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(apply.data ?? { applied: opts.agent }, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Role applied: role=${slugOrId} agent=${opts.agent}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  role
    .command('edit <slugOrId> [pathOrDir]')
    .description('Edit an owned role from a bundle and/or repeatable --field key=value overrides')
    .option('--field <key=value>', 'inline field override; JSON objects/arrays are parsed', collectField, [])
    .option('--changelog <text>', 'required by the server for live content changes')
    .option('--publish', 'publish after a successful edit')
    .option('--json', 'Output JSON')
    .action(
      async (
        slugOrId: string,
        pathOrDir: string | undefined,
        opts: { field: string[]; changelog?: string; publish?: boolean; json?: boolean },
      ) => {
        let body: Record<string, unknown> = {};
        if (pathOrDir) {
          try {
            body = readRoleBundle(pathOrDir).role;
          } catch (err) {
            process.stderr.write(`Error: ${(err as Error).message}\n`);
            process.exit(1);
            return;
          }
        }
        for (const assignment of opts.field) {
          const split = assignment.indexOf('=');
          if (split <= 0) {
            process.stderr.write(`Error: --field expects key=value, got ${assignment}\n`);
            process.exit(1);
            return;
          }
          const key = assignment.slice(0, split);
          const raw = assignment.slice(split + 1);
          if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
              body[key] = JSON.parse(raw);
            } catch (err) {
              process.stderr.write(`Error: --field ${key} has invalid JSON: ${(err as Error).message}\n`);
              process.exit(1);
              return;
            }
          } else {
            body[key] = raw;
          }
        }
        if (!pathOrDir && opts.field.length === 0) {
          process.stderr.write('Error: role edit requires a bundle path and/or --field key=value\n');
          process.exit(1);
          return;
        }
        if (opts.changelog) body.changelog = opts.changelog;

        const client = getIMClient();
        const patched = await client.im.request<RoleEnvelope<RoleTemplate>>(
          'PATCH',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}`,
          body,
        );
        if (!patched.ok || !patched.data) {
          process.stderr.write(`Error: ${roleError(patched, 'role edit failed')}\n`);
          process.exit(1);
          return;
        }
        let published: unknown = false;
        if (opts.publish) {
          const result = await client.im.request<RoleEnvelope>(
            'POST',
            `/api/im/role-templates/${encodeURIComponent(slugOrId)}/publish`,
            {},
          );
          if (!result.ok) {
            process.stderr.write(`Error: role edited, but publish failed: ${roleError(result, 'publish failed')}\n`);
            process.exit(1);
            return;
          }
          published = result.data ?? true;
        }
        const result = { role: patched.data, published };
        if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else process.stdout.write(`Role edited: ${patched.data.slug ?? slugOrId}\n`);
      },
    );

  role
    .command('list')
    .description('List role templates')
    .option('--category <name>', 'Filter by category')
    .option('--agent-type <type>', 'Filter by agentType')
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output JSON')
    .action(async (opts: { category?: string; agentType?: string; status?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const query: Record<string, string> = {};
        if (opts.category) query.category = opts.category;
        if (opts.agentType) query.agentType = opts.agentType;
        if (opts.status) query.status = opts.status;
        const res = await client.im.request<RoleEnvelope<RoleTemplate[]>>(
          'GET',
          '/api/im/role-templates',
          undefined,
          query,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${roleError(res, 'list failed')}\n`);
          process.exit(1);
        }
        const data = res.data ?? [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Role templates (${data.length})\n`);
        for (const t of data) {
          process.stdout.write(
            `  ${t.slug ?? '—'}\ttype=${t.agentType ?? '—'}\tauthority=${t.taskAuthority ?? '—'}\tcategory=${t.category ?? '—'}\tstatus=${t.status ?? '—'}\n`,
          );
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // product204/16 §2.2 — private-domain companions to the /mine-default create.
  role
    .command('mine')
    .description("List the caller's own private role templates (GET /role-templates/mine)")
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<RoleEnvelope<RoleTemplate[]>>('GET', '/api/im/role-templates/mine');
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${roleError(res, 'mine failed')}\n`);
          process.exit(1);
        }
        const data = res.data ?? [];
        if (opts.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
          return;
        }
        process.stdout.write(`My role templates (${data.length})\n`);
        for (const t of data) {
          process.stdout.write(`  ${t.slug ?? '—'}\ttype=${t.agentType ?? '—'}\tstatus=${t.status ?? '—'}\n`);
        }
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  role
    .command('publish <slugOrId>')
    .description('Publish a private role to the public Marketplace (POST /role-templates/:slug/publish)')
    .option('--json', 'Output JSON')
    .action(async (slugOrId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<RoleEnvelope<RoleTemplate>>(
          'POST',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}/publish`,
          {},
        );
        if (!res.ok || !res.data) {
          process.stderr.write(
            `Error: ${roleError(res, 'publish failed (need the private-role owner or an admin)')}\n`,
          );
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(res.data ?? {}, null, 2) + '\n');
          return;
        }
        process.stdout.write(`Role published to public: ${String(res.data?.slug ?? slugOrId)}\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // product204/16 §2.5 — crystallize a live agent's persona into a role bundle
  // (GET /agents/:id/role-bundle; RAW SOUL, no runtime-injected clauses).
  role
    .command('export <agentImUserId>')
    .description(
      "Export a live agent's persona as a role bundle. --out <dir> writes role.json + SOUL.md; --ingest creates a private role from it (POST /role-templates/mine).",
    )
    .option('--workspace-id <id>', 'Workspace scope (defaults to the agent card workspace)')
    .option('--out <dir>', 'Write role.json (+ SOUL.md when present) into <dir>')
    .option('--ingest', 'Ingest the exported bundle as a PRIVATE role owned by the caller')
    .option('--json', 'Output JSON')
    .action(
      async (agentImUserId: string, opts: { workspaceId?: string; out?: string; ingest?: boolean; json?: boolean }) => {
        const client = getIMClient();
        try {
          const res = await client.im.request<
            RoleEnvelope<{ role: Record<string, unknown>; soulMd: string | null; source: Record<string, unknown> }>
          >(
            'GET',
            `/api/im/agents/${encodeURIComponent(agentImUserId)}/role-bundle`,
            undefined,
            opts.workspaceId ? { workspaceId: opts.workspaceId } : undefined,
          );
          if (!res.ok || !res.data) {
            process.stderr.write(`Error: ${roleError(res, 'export failed')}\n`);
            process.exit(1);
            return;
          }
          const bundle = res.data;
          const result: Record<string, unknown> = {
            slug: bundle.role.slug,
            soul: Boolean(bundle.soulMd),
            requiredSkills: Array.isArray(bundle.role.requiredSkills) ? bundle.role.requiredSkills.length : 0,
            ingested: false as boolean | string,
          };

          if (opts.out) {
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            mkdirSync(opts.out, { recursive: true });
            writeFileSync(join(opts.out, 'role.json'), JSON.stringify(bundle.role, null, 2) + '\n');
            if (bundle.soulMd) writeFileSync(join(opts.out, 'SOUL.md'), bundle.soulMd);
            result.out = opts.out;
          }

          if (opts.ingest) {
            const created = await client.im.request<RoleEnvelope<RoleTemplate>>(
              'POST',
              '/api/im/role-templates/mine',
              bundle.role,
            );
            if (!created.ok || !created.data) {
              process.stderr.write(
                `Error: ingest failed — ${roleError(created, 'slug may already exist (use a fresh slug in role.json)')}\n`,
              );
              process.exit(1);
            }
            result.ingested = String(created.data?.slug ?? bundle.role.slug);
          }

          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ...result, role: bundle.role, soulMd: bundle.soulMd }, null, 2) + '\n',
            );
            return;
          }
          process.stdout.write(`Role bundle exported: ${String(result.slug)}\n`);
          process.stdout.write(
            `soul=${String(result.soul)}  skills=${String(result.requiredSkills)}  ingested=${String(result.ingested)}${result.out ? `  out=${String(result.out)}` : ''}\n`,
          );
          if (result.ingested) process.stdout.write('verify: cloud role mine\n');
        } catch (err: unknown) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      },
    );

  role
    .command('show <slugOrId>')
    .description('Show a role template detail record')
    .option('--json', 'Output JSON (default)')
    .action(async (slugOrId: string, _opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<RoleEnvelope<RoleTemplate>>(
          'GET',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}`,
        );
        if (!res.ok || !res.data) {
          process.stderr.write(`Error: ${roleError(res, 'show failed')}\n`);
          process.exit(1);
        }
        process.stdout.write(JSON.stringify(res.data, null, 2) + '\n');
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // product204/21 (M-P W3) — publish-governance verbs: delist / relist /
  // deprecate / undeprecate / archive / transfer* / published. Same factory as
  // `cloud skill`; role archive routes through DELETE (a soft archive), and a
  // PUBLIC role must be delisted before it can be archived.
  registerLifecycleCommands(role, 'role', getIMClient);
}
