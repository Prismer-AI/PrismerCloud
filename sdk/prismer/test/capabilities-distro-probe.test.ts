// capabilities-distro-probe.test.ts — the OS-distro probe must not spray the
// daemon's stderr on non-Linux hosts.
//
// Real-machine symptom (2026-07-26, desktop daemon on macOS):
//
//   cat: /etc/os-release: No such file or directory
//
// arriving on daemon stderr on every boot. `/etc/os-release` is a Linux
// (freedesktop) interface; on macOS/Windows the probe is guaranteed to fail.
// The surrounding try/catch only swallows the *exception* — `execFileSync`
// leaves the child's stderr wired to the parent's unless `stdio` says
// otherwise, and this was the one probe in capabilities.ts that omitted the
// `stdio: ['ignore','pipe','ignore']` the other probes all use.
//
// ORACLE: the child process's real stderr bytes. Deliberately NOT a spy on
// execFileSync — the leak happens at the file-descriptor level, below anything a
// spy can see, which is exactly why it survived into a shipped build. So the
// test bundles the real module with esbuild, runs it in a real child process,
// and reads what that process actually wrote to fd 2.
//
// The expectation is platform-split rather than skipped: the gate's whole
// content is "linux yes / everything else no", so each host asserts its own half
//   - non-Linux: the probe must not run  → clean stderr AND os.distro undefined
//   - Linux:     the probe must still run → os.distro populated
// A skip on either side would let the gate be deleted (or inverted) unnoticed.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESBUILD = path.resolve(HERE, '../node_modules/.bin/esbuild');

interface ProbeResult {
  stderr: string;
  distro: string | undefined;
}

/**
 * Run the REAL getCapabilitySnapshot() in a child process and capture what that
 * process writes to fd 2.
 */
function runSnapshotInChildProcess(): ProbeResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'prismer-caps-probe-'));
  try {
    const entry = path.join(dir, 'entry.ts');
    const out = path.join(dir, 'entry.cjs');
    const resultFile = path.join(dir, 'result.json');
    writeFileSync(
      entry,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { getCapabilitySnapshot } from ${JSON.stringify(path.resolve(HERE, '../src/daemon/capabilities.ts'))};`,
        `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(getCapabilitySnapshot().os));`,
      ].join('\n'),
    );
    execFileSync(ESBUILD, [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const child = spawnSync(process.execPath, [out], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    expect(child.status, `child failed: ${child.stderr?.toString()}`).toBe(0);
    return {
      stderr: child.stderr.toString(),
      distro: (JSON.parse(readFileSync(resultFile, 'utf8')) as { distro?: string }).distro,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('capability snapshot — /etc/os-release distro probe', () => {
  it(
    'is gated on Linux and never leaks the probe failure to stderr',
    () => {
      const { stderr, distro } = runSnapshotInChildProcess();

      // The headline invariant, true on every platform: the capability probe is
      // best-effort and must be silent on fd 2 regardless of what is installed.
      expect(stderr).not.toMatch(/os-release/);

      if (process.platform === 'linux') {
        // The gate must not have turned the probe off where it is meaningful.
        expect(distro, 'PRETTY_NAME should be readable on Linux').toBeTruthy();
      } else {
        // Nothing to read here — and, crucially, nothing attempted.
        expect(distro).toBeUndefined();
      }
    },
    120_000,
  );
});
