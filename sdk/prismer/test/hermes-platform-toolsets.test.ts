// release203 web-capability fix — explicit `platform_toolsets.api_server` pin.
//
// Proves configurePrismerProvider writes the explicit toolset list (bypassing
// the hermes v0.17.0 subset-inference bug that dropped `terminal`):
//   - `terminal` + the full default set land in config.yaml
//   - operator-added entries survive (union merge, idempotent)
//   - per-role deny (`agent.disabled_toolsets`) is untouched by the pin

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import {
  configurePrismerProvider,
  getHermesProfileDir,
  HermesProfileConfigSchema,
  HERMES_API_SERVER_PLATFORM_TOOLSETS,
} from '../src/adapters/persistence/hermes/index.js';

const PROFILE = 'platform-ts-test';

let home = '';
const savedEnv: Record<string, string | undefined> = {};

function snapEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return HermesProfileConfigSchema.parse({
    apiKey: 'sk-prismer-test-key',
    prismerProviderBaseUrl: 'http://127.0.0.1:9999/api/v1',
    installPrismerMcpServer: false,
    ...overrides,
  });
}

function readConfigYaml(profile: string): Record<string, unknown> {
  const path = join(getHermesProfileDir(profile), 'config.yaml');
  return YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'prismer-platform-ts-'));
  snapEnv('HERMES_HOME', 'PRISMER_API_KEY', 'PRISMER_MEMORY_PROVIDER', 'PRISMER_RECALL_TOOLS_PLUGIN');
  process.env.HERMES_HOME = home;
  process.env.PRISMER_API_KEY = 'sk-prismer-test-key';
  delete process.env.PRISMER_MEMORY_PROVIDER;
  delete process.env.PRISMER_RECALL_TOOLS_PLUGIN;
});

afterEach(() => {
  restoreEnv();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('platform_toolsets.api_server explicit pin (v0.17.0 inference-bug bypass)', () => {
  it('blocks optional upstream entries from bundled metadata without auto-installing canonical skills', () => {
    snapEnv('PRISMER_BUILT_IN_SKILLS_ROOT');
    const bundle = join(home, 'bundle');
    process.env.PRISMER_BUILT_IN_SKILLS_ROOT = bundle;
    mkdirSync(join(bundle, 'optional-connector'), { recursive: true });
    const body = '---\nname: optional-connector\nmetadata:\n  requiresExplicitGrant: true\n  nativeReplaces: [upstream-connector]\nprerequisites:\n  commands: [not-installed-fixture]\n---\nBody';
    writeFileSync(join(bundle, 'optional-connector/SKILL.md'), body);
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('upstream-connector');
    const installed = join(getHermesProfileDir(PROFILE), 'skills/optional-connector');
    expect(existsSync(installed)).toBe(false);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'SKILL.md'), body.replace('prerequisites:\n  commands: [not-installed-fixture]\n', ''));
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('optional-connector');
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('upstream-connector');
  });
  it('never exposes standalone coding lifecycle entrypoints, even with a Cloud floor', () => {
    configurePrismerProvider(PROFILE, baseConfig({ capabilityFloor: { skills: ['custom-floor'] } }));
    expect((readConfigYaml(PROFILE).skills as any).disabled).toEqual(expect.arrayContaining(['claude-code', 'codex', 'opencode']));
  });
  it('allows byte-identical shared mirrors across roots', () => {
    const profileDir = getHermesProfileDir(PROFILE);
    for (const root of [join(home, 'skills'), join(profileDir, 'skills')]) {
      mkdirSync(join(root, 'shared'), { recursive: true });
      writeFileSync(join(root, 'shared/SKILL.md'), '---\nname: shared\n---\nIdentical mirror');
    }
    expect(() => configurePrismerProvider(PROFILE, baseConfig())).not.toThrow();
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('shared');
  });
  it('does not suppress a non-optional upstream when its replacement is disabled or unavailable', () => {
    snapEnv('PRISMER_BUILT_IN_SKILLS_ROOT');
    process.env.PRISMER_BUILT_IN_SKILLS_ROOT = join(home, 'empty-policy-bundle');
    const profileDir = getHermesProfileDir(PROFILE);
    const dir = join(profileDir, 'skills/prismer-github');
    mkdirSync(dir, { recursive: true });
    const entry = (extra = '') => `---\nname: prismer-github\nmetadata:\n  nativeReplaces: [github]\n${extra}\n---\nInstall gh when missing.`;
    writeFileSync(join(dir, 'SKILL.md'), entry());
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('github');
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('prismer-github');
    writeFileSync(join(profileDir, 'config.yaml'), YAML.stringify({ skills: { disabled: ['prismer-github', 'github'], prismer_managed_disabled: ['github'] } }));
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('github');
    writeFileSync(join(profileDir, 'config.yaml'), YAML.stringify({ skills: {} }));
    writeFileSync(join(dir, 'SKILL.md'), entry('prerequisites:\n  commands: [never-installed-prismer-fixture]'));
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('github');
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('prismer-github');
  });

  it('rejects ambiguous imported names instead of disabling both copies', () => {
    const profileDir = getHermesProfileDir(PROFILE);
    for (const [root, body] of [[join(home, 'skills'), 'upstream'], [join(profileDir, 'skills'), 'adapted']]) {
      mkdirSync(join(root!, 'humanizer'), { recursive: true });
      writeFileSync(join(root!, 'humanizer/SKILL.md'), `---\nname: humanizer\n---\n${body}`);
    }
    expect(() => configurePrismerProvider(PROFILE, baseConfig())).toThrow(/unique canonical slug/);
    rmSync(join(profileDir, 'skills/humanizer'), { recursive: true });
    mkdirSync(join(profileDir, 'skills/prismer-humanizer'), { recursive: true });
    writeFileSync(join(profileDir, 'skills/prismer-humanizer/SKILL.md'), '---\nname: prismer-humanizer\nmetadata:\n  nativeReplaces: [humanizer]\n---\nadapted');
    configurePrismerProvider(PROFILE, baseConfig());
    const disabled = (readConfigYaml(PROFILE).skills as any).disabled;
    expect(disabled).toContain('humanizer');
    expect(disabled).not.toContain('prismer-humanizer');
  });

  it('rejects a nativeReplaces declaration that disables itself', () => {
    const dir = join(getHermesProfileDir(PROFILE), 'skills/arxiv');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: arxiv\nmetadata:\n  nativeReplaces: [arxiv]\n---\nBody');
    expect(() => configurePrismerProvider(PROFILE, baseConfig())).toThrow(/unique canonical slug/);
  });
  it('scans pinned and saved external directories and preserves operator disables', () => {
    const profileDir = getHermesProfileDir(PROFILE);
    const pinned = join(home, 'per-agent');
    const external = join(home, 'external');
    mkdirSync(join(pinned, 'webapp-qa'), { recursive: true });
    mkdirSync(join(external, 'needs-command'), { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(pinned, 'webapp-qa/SKILL.md'), '---\nname: webapp-qa\nmetadata:\n  nativeReplaces: [dogfood]\n---\nBody');
    writeFileSync(join(external, 'needs-command/SKILL.md'), '---\nname: needs-command\nprerequisites:\n  commands: [prismer-never-present-3289]\n---\nBody');
    writeFileSync(join(profileDir, 'config.yaml'), YAML.stringify({ skills: { external_dirs: [external], disabled: ['operator-only'] } }));
    configurePrismerProvider(PROFILE, baseConfig({ skillsDir: pinned }));
    expect((readConfigYaml(PROFILE).skills as any).disabled).toEqual(expect.arrayContaining(['dogfood', 'needs-command', 'operator-only']));
  });

  it('uses profile dotenv syntax and precedence and restores only managed disables', () => {
    snapEnv('CURATION_TEST_PRIVATE_TOKEN');
    process.env.CURATION_TEST_PRIVATE_TOKEN = '';
    const profileDir = getHermesProfileDir(PROFILE);
    mkdirSync(join(profileDir, 'skills', 'needs-env'), { recursive: true });
    writeFileSync(join(profileDir, 'skills/needs-env/SKILL.md'), '---\nname: needs-env\nprerequisites:\n  env_vars: [CURATION_TEST_PRIVATE_TOKEN]\n---\nBody');
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('needs-env');
    writeFileSync(join(profileDir, '.env'), 'export CURATION_TEST_PRIVATE_TOKEN="fixture"\n');
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('needs-env');
  });

  it('keeps github install guidance visible without gh and preserves an operator disable', () => {
    const profileDir = getHermesProfileDir(PROFILE);
    mkdirSync(join(profileDir, 'skills/prismer-github'), { recursive: true });
    writeFileSync(join(profileDir, 'skills/prismer-github/SKILL.md'), '---\nname: prismer-github\nmetadata:\n  nativeReplaces: [github]\n---\nInstall gh if missing.');
    writeFileSync(join(profileDir, 'config.yaml'), YAML.stringify({ skills: { disabled: ['prismer-github'], prismer_managed_disabled: ['prismer-github'] } }));
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).not.toContain('prismer-github');
    writeFileSync(join(profileDir, 'config.yaml'), YAML.stringify({ skills: { disabled: ['prismer-github'] } }));
    configurePrismerProvider(PROFILE, baseConfig());
    expect((readConfigYaml(PROFILE).skills as any).disabled).toContain('prismer-github');
  });
  it('hides unavailable native skills and replaces upstream QA only when the curated skill is present', () => {
    const profileDir = getHermesProfileDir(PROFILE);
    const add = (root: string, name: string, extra: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test\n${extra}\n---\nBody`);
    };
    add(join(home, 'skills'), 'test-native', 'prerequisites:\n  commands: [prismer-nonexistent-test-gh]');
    configurePrismerProvider(PROFILE, baseConfig());
    let skills = readConfigYaml(PROFILE).skills as { disabled: string[] };
    expect(skills.disabled).toContain('test-native');
    expect(skills.disabled).not.toContain('dogfood');
    add(join(profileDir, 'skills'), 'webapp-qa', 'metadata:\n  nativeReplaces: [dogfood]');
    configurePrismerProvider(PROFILE, baseConfig());
    skills = readConfigYaml(PROFILE).skills as { disabled: string[] };
    expect(skills.disabled).toContain('dogfood');
    expect(skills.disabled).not.toContain('webapp-qa');
    rmSync(join(profileDir, 'skills', 'webapp-qa'), { recursive: true });
    add(join(home, 'skills'), 'test-native', '');
    configurePrismerProvider(PROFILE, baseConfig());
    skills = readConfigYaml(PROFILE).skills as { disabled: string[] };
    expect(skills.disabled).not.toContain('dogfood');
    expect(skills.disabled).not.toContain('test-native');
  });
  it('accepts a legacy roleless profile snapshot encoded as null', () => {
    expect(baseConfig({ roleTemplate: null }).roleTemplate).toBeNull();
  });

  it('writes the full explicit list including terminal', () => {
    configurePrismerProvider(PROFILE, baseConfig(), 'agent-x', 'ws_1');
    const yaml = readConfigYaml(PROFILE);
    const pt = yaml.platform_toolsets as Record<string, string[]>;
    expect(pt).toBeDefined();
    expect(pt.api_server).toBeDefined();
    // The load-bearing entry: the upstream bug dropped `terminal`.
    expect(pt.api_server).toContain('terminal');
    // Nothing from the platform's normal default set is lost.
    for (const ts of HERMES_API_SERVER_PLATFORM_TOOLSETS) {
      expect(pt.api_server).toContain(ts);
    }
    // Default-off toolsets stay out (parity with correct inference).
    expect(pt.api_server).not.toContain('homeassistant');
    expect(pt.api_server).not.toContain('moa');
  });

  it('preserves operator-added entries and stays idempotent across re-syncs', () => {
    // Pre-seed an operator-edited config.yaml.
    const profileDir = getHermesProfileDir(PROFILE);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'config.yaml'),
      YAML.stringify({ platform_toolsets: { api_server: ['spotify'], telegram: ['web'] } }),
      'utf8',
    );

    configurePrismerProvider(PROFILE, baseConfig(), 'agent-x', 'ws_1');
    configurePrismerProvider(PROFILE, baseConfig(), 'agent-x', 'ws_1'); // idempotent re-sync

    const yaml = readConfigYaml(PROFILE);
    const pt = yaml.platform_toolsets as Record<string, string[]>;
    // Operator opt-in survives the union merge.
    expect(pt.api_server).toContain('spotify');
    expect(pt.api_server).toContain('terminal');
    // No duplicate entries after double sync.
    expect(new Set(pt.api_server).size).toBe(pt.api_server.length);
    // Other platforms' operator config untouched.
    expect(pt.telegram).toEqual(['web']);
  });

  it('does not interfere with per-role deny (agent.disabled_toolsets applies last hermes-side)', () => {
    configurePrismerProvider(
      PROFILE,
      baseConfig({ toolsetScope: { mode: 'deny', toolsets: ['browser'] } }),
      'agent-x',
      'ws_1',
    );
    const yaml = readConfigYaml(PROFILE);
    const pt = yaml.platform_toolsets as Record<string, string[]>;
    const agent = yaml.agent as Record<string, unknown>;
    // The pin still lists browser (platform default)…
    expect(pt.api_server).toContain('browser');
    // …but the role deny rides agent.disabled_toolsets, which hermes applies
    // LAST (tools_config.py) — so governance still wins.
    expect(agent.disabled_toolsets).toContain('browser');
  });
});
