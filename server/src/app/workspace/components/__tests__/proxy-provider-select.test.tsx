/**
 * @vitest-environment jsdom
 *
 * 2026-05-30 — smoke coverage for ProxyProviderSelect.
 *
 * Pins:
 *   - both options render with their test-ids so the dialog + pro panel can
 *     deep-link to them
 *   - clicking the deepseek option fires onChange with the enum value
 *     (no `as string` smuggling — the prop signature is the source of truth)
 *   - the active option carries `data-state=checked` (radix radio contract)
 *     so the highlight CSS keys off it consistently
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProxyProviderSelect, type ProxyProvider } from '../proxy-provider-select';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (host) {
    host.remove();
    host = null;
  }
  vi.clearAllMocks();
});

async function mount(value: ProxyProvider, onChange: (v: ProxyProvider) => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ProxyProviderSelect value={value} onChange={onChange} isDark={false} />);
  });
  return { root };
}

describe('ProxyProviderSelect', () => {
  it('renders both newapi + deepseek options with stable test-ids', async () => {
    await mount('newapi', () => {});
    expect(host!.querySelector('[data-testid="proxy-provider-option-newapi"]')).toBeTruthy();
    expect(host!.querySelector('[data-testid="proxy-provider-option-deepseek"]')).toBeTruthy();
  });

  it('marks the active option with data-state=checked', async () => {
    await mount('deepseek', () => {});
    const deepseek = host!.querySelector('[data-testid="proxy-provider-option-deepseek"]');
    const newapi = host!.querySelector('[data-testid="proxy-provider-option-newapi"]');
    expect(deepseek?.getAttribute('data-state')).toBe('checked');
    expect(newapi?.getAttribute('data-state')).toBe('unchecked');
  });

  it('fires onChange with the typed enum value when the user picks deepseek', async () => {
    const onChange = vi.fn();
    await mount('newapi', onChange);
    const deepseek = host!.querySelector(
      '[data-testid="proxy-provider-option-deepseek"]',
    ) as HTMLButtonElement | null;
    expect(deepseek).toBeTruthy();
    await act(async () => {
      deepseek!.click();
    });
    // release202/12 (C1) — onChange now also passes the chain's default model as
    // an optional 2nd arg so custom chains reset the model correctly. The chain
    // id (1st arg) is still the contract this test pins.
    expect(onChange.mock.calls[0][0]).toBe('deepseek');
  });
});
