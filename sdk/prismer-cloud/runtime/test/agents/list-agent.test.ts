// T13 — list-agent.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UI } from '../../src/cli/ui.js';
import type { CliContext } from '../../src/cli/context.js';
import { listAgents } from '../../src/agents/list-agent.js';
import { installHooks, writeHookConfig } from '../../src/agents/hooks.js';
import { upsertAgent } from '../../src/agents/agents-registry.js';
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
// Catalog stubs
// ============================================================

function makeCatalog(
  detectMap: Record<string, { found: boolean; binaryPath?: string }>,
  hookRoot?: string,
): AgentCatalogEntry[] {
  const agents = [
    { name: 'claude-code', displayName: 'Claude Code', tiersSupported: [1, 2, 3, 4, 5, 6, 7], capabilityTags: ['code', 'shell', 'mcp', 'approval', 'skill', 'fs'], hookPath: '~/.claude/hooks.json' },
    { name: 'codex', displayName: 'Codex', tiersSupported: [1, 2, 3, 4, 5, 6], capabilityTags: ['code', 'shell', 'mcp'], hookPath: '~/.codex/hooks.json' },
    { name: 'hermes', displayName: 'Hermes', tiersSupported: [1, 2, 3, 4], capabilityTags: ['code', 'shell', 'mcp'], hookPath: '~/.hermes/hooks.json' },
    { name: 'openclaw', displayName: 'OpenClaw', tiersSupported: [1, 2, 3, 4, 5, 6], capabilityTags: ['code', 'shell', 'mcp', 'fs'], hookPath: '~/.openclaw/hooks.json' },
  ];

  return agents.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    packPackage: '@prismer/' + a.name + '-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath: hookRoot
      ? path.join(hookRoot, a.name, 'hooks.json')
      : a.hookPath,
    mcpConfigPath: undefined,
    upstreamBinary: a.name,
    upstreamVersionRange: undefined,
    localSourcePath: path.join(os.homedir(), 'workspace', 'agent', a.name),
    installCommand: 'install ' + a.name,
    tiersSupported: a.tiersSupported,
    capabilityTags: a.capabilityTags,
    detect: async () => detectMap[a.name] ?? { found: false },
  }));
}

// ============================================================
// Tests
// ============================================================

describe('listAgents — all not installed', () => {
  it('returns all four agents as not-installed when detect returns false for all', async () => {
    const { ctx } = makeCtx();
    const catalog = makeCatalog({
      'claude-code': { found: false },
      'codex': { found: false },
      'hermes': { found: false },
      'openclaw': { found: false },
    });

    const rows = await listAgents(ctx, { catalog });

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe('not-installed');
    }
  });

  it('shows zero-state text in pretty output', async () => {
    const { ctx, out } = makeCtx('pretty');
    const catalog = makeCatalog({});

    await listAgents(ctx, { catalog });

    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('no agents detected');
    expect(outStr).toContain('prismer agent install');
  });
});

describe('listAgents — claude-code online', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-list-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows online status when binary detected and hook config has PARA hooks', async () => {
    const { ctx } = makeCtx();

    // Write a hook config with PARA adapter for claude-code
    const hookPath = path.join(tmpDir, 'claude-code', 'hooks.json');
    await installHooks(hookPath, null, { daemonUrl: 'http://127.0.0.1:3210' });

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir });

    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('online');
  });

  it('shows stopped when binary detected but no hook config', async () => {
    const { ctx } = makeCtx();

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir, // no hook file written
    );

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('stopped');
  });

  it('table output includes AGENT STATUS TIERS headers', async () => {
    const { ctx, out } = makeCtx('pretty');
    const catalog = makeCatalog({});

    await listAgents(ctx, { catalog });

    const outStr = stripAnsi(out.join(''));
    expect(outStr).toMatch(/AGENT/i);
    expect(outStr).toMatch(/STATUS/i);
    expect(outStr).toMatch(/TIERS/i);
  });

  it('uses singular grammar for one online agent', async () => {
    const { ctx, out } = makeCtx('pretty');
    const hookPath = path.join(tmpDir, 'claude-code', 'hooks.json');
    await installHooks(hookPath, null, { daemonUrl: 'http://127.0.0.1:3210' });
    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    await listAgents(ctx, { catalog, homeDir: tmpDir });

    const outStr = stripAnsi(out.join(''));
    expect(outStr).toContain('1 agent online');
    expect(outStr).not.toContain('1 agents online');
  });

  it('emits JSON array in json mode', async () => {
    const { ctx, out } = makeCtx('json');
    const catalog = makeCatalog({});

    await listAgents(ctx, { catalog });

    const outStr = out.join('').trim();
    const parsed = JSON.parse(outStr) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(4);
  });
});

// ============================================================
// Q13 — lastActive (updated: daemon-query path; unreachable → '—')
// ============================================================

describe('Q13: listAgents lastActive field', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-q13-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Q13-a: online agent with daemon unreachable has lastActive = "—"', async () => {
    const { ctx } = makeCtx();

    const hookPath = path.join(tmpDir, 'claude-code', 'hooks.json');
    await installHooks(hookPath, null, { daemonUrl: 'http://127.0.0.1:3210' });

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    // fetchImpl always rejects (daemon unreachable)
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir, fetchImpl });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('online');
    expect(claudeRow?.lastActive).toBe('—');
  });

  it('Q13-b: stopped agent (installed, no hook) has lastActive = "—"', async () => {
    const { ctx } = makeCtx();

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );
    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('stopped');
    expect(claudeRow?.lastActive).toBe('—');
  });

  it('Q13-c: not-installed agent has lastActive = "—"', async () => {
    const { ctx } = makeCtx();

    const catalog = makeCatalog({ 'claude-code': { found: false } }, tmpDir);
    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('not-installed');
    expect(claudeRow?.lastActive).toBe('—');
  });
});

// ============================================================
// Registry + daemon lastActive integration
// ============================================================

describe('listAgents — registry + daemon lastActive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prismer-list-reg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registry entry + daemon unreachable → status online, lastActive "—"', async () => {
    const { ctx } = makeCtx();

    // Write registry entry (no hook file needed)
    upsertAgent(tmpDir, {
      name: 'claude-code',
      displayName: 'Claude Code',
      version: '1.9.0',
      source: 'npm',
      installedAt: new Date().toISOString(),
      hookConfigPath: path.join(tmpDir, 'claude-code', 'hooks.json'),
    });

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir, fetchImpl });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('online');
    expect(claudeRow?.lastActive).toBe('—');
  });

  it('registry entry + daemon returns startedAt 2 minutes ago → lastActive ≈ "2m ago"', async () => {
    const { ctx } = makeCtx();

    upsertAgent(tmpDir, {
      name: 'claude-code',
      displayName: 'Claude Code',
      version: '1.9.0',
      source: 'npm',
      installedAt: new Date().toISOString(),
      hookConfigPath: path.join(tmpDir, 'claude-code', 'hooks.json'),
    });

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    const twoMinAgo = Date.now() - 2 * 60 * 1000;
    const fetchImpl = async (_url: RequestInfo | URL): Promise<Response> => {
      return new Response(JSON.stringify({ id: 'claude-code@host', state: 'running', restarts: 0, startedAt: twoMinAgo }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir, fetchImpl });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('online');
    // Should be "2m ago" (allow 1m–3m for timing tolerance)
    expect(claudeRow?.lastActive).toMatch(/^[1-3]m ago$/);
  });

  it('no registry entry + no hook file → binary present but status stopped', async () => {
    const { ctx } = makeCtx();

    const catalog = makeCatalog(
      { 'claude-code': { found: true, binaryPath: '/usr/bin/claude' } },
      tmpDir,
    );

    const rows = await listAgents(ctx, { catalog, homeDir: tmpDir });
    const claudeRow = rows.find((r) => r.name === 'claude-code');
    expect(claudeRow?.status).toBe('stopped');
    expect(claudeRow?.lastActive).toBe('—');
  });
});
