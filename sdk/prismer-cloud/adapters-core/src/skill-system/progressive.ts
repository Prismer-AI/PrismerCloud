/**
 * Progressive Disclosure (PARA §4.6.3.3, Pattern P14).
 *
 * Three layers:
 *   L0 Metadata  — name + description + argument-hint, ~30 tokens/skill.
 *                  Always resident in session; enumerated at session start.
 *   L1 Body      — SKILL.md body, loaded when the skill activates (user
 *                  invoke / LLM invoke / path glob match).
 *   L2 References — scripts/, references/*.md — loaded on explicit reference.
 *
 * After compaction, invoked skills share a 25K-token budget (Anthropic's
 * default). LRU evicts least-recently-used skill bodies when the budget
 * overflows.
 *
 * Token counting is approximate — we use ~4 chars/token on average, which
 * matches the heuristic used in Claude Code's hook budget docs. Exact counts
 * would require a tokenizer library; the cost isn't worth it here since the
 * budget is a soft cap with LRU backstop.
 */

import type { SkillDescriptor } from './loader.js';
import { loadSkillBody } from './loader.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET_TOKENS = 25_000;

export interface ProgressiveLoaderOptions {
  budgetTokens?: number;
}

export interface LoadedSkill {
  descriptor: SkillDescriptor;
  body: string;
  bodyTokens: number;
  lastAccessed: number;
}

export class ProgressiveSkillLoader {
  private readonly budget: number;
  /** LRU cache of loaded skill bodies, keyed by qualifiedName. */
  private readonly cache: Map<string, LoadedSkill> = new Map();

  constructor(opts: ProgressiveLoaderOptions = {}) {
    this.budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  }

  /** Metadata (L0) — cheap, always available without loading body. */
  metadata(descriptor: SkillDescriptor): { name: string; description: string; argumentHint?: string } {
    const fm = descriptor.frontmatter;
    return {
      name: descriptor.qualifiedName,
      description: typeof fm['description'] === 'string' ? fm['description'] as string : '',
      argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] as string : undefined,
    };
  }

  /**
   * Activate a skill, loading its body (L1) into the cache. If the cache
   * exceeds the token budget, the LRU entries are evicted. Already-loaded
   * skills are bumped to MRU instead of being reloaded.
   */
  activate(descriptor: SkillDescriptor): LoadedSkill {
    const key = descriptor.qualifiedName;
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      // Touch to end of insertion order (Map iteration is insertion-order)
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }

    const body = loadSkillBody(descriptor);
    const loaded: LoadedSkill = {
      descriptor,
      body,
      bodyTokens: Math.ceil(body.length / CHARS_PER_TOKEN),
      lastAccessed: Date.now(),
    };
    this.cache.set(key, loaded);
    this.enforceBudget();
    return loaded;
  }

  /** Explicit deactivate — e.g. agent.skill.deactivated from compaction-drop. */
  deactivate(qualifiedName: string): LoadedSkill | null {
    const loaded = this.cache.get(qualifiedName);
    if (!loaded) return null;
    this.cache.delete(qualifiedName);
    return loaded;
  }

  /** Snapshot of currently-active skills (loaded bodies) in LRU order. */
  active(): LoadedSkill[] {
    return Array.from(this.cache.values());
  }

  /** Total tokens across all loaded bodies. */
  totalTokens(): number {
    let sum = 0;
    this.cache.forEach((v) => { sum += v.bodyTokens; });
    return sum;
  }

  /** Evict skills via LRU until totalTokens ≤ budget. Returns evicted skills
   *  so the caller can emit `agent.skill.deactivated` events for each. */
  private enforceBudget(): LoadedSkill[] {
    const evicted: LoadedSkill[] = [];
    while (this.totalTokens() > this.budget) {
      const firstKey = this.cache.keys().next().value;
      if (!firstKey) break;
      const lru = this.cache.get(firstKey);
      if (!lru) break;
      this.cache.delete(firstKey);
      evicted.push(lru);
    }
    return evicted;
  }
}
