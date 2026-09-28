import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCloudCliShim, resolveBundledCloudCli } from '../src/adapters/persistence/hermes/cloud-cli-shim.js';

const here = dirname(fileURLToPath(import.meta.url));
const realCloudCli = resolve(here, '..', '..', 'cloud', 'dist', 'cli.js');

describe('managed Cloud CLI shim', () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('creates a direct managed symlink and a stable shell-visible alias', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-cloud-shim-'));
    cleanup.push(home);
    const sdkDist = join(home, 'bundle', 'node_modules', '@prismer', 'sdk', 'dist');
    mkdirSync(sdkDist, { recursive: true });
    const cli = join(sdkDist, 'cli.js');
    writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("Cloud CLI 2.2.12")\n');
    chmodSync(cli, 0o755);

    const result = ensureCloudCliShim({ homeDir: home, cloudCliPath: cli });
    expect(result.managedBinDir).toBe(join(home, '.prismer', 'bin'));
    expect(lstatSync(result.managedShimPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(result.managedShimPath)).toBe(cli);
    const shellAlias = join(home, '.local', 'bin', 'cloud');
    expect(existsSync(shellAlias)).toBe(true);
    expect(readlinkSync(shellAlias)).toBe(result.managedShimPath);
    expect(spawnSync(result.managedShimPath, ['--version'], { encoding: 'utf8' }).stdout).toContain('2.2.12');
  });

  it('keeps the shell-visible alias current when OTA rotates the bundle target', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-cloud-shim-ota-'));
    cleanup.push(home);
    const firstCli = join(home, 'bundle-v1', 'cli.js');
    const secondCli = join(home, 'bundle-v2', 'cli.js');
    mkdirSync(join(home, 'bundle-v1'), { recursive: true });
    mkdirSync(join(home, 'bundle-v2'), { recursive: true });
    writeFileSync(firstCli, '#!/usr/bin/env node\nconsole.log("v1")\n');
    writeFileSync(secondCli, '#!/usr/bin/env node\nconsole.log("v2")\n');
    chmodSync(firstCli, 0o755);
    chmodSync(secondCli, 0o755);

    const first = ensureCloudCliShim({ homeDir: home, cloudCliPath: firstCli });
    ensureCloudCliShim({ homeDir: home, cloudCliPath: secondCli });

    expect(readlinkSync(first.shellVisibleShimPath)).toBe(first.managedShimPath);
    expect(readlinkSync(first.managedShimPath)).toBe(secondCli);
    expect(spawnSync(first.shellVisibleShimPath, [], { encoding: 'utf8' }).stdout).toContain('v2');
  });

  it('does not overwrite an unrelated user-owned ~/.local/bin/cloud', () => {
    const home = mkdtempSync(join(tmpdir(), 'prismer-cloud-shim-user-'));
    cleanup.push(home);
    const cli = join(home, 'bundle-cli.js');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    chmodSync(cli, 0o755);
    const localBin = join(home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const userCloud = join(localBin, 'cloud');
    writeFileSync(userCloud, 'user-owned');

    const result = ensureCloudCliShim({ homeDir: home, cloudCliPath: cli });
    expect(result.shellVisibleShimCreated).toBe(false);
    expect(lstatSync(result.managedShimPath).isSymbolicLink()).toBe(true);
  });

  // product210 bugfix regression: local CLI-daemon mode (`node
  // sdk/prismer/dist/cli.js daemon start`) runs from a repo checkout where
  // @prismer/sdk is the UNLINKED sibling package sdk/cloud — module resolution
  // finds nothing and the capability receipt used to report
  // `cloudCli: unavailable`. The sibling-path fallback must find the real CLI.
  it('resolves the sibling sdk/cloud CLI in a repo checkout (local CLI-daemon mode)', () => {
    expect(existsSync(realCloudCli), 'build sdk/cloud before this Runtime contract test').toBe(true);
    expect(resolveBundledCloudCli()).toBe(realCloudCli);
  });

  it('ensureCloudCliShim succeeds in a repo checkout WITHOUT an explicit cloudCliPath', () => {
    expect(existsSync(realCloudCli), 'build sdk/cloud before this Runtime contract test').toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'prismer-cloud-shim-checkout-'));
    cleanup.push(home);
    const result = ensureCloudCliShim({ homeDir: home });
    expect(result.cloudCliPath).toBe(realCloudCli);
    expect(lstatSync(result.managedShimPath).isSymbolicLink()).toBe(true);
    expect(spawnSync(result.managedShimPath, ['--version'], { encoding: 'utf8' }).status).toBe(0);
  });

  it('executes the real bundled Cloud CLI shim against the bounded PKF inspect API', () => {
    expect(existsSync(realCloudCli), 'build sdk/cloud before this Runtime contract test').toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'prismer-cloud-shim-real-'));
    cleanup.push(home);
    const sourcePath = join(home, 'bounded.pkf');
    writeFileSync(
      sourcePath,
      '<script type="application/prismer+json">{"type":"note","title":"CLI","description":"bounded cli test","pkfVersion":"1.1"}</script>' +
        '<section><h2 id="a" data-sid="sec_01k2f6m8v7q4x9a3b5c6d7e8f9">A</h2><p>bounded needle</p></section>',
    );
    const result = ensureCloudCliShim({ homeDir: home, cloudCliPath: realCloudCli });

    const invoked = spawnSync(result.managedShimPath, ['pkf', 'inspect', sourcePath, '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home },
    });

    expect(invoked.status, invoked.stderr).toBe(0);
    const receipt = JSON.parse(invoked.stdout) as {
      sourceHash?: string;
      sections?: Array<{ anchorSlug?: string }>;
    };
    expect(receipt.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.sections?.map((section) => section.anchorSlug)).toContain('a');
  });
});
