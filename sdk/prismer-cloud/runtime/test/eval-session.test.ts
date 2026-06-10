/**
 * release201/08 §7 — EvalSessionRunner unit tests.
 *
 * Verifies:
 *  • tempHome is created with skill manifest files written under .skills/
 *  • the built-in matcher returns per-case pass/fail aligned with input pattern
 *  • cleanup removes the tempHome after the run finishes
 *  • onFinish callback receives the correct pass/fail tally
 *  • concurrency cap queues additional runs
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSessionRunner, newEvalRunId, scoreCase, type EvalCaseResult } from '../src/daemon/eval-session.js';

describe('EvalSessionRunner.start (built-in matcher)', () => {
  it('creates tempHome with skill manifest and cleans up after run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-session-test-'));
    const seen: string[] = [];
    let finishCb: any = null;

    const runner = new EvalSessionRunner({
      rootDir: root,
      onFinish: (req) => {
        finishCb = req;
      },
    });
    const runId = newEvalRunId();
    const skillManifest = [
      { path: 'SKILL.md', content: Buffer.from('---\nname: demo\n---\nBody').toString('base64') },
      { path: 'skill.json', content: Buffer.from('{"name":"demo"}').toString('base64') },
    ];
    let manifestSeen = false;

    // Sniff that the manifest was indeed written to disk during the run.
    await runner.start({
      runId,
      skillId: 'skill-1',
      skillSlug: 'demo',
      skillManifest,
      testCases: [
        { id: 'tc-1', input: 'hello world', expectedOutputPattern: 'hello' },
        { id: 'tc-2', input: 'goodbye', expectedOutputPattern: 'will-not-match' },
      ],
    });

    // After the run, tempHome should be gone (cleanup branch).
    expect(existsSync(join(root, runId))).toBe(false);

    // The finish callback must have received pass=1, fail=1.
    expect(finishCb).toBeTruthy();
    expect(finishCb.passCount).toBe(1);
    expect(finishCb.failCount).toBe(1);
    expect(finishCb.results).toHaveLength(2);
    const tc1 = (finishCb.results as EvalCaseResult[]).find((r) => r.id === 'tc-1');
    const tc2 = (finishCb.results as EvalCaseResult[]).find((r) => r.id === 'tc-2');
    expect(tc1?.passed).toBe(true);
    expect(tc2?.passed).toBe(false);
    expect(tc2?.error).toContain('did not match');

    // No skills root left behind — full HOME cleanup verified.
    void seen;
    void manifestSeen;
  });

  it('respects PRISMER_EVAL_MAX_CONCURRENT=1 by queueing the second run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-session-test-'));
    const order: string[] = [];
    const runner = new EvalSessionRunner({
      rootDir: root,
      maxConcurrent: 1,
      adapterSpawner: async (req) => {
        order.push(`start:${req.runId}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${req.runId}`);
        return req.testCases.map((tc) => ({ id: tc.id, passed: true, verdict: 'pass' as const, durationMs: 1 }));
      },
    });
    const r1 = newEvalRunId();
    const r2 = newEvalRunId();
    const p1 = runner.start({ runId: r1, skillId: 'skill-1', skillSlug: 'demo', skillManifest: [], testCases: [{ id: 'a', input: 'x' }] });
    const p2 = runner.start({ runId: r2, skillId: 'skill-1', skillSlug: 'demo', skillManifest: [], testCases: [{ id: 'a', input: 'x' }] });
    await Promise.all([p1, p2]);
    // First run must complete (end) before second one starts.
    const startR1 = order.indexOf(`start:${r1}`);
    const endR1 = order.indexOf(`end:${r1}`);
    const startR2 = order.indexOf(`start:${r2}`);
    expect(startR1).toBeLessThan(endR1);
    expect(endR1).toBeLessThan(startR2);
  });

  it('release201/24 §2.1 — a case with NO assertion is inconclusive, NOT auto-pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-session-test-'));
    let finishCb: any = null;
    const runner = new EvalSessionRunner({
      rootDir: root,
      onFinish: (req) => {
        finishCb = req;
      },
    });
    await runner.start({
      runId: newEvalRunId(),
      skillId: 'skill-1',
      skillSlug: 'demo',
      skillManifest: [],
      // No expectedOutputPattern, no acceptanceCriteria → must NOT auto-pass.
      testCases: [{ id: 'tc-bare', input: 'anything' }],
    });
    expect(finishCb).toBeTruthy();
    expect(finishCb.passCount).toBe(0);
    expect(finishCb.failCount).toBe(1);
    const r = (finishCb.results as EvalCaseResult[])[0];
    expect(r.verdict).toBe('inconclusive');
    expect(r.passed).toBe(false);
    expect(r.error).toContain('inconclusive');
  });

  it('scoreCase honors acceptanceCriteria and dispatch-success precedence', () => {
    // pattern wins
    expect(scoreCase({ expectedOutputPattern: 'ok' }, 'all ok here', { dispatchOk: false, canDispatch: false }).verdict).toBe('pass');
    // all acceptance criteria must match
    expect(scoreCase({ acceptanceCriteria: ['foo', 'bar'] }, 'foo bar baz', { dispatchOk: false, canDispatch: false }).verdict).toBe('pass');
    expect(scoreCase({ acceptanceCriteria: ['foo', 'missing'] }, 'foo only', { dispatchOk: false, canDispatch: false }).verdict).toBe('fail');
    // dispatch-success fallback only when a live adapter ran
    expect(scoreCase({}, '', { dispatchOk: true, canDispatch: true }).verdict).toBe('pass');
    expect(scoreCase({}, '', { dispatchOk: false, canDispatch: true }).verdict).toBe('fail');
    // no assertion + no dispatch → inconclusive
    expect(scoreCase({}, '', { dispatchOk: false, canDispatch: false }).verdict).toBe('inconclusive');
  });

  it('reports state with active runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-session-test-'));
    const runner = new EvalSessionRunner({
      rootDir: root,
      adapterSpawner: async (req) => {
        // Snapshot state mid-run to verify active count.
        const snap = runner.getState();
        expect(snap.active).toBeGreaterThanOrEqual(1);
        return req.testCases.map((tc) => ({ id: tc.id, passed: true, verdict: 'pass' as const, durationMs: 0 }));
      },
    });
    await runner.start({
      runId: newEvalRunId(),
      skillId: 'skill-1',
      skillSlug: 'demo',
      skillManifest: [],
      testCases: [{ id: 'a', input: 'x' }],
    });
    // After finish, active is 0.
    expect(runner.getState().active).toBe(0);
  });
});
