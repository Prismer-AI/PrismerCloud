/**
 * @vitest-environment jsdom
 *
 * release201/24 §Phase1b — NewSkillDialog rebuilt as a conversational wizard
 * (Path B). The old static form (mode Tabs, advanced toggle, footer submit)
 * is gone; this verifies the new surface:
 *   - greeting + composer render on open
 *   - sending a turn calls authoringChat and renders the reply + decision cards
 *   - a `ready` turn surfaces the dispatch action, which fires requestAuthoring
 *     and flips into the tracking phase (composer disabled)
 *
 * authoringChat / requestAuthoring / fetch* are mocked so the wizard runs
 * deterministically with no network. createRoot + act (no testing-library).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/contexts/i18n-context';

const mocks = vi.hoisted(() => ({
  authoringChat: vi.fn(),
  requestAuthoring: vi.fn(),
}));

vi.mock('../types', async (importActual) => {
  const actual = await importActual<typeof import('../types')>();
  return {
    ...actual,
    authoringChat: mocks.authoringChat,
    requestAuthoring: mocks.requestAuthoring,
    fetchDrafts: vi.fn(async () => []),
    fetchDraftDetail: vi.fn(async () => null),
    fetchSkillDetail: vi.fn(async () => null),
    fetchEvalRun: vi.fn(async () => null),
  };
});

import { NewSkillDialog } from '../new-skill-dialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MountResult {
  root: Root;
  host: HTMLDivElement;
  onSubmitted: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<MountResult> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onSubmitted = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider>
        <NewSkillDialog open onOpenChange={() => undefined} isDark={false} workspaceId="ws-1" onSubmitted={onSubmitted} />
      </I18nProvider>,
    );
  });
  await flush();
  return {
    root,
    host,
    onSubmitted,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function typeAndSend(text: string) {
  const composer = document.body.querySelector<HTMLTextAreaElement>('[data-testid="wizard-composer"]')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(composer, text);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
}

let current: MountResult | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.authoringChat.mockReset();
  mocks.requestAuthoring.mockReset();
});

afterEach(async () => {
  if (current) {
    await current.cleanup();
    current = null;
  }
});

describe('NewSkillDialog — conversational wizard (release201/24 Phase1b)', () => {
  it('renders a greeting bubble + composer on open', async () => {
    current = await mount();
    const convo = document.body.querySelector('[data-testid="wizard-conversation"]');
    expect(convo).toBeTruthy();
    const assistantBubble = document.body.querySelector('[data-role="assistant"]');
    expect(assistantBubble).toBeTruthy();
    expect(document.body.querySelector('[data-testid="wizard-composer"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="wizard-send"]')).toBeTruthy();
  });

  it('sending a turn calls authoringChat and renders the reply + decision cards', async () => {
    mocks.authoringChat.mockResolvedValue({
      ok: true,
      turn: {
        reply: 'Where does this come from?',
        spec: { slug: 'call-x' },
        decisions: [
          {
            key: 'sourceKind',
            label: 'Where from?',
            options: [{ value: 'doc-url', label: 'API doc / URL' }],
          },
        ],
        ready: false,
      },
    });
    current = await mount();

    await act(async () => typeAndSend('make a skill from https://docs.example.com'));
    const sendBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-send"]')!;
    await act(async () => sendBtn.click());
    await flush();

    expect(mocks.authoringChat).toHaveBeenCalledTimes(1);
    const arg = mocks.authoringChat.mock.calls[0][0];
    expect(arg.messages.some((m: any) => m.content.includes('docs.example.com'))).toBe(true);

    const decisions = document.body.querySelector('[data-testid="wizard-decisions"]');
    expect(decisions).toBeTruthy();
    expect(document.body.querySelector('[data-decision-option="doc-url"]')).toBeTruthy();
    expect(document.body.textContent).toContain('Where does this come from?');
  });

  it('a ready turn surfaces dispatch, which fires requestAuthoring + enters tracking', async () => {
    mocks.authoringChat.mockResolvedValue({
      ok: true,
      turn: {
        reply: 'All set.',
        spec: {
          slug: 'call-example-api',
          name: 'Call Example API',
          triggers: ['call the example api'],
          sourceKind: 'doc-url',
          sourceRefs: ['https://docs.example.com'],
          scope: 'workspace',
          sampleTasks: [{ input: 'fetch', acceptanceCriteria: ['"status":\\s*200'] }],
        },
        decisions: [],
        ready: true,
      },
    });
    mocks.requestAuthoring.mockResolvedValue({ ok: true, taskId: 'task-1', agentId: 'agent-1', agentOnline: true });
    current = await mount();

    await act(async () => typeAndSend('make a skill from the example api'));
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-send"]')!.click());
    await flush();

    const readyBanner = document.body.querySelector('[data-testid="wizard-ready-banner"]');
    expect(readyBanner).toBeTruthy();

    const dispatch = document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-dispatch"]')!;
    await act(async () => dispatch.click());
    await flush();

    expect(mocks.requestAuthoring).toHaveBeenCalledTimes(1);
    const dispatchArg = mocks.requestAuthoring.mock.calls[0][0];
    expect(dispatchArg.spec.slug).toBe('call-example-api');
    expect(dispatchArg.sourceKind).toBe('doc-url');
    expect(current.onSubmitted).toHaveBeenCalledWith({ taskId: 'task-1', agentId: 'agent-1', agentOnline: true });

    // tracking phase: composer disabled, preview switches to tracking
    const composer = document.body.querySelector<HTMLTextAreaElement>('[data-testid="wizard-composer"]')!;
    expect(composer.disabled).toBe(true);
    const preview = document.body.querySelector('[data-testid="wizard-preview"]');
    expect(preview?.getAttribute('data-phase')).toBe('tracking');
  });
});
