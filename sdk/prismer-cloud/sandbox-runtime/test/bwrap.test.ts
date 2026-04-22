import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  generateBwrapArgs,
  spawnInBwrap,
  BwrapUnavailableError,
  isBwrapAvailable,
} from '../src/bwrap.js';

// bwrap was implemented in v1.9.0 — these tests previously checked a
// BwrapNotImplementedError stub that has been removed. Current surface:
//   - generateBwrapArgs() succeeds on any platform (pure arg generation)
//   - spawnInBwrap() throws BwrapUnavailableError on non-Linux or when
//     bwrap binary is absent.

describe('bwrap arg generation', () => {
  it('generateBwrapArgs returns a non-empty arg list ending with separator', () => {
    const args = generateBwrapArgs({ workspace: os.tmpdir() });
    expect(args.length).toBeGreaterThan(0);
    expect(args[args.length - 1]).toBe('--');
  });

  it('respects allowNetwork:false by appending --unshare-net', () => {
    const args = generateBwrapArgs({ workspace: os.tmpdir(), allowNetwork: false });
    expect(args).toContain('--unshare-net');
  });

  it('omits --unshare-net when allowNetwork:true', () => {
    const args = generateBwrapArgs({ workspace: os.tmpdir(), allowNetwork: true });
    expect(args).not.toContain('--unshare-net');
  });

  it('binds the workspace as read-write', () => {
    const args = generateBwrapArgs({ workspace: os.tmpdir() });
    const bindIdx = args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
  });
});

describe('bwrap runtime availability', () => {
  it('isBwrapAvailable is false on non-Linux', () => {
    if (os.platform() !== 'linux') {
      expect(isBwrapAvailable()).toBe(false);
    }
  });

  it('spawnInBwrap throws BwrapUnavailableError on non-Linux', () => {
    if (os.platform() === 'linux') return; // skip on linux
    let caught: unknown;
    try {
      spawnInBwrap({ workspace: os.tmpdir() }, '/bin/sh', ['-c', 'true']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BwrapUnavailableError);
    expect((caught as Error).name).toBe('BwrapUnavailableError');
    expect((caught as Error).message).toMatch(/Linux/i);
  });
});
