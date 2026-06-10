/**
 * @vitest-environment jsdom
 *
 * release202/08 Phase 2 — NewTaskDialog "进度/产物发送到" (delivery target)
 * selector tests.
 *
 * The fix this guards: a manually-created kanban card has NO originating
 * chat, so the dialog must NOT silently inherit the (often group)
 * conversation that happens to be open. The default delivery target is
 * always `kanban` → createTask receives `conversationId: undefined`, even
 * when a `conversationId` prop is passed in.
 *
 * Coverage:
 *   - default kanban → createTask.conversationId === undefined (core fix)
 *   - explicit `conversation` → createTask.conversationId === prop
 *   - explicit `dm` → createDirectConversation(assigneeId, workspaceId)
 *       called, its data.id flows into createTask.conversationId
 *   - `dm` soft fallback: createDirectConversation {ok:false} → task still
 *       created with conversationId === undefined
 *   - option availability: no conversationId prop → no `conversation`
 *       option; no assignee → no `dm` option
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/mutations', () => ({
  createTask: vi.fn(),
  createDirectConversation: vi.fn(),
}));

// TaskDescriptionEditor pulls AssetPicker, which fetches the workspace asset
// list on focus. Stub the IM fetch helper so nothing hits the network and the
// (best-effort) criteria POST path is inert.
vi.mock('../../lib/im-api', () => ({
  imFetch: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
}));

import { NewTaskDialog } from '../new-task-dialog';
import { createTask, createDirectConversation } from '../../lib/mutations';
import type { AgentDTO, AgentProfileDTO } from '../../lib/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Dialog (focus-trap + dismissable layer) probes a few DOM APIs that
// jsdom doesn't implement. Polyfill them so the content mounts cleanly.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const AGENT: AgentDTO = {
  agentId: 'agentcard_1',
  userId: 'agent_user_1',
  name: 'Codex',
  username: 'codex-abc',
  agentType: 'code',
  capabilities: ['code'],
};

const PROFILES: AgentProfileDTO[] = [];

interface MountOpts {
  conversationId?: string;
  defaultAssigneeId?: string;
  agents?: AgentDTO[];
}

function defaultMutationResults() {
  vi.mocked(createTask).mockResolvedValue({
    ok: true,
    status: 200,
    data: { id: 'task_new' },
  } as unknown as Awaited<ReturnType<typeof createTask>>);
  vi.mocked(createDirectConversation).mockResolvedValue({
    ok: true,
    status: 200,
    data: { id: 'dm_conv_1' },
  } as unknown as Awaited<ReturnType<typeof createDirectConversation>>);
}

async function mount(opts: MountOpts = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NewTaskDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws_1"
        agents={opts.agents ?? [AGENT]}
        profiles={PROFILES}
        defaultAssigneeId={opts.defaultAssigneeId}
        conversationId={opts.conversationId}
        onCreated={() => {}}
        isDark={false}
        notify={() => {}}
      />,
    );
  });
  return { container, root };
}

function deliverySelect(): HTMLSelectElement {
  const el = document.querySelector('[data-testid="new-task-delivery"]') as HTMLSelectElement | null;
  if (!el) throw new Error('delivery select not found');
  return el;
}

/** Drive a controlled <select> the way React expects (native value setter + change event). */
async function setSelectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function setTitle(value: string) {
  const input = document.querySelector('[data-testid="new-task-title"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit() {
  const btn = document.querySelector('[data-testid="new-task-submit"]') as HTMLButtonElement;
  await act(async () => {
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function lastCreateTaskArg() {
  const calls = vi.mocked(createTask).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

let unmount: (() => Promise<void>) | null = null;

async function trackMount(opts: MountOpts = {}) {
  const { container, root } = await mount(opts);
  unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { container, root };
}

describe('NewTaskDialog — delivery target (release202/08 Phase 2)', () => {
  beforeEach(() => {
    vi.mocked(createTask).mockReset();
    vi.mocked(createDirectConversation).mockReset();
    defaultMutationResults();
  });

  afterEach(async () => {
    if (unmount) {
      await unmount();
      unmount = null;
    }
    vi.clearAllMocks();
  });

  it('defaults to kanban → createTask receives conversationId=undefined even with a conversationId prop (the core fix)', async () => {
    await trackMount({ conversationId: 'conv_group_1', defaultAssigneeId: AGENT.userId });
    expect(deliverySelect().value).toBe('kanban');

    await setTitle('Summarize last 24h');
    await submit();

    expect(createDirectConversation).not.toHaveBeenCalled();
    const arg = lastCreateTaskArg();
    expect(arg.conversationId).toBeUndefined();
    // No linked-conversation metadata leak either.
    const meta = arg.metadata as Record<string, unknown> | undefined;
    expect(meta?.context).toBeUndefined();
  });

  it('explicit "conversation" target → createTask receives the conversationId prop', async () => {
    await trackMount({ conversationId: 'conv_group_1', defaultAssigneeId: AGENT.userId });

    await setSelectValue(deliverySelect(), 'conversation');
    await setTitle('Post into this channel');
    await submit();

    expect(createDirectConversation).not.toHaveBeenCalled();
    expect(lastCreateTaskArg().conversationId).toBe('conv_group_1');
  });

  it('explicit "dm" target → createDirectConversation(assigneeId, workspaceId) called; its data.id flows into createTask', async () => {
    await trackMount({ defaultAssigneeId: AGENT.userId });

    await setSelectValue(deliverySelect(), 'dm');
    await setTitle('DM the agent');
    await submit();

    expect(createDirectConversation).toHaveBeenCalledWith(AGENT.userId, 'ws_1');
    expect(lastCreateTaskArg().conversationId).toBe('dm_conv_1');
  });

  it('"dm" soft fallback → createDirectConversation {ok:false} still creates the task with conversationId=undefined', async () => {
    vi.mocked(createDirectConversation).mockResolvedValue({
      ok: false,
      status: 500,
      message: 'dm create failed',
    } as Awaited<ReturnType<typeof createDirectConversation>>);
    await trackMount({ defaultAssigneeId: AGENT.userId });

    await setSelectValue(deliverySelect(), 'dm');
    await setTitle('DM fallback to board');
    await submit();

    expect(createDirectConversation).toHaveBeenCalledWith(AGENT.userId, 'ws_1');
    // Task is still created (not failed) and lives board-only.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(lastCreateTaskArg().conversationId).toBeUndefined();
  });

  it('option availability: no conversationId prop → "conversation" option is not rendered', async () => {
    await trackMount({ defaultAssigneeId: AGENT.userId });
    const options = Array.from(deliverySelect().querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('kanban');
    expect(options).not.toContain('conversation');
    // dm is present because an assignee is set.
    expect(options).toContain('dm');
  });

  it('option availability: no assignee → "dm" option is not rendered', async () => {
    // initialColumn defaults to non-backlog so an assignee would normally be
    // chosen; pass an empty agent list + no default so assigneeId stays ''.
    await trackMount({ conversationId: 'conv_group_1', agents: [], defaultAssigneeId: '' });
    const options = Array.from(deliverySelect().querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('kanban');
    expect(options).toContain('conversation');
    expect(options).not.toContain('dm');
  });
});
