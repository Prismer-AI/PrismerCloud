// `prismer config (show|set|path)` — inspect and tweak ~/.prismer/config.toml.
//
// `show` prints the active config (api_key redacted unless --reveal). `set`
// updates a single field (`cloud_api_base`, `api_key`, or `daemon_id`) and
// rewrites the TOML in place. `path` prints the resolved file path so callers
// can `cat`/`open` it from a shell without remembering the location.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { configExists, loadConfig, resolvePaths, saveConfig, type Config } from '../../config.js';
import { exitWithError, normalizeCloudUrl, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

const SETTABLE_KEYS = ['cloud_api_base', 'api_key', 'daemon_id'] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

function redactApiKey(key: string): string {
  if (!key.startsWith('sk-prismer-')) return '***';
  return `${key.slice(0, 16)}…${key.slice(-4)}`;
}

export function buildConfigCommand(): Command {
  const cmd = new Command('config').description('Inspect and edit ~/.prismer/config.toml');

  cmd
    .command('path')
    .description('Print the resolved config file path')
    .option('--json', 'Output JSON')
    .action(runAction<[{ json?: boolean }]>(async (opts) => {
      const paths = resolvePaths();
      if (opts.json) {
        printJson({ ok: true, path: paths.configFile, exists: configExists(paths) });
      } else {
        getUI().line(paths.configFile);
      }
    }, { code: 'config_path_failed' }));

  cmd
    .command('show')
    .description('Print the active config (api_key redacted unless --reveal)')
    .option('--reveal', 'Print the api_key in clear text (use with care)')
    .option('--json', 'Output JSON')
    .action(runAction<[{ reveal?: boolean; json?: boolean }]>(async (opts) => {
      const paths = resolvePaths();
      if (!configExists(paths)) {
        exitWithError(
          `Config not found at ${paths.configFile}. Run \`prismer setup\`.`,
          { code: 'config_missing' },
        );
      }
      const cfg = loadConfig(paths);
      const view = {
        path: paths.configFile,
        cloud_api_base: cfg.cloud_api_base,
        daemon_id: cfg.daemon_id,
        api_key: opts.reveal ? cfg.api_key : redactApiKey(cfg.api_key),
        adapters: cfg.adapters
          ? Object.fromEntries(
              Object.entries(cfg.adapters).map(([name, value]) => [name, value]),
            )
          : {},
      };
      if (opts.json) {
        printJson({ ok: true, config: view });
        return;
      }
      const ui = getUI();
      ui.header('Prismer config');
      ui.blank();
      ui.line(`  path:           ${view.path}`);
      ui.line(`  cloud_api_base: ${view.cloud_api_base}`);
      ui.line(`  daemon_id:      ${view.daemon_id}`);
      ui.line(`  api_key:        ${view.api_key}`);
      const adapters = Object.keys(view.adapters);
      if (adapters.length > 0) {
        ui.blank();
        ui.line(`  adapters: ${adapters.join(', ')}`);
      }
    }, { code: 'config_show_failed' }));

  cmd
    .command('set <key> <value>')
    .description(`Update a config field (one of: ${SETTABLE_KEYS.join(', ')})`)
    .option('--json', 'Output JSON')
    .action(runAction<[string, string, { json?: boolean }]>(async (key, value, opts) => {
      if (!SETTABLE_KEYS.includes(key as SettableKey)) {
        exitWithError(
          `Unknown config key "${key}". Settable keys: ${SETTABLE_KEYS.join(', ')}.`,
          { code: 'unknown_config_key' },
        );
      }
      const paths = resolvePaths();
      if (!configExists(paths)) {
        exitWithError(
          `Config not found at ${paths.configFile}. Run \`prismer setup\` first.`,
          { code: 'config_missing' },
        );
      }
      const cfg = loadConfig(paths);
      const next: Config = { ...cfg };
      switch (key as SettableKey) {
        case 'cloud_api_base':
          next.cloud_api_base = normalizeCloudUrl(value);
          break;
        case 'api_key':
          if (!/^sk-prismer-/.test(value)) {
            exitWithError('Invalid API key format. Expected key starting with sk-prismer-.', {
              code: 'invalid_api_key_format',
            });
          }
          next.api_key = value;
          break;
        case 'daemon_id':
          if (!value.trim()) exitWithError('daemon_id cannot be empty.', { code: 'invalid_argument' });
          next.daemon_id = value;
          break;
      }
      saveConfig(next, paths);
      if (opts.json) {
        printJson({ ok: true, key, value: key === 'api_key' ? redactApiKey(value) : value });
      } else {
        getUI().ok(`Updated ${key}`, key === 'api_key' ? redactApiKey(value) : value);
      }
    }, { code: 'config_set_failed' }));

  cmd.addCommand(buildConfigSkillCommand());

  return cmd;
}

// ── `config skill` — per-account USER skill config (config-mgmt redesign) ──────
//
// Distinct axis from the daemon-config verbs above (path/show/set operate on the
// LOCAL ~/.prismer/config.toml). These hit the cloud endpoint
// `/api/im/user-skill-config`, which is owner-scoped by the API key: a caller can
// only ever read/write their OWN account's `kind: user` config values (its own
// credentials, e.g. an API_KEY), sealed `enc:v1:` server-side — plaintext never
// leaves the caller.
//
// The reason it lives on the CLI: a PARKED agent (a dispatch gated on a missing
// required user key → config_needed) can self-serve — `config skill list --skill
// <slug>` shows which user keys are 已配/缺失, `config skill set …` fills the
// missing one, and the pre-dispatch gate resumes it. That closes the loop without
// a human opening Studio.
//
// It is a NESTED group (`config skill …`, not `config list/set/delete`) on
// purpose: the sibling `config set <key> <value>` already means "edit the local
// TOML", so a second top-level `set` with skill semantics would shadow it. The
// nesting keeps both unambiguous while still living under `cloud config`.

interface ConfigDecl {
  key: string;
  type?: string;
  required?: boolean;
  default?: string | null;
  kind?: 'default' | 'user';
  bindable?: string[];
  prompt?: Record<string, string> | null;
  description?: string;
}

/**
 * Client mirror of cloud `effectiveConfigKind` (src/im/skills/frontmatter.ts):
 * explicit `kind` wins; else a `type: secret` key with NO shared default is a
 * per-account `user` credential, everything else a shared template `default`.
 * Kept byte-identical so the CLI's user/default split matches what the endpoint
 * enforces on write.
 */
function effectiveConfigKind(decl: Pick<ConfigDecl, 'kind' | 'type' | 'default'>): 'default' | 'user' {
  if (decl.kind === 'user' || decl.kind === 'default') return decl.kind;
  if (decl.type === 'secret' && (decl.default === null || decl.default === undefined)) return 'user';
  return 'default';
}

interface SkillDetailLite {
  slug?: string;
  metadata?: Record<string, unknown> | string;
}

/** Fetch a skill's declared configSchema (tolerating metadata as object OR raw JSON string). */
async function fetchConfigSchema(cloud: CloudClient, slug: string): Promise<ConfigDecl[]> {
  const detail = await cloud.get<SkillDetailLite>(`/api/im/skills/${encodeURIComponent(slug)}`);
  let meta: Record<string, unknown> = {};
  if (detail?.metadata && typeof detail.metadata === 'object') {
    meta = detail.metadata as Record<string, unknown>;
  } else if (typeof detail?.metadata === 'string') {
    try {
      meta = JSON.parse(detail.metadata) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  const schema = meta.configSchema;
  return Array.isArray(schema) ? (schema as ConfigDecl[]).filter((d) => d && typeof d.key === 'string') : [];
}

interface RedactedRow {
  targetKind: string;
  targetSlug: string;
  keyName: string;
  set: boolean;
  hint: string;
}

function buildConfigSkillCommand(): Command {
  const cmd = new Command('skill').description(
    'Per-account USER skill config (your own credentials, sealed cloud-side). ' +
      'A parked agent uses this to self-serve the `kind: user` keys it is missing.',
  );

  cmd
    .command('list')
    .description(
      'List your account\'s USER skill config (redacted — values never leave the server). ' +
        'With --skill, cross-references the skill\'s declared user keys to show 已配/缺失 (+ prompt).',
    )
    .option('--skill <slug>', 'Scope to one skill AND resolve missing user keys against its schema')
    .option('--json', 'Output JSON')
    .action(
      runAction<[{ skill?: string; json?: boolean }]>(async (opts) => {
        const cloud = mkCloud();
        const qs = opts.skill ? `?targetKind=skill&targetSlug=${encodeURIComponent(opts.skill)}` : '';
        const setRows = await cloud.get<RedactedRow[]>(`/api/im/user-skill-config${qs}`);
        const setByKey = new Map((setRows ?? []).map((r) => [`${r.targetSlug} ${r.keyName}`, r]));

        // Without --skill we can only show what IS set (the redacted endpoint
        // never enumerates unset keys). With --skill we ALSO fetch the schema to
        // surface the 缺失 keys the agent still owes.
        if (!opts.skill) {
          const rows = (setRows ?? []).map((r) => ({
            skill: r.targetSlug,
            key: r.keyName,
            state: 'set',
            hint: r.hint,
          }));
          if (opts.json) {
            printJson({ scope: 'all', configured: rows });
            return;
          }
          const ui = getUI();
          ui.header(`Your user skill config (${rows.length} set)`);
          if (rows.length === 0) {
            ui.secondary('Nothing configured. Scope to a skill to see what it needs: config skill list --skill <slug>');
            return;
          }
          ui.table(rows, { columns: ['skill', 'key', 'state', 'hint'] });
          ui.secondary('Redacted: only the display hint is shown; plaintext never leaves the server.');
          return;
        }

        const schema = await fetchConfigSchema(cloud, opts.skill);
        const userKeys = schema.filter((d) => effectiveConfigKind(d) === 'user');
        const rows = userKeys.map((d) => {
          const row = setByKey.get(`${opts.skill} ${d.key}`);
          return {
            key: d.key,
            state: row?.set ? 'set' : 'MISSING',
            required: d.required && !d.default ? 'yes' : 'no',
            hint: row?.hint ?? '—',
            prompt: (d.prompt?.en ?? Object.values(d.prompt ?? {})[0] ?? d.description ?? '').slice(0, 60),
          };
        });
        if (opts.json) {
          printJson({ scope: 'skill', skill: opts.skill, userKeys: rows });
          return;
        }
        const ui = getUI();
        if (userKeys.length === 0) {
          ui.ok('No user-kind config keys', String(opts.skill));
          ui.secondary('(this skill declares no `kind: user` keys — default keys are edited on the template, not here)');
          return;
        }
        const missing = rows.filter((r) => r.state === 'MISSING').length;
        ui.header(`User config · ${opts.skill} (${rows.length} key${rows.length === 1 ? '' : 's'}, ${missing} missing)`);
        ui.table(rows, { columns: ['key', 'state', 'required', 'hint', 'prompt'] });
        if (missing > 0) {
          ui.secondary(`fill a missing key: config skill set ${opts.skill} <KEY> <value>`);
        }
      }, { code: 'config_skill_list_failed' }),
    );

  cmd
    .command('set <skill> <key> <value>')
    .description(
      'Set a USER config value for a skill (sealed enc:v1: server-side). ' +
        'Only `kind: user` keys are accepted — default keys are rejected (edit those on the template).',
    )
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, string, string, { json?: boolean }]>(async (skill, key, value, opts) => {
        const cloud = mkCloud();
        const res = await cloud.request<{
          ok?: boolean;
          data?: RedactedRow[];
          meta?: { settled?: string[] };
          error?: { code?: string; message?: string };
        }>('POST', '/api/im/user-skill-config', {
          body: { targetKind: 'skill', targetSlug: skill, values: { [key]: value } },
        });
        if (!res.ok || res.data?.ok === false) {
          // 422 SKILL_CONFIG_KEY_NOT_USER / SKILL_CONFIG_NOT_DECLARED land here —
          // surface the reason verbatim so an agent learns it aimed at a default
          // key (edit the template) or an undeclared one.
          const err = res.error ?? res.data?.error;
          exitWithError(`set failed (${describeStatus(res.status)}): ${err?.message ?? 'request failed'}`, {
            code: err?.code ?? 'config_skill_set_failed',
          });
        }
        const settled = res.data?.meta?.settled ?? [];
        const row = (res.data?.data ?? []).find((r) => r.keyName === key);
        if (opts.json) {
          printJson({ ok: true, skill, key, set: true, hint: row?.hint ?? null, settled });
          return;
        }
        const ui = getUI();
        ui.ok('User config set (sealed)', `${skill} · ${key}${row?.hint ? ` → ${row.hint}` : ''}`);
        if (settled.length > 0) {
          ui.secondary(`resumed ${settled.length} parked config request(s): ${settled.join(', ')}`);
        }
      }, { code: 'config_skill_set_failed' }),
    );

  cmd
    .command('delete <skill> <key>')
    .description('Delete one USER config value for a skill (idempotent).')
    .option('--json', 'Output JSON')
    .action(
      runAction<[string, string, { json?: boolean }]>(async (skill, key, opts) => {
        const cloud = mkCloud();
        const res = await cloud.request<{ ok?: boolean; error?: { code?: string; message?: string } }>(
          'DELETE',
          '/api/im/user-skill-config',
          { body: { targetKind: 'skill', targetSlug: skill, keyName: key } },
        );
        if (!res.ok || res.data?.ok === false) {
          const err = res.error ?? res.data?.error;
          exitWithError(`delete failed (${describeStatus(res.status)}): ${err?.message ?? 'request failed'}`, {
            code: err?.code ?? 'config_skill_delete_failed',
          });
        }
        if (opts.json) {
          printJson({ ok: true, skill, key, deleted: true });
          return;
        }
        getUI().ok('User config deleted', `${skill} · ${key}`);
      }, { code: 'config_skill_delete_failed' }),
    );

  return cmd;
}

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}
