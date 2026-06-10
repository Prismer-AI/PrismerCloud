import { describe, expect, it } from 'vitest';
import {
  SANDBOX_STATUSES,
  SandboxStatusTransitionError,
  assertSandboxStatusTransition,
  canTransitionSandboxStatus,
  normalizeSandboxStatus,
  transitionSandboxStatus,
} from '@/lib/sandbox/state-machine';

describe('sandbox state machine', () => {
  it('uses the seven migration 333 statuses', () => {
    expect(SANDBOX_STATUSES).toEqual([
      'pending',
      'provisioning',
      'running',
      'degraded',
      'stopping',
      'stopped',
      'errored',
    ]);
  });

  it('normalizes historical aliases into the seven-state set', () => {
    expect(normalizeSandboxStatus('created')).toBe('pending');
    expect(normalizeSandboxStatus('creating')).toBe('provisioning');
    expect(normalizeSandboxStatus('active')).toBe('running');
    expect(normalizeSandboxStatus('removed')).toBe('stopped');
    expect(normalizeSandboxStatus('failed')).toBe('errored');
    expect(normalizeSandboxStatus('unknown')).toBe('errored');
  });

  it('T11 — collapses legacy `failing` onto `errored`', () => {
    // Sweep target: any read path that decodes a legacy DB string must
    // surface it as the canonical terminal-error state.
    expect(normalizeSandboxStatus('failing')).toBe('errored');
  });

  it('allows expected lifecycle transitions', () => {
    expect(transitionSandboxStatus('pending', 'provisioning')).toBe('provisioning');
    expect(transitionSandboxStatus('provisioning', 'running')).toBe('running');
    expect(transitionSandboxStatus('running', 'degraded')).toBe('degraded');
    expect(transitionSandboxStatus('degraded', 'running')).toBe('running');
    expect(transitionSandboxStatus('running', 'stopping')).toBe('stopping');
    expect(transitionSandboxStatus('stopping', 'stopped')).toBe('stopped');
    expect(transitionSandboxStatus('errored', 'stopping')).toBe('stopping');
  });

  it('rejects illegal lifecycle transitions', () => {
    expect(canTransitionSandboxStatus('running', 'pending')).toBe(false);
    expect(() => transitionSandboxStatus('running', 'pending')).toThrow(SandboxStatusTransitionError);
    expect(() => transitionSandboxStatus('stopped', 'running')).toThrow('stopped -> running');
  });

  // T11 — strict guard tests: each illegal transition must throw and the
  // error must carry the from/to + context for the operator.
  it('T11 — assertSandboxStatusTransition throws on illegal transitions', () => {
    // Skip provisioning entirely → illegal.
    expect(() => assertSandboxStatusTransition('pending', 'running')).toThrow(SandboxStatusTransitionError);
    // stopped is terminal → no out-transitions allowed.
    expect(() => assertSandboxStatusTransition('stopped', 'running')).toThrow(/stopped -> running/);
    expect(() => assertSandboxStatusTransition('stopped', 'provisioning')).toThrow(SandboxStatusTransitionError);
    // errored may only cleanup via stopping.
    expect(() => assertSandboxStatusTransition('errored', 'running')).toThrow(SandboxStatusTransitionError);
    // provisioning skipping running goes to errored only — degraded illegal.
    expect(() => assertSandboxStatusTransition('provisioning', 'degraded')).toThrow(SandboxStatusTransitionError);
  });

  it('T11 — error message includes rowId / podName / reason context', () => {
    try {
      assertSandboxStatusTransition('stopped', 'running', {
        rowId: 'row-123',
        podName: 'pod-456',
        reason: 'pod_running',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxStatusTransitionError);
      const msg = (err as Error).message;
      expect(msg).toContain('rowId=row-123');
      expect(msg).toContain('pod=pod-456');
      expect(msg).toContain('reason=pod_running');
    }
  });

  it('T11 — assertSandboxStatusTransition same-state is legal (no throw)', () => {
    expect(() => assertSandboxStatusTransition('running', 'running')).not.toThrow();
    expect(() => assertSandboxStatusTransition('stopped', 'stopped')).not.toThrow();
  });
});
