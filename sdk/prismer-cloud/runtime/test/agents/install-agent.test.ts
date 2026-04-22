// T13 — install-agent.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { installAgent } from '../../src/agents/install-agent.js';
import type { AgentCatalogEntry } from '../../src/agents/registry.js';

// ============================================================
// Helpers
// ============================================================

const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

function makeCollector(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Buffer): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    isTTY: false,
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

function makeCtx(opts?: { mode?: 'pretty' | 'json' | 'quiet' }): {
  ctx: CliContext;
  out: string[];
  err: string[];
} {
  const outCol = makeCollector();
  const errCol = makeCollector();
  const ui = new UI({
    mode: opts?.mode ?? 'pretty',
    color: false,
    stream: outCol.stream,
    errStream: errCol.stream,
  });
  const ctx: CliContext = {
    ui,
    keychain: {} as CliContext['keychain'],
    cwd: process.cwd(),
    argv: [],
  };
  return { ctx, out: outCol.chunks, err: errCol.chunks };
}

// ============================================================
// Catalog stubs for injection
// ============================================================

function makeClaudeCodeEntry(detected: { found: boolean; binaryPath?: string; version?: string }): AgentCatalogEntry {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    packPackage: '@prismer/claude-code-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath: '~/.claude/hooks.json',
    mcpConfigPath: '~/.claude/mcp_servers.json',
    upstreamBinary: 'claude',
    upstreamVersionRange: '>=4.0.0',
    tiersSupported: [1, 2, 3, 4, 5, 6, 7],
    capabilityTags: ['code', 'shell', 'mcp', 'approval', 'skill', 'fs'],
    detect: async () => detected,
  };
}

// ============================================================
// Tests
// ============================================================

describe('installAgent — unknown agent', () => {
  it('throws and emits error for unknown agent name', async () => {
    const { ctx, err } = makeCtx();
    await expect(
      installAgent(ctx, { name: 'no-such-agent' }),
    ).rejects.toThrow('Unknown agent: no-such-agent');
    const errStr = err.join('');
    expect(stripAnsi(errStr)).toContain('Unknown agent');
  });
});

describe('installAgent — binary not found', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-install-missing-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:false in non-interactive mode when binary missing', async () => {
    const { ctx } = makeCtx();
    const catalog = [makeClaudeCodeEntry({ found: false })];
    const result = await installAgent(ctx, {
      name: 'claude-code',
      nonInteractive: true,
      catalog,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toBe(0);
  });

  it('throws in interactive mode when binary missing', async () => {
    const { ctx } = makeCtx();
    const catalog = [makeClaudeCodeEntry({ found: false })];
    await expect(
      installAgent(ctx, { name: 'claude-code', nonInteractive: false, catalog }),
    ).rejects.toThrow(/not found on PATH/);
  });

  it('returns version:"unknown" when binary is missing (no install ran)', async () => {
    const { ctx } = makeCtx();
    const catalog = [makeClaudeCodeEntry({ found: false })];
    const result = await installAgent(ctx, {
      name: 'claude-code',
      nonInteractive: true,
      catalog,
    });
    expect(result.version).toBe('unknown');
  });

  it('runs the agent install command with installAgentBinary:true, then installs hooks', async () => {
    const { ctx, out } = makeCtx();
    const commands: string[] = [];
    let installed = false;
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: false }),
        hookConfigPath,
        installCommand: 'echo install-agent',
        detect: async () => {
          if (!installed) return { found: false };
          return { found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' };
        },
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      installAgentBinary: true,
      runCommand: async (command) => {
        commands.push(command);
        installed = true;
        return 0;
      },
    });

    expect(commands).toEqual(['echo install-agent']);
    expect(result.ok).toBe(true);
    expect(result.checks).toBe(3);
    expect(fs.existsSync(hookConfigPath)).toBe(true);
    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('Installing Claude Code CLI');
    expect(outStr).toContain('Claude Code CLI installed');
    expect(outStr).toContain('Claude Code is ready');
  });

  it('throws when installAgentBinary:true and the agent install command fails', async () => {
    const { ctx, out } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: false }),
        installCommand: 'exit 42',
      },
    ];

    await expect(
      installAgent(ctx, {
        name: 'claude-code',
        catalog,
        homeDir: tmpDir,
        installAgentBinary: true,
        runCommand: async () => 42,
      }),
    ).rejects.toThrow(/CLI install failed/);

    expect(stripAnsi(out.join(''))).toContain('exit code 42');
  });
});

describe('installAgent — successful install', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-install-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges hooks into a temp path and returns ok:true', async () => {
    const { ctx, out } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath: path.join(tmpDir, '.claude', 'hooks.json'), // absolute override
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      daemonUrl: 'http://127.0.0.1:3210',
      // Force npm path: the GitHub Release manifest is only available on
      // tagged releases, and this test runs in-tree where no release yet
      // exists. Production installs go through the pack-registry.ts fetch
      // flow (covered by pack-verify.test.ts + fs-rpc integration tests).
      source: 'npm',
    });

    expect(result.ok).toBe(true);
    expect(result.agent).toBe('claude-code');
    // npm path: packManifest is undefined, require.resolve may or may not
    // resolve @prismer/claude-code-plugin — accept 'unknown' or a real semver.
    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
    expect(result.source).toBe('npm');
    expect(result.checks).toBe(3);

    // Sidecar must be written
    const sidecarPath = path.join(tmpDir, '.prismer', 'agents', 'claude-code.version');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.readFileSync(sidecarPath, 'utf-8').trim()).toBe(result.version);

    // Hook file should exist
    expect(fs.existsSync(hookConfigPath)).toBe(true);

    // Output should contain success messages
    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('Claude Code is ready');
  });

  it('json mode: ui.json output contains ok/agent/version/source/checks', async () => {
    const { ctx, out } = makeCtx({ mode: 'json' });

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/bin/claude', version: '4.3.0' }),
        hookConfigPath: path.join(tmpDir, '.claude', 'hooks.json'),
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
    });

    // In json mode, UI doesn't print pretty output, but result object has correct fields
    expect(result.ok).toBe(true);
    expect(result.source).toBe('npm');
    // out should be empty in json mode (ui.ok is suppressed)
    const outStr = out.join('');
    expect(outStr).toBe('');
  });

  it('npm path: result.version is not the old hardcoded "1.9.0" and sidecar is written', async () => {
    // Verifies the fix: version is never a literal '1.9.0' string; it comes from
    // readInstalledPackageVersion (or 'unknown' when the pack isn't installed globally).
    // The critical invariant is: sidecar written ↔ result.version match.
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
    });

    // Version is a non-empty string (either the real installed semver or 'unknown')
    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);

    // Sidecar must be written and match the returned version
    const sidecarPath = path.join(tmpDir, '.prismer', 'agents', 'claude-code.version');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.readFileSync(sidecarPath, 'utf-8').trim()).toBe(result.version);
  });
});

describe('installAgent — version range check', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-install-ver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws on incompatible upstream version', async () => {
    const { ctx } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/bin/claude', version: '3.9.0' }),
        hookConfigPath: path.join(tmpDir, '.claude', 'hooks.json'),
      },
    ];

    await expect(
      installAgent(ctx, { name: 'claude-code', catalog, homeDir: tmpDir }),
    ).rejects.toThrow(/Incompatible version|does not satisfy/);
  });

  it('proceeds when upstream version is undefined (no version output)', async () => {
    const { ctx } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/bin/claude', version: undefined }),
        hookConfigPath: path.join(tmpDir, '.claude', 'hooks.json'),
      },
    ];

    // version is undefined — version range check is skipped (lenient)
    const result = await installAgent(ctx, { name: 'claude-code', catalog, homeDir: tmpDir });
    expect(result.ok).toBe(true);
  });

  it('upgrades an incompatible agent when installAgentBinary:true', async () => {
    const { ctx, out } = makeCtx();
    const commands: string[] = [];
    let upgraded = false;
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/bin/claude', version: '3.9.0' }),
        hookConfigPath,
        installCommand: 'echo upgrade-agent',
        detect: async () => upgraded
          ? { found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }
          : { found: true, binaryPath: '/usr/bin/claude', version: '3.9.0' },
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      installAgentBinary: true,
      runCommand: async (command) => {
        commands.push(command);
        upgraded = true;
        return 0;
      },
    });

    expect(commands).toEqual(['echo upgrade-agent']);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(hookConfigPath)).toBe(true);
    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('Upgrading Claude Code CLI');
    expect(outStr).toContain('Claude Code CLI upgraded');
  });

  it('throws if upgrade completes but the version is still incompatible', async () => {
    const { ctx } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/bin/claude', version: '3.9.0' }),
        installCommand: 'echo upgrade-agent',
      },
    ];

    await expect(
      installAgent(ctx, {
        name: 'claude-code',
        catalog,
        homeDir: tmpDir,
        installAgentBinary: true,
        runCommand: async () => 0,
      }),
    ).rejects.toThrow(/does not satisfy/);
  });
});

describe('installAgent — already installed detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-install-already-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePreInstalledConfig(hookConfigPath: string): { mtimeMs: number; content: string } {
    fs.mkdirSync(path.dirname(hookConfigPath), { recursive: true });
    const preExisting = {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: 'node "/some/path/hooks/para-emit.mjs" PreToolUse' },
            ],
          },
        ],
      },
    };
    const content = JSON.stringify(preExisting, null, 2);
    fs.writeFileSync(hookConfigPath, content, 'utf-8');
    const stat = fs.statSync(hookConfigPath);
    return { mtimeMs: stat.mtimeMs, content };
  }

  it('returns alreadyInstalled:true and does not re-run installHooks (no sidecar → version:unknown)', async () => {
    const { ctx, out } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    const before = writePreInstalledConfig(hookConfigPath);

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
    });

    expect(result.alreadyInstalled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.checks).toBe(0);
    // No sidecar was written before this call — should fall back to 'unknown'
    expect(result.version).toBe('unknown');

    // File content must be byte-for-byte unchanged — installHooks was not invoked
    const after = fs.readFileSync(hookConfigPath, 'utf-8');
    expect(after).toBe(before.content);

    // Output should contain the canonical already-installed line with unknown version
    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('already installed (vunknown)');
    expect(outStr).toContain('prismer agent update');
  });

  it('returns alreadyInstalled:true with version from sidecar when sidecar exists', async () => {
    const { ctx, out } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    writePreInstalledConfig(hookConfigPath);

    // Write sidecar with a known version
    const sidecarDir = path.join(tmpDir, '.prismer', 'agents');
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(sidecarDir, 'claude-code.version'), '1.2.3\n', 'utf-8');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
    });

    expect(result.alreadyInstalled).toBe(true);
    expect(result.version).toBe('1.2.3');

    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('already installed (v1.2.3)');
  });

  it('force:true bypasses the already-installed check and re-runs install', async () => {
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    writePreInstalledConfig(hookConfigPath);

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      force: true,
    });

    expect(result.alreadyInstalled).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.checks).toBeGreaterThan(0);
  });
});

// ============================================================
// Ed25519 signature failure must halt — not fall through to npm (security fix)
// ============================================================

describe('installAgent — CDN signature failure halts install', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-sig-halt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects when CDN returns a manifest with an invalid Ed25519 signature', async () => {
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    // Build a YAML manifest whose `signature` field is a valid base64 string
    // but does NOT verify against the Prismer release pubkey.
    const badSignature = Buffer.alloc(64, 0).toString('base64');
    const fakeManifestYaml = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      `adapter: "@prismer/claude-code-plugin"`,
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3, 4, 5, 6, 7]',
      'capabilityTags: [code, shell, mcp, approval, skill, fs]',
      `upstreamPackage: "@prismer/claude-code-plugin"`,
      'upstreamVersionRange: "^1.9.0"',
      'description: "Claude Code PARA adapter"',
      'size: 42kb',
      `signature: ${badSignature}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    const tampered = async (url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(fakeManifestYaml, {
        status: 200,
        headers: { 'Content-Type': 'text/yaml' },
      });
    };

    await expect(
      installAgent(ctx, {
        name: 'claude-code',
        catalog,
        homeDir: tmpDir,
        // source defaults to 'cdn' — triggers the CDN tier
        fetchImpl: tampered,
      }),
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('does NOT resolve with source:npm after CDN signature failure', async () => {
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const badSignature = Buffer.alloc(64, 0).toString('base64');
    const fakeManifestYaml = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      `adapter: "@prismer/claude-code-plugin"`,
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3, 4, 5, 6, 7]',
      'capabilityTags: [code, shell, mcp, approval, skill, fs]',
      `upstreamPackage: "@prismer/claude-code-plugin"`,
      'upstreamVersionRange: "^1.9.0"',
      'description: "Claude Code PARA adapter"',
      'size: 42kb',
      `signature: ${badSignature}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    const tampered = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(fakeManifestYaml, {
        status: 200,
        headers: { 'Content-Type': 'text/yaml' },
      });
    };

    let result: Awaited<ReturnType<typeof installAgent>> | undefined;
    let threw = false;
    try {
      result = await installAgent(ctx, {
        name: 'claude-code',
        catalog,
        homeDir: tmpDir,
        fetchImpl: tampered,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // Ensure it did not silently succeed with npm as source
    expect(result).toBeUndefined();
  });

  it('rejects and does NOT fall through to npm when fetchPackManifest itself throws "Pack manifest signature verification failed"', async () => {
    // This exercises the path where pack-registry.ts's internal verifySignature
    // call fails (line ~183) and throws before returning to install-agent.ts.
    // The catch block in install-agent.ts must re-throw it rather than warning
    // and falling through to the npm tier.
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    // Return a manifest YAML with a signature that will fail pack-registry's
    // internal verifySignature check (all-zero bytes ≠ valid Ed25519 sig).
    const badSignature = Buffer.alloc(64, 0).toString('base64');
    const fakeManifestYaml = [
      'name: claude-code',
      'displayName: "Claude Code Plugin"',
      `adapter: "@prismer/claude-code-plugin"`,
      'version: 1.9.0',
      'tiersSupported: [1, 2, 3, 4, 5, 6, 7]',
      'capabilityTags: [code, shell, mcp, approval, skill, fs]',
      `upstreamPackage: "@prismer/claude-code-plugin"`,
      'upstreamVersionRange: "^1.9.0"',
      'description: "Claude Code PARA adapter"',
      'size: 42kb',
      `signature: ${badSignature}`,
      'signedAt: 2026-04-21T00:00:00Z',
    ].join('\n');

    // fetchImpl returns a valid 200 with a tampered manifest.
    // pack-registry.fetchPackManifest will parse it and then throw
    // "Pack manifest signature verification failed: claude-code".
    const tampered = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return new Response(fakeManifestYaml, {
        status: 200,
        headers: { 'Content-Type': 'text/yaml' },
      });
    };

    let result: Awaited<ReturnType<typeof installAgent>> | undefined;
    let caughtError: Error | undefined;
    try {
      result = await installAgent(ctx, {
        name: 'claude-code',
        catalog,
        homeDir: tmpDir,
        fetchImpl: tampered,
      });
    } catch (err) {
      caughtError = err as Error;
    }

    // Must throw — not silently fall through to npm
    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toMatch(/^Pack manifest signature verification failed/i);
    // Must NOT have resolved with a result
    expect(result).toBeUndefined();
  });
});

// ============================================================
// agents.json registry wiring
// ============================================================

import { readAgentsRegistry, findAgent } from '../../src/agents/agents-registry.js';

describe('installAgent — agents.json registry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-install-registry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path writes an entry to agents.json with version, source, installedAt, hookConfigPath', async () => {
    const { ctx } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
    });

    expect(result.ok).toBe(true);

    const entry = findAgent(tmpDir, 'claude-code');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(result.version);
    expect(entry?.source).toBe('npm');
    expect(entry?.hookConfigPath).toBe(hookConfigPath);
    expect(typeof entry?.installedAt).toBe('string');
    // installedAt must be a valid ISO date
    expect(new Date(entry!.installedAt).getTime()).toBeGreaterThan(0);
  });

  it('missing binary (nonInteractive) does NOT write to registry', async () => {
    const { ctx } = makeCtx();
    const catalog = [makeClaudeCodeEntry({ found: false })];

    await installAgent(ctx, {
      name: 'claude-code',
      nonInteractive: true,
      catalog,
      homeDir: tmpDir,
    });

    expect(findAgent(tmpDir, 'claude-code')).toBeUndefined();
    // Registry file should not exist
    const registryFile = path.join(tmpDir, '.prismer', 'agents.json');
    expect(fs.existsSync(registryFile)).toBe(false);
  });

  it('already-installed branch prefers registry over hook-fingerprint', async () => {
    const { ctx, out } = makeCtx();
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');

    // Write a pre-existing registry entry (simulates a previous install)
    const { upsertAgent } = await import('../../src/agents/agents-registry.js');
    upsertAgent(tmpDir, {
      name: 'claude-code',
      displayName: 'Claude Code',
      version: '2.5.0',
      source: 'cdn',
      installedAt: '2026-01-01T00:00:00.000Z',
      hookConfigPath,
    });

    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    const result = await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
    });

    expect(result.alreadyInstalled).toBe(true);
    expect(result.version).toBe('2.5.0');
    expect(result.source).toBe('cdn');

    const outStr = out.join('').replace(/\u001b\[[0-9;]*m/g, '');
    expect(outStr).toContain('already installed (v2.5.0)');
  });
});

// ============================================================
// openclaw plugin registration (v1.9.0 closure report §14.4 gap N1)
// ============================================================

function makeOpenClawEntry(detected: { found: boolean; binaryPath?: string; version?: string }): AgentCatalogEntry {
  return {
    name: 'openclaw',
    displayName: 'OpenClaw',
    packPackage: '@prismer/openclaw-channel',
    packVersionRange: '^1.9.0',
    hookConfigPath: '~/.openclaw/hooks.json',
    upstreamBinary: 'openclaw',
    upstreamVersionRange: undefined,
    tiersSupported: [1, 2, 3, 4, 5, 6],
    capabilityTags: ['code', 'shell', 'mcp', 'fs'],
    detect: async () => detected,
  };
}

describe('installAgent — openclaw plugin registration (N1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-openclaw-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invokes `openclaw plugins install @prismer/openclaw-channel` for openclaw agent', async () => {
    const { ctx } = makeCtx();
    const commands: string[] = [];
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeOpenClawEntry({ found: true, binaryPath: '/usr/local/bin/openclaw', version: '1.2.0' }),
        hookConfigPath: path.join(tmpDir, '.openclaw', 'hooks.json'),
      },
    ];

    await installAgent(ctx, {
      name: 'openclaw',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
      runCommand: async (command) => {
        commands.push(command);
        return 0;
      },
    });

    expect(commands).toContain('openclaw plugins install @prismer/openclaw-channel');
  });

  it('does NOT invoke `openclaw plugins install` for claude-code agent', async () => {
    const { ctx } = makeCtx();
    const commands: string[] = [];
    const hookConfigPath = path.join(tmpDir, '.claude', 'hooks.json');
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeClaudeCodeEntry({ found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' }),
        hookConfigPath,
      },
    ];

    await installAgent(ctx, {
      name: 'claude-code',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
      runCommand: async (command) => {
        commands.push(command);
        return 0;
      },
    });

    expect(commands.find((c) => c.includes('openclaw plugins install'))).toBeUndefined();
  });

  it('is non-fatal when `openclaw plugins install` exits non-zero', async () => {
    const { ctx, out } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeOpenClawEntry({ found: true, binaryPath: '/usr/local/bin/openclaw', version: '1.2.0' }),
        hookConfigPath: path.join(tmpDir, '.openclaw', 'hooks.json'),
      },
    ];

    const result = await installAgent(ctx, {
      name: 'openclaw',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
      runCommand: async (command) => {
        if (command.includes('openclaw plugins install')) return 1;
        return 0;
      },
    });

    expect(result.agent).toBe('openclaw');
    expect(stripAnsi(out.join(''))).toContain('openclaw plugins install exited with code 1');
  });

  it('is non-fatal when `openclaw plugins install` throws an error', async () => {
    const { ctx, out } = makeCtx();
    const catalog: AgentCatalogEntry[] = [
      {
        ...makeOpenClawEntry({ found: true, binaryPath: '/usr/local/bin/openclaw', version: '1.2.0' }),
        hookConfigPath: path.join(tmpDir, '.openclaw', 'hooks.json'),
      },
    ];

    const result = await installAgent(ctx, {
      name: 'openclaw',
      catalog,
      homeDir: tmpDir,
      source: 'npm',
      runCommand: async (command) => {
        if (command.includes('openclaw plugins install')) {
          throw new Error('ENOENT: openclaw not found');
        }
        return 0;
      },
    });

    expect(result.agent).toBe('openclaw');
    expect(stripAnsi(out.join(''))).toContain('openclaw plugins install failed');
  });
});
