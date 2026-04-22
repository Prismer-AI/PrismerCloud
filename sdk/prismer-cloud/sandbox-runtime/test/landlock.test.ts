import { describe, it, expect, beforeEach } from 'vitest';
import {
  LANDLOCK_ACCESS_FS,
  detectLandlock,
  generateLandlockPolicy,
  isLandlockAvailable,
  landlockToBwrapArgs,
  LandlockUnavailableError,
  resetLandlockCache,
} from '../src/landlock.js';
import { defaultSeccompPolicy, DANGEROUS_SYSCALLS, isSeccompAvailable, seccompToBwrapArgs } from '../src/seccomp.js';

describe('LANDLOCK_ACCESS_FS constants', () => {
  it('matches kernel bit positions', () => {
    // These must equal what the kernel defines in <linux/landlock.h>. If this
    // breaks, a native addon would see mismatched flags → silently wrong policy.
    expect(LANDLOCK_ACCESS_FS.EXECUTE).toBe(0x1);
    expect(LANDLOCK_ACCESS_FS.READ_FILE).toBe(0x4);
    expect(LANDLOCK_ACCESS_FS.READ_DIR).toBe(0x8);
    expect(LANDLOCK_ACCESS_FS.TRUNCATE).toBe(0x4000);
  });
});

describe('generateLandlockPolicy', () => {
  it('includes workspace in read+write set', () => {
    const p = generateLandlockPolicy({ workspace: '/home/me/project' });
    expect(p.readWritePaths).toContain('/home/me/project');
    expect(p.readWritePaths).toContain('/tmp');
  });

  it('includes system exec by default, excludes when disabled', () => {
    const withExec = generateLandlockPolicy({ workspace: '/w', allowSystemExec: true });
    expect(withExec.execPaths.length).toBeGreaterThan(0);
    const noExec = generateLandlockPolicy({ workspace: '/w', allowSystemExec: false });
    expect(noExec.execPaths).toHaveLength(0);
  });

  it('extra paths are included', () => {
    const p = generateLandlockPolicy({
      workspace: '/w',
      extraReadPaths: ['/opt/cfg'],
      extraWritePaths: ['/var/log/app'],
    });
    expect(p.readPaths).toContain('/opt/cfg');
    expect(p.readWritePaths).toContain('/var/log/app');
  });

  it('exposes FROZEN paths in denyPaths', () => {
    const p = generateLandlockPolicy({ workspace: '/w' });
    // FROZEN list should surface in denyPaths for caller-side logging
    expect(p.denyPaths.some((d) => d.includes('.ssh'))).toBe(true);
    expect(p.denyPaths.some((d) => d.includes('.gitconfig'))).toBe(true);
  });
});

describe('landlockToBwrapArgs', () => {
  beforeEach(() => {
    resetLandlockCache();
  });

  it('throws LandlockUnavailableError when not available', () => {
    const policy = generateLandlockPolicy({ workspace: '/w' });
    if (!isLandlockAvailable()) {
      expect(() => landlockToBwrapArgs(policy)).toThrow(LandlockUnavailableError);
    }
  });

  it('detectLandlock returns a stable shape', () => {
    const d = detectLandlock();
    expect(typeof d.kernelOk).toBe('boolean');
    expect(typeof d.bwrapLandlockOk).toBe('boolean');
  });
});

describe('seccomp policy', () => {
  it('default policy denies dangerous syscalls', () => {
    const p = defaultSeccompPolicy();
    expect(p.defaultAllow).toBe(true);
    expect(p.denySyscalls).toEqual(expect.arrayContaining(['init_module', 'bpf', 'ptrace']));
    expect(p.denySyscalls).toEqual(DANGEROUS_SYSCALLS);
  });

  it('isSeccompAvailable returns a boolean', () => {
    expect(typeof isSeccompAvailable()).toBe('boolean');
  });

  it('seccompToBwrapArgs returns empty in v1.9.0 (rely on bwrap default)', () => {
    const p = defaultSeccompPolicy();
    expect(seccompToBwrapArgs(p)).toEqual([]);
  });
});
