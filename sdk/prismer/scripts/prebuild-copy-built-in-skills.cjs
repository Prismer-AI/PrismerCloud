#!/usr/bin/env node
// Mirror the runtime's out-of-package skill sources INTO the package root
// before `tsup` runs so the tarball / OTA bundle can ship them:
//
//   sdk/cloud/catalog/skills/  →  prismer/built-in-skills/
//   sdk/apc/skills/                     →  prismer/apc/skills/
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
// The apc/ mirror (desktop205 D8): resolveApcSkillsRoot() walks up from the
// running module looking for `apc/skills` | `sdk/apc/skills`. Before this
// mirror existed the source lived ONLY in the repo working tree, so every
// non-repo host (OTA bundle, npm-installed daemon, desktop resources/runtime)
// resolved null and installed nothing — a silent second gate on top of the
// platform gate. Mirroring to <package>/apc/skills puts it exactly one hop
// above dist/, which every one of those layouts hits. Same failure mode as the
// 2026-07-19 "bundle shipped without plugins/ ⇒ memory layer dark" incident.
//
// Single sources of truth:
//   <repo>/sdk/cloud/catalog/skills/ (after catalog migration)
//   <repo>/sdk/apc/skills/
//
// This script is idempotent: it rms each mirror first, then deep-copies.

const fs = require('node:fs');
const path = require('node:path');

const here = __dirname; // prismer/scripts
const runtimeRoot = path.resolve(here, '..'); // sdk/prismer

function resolveMirrorSources(targetRuntimeRoot = runtimeRoot) {
  const sdkRoot = path.resolve(targetRuntimeRoot, '..');
  const builtInSource = path.resolve(sdkRoot, 'cloud', 'catalog', 'skills');
  const apcSource = path.resolve(sdkRoot, 'apc', 'skills');

  if (!fs.existsSync(builtInSource)) {
    throw new Error(`[prebuild] source missing: ${builtInSource}`);
  }
  if (!fs.existsSync(apcSource)) {
    throw new Error(`[prebuild] source missing: ${apcSource}`);
  }

  return {
    sdkRoot,
    builtInSource,
    apcSource,
  };
}

function buildMirrors(targetRuntimeRoot = runtimeRoot) {
  const { builtInSource, apcSource } = resolveMirrorSources(targetRuntimeRoot);
  return [
    [builtInSource, path.resolve(targetRuntimeRoot, 'built-in-skills')],
    [apcSource, path.resolve(targetRuntimeRoot, 'apc', 'skills')],
  ];
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

function syncMirrors(targetRuntimeRoot = runtimeRoot) {
  const mirrors = buildMirrors(targetRuntimeRoot);
  for (const [sourceDir, targetDir] of mirrors) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    const relSource = path.relative(process.cwd(), sourceDir);
    const relTarget = path.relative(process.cwd(), targetDir);
    console.log(`[prebuild] mirrored ${countFiles(targetDir)} file(s) from ${relSource} to ${relTarget}`);
  }
}

function main() {
  try {
    syncMirrors();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { buildMirrors, resolveMirrorSources, syncMirrors };
