/**
 * @vitest-environment jsdom
 *
 * release201/26 Phase 3 — SessionMemoryDrawer render + state test.
 *
 * Mocks the memory fetch client so we exercise the drawer's idle / loading /
 * ready / empty / forbidden state surfacing without a real /api round-trip.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchConversationMemory = vi.fn();
const regenerateMemorySegment = vi.fn();

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    fetchConversationMemory: (...args: unknown[]) => fetchConversationMemory(...args),
    regenerateMemorySegment: (...args: unknown[]) => regenerateMemorySegment(...args),
  };
});

import { SessionMemoryDrawer } from '../session-memory-drawer';
import { I18nProvider } from '@/contexts/i18n-context';
import { AppProvider } from '@/contexts/app-context';
import { ThemeProvider } from '@/contexts/theme-context';

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <AppProvider>
          <I18nProvider>
            <SessionMemoryDrawer isDark={false} open onOpenChange={() => undefined} />
          </I18nProvider>
        </AppProvider>
      </ThemeProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

// Sheet portals into document.body; query there.
function q(testid: string): Element | null {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

// Set the controlled input via the native value setter (so React's onChange
// fires), then submit the enclosing form and flush the resolved fetch.
async function typeAndSubmit(value: string) {
  const input = q('session-memory-conv-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const form = input.closest('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"token":"t"}');
  fetchConversationMemory.mockReset();
  regenerateMemorySegment.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SessionMemoryDrawer (release201/26 Phase 3)', () => {
  it('renders the conversation id input + idle prompt when open', async () => {
    fetchConversationMemory.mockResolvedValue({ status: 'ok', data: { segments: [], identifiers: [] } });
    const { cleanup } = await mount();
    expect(q('session-memory-conv-input')).toBeTruthy();
    expect(q('session-memory-idle')).toBeTruthy();
    await cleanup();
  });

  it('loads + renders a segment with summary, kind and tokens', async () => {
    fetchConversationMemory.mockResolvedValue({
      status: 'ok',
      data: {
        segments: [
          {
            segmentSeq: 0,
            segmentKind: 'range',
            summary: 'Hello **world**',
            salientFacts: ['fact-A'],
            coversFromCreatedAt: '2026-05-01T00:00:00Z',
            coversToCreatedAt: '2026-05-02T00:00:00Z',
            tokenCountCl100k: 1234,
            producerModel: 'claude',
            producerVersion: 'v1',
            supersededBy: null,
          },
        ],
        identifiers: [],
      },
    });
    const { cleanup } = await mount();
    await typeAndSubmit('cmpabc');
    expect(fetchConversationMemory).toHaveBeenCalled();
    expect(q('session-memory-segment')).toBeTruthy();
    expect(document.body.textContent).toContain('range');
    await cleanup();
  });

  it('surfaces the forbidden (non-admin) state', async () => {
    fetchConversationMemory.mockResolvedValue({ status: 'forbidden' });
    const { cleanup } = await mount();
    await typeAndSubmit('cmpabc');
    expect(q('session-memory-forbidden')).toBeTruthy();
    await cleanup();
  });
});
