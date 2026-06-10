/**
 * @vitest-environment jsdom
 *
 * P6 — TaskCardActions bucket → handler routing test.
 *
 * Asserts that, per (status, assigneeId), the rendered primary/secondary
 * action wires to the correct prop handler. This is the cheap end-to-end
 * verification that the column-specific actions (Approve / Reject /
 * Unblock / Restore) we added in §7.1 actually fire `transitionTask` via
 * the card-level handler.
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCardActions } from '../task-card-actions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderActions(props: React.ComponentProps<typeof TaskCardActions>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TaskCardActions {...props} />);
  });
  return {
    host,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function clickByTestId(host: HTMLElement, testId: string) {
  const btn = host.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(btn, `expected button with data-testid="${testId}"`).toBeTruthy();
  act(() => {
    btn!.click();
  });
}

describe('TaskCardActions — P6 bucket → handler routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('REVIEW: Approve button fires onApprove', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { host, cleanup } = renderActions({
      task: { id: 't1', status: 'review', assigneeId: 'a1' },
      onApprove,
      onReject,
    });
    expect(host.querySelector('[data-bucket="review"]')).toBeTruthy();
    clickByTestId(host, 'task-card-actions-primary-approve');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
    cleanup();
  });

  it('REVIEW: Reject button fires onReject (drawer routes to inline form)', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { host, cleanup } = renderActions({
      task: { id: 't1', status: 'review', assigneeId: 'a1' },
      onApprove,
      onReject,
    });
    clickByTestId(host, 'task-card-actions-secondary-reject');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    cleanup();
  });

  it('BLOCKED: Unblock button fires onUnblock; Reassign fires onReassign', () => {
    const onUnblock = vi.fn();
    const onReassign = vi.fn();
    const { host, cleanup } = renderActions({
      task: { id: 't1', status: 'blocked', assigneeId: 'a1' },
      onUnblock,
      onReassign,
    });
    expect(host.querySelector('[data-bucket="blocked"]')).toBeTruthy();
    clickByTestId(host, 'task-card-actions-primary-unblock');
    expect(onUnblock).toHaveBeenCalledOnce();
    clickByTestId(host, 'task-card-actions-secondary-reassign');
    expect(onReassign).toHaveBeenCalledOnce();
    cleanup();
  });

  it('CANCELLED: Restore button fires onRestore', () => {
    const onRestore = vi.fn();
    const onReopen = vi.fn();
    const { host, cleanup } = renderActions({
      task: { id: 't1', status: 'cancelled', assigneeId: null },
      onRestore,
      onReopen,
    });
    expect(host.querySelector('[data-bucket="cancelled"]')).toBeTruthy();
    clickByTestId(host, 'task-card-actions-primary-restore');
    expect(onRestore).toHaveBeenCalledOnce();
    // We deliberately don't render `reopen` in the cancelled bucket anymore —
    // restore is the single primary affordance.
    expect(onReopen).not.toHaveBeenCalled();
    cleanup();
  });

  it('DONE (completed): View output + Reopen are exposed', () => {
    const onViewOutput = vi.fn();
    const onReopen = vi.fn();
    const { host, cleanup } = renderActions({
      task: { id: 't1', status: 'completed', assigneeId: 'a1' },
      onViewOutput,
      onReopen,
    });
    expect(host.querySelector('[data-bucket="done"]')).toBeTruthy();
    clickByTestId(host, 'task-card-actions-primary-view-output');
    expect(onViewOutput).toHaveBeenCalledOnce();
    clickByTestId(host, 'task-card-actions-secondary-reopen');
    expect(onReopen).toHaveBeenCalledOnce();
    cleanup();
  });
});
