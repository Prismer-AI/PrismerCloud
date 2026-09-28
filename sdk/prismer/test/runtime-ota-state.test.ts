import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/config.js';
import { bundleDir, bundleRoot, writePointer, writeVerifiedRuntimeMetadata } from '../src/daemon/ota/bundle-store.js';
import { readRuntimeOtaSnapshot } from '../src/daemon/ota/runtime-state.js';
import { Runner } from '../src/daemon/runner.js';

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'runtime-ota-state-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env.SANDBOX_MANAGER_PID;
});

describe('readRuntimeOtaSnapshot', () => {
  it('accepts only verified metadata for the exact running current bundle', () => {
    const home = makeHome();
    const root = bundleRoot(home);
    writePointer(root, 'previous', '2.2.10');
    writePointer(root, 'current', '2.2.11');
    writeVerifiedRuntimeMetadata(root, '2.2.11', {
      version: '2.2.11',
      current: '2.2.11',
      previous: '2.2.10',
      sha256: 'a'.repeat(64),
      signatureSha256: 'b'.repeat(64),
    });

    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11', managerPidEnv: '4242' })).toEqual({
      managerPid: 4242,
      version: '2.2.11',
      source: 'bundle',
      current: '2.2.11',
      previous: '2.2.10',
      activeBundleDigest: `sha256:${'a'.repeat(64)}`,
      signatureChecksum: `sha256:${'b'.repeat(64)}`,
      signatureVerified: true,
    });
  });

  it('fails closed for missing, corrupt, cross-version, or pointer-drifted proof', () => {
    const home = makeHome();
    const root = bundleRoot(home);
    writePointer(root, 'current', '2.2.11');
    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11', managerPidEnv: '0' })).toMatchObject({
      managerPid: null,
      source: 'bundle',
      signatureVerified: false,
      activeBundleDigest: null,
      signatureChecksum: null,
    });

    mkdirSync(bundleDir(root, '2.2.11'), { recursive: true });
    writeFileSync(join(bundleDir(root, '2.2.11'), 'verified-runtime.json'), '{not-json', 'utf8');
    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11' }).signatureVerified).toBe(false);

    writeFileSync(
      join(bundleDir(root, '2.2.11'), 'verified-runtime.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '2.2.12',
        current: '2.2.12',
        previous: null,
        sha256: 'c'.repeat(64),
        signatureSha256: 'd'.repeat(64),
        verified: true,
      }),
      'utf8',
    );
    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11' }).signatureVerified).toBe(false);

    writeVerifiedRuntimeMetadata(root, '2.2.11', {
      version: '2.2.11',
      current: '2.2.11',
      previous: '2.2.10',
      sha256: 'e'.repeat(64),
      signatureSha256: 'f'.repeat(64),
    });
    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11' }).signatureVerified).toBe(false);
  });

  it('reports the image floor explicitly without synthesizing verification', () => {
    expect(readRuntimeOtaSnapshot({ home: makeHome(), runningVersion: '2.2.11' })).toEqual({
      managerPid: null,
      version: '2.2.11',
      source: 'builtin',
      current: null,
      previous: null,
      activeBundleDigest: null,
      signatureChecksum: null,
      signatureVerified: false,
    });
  });

  it('does not label the running image floor as bundle when a stale pointer names another version', () => {
    const home = makeHome();
    writePointer(bundleRoot(home), 'current', '9.9.9');

    expect(readRuntimeOtaSnapshot({ home, runningVersion: '2.2.11' })).toMatchObject({
      version: '2.2.11',
      source: 'builtin',
      current: '9.9.9',
      signatureVerified: false,
    });
  });

  it('Runner snapshots proof once, then health state stays in-memory', () => {
    const home = makeHome();
    const root = bundleRoot(home);
    writePointer(root, 'current', '2.2.11');
    writeVerifiedRuntimeMetadata(root, '2.2.11', {
      version: '2.2.11',
      current: '2.2.11',
      previous: null,
      sha256: 'a'.repeat(64),
      signatureSha256: 'b'.repeat(64),
    });
    process.env.SANDBOX_MANAGER_PID = '5151';

    const runner = new Runner({ paths: resolvePaths(home), daemonVersion: '2.2.11' }) as Runner & {
      captureRuntimeOtaSnapshot(): void;
    };
    expect(runner.snapshotState().ota).toBeUndefined();
    runner.captureRuntimeOtaSnapshot();
    const first = runner.snapshotState();
    expect(first.runtimePid).toBe(process.pid);
    expect(first.ota).toMatchObject({ managerPid: 5151, signatureVerified: true });

    writeFileSync(join(bundleDir(root, '2.2.11'), 'verified-runtime.json'), '{corrupt-after-start', 'utf8');
    expect(runner.snapshotState().ota).toEqual(first.ota);
  });
});
