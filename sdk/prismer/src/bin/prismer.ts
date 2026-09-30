#!/usr/bin/env node
// `prismer` executable shim — Prismer Cloud daemon CLI.
// Tsup emits this to dist/cli.js; package.json bin field maps it to `prismer`.
// The user-facing daily CLI (`cloud`, agent + user facing) ships from
// @prismer/sdk and is a separate binary.

// The EaaS hot path must not initialise every interactive CLI command (and
// their database/adapter dependencies) just to print capabilities or run a turn.
async function main(): Promise<void> {
  const { applyCommonFlags, setUI, UI } = await import('../cli/ui.js');
  const { mode, color, restArgv } = applyCommonFlags(process.argv.slice(2));
  const turnArgv = restArgv.filter((arg) => arg !== '--json');
  if (turnArgv[0] === 'turn') {
    setUI(new UI({ mode, color }));
    const [{ Command }, { buildTurnCommand }] = await Promise.all([
      import('commander'),
      import('../cli/commands/turn.js'),
    ]);
    await new Command('prismer').addCommand(buildTurnCommand()).parseAsync([...process.argv.slice(0, 2), ...turnArgv]);
    return;
  }
  const { runCli } = await import('../cli/index.js');
  await runCli();
}

main().catch((err: Error) => {
  process.stderr.write(`prismer: ${err.message}\n`);
  process.exit(1);
});
