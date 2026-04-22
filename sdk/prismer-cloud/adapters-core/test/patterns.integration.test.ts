/**
 * Integration test: PARA Patterns P4 / P5 / P8 / P11 / P12 working together.
 *
 * Simulates a minimal adapter session:
 *   1. Session start → trace store gets session events (P8).
 *   2. Runtime injects a cache-safe context (P11) and a system-prompt snippet (P4).
 *   3. A tool call requests approval (P5); gateway resolves with allow.
 *   4. Compaction boundary (P12) — trace persists both pre/post events.
 *
 * This is NOT a test of individual module behaviour (that's in their own
 * unit tests) — it's a test that they compose without contract drift. A
 * regression here almost always means one module's types or semantics
 * diverged from what another module assumes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TraceStore } from '../src/patterns/trace-store.js';
import { ApprovalGateway } from '../src/patterns/approval-gateway.js';
import { InjectionRegistry } from '../src/patterns/injection-registry.js';
import { PermissionLeaseManager } from '../src/permission-lease.js';
import { ProgressiveSkillLoader } from '../src/skill-system/progressive.js';
import type { SkillDescriptor } from '../src/skill-system/loader.js';

describe('Patterns composition (P4+P5+P8+P11+P12)', () => {
  let traceDir: string;
  let trace: TraceStore;

  beforeEach(() => {
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'para-patterns-'));
    trace = new TraceStore({ traceDir });
  });

  afterEach(() => {
    fs.rmSync(traceDir, { recursive: true, force: true });
  });

  it('session trace captures events before compaction; post-compaction events appended', () => {
    const sid = 'sess-1';
    // Emit a pre-compaction stream
    for (let i = 0; i < 5; i++) {
      trace.append(sid, { type: 'agent.message', role: 'user', content: `msg ${i}`, ts: i });
    }
    trace.append(sid, { type: 'agent.compact.pre', sessionId: sid, trigger: 'auto', messageCount: 5, tokenCount: 100 });
    // Simulated compaction discards messages 0-2 from working memory but trace
    // persists all of them (P12 invariant: trace file unaffected by compaction).
    trace.append(sid, { type: 'agent.compact.post', sessionId: sid, compactedCount: 3, tokensBefore: 100, tokensAfter: 40 });
    trace.append(sid, { type: 'agent.message', role: 'agent', content: 'after-compact', ts: 6 });

    const events = trace.read(sid);
    expect(events).toHaveLength(8);  // 5 msgs + pre + post + 1 msg after
    // Pre-compaction messages still recoverable
    expect((events[0] as any).content).toBe('msg 0');
    expect((events[4] as any).content).toBe('msg 4');
    // Compaction events bracket the boundary
    expect((events[5] as any).type).toBe('agent.compact.pre');
    expect((events[6] as any).type).toBe('agent.compact.post');
  });

  it('approval gateway round-trip: request → resolve → tool allowed', async () => {
    const gateway = new ApprovalGateway();
    const callId = 'tool-call-42';
    const pending = gateway.waitForDecision(callId, { ttlMs: 500 });
    // Runtime sends approval via a remote channel
    gateway.resolve(callId, { decision: 'allow', by: 'remote' });
    const result = await pending;
    expect(result.decision).toBe('allow');
    expect(result.by).toBe('remote');
  });

  it('approval gateway timeout falls back to deny', async () => {
    const gateway = new ApprovalGateway();
    const pending = gateway.waitForDecision('c-timeout', { ttlMs: 30, defaultOnTimeout: 'deny' });
    const result = await pending;
    expect(result.decision).toBe('deny');
    expect(result.by).toBe('local');
  });

  it('skill activation + permission lease compose correctly', () => {
    const leases = new PermissionLeaseManager();
    const rules = [
      { source: 'skill' as const, behavior: 'allow' as const, value: { tool: 'Bash', pattern: 'git *' } },
      { source: 'skill' as const, behavior: 'allow' as const, value: { tool: 'Edit', pattern: 'src/**' } },
    ];
    leases.grant('deploy-prod', rules);
    expect(leases.active()).toHaveLength(2);

    // Deactivate (e.g. compaction-drop via ProgressiveSkillLoader eviction)
    const revoked = leases.revoke('deploy-prod');
    expect(revoked).toHaveLength(2);
    expect(leases.active()).toHaveLength(0);
  });

  it('progressive loader evicts → caller can revoke lease for evicted skill', () => {
    // Simulate the coupling: ProgressiveSkillLoader eviction event triggers
    // PermissionLeaseManager.revoke(). This test asserts the composition works
    // without enforcing a specific callback mechanism.
    const leases = new PermissionLeaseManager();
    // Budget 30 tokens fits exactly one ~25-token body; activating the second
    // triggers LRU eviction of the first.
    const progressive = new ProgressiveSkillLoader({ budgetTokens: 30 });

    // Write two skills on disk so activate can load bodies
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prog-lease-'));
    try {
      function skillOnDisk(name: string, body: string): SkillDescriptor {
        const skillDir = path.join(dir, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${name}\n---\n${body}`,
          'utf-8',
        );
        return {
          name,
          qualifiedName: name,
          source: { kind: 'workspace', root: dir },
          filePath: path.join(skillDir, 'SKILL.md'),
          frontmatter: { name, description: name },
        };
      }
      const a = skillOnDisk('a', 'x'.repeat(100)); // ≈ 25 tokens
      const b = skillOnDisk('b', 'x'.repeat(100));

      progressive.activate(a);
      leases.grant('a', [{ source: 'skill', behavior: 'allow', value: { tool: 'Bash' } }]);
      progressive.activate(b);
      leases.grant('b', [{ source: 'skill', behavior: 'allow', value: { tool: 'Edit' } }]);

      // Budget = 10 tokens but each skill body ≈ 25 tokens → a should have been
      // evicted when b landed.
      const still = progressive.active().map((s) => s.descriptor.name);
      expect(still).toEqual(['b']);

      // Caller now revokes a's lease since a is no longer active
      for (const evicted of ['a']) {
        leases.revoke(evicted);
      }
      // b's lease still active
      expect(leases.active()).toHaveLength(1);
      expect(leases.active()[0].value.tool).toBe('Edit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injection registry: snippets + cache-safe ticks correctly', () => {
    const injections = new InjectionRegistry();

    injections.activateSnippet({
      id: 'memory-summary',
      source: 'runtime',
      content: 'Prior sessions: ...',
    });
    injections.activateCacheSafe({
      id: 'turn-hint',
      source: 'runtime',
      content: 'Only do one tool call this turn.',
      turnsRemaining: 2,
    });

    expect(injections.currentSnippets()).toHaveLength(1);
    expect(injections.currentCacheContexts()).toHaveLength(1);

    injections.tickCacheContexts();
    expect(injections.currentCacheContexts()).toHaveLength(1);
    expect(injections.currentCacheContexts()[0].turnsRemaining).toBe(1);

    injections.tickCacheContexts();
    // turnsRemaining dropped to 0 → auto-removed
    expect(injections.currentCacheContexts()).toHaveLength(0);
    // Snippets unchanged (no ticking)
    expect(injections.currentSnippets()).toHaveLength(1);
  });

  it('deactivate by skill name only drops that skill\'s snippets', () => {
    const injections = new InjectionRegistry();
    injections.activateSnippet({
      id: 's1',
      source: 'skill',
      content: 'from skill A',
      skillName: 'skill-a',
    });
    injections.activateSnippet({
      id: 's2',
      source: 'skill',
      content: 'from skill B',
      skillName: 'skill-b',
    });
    injections.activateSnippet({
      id: 's3',
      source: 'runtime',
      content: 'from runtime',
    });

    const removed = injections.deactivateBySkill('skill-a');
    expect(removed).toBe(1);
    expect(injections.currentSnippets()).toHaveLength(2);
    expect(injections.currentSnippets().find((s) => s.skillName === 'skill-a')).toBeUndefined();
  });
});
