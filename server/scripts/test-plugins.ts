/**
 * Plugin Compliance & Packaging Tests
 *
 * Validates all 3 plugins against their respective platform specs:
 *   - Claude Code: plugin.json manifest, hooks, MCP, skills
 *   - OpenCode: package.json exports, build output, event hooks
 *   - OpenClaw: openclaw.plugin.json, entry point, subpath imports
 *
 * Usage: npx tsx scripts/test-plugins.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function readText(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

// ============================================================================
// Claude Code Plugin
// ============================================================================

function testClaudeCodePlugin() {
  console.log('\n═══ Claude Code Plugin ═══\n');
  const root = 'sdk/claude-code-plugin';

  // ── Manifest ──
  console.log('  ── Manifest ──');
  const manifestPath = `${root}/.claude-plugin/plugin.json`;
  assert(fileExists(manifestPath), 'plugin.json exists');
  if (fileExists(manifestPath)) {
    const manifest = readJson(manifestPath);
    assert(typeof manifest.name === 'string' && manifest.name.length > 0, `name = "${manifest.name}"`);
    assert(/^[a-z0-9-]+$/.test(manifest.name), 'name is kebab-case');
    assert(typeof manifest.version === 'string', `version = "${manifest.version}"`);
    assert(typeof manifest.description === 'string', 'has description');
    assert(manifest.author?.name !== undefined, 'has author');
    assert(typeof manifest.license === 'string', 'has license');
    assert(Array.isArray(manifest.keywords), 'has keywords');
  }

  // ── Hooks ──
  console.log('  ── Hooks ──');
  const hooksPath = `${root}/hooks/hooks.json`;
  assert(fileExists(hooksPath), 'hooks/hooks.json exists');
  if (fileExists(hooksPath)) {
    const hooks = readJson(hooksPath);
    assert(hooks.hooks?.PreToolUse !== undefined, 'PreToolUse hook defined');
    assert(hooks.hooks?.PostToolUse !== undefined, 'PostToolUse hook defined');

    // Check hooks reference ${CLAUDE_PLUGIN_ROOT}
    const hookStr = JSON.stringify(hooks);
    assert(hookStr.includes('${CLAUDE_PLUGIN_ROOT}'), 'uses ${CLAUDE_PLUGIN_ROOT} variable');

    // Validate hook structure
    for (const [event, matchers] of Object.entries(hooks.hooks)) {
      for (const m of matchers as any[]) {
        assert(typeof m.matcher === 'string', `${event}: has matcher "${m.matcher}"`);
        assert(Array.isArray(m.hooks) && m.hooks.length > 0, `${event}: has hook commands`);
        for (const h of m.hooks) {
          assert(h.type === 'command', `${event}: hook type is "command"`);
          assert(typeof h.command === 'string', `${event}: has command string`);
        }
      }
    }
  }

  // ── MCP ──
  console.log('  ── MCP ──');
  assert(fileExists(`${root}/.mcp.json`), '.mcp.json exists');
  if (fileExists(`${root}/.mcp.json`)) {
    const mcp = readJson(`${root}/.mcp.json`);
    const serverNames = Object.keys(mcp.mcpServers || mcp);
    assert(serverNames.length > 0, `MCP servers configured: ${serverNames.join(', ')}`);
  }

  // ── Skills ──
  console.log('  ── Skills ──');
  const expectedSkills = ['evolve-analyze', 'evolve-create', 'evolve-record'];
  for (const skill of expectedSkills) {
    const skillPath = `${root}/skills/${skill}/SKILL.md`;
    assert(fileExists(skillPath), `skill "${skill}" exists`);
  }

  // ── Scripts ──
  console.log('  ── Scripts ──');
  assert(fileExists(`${root}/scripts/pre-bash-suggest.mjs`), 'pre-bash-suggest.mjs exists');
  assert(fileExists(`${root}/scripts/post-bash-report.mjs`), 'post-bash-report.mjs exists');

  // ── Package.json alignment ──
  console.log('  ── Package Alignment ──');
  if (fileExists(manifestPath) && fileExists(`${root}/package.json`)) {
    const manifest = readJson(manifestPath);
    const pkg = readJson(`${root}/package.json`);
    assert(manifest.version === pkg.version, `version aligned: plugin.json=${manifest.version} pkg=${pkg.version}`);
    const pkgFiles: string[] = pkg.files || [];
    assert(pkgFiles.includes('.claude-plugin/'), 'package.json files includes .claude-plugin/');
    assert(pkgFiles.includes('hooks/'), 'package.json files includes hooks/');
    assert(pkgFiles.includes('skills/'), 'package.json files includes skills/');
    assert(pkgFiles.includes('.mcp.json'), 'package.json files includes .mcp.json');
  }
}

// ============================================================================
// OpenCode Plugin
// ============================================================================

function testOpenCodePlugin() {
  console.log('\n═══ OpenCode Plugin ═══\n');
  const root = 'sdk/opencode-plugin';

  // ── Package.json ──
  console.log('  ── Package.json ──');
  const pkg = readJson(`${root}/package.json`);
  assert(pkg.type === 'module', `type = "module" (ESM)`);
  assert(pkg.main === './dist/index.js', `main = "${pkg.main}"`);
  assert(pkg.exports?.['.']?.import === './dist/index.js', 'exports["."].import correct');
  assert(pkg.exports?.['.']?.types === './dist/index.d.ts', 'exports["."].types correct');

  // ── Build output ──
  console.log('  ── Build Output ──');
  assert(fileExists(`${root}/dist/index.js`), 'dist/index.js exists');
  assert(fileExists(`${root}/dist/index.d.ts`), 'dist/index.d.ts exists');
  assert(fileExists(`${root}/dist/evolution-client.js`), 'dist/evolution-client.js exists');
  assert(fileExists(`${root}/dist/evolution-client.d.ts`), 'dist/evolution-client.d.ts exists');

  // ── DTS exports check ──
  console.log('  ── Type Exports ──');
  if (fileExists(`${root}/dist/index.d.ts`)) {
    const dts = readText(`${root}/dist/index.d.ts`);
    assert(dts.includes('PrismerEvolution'), 'DTS exports PrismerEvolution');
    assert(dts.includes('default') && dts.includes('export'), 'DTS has default export');
  }

  // ── Source entry point ──
  console.log('  ── Source Entry ──');
  const src = readText(`${root}/src/index.ts`);
  assert(src.includes('export default'), 'src/index.ts has default export');
  assert(src.includes("'tool.execute.before'"), 'has tool.execute.before hook');
  assert(src.includes("'tool.execute.after'"), 'has tool.execute.after hook');
  assert(src.includes("'session.error'"), 'has session.error hook');
  assert(src.includes("'shell.env'"), 'has shell.env hook');
  assert(src.includes("'session.created'"), 'has session.created hook');

  // ── Plugin type signature ──
  assert(src.includes('Plugin'), 'uses Plugin type');

  // ── Skills ──
  console.log('  ── Skills ──');
  const expectedSkills = ['prismer-evolve-analyze', 'prismer-evolve-create', 'prismer-evolve-record'];
  for (const skill of expectedSkills) {
    assert(fileExists(`${root}/skills/${skill}/SKILL.md`), `skill "${skill}" exists`);
  }

  // ── Build script ──
  console.log('  ── Build Script ──');
  assert(pkg.scripts?.build?.includes('src/index.ts'), 'build script targets src/index.ts');
  assert(!pkg.scripts?.build?.includes('harness'), 'build script does NOT reference old harness');
}

// ============================================================================
// OpenClaw Channel Plugin
// ============================================================================

function testOpenClawPlugin() {
  console.log('\n═══ OpenClaw Channel Plugin ═══\n');
  const root = 'sdk/openclaw-channel';

  // ── Manifest ──
  console.log('  ── Manifest ──');
  const manifest = readJson(`${root}/openclaw.plugin.json`);
  assert(manifest.kind === 'channel', `kind = "${manifest.kind}"`);
  assert(typeof manifest.id === 'string', `id = "${manifest.id}"`);
  assert(typeof manifest.name === 'string', `name = "${manifest.name}"`);
  assert(typeof manifest.description === 'string', 'has description');
  assert(manifest.configSchema?.properties?.apiKey !== undefined, 'configSchema has apiKey');
  assert(manifest.configSchema?.required?.includes('apiKey'), 'apiKey is required');

  // ── Package.json ──
  console.log('  ── Package.json ──');
  const pkg = readJson(`${root}/package.json`);
  assert(pkg.type === 'module', 'type = "module" (ESM required)');
  assert(pkg.openclaw?.extensions?.length > 0, 'openclaw.extensions defined');
  assert(typeof pkg.openclaw?.setupEntry === 'string', `setupEntry = "${pkg.openclaw?.setupEntry}"`);
  assert(pkg.openclaw?.channel?.id === 'prismer', 'openclaw.channel.id = "prismer"');
  assert(typeof pkg.openclaw?.channel?.label === 'string', 'openclaw.channel.label defined');

  // ── Entry point ──
  console.log('  ── Entry Point ──');
  const entry = readText(`${root}/index.ts`);
  assert(entry.includes('definePluginEntry'), 'uses definePluginEntry()');
  assert(entry.includes('export default'), 'has default export');
  assert(!entry.includes('emptyPluginConfigSchema'), 'NOT using deprecated emptyPluginConfigSchema');
  assert(entry.includes('api.registerChannel'), 'registers channel');

  // ── Setup entry ──
  assert(fileExists(`${root}/setup-entry.ts`), 'setup-entry.ts exists');
  if (fileExists(`${root}/setup-entry.ts`)) {
    const setup = readText(`${root}/setup-entry.ts`);
    assert(setup.includes('defineSetupPluginEntry'), 'uses defineSetupPluginEntry()');
  }

  // ── Subpath imports (no root imports) ──
  console.log('  ── Import Paths ──');
  const srcFiles = ['channel.ts', 'accounts.ts', 'runtime.ts', 'types.ts', 'directory.ts', 'inbound.ts', 'tools.ts'];
  let rootImportCount = 0;
  for (const f of srcFiles) {
    const fp = `${root}/src/${f}`;
    if (fileExists(fp)) {
      const content = readText(fp);
      // Check for root import (from "openclaw/plugin-sdk" without further path)
      const rootImports = content.match(/from\s+["']openclaw\/plugin-sdk["']/g);
      if (rootImports && rootImports.length > 0) {
        rootImportCount += rootImports.length;
        console.log(`  ❌ ${f}: uses root import "openclaw/plugin-sdk" (${rootImports.length}x)`);
        failed++;
      }
    }
  }
  if (rootImportCount === 0) {
    assert(true, 'all imports use subpath (openclaw/plugin-sdk/<subpath>)');
  }

  // ── Channel implementation ──
  console.log('  ── Channel Implementation ──');
  const channel = readText(`${root}/src/channel.ts`);
  assert(channel.includes('ChannelPlugin'), 'exports ChannelPlugin type');
  assert(channel.includes('outbound'), 'has outbound messaging');
  assert(channel.includes('gateway'), 'has gateway (inbound)');
  assert(channel.includes('agentTools'), 'has agentTools');

  // ── Tools ──
  const tools = readText(`${root}/src/tools.ts`);
  assert(tools.includes('prismer_evolve_analyze'), 'has evolve_analyze tool');
  assert(tools.includes('prismer_evolve_record'), 'has evolve_record tool');
  assert(tools.includes('prismer_evolve_report'), 'has evolve_report tool');
  assert(tools.includes('prismer_load'), 'has prismer_load tool');
  assert(tools.includes('prismer_parse'), 'has prismer_parse tool');
}

// ============================================================================
// SKILL.md Content Validation
// ============================================================================

function testSkillContent() {
  console.log('\n═══ SKILL.md Content Validation ═══\n');

  // Claude Code skills
  const ccSkills = [
    { path: 'sdk/claude-code-plugin/skills/evolve-analyze/SKILL.md', name: 'CC analyze' },
    { path: 'sdk/claude-code-plugin/skills/evolve-record/SKILL.md', name: 'CC record' },
    { path: 'sdk/claude-code-plugin/skills/evolve-create/SKILL.md', name: 'CC create' },
  ];

  for (const skill of ccSkills) {
    const content = readText(skill.path);
    assert(content.includes('scope'), `${skill.name}: mentions scope`);
    assert(content.includes('PRISMER_API_KEY') || content.includes('MCP'), `${skill.name}: has auth reference`);
    assert(content.includes('---\nname:') || content.includes('---\r\nname:'), `${skill.name}: has YAML frontmatter`);
  }

  // OpenCode skills
  const ocSkills = [
    { path: 'sdk/opencode-plugin/skills/prismer-evolve-analyze/SKILL.md', name: 'OC analyze' },
    { path: 'sdk/opencode-plugin/skills/prismer-evolve-record/SKILL.md', name: 'OC record' },
    { path: 'sdk/opencode-plugin/skills/prismer-evolve-create/SKILL.md', name: 'OC create' },
  ];

  for (const skill of ocSkills) {
    const content = readText(skill.path);
    assert(content.includes('scope'), `${skill.name}: mentions scope`);
    assert(content.includes('PRISMER_API_KEY'), `${skill.name}: has PRISMER_API_KEY reference`);
  }

  // API field correctness in create skills
  const ccCreate = readText('sdk/claude-code-plugin/skills/evolve-create/SKILL.md');
  assert(ccCreate.includes('signals_match'), 'CC create: uses signals_match (not signalTags)');
  assert(ccCreate.includes('title'), 'CC create: uses title (not name)');

  const ocCreate = readText('sdk/opencode-plugin/skills/prismer-evolve-create/SKILL.md');
  assert(ocCreate.includes('signals_match'), 'OC create: uses signals_match (not signalTags)');
  assert(ocCreate.includes('"title"'), 'OC create: uses title (not name)');
  assert(!ocCreate.includes('"signalTags"'), 'OC create: no deprecated signalTags field');
  assert(!ocCreate.includes('"name"'), 'OC create: no deprecated name field');
}

// ============================================================================
// Cross-Plugin Consistency
// ============================================================================

function testCrossPlugin() {
  console.log('\n═══ Cross-Plugin Consistency ═══\n');

  // Version alignment
  const ccPkg = readJson('sdk/claude-code-plugin/package.json');
  const ocPkg = readJson('sdk/opencode-plugin/package.json');
  const clawPkg = readJson('sdk/openclaw-channel/package.json');
  assert(ccPkg.version === ocPkg.version, `CC=${ccPkg.version} == OC=${ocPkg.version}`);
  assert(ccPkg.version === clawPkg.version, `CC=${ccPkg.version} == Claw=${clawPkg.version}`);

  // All have README
  assert(fileExists('sdk/claude-code-plugin/README.md'), 'Claude Code has README');
  assert(fileExists('sdk/opencode-plugin/README.md'), 'OpenCode has README');
  assert(fileExists('sdk/openclaw-channel/README.md'), 'OpenClaw has README');

  // All have LICENSE reference
  assert(ccPkg.license === 'MIT', 'Claude Code: MIT license');
  assert(ocPkg.license === 'MIT', 'OpenCode: MIT license');
  assert(clawPkg.license === 'MIT', 'OpenClaw: MIT license');

  // Evolution coverage: all plugins have suggest+report
  const ccHooks = readText('sdk/claude-code-plugin/hooks/hooks.json');
  assert(
    ccHooks.includes('PreToolUse') && ccHooks.includes('PostToolUse'),
    'Claude Code: suggest (Pre) + report (Post)',
  );

  const ocSrc = readText('sdk/opencode-plugin/src/index.ts');
  assert(
    ocSrc.includes('tool.execute.before') && ocSrc.includes('tool.execute.after'),
    'OpenCode: suggest (before) + report (after)',
  );

  const clawInbound = readText('sdk/openclaw-channel/src/inbound.ts');
  const clawTools = readText('sdk/openclaw-channel/src/tools.ts');
  assert(
    clawInbound.includes('evolution') && clawTools.includes('evolve_analyze'),
    'OpenClaw: suggest (inbound) + analyze (tool)',
  );
}

// ============================================================================
// Main
// ============================================================================

console.log('╔══════════════════════════════════════════════╗');
console.log('║  Plugin Compliance & Packaging Tests         ║');
console.log('╚══════════════════════════════════════════════╝');

testClaudeCodePlugin();
testOpenCodePlugin();
testOpenClawPlugin();
testSkillContent();
testCrossPlugin();

console.log('\n══════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
