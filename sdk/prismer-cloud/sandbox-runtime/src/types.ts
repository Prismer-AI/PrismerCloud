/**
 * Canonical FS sandbox types for Prismer Cloud (D12).
 * All other packages import from here; no re-declarations elsewhere.
 */

/** Controls how the permission engine responds to tool calls. */
export type PermissionMode =
  /** Prompt the user on every tool call. */
  | 'default'
  /** Read-only preview — no side-effects executed. */
  | 'plan'
  /** Automatically approve file edits deemed safe by the rule engine. */
  | 'acceptEdits'
  /** User has explicitly disabled sandboxing (dangerous). */
  | 'bypassPermissions'
  /** Silently deny any call that does not match an explicit allow rule. */
  | 'dontAsk'
  /** LLM classifier decides (feature-gated). */
  | 'auto'
  /** Tier-based permissions (Tier 1-5). */
  | 'tier';

/** Identifies where a PermissionRule originated. */
export type PermissionRuleSource =
  | 'userSettings'    // ~/.prismer/settings.json (user-global)
  | 'projectSettings' // <workspace>/.prismer/settings.json
  | 'localSettings'   // <workspace>/.prismer/settings.local.json (gitignored)
  | 'policySettings'  // Enterprise MDM push — highest priority
  | 'skill'           // Rule contributed by an installed skill
  | 'session'         // In-memory rule for the current session only (not persisted)
  | 'cliArg'          // Startup CLI argument
  | 'command';        // Dynamically added during a conversation

// A single resolved permission rule evaluated by the permission engine.
export interface PermissionRule {
  source: PermissionRuleSource;
  behavior: 'allow' | 'deny' | 'ask';
  value: { tool: string; pattern?: string }; // e.g. { tool: 'Bash', pattern: 'npm:*' }
  tier?: number; // Optional: Tier level for this rule
}

// Tier configuration for permission evaluation
export interface TierConfig {
  activeTier: number; // Current tier level (1-5)
  supportedTiers: number[]; // Tiers supported by this agent
}

// Tier capability definitions
export interface TierCapability {
  tier: number;
  name: string;
  description: string;
  capabilities: string[]; // Allowed capabilities at this tier
  restrictions: string[]; // Restricted capabilities at this tier
}
