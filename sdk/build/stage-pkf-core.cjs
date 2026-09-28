// product209/15 PKF-D2 — hash-verified PKF staging for SDK builds.
// (pkf209/07 §6 Phase 0: @prismer/pkf-core + @prismer/pkf-reader merged into
// the single @prismer/pkf package; the script NAME stays `stage-pkf-core.cjs`
// because both SDK prebuild hooks and docs reference it.)
//
//   node sdk/build/stage-pkf-core.cjs <target-node_modules-dir> [--skip-build]
//
// The Cloud SDK and Runtime stay OUTSIDE the root npm workspace, so neither
// may `file:`-link the monorepo packages. This script stages the BUILT
// @prismer/pkf dist into `<target>/node_modules/@prismer/pkf`:
//
//   1. builds packages/pkf unless --skip-build;
//   2. copies its publishable dist + schema + package metadata into node_modules;
//   3. verifies every staged file's sha256 against the built dist — a drift
//      fails the build instead of shipping a silently stale core;
//   4. writes minimal @prismer/pkf-core / @prismer/pkf-reader alias shims whose
//      main points at ../pkf/dist — one-release compat for third-party code
//      still importing the pre-merge names.
//
// The staged copy is build-time only: it never lands in a published tarball
// (tsup bundles the package into the SDK output; `files` excludes node_modules).

const { execSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const SDK_BUILD_DIR = __dirname;
const REPO_ROOT = resolve(SDK_BUILD_DIR, '..', '..');
const PKF_DIR = join(REPO_ROOT, 'packages', 'pkf');

const target = process.argv[2];
const skipBuild = process.argv.includes('--skip-build');
if (!target) {
  console.error('[stage-pkf-core] usage: node sdk/build/stage-pkf-core.cjs <target-node_modules-dir> [--skip-build]');
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// One-release compat shims for the pre-merge package names (pkf209/07 §6).
// Legacy `main` resolution points at the staged @prismer/pkf dist so a residual
// `@prismer/pkf-core` / `@prismer/pkf-reader` import still resolves; the
// deprecated package shells in packages/pkf-core + packages/pkf-reader are
// source-level only and are NOT staged here.
function writeAliasShims() {
  for (const legacy of ['pkf-core', 'pkf-reader']) {
    const shim = join(target, 'node_modules', '@prismer', legacy);
    rmSync(shim, { recursive: true, force: true });
    mkdirSync(shim, { recursive: true });
    writeFileSync(
      join(shim, 'package.json'),
      `${JSON.stringify(
        {
          name: `@prismer/${legacy}`,
          version: '0.2.0',
          private: true,
          deprecated: 'merged into @prismer/pkf (pkf209/07 §6) — update imports to @prismer/pkf',
          // No `exports` map on purpose: export targets must stay inside the
          // package (no "../"), so legacy main/module resolution is the only
          // way to point at the staged @prismer/pkf dist one directory up.
          main: '../pkf/dist/index.cjs',
          module: '../pkf/dist/index.js',
          types: '../pkf/dist/index.d.ts',
        },
        null,
        2,
      )}\n`,
    );
  }
}

function main() {
  if (!existsSync(join(PKF_DIR, 'package.json'))) {
    console.error('[stage-pkf-core] packages/pkf missing');
    process.exit(1);
  }
  if (!skipBuild) {
    console.log('[stage-pkf-core] building packages/pkf dist');
    execSync('npx tsup', { cwd: PKF_DIR, stdio: 'inherit' });
  }
  if (!existsSync(join(PKF_DIR, 'dist/index.js'))) {
    console.error('[stage-pkf-core] packages/pkf dist missing — build failed?');
    process.exit(1);
  }

  const nm = join(target, 'node_modules', '@prismer', 'pkf');
  rmSync(nm, { recursive: true, force: true });
  mkdirSync(nm, { recursive: true });
  cpSync(join(PKF_DIR, 'dist'), join(nm, 'dist'), { recursive: true });
  cpSync(join(PKF_DIR, 'schema'), join(nm, 'schema'), { recursive: true });
  cpSync(join(PKF_DIR, 'package.json'), join(nm, 'package.json'));

  writeAliasShims();

  let drift = 0;
  for (const src of walk(join(PKF_DIR, 'dist'))) {
    const rel = src.slice(join(PKF_DIR, 'dist').length + 1);
    const dst = join(nm, 'dist', rel);
    if (!existsSync(dst) || sha256(readFileSync(dst)) !== sha256(readFileSync(src))) {
      console.error(`[stage-pkf-core] ❌ hash drift: ${rel}`);
      drift++;
    }
  }
  if (drift > 0) {
    console.error(`[stage-pkf-core] ${drift} staged file(s) drifted from the built dist`);
    process.exit(1);
  }
  console.log(`[stage-pkf-core] staged into ${nm} (+ pkf-core/pkf-reader alias shims)`);
}

main();
