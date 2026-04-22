#!/usr/bin/env node
// deprecation-notice.mjs — stderr banner printed on `npm install`.
//
// Why: v1.9.0 renames the PARA adapter line from `@prismer/claude-code-plugin`
// to `@prismer/adapters-core`. The old package keeps shipping critical fixes
// for 6 months (until 2026-10-16) per docs/version190/11-context-references.md §11.1.
//
// Contract:
//   - Writes to STDERR only; never stdout (keeps `npm install --silent` quiet on stdout).
//   - Never blocks install: exits 0 unconditionally, any error is swallowed.
//   - Honors PRISMER_SILENCE_DEPRECATION=1 to stay silent (CI hygiene).
//   - ANSI colors only when stderr is a TTY — plain text otherwise.

const SILENCE = process.env.PRISMER_SILENCE_DEPRECATION === '1';
if (SILENCE) {
  process.exit(0);
}

try {
  const useColor = Boolean(process.stderr && process.stderr.isTTY);
  const yellow = useColor ? '\x1b[33m' : '';
  const red = useColor ? '\x1b[31m' : '';
  const bold = useColor ? '\x1b[1m' : '';
  const reset = useColor ? '\x1b[0m' : '';

  const lines = [
    '',
    `${red}${bold}⚠️  @prismer/claude-code-plugin is DEPRECATED${reset}`,
    '',
    `${yellow}Please migrate to the new PARA adapter:${reset}`,
    `  ${bold}npm install @prismer/adapters-core${reset}`,
    '',
    'This package will continue to receive critical fixes for 6 months',
    `(until ${bold}2026-10-16${reset}). See: https://prismer.cloud/docs/migrate-v190`,
    '',
    `To silence this notice in CI: ${bold}PRISMER_SILENCE_DEPRECATION=1${reset}`,
    '',
  ];

  process.stderr.write(lines.join('\n'));
} catch {
  // Never block install on any error in the notice itself.
}

process.exit(0);
