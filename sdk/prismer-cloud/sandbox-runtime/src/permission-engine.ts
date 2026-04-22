import { FROZEN_DIRS, FROZEN_FILES, FROZEN_GLOBS } from './frozen.js';
import { matchGlob } from './glob.js';
import type { PermissionMode, PermissionRule, PermissionRuleSource, TierConfig, TierCapability } from './types.js';

// ============================================================
// Tier capability definitions (per §5.2)
// ============================================================

const TIER_CAPABILITIES: readonly TierCapability[] = [
  {
    tier: 1,
    name: 'Sandbox',
    description: 'Read-only preview, no side-effects',
    capabilities: ['read-files', 'search-files', 'list-files'],
    restrictions: ['write-files', 'execute-commands', 'network-access', 'system-commands', 'dangerous-commands'],
  },
  {
    tier: 2,
    name: 'Trusted',
    description: 'Safe file edits and commands with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'execute-commands'],
    restrictions: ['network-access', 'system-commands', 'dangerous-commands'],
  },
  {
    tier: 3,
    name: 'Privileged',
    description: 'Most operations with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands'],
    restrictions: ['system-commands', 'dangerous-commands'],
  },
  {
    tier: 4,
    name: 'Admin',
    description: 'All operations with approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands', 'system-commands'],
    restrictions: ['dangerous-commands'],
  },
  {
    tier: 5,
    name: 'Unrestricted',
    description: 'All operations without approval',
    capabilities: ['read-files', 'search-files', 'list-files', 'edit-files', 'write-files', 'execute-commands', 'system-commands', 'dangerous-commands'],
    restrictions: [],
  },
] as const;

// Tool-to-capability mapping
const TOOL_CAPABILITIES: Record<string, string[]> = {
  'Bash': ['execute-commands', 'system-commands', 'dangerous-commands'],
  'Edit': ['edit-files'],
  'Write': ['write-files'],
  'NotebookEdit': ['edit-files'],
  'Read': ['read-files'],
  'Glob': ['search-files'],
  'ListFiles': ['list-files'],
};

// ============================================================
// Public request / result types
// ============================================================

export interface PermissionRequest {
  toolName: string;
  args?: string;      // bash command string, file path, etc.
  filePath?: string;  // resolved file path — triggers FROZEN check
  tierConfig?: TierConfig; // Optional tier configuration for tier-based evaluation
}

export interface EvalResult {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  matchedRule?: PermissionRule;
  frozen?: boolean;
  warning?: string;
  tier?: number; // Current tier level if in tier mode
}

// ============================================================
// Internal tool sets (not exported)
// ============================================================

const WRITE_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
const EDIT_TOOLS  = new Set(['Edit', 'Write', 'NotebookEdit']);

// ============================================================
// Source priority (lower index = higher priority)
// ============================================================

const SOURCE_PRIORITY: PermissionRuleSource[] = [
  'policySettings',
  'userSettings',
  'projectSettings',
  'localSettings',
  'skill',           // installed skill — trusted more than session/cliArg but less than settings
  'session',
  'cliArg',
  'command',
];

function sourcePriority(source: PermissionRuleSource): number {
  return SOURCE_PRIORITY.indexOf(source);
}

// ============================================================
// FROZEN detection — built from frozen.ts arrays at module load
// (FROZEN_FILES, FROZEN_DIRS, FROZEN_GLOBS are the single source of truth)
// ============================================================

// Build a check function from all three FROZEN arrays once at module load.
function buildFrozenCheck(): (filePath: string) => boolean {
  return (filePath: string): boolean => {
    const basename = filePath.split('/').pop() ?? '';

    // FROZEN_FILES: exact basename match
    if (FROZEN_FILES.includes(basename)) return true;

    // FROZEN_DIRS: any path segment equals a frozen dir name
    // Split on / and check each segment; also handles multi-segment dirs like .config/gcloud.
    const segments = filePath.split('/').filter(Boolean);
    for (const frozenDir of FROZEN_DIRS) {
      if (frozenDir.includes('/')) {
        // Multi-segment dir (e.g. ".config/gcloud") — check as a substring of the path
        if (filePath.includes(frozenDir)) return true;
      } else {
        if (segments.includes(frozenDir)) return true;
      }
    }

    // FROZEN_GLOBS: minimatch-style glob against full path
    for (const glob of FROZEN_GLOBS) {
      if (matchGlob(glob, filePath)) return true;
    }

    return false;
  };
}

const isFrozenRaw = buildFrozenCheck();

/**
 * Normalise a user-facing path (which may start with ~, $HOME, /Users/..., /home/...)
 * to a bare relative form for FROZEN matching.  The EXP-15 design strips the
 * home-directory prefix so that rules expressed as bare basenames still fire.
 */
function normalizePath(filePath: string): string {
  return filePath
    .replace(/^~\//, '')
    .replace(/^\/home\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^\/root\//, '');
}

function isFrozenFile(filePath: string): boolean {
  // Check both the raw path (for absolute paths with frozen dir segments)
  // and the home-stripped form (for basename / relative checks).
  return isFrozenRaw(filePath) || isFrozenRaw(normalizePath(filePath));
}

/**
 * Public FROZEN check used by fsSearch (I2) and other callers that need to
 * gate file-level access without going through the full permission evaluation.
 *
 * Returns `{ frozen: false }` when the path is safe to read; returns
 * `{ frozen: true, reason: '...' }` when the path matches any FROZEN rule.
 */
export function isFrozenPath(absPath: string): { frozen: boolean; reason?: string } {
  if (isFrozenFile(absPath)) {
    return { frozen: true, reason: `matches FROZEN rules: ${absPath}` };
  }
  return { frozen: false };
}

// ============================================================
// Wildcard pattern matching (operates on rule.value.pattern)
// ============================================================

/**
 * Match a glob pattern against args.  "*" expands to any substring.
 * "npm *" matches "npm install", "npm run build", etc.
 * "git push" matches exactly "git push".
 */
function wildcardMatch(pattern: string, args: string): boolean {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*') +
    '$';
  return new RegExp(regexStr).test(args);
}

// ============================================================
// Rule specificity — higher score = more specific
// ============================================================

/**
 * Compute specificity for a structured rule value.
 * - Wildcard tool ('*') → 0; named tool → +100
 * - No pattern → +0; exact (no *) → +50; glob → +30 + (len - wildcardCount)
 */
function ruleSpecificity(value: { tool: string; pattern?: string }): number {
  let score = 0;
  if (value.tool !== '*') score += 100;
  if (value.pattern !== undefined) {
    const wildcardCount = (value.pattern.match(/\*/g) ?? []).length;
    if (wildcardCount === 0) {
      score += 50;
    } else {
      score += 30 + (value.pattern.length - wildcardCount);
    }
  }
  return score;
}

// ============================================================
// Rule matching
// ============================================================

function ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
  const { tool, pattern } = rule.value;

  if (tool !== '*' && tool !== request.toolName) return false;

  if (pattern !== undefined) {
    const args = request.args ?? '';
    if (!wildcardMatch(pattern, args)) return false;
  }

  return true;
}

// ============================================================
// Mode-based defaults (applied when no explicit rule matches)
// ============================================================

function modeDefault(mode: PermissionMode, request: PermissionRequest): EvalResult {
  switch (mode) {
    case 'plan':
      if (WRITE_TOOLS.has(request.toolName)) {
        return { decision: 'deny', reason: `plan mode: ${request.toolName} is a write tool` };
      }
      return { decision: 'allow', reason: 'plan mode: read-only tool allowed' };

    case 'acceptEdits':
      if (EDIT_TOOLS.has(request.toolName)) {
        return { decision: 'allow', reason: 'acceptEdits mode: edit tool auto-allowed' };
      }
      if (request.toolName === 'Bash') {
        return { decision: 'ask', reason: 'acceptEdits mode: Bash requires approval' };
      }
      return { decision: 'allow', reason: 'acceptEdits mode: non-write tool allowed' };

    case 'bypassPermissions':
      return { decision: 'allow', reason: 'bypassPermissions mode: all allowed' };

    case 'dontAsk':
      return { decision: 'deny', reason: 'dontAsk mode: no matching allow rule' };

    case 'auto':
      return { decision: 'allow', reason: 'auto mode: agent-driven' };

    case 'tier':
      return tierDefault(request);

    case 'default':
    default:
      if (WRITE_TOOLS.has(request.toolName)) {
        return { decision: 'ask', reason: 'default mode: write tool requires approval' };
      }
      return { decision: 'allow', reason: 'default mode: read tool allowed' };
  }
}

// ============================================================
// Tier-based permission evaluation
// ============================================================

function tierDefault(request: PermissionRequest): EvalResult {
  const { tierConfig } = request;

  if (!tierConfig) {
    return { decision: 'ask', reason: 'tier mode: no tier configuration provided' };
  }

  const tierInfo = TIER_CAPABILITIES.find((t) => t.tier === tierConfig.activeTier);
  if (!tierInfo) {
    return { decision: 'deny', reason: `tier mode: invalid tier ${tierConfig.activeTier}` };
  }

  // Check if tier is supported by this agent
  if (!tierConfig.supportedTiers.includes(tierConfig.activeTier)) {
    return {
      decision: 'deny',
      reason: `tier mode: agent does not support tier ${tierConfig.activeTier} (supported: ${tierConfig.supportedTiers.join(', ')})`,
      tier: tierConfig.activeTier,
    };
  }

  // Map tool to required capabilities
  const toolCaps = TOOL_CAPABILITIES[request.toolName] || [];

  // Check if all required capabilities are allowed at this tier
  for (const cap of toolCaps) {
    if (tierInfo.restrictions.includes(cap)) {
      return {
        decision: tierConfig.activeTier < 5 ? 'ask' : 'allow',
        reason: `tier ${tierConfig.activeTier}: ${request.toolName} requires restricted capability "${cap}"`,
        tier: tierConfig.activeTier,
      };
    }
    if (!tierInfo.capabilities.includes(cap)) {
      return {
        decision: 'deny',
        reason: `tier ${tierConfig.activeTier}: ${request.toolName} requires capability "${cap}" not available`,
        tier: tierConfig.activeTier,
      };
    }
  }

  // All capabilities are allowed
  return {
    decision: tierConfig.activeTier >= 5 ? 'allow' : 'ask',
    reason: `tier ${tierConfig.activeTier}: ${request.toolName} allowed (requires approval below tier 5)`,
    tier: tierConfig.activeTier,
  };
}

// ============================================================
// Public evaluation entry point
// ============================================================

/**
 * Evaluate a permission request against a rule set and the active mode.
 *
 * Evaluation order:
 *   1. FROZEN file check — always deny regardless of rules or mode.
 *   2. Matching rules sorted by source priority then specificity — first wins.
 *   3. Mode-based default.
 */
export function evaluate(
  rules: PermissionRule[],
  mode: PermissionMode,
  request: PermissionRequest,
): EvalResult {
  // Phase 1: FROZEN check — no rule or mode can override
  if (request.filePath && isFrozenFile(request.filePath)) {
    // bypassPermissions users get a warning so they know sandboxing was not bypassed
    const warning =
      mode === 'bypassPermissions'
        ? 'WARNING: bypassPermissions cannot override FROZEN file protection'
        : undefined;
    return {
      decision: 'deny',
      reason: `FROZEN file: ${request.filePath}`,
      frozen: true,
      warning,
    };
  }

  // Phase 2: Find matching rules, sort by source priority then specificity
  const matching = rules
    .filter((rule) => ruleMatches(rule, request))
    .sort((a, b) => {
      const priDiff = sourcePriority(a.source) - sourcePriority(b.source);
      if (priDiff !== 0) return priDiff;
      // Higher specificity wins within the same source level
      return ruleSpecificity(b.value) - ruleSpecificity(a.value);
    });

  // Phase 3: First matching rule wins
  if (matching.length > 0) {
    const winner = matching[0];
    const result: EvalResult = {
      decision: winner.behavior,
      reason: `rule match: [${winner.source}] ${winner.value.tool}${winner.value.pattern !== undefined ? `(${winner.value.pattern})` : ''} → ${winner.behavior}`,
      matchedRule: winner,
    };
    if (winner.tier !== undefined) {
      result.tier = winner.tier;
    }
    return result;
  }

  // Phase 4: Fall back to mode-based default
  return modeDefault(mode, request);
}


// ============================================================
// Tier capability query
// ============================================================

/**
 * Get all tier capabilities.
 * Used by CLI commands and daemon for tier management.
 */
export function getTierCapabilities(): readonly TierCapability[] {
  return TIER_CAPABILITIES;
}

/**
 * Get a specific tier's capabilities.
 */
export function getTier(tier: number): TierCapability | undefined {
  return TIER_CAPABILITIES.find((t) => t.tier === tier);
}

