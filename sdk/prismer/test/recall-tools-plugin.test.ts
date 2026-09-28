// Desktop-202 doc 19 §8 — recall-tools plugin lane (reversible-first).
//
// Two layers:
//   1. Shell install (resolve source + copy into profile plugins dir), mirrors
//      memory-provider-install.test.ts.
//   2. Config wiring through hermesAdapter.prepareProfile (the public seam that
//      drives configurePrismerProvider → config.yaml): flag ON adds the plugin
//      to plugins.enabled and does NOT set memory.provider: prismer; flag OFF
//      leaves both untouched (zero behaviour change).
//
// The live joint-acceptance (a real @agent turn calling memory_search) needs a
// running daemon + Hermes + agent and is OUT of this unit scope.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  hermesAdapter,
  installRecallToolsPluginShell,
  resolveRecallToolsPluginSource,
  RECALL_TOOLS_PLUGIN_KEY,
} from '../src/adapters/persistence/hermes/index.js';

let dir = '';
let prevHermesHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prismer-recall-'));
  // The plugin installs into the PER-PROFILE `<profileDir>/plugins/` dir — the
  // only dir the daemon-spawned `hermes -p <name> gateway run` gateway scans
  // (its `-p` HERMES_HOME override repoints to <root>/profiles/<name>). Pin
  // HERMES_HOME to the temp dir so the install target is deterministic + isolated.
  prevHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
});

afterEach(() => {
  if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = prevHermesHome;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('recall-tools plugin shell install (doc 19 §8)', () => {
  it('resolves the on-disk plugin source (plugins/tools/prismer-recall)', () => {
    const src = resolveRecallToolsPluginSource();
    expect(src).not.toBeNull();
    expect(existsSync(join(src!, '__init__.py'))).toBe(true);
    expect(existsSync(join(src!, 'plugin.yaml'))).toBe(true);
  });

  it('registers tools plus the signed post-response routing hook, without becoming a MemoryProvider', () => {
    const src = resolveRecallToolsPluginSource();
    const py = readFileSync(join(src!, '__init__.py'), 'utf8');
    // It IS a register_tool plugin for the two FROZEN tool names.
    expect(py).toContain('register_tool');
    expect(py).toContain('memory_search');
    expect(py).toContain('memory_load');
    expect(py).toContain('register_hook("post_api_request"');
    expect(py).toContain('/v1/hooks/post_api_request');
    // It is NOT a memory provider — must avoid the substrings the Hermes
    // loader sniffs for to auto-coerce kind="exclusive" (plugins.py:1318).
    expect(py).not.toContain('register_memory_provider');
    expect(py).not.toContain('MemoryProvider');
    // plugin.yaml pins standalone kind explicitly.
    const yml = readFileSync(join(src!, 'plugin.yaml'), 'utf8');
    expect(yml).toContain('kind: standalone');
  });

  it('copies the plugin into the per-profile plugins/tools dir (the dir the -p gateway scans)', () => {
    const profileDir = join(dir, 'profiles', 'ceo');
    const ok = installRecallToolsPluginShell(profileDir);
    expect(ok).toBe(true);
    // Install lands under the per-profile dir, NOT the shared <root>/plugins.
    const dest = join(profileDir, 'plugins', 'tools', 'prismer-recall', '__init__.py');
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dir, 'plugins', 'tools', 'prismer-recall'))).toBe(false);
  });

  it('is a no-write success when a restored read-only profile already has the current plugin', () => {
    const profileDir = join(dir, 'profiles', 'ceo');
    expect(installRecallToolsPluginShell(profileDir)).toBe(true);
    const dest = join(profileDir, 'plugins', 'tools', 'prismer-recall');
    const files = [join(dest, '__init__.py'), join(dest, 'plugin.yaml')];
    for (const file of files) chmodSync(file, 0o444);
    chmodSync(dest, 0o555);
    try {
      expect(installRecallToolsPluginShell(profileDir)).toBe(true);
    } finally {
      chmodSync(dest, 0o755);
      for (const file of files) chmodSync(file, 0o644);
    }
  });

  it('falls back (returns false, no throw) when the source is unresolvable', () => {
    const prev = process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL;
    process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL = join(dir, 'does-not-exist');
    try {
      const ok = installRecallToolsPluginShell(join(dir, 'profiles', 'ceo'));
      expect(ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL;
      else process.env.PRISMER_RECALL_TOOLS_PLUGIN_SHELL = prev;
    }
  });
});

async function prepareWithRecallFlag(
  hermesHome: string,
  installRecallToolsPlugin: boolean,
  installMemoryProvider = false,
): Promise<Record<string, unknown>> {
  const oldHermesHome = process.env.HERMES_HOME;
  const oldBaseUrl = process.env.PRISMER_BASE_URL;
  const oldApiKey = process.env.PRISMER_API_KEY;
  const oldFlagEnv = process.env.PRISMER_RECALL_TOOLS_PLUGIN;
  // Make sure the env-var opt-in does not leak across the OFF case.
  delete process.env.PRISMER_RECALL_TOOLS_PLUGIN;
  process.env.HERMES_HOME = hermesHome;
  process.env.PRISMER_BASE_URL = 'http://127.0.0.1:3000';
  process.env.PRISMER_API_KEY = 'sk-prismer-test';
  try {
    await hermesAdapter.prepareProfile?.({
      id: 'profile-ceo',
      workspaceId: 'ws-1',
      agentImUserId: 'agent-ceo',
      agentUsername: 'ceo',
      adapterName: 'hermes',
      name: 'default',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      config: {
        apiKey: 'hermes-api-key',
        hermesProfileName: 'ceo',
        // Avoid resolving a real MCP server (irrelevant to recall-tools).
        installPrismerMcpServer: false,
        installRecallToolsPlugin,
        installMemoryProvider,
      },
    });
    const raw = readFileSync(join(hermesHome, 'profiles', 'ceo', 'config.yaml'), 'utf8');
    return (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  } finally {
    if (oldHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHermesHome;
    if (oldBaseUrl === undefined) delete process.env.PRISMER_BASE_URL;
    else process.env.PRISMER_BASE_URL = oldBaseUrl;
    if (oldApiKey === undefined) delete process.env.PRISMER_API_KEY;
    else process.env.PRISMER_API_KEY = oldApiKey;
    if (oldFlagEnv === undefined) delete process.env.PRISMER_RECALL_TOOLS_PLUGIN;
    else process.env.PRISMER_RECALL_TOOLS_PLUGIN = oldFlagEnv;
  }
}

describe('recall-tools config wiring (flag-gated, doc 19 §8)', () => {
  it('flag ON → plugins.enabled contains the recall key AND memory.provider is NOT prismer', async () => {
    const home = join(dir, 'hermes-on');
    const doc = await prepareWithRecallFlag(home, true);

    const plugins = doc.plugins as Record<string, unknown> | undefined;
    const enabled = (plugins?.enabled as unknown[]) ?? [];
    expect(enabled).toContain(RECALL_TOOLS_PLUGIN_KEY);

    // Recall-tools must NOT pin the provider (that's the separate D5 path) —
    // pinning it would exclude Honcho. memory: block exists (always written)
    // but its provider must not be 'prismer'.
    const memory = doc.memory as Record<string, unknown> | undefined;
    expect(memory?.provider).not.toBe('prismer');

    // The plugin was installed into the PER-PROFILE plugins dir
    // (<home>/profiles/ceo/plugins — the dir the -p gateway scans), NOT the
    // shared <home>/plugins root.
    const dest = join(home, 'profiles', 'ceo', 'plugins', 'tools', 'prismer-recall', '__init__.py');
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(home, 'plugins', 'tools', 'prismer-recall'))).toBe(false);

    const env = readFileSync(join(home, 'profiles', 'ceo', '.env'), 'utf8');
    expect(env).toContain('PRISMER_WORKSPACE_ID="ws-1"');
    expect(env).toContain('PRISMER_DAEMON_PORT="7878"');
    expect(env).toContain('PRISMER_AGENT_IM_USER_ID="agent-ceo"');
  });

  it('flag OFF → neither plugins.enabled has the key nor is the plugin installed', async () => {
    const home = join(dir, 'hermes-off');
    const doc = await prepareWithRecallFlag(home, false);

    const plugins = doc.plugins as Record<string, unknown> | undefined;
    const enabled = (plugins?.enabled as unknown[]) ?? [];
    expect(enabled).not.toContain(RECALL_TOOLS_PLUGIN_KEY);

    const memory = doc.memory as Record<string, unknown> | undefined;
    expect(memory?.provider).not.toBe('prismer');

    const dest = join(home, 'profiles', 'ceo', 'plugins', 'tools', 'prismer-recall');
    expect(existsSync(dest)).toBe(false);
  });

  it('native memory provider automatically enables the bounded routing hook plugin', async () => {
    const home = join(dir, 'hermes-provider');
    const doc = await prepareWithRecallFlag(home, false, true);
    const plugins = doc.plugins as Record<string, unknown> | undefined;
    expect((plugins?.enabled as unknown[]) ?? []).toContain(RECALL_TOOLS_PLUGIN_KEY);
    expect((doc.memory as Record<string, unknown> | undefined)?.provider).toBe('prismer');
    expect(
      existsSync(
        join(home, 'profiles', 'ceo', 'plugins', 'tools', 'prismer-recall', '__init__.py'),
      ),
    ).toBe(true);
    const env = readFileSync(join(home, 'profiles', 'ceo', '.env'), 'utf8');
    expect(env).toContain('PRISMER_AGENT_IM_USER_ID="agent-ceo"');
  });
});
