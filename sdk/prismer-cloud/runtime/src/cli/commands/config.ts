// `prismer config (show|set|path)` — inspect and tweak ~/.prismer/config.toml.
//
// `show` prints the active config (api_key redacted unless --reveal). `set`
// updates a single field (`cloud_api_base`, `api_key`, or `daemon_id`) and
// rewrites the TOML in place. `path` prints the resolved file path so callers
// can `cat`/`open` it from a shell without remembering the location.

import { Command } from 'commander';
import { configExists, loadConfig, resolvePaths, saveConfig, type Config } from '../../config.js';
import { exitWithError, normalizeCloudUrl, printJson, runAction } from '../util.js';
import { getUI } from '../ui.js';

const SETTABLE_KEYS = ['cloud_api_base', 'api_key', 'daemon_id'] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

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

  return cmd;
}
