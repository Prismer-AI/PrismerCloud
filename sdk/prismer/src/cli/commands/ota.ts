// `prismer ota (resolve|status)` — boot-time runtime-bundle OTA (product204/08
// §2.3, M9-β).
//
// `resolve` is the K8s entrypoint hook: it runs the full boot-time pass
// (settle previous boot → cleanup → manifest → download/verify/apply →
// pointer resolve) and prints the exec target. With `--exec-path` it prints
// ONLY the resolved bundle cli.js path on stdout (nothing when the builtin
// runtime should run), so the entrypoint can do:
//
//   BUNDLE_CLI="$(prismer ota resolve --exec-path || true)"
//   [ -n "$BUNDLE_CLI" ] && exec node "$BUNDLE_CLI" daemon start ...
//   exec prismer daemon start ...            # builtin floor — never brick
//
// All human-readable progress goes to stderr (pod logs); stdout stays
// machine-parseable.

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '../../config.js';
import {
  bootDepsFromEnvironment,
  runBootOta,
} from '../../daemon/ota/ota-check.js';
import { bundleRoot, isBlacklisted, isValidBundleDir, readBootMarker, readPointer } from '../../daemon/ota/bundle-store.js';
import { printJson } from '../util.js';

export function buildOtaCommand(): Command {
  const cmd = new Command('ota').description('Runtime bundle OTA (boot-time pull, verify, rollback)');

  cmd
    .command('resolve')
    .description('Run the boot-time bundle check and print the resolved runtime')
    .option('--exec-path', 'Print only the resolved bundle cli.js path (empty = builtin)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { execPath?: boolean; json?: boolean }) => {
      const home = resolvePaths().root;
      const deps = bootDepsFromEnvironment(home);
      const resolution = await runBootOta(deps);
      if (opts.execPath) {
        // stdout carries ONLY the path (or nothing for builtin) — the
        // entrypoint substitutes this into `exec node <path> daemon start`.
        if (resolution.execPath) process.stdout.write(`${resolution.execPath}\n`);
        return;
      }
      printJson(resolution);
    });

  cmd
    .command('status')
    .description('Show bundle pointers, blacklist, and boot marker')
    .option('--json', 'Output JSON (default)')
    .action(async () => {
      const home = resolvePaths().root;
      const root = bundleRoot(home);
      const current = readPointer(root, 'current');
      const previous = readPointer(root, 'previous');
      let blacklist: Record<string, number> = {};
      try {
        const f = join(root, 'blacklist.json');
        if (existsSync(f)) blacklist = JSON.parse(readFileSync(f, 'utf8')) as Record<string, number>;
      } catch {
        /* unreadable → show empty */
      }
      printJson({
        root,
        current,
        currentValid: current ? isValidBundleDir(join(root, current)) && !isBlacklisted(root, current) : false,
        previous,
        blacklist,
        bootMarker: readBootMarker(root),
      });
    });

  return cmd;
}
