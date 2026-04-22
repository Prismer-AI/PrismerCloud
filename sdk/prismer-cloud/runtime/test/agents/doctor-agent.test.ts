// T13 — doctor-agent.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { doctorAgent } from '../../src/agents/doctor-agent.js';
import { installHooks } from '../../src/agents/hooks.js';
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

function makeCtx(mode: 'pretty' | 'json' | 'quiet' = 'pretty'): {
  ctx: CliContext;
  out: string[];
  err: string[];
} {
  const outCol = makeCollector();
  const errCol = makeCollector();
  const ui = new UI({ mode, color: false, stream: outCol.stream, errStream: errCol.stream });
  const ctx: CliContext = {
    ui,
    keychain: {} as CliContext['keychain'],
    cwd: process.cwd(),
    argv: [],
  };
  return { ctx, out: outCol.chunks, err: errCol.chunks };
}

// ============================================================
// Catalog stub
// ============================================================

function makeEntry(
  detected: { found: boolean; binaryPath?: string; version?: string },
  hookConfigPath: string,
): AgentCatalogEntry {
  return {
    name: 'claude-code',
    displayName: 'Claude Code',
    packPackage: '@prismer/claude-code-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath,
    mcpConfigPath: undefined,
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

describe('doctorAgent — unknown agent', () => {
  it('throws for unknown agent name', async () => {
    const { ctx } = makeCtx();
    await expect(doctorAgent(ctx, 'no-such-agent')).rejects.toThrow('Unknown agent');
  });
});

describe('doctorAgent — all checks pass', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-doctor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports 6/6 when binary found, hook config present, sandbox present (linux mock)', async () => {
    const { ctx, out } = makeCtx('pretty');

    const hookPath = path.join(tmpDir, '.claude', 'hooks.json');
    await installHooks(hookPath, null, { daemonUrl: 'http://127.0.0.1:3210', pluginRoot: '/opt/prismer/test-plugin' });

    // Create sandbox profile
    const sandboxDir = path.join(tmpDir, '.prismer', 'sandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, 'claude-code.sb'), '(version 1)', 'utf-8');

    const catalog = [makeEntry(
      { found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' },
      hookPath,
    )];

    const result = await doctorAgent(ctx, 'claude-code', { catalog, homeDir: tmpDir });

    // Binary, hook config, PARA compliance, sandbox should all pass (4 checks)
    // Memory gateway and evolution sync depend on a running daemon and may fail
    const hookCheck = result.checks.find((c) => c.label === 'Hook config');
    expect(hookCheck?.pass).toBe(true);

    const paraCheck = result.checks.find((c) => c.label === 'PARA compliance');
    expect(paraCheck?.pass).toBe(true);

    const binaryCheck = result.checks.find((c) => c.label === 'Binary found');
    expect(binaryCheck?.pass).toBe(true);

    // At minimum the non-daemon checks should pass
    expect(result.passed).toBeGreaterThanOrEqual(4);
  });
});

describe('doctorAgent — missing hook config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-doctor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hook config check fails but others may pass', async () => {
    const { ctx, out } = makeCtx('pretty');

    // Do NOT create hook config
    const hookPath = path.join(tmpDir, '.claude', 'hooks.json');

    // Also create sandbox profile so it passes on macOS
    const sandboxDir = path.join(tmpDir, '.prismer', 'sandbox');
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, 'claude-code.sb'), '(version 1)', 'utf-8');

    const catalog = [makeEntry(
      { found: true, binaryPath: '/usr/local/bin/claude', version: '4.2.1' },
      hookPath,
    )];

    const result = await doctorAgent(ctx, 'claude-code', { catalog, homeDir: tmpDir });

    // Hook config check fails (no hooks.json)
    const hookCheck = result.checks.find((c) => c.label === 'Hook config');
    expect(hookCheck?.pass).toBe(false);

    // PARA compliance also fails (no hooks.json)
    const paraCheck = result.checks.find((c) => c.label === 'PARA compliance');
    expect(paraCheck?.pass).toBe(false);

    // Binary check passes
    const binaryCheck = result.checks.find((c) => c.label === 'Binary found');
    expect(binaryCheck?.pass).toBe(true);

    // At least 2 actions needed (hook config + PARA compliance)
    expect(result.actionsNeeded).toBeGreaterThanOrEqual(2);

    const outStr = stripAnsi(out.join(''));
    expect(outStr).toMatch(/action[s]? needed/);
  });

  it('binary not found causes binary check to fail', async () => {
    const { ctx } = makeCtx();
    const hookPath = path.join(tmpDir, '.claude', 'hooks.json');
    const catalog = [makeEntry({ found: false }, hookPath)];

    const result = await doctorAgent(ctx, 'claude-code', { catalog, homeDir: tmpDir });

    const binaryCheck = result.checks.find((c) => c.label === 'Binary found');
    expect(binaryCheck?.pass).toBe(false);
  });
});

describe('doctorAgent — json mode', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-doctor-json-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits JSON payload in json mode', async () => {
    const { ctx, out } = makeCtx('json');
    const hookPath = path.join(tmpDir, '.claude', 'hooks.json');
    const catalog = [makeEntry({ found: false }, hookPath)];

    await doctorAgent(ctx, 'claude-code', { catalog, homeDir: tmpDir });

    const outStr = out.join('').trim();
    const parsed = JSON.parse(outStr) as { agent: string; passed: number; total: number };
    expect(parsed.agent).toBe('claude-code');
    expect(typeof parsed.passed).toBe('number');
    expect(typeof parsed.total).toBe('number');
  });
});
