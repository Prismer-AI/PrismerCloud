// release203/19 P0 — daemon start-lock self-pid guard.
//
// Root cause: in a container the daemon runs as pid 1 and writes
// `daemon.pid=1`. On a same-pod-sandbox container restart the emptyDir keeps
// the pidfile, so the *new* daemon (also pid 1) used to see `pidAlive(1)===true`
// and crash-loop with "Daemon already running (pid 1)". A self-referential
// pidfile is always our own stale leftover, never a live peer.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { daemonAlreadyRunning } from '../src/cli/util.js';

describe('daemonAlreadyRunning (start-lock guard)', () => {
  it('does NOT bail on a self-referential pidfile (container pid-1 restart)', () => {
    // daemon.pid === our own pid → stale leftover from the previous boot.
    expect(daemonAlreadyRunning(process.pid, process.pid)).toBe(false);
  });

  it('treats pid 1 from a previous boot as stale when we are also pid 1', () => {
    // Simulate the container case directly: both old + new daemon are pid 1.
    expect(daemonAlreadyRunning(1, 1)).toBe(false);
  });

  it('still bails when a DIFFERENT live pid holds the pidfile', () => {
    // Our own parent is guaranteed alive and has a different pid than this
    // process — a genuine "another daemon is running" signal.
    const otherAlivePid = process.ppid;
    expect(otherAlivePid).not.toBe(process.pid);
    expect(daemonAlreadyRunning(otherAlivePid, process.pid)).toBe(true);
  });

  it('does NOT bail when a different pid is dead (kernel reclaims the liveness signal)', () => {
    // Spawn a child, let it exit, then probe its (now-dead) pid. The kernel
    // makes kill(pid,0) fail for a dead pid, so a crashed daemon's pidfile
    // never blocks a restart.
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    expect(deadPid).not.toBe(process.pid);
    expect(daemonAlreadyRunning(deadPid, process.pid)).toBe(false);
  });

  it('does NOT bail when there is no pidfile', () => {
    expect(daemonAlreadyRunning(undefined, process.pid)).toBe(false);
  });
});
