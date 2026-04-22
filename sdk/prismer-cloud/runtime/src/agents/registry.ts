// T13 — Agent catalog: static registry of known agents Prismer can install adapters for.

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AGENT_SOURCE_ROOT = process.env['PRISMER_AGENT_SOURCE_ROOT'] ?? path.join(os.homedir(), 'workspace', 'agent');

function sourcePath(name: string): string {
  return path.join(AGENT_SOURCE_ROOT, name);
}

// ============================================================
// Types
// ============================================================

export interface AgentCatalogEntry {
  name: string;
  displayName: string;
  packPackage: string;
  packVersionRange: string;
  hookConfigPath: string;       // raw path with ~ (expanded by callers via os.homedir())
  mcpConfigPath?: string;
  upstreamBinary: string;
  upstreamVersionRange?: string;
  localSourcePath?: string;
  installCommand?: string;
  tiersSupported: number[];      // PARA tiers this agent supports (L1-L10)
  capabilityTags: string[];         // PARA capability tags (code, shell, mcp, approval, etc.)
  detect: () => Promise<{ found: boolean; binaryPath?: string; version?: string }>;
}

// ============================================================
// Tiny internal semver comparator
// ============================================================
// Supports only >=X.Y.Z (no upper bound) and undefined (skip).

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Returns true if `version` satisfies `range`.
 * Only >=X.Y.Z is supported. If range is undefined, always returns true.
 */
function satisfiesRange(version: string, range: string | undefined): boolean {
  if (!range) return true;
  const m = range.match(/^>=\s*(.+)$/);
  if (!m) return true; // unsupported range form — lenient pass
  const minParsed = parseSemver(m[1]);
  const vParsed = parseSemver(version);
  if (!minParsed || !vParsed) return true; // cannot parse — lenient pass
  const [maj1, min1, pat1] = minParsed;
  const [maj2, min2, pat2] = vParsed;
  if (maj2 !== maj1) return maj2 > maj1;
  if (min2 !== min1) return min2 > min1;
  return pat2 >= pat1;
}

// ============================================================
// detect() factory
// ============================================================

function makeDetect(
  binary: string,
  versionFlag = '--version',
  parseVersion?: (output: string) => string,
): AgentCatalogEntry['detect'] {
  return async () => {
    // Step 1: which <binary>
    let binaryPath: string | undefined;
    try {
      const { stdout } = await execFileAsync('which', [binary]);
      binaryPath = stdout.trim();
    } catch {
      return { found: false };
    }

    if (!binaryPath) return { found: false };

    // Step 2: <binary> --version
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, [versionFlag]);
      const raw = (stdout + stderr).trim();
      const version = parseVersion ? parseVersion(raw) : extractVersion(raw);
      return { found: true, binaryPath, version };
    } catch {
      // Binary exists but --version failed — report found with no version
      return { found: true, binaryPath, version: undefined };
    }
  };
}

/** Extract the first semver-like string from a version output line. */
function extractVersion(output: string): string | undefined {
  const m = output.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : undefined;
}

// ============================================================
// Catalog
// ============================================================

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    packPackage: '@prismer/claude-code-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath: '~/.claude/hooks.json',
    mcpConfigPath: '~/.claude/mcp_servers.json',
    upstreamBinary: 'claude',
    upstreamVersionRange: '>=2.0.0',
    localSourcePath: sourcePath('claude-code'),
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    tiersSupported: [1, 2, 3, 4, 5, 6, 7],
    capabilityTags: ['code', 'shell', 'mcp', 'approval', 'skill', 'fs'],
    detect: makeDetect('claude', '--version'),
  },
  {
    name: 'codex',
    displayName: 'Codex',
    packPackage: '@prismer/codex-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath: '~/.codex/hooks.json',
    mcpConfigPath: undefined,
    upstreamBinary: 'codex',
    upstreamVersionRange: undefined,
    localSourcePath: sourcePath('codex'),
    installCommand: 'npm install -g @openai/codex',
    tiersSupported: [1, 2, 3, 4, 5, 6],
    capabilityTags: ['code', 'shell', 'mcp'],
    detect: makeDetect('codex', '--version'),
  },
  {
    name: 'hermes',
    displayName: 'Hermes',
    packPackage: '@prismer/hermes-plugin',
    packVersionRange: '^1.9.0',
    hookConfigPath: '~/.hermes/hooks.json',
    mcpConfigPath: undefined,
    upstreamBinary: 'hermes',
    // NousResearch/hermes-agent upstream is currently 0.10.x (as of 2026-04).
    // Previously pinned `>=1.0.0` — rejected every current release so every
    // fresh install hit "Incompatible version: hermes 0.10.0 does not satisfy
    // >=1.0.0" and fell back to skipping Hermes entirely. G-14 closed 2026-04-22.
    // The hook-plugin API we target (ctx.register_hook + **kwargs) has been
    // stable since 0.10.0 per real integration verification in v0.1.1-0.2.0
    // of prismer-adapter-hermes.
    upstreamVersionRange: '>=0.10.0',
    localSourcePath: sourcePath('hermes-agent'),
    // v1.9.0 B.3: public installer curl path instead of the dev-machine
    // `cd ~/workspace/agent/hermes-agent && uv pip install -e ".[cli]"` form —
    // Docker / CI hosts do not have that worktree. --skip-setup keeps the
    // install non-interactive so the outer agent-install wizard can follow up
    // with config.yaml / .env writes under its own sequence.
    installCommand: 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup',
    tiersSupported: [1, 2, 3, 4],
    capabilityTags: ['code', 'shell', 'mcp'],
    detect: makeDetect('hermes', '--version'),
  },
  {
    name: 'openclaw',
    displayName: 'OpenClaw',
    packPackage: '@prismer/openclaw-channel',
    packVersionRange: '^1.9.0',
    // NOTE: OpenClaw does NOT read `~/.openclaw/hooks.json` — its hook
    // discovery scans `~/.openclaw/hooks/<name>/HOOK.md` directories and the
    // plugin registry (see openclaw docs/automation/hooks.md).  PARA events
    // during `openclaw agent --local` are actually fired by the
    // `@prismer/openclaw-channel` package itself via the native
    // `api.registerHook(...)` + `api.on(...)` plugin APIs (see
    // `sdk/prismer-cloud/openclaw-channel/src/para/register.ts`).  We keep
    // this path here because install-agent's smoke-test step reads it to
    // verify the adapter is in place; removing it would break that check.
    // v1.9.0 report break #5 fix.
    hookConfigPath: '~/.openclaw/hooks.json',
    mcpConfigPath: undefined,
    upstreamBinary: 'openclaw',
    upstreamVersionRange: undefined,
    localSourcePath: sourcePath('openclaw'),
    // v1.9.0 B.3: replaced the monorepo-relative pnpm build with the upstream
    // npm release, matching how claude-code and codex pull from public sources.
    installCommand: 'npm install -g openclaw@latest',
    tiersSupported: [1, 2, 3, 4, 5, 6],
    capabilityTags: ['code', 'shell', 'mcp', 'fs'],
    detect: makeDetect('openclaw', '--version'),
  },
];

export function getAgent(name: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((e) => e.name === name);
}

// Re-export for convenience (used in install-agent)
export { satisfiesRange };
