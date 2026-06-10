/**
 * @vitest-environment jsdom
 *
 * release201/26 §8 Phase 4 — conversation-timeline strip for the
 * `resume_failed` run status (daemon couldn't resume an interrupted run).
 *
 * Covers:
 *   - readTaskStatusEvent accepts metadata.status='resume_failed' (previously
 *     it filtered to completed/failed/cancelled/awaiting_approval only)
 *   - TaskStatusEventRow renders the amber "Task interrupted — tap to retry"
 *     pill and fires onRetryRun(taskId) on click — the retry affordance
 *   - the row remains a no-op-render for the existing terminal statuses
 *     (regression guard: no interaction change for completed/failed)
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/contexts/i18n-context';
import {
  TaskStatusEventRow,
  readTaskStatusEvent,
  type TaskStatusEventInfo,
} from '../im-channel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// readTaskStatusEvent only reads `type`, `metadata`, `content`.
function makeMessage(metadata: Record<string, unknown>, content = '') {
  return { type: 'system_event', metadata, content } as never;
}

async function renderRow(event: TaskStatusEventInfo, onRetryRun?: (taskId: string) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <TaskStatusEventRow event={event} isDark={false} onRetryRun={onRetryRun} />
      </I18nProvider>,
    );
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('readTaskStatusEvent — resume_failed', () => {
  it('accepts a resume_failed status event', () => {
    const info = readTaskStatusEvent(
      makeMessage({ kind: 'agent_status_event', status: 'resume_failed', taskId: 'run_1', error: 'kill -9' }),
    );
    expect(info).not.toBeNull();
    expect(info!.status).toBe('resume_failed');
    expect(info!.taskId).toBe('run_1');
    expect(info!.error).toBe('kill -9');
  });

  it('still accepts the existing terminal statuses', () => {
    expect(
      readTaskStatusEvent(makeMessage({ kind: 'task_status_event', status: 'completed', taskId: 't1' }))?.status,
    ).toBe('completed');
    expect(
      readTaskStatusEvent(makeMessage({ kind: 'task_status_event', status: 'failed', taskId: 't1' }))?.status,
    ).toBe('failed');
  });

  it('rejects an unknown status', () => {
    expect(
      readTaskStatusEvent(makeMessage({ kind: 'task_status_event', status: 'banana', taskId: 't1' })),
    ).toBeNull();
  });
});

describe('TaskStatusEventRow — resume_failed strip', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the retry label and fires onRetryRun on click', async () => {
    const onRetryRun = vi.fn();
    const { host, cleanup } = await renderRow(
      { taskId: 'run_1', taskTitle: 'My run', status: 'resume_failed', kind: 'agent', error: 'crash' },
      onRetryRun,
    );
    const btn = host.querySelector('[data-status="resume_failed"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(host.textContent).toContain('Task interrupted');
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(onRetryRun).toHaveBeenCalledWith('run_1');
    await cleanup();
  });

  it('is disabled when no retry handler is wired', async () => {
    const { host, cleanup } = await renderRow({
      taskId: 'run_1',
      taskTitle: 'My run',
      status: 'resume_failed',
      kind: 'agent',
    });
    const btn = host.querySelector('[data-status="resume_failed"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await cleanup();
  });

  it('regression: a failed status row does NOT call onRetryRun on click', async () => {
    const onRetryRun = vi.fn();
    const { host, cleanup } = await renderRow(
      { taskId: 'run_1', taskTitle: 'My run', status: 'failed', kind: 'agent', error: 'boom' },
      onRetryRun,
    );
    const btn = host.querySelector('[data-status="failed"]') as HTMLButtonElement;
    // agent-kind non-resume rows are not clickable (existing behaviour).
    expect(btn.disabled).toBe(true);
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(onRetryRun).not.toHaveBeenCalled();
    await cleanup();
  });
});
