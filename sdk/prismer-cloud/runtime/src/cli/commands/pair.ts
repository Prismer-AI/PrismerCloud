// `prismer pair` — legacy QR approval flow.
//
// Runtime/cloud binding is now owned by `prismer setup`. Keep this command as
// a compatibility path while the product-level `pair` verb is redesigned for
// mobile QR login / web login approval.
// `--as-user <email>` enables a LAN-dev bypass (LOCAL_ONLY=1 required) used
// by the release54 harness to drive the daemon end-to-end without human
// interaction. See `pair.ts` for the protocol details.

import { Command } from 'commander';
import { pair } from '../../pair.js';
import { resolvePaths } from '../../config.js';
import { DEFAULT_CLOUD_BASE_URL, exitWithError, normalizeCloudUrl, runAction } from '../util.js';
import { getUI } from '../ui.js';

export function buildPairCommand(): Command {
  return new Command('pair')
    .description('Legacy QR approval path; use `prismer setup` to bind this runtime')
    .option(
      '--cloud <url>',
      `Cloud base URL (default: ${DEFAULT_CLOUD_BASE_URL}; bare host:port is auto-prefixed http://)`,
      (v) => v,
    )
    .option('--device-name <name>', 'Friendly name shown to the approver in mobile UI')
    .option('--force', 'Overwrite existing config.toml if present')
    .option(
      '--as-user <email>',
      'LAN-dev bypass: auto-approve as the named human user (requires LOCAL_ONLY=1)',
    )
    .option('--json', 'Accept --json for global flag compatibility')
    .action(
      runAction<[{ cloud?: string; deviceName?: string; force?: boolean; asUser?: string }]>(
        async (opts) => {
          const rawCloud = opts.cloud ?? process.env.PRISMER_BASE_URL ?? DEFAULT_CLOUD_BASE_URL;
          let cloudBaseUrl: string;
          try {
            cloudBaseUrl = normalizeCloudUrl(rawCloud);
          } catch (err) {
            exitWithError((err as Error).message, { code: 'invalid_cloud_url' });
          }
          // CLI-side gate so the user gets a clear error before we hit the
          // network. Cloud also rejects (NODE_ENV !== 'production') as defense
          // in depth.
          if (opts.asUser && process.env.LOCAL_ONLY !== '1') {
            exitWithError('--as-user requires LOCAL_ONLY=1. Set LOCAL_ONLY=1 in env, or remove --as-user.', {
              code: 'local_only_required',
            });
          }
          getUI().warn('Legacy command', '`prismer setup --start` is the canonical runtime binding path');
          const result = await pair({
            cloudBaseUrl,
            deviceName: opts.deviceName,
            force: opts.force,
            paths: resolvePaths(),
            asUserEmail: opts.asUser,
          });
          const ui = getUI();
          ui.ok('Paired', result.paths.configFile);
          ui.secondary(`daemon_id: ${result.config.daemon_id}`);
        },
        { code: 'pair_failed' },
      ),
    );
}
