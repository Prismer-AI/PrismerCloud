/**
 * @vitest-environment jsdom
 *
 * P9 — TaskDigestCard renderer.
 *
 * Verifies the §9 contract: the digest card surfaces actionable buttons
 * only when the status requires operator attention.
 *   - review → Approve + Reject visible
 *   - blocked → Unblock visible
 *   - completed → no action buttons
 *
 * Plus: readTaskDigestPayload parses the metadata shape and rejects
 * unrelated system messages.
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PhaseBadge,
  StuckWarning,
  TaskDigestCard,
  readTaskDigestPayload,
  type AgentTaskPhase,
  type TaskDigestPayload,
} from '../task-digest-card';

vi.mock('../../lib/mutations', () => ({
  transitionTask: vi.fn(),
}));

import { transitionTask } from '../../lib/mutations';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeDigest(overrides: Partial<TaskDigestPayload> = {}): TaskDigestPayload {
  return {
    taskId: 'task_abc',
    taskTitle: 'Fix login bug',
    status: 'review',
    creatorId: 'creator_1',
    assigneeId: 'agent_1',
    latestTransition: {
      from: 'running',
      to: 'review',
      by: 'agent_1',
      at: '2026-05-19T00:00:00.000Z',
    },
    ...overrides,
  };
}

async function renderInto(digest: TaskDigestPayload) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TaskDigestCard digest={digest} isDark={false} onOpenTask={() => {}} />);
  });
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe('TaskDigestCard — P9 action buttons', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('review status renders Approve + Reject buttons', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'review' }));
    expect(host.querySelector('[data-testid="task-digest-card-approve-task_abc"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-reject-task_abc"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-unblock-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('blocked status renders the Unblock button (no Approve/Reject)', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'blocked', error: 'missing key' }));
    expect(host.querySelector('[data-testid="task-digest-card-unblock-task_abc"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-approve-task_abc"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-digest-card-reject-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('completed status shows no action buttons', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'completed' }));
    expect(host.querySelector('[data-testid="task-digest-card-approve-task_abc"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-digest-card-reject-task_abc"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-digest-card-unblock-task_abc"]')).toBeNull();
    // Card itself still renders.
    expect(host.querySelector('[data-testid="task-digest-card-task_abc"]')).toBeTruthy();
    await cleanup();
  });

  it('Approve click calls transitionTask({to:"completed"})', async () => {
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: {} as never } as Awaited<
      ReturnType<typeof transitionTask>
    >);
    const { host, cleanup } = await renderInto(makeDigest({ status: 'review' }));
    const approveBtn = host.querySelector(
      '[data-testid="task-digest-card-approve-task_abc"]',
    ) as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
    });
    expect(transitionTask).toHaveBeenCalledWith('task_abc', { to: 'completed', reason: 'Approved' });
    await cleanup();
  });

  it('Unblock click calls transitionTask({to:"running"})', async () => {
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: {} as never } as Awaited<
      ReturnType<typeof transitionTask>
    >);
    const { host, cleanup } = await renderInto(makeDigest({ status: 'blocked' }));
    const unblockBtn = host.querySelector(
      '[data-testid="task-digest-card-unblock-task_abc"]',
    ) as HTMLButtonElement;
    await act(async () => {
      unblockBtn.click();
      await Promise.resolve();
    });
    expect(transitionTask).toHaveBeenCalledWith('task_abc', { to: 'running', reason: 'Unblocked' });
    await cleanup();
  });
});

describe('TaskDigestCard — completed deliverables surface as product assets (B-line)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('completed + resultAssetCount renders the artifact chip (not inline body)', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'completed', resultAssetCount: 3 }));
    const chip = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('data-asset-count')).toBe('3');
    expect(chip?.textContent).toContain('3 个产物');
    // The old inline result body must be gone.
    expect(host.querySelector('[data-testid="task-digest-card-result-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('single asset with a filename labels the chip with the filename', async () => {
    const { host, cleanup } = await renderInto(
      makeDigest({
        status: 'completed',
        resultAssetCount: 1,
        resultAssets: [{ assetId: 'a1', filename: 'report.md', mime: 'text/markdown' }],
      }),
    );
    const chip = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]');
    expect(chip?.textContent).toContain('report.md');
    await cleanup();
  });

  it('clicking the chip routes to the task (drawer Artifacts tab)', async () => {
    const onOpenTask = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({ status: 'completed', resultAssetCount: 2 })}
          isDark={false}
          onOpenTask={onOpenTask}
        />,
      );
    });
    const chip = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]') as HTMLButtonElement;
    await act(async () => {
      chip.click();
      await Promise.resolve();
    });
    expect(onOpenTask).toHaveBeenCalledWith('task_abc');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('completed WITHOUT any deliverable assets renders no chip (zero-noise)', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'completed' }));
    expect(host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('completed + outputPreview but no assets renders NOTHING inline (output lives in drawer)', async () => {
    const { host, cleanup } = await renderInto(
      makeDigest({ status: 'completed', outputPreview: '一段不该被回显的输出文本' }),
    );
    expect(host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-digest-card-result-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('a running task does NOT show the chip even if resultAssetCount is set', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'running', resultAssetCount: 2 }));
    expect(host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]')).toBeNull();
    await cleanup();
  });
});

describe('TaskDigestCard — multi-file product list', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per deliverable when multiple refs are present', async () => {
    const { host, cleanup } = await renderInto(
      makeDigest({
        status: 'completed',
        resultAssetCount: 3,
        resultAssets: [
          { assetId: 'a1', filename: 'report.md', mime: 'text/markdown' },
          { assetId: 'a2', filename: 'data.csv', mime: 'text/csv' },
          { assetId: 'a3', filename: 'chart.png', mime: 'image/png' },
        ],
      }),
    );
    expect(host.querySelector('[data-testid="task-digest-card-artifact-a1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-a2"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-a3"]')).toBeTruthy();
    const container = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]');
    expect(container?.textContent).toContain('report.md');
    expect(container?.textContent).toContain('data.csv');
    expect(container?.textContent).toContain('chart.png');
    // count <= refs.length → no overflow row.
    expect(host.querySelector('[data-testid="task-digest-card-artifacts-more-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('clicking a file row opens that specific asset when onOpenAsset is provided', async () => {
    const onOpenAsset = vi.fn();
    const onOpenTask = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({
            status: 'completed',
            resultAssetCount: 2,
            resultAssets: [
              { assetId: 'a1', filename: 'report.md', mime: 'text/markdown' },
              { assetId: 'a2', filename: 'data.csv', mime: 'text/csv' },
            ],
          })}
          isDark={false}
          onOpenTask={onOpenTask}
          onOpenAsset={onOpenAsset}
        />,
      );
    });
    const row = host.querySelector('[data-testid="task-digest-card-artifact-a2"]') as HTMLButtonElement;
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
    expect(onOpenAsset).toHaveBeenCalledWith('a2');
    expect(onOpenTask).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('file row falls back to opening the task when onOpenAsset is absent', async () => {
    const onOpenTask = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({
            status: 'completed',
            resultAssetCount: 1,
            resultAssets: [{ assetId: 'a1', filename: 'report.md', mime: 'text/markdown' }],
          })}
          isDark={false}
          onOpenTask={onOpenTask}
        />,
      );
    });
    const row = host.querySelector('[data-testid="task-digest-card-artifact-a1"]') as HTMLButtonElement;
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
    expect(onOpenTask).toHaveBeenCalledWith('task_abc');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('shows an overflow row to the drawer when count exceeds the shown refs', async () => {
    const onOpenTask = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({
            status: 'completed',
            resultAssetCount: 9, // produced 9 files; payload teaser caps refs at 4
            resultAssets: [
              { assetId: 'a1', filename: 'f1.md', mime: 'text/markdown' },
              { assetId: 'a2', filename: 'f2.md', mime: 'text/markdown' },
              { assetId: 'a3', filename: 'f3.md', mime: 'text/markdown' },
              { assetId: 'a4', filename: 'f4.md', mime: 'text/markdown' },
            ],
          })}
          isDark={false}
          onOpenTask={onOpenTask}
        />,
      );
    });
    const more = host.querySelector('[data-testid="task-digest-card-artifacts-more-task_abc"]') as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent).toContain('9');
    await act(async () => {
      more.click();
      await Promise.resolve();
    });
    expect(onOpenTask).toHaveBeenCalledWith('task_abc');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('TaskDigestCard — live authoritative product list (WS1 resolveTaskAssets)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function renderWithResolver(
    digest: TaskDigestPayload,
    resolver?: (taskId: string) => Promise<{ assetId: string; filename?: string | null; mime?: string | null }[]>,
  ) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={digest}
          isDark={false}
          onOpenTask={() => {}}
          onOpenAsset={() => {}}
          resolveTaskAssets={resolver}
        />,
      );
    });
    // Let the mount effect's async resolver settle + re-render.
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

  it('overlays the live list on top of the payload teaser (payload 2 → resolver 3 → renders 3 rows)', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { assetId: 'live1', filename: 'a.md', mime: 'text/markdown' },
      { assetId: 'live2', filename: 'b.csv', mime: 'text/csv' },
      { assetId: 'live3', filename: 'c.png', mime: 'image/png' },
    ]);
    const { host, cleanup } = await renderWithResolver(
      makeDigest({
        status: 'completed',
        resultAssetCount: 2,
        resultAssets: [
          { assetId: 'snap1', filename: 'old.md', mime: 'text/markdown' },
          { assetId: 'snap2', filename: 'old.csv', mime: 'text/csv' },
        ],
      }),
      resolver,
    );
    expect(resolver).toHaveBeenCalledWith('task_abc');
    // Live rows present.
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live2"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live3"]')).toBeTruthy();
    // Stale payload rows replaced.
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap1"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap2"]')).toBeNull();
    // Authoritative count = 3 (not the payload's 2).
    const container = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]');
    expect(container?.getAttribute('data-asset-count')).toBe('3');
    await cleanup();
  });

  it('falls back to the payload teaser when the resolver rejects', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('network'));
    const { host, cleanup } = await renderWithResolver(
      makeDigest({
        status: 'completed',
        resultAssetCount: 2,
        resultAssets: [
          { assetId: 'snap1', filename: 'old.md', mime: 'text/markdown' },
          { assetId: 'snap2', filename: 'old.csv', mime: 'text/csv' },
        ],
      }),
      resolver,
    );
    expect(resolver).toHaveBeenCalledWith('task_abc');
    // Payload rows preserved.
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap2"]')).toBeTruthy();
    const container = host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]');
    expect(container?.getAttribute('data-asset-count')).toBe('2');
    await cleanup();
  });

  it('falls back to the payload teaser when the resolver returns an empty list', async () => {
    const resolver = vi.fn().mockResolvedValue([]);
    const { host, cleanup } = await renderWithResolver(
      makeDigest({
        status: 'completed',
        resultAssetCount: 1,
        resultAssets: [{ assetId: 'snap1', filename: 'old.md', mime: 'text/markdown' }],
      }),
      resolver,
    );
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap1"]')).toBeTruthy();
    await cleanup();
  });

  it('does NOT call the resolver for a running task even if resultAssetCount is set', async () => {
    const resolver = vi.fn().mockResolvedValue([{ assetId: 'live1', filename: 'a.md', mime: 'text/markdown' }]);
    const { cleanup } = await renderWithResolver(
      makeDigest({ status: 'running', resultAssetCount: 3 }),
      resolver,
    );
    expect(resolver).not.toHaveBeenCalled();
    await cleanup();
  });

  it('does NOT call the resolver for a completed task with no claimed products', async () => {
    const resolver = vi.fn().mockResolvedValue([{ assetId: 'live1', filename: 'a.md', mime: 'text/markdown' }]);
    const { host, cleanup } = await renderWithResolver(makeDigest({ status: 'completed' }), resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="task-digest-card-artifacts-task_abc"]')).toBeNull();
    await cleanup();
  });

  it('clicking a live row calls onOpenAsset with that asset id', async () => {
    const onOpenAsset = vi.fn();
    const onOpenTask = vi.fn();
    const resolver = vi
      .fn()
      .mockResolvedValue([{ assetId: 'live1', filename: 'a.md', mime: 'text/markdown' }]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({ status: 'completed', resultAssetCount: 1, resultAssets: null })}
          isDark={false}
          onOpenTask={onOpenTask}
          onOpenAsset={onOpenAsset}
          resolveTaskAssets={resolver}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const row = host.querySelector('[data-testid="task-digest-card-artifact-live1"]') as HTMLButtonElement;
    expect(row).toBeTruthy();
    await act(async () => {
      row.click();
      await Promise.resolve();
    });
    expect(onOpenAsset).toHaveBeenCalledWith('live1');
    expect(onOpenTask).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('truncates a long live list (>8) and shows the overflow row to the drawer', async () => {
    const refs = Array.from({ length: 11 }, (_, i) => ({
      assetId: `live${i}`,
      filename: `f${i}.md`,
      mime: 'text/markdown',
    }));
    const onOpenTask = vi.fn();
    const resolver = vi.fn().mockResolvedValue(refs);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({ status: 'completed', resultAssetCount: 2 })}
          isDark={false}
          onOpenTask={onOpenTask}
          onOpenAsset={() => {}}
          resolveTaskAssets={resolver}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // First 8 shown.
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live0"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live7"]')).toBeTruthy();
    // 9th+ hidden behind overflow.
    expect(host.querySelector('[data-testid="task-digest-card-artifact-live8"]')).toBeNull();
    const more = host.querySelector(
      '[data-testid="task-digest-card-artifacts-more-task_abc"]',
    ) as HTMLButtonElement;
    expect(more).toBeTruthy();
    expect(more.textContent).toContain('11');
    await act(async () => {
      more.click();
      await Promise.resolve();
    });
    expect(onOpenTask).toHaveBeenCalledWith('task_abc');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('without a resolver, completed cards still render the payload teaser (back-compat)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({
            status: 'completed',
            resultAssetCount: 1,
            resultAssets: [{ assetId: 'snap1', filename: 'old.md', mime: 'text/markdown' }],
          })}
          isDark={false}
          onOpenTask={() => {}}
        />,
      );
    });
    expect(host.querySelector('[data-testid="task-digest-card-artifact-snap1"]')).toBeTruthy();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('PhaseBadge — Wave 3 §4.4.3', () => {
  const phases: AgentTaskPhase[] = [
    'thinking',
    'tool_use',
    'reasoning',
    'responding',
    'waiting_user',
    'waiting_dep',
    'stuck',
  ];

  it('renders one mapping per known phase', async () => {
    for (const phase of phases) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(<PhaseBadge phase={phase} isDark={false} />);
      });
      const node = host.querySelector(`[data-testid="phase-badge-${phase}"]`);
      expect(node, `phase ${phase}`).toBeTruthy();
      expect(node?.getAttribute('data-phase')).toBe(phase);
      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  });

  it('renders nothing when phase is omitted', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<PhaseBadge phase={undefined} isDark={false} />);
    });
    expect(host.querySelector('[data-phase]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('includes the tool name when phase=tool_use and lastStep.toolName is provided', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<PhaseBadge phase="tool_use" lastStep={{ toolName: 'wechat-send' }} isDark={false} />);
    });
    expect(host.textContent).toContain('wechat-send');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('TaskDigestCard — stuck warning bar (Wave 3 §4.4.6)', () => {
  it('renders the stuck warning bar when phase=stuck, with both action buttons', async () => {
    const { host, cleanup } = await renderInto(
      makeDigest({
        status: 'running',
        phase: 'stuck',
        lastHeartbeatAt: new Date(Date.now() - 50_000).toISOString(),
      }),
    );
    expect(host.querySelector('[data-testid="stuck-warning"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="stuck-warning-retry"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="stuck-warning-fail"]')).toBeTruthy();
    // Phase badge ALSO renders.
    expect(host.querySelector('[data-testid="phase-badge-stuck"]')).toBeTruthy();
    await cleanup();
  });

  it('does NOT render the stuck warning bar when phase != stuck', async () => {
    const { host, cleanup } = await renderInto(makeDigest({ status: 'running', phase: 'thinking' }));
    expect(host.querySelector('[data-testid="stuck-warning"]')).toBeNull();
    expect(host.querySelector('[data-testid="phase-badge-thinking"]')).toBeTruthy();
    await cleanup();
  });

  it('"标记失败" calls transitionTask({to:"failed"}) — reuses force-transition L0/L1 path', async () => {
    vi.mocked(transitionTask).mockResolvedValue({ ok: true, data: {} as never } as Awaited<
      ReturnType<typeof transitionTask>
    >);
    const { host, cleanup } = await renderInto(
      makeDigest({ status: 'running', phase: 'stuck' }),
    );
    const failBtn = host.querySelector('[data-testid="stuck-warning-fail"]') as HTMLButtonElement;
    await act(async () => {
      failBtn.click();
      await Promise.resolve();
    });
    expect(transitionTask).toHaveBeenCalledWith('task_abc', {
      to: 'failed',
      reason: 'Marked failed from stuck warning',
    });
    await cleanup();
  });

  it('"重试 dispatch" calls onRetryDispatch when provided', async () => {
    const onRetryDispatch = vi.fn().mockResolvedValue(undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TaskDigestCard
          digest={makeDigest({ status: 'running', phase: 'stuck' })}
          isDark={false}
          onOpenTask={() => {}}
          onRetryDispatch={onRetryDispatch}
        />,
      );
    });
    const retryBtn = host.querySelector('[data-testid="stuck-warning-retry"]') as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });
    expect(onRetryDispatch).toHaveBeenCalledWith('task_abc');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('StuckWarning — standalone', () => {
  it('renders a concrete seconds-without-response when lastHeartbeatAt is present', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const ts = new Date(Date.now() - 90_000).toISOString();
    await act(async () => {
      root.render(<StuckWarning lastHeartbeatAt={ts} isDark={false} />);
    });
    expect(host.textContent).toMatch(/已 \d+ 秒无响应/);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('falls back to generic copy when lastHeartbeatAt is null', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<StuckWarning lastHeartbeatAt={null} isDark={false} />);
    });
    expect(host.textContent).toContain('agent 长时间未响应');
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});

describe('readTaskDigestPayload', () => {
  it('parses well-formed taskDigest metadata', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: {
        taskId: 't1',
        taskTitle: 'Hi',
        status: 'review',
        previousStatus: 'running',
        latestTransition: { from: 'running', to: 'review', by: 'a', at: 'now' },
      },
    };
    const out = readTaskDigestPayload(meta);
    expect(out).not.toBeNull();
    expect(out?.taskId).toBe('t1');
    expect(out?.status).toBe('review');
    expect(out?.latestTransition?.from).toBe('running');
  });

  it('returns null for non-digest system messages', () => {
    expect(readTaskDigestPayload({ kind: 'member_join' })).toBeNull();
    expect(readTaskDigestPayload({ kind: 'task_status_event', taskId: 't' })).toBeNull();
    expect(readTaskDigestPayload(null)).toBeNull();
    expect(readTaskDigestPayload({})).toBeNull();
  });

  it('returns null when digestKind is present but status is invalid', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: { taskId: 't1', status: 'unknown_status' },
    };
    expect(readTaskDigestPayload(meta)).toBeNull();
  });

  it('parses phase / lastStep / lastHeartbeatAt when present', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: {
        taskId: 't1',
        taskTitle: 'Hi',
        status: 'running',
        phase: 'tool_use',
        lastStep: { toolName: 'wechat-send' },
        lastHeartbeatAt: '2026-05-21T10:30:00.000Z',
      },
    };
    const out = readTaskDigestPayload(meta);
    expect(out?.phase).toBe('tool_use');
    expect(out?.lastStep?.toolName).toBe('wechat-send');
    expect(out?.lastHeartbeatAt).toBe('2026-05-21T10:30:00.000Z');
  });

  it('parses outputPreview when present (back-compat field; no longer rendered inline)', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: {
        taskId: 't1',
        taskTitle: 'Hi',
        status: 'completed',
        outputPreview: '任务输出摘要',
      },
    };
    expect(readTaskDigestPayload(meta)?.outputPreview).toBe('任务输出摘要');
  });

  it('parses resultAssetCount + resultAssets (B-line product-asset chip)', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: {
        taskId: 't1',
        taskTitle: 'Hi',
        status: 'completed',
        resultAssetCount: 2,
        resultAssets: [
          { assetId: 'a1', filename: 'plan.md', mime: 'text/markdown' },
          { assetId: 'a2', filename: 'data.csv', mime: 'text/csv' },
        ],
      },
    };
    const out = readTaskDigestPayload(meta);
    expect(out?.resultAssetCount).toBe(2);
    expect(out?.resultAssets?.length).toBe(2);
    expect(out?.resultAssets?.[0]).toEqual({ assetId: 'a1', filename: 'plan.md', mime: 'text/markdown' });
  });

  it('drops resultAssetCount <= 0 to null + skips malformed asset refs', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: {
        taskId: 't1',
        taskTitle: 'Hi',
        status: 'completed',
        resultAssetCount: 0,
        resultAssets: [{ filename: 'no-id.md' }, { assetId: 'ok' }],
      },
    };
    const out = readTaskDigestPayload(meta);
    expect(out?.resultAssetCount).toBeNull();
    expect(out?.resultAssets).toEqual([{ assetId: 'ok', filename: null, mime: null }]);
  });

  it('drops unknown phase strings to null (forward-compat)', () => {
    const meta = {
      digestKind: 'task_digest',
      taskDigest: { taskId: 't1', taskTitle: 'Hi', status: 'running', phase: 'compiling' },
    };
    expect(readTaskDigestPayload(meta)?.phase).toBeNull();
  });
});
