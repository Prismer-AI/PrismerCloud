/**
 * Injection Registry (Patterns P4 + P11, v1.9.0).
 *
 * Hosts system-prompt / tool injections the runtime wants to push into an
 * agent's next turn. Two injection shapes:
 *
 *   - SystemPromptSnippet: text appended to system prompt (classic L4).
 *     Reuses the prompt cache key — agent-specific adapters that don't
 *     support cache-safe inject MUST use this path.
 *
 *   - CacheSafeContext (P11): text injected as trailing content on the
 *     current user message instead of the system prompt. This preserves
 *     the prompt cache hit rate on upstream LLM providers, at the cost of
 *     per-turn re-injection. Requires the adapter to honor
 *     `agent.llm.pre`'s { context } return value.
 *
 * The registry is purely in-memory; adapters are expected to:
 *   1. Call `activate(...)` when runtime requests an injection.
 *   2. Call `currentSnippets()` / `currentCacheContext()` when building the
 *      next LLM request.
 *   3. Call `deactivate(...)` when the injection is no longer needed (skill
 *      deactivation, session reset).
 *
 * Each entry has a source tag so the adapter can choose to honor or skip
 * specific sources (e.g. user-defined injections only, ignore remote ones).
 */

export type InjectionSource = 'runtime' | 'skill' | 'user' | 'plugin';

export interface SystemPromptSnippet {
  id: string;
  source: InjectionSource;
  content: string;
  /** Optional skill name — set when source === 'skill'. */
  skillName?: string;
}

export interface CacheSafeContext {
  id: string;
  source: InjectionSource;
  content: string;
  /** Hint: only apply to the next N turns, then auto-expire. */
  turnsRemaining?: number;
}

export class InjectionRegistry {
  private readonly snippets: Map<string, SystemPromptSnippet> = new Map();
  private readonly cacheSafe: Map<string, CacheSafeContext> = new Map();

  activateSnippet(snippet: SystemPromptSnippet): void {
    this.snippets.set(snippet.id, { ...snippet });
  }

  activateCacheSafe(ctx: CacheSafeContext): void {
    this.cacheSafe.set(ctx.id, { ...ctx });
  }

  deactivate(id: string): boolean {
    const a = this.snippets.delete(id);
    const b = this.cacheSafe.delete(id);
    return a || b;
  }

  deactivateBySkill(skillName: string): number {
    let count = 0;
    for (const [id, s] of this.snippets) {
      if (s.skillName === skillName) {
        this.snippets.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Snapshot of currently-active system prompt snippets. Order is
   *  insertion order so adapters emit a stable prompt. */
  currentSnippets(): SystemPromptSnippet[] {
    return Array.from(this.snippets.values());
  }

  /** Snapshot of cache-safe contexts to inject on the next LLM call.
   *  Entries with `turnsRemaining === 0` are auto-dropped — caller is
   *  expected to tick before reading. */
  currentCacheContexts(): CacheSafeContext[] {
    return Array.from(this.cacheSafe.values());
  }

  /** Decrement `turnsRemaining` on every cache-safe entry. Entries that
   *  reach 0 are removed. Call this after building each LLM request. */
  tickCacheContexts(): void {
    for (const [id, ctx] of Array.from(this.cacheSafe.entries())) {
      if (ctx.turnsRemaining === undefined) continue;
      const next = ctx.turnsRemaining - 1;
      if (next <= 0) {
        this.cacheSafe.delete(id);
      } else {
        this.cacheSafe.set(id, { ...ctx, turnsRemaining: next });
      }
    }
  }

  clear(): void {
    this.snippets.clear();
    this.cacheSafe.clear();
  }
}
