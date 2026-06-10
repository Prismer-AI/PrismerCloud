/**
 * @vitest-environment jsdom
 *
 * release201/10 rev 2 §8.4 (S35) — TodoMiniBar colour-threshold + lazy
 * fetch contract on the kanban card foot.
 *
 * Verifies:
 *  - ≥80% completion → emerald
 *  - 50-79% completion → amber
 *  - <50% completion → rose
 *  - totalCount==0 renders nothing (avoids noise on TODO-less tasks)
 *  - lazy fetch is keyed by taskId so re-renders don't double-fire
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/im-api', () => ({
  imFetch: vi.fn(),
}));

import { imFetch } from '../../lib/im-api';
import { TodoMiniBar } from '../task-card';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderBar(taskId: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TodoMiniBar taskId={taskId} isDark={false} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('TodoMiniBar — release201/10 §8.4 colour thresholds', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when totalCount=0', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 0, totalCount: 0, progressPct: 0 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const { host, cleanup } = await renderBar('t-empty');
    expect(host.querySelector('[data-testid="todo-mini-bar"]')).toBeNull();
    await cleanup();
  });

  it('renders nothing when fetch fails', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: false,
      status: 500,
      error: 'ERR',
      message: 'boom',
    } as Awaited<ReturnType<typeof imFetch>>);

    const { host, cleanup } = await renderBar('t-fail');
    expect(host.querySelector('[data-testid="todo-mini-bar"]')).toBeNull();
    await cleanup();
  });

  it('uses emerald colour at ≥80% completion (9/10)', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 9, totalCount: 10, progressPct: 0.9 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const { host, cleanup } = await renderBar('t-80');
    const bar = host.querySelector('[data-testid="todo-mini-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toMatch(/emerald/);
    // The bar fill width matches the progress percentage.
    expect(bar.style.width).toBe('90%');
    await cleanup();
  });

  it('uses amber colour at 50-79% completion (6/10)', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 6, totalCount: 10, progressPct: 0.6 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const { host, cleanup } = await renderBar('t-60');
    const bar = host.querySelector('[data-testid="todo-mini-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toMatch(/amber/);
    await cleanup();
  });

  it('uses rose colour at <50% completion (2/10)', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 2, totalCount: 10, progressPct: 0.2 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const { host, cleanup } = await renderBar('t-20');
    const bar = host.querySelector('[data-testid="todo-mini-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toMatch(/rose/);
    await cleanup();
  });

  it('fires exactly one fetch per mount for a given taskId', async () => {
    vi.mocked(imFetch).mockResolvedValue({
      ok: true,
      data: { doneCount: 5, totalCount: 10, progressPct: 0.5 },
    } as Awaited<ReturnType<typeof imFetch>>);

    const { cleanup } = await renderBar('t-fetch-count');
    expect(imFetch).toHaveBeenCalledTimes(1);
    expect(imFetch).toHaveBeenCalledWith('/tasks/t-fetch-count/todo');
    await cleanup();
  });
});
