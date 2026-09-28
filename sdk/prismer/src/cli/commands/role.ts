// `prismer role ...` — role-template ingest/apply lifecycle (SS-02).
//
// Companion to `prismer skill` (SS-01). Where `skill create` ingests a skill
// bundle, `role create` ingests a role template JSON and `role apply` projects
// it onto a live agent (installs requiredSkills + writes profile.config).
//
// product204/16 §2.2 — creation defaults to the PRIVATE domain:
//   • `role create` POSTs /role-templates/mine (owner-scoped private role, any
//     authenticated key). Going public is an EXPLICIT action: `--publish`
//     (create → POST /:slug/publish) or a later `role publish <slug>`.
//   • `--admin-catalog` keeps the old direct-to-public-catalog path (admin
//     email required server-side; non-admin gets 403).
// APPLY is admin OR the target agent's workspace owner. The CLI just surfaces
// the 403 — it does not pre-check.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { readRoleBundle, validateRoleBundle, BundleError } from '../../bundle/index.js';
import { exitWithError, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';
import { registerLifecycleCommands, ROLE_LIFECYCLE } from './lifecycle.js';
import { markCloudOwnedCompatibilityCommand } from '../shared/compatibility-warning.js';

interface RoleTemplate {
  id?: string;
  slug?: string;
  agentType?: string;
  taskAuthority?: string;
  category?: string;
  status?: string;
  requiredSkills?: unknown;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

export function buildRoleCommand(): Command {
  const cmd = new Command('role').description('Ingest and apply role templates (SS-02)');

  cmd
    .command('create <pathOrDir>')
    .description(
      'Ingest a SS-02 role as a PRIVATE role owned by the caller (POST /role-templates/mine — default, product204/16 §2.2). Accepts a single role.json OR a role bundle directory (role.json + optional SOUL.md → operatingPrinciples). Use --publish to also publish to the public Marketplace.',
    )
    .option('--mine', '(deprecated — private /mine is now the default) kept for backward compat')
    .option('--publish', 'After create, publish the role to the public Marketplace (POST /:slug/publish)')
    .option(
      '--admin-catalog',
      'Create directly on the admin public catalog path (POST /role-templates, admin email required)',
    )
    .option('--apply', 'Apply the new role to an agent after create')
    .option('--agent <imUserId>', 'Target agent for --apply')
    .option('--workspace-id <id>', 'Workspace scope for --apply')
    .option('--json', 'Output JSON')
    .action(
      runAction<
        [
          string,
          {
            mine?: boolean;
            publish?: boolean;
            adminCatalog?: boolean;
            apply?: boolean;
            agent?: string;
            workspaceId?: string;
            json?: boolean;
          },
        ]
      >(
        async (pathOrDir, opts) => {
          if (opts.apply && !opts.agent) {
            exitWithError('--apply requires --agent <imUserId>', { code: 'invalid_argument' });
          }
          let role: Record<string, unknown>;
          try {
            // file-or-dir: a directory bundle folds SOUL.md → operatingPrinciples.
            role = readRoleBundle(pathOrDir).role;
          } catch (err) {
            if (err instanceof BundleError) {
              exitWithError(err.message, { code: err.code });
            }
            exitWithError(`could not read role from ${pathOrDir}: ${(err as Error).message}`, {
              code: 'role_json_invalid',
            });
            return;
          }
          if (role.requiredSkills && !Array.isArray(role.requiredSkills)) {
            exitWithError('requiredSkills must be an array of { skillSlug, required }', {
              code: 'role_required_skills_shape',
            });
          }

          const cloud = mkCloud();
          // product204/16 §2.2 — DEFAULT is the owner-scoped PRIVATE path
          // (POST /role-templates/mine; any authenticated key). The admin
          // public-catalog path is opt-in via --admin-catalog.
          const useAdminCatalog = Boolean(opts.adminCatalog);
          const createPath = useAdminCatalog ? '/api/im/role-templates' : '/api/im/role-templates/mine';
          const created = await cloud.request<{ ok?: boolean; data?: RoleTemplate; error?: string }>(
            'POST',
            createPath,
            { body: role },
          );
          if (created.status === 403) {
            exitWithError(
              useAdminCatalog
                ? 'create returned 403 — API key does not map to an admin email (--admin-catalog is admin-only). Drop --admin-catalog for an owner-scoped private role.'
                : 'create returned 403 — API key does not resolve to an IM user (auth failed).',
              { code: 'role_create_forbidden' },
            );
          }
          if (created.status === 409) {
            exitWithError('role slug already exists (409). Use a new slug or update.', { code: 'role_slug_conflict' });
          }
          if (created.status !== 201 || created.data?.ok === false) {
            const msg = created.error?.message ?? created.data?.error ?? 'request failed';
            exitWithError(`create failed (${describeStatus(created.status)}): ${msg}`, { code: 'role_create_failed' });
          }
          const tpl = created.data?.data as RoleTemplate;
          const result: Record<string, unknown> = {
            slug: tpl?.slug,
            agentType: tpl?.agentType,
            taskAuthority: tpl?.taskAuthority,
            requiredSkills: Array.isArray(role.requiredSkills) ? role.requiredSkills.length : 0,
            domain: useAdminCatalog ? 'marketplace (admin catalog)' : 'workspace (private, in `cloud role mine`)',
            published: false as boolean | string,
            applied: false as boolean | string,
          };

          // --publish: explicit human action that takes the private role public
          // (16 §2.1 — 进公域是一个显式动作). Runs the server publish gate
          // (RO-11 completeness + RO-6 requiredSkills resolution).
          if (opts.publish && !useAdminCatalog) {
            const pub = await cloud.request<{
              ok?: boolean;
              data?: { pending?: boolean; approval?: { id?: string } };
              error?: string;
            }>(
              'POST',
              `/api/im/role-templates/${encodeURIComponent(tpl?.slug ?? '')}/publish`,
              { body: {} },
            );
            // product204/16 §2.1 — when the caller is an AGENT, publish is
            // DEFERRED to a human approval (HTTP 202 + pending). `--publish` is
            // a *request*, not an act — do NOT report it as published.
            if (pub.status === 202 || pub.data?.data?.pending) {
              result.published = `pending human approval (approval ${pub.data?.data?.approval?.id ?? '?'})`;
              result.domain = 'workspace (private) — publish awaiting Team Manager approval';
            } else if (pub.status >= 200 && pub.status < 300 && pub.data?.ok !== false) {
              result.published = true;
              result.domain = 'marketplace (published)';
            } else {
              result.publishError = `${describeStatus(pub.status)}: ${pub.error?.message ?? pub.data?.error ?? 'publish failed'}`;
            }
          } else if (opts.publish && useAdminCatalog) {
            result.published = 'n/a (--admin-catalog already lands public)';
          }

          if (opts.apply) {
            const apply = await cloud.request<{ ok?: boolean; error?: string }>(
              'POST',
              `/api/im/role-templates/${encodeURIComponent(tpl.slug ?? '')}/apply`,
              { body: { agentId: opts.agent, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) } },
            );
            if (apply.status >= 200 && apply.status < 300 && apply.data?.ok !== false) {
              result.applied = opts.agent ?? true;
            } else if (apply.status === 403) {
              result.applyError = '403 — need admin or the target agent workspace owner';
            } else {
              result.applyError = `${describeStatus(apply.status)}: ${apply.error?.message ?? apply.data?.error ?? 'apply failed'}`;
            }
          }

          if (opts.json) {
            printJson(result);
            return;
          }
          const ui = getUI();
          ui.ok('Role template ingested', String(result.slug));
          ui.line(`type=${result.agentType}  authority=${result.taskAuthority}  skills=${result.requiredSkills}  applied=${String(result.applied)}`);
          ui.line(`domain=${String(result.domain)}  published=${String(result.published)}`);
          if (result.publishError) ui.secondary(`publish error: ${String(result.publishError)}`);
          if (result.applyError) ui.secondary(`apply error: ${String(result.applyError)}`);
          ui.secondary(`verify: cloud role show ${result.slug}`);
        },
        { code: 'role_create_failed' },
      ),
    );

  // ── ② validate (dry-run, NO network) — doc 16 §5.2 / §5.4 ───────────────────
  cmd
    .command('validate <pathOrDir>')
    .description(
      'Dry-run validate a role: a single role.json OR a bundle dir (role.json present + valid; SOUL.md optional, non-empty if present). No network.',
    )
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (pathOrDir, opts) => {
        let bundle;
        try {
          bundle = readRoleBundle(pathOrDir);
        } catch (err) {
          if (err instanceof BundleError) {
            if (opts.json) {
              printJson({ ok: false, slug: null, errors: [err.message], warnings: [] });
              process.exit(1);
            }
            exitWithError(err.message, { code: err.code });
            return;
          }
          exitWithError(`could not read role from ${pathOrDir}: ${(err as Error).message}`, { code: 'role_json_invalid' });
          return;
        }
        const role = bundle.role;
        const v = validateRoleBundle(bundle);
        if (opts.json) {
          printJson({ ok: v.ok, slug: role.slug ?? null, bundleDir: bundle.isDir, soul: Boolean(bundle.soulMd), errors: v.errors, warnings: v.warnings });
          if (!v.ok) process.exit(1);
          return;
        }
        const ui = getUI();
        const shape = bundle.isDir ? (bundle.soulMd ? 'dir+SOUL.md' : 'dir') : 'role.json';
        if (v.ok) ui.ok('Role valid', `${String(role.slug ?? '')} (${shape})`);
        else ui.fail('Role invalid', `${v.errors.length} error(s)`);
        for (const e of v.errors) ui.line(`  ✗ ${e}`);
        for (const w of v.warnings) ui.secondary(`! ${w}`);
        if (!v.ok) process.exit(1);
      }, { code: 'role_validate_failed' }),
    );

  // ── test (network RO-6 resolution check) — product204/29 agent loop ─────────
  // `validate` is offline (shape only). `test` adds the NETWORK check that
  // actually matters before ingest: every requiredSkills[].skillSlug RESOLVES
  // in the live catalog (RO-6). Referencing a non-existent slug is the #1 role
  // failure mode — apply installs each one and a missing slug fails the install
  // mid-way. This lets the agent catch it pre-ingest, no sandbox needed.
  cmd
    .command('test <pathOrDir>')
    .description(
      'Test a role before ingest: dry-run validate (shape) + resolve every requiredSkills[].skillSlug against the live catalog (RO-6). Reports which slugs are missing. No sandbox/apply.',
    )
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (pathOrDir, opts) => {
        let bundle;
        try {
          bundle = readRoleBundle(pathOrDir);
        } catch (err) {
          if (err instanceof BundleError) {
            exitWithError(err.message, { code: err.code });
          }
          exitWithError(`could not read role from ${pathOrDir}: ${(err as Error).message}`, {
            code: 'role_json_invalid',
          });
          return;
        }
        const role = bundle.role;
        const v = validateRoleBundle(bundle);
        if (!v.ok) {
          if (opts.json) {
            printJson({ ok: false, shapeOk: false, errors: v.errors, skills: [] });
            process.exit(1);
            return;
          }
          getUI().fail('Role invalid (shape)', `${v.errors.length} error(s)`);
          for (const e of v.errors) getUI().line(`  ✗ ${e}`);
          process.exit(1);
          return;
        }

        const reqs = Array.isArray(role.requiredSkills) ? (role.requiredSkills as Array<{ skillSlug?: string }>) : [];
        const cloud = mkCloud();
        // `transient` = catalog was unreachable (network error status 0, 5xx, timeout),
        // NOT a real "skill missing" (which is a definitive 404). Conflating the two
        // tells the agent to rebuild an existing skill just because the gateway blipped.
        const skills: Array<{ slug: string; resolved: boolean; transient?: boolean; detail?: string }> = [];
        for (const r of reqs) {
          const slug = r?.skillSlug;
          if (!slug || typeof slug !== 'string') {
            skills.push({ slug: String(slug ?? '—'), resolved: false, detail: 'malformed skillSlug' });
            continue;
          }
          const res = await cloud.request<{ ok?: boolean }>('GET', `/api/im/skills/${encodeURIComponent(slug)}`);
          // 2xx = resolves; 404 = definitively missing; anything else (0/5xx/timeout) =
          // transient catalog failure → don't misreport as "missing, build it first".
          const resolved = res.status >= 200 && res.status < 300;
          const transient = !resolved && res.status !== 404;
          skills.push({
            slug,
            resolved,
            transient,
            detail: resolved ? undefined : describeStatus(res.status),
          });
        }
        const missing = skills.filter((s) => !s.resolved && !s.transient); // true 404s
        const unreachable = skills.filter((s) => s.transient); // catalog blips — retry, don't rebuild
        const ok = missing.length === 0 && unreachable.length === 0;
        if (opts.json) {
          printJson({
            ok,
            shapeOk: true,
            slug: role.slug ?? null,
            skills,
            missing: missing.map((m) => m.slug),
            unreachable: unreachable.map((m) => m.slug),
          });
          if (!ok) process.exit(unreachable.length > 0 && missing.length === 0 ? 2 : 1);
          return;
        }
        const ui = getUI();
        if (ok) {
          ui.ok('Role test passed', `${String(role.slug ?? '')} · ${skills.length} skill(s) all resolve`);
        } else if (missing.length === 0) {
          // Only transient failures — the role may well be fine; catalog was unreachable.
          ui.fail('Role test inconclusive', `${unreachable.length}/${skills.length} skill(s) — catalog unreachable`);
          for (const m of unreachable) ui.line(`  ? ${m.slug} (${m.detail ?? 'unreachable'}) — transient, retry; do NOT rebuild`);
          process.exit(2);
        } else {
          ui.fail('Role test failed', `${missing.length}/${skills.length} required skill(s) missing from catalog`);
          for (const m of missing) ui.line(`  ✗ ${m.slug} (${m.detail ?? 'not found'}) — build it first: cloud skill create, then re-test`);
          for (const m of unreachable) ui.line(`  ? ${m.slug} (${m.detail ?? 'unreachable'}) — transient, retry; do NOT rebuild`);
          process.exit(1);
        }
      }, { code: 'role_test_failed' }),
    );

  cmd
    .command('apply <slugOrId>')
    .description('Apply an existing role template to an agent (POST /role-templates/:slug/apply)')
    .requiredOption('--agent <imUserId>', 'Target agent IMUser.id')
    .option('--workspace-id <id>', 'Workspace scope')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { agent: string; workspaceId?: string; json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const apply = await cloud.request<{ ok?: boolean; data?: unknown; error?: string }>(
          'POST',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}/apply`,
          { body: { agentId: opts.agent, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) } },
        );
        if (apply.status === 403) {
          exitWithError('apply returned 403 — need admin or the target agent workspace owner.', {
            code: 'role_apply_forbidden',
          });
        }
        if (apply.status < 200 || apply.status >= 300 || apply.data?.ok === false) {
          const msg = apply.error?.message ?? apply.data?.error ?? 'request failed';
          exitWithError(`apply failed (${describeStatus(apply.status)}): ${msg}`, { code: 'role_apply_failed' });
        }
        if (opts.json) {
          printJson(apply.data?.data ?? { applied: opts.agent });
          return;
        }
        getUI().ok('Role applied', `role=${slugOrId} agent=${opts.agent}`);
      }, { code: 'role_apply_failed' }),
    );

  // ── edit an existing role (PATCH) — product204/29 agent loop ────────────────
  // The agent authoring loop needs EDIT, not just create: tweak
  // operatingPrinciples / scopes / skillConfig / requiredSkills on an existing
  // role (private draft OR already-published own asset — P0 fixed the latter's
  // owner lockout). Mirrors `create`'s bundle reading (role.json + SOUL.md fold)
  // so the same directory used to create can be re-used to edit. `--field
  // k=v` (repeatable) is the inline path for scalar/JSON tweaks without touching
  // files. `--publish` chains the edit into a marketplace publish (one agent
  // step: edit → publish), matching the unified 草稿→marketplace semantics.
  cmd
    .command('edit <slugOrId> [pathOrDir]')
    .description(
      'Edit an existing role (PATCH /role-templates/:slug). Accepts a role.json OR bundle dir (role.json + SOUL.md → operatingPrinciples), --field k=v inline overrides (repeatable; JSON value if it starts with { or [), or both. --publish chains a marketplace publish after the edit. Owner-of-role OR admin (product204/29).',
    )
    .option(
      '--field <key=value>',
      'Set a field inline (repeatable; value parsed as JSON if {/[ -prefixed)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--changelog <text>', 'Changelog for a content edit on a PUBLISHED role (server rejects content edits without it — fleet-wide propagation)')
    .option('--publish', 'After edit, publish to the public Marketplace (POST /:slug/publish)')
    .option('--json', 'Output JSON')
    .action(
      runAction<
        [string, string | undefined, { field?: string[]; changelog?: string; publish?: boolean; json?: boolean }]
      >(
        async (slugOrId, pathOrDir, opts) => {
          if (!pathOrDir && (!opts.field || opts.field.length === 0)) {
            exitWithError('edit needs either a <pathOrDir> or --field <key=value>', {
              code: 'invalid_argument',
            });
          }

          let body: Record<string, unknown> = {};
          if (pathOrDir) {
            try {
              body = readRoleBundle(pathOrDir).role;
            } catch (err) {
              if (err instanceof BundleError) {
                exitWithError(err.message, { code: err.code });
              }
              exitWithError(`could not read role from ${pathOrDir}: ${(err as Error).message}`, {
                code: 'role_json_invalid',
              });
              return;
            }
          }
          // Inline --field overrides win over file contents. Value is parsed as
          // JSON when it looks structural (object/array), else kept as a string —
          // so `--field taskAuthority=autonomous` and `--field skillConfig='{"memory":{}}'`
          // both work. slug/visibility/ownerAgentId/source are server-stripped for
          // non-admin (the PATCH route enforces it), so sending them is a no-op.
          for (const f of opts.field ?? []) {
            const eq = f.indexOf('=');
            if (eq <= 0) {
              exitWithError(`--field expects <key>=<value> (got "${f}")`, { code: 'invalid_argument' });
            }
            const key = f.slice(0, eq);
            const raw = f.slice(eq + 1);
            let val: unknown = raw;
            const trimmed = raw.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              try {
                val = JSON.parse(trimmed);
              } catch {
                // keep as string — server may still reject, but don't guess
              }
            }
            body[key] = val;
          }
          if (body.requiredSkills && !Array.isArray(body.requiredSkills)) {
            exitWithError('requiredSkills must be an array of { skillSlug, required }', {
              code: 'role_required_skills_shape',
            });
          }
          // Content edits on a PUBLISHED role propagate fleet-wide, so the server
          // requires a changelog (422 otherwise). Pass it through in the body.
          if (opts.changelog) body.changelog = opts.changelog;

          const cloud = mkCloud();
          const patched = await cloud.request<{ ok?: boolean; data?: RoleTemplate; error?: string }>(
            'PATCH',
            `/api/im/role-templates/${encodeURIComponent(slugOrId)}`,
            { body },
          );
          if (patched.status === 403) {
            exitWithError(
              'edit returned 403 — need the role owner or an admin (product204/29: owner keeps authority over their own asset, public or private).',
              { code: 'role_edit_forbidden' },
            );
          }
          if (patched.status === 404) {
            exitWithError(`role not found: ${slugOrId}`, { code: 'role_not_found' });
          }
          if (patched.status === 422) {
            const msg = patched.error?.message ?? patched.data?.error ?? 'standard violation';
            exitWithError(`edit rejected (422 STANDARD_VIOLATION): ${msg}`, {
              code: 'role_standard_violation',
            });
          }
          if (patched.status < 200 || patched.status >= 300 || patched.data?.ok === false) {
            const msg = patched.error?.message ?? patched.data?.error ?? 'request failed';
            exitWithError(`edit failed (${describeStatus(patched.status)}): ${msg}`, {
              code: 'role_edit_failed',
            });
          }
          const tpl = patched.data?.data as RoleTemplate | undefined;
          const result: Record<string, unknown> = {
            slug: tpl?.slug ?? slugOrId,
            edited: true,
            published: false as boolean | string,
          };

          if (opts.publish) {
            const pub = await cloud.request<{
              ok?: boolean;
              data?: { pending?: boolean; approval?: { id?: string } };
              error?: string;
            }>(
              'POST',
              `/api/im/role-templates/${encodeURIComponent(tpl?.slug ?? slugOrId)}/publish`,
              { body: {} },
            );
            if (pub.status === 202 || pub.data?.data?.pending) {
              result.published = `pending human approval (approval ${pub.data?.data?.approval?.id ?? '?'})`;
            } else if (pub.status >= 200 && pub.status < 300 && pub.data?.ok !== false) {
              result.published = true;
            } else {
              result.publishError = `${describeStatus(pub.status)}: ${pub.error?.message ?? pub.data?.error ?? 'publish failed'}`;
            }
          }

          if (opts.json) {
            printJson(result);
            return;
          }
          const ui = getUI();
          ui.ok('Role edited', String(result.slug));
          if (opts.publish) {
            ui.line(`published=${String(result.published)}`);
            if (result.publishError) ui.secondary(`publish error: ${String(result.publishError)}`);
          }
          ui.secondary(`verify: cloud role show ${result.slug}`);
        },
        { code: 'role_edit_failed' },
      ),
    );

  cmd
    .command('list')
    .description('List role templates')
    .option('--category <name>', 'Filter by category')
    .option('--agent-type <type>', 'Filter by agentType')
    .option('--status <status>', 'Filter by status')
    .option('--json', 'Output JSON')
    .action(
      runAction<[{ category?: string; agentType?: string; status?: string; json?: boolean }]>(async (opts) => {
        const cloud = mkCloud();
        const params = new URLSearchParams();
        if (opts.category) params.set('category', opts.category);
        if (opts.agentType) params.set('agentType', opts.agentType);
        if (opts.status) params.set('status', opts.status);
        const qs = params.toString();
        const data = await cloud.get<RoleTemplate[]>(`/api/im/role-templates${qs ? `?${qs}` : ''}`);
        if (opts.json) {
          printJson(data);
          return;
        }
        const ui = getUI();
        ui.header(`Role templates (${data.length})`);
        ui.table(
          data.map((t) => ({
            slug: t.slug ?? '—',
            type: t.agentType ?? '—',
            authority: t.taskAuthority ?? '—',
            category: t.category ?? '—',
            status: t.status ?? '—',
          })),
          { columns: ['slug', 'type', 'authority', 'category', 'status'] },
        );
      }, { code: 'role_list_failed' }),
    );

  cmd
    .command('mine')
    .description("List the caller's own private role templates (GET /role-templates/mine)")
    .option('--json', 'Output JSON')
    .action(
      runAction<[{ json?: boolean }]>(async (opts) => {
        const cloud = mkCloud();
        const data = await cloud.get<RoleTemplate[]>('/api/im/role-templates/mine');
        if (opts.json) {
          printJson(data);
          return;
        }
        const ui = getUI();
        ui.header(`My role templates (${data.length})`);
        ui.table(
          data.map((t) => ({
            slug: t.slug ?? '—',
            type: t.agentType ?? '—',
            status: t.status ?? '—',
          })),
          { columns: ['slug', 'type', 'status'] },
        );
      }, { code: 'role_mine_failed' }),
    );

  cmd
    .command('publish <slugOrId>')
    .description('Publish a private role to the public Marketplace (POST /role-templates/:slug/publish)')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId, opts) => {
        const cloud = mkCloud();
        const res = await cloud.request<{
          ok?: boolean;
          // product204/16 §2.1 — agent publish returns HTTP 202 + { pending, approval }.
          data?: (RoleTemplate & { pending?: boolean; approval?: { id?: string } }) | { pending?: boolean; approval?: { id?: string } };
          error?: string;
        }>(
          'POST',
          `/api/im/role-templates/${encodeURIComponent(slugOrId)}/publish`,
          { body: {} },
        );
        if (res.status === 403) {
          exitWithError('publish returned 403 — need the private-role owner or an admin.', {
            code: 'role_publish_forbidden',
          });
        }
        if (res.status < 200 || res.status >= 300 || res.data?.ok === false) {
          const msg = res.error?.message ?? res.data?.error ?? 'request failed';
          exitWithError(`publish failed (${describeStatus(res.status)}): ${msg}`, { code: 'role_publish_failed' });
        }
        // product204/16 §2.1 — agent publish awaits the Team Manager's approval, not done.
        if (res.status === 202 || (res.data?.data as { pending?: boolean })?.pending) {
          const approvalId = (res.data?.data as { approval?: { id?: string } })?.approval?.id ?? '?';
          if (opts.json) {
            printJson(res.data?.data ?? { pending: true });
            return;
          }
          getUI().ok('Publish requested — awaiting human approval', String(slugOrId));
          getUI().secondary(`the workspace owner must approve it in their 待审区 (approval ${approvalId}) before it goes public`);
          return;
        }
        if (opts.json) {
          printJson(res.data?.data ?? {});
          return;
        }
        getUI().ok('Role published to public', String((res.data?.data as RoleTemplate)?.slug ?? slugOrId));
      }, { code: 'role_publish_failed' }),
    );

  // product204/16 §2.5 — crystallize a live agent's persona into a role bundle.
  // GET /agents/:id/role-bundle returns { role (SS-02) + soulMd } built from the
  // RAW operatingPrinciples (no runtime-injected clauses → no round-trip
  // stacking). --ingest lands it as a PRIVATE role via POST /role-templates/mine.
  cmd
    .command('export <agentImUserId>')
    .description(
      "Export a live agent's persona as a role bundle (GET /agents/:id/role-bundle). --out <dir> writes role.json + SOUL.md; --ingest creates a private role from it (POST /role-templates/mine).",
    )
    .option('--workspace-id <id>', 'Workspace scope (defaults to the agent card workspace)')
    .option('--out <dir>', 'Write role.json (+ SOUL.md when present) into <dir>')
    .option('--ingest', 'Ingest the exported bundle as a PRIVATE role owned by the caller')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { workspaceId?: string; out?: string; ingest?: boolean; json?: boolean }]>(
        async (agentImUserId, opts) => {
          const cloud = mkCloud();
          const qs = opts.workspaceId ? `?workspaceId=${encodeURIComponent(opts.workspaceId)}` : '';
          const res = await cloud.request<{
            ok?: boolean;
            data?: { role: Record<string, unknown>; soulMd: string | null; source: Record<string, unknown> };
            error?: string;
          }>('GET', `/api/im/agents/${encodeURIComponent(agentImUserId)}/role-bundle${qs}`);
          if (res.status < 200 || res.status >= 300 || res.data?.ok === false || !res.data?.data) {
            const msg = res.error?.message ?? res.data?.error ?? 'request failed';
            exitWithError(`export failed (${describeStatus(res.status)}): ${msg}`, { code: 'role_export_failed' });
            return;
          }
          const bundle = res.data.data;
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
            const created = await cloud.request<{ ok?: boolean; data?: RoleTemplate; error?: string }>(
              'POST',
              '/api/im/role-templates/mine',
              { body: bundle.role },
            );
            if (created.status === 409) {
              exitWithError(`ingest failed: role slug ${String(bundle.role.slug)} already exists (409).`, {
                code: 'role_slug_conflict',
              });
            }
            if (created.status !== 201 || created.data?.ok === false) {
              const msg = created.error?.message ?? created.data?.error ?? 'request failed';
              exitWithError(`ingest failed (${describeStatus(created.status)}): ${msg}`, {
                code: 'role_export_ingest_failed',
              });
            }
            result.ingested = String(created.data?.data?.slug ?? bundle.role.slug);
          }

          if (opts.json) {
            printJson({ ...result, role: bundle.role, soulMd: bundle.soulMd });
            return;
          }
          const ui = getUI();
          ui.ok('Role bundle exported', String(result.slug));
          ui.line(`soul=${String(result.soul)}  skills=${String(result.requiredSkills)}  ingested=${String(result.ingested)}${result.out ? `  out=${String(result.out)}` : ''}`);
          if (result.ingested) ui.secondary(`verify: cloud role mine`);
        },
        { code: 'role_export_failed' },
      ),
    );

  cmd
    .command('show <slugOrId>')
    .description('Show a role template detail record')
    .option('--json', 'Output JSON (default)')
    .action(
      runAction<[string, { json?: boolean }]>(async (slugOrId) => {
        const cloud = mkCloud();
        const data = await cloud.get<RoleTemplate>(`/api/im/role-templates/${encodeURIComponent(slugOrId)}`);
        printJson(data);
      }, { code: 'role_show_failed' }),
    );

  // ── draft (owner-scoped private tier) — discoverability parity with skill ───
  // `cloud skill draft create` is the review-gated draft tier for skills; roles
  // have no review gate, but authors still reach for `role draft create` by
  // muscle-memory. This is that command: a clear, discoverable ALIAS for the
  // private/owner-scoped create (`role create --mine`). It hits the SAME
  // POST /api/im/role-templates/mine endpoint → visibility=private + status=active
  // (the role "draft" state). Going public is a separate explicit step:
  // `cloud role publish <slug>`.
  const draft = cmd
    .command('draft')
    .description('Draft tier — a PRIVATE role you own (visibility=private, status=active), later published with `cloud role publish`.');
  draft
    .command('create <pathOrDir>')
    .description(
      'Create a PRIVATE role you own (POST /role-templates/mine → visibility=private, status=active). ' +
        'Alias for `cloud role create --mine`: the role lands in your Studio `/mine` (`cloud role mine`), editable, then publishable via `cloud role publish <slug>`. ' +
        'Accepts a single role.json OR a role bundle directory (role.json + optional SOUL.md → operatingPrinciples).',
    )
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, { json?: boolean }]>(async (pathOrDir, opts) => {
        let role: Record<string, unknown>;
        try {
          role = readRoleBundle(pathOrDir).role;
        } catch (err) {
          if (err instanceof BundleError) {
            exitWithError(err.message, { code: err.code });
          }
          exitWithError(`could not read role from ${pathOrDir}: ${(err as Error).message}`, {
            code: 'role_json_invalid',
          });
          return;
        }
        if (role.requiredSkills && !Array.isArray(role.requiredSkills)) {
          exitWithError('requiredSkills must be an array of { skillSlug, required }', {
            code: 'role_required_skills_shape',
          });
        }
        const cloud = mkCloud();
        // Same endpoint as `create` (non-admin path): owner-scoped PRIVATE role.
        const created = await cloud.request<{ ok?: boolean; data?: RoleTemplate; error?: string }>(
          'POST',
          '/api/im/role-templates/mine',
          { body: role },
        );
        if (created.status === 403) {
          exitWithError('draft create returned 403 — API key does not resolve to an IM user (auth failed).', {
            code: 'role_create_forbidden',
          });
        }
        if (created.status === 409) {
          exitWithError('role slug already exists (409). Use a new slug or `cloud role edit`.', {
            code: 'role_slug_conflict',
          });
        }
        if (created.status !== 201 || created.data?.ok === false) {
          const msg = created.error?.message ?? created.data?.error ?? 'request failed';
          exitWithError(`draft create failed (${describeStatus(created.status)}): ${msg}`, {
            code: 'role_create_failed',
          });
        }
        const tpl = created.data?.data as RoleTemplate;
        const result = {
          slug: tpl?.slug,
          agentType: tpl?.agentType,
          taskAuthority: tpl?.taskAuthority,
          visibility: 'private',
          status: 'active',
          domain: 'workspace (private draft, in `cloud role mine`)',
        };
        if (opts.json) {
          printJson(result);
          return;
        }
        const ui = getUI();
        ui.ok('Role draft created (private)', String(result.slug));
        ui.line(`type=${result.agentType}  authority=${result.taskAuthority}  visibility=private  status=active`);
        ui.secondary(`publish it later: cloud role publish ${result.slug}`);
        ui.secondary(`verify: cloud role show ${result.slug}`);
      }, { code: 'role_create_failed' }),
    );

  // product204/21 (M-P W3) — publish-governance verbs: delist / relist /
  // deprecate / undeprecate / archive / transfer* / published. Same factory as
  // `prismer skill`; role archive routes through DELETE (which is a soft
  // archive), and a PUBLIC role must be delisted before it can be archived.
  registerLifecycleCommands(cmd, ROLE_LIFECYCLE('prismer role'), mkCloud);

  return markCloudOwnedCompatibilityCommand(cmd);
}
