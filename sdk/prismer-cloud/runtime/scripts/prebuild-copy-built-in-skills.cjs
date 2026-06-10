#!/usr/bin/env node
// Mirror sdk/prismer-cloud/built-in-skills/ into runtime/built-in-skills/
// before `tsup` runs so the tarball can ship the canonical SKILL.md bundle.
//
// Why prebuild + copy (not symlink / not tsup plugin):
//   1. npm pack hard-includes only the directory entries listed in
//      package.json `files`; symlinks outside the package root are not packed.
//   2. tsup output is .js — embedding .md as bundled string requires a
//      custom esbuild loader and erases path-based introspection at runtime.
//   3. Adapters read SKILL.md at runtime to install it into Hermes /
//      OpenClaw profile dirs; keeping it as a flat file mirrors how those
//      hosts expect to load skills.
//
// Single source of truth lives at:
//   <repo>/sdk/prismer-cloud/built-in-skills/
//
// This script is idempotent: it rms the mirror first, then deep-copies.

const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;                                      // runtime/scripts
const runtimeRoot = path.resolve(here, '..');                // runtime/
const sourceDir = path.resolve(runtimeRoot, '..', 'built-in-skills');
const targetDir = path.resolve(runtimeRoot, 'built-in-skills');

if (!fs.existsSync(sourceDir)) {
  console.error(`[prebuild] source missing: ${sourceDir}`);
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

let fileCount = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else fileCount++;
  }
}
walk(targetDir);

const relSource = path.relative(process.cwd(), sourceDir);
const relTarget = path.relative(process.cwd(), targetDir);
console.log(`[prebuild] mirrored ${fileCount} file(s) from ${relSource} to ${relTarget}`);
