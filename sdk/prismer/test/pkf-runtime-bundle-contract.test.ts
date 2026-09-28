import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLE_REQUIRED_ENTRIES } from '../src/daemon/ota/bundle-store.js';
import {
  assertCloudCliRunnable,
  installCloudCliLauncher,
} from '../../../scripts/ops/runtime-bundle-staging';

const REPO = resolve(__dirname, '..', '..', '..');
const REQUIRED_ENTRIES_MANIFEST = 'sdk/prismer/src/daemon/ota/runtime-required-entries.json';
const REQUIRED = [
  'node_modules/@prismer/pkf/package.json',
  'node_modules/@prismer/sdk/package.json',
  'node_modules/@prismer/sdk/dist/cli.js',
  'node_modules/@earendil-works/pi-agent-core/package.json',
  'node_modules/@earendil-works/pi-ai/package.json',
  'built-in-skills/pkf-writing/SKILL.md',
  'built-in-skills/pkf-svg/SKILL.md',
];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function cloudCliFixture(): string {
  const staging = mkdtempSync(join(tmpdir(), 'pkf-runtime-cloud-cli-'));
  temporaryDirectories.push(staging);
  const sdkRoot = join(staging, 'node_modules/@prismer/sdk');
  const nestedAip = join(sdkRoot, 'node_modules/@prismer/aip-sdk');
  const bin = join(staging, 'node_modules/.bin');
  mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
  mkdirSync(nestedAip, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(sdkRoot, 'dist/cli.js'),
    "#!/usr/bin/env node\nrequire('@prismer/aip-sdk'); process.stdout.write('Usage: cloud\\n');\n",
  );
  writeFileSync(join(nestedAip, 'package.json'), '{"name":"@prismer/aip-sdk","main":"index.js"}\n');
  writeFileSync(join(nestedAip, 'index.js'), 'module.exports = { AIPIdentity: class AIPIdentity {} };\n');
  // Reproduce the signed-candidate failure: zip dereferenced npm's symlink,
  // so this copied CLI resolves dependencies from node_modules/.bin instead
  // of from @prismer/sdk and cannot see the SDK's bundled AIP dependency.
  const broken = join(bin, 'cloud');
  writeFileSync(broken, "#!/usr/bin/env node\nrequire('@prismer/aip-sdk');\n");
  chmodSync(broken, 0o755);
  return staging;
}

function readRequiredEntriesManifest(): {
  daemonBundle: string[];
  k8sPackerExtra: string[];
  embeddedRuntimeExtra: string[];
} {
  return JSON.parse(readFileSync(resolve(REPO, REQUIRED_ENTRIES_MANIFEST), 'utf8')) as {
    daemonBundle: string[];
    k8sPackerExtra: string[];
    embeddedRuntimeExtra: string[];
  };
}

describe('signed Runtime bundle PKF floor', () => {
  it('loader rejects a signed bundle missing core, Cloud CLI, or either canonical skill', () => {
    expect(readRequiredEntriesManifest().daemonBundle).toEqual(BUNDLE_REQUIRED_ENTRIES);
    for (const entry of REQUIRED) expect(BUNDLE_REQUIRED_ENTRIES).toContain(entry);
  });

  it('K8s and Desktop packers read the shared required-entry manifest', () => {
    const k8s = readFileSync(resolve(REPO, 'scripts/ops/build-daemon-runtime-bundle.ts'), 'utf8');
    const desktop = readFileSync(resolve(REPO, 'apps/desktop/scripts/build-daemon-bundle.cjs'), 'utf8');
    expect(k8s).toContain('runtime-required-entries.json');
    expect(k8s).toContain('daemonBundle');
    expect(k8s).toContain('k8sPackerExtra');
    expect(desktop).toContain('runtime-required-entries.json');
    expect(desktop).toContain('daemonBundle');
  });

  it('repairs the PATH launcher and fails closed when the Cloud CLI dependency closure is incomplete', () => {
    const staging = cloudCliFixture();
    expect(() => assertCloudCliRunnable(staging)).toThrow(/Cloud CLI startup probe failed/);

    installCloudCliLauncher(staging);
    expect(() => assertCloudCliRunnable(staging)).not.toThrow();

    rmSync(resolve(staging, 'node_modules/@prismer/sdk/node_modules/@prismer/aip-sdk'), {
      recursive: true,
      force: true,
    });
    expect(() => assertCloudCliRunnable(staging)).toThrow(/Cloud CLI startup probe failed/);
  });

  it('runs the executable Cloud CLI gate before the K8s bundle is zipped and signed', () => {
    const source = readFileSync(resolve(REPO, 'scripts/ops/build-daemon-runtime-bundle.ts'), 'utf8');
    const installAt = source.indexOf('installCloudCliLauncher(stagingDir)');
    const smokeAt = source.indexOf('assertCloudCliRunnable(stagingDir)');
    // The packer uses the deterministic ZIP writer rather than a host `zip`
    // binary. Keep the ordering gate tied to the actual signed artifact path.
    const zipAt = source.indexOf('createDeterministicZipFromDirectory(stagingDir, zipPath)');
    const signAt = source.indexOf('crypto.sign(null, bytes, privateKey)');
    expect(installAt).toBeGreaterThan(0);
    expect(smokeAt).toBeGreaterThan(installAt);
    expect(zipAt).toBeGreaterThan(smokeAt);
    expect(signAt).toBeGreaterThan(zipAt);
  });
});
