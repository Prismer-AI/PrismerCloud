// Desktop-202 doc 18 §3a/§4/§8 — MemoryIntegration five-verb hermes binding +
// recallStats observability.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHermesMemoryIntegration,
  createFallbackMemoryIntegration,
  resolveDaemonUrl,
  MEMORY_VERBS,
} from '../src/adapters/shared/memory-integration.js';
import {
  MANAGED_START,
  MANAGED_END,
} from '../src/daemon/memory/hermes-memory-bridge.js';
import { getRecallStats } from '../src/daemon/memory/recall-stats.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-integration-'));
  getRecallStats().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  getRecallStats().reset();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('MemoryIntegration five-verb contract (doc 18 §3a)', () => {
  it('declares the five verbs', () => {
    expect(MEMORY_VERBS).toEqual([
      'core-inject',
      'recall-tools',
      'extract',
      'native-bridge',
      'session-map',
    ]);
  });

  it('recall-tools (P0): hermes binding exposes memory_search + memory_load schemas + impls', () => {
    const integ = createHermesMemoryIntegration({ workspaceId: 'ws1' });
    const { schemas, impls } = integ.recallTools();
    const names = schemas.map((s) => s.function.name).sort();
    // product209/15 PKF-D3 — pkf_validate joined the shared tool surface.
    // product209 — Hermes exposes only the native PKF functions that the
    // shipped Python provider actually handles. pkf209/07 §5 adds
    // pkf_svg_check and pkf209 adds pkf_reply_inline (both optional — not in
    // REQUIRED_PKF_NATIVE_TOOLS).
    expect(names).toEqual([
      'memory_load',
      'memory_search',
      'pkf_bundle_commit',
      'pkf_mint_sids',
      'pkf_outline',
      'pkf_read',
      'pkf_reply_inline',
      'pkf_search',
      'pkf_svg_check',
      'pkf_validate',
    ]);
    // OpenAI-style function tool shape (hermes).
    for (const s of schemas) {
      expect(s.type).toBe('function');
      expect(typeof s.function.description).toBe('string');
      expect(s.function.parameters).toBeTypeOf('object');
    }
    expect(typeof impls.search).toBe('function');
    expect(typeof impls.load).toBe('function');
  });

  it('core-inject: writes the bounded managed section + reports bytes + bumps recallStats', () => {
    const memoryMd = join(dir, 'MEMORY.md');
    const integ = createHermesMemoryIntegration({ workspaceId: 'ws1', memoryFilePath: memoryMd });
    const out = integ.coreInject('User prefers concise answers. Timezone: UTC+8.');
    expect(out.written).toBe(true);
    expect(out.bytes).toBeGreaterThan(0);

    const file = readFileSync(memoryMd, 'utf8');
    expect(file).toContain(MANAGED_START);
    expect(file).toContain(MANAGED_END);
    expect(file).toContain('Timezone: UTC+8');

    // doc 18 §8 — core-inject byte budget reflected in recallStats.
    const snap = getRecallStats().snapshot();
    expect(snap.coreInjectBytes).toBe(out.bytes);
    expect(snap.providerPath).toBe('core');
  });

  it('core-inject: enforces the ≤1,800 char budget (truncates)', () => {
    const memoryMd = join(dir, 'MEMORY.md');
    const integ = createHermesMemoryIntegration({
      workspaceId: 'ws1',
      memoryFilePath: memoryMd,
      coreInjectCharBudget: 1800,
    });
    const out = integ.coreInject('x'.repeat(5000));
    expect(out.written).toBe(true);
    // The budget is on CHARS (doc 18: ≤1,800 字符). The managed body is capped
    // at 1,800 chars; report its char length (bytes ≈ chars + a few for the
    // multibyte truncation marker).
    const managed = integ.readNative().managed;
    expect(managed.length).toBeLessThanOrEqual(1800);
    expect(managed).toContain('truncated');
  });

  it('native-bridge: returns agent-curated content OUTSIDE the managed section', () => {
    const memoryMd = join(dir, 'MEMORY.md');
    const integ = createHermesMemoryIntegration({ workspaceId: 'ws1', memoryFilePath: memoryMd });
    // Agent writes curated content first; then we inject a managed core.
    writeFileSync(memoryMd, 'Agent curated fact: ships on Friday.\n');
    integ.coreInject('Managed core: identity X.');
    const curated = integ.nativeCurated();
    expect(curated).toContain('Agent curated fact: ships on Friday.');
    expect(curated).not.toContain('Managed core: identity X.');
  });

  it('core-inject no-ops (and does not throw) when no memoryFilePath is bound', () => {
    const integ = createHermesMemoryIntegration({ workspaceId: 'ws1' });
    const out = integ.coreInject('anything');
    expect(out).toEqual({ written: false, bytes: 0 });
  });
});

describe('resolveDaemonUrl', () => {
  it('honours an explicit url, else falls back to 127.0.0.1:$PRISMER_DAEMON_PORT', () => {
    expect(resolveDaemonUrl('http://x:9/')).toBe('http://x:9');
    const prev = process.env.PRISMER_DAEMON_PORT;
    process.env.PRISMER_DAEMON_PORT = '4321';
    try {
      expect(resolveDaemonUrl()).toBe('http://127.0.0.1:4321');
    } finally {
      if (prev === undefined) delete process.env.PRISMER_DAEMON_PORT;
      else process.env.PRISMER_DAEMON_PORT = prev;
    }
  });
});

describe('fallback adapter recall-tools registration (spec 11 T5-3)', () => {
  it('registers adapter-format memory_search/load schemas with live daemon-RPC handlers', async () => {
    for (const adapter of ['claude-code', 'codex'] as const) {
      const fetch = vi.fn(async () =>
        new Response(JSON.stringify({ query: 'OAuth', results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetch);
      const fb = createFallbackMemoryIntegration(adapter, {
        workspaceId: 'ws1',
        daemonUrl: 'http://127.0.0.1:9876',
      });
      expect(fb.adapter).toBe(adapter);
      const registry = { registerRecallTools: vi.fn() };
      const recallTools = fb.recallTools();
      expect(recallTools.schemas.map((tool) => tool.name).sort()).toEqual(['memory_load', 'memory_search']);

      recallTools.register(registry);
      expect(registry.registerRecallTools).toHaveBeenCalledWith({
        adapter,
        schemas: recallTools.schemas,
        handlers: recallTools.handlers,
      });

      await expect(recallTools.handlers.search({ query: 'OAuth' })).resolves.toEqual({
        query: 'OAuth',
        results: [],
      });
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:9876/local/memory/search?workspaceId=ws1&q=OAuth',
        expect.any(Object),
      );
      // Back-compat executor access stays callable, but now shares the same
      // registration-ready handler contract.
      expect(typeof fb.recallToolImpls().search).toBe('function');
      // No core-inject / native-bridge methods — those are deferred per D7.
      expect((fb as Record<string, unknown>).coreInject).toBeUndefined();
    }
  });
});

describe('recallStats (doc 18 §8)', () => {
  it('counts tool recalls and advances providerPath to tools', () => {
    const stats = getRecallStats();
    expect(stats.snapshot().toolRecallCount).toBe(0);
    expect(stats.snapshot().providerPath).toBe('inject');
    stats.recordToolRecall();
    stats.recordToolRecall();
    const snap = stats.snapshot();
    expect(snap.toolRecallCount).toBe(2);
    expect(snap.toolRecallLastAt).not.toBeNull();
    expect(snap.providerPath).toBe('tools');
  });

  it('counts shadow firings and advances providerPath to shadow', () => {
    const stats = getRecallStats();
    stats.recordShadowFired();
    const snap = stats.snapshot();
    expect(snap.shadowFiredCount).toBe(1);
    expect(snap.shadowLastAt).not.toBeNull();
    expect(snap.providerPath).toBe('shadow');
  });

  it('records core-inject bytes', () => {
    const stats = getRecallStats();
    stats.recordCoreInject(512);
    expect(stats.snapshot().coreInjectBytes).toBe(512);
  });
});
