/**
 * release201/26 §8 Phase 4 — `task.dispatch.resume_failed` cloud effect.
 *
 * Covers `applyResumeFailed` (the unit the WS `task.dispatch.resume_failed`
 * handler delegates to after daemon-ownership resolution):
 *   - writes IMTaskRun.status='resume_failed' + error=reason + metadata.reason
 *   - preserves existing run metadata while merging the resume-failed marker
 *   - posts a system_event with metadata.status='resume_failed' so the
 *     conversation-timeline strip renders the retry affordance
 *   - chat-mention runs emit `agent_status_event`; board runs `task_status_event`
 *   - graceful: DB update failure does NOT throw and still posts the message
 *   - graceful: no conversationId / no messageService → no message, no throw
 *
 * Note: daemon-ownership resolution + "run not found → drop" lives in the WS
 * closure (resolveDeclaredRun) which is exercised by the wider daemon-protocol
 * suite; this file pins the persisted effect that is the user-facing contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyResumeFailed } from '../ws/handler';

function makeRun(over: Record<string, unknown> = {}) {
  return {
    assigneeId: 'agent_1',
    conversationId: 'conv_1',
    metadata: JSON.stringify({ title: 'My run' }),
    sourceKind: 'task',
    ...over,
  };
}

function makeDeps() {
  const update = vi.fn().mockResolvedValue({});
  const send = vi.fn().mockResolvedValue({});
  return {
    prisma: { iMTaskRun: { update } } as any,
    messageService: { send } as any,
    update,
    send,
  };
}

describe('applyResumeFailed — run row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes status=resume_failed + error + merged metadata', async () => {
    const { prisma, messageService, update } = makeDeps();
    await applyResumeFailed({
      prisma,
      messageService,
      runId: 'run_1',
      taskId: 'task_1',
      reason: 'checkpoint corrupt',
      run: makeRun(),
    });

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'run_1' });
    expect(arg.data.status).toBe('resume_failed');
    expect(arg.data.error).toBe('checkpoint corrupt');
    const meta = JSON.parse(arg.data.metadata);
    expect(meta.title).toBe('My run'); // prior metadata preserved
    expect(meta.resumeFailedReason).toBe('checkpoint corrupt');
    expect(typeof meta.resumeFailedAt).toBe('string');
  });

  it('tolerates unparseable prior metadata', async () => {
    const { prisma, messageService, update } = makeDeps();
    await applyResumeFailed({
      prisma,
      messageService,
      runId: 'run_2',
      reason: 'kill -9',
      run: makeRun({ metadata: 'not json' }),
    });
    const meta = JSON.parse(update.mock.calls[0][0].data.metadata);
    expect(meta.resumeFailedReason).toBe('kill -9');
  });
});

describe('applyResumeFailed — status-event message', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a task_status_event with status=resume_failed for board runs', async () => {
    const { prisma, messageService, send } = makeDeps();
    await applyResumeFailed({
      prisma,
      messageService,
      runId: 'run_1',
      taskId: 'task_1',
      reason: 'crash',
      run: makeRun({ sourceKind: 'task' }),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.conversationId).toBe('conv_1');
    expect(msg.senderId).toBe('agent_1');
    expect(msg.type).toBe('system_event');
    expect(msg.metadata.kind).toBe('task_status_event');
    expect(msg.metadata.status).toBe('resume_failed');
    expect(msg.metadata.taskId).toBe('task_1');
    expect(msg.metadata.runId).toBe('run_1');
    expect(msg.metadata.error).toBe('crash');
  });

  it('uses agent_status_event for chat-mention runs', async () => {
    const { prisma, messageService, send } = makeDeps();
    await applyResumeFailed({
      prisma,
      messageService,
      runId: 'run_1',
      reason: 'crash',
      run: makeRun({ sourceKind: 'chat_mention' }),
    });
    expect(send.mock.calls[0][0].metadata.kind).toBe('agent_status_event');
    // taskId falls back to runId when not supplied
    expect(send.mock.calls[0][0].metadata.taskId).toBe('run_1');
  });
});

describe('applyResumeFailed — graceful failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not throw when the run update rejects, still posts the message', async () => {
    const update = vi.fn().mockRejectedValue(new Error('db down'));
    const send = vi.fn().mockResolvedValue({});
    await expect(
      applyResumeFailed({
        prisma: { iMTaskRun: { update } } as any,
        messageService: { send } as any,
        runId: 'run_1',
        reason: 'crash',
        run: makeRun(),
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips the message when run has no conversationId', async () => {
    const { prisma, messageService, send } = makeDeps();
    await applyResumeFailed({
      prisma,
      messageService,
      runId: 'run_1',
      reason: 'crash',
      run: makeRun({ conversationId: null }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the message when messageService is absent', async () => {
    const { prisma } = makeDeps();
    await expect(
      applyResumeFailed({
        prisma,
        messageService: undefined,
        runId: 'run_1',
        reason: 'crash',
        run: makeRun(),
      }),
    ).resolves.toBeUndefined();
  });
});
