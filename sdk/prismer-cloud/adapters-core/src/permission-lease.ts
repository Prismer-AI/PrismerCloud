/**
 * PermissionLeaseManager — tracks which skills own which PermissionRules.
 *
 * When a skill activates it grants a set of rules. When it deactivates
 * (agent.skill.deactivated), those rules are atomically revoked so the
 * permission set stays consistent across compaction-drops and session-ends.
 *
 * NOTE: Evaluation logic (priority, FROZEN, mode-based defaults) lives in
 * @prismer/sandbox-runtime (Track 2). This class is ONLY lease bookkeeping.
 */

import type { PermissionRule } from '@prismer/wire';

export class PermissionLeaseManager {
  private readonly leases: Map<string, PermissionRule[]> = new Map();

  /**
   * Grant rules to a skill. If the skill already has an active lease,
   * its rules are REPLACED (not appended).
   */
  grant(skillName: string, rules: PermissionRule[]): void {
    this.leases.set(skillName, [...rules]);
  }

  /**
   * Revoke a skill's rules and return the removed rules.
   * Returns [] if the skill has no active lease (no-op).
   */
  revoke(skillName: string): PermissionRule[] {
    const rules = this.leases.get(skillName);
    if (rules === undefined) return [];
    this.leases.delete(skillName);
    return rules;
  }

  /**
   * Returns a flat list of all currently-leased rules across all skills.
   * Order is insertion order of skill grants, stable within each skill's list.
   */
  active(): PermissionRule[] {
    const result: PermissionRule[] = [];
    for (const rules of this.leases.values()) {
      result.push(...rules);
    }
    return result;
  }

  /** Returns true if the skill has an active lease. */
  has(skillName: string): boolean {
    return this.leases.has(skillName);
  }

  /** Removes all leases. */
  clear(): void {
    this.leases.clear();
  }
}
