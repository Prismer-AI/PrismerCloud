/**
 * @vitest-environment jsdom
 *
 * Wave 3 §4.4.8 — ApprovalCard banner + bottom sheet.
 *
 * Behaviour under test:
 *   - default state renders a 32px banner (no per-row UI visible)
 *   - clicking the banner opens the bottom sheet
 *   - urgency labels are colour-coded by minutes-left
 *   - dedup hint shows on follower rows when intentHash matches
 *   - approve / reject go through the two-stage confirm row
 *   - "Approve all similar" fires decideApproval for every duplicate
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../approval-card';

vi.mock('../../lib/mutations', () => ({
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
}));

import { decideApproval, listApprovals } from '../../lib/mutations';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXED_NOW = Date.parse('2026-05-21T12:00:00.000Z');

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    taskId: null,
    requestedById: 'agent-1',
    requestedByName: 'Agent',
    category: 'deploy',
    title: 'Default approval',
    context: null,
    options: [
      { value: 'approve', label: 'Approve' },
      { value: 'reject', label: 'Reject' },
    ],
    status: 'pending',
    selectedValue: null,
    metadata: {},
    createdAt: '2026-05-21T11:50:00.000Z',
    decidedAt: null,
    expiresAt: null,
    intentHash: null,
    ...overrides,
  };
}

async function mount(approvals: ReturnType<typeof approval>[]) {
  vi.mocked(listApprovals).mockResolvedValue({ ok: true, data: approvals } as Awaited<
    ReturnType<typeof listApprovals>
  >);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const notify = vi.fn();
  await act(async () => {
    root.render(<ApprovalCard isDark={false} workspaceId="ws-1" conversationId="conv-1" notify={notify} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    notify,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ApprovalCard — banner default state', () => {
  it('renders the collapsed banner and hides per-row controls', async () => {
    const { host, cleanup } = await mount([
      approval({
        id: 'a-1',
        title: 'First',
        expiresAt: new Date(FIXED_NOW + 12 * 60_000).toISOString(),
      }),
      approval({ id: 'a-2', title: 'Second' }),
    ]);

    const banner = host.querySelector('[data-testid="approval-card-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.getAttribute('data-approval-count')).toBe('2');
    expect(host.textContent).toContain('2 approvals waiting');
    expect(host.textContent).toContain('expires in 12m');
    // Sheet should NOT be in the DOM yet.
    expect(host.querySelector('[data-testid="approval-sheet"]')).toBeNull();
    expect(host.querySelector('[data-testid="approval-row-a-1"]')).toBeNull();
    await cleanup();
  });

  it('renders nothing when there are no approvals', async () => {
    const { host, cleanup } = await mount([]);
    expect(host.querySelector('[data-testid="approval-card-banner"]')).toBeNull();
    await cleanup();
  });
});

describe('ApprovalCard — expanded sheet', () => {
  it('opens the sheet when banner is clicked and lists rows by urgency', async () => {
    const { host, cleanup } = await mount([
      approval({
        id: 'a-late',
        title: 'Later one',
        expiresAt: new Date(FIXED_NOW + 4 * 60 * 60_000).toISOString(),
      }),
      approval({
        id: 'a-soon',
        title: 'Critical one',
        expiresAt: new Date(FIXED_NOW + 12 * 60_000).toISOString(),
      }),
    ]);
    const banner = host.querySelector('[data-testid="approval-card-banner"]') as HTMLButtonElement;
    await act(async () => {
      banner.click();
    });

    // Sheet is mounted (it lives in a portal-less inline render). We can
    // also verify urgency attributes on each row.
    expect(document.querySelector('[data-testid="approval-sheet"]')).toBeTruthy();
    const critical = document.querySelector('[data-testid="approval-row-a-soon"]');
    const low = document.querySelector('[data-testid="approval-row-a-late"]');
    expect(critical?.getAttribute('data-urgency')).toBe('critical');
    expect(low?.getAttribute('data-urgency')).toBe('medium');
    // Critical row sorted first.
    const rows = Array.from(document.querySelectorAll('[data-testid^="approval-row-"]'));
    expect(rows[0]?.getAttribute('data-testid')).toBe('approval-row-a-soon');
    await cleanup();
  });

  it('approve is a single-click affordance and posts decideApproval immediately', async () => {
    // Bug 2 (2026-05-29) — one intent = one affordance. The legacy
    // [approve, reject] options now map to the 4 hermes-native HITL choices
    // (once / session / always / deny). Each grant choice (e.g. `once`) fires
    // on the first click with NO inline "Confirm?" stage — only `deny`/`reject`
    // arm an inline reason input. Replaces the legacy two-stage approve flow.
    vi.mocked(decideApproval).mockResolvedValue({ ok: true, data: {} } as Awaited<
      ReturnType<typeof decideApproval>
    >);
    const { host, cleanup } = await mount([approval({ id: 'a-x', title: 'Single-click' })]);
    (host.querySelector('[data-testid="approval-card-banner"]') as HTMLButtonElement).click();
    await act(async () => {
      await Promise.resolve();
    });

    const grantBtn = document.querySelector(
      '[data-testid="approval-action-a-x-once"]',
    ) as HTMLButtonElement;
    await act(async () => {
      grantBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // No confirm row was ever inserted — the click went straight through.
    expect(document.querySelector('[data-testid="approval-confirm-a-x"]')).toBeNull();
    expect(decideApproval).toHaveBeenCalledWith('a-x', 'once', undefined);
    await cleanup();
  });

  it('shows dedup hint on follower rows and exposes "Approve all similar"', async () => {
    vi.mocked(decideApproval).mockResolvedValue({ ok: true, data: {} } as Awaited<
      ReturnType<typeof decideApproval>
    >);
    const sharedHash = 'hash-shared-abc';
    const { host, cleanup } = await mount([
      approval({
        id: 'a-1',
        title: 'First similar',
        intentHash: sharedHash,
        expiresAt: new Date(FIXED_NOW + 20 * 60_000).toISOString(),
      }),
      approval({
        id: 'a-2',
        title: 'Second similar',
        intentHash: sharedHash,
        expiresAt: new Date(FIXED_NOW + 50 * 60_000).toISOString(),
      }),
      approval({
        id: 'a-uniq',
        title: 'Unique',
      }),
    ]);
    (host.querySelector('[data-testid="approval-card-banner"]') as HTMLButtonElement).click();
    await act(async () => {
      await Promise.resolve();
    });

    // First similar = canonical (no hint); second = follower (hint).
    expect(document.querySelector('[data-testid="approval-dedup-hint-a-1"]')).toBeNull();
    expect(document.querySelector('[data-testid="approval-dedup-hint-a-2"]')).toBeTruthy();

    // Batch action present + clicking it fires twice (the 2 similar rows).
    const batch = document.querySelector('[data-testid="approval-approve-similar"]') as HTMLButtonElement;
    expect(batch).toBeTruthy();
    expect(batch.textContent).toContain('Approve all similar (2)');
    await act(async () => {
      batch.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(decideApproval).toHaveBeenCalledTimes(2);
    await cleanup();
  });
});
