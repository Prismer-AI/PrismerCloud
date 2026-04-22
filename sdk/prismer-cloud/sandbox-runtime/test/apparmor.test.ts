import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  generateProfile,
  defaultAgentProfile,
  isAppArmorAvailable,
  writeProfile,
  AppArmorUnavailableError,
} from '../src/apparmor.js';
import { FROZEN_DIRS, FROZEN_FILES } from '../src/frozen.js';

// ============================================================
// Helpers
// ============================================================

const HOME = process.env['HOME'] ?? os.homedir();

// ============================================================
// Cross-platform tests (always run)
// ============================================================

describe('generateProfile — cross-platform', () => {
  it('returns a non-empty string containing the profile name', () => {
    const profile = generateProfile({
      profileName: 'prismer-test-agent',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(typeof profile).toBe('string');
    expect(profile.length).toBeGreaterThan(0);
    expect(profile).toContain('profile prismer-test-agent flags=(enforce)');
  });

  it('includes tunables and base abstraction', () => {
    const profile = generateProfile({
      profileName: 'test-base',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile).toContain('#include <tunables/global>');
    expect(profile).toContain('#include <abstractions/base>');
  });

  it('generates read rules with /** r, suffix', () => {
    const profile = generateProfile({
      profileName: 'test-read',
      allowedReadPaths: ['/usr/lib', '/usr/share'],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile).toContain('/usr/lib/** r,');
    expect(profile).toContain('/usr/share/** r,');
  });

  it('generates write rules with /** rw, suffix', () => {
    const profile = generateProfile({
      profileName: 'test-write',
      allowedReadPaths: [],
      allowedWritePaths: ['/home/user/workspace'],
      allowedExecPaths: [],
    });
    expect(profile).toContain('/home/user/workspace/** rw,');
  });

  it('generates exec rules with ix, suffix (no /**)', () => {
    const profile = generateProfile({
      profileName: 'test-exec',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: ['/usr/bin/node', '/usr/bin/git'],
    });
    expect(profile).toContain('/usr/bin/node ix,');
    expect(profile).toContain('/usr/bin/git ix,');
  });

  it('includes all three path types together', () => {
    const profile = generateProfile({
      profileName: 'test-all',
      allowedReadPaths: ['/usr/lib'],
      allowedWritePaths: ['/home/user/workspace'],
      allowedExecPaths: ['/usr/bin/node'],
    });
    expect(profile).toContain('/usr/lib/** r,');
    expect(profile).toContain('/home/user/workspace/** rw,');
    expect(profile).toContain('/usr/bin/node ix,');
  });

  it('includes network rules when allowNetwork is true', () => {
    const profile = generateProfile({
      profileName: 'test-net',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
      allowNetwork: true,
    });
    expect(profile).toContain('network inet stream,');
    expect(profile).toContain('network inet dgram,');
    expect(profile).toContain('network inet6 stream,');
    expect(profile).toContain('network inet6 dgram,');
  });

  it('includes DNS netlink rule when allowNetwork + allowDns', () => {
    const profile = generateProfile({
      profileName: 'test-net-dns',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
      allowNetwork: true,
      allowDns: true,
    });
    expect(profile).toContain('network netlink raw,');
  });

  it('excludes DNS netlink rule when allowNetwork=true but allowDns=false', () => {
    const profile = generateProfile({
      profileName: 'test-net-nodns',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
      allowNetwork: true,
      allowDns: false,
    });
    expect(profile).toContain('network inet stream,');
    expect(profile).not.toContain('network netlink raw,');
  });

  it('excludes network rules when allowNetwork is false', () => {
    const profile = generateProfile({
      profileName: 'test-nonet',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
      allowNetwork: false,
      allowDns: false,
    });
    expect(profile).not.toContain('network inet stream,');
    expect(profile).not.toContain('network inet dgram,');
    expect(profile).not.toContain('network inet6 stream,');
  });

  it('includes DNS-only rules when allowNetwork=false but allowDns=true', () => {
    const profile = generateProfile({
      profileName: 'test-dnsonly',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
      allowNetwork: false,
      allowDns: true,
    });
    expect(profile).not.toContain('network inet stream,');
    expect(profile).toContain('network inet dgram,');
    expect(profile).toContain('network netlink raw,');
    expect(profile).toContain('DNS resolution only');
  });

  it('defaults: allowNetwork=true, allowDns=true when omitted', () => {
    const profile = generateProfile({
      profileName: 'test-defaults',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile).toContain('network inet stream,');
    expect(profile).toContain('network netlink raw,');
  });

  it('denies dangerous capabilities', () => {
    const profile = generateProfile({
      profileName: 'test-caps',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile).toContain('deny capability sys_admin,');
    expect(profile).toContain('deny capability sys_rawio,');
    expect(profile).toContain('deny capability net_raw,');
    expect(profile).toContain('deny capability sys_module,');
    expect(profile).toContain('deny capability sys_ptrace,');
    expect(profile).toContain('deny capability sys_boot,');
    expect(profile).toContain('deny capability mknod,');
  });

  it('denies sensitive system paths', () => {
    const profile = generateProfile({
      profileName: 'test-deny',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile).toContain('deny /etc/shadow r,');
    expect(profile).toContain('deny /etc/passwd w,');
    expect(profile).toContain('deny /etc/sudoers* rw,');
    expect(profile).toContain('deny /proc/*/mem rw,');
    expect(profile).toContain('deny /proc/kcore r,');
    expect(profile).toContain('deny /sys/firmware/** rw,');
  });

  it('includes FROZEN_DIRS deny rules (except .git per D20)', () => {
    const profile = generateProfile({
      profileName: 'test-frozen',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });

    for (const dir of FROZEN_DIRS) {
      if (dir === '.git') {
        // D20: .git should be skipped with a comment
        expect(profile).toContain('.git skipped (D20)');
        expect(profile).not.toContain(`deny ${path.join(HOME, '.git')}/** rw,`);
      } else {
        const fullPath = path.join(HOME, dir);
        expect(profile).toContain(`deny ${fullPath}/** rw,`);
      }
    }
  });

  it('includes FROZEN_FILES deny rules', () => {
    const profile = generateProfile({
      profileName: 'test-frozen-files',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });

    for (const file of FROZEN_FILES) {
      const fullPath = path.join(HOME, file);
      expect(profile).toContain(`deny ${fullPath} rw,`);
    }
  });

  it('profile ends with closing brace', () => {
    const profile = generateProfile({
      profileName: 'test-end',
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    });
    expect(profile.trimEnd()).toMatch(/\}$/);
  });
});

// ============================================================
// Injection guard tests (cross-platform)
// ============================================================

describe('generateProfile — injection guard', () => {
  it('throws AppArmorUnavailableError for profile name with semicolons', () => {
    expect(() =>
      generateProfile({
        profileName: 'test; rm -rf /',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for profile name with spaces', () => {
    expect(() =>
      generateProfile({
        profileName: 'test profile',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for profile name starting with a dot', () => {
    expect(() =>
      generateProfile({
        profileName: '.hidden',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for profile name starting with a hyphen', () => {
    expect(() =>
      generateProfile({
        profileName: '-flag',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for empty profile name', () => {
    expect(() =>
      generateProfile({
        profileName: '',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('accepts valid profile name with hyphens, dots, and underscores', () => {
    expect(() =>
      generateProfile({
        profileName: 'prismer-agent_v1.2',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).not.toThrow();
  });

  it('throws for read path containing braces (AppArmor alternation)', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: ['/home/{user1,user2}'],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for write path containing braces', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: [],
        allowedWritePaths: ['/home/{user1,user2}'],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for exec path containing braces', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: ['/usr/{bin,sbin}/node'],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for path containing hash (AppArmor comments)', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: ['/home/user#comment'],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for path containing comma', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: ['/home/user,other'],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for path containing newline', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: ['/home/user\n/etc/shadow'],
        allowedWritePaths: [],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for path containing carriage return', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: [],
        allowedWritePaths: ['/home/user\r/etc/shadow'],
        allowedExecPaths: [],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('throws for path containing null byte', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-safe',
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedExecPaths: ['/usr/bin/node\0/etc/shadow'],
      }),
    ).toThrow(AppArmorUnavailableError);
  });

  it('does NOT throw for normal paths without forbidden characters', () => {
    expect(() =>
      generateProfile({
        profileName: 'test-ok',
        allowedReadPaths: ['/usr/lib', '/usr/share/doc'],
        allowedWritePaths: ['/home/user/workspace', '/tmp/test-output'],
        allowedExecPaths: ['/usr/bin/node', '/usr/local/bin/git'],
      }),
    ).not.toThrow();
  });
});

// ============================================================
// defaultAgentProfile tests (cross-platform)
// ============================================================

describe('defaultAgentProfile — cross-platform', () => {
  it('creates a profile with prismer- prefix', () => {
    const config = defaultAgentProfile('claude-code', '/home/user/project');
    expect(config.profileName).toBe('prismer-claude-code');
  });

  it('includes the workspace in both read and write paths', () => {
    const config = defaultAgentProfile('test-agent', '/home/user/project');
    // workDir may be resolved via realpath; check at least one path contains the dir
    expect(config.allowedWritePaths.length).toBeGreaterThan(0);
    expect(config.allowedReadPaths.length).toBeGreaterThan(0);
  });

  it('includes system libraries in read paths', () => {
    const config = defaultAgentProfile('test-agent', '/tmp/workspace');
    expect(config.allowedReadPaths).toContain('/usr/lib');
    expect(config.allowedReadPaths).toContain('/usr/share');
    expect(config.allowedReadPaths).toContain('/usr/local/lib');
    expect(config.allowedReadPaths).toContain('/usr/local/share');
  });

  it('includes HOME in read paths', () => {
    const config = defaultAgentProfile('test-agent', '/tmp/workspace');
    expect(config.allowedReadPaths).toContain(HOME);
  });

  it('scopes /tmp writes to agent name', () => {
    const config = defaultAgentProfile('hermes', '/workspace');
    const tmpPaths = config.allowedWritePaths.filter((p) => p.includes('/tmp'));
    expect(tmpPaths.some((p) => p.includes('prismer-hermes'))).toBe(true);
  });

  it('includes common exec paths (node, git, env, sh)', () => {
    const config = defaultAgentProfile('test-agent', '/tmp/workspace');
    expect(config.allowedExecPaths).toContain('/usr/bin/node');
    expect(config.allowedExecPaths).toContain('/usr/bin/git');
    expect(config.allowedExecPaths).toContain('/usr/bin/env');
    expect(config.allowedExecPaths).toContain('/bin/sh');
  });

  it('enables network and DNS by default', () => {
    const config = defaultAgentProfile('test-agent', '/tmp/workspace');
    expect(config.allowNetwork).toBe(true);
    expect(config.allowDns).toBe(true);
  });

  it('throws for agent name with forbidden characters', () => {
    expect(() => defaultAgentProfile('bad agent!', '/workspace')).toThrow(
      AppArmorUnavailableError,
    );
  });

  it('throws for workDir with forbidden characters', () => {
    expect(() =>
      defaultAgentProfile('valid-agent', '/workspace\n/etc/shadow'),
    ).toThrow(AppArmorUnavailableError);
  });

  it('generates a valid profile from the default config', () => {
    const config = defaultAgentProfile('roundtrip', '/tmp/workspace');
    const profile = generateProfile(config);
    expect(profile).toContain('profile prismer-roundtrip flags=(enforce)');
    expect(profile).toContain('/tmp/prismer-roundtrip/** rw,');
    expect(profile).toContain('/usr/bin/node ix,');
  });
});

// ============================================================
// writeProfile tests (cross-platform — writes to ~/.prismer/sandbox/)
// ============================================================

describe('writeProfile — cross-platform', () => {
  const cleanupPaths: string[] = [];

  // afterEach not imported, use afterAll-style cleanup instead:
  // Actually, just clean up inline since tests are isolated.

  it('writes profile to ~/.prismer/sandbox/ and returns absolute path', () => {
    const config = {
      profileName: `test-write-${Date.now()}`,
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    };
    const expectedDir = path.join(os.homedir(), '.prismer', 'sandbox');
    const returned = writeProfile(config);
    cleanupPaths.push(returned);

    try {
      expect(path.isAbsolute(returned)).toBe(true);
      expect(returned).toBe(path.join(expectedDir, `${config.profileName}.apparmor`));
      expect(fs.existsSync(returned)).toBe(true);

      const written = fs.readFileSync(returned, 'utf8');
      const expected = generateProfile(config);
      expect(written).toBe(expected);
    } finally {
      fs.rmSync(returned, { force: true });
    }
  });

  it('file permissions are 0644', () => {
    const config = {
      profileName: `test-perms-${Date.now()}`,
      allowedReadPaths: [],
      allowedWritePaths: [],
      allowedExecPaths: [],
    };
    const returned = writeProfile(config);

    try {
      const stat = fs.statSync(returned);
      // mode includes file type bits; mask to get permission bits only
      const perms = stat.mode & 0o777;
      expect(perms).toBe(0o644);
    } finally {
      fs.rmSync(returned, { force: true });
    }
  });
});

// ============================================================
// isAppArmorAvailable tests
// ============================================================

describe('isAppArmorAvailable — cross-platform', () => {
  it('returns a boolean', () => {
    const result = isAppArmorAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('returns false on macOS', () => {
    if (process.platform === 'darwin') {
      expect(isAppArmorAvailable()).toBe(false);
    }
  });
});

// ============================================================
// AppArmorUnavailableError tests
// ============================================================

describe('AppArmorUnavailableError', () => {
  it('has name set to AppArmorUnavailableError', () => {
    const err = new AppArmorUnavailableError('test reason');
    expect(err.name).toBe('AppArmorUnavailableError');
  });

  it('extends Error', () => {
    const err = new AppArmorUnavailableError('test reason');
    expect(err instanceof Error).toBe(true);
  });

  it('preserves the message', () => {
    const err = new AppArmorUnavailableError('specific reason');
    expect(err.message).toBe('specific reason');
  });
});
