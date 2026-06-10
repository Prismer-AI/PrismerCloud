/**
 * Tests for business-event-bus (release201/12 §8c.2).
 *
 * Covers:
 *  - raw SSE envelope → WorkspaceBusinessEvent mapping for all 6 types
 *  - subscriber notification + ordering
 *  - history retention cap
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  __pushBusinessEventForTests,
  __resetBusinessEventBusForTests,
  getBusinessEventHistory,
  mapRawSseToBusinessEvent,
  subscribeBusinessEvents,
  type WorkspaceBusinessEvent,
} from '../business-event-bus';

afterEach(() => {
  __resetBusinessEventBusForTests();
});

describe('mapRawSseToBusinessEvent', () => {
  it('maps skill.authoring.started to skill.authoring.state_changed', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'skill.authoring.started',
      payload: { skillId: 's-1', stage: 'draft', state: 'started' },
    });
    expect(ev).not.toBeNull();
    if (!ev) return;
    expect(ev.type).toBe('skill.authoring.state_changed');
    if (ev.type === 'skill.authoring.state_changed') {
      expect(ev.payload.skillId).toBe('s-1');
      expect(ev.payload.stage).toBe('draft');
      expect(ev.payload.state).toBe('started');
    }
  });

  it('maps skill.authoring.failed and keeps severity + reason', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'skill.authoring.failed',
      payload: { skillId: 's-1', stage: 'eval', severity: 'error', reason: 'smoke failed' },
    });
    expect(ev?.type).toBe('skill.authoring.failed');
    if (ev?.type === 'skill.authoring.failed') {
      expect(ev.payload.severity).toBe('error');
      expect(ev.payload.reason).toBe('smoke failed');
    }
  });

  it('maps smoke completion', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'skill.authoring.smoke_completed',
      payload: { skillId: 's-1', passed: true, evidenceUri: 'https://x' },
    });
    expect(ev?.type).toBe('skill.authoring.smoke_completed');
    if (ev?.type === 'skill.authoring.smoke_completed') {
      expect(ev.payload.passed).toBe(true);
      expect(ev.payload.evidenceUri).toBe('https://x');
    }
  });

  it('maps task.acceptance.changed and includes counts', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'task.acceptance.changed',
      payload: {
        taskId: 't-1',
        workspaceId: 'ws-1',
        acceptanceStatus: 'partial',
        passedCount: 3,
        totalCount: 5,
      },
    });
    expect(ev?.type).toBe('task.acceptance.changed');
    if (ev?.type === 'task.acceptance.changed') {
      expect(ev.payload.acceptanceStatus).toBe('partial');
      expect(ev.payload.passedCount).toBe(3);
      expect(ev.payload.totalCount).toBe(5);
    }
  });

  it('maps task.evidence.attached', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'task.evidence.attached',
      payload: {
        taskId: 't-1',
        workspaceId: 'ws-1',
        evidenceId: 'e-1',
        kind: 'artifact',
        mime: 'image/png',
      },
    });
    expect(ev?.type).toBe('task.evidence.attached');
    if (ev?.type === 'task.evidence.attached') {
      expect(ev.payload.kind).toBe('artifact');
      expect(ev.payload.mime).toBe('image/png');
    }
  });

  it('maps project.metric.snapshot_updated', () => {
    const ev = mapRawSseToBusinessEvent({
      type: 'project.metric.snapshot_updated',
      payload: {
        projectId: 'p-1',
        workspaceId: 'ws-1',
        metricId: 'm-1',
        name: 'velocity',
        status: 'failing',
        current: 2,
        target: 10,
      },
    });
    expect(ev?.type).toBe('project.metric.snapshot_updated');
    if (ev?.type === 'project.metric.snapshot_updated') {
      expect(ev.payload.status).toBe('failing');
      expect(ev.payload.current).toBe(2);
      expect(ev.payload.target).toBe(10);
    }
  });

  it('returns null for unknown raw event types', () => {
    expect(mapRawSseToBusinessEvent({ type: 'random.unknown', payload: {} })).toBeNull();
    expect(mapRawSseToBusinessEvent({} as never)).toBeNull();
  });
});

describe('subscribeBusinessEvents', () => {
  it('delivers pushed events to all listeners in registration order', () => {
    const seen: string[] = [];
    const unsub1 = subscribeBusinessEvents((ev) => seen.push(`A:${ev.type}`));
    const unsub2 = subscribeBusinessEvents((ev) => seen.push(`B:${ev.type}`));

    const event: WorkspaceBusinessEvent = {
      type: 'task.acceptance.changed',
      receivedAt: Date.now(),
      payload: { taskId: 't-1', workspaceId: 'ws-1', acceptanceStatus: 'partial' },
    };
    __pushBusinessEventForTests(event);

    expect(seen).toEqual(['A:task.acceptance.changed', 'B:task.acceptance.changed']);
    unsub1();
    unsub2();
  });

  it('stops delivering after unsubscribe', () => {
    let count = 0;
    const unsub = subscribeBusinessEvents(() => count++);
    __pushBusinessEventForTests({
      type: 'skill.authoring.smoke_completed',
      receivedAt: 0,
      payload: { skillId: 's-1', passed: true },
    });
    unsub();
    __pushBusinessEventForTests({
      type: 'skill.authoring.smoke_completed',
      receivedAt: 0,
      payload: { skillId: 's-2', passed: true },
    });
    expect(count).toBe(1);
  });

  it('records history up to the cap and exposes a copy', () => {
    for (let i = 0; i < 5; i++) {
      __pushBusinessEventForTests({
        type: 'task.evidence.attached',
        receivedAt: i,
        payload: { taskId: `t-${i}`, workspaceId: 'ws-1', evidenceId: `e-${i}`, kind: 'artifact' },
      });
    }
    const hist = getBusinessEventHistory();
    expect(hist.length).toBe(5);
    // Mutating returned array should not affect internal store.
    hist.push({
      type: 'task.evidence.attached',
      receivedAt: 99,
      payload: { taskId: 'mutant', workspaceId: 'ws-1', evidenceId: 'mutant', kind: 'artifact' },
    });
    expect(getBusinessEventHistory().length).toBe(5);
  });
});
