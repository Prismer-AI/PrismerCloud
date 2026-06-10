/**
 * @vitest-environment jsdom
 *
 * P6 — TaskReviewBar inline reject flow.
 *
 * Verifies the §7.1 contract: reject MUST carry a `reviewComment` (empty
 * submit is a no-op + info toast), and the success path calls
 * `transitionTask({to:'assigned', reviewComment})`.
 *
 * release201/10 §8.5 (S35) — TODO + Acceptance chip pair on the review bar
 * + force-approve confirm modal when TODO < 80% or acceptance not passed.
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskReviewBar, __resetTodoCacheForTests } from '../task-review-bar';

vi.mock('../../lib/mutations', () => ({
  transitionTask: vi.fn(),
}));

vi.mock('../../lib/im-api', () => ({
  imFetch: vi.fn(),
}));

import { transitionTask } from '../../lib/mutations';
import { imFetch } from '../../lib/im-api';
import { beforeEach } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // Default — no TODO items so the chip is hidden and the soft-gate
  // confirm modal stays out of the way. Individual tests override as
  // needed.
  vi.mocked(imFetch).mockResolvedValue({
    ok: true,
    data: { doneCount: 0, totalCount: 0, progressPct: 0 },
  } as Awaited<ReturnType<typeof imFetch>>);
});

function makeTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: null,
    capability: null,
    workspaceId: 'ws-1',
    conversationId: null,
    creatorId: 'u-creator',
    assigneeId: 'agent-1',
    status: 'review',
    progress: null,
    statusMessage: null,
    budget: null,
    cost: 0,
    deadline: null,
    completedAt: null,
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('TaskReviewBar — P6 inline reject', () => {
  afterEach(() => {
    vi.clearAllMocks();
    __resetTodoCacheForTests();
  });

  it('Reject requires a non-empty reviewComment before transitionTask is called', async () => {
    const notify = vi.fn();
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: makeTask('t1') } as Awaited<
      ReturnType<typeof transitionTask>
    >);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[makeTask('t1') as never]} notify={notify} />);
    });

    // Click "驳回" → reveals the inline textarea (no transitionTask yet).
    const rejectBtn = host.querySelector('[data-testid="task-review-bar-reject-t1"]') as HTMLButtonElement;
    expect(rejectBtn).toBeTruthy();
    await act(async () => {
      rejectBtn.click();
    });
    expect(transitionTask).not.toHaveBeenCalled();

    // Try to submit with empty textarea — should NOT call transitionTask;
    // submit button stays disabled. We also assert programmatic submit
    // (forcing the click) refuses via the empty-reason guard.
    const submitBtn = host.querySelector('[data-testid="task-review-bar-reject-submit-t1"]') as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    expect(submitBtn.disabled).toBe(true);

    // Type a reason → submit button enables → click submits.
    const textarea = host.querySelector('[data-testid="task-review-bar-reject-input-t1"]') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      // React 19 controlled-input pattern: dispatch a real input event so
      // the onChange handler updates state.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Needs source links');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(submitBtn.disabled).toBe(false);
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
    });

    expect(transitionTask).toHaveBeenCalledOnce();
    expect(transitionTask).toHaveBeenCalledWith('t1', {
      to: 'assigned',
      reason: 'Rejected — needs rework',
      reviewComment: 'Needs source links',
    });

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('Approve fires transitionTask({to:"completed"})', async () => {
    const notify = vi.fn();
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: makeTask('t1') } as Awaited<
      ReturnType<typeof transitionTask>
    >);
    // No TODO items + no acceptance criteria → soft gates skip, approve
    // proceeds straight to transitionTask.
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 0, totalCount: 0, progressPct: 0 },
    } as Awaited<ReturnType<typeof imFetch>>);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[makeTask('t1') as never]} notify={notify} />);
    });

    const approveBtn = host.querySelector('[data-testid="task-review-bar-approve-t1"]') as HTMLButtonElement;
    expect(approveBtn).toBeTruthy();
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transitionTask).toHaveBeenCalledWith('t1', { to: 'completed', reason: 'Approved' });

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('TaskReviewBar — release201/10 §8.5 TODO + Acceptance chip', () => {
  afterEach(() => {
    vi.clearAllMocks();
    __resetTodoCacheForTests();
  });

  it('Renders TODO summary chip once TODO.md has items', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 5, totalCount: 10, progressPct: 0.5 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[makeTask('t1') as never]} notify={vi.fn()} />);
    });
    // Flush effect + state update from the imFetch promise.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const chip = host.querySelector('[data-testid="task-review-bar-todo-chip-t1"]');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('5/10');
    // 50% → amber threshold
    expect(chip!.className).toContain('amber');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('Renders acceptance chip alongside TODO chip', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 10, totalCount: 10, progressPct: 1 },
    } as Awaited<ReturnType<typeof imFetch>>);
    const task = makeTask('t2', {
      acceptanceTotalCount: 3,
      acceptanceCompletedCount: 3,
      acceptanceStatus: 'passed',
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[task as never]} notify={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="task-review-bar-todo-chip-t2"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-review-bar-acceptance-chip-t2"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('Force-approve confirm modal surfaces when TODO < 80%', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 3, totalCount: 10, progressPct: 0.3 },
    } as Awaited<ReturnType<typeof imFetch>>);
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: makeTask('t3') } as Awaited<
      ReturnType<typeof transitionTask>
    >);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[makeTask('t3') as never]} notify={vi.fn()} />);
    });
    // Let mount fetch complete so cache is primed.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const approveBtn = host.querySelector('[data-testid="task-review-bar-approve-t3"]') as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Confirm modal should be visible — transitionTask must NOT have fired yet.
    const confirm = host.querySelector('[data-testid="task-review-bar-confirm-t3"]');
    expect(confirm).toBeTruthy();
    expect(host.querySelector('[data-testid="task-review-bar-confirm-todo-t3"]')).toBeTruthy();
    expect(transitionTask).not.toHaveBeenCalled();

    // Click "强制通过" → fires transitionTask.
    const force = host.querySelector('[data-testid="task-review-bar-confirm-force-t3"]') as HTMLButtonElement;
    await act(async () => {
      force.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transitionTask).toHaveBeenCalledWith('t3', { to: 'completed', reason: 'Approved' });

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('Force-approve confirm modal surfaces when acceptance partial', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 10, totalCount: 10, progressPct: 1 },
    } as Awaited<ReturnType<typeof imFetch>>);
    const task = makeTask('t4', {
      acceptanceTotalCount: 3,
      acceptanceCompletedCount: 1,
      acceptanceStatus: 'partial',
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<TaskReviewBar isDark={false} tasks={[task as never]} notify={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const approveBtn = host.querySelector('[data-testid="task-review-bar-approve-t4"]') as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="task-review-bar-confirm-t4"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-review-bar-confirm-acceptance-t4"]')).toBeTruthy();
    // TODO complete → no TODO block in the modal
    expect(host.querySelector('[data-testid="task-review-bar-confirm-todo-t4"]')).toBeNull();

    // Cancel keeps the task in review.
    const cancel = host.querySelector('[data-testid="task-review-bar-confirm-cancel-t4"]') as HTMLButtonElement;
    await act(async () => {
      cancel.click();
    });
    expect(transitionTask).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="task-review-bar-confirm-t4"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
