#!/usr/bin/env node
// `prismer` executable shim — Prismer Cloud daemon CLI.
// Tsup emits this to dist/cli.js; package.json bin field maps it to `prismer`.
// The user-facing daily CLI (`cloud`, agent + user facing) ships from
// @prismer/sdk and is a separate binary.

import { runCli } from '../cli/index.js';

runCli().catch((err: Error) => {
  process.stderr.write(`prismer: ${err.message}\n`);
  process.exit(1);
});
