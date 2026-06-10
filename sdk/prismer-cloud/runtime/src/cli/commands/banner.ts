// `prismer banner` — small branded entry point for first-run and docs.

import { Command } from 'commander';
import { printBanner } from '../util.js';

export function buildBannerCommand(): Command {
  return new Command('banner')
    .description('Show the Prismer runtime CLI banner')
    .option('--compact', 'Show a single-line banner')
    .option('--json', 'Accept --json for global flag compatibility (banner is suppressed in JSON mode)')
    .action((opts: { compact?: boolean }) => {
      printBanner({ compact: opts.compact });
    });
}
