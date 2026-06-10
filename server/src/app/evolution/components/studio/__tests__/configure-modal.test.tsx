/**
 * @vitest-environment jsdom
 *
 * S22 — Configure modal dynamic form.
 *
 * Verifies that the modal:
 *   1. Fetches the skill detail when opened,
 *   2. Renders one form field per `executableJson.configSchema.properties` entry,
 *   3. PATCHes the agent-skill config endpoint on Save.
 *
 * Mocks `fetchSkillDetail` + `updateAgentSkillConfig`; no real HTTP.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return {
    ...actual,
    fetchSkillDetail: vi.fn(),
    updateAgentSkillConfig: vi.fn(),
  };
});

import { fetchSkillDetail, updateAgentSkillConfig } from '../types';
import { ConfigureModal } from '../lifecycle/configure-modal';
import { I18nProvider } from '@/contexts/i18n-context';

async function mount(opts: { open: boolean; initialConfig?: Record<string, unknown>; onSaved?: () => void }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <I18nProvider>
        <ConfigureModal
          isDark={false}
          open={opts.open}
          onOpenChange={onOpenChange}
          agentId="agent-1"
          skillId="skill-1"
          skillName="Test skill"
          initialConfig={opts.initialConfig}
          onSaved={opts.onSaved}
        />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    onOpenChange,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  vi.mocked(fetchSkillDetail).mockResolvedValue({
    id: 'skill-1',
    slug: 'test-skill',
    name: 'Test skill',
    description: 'Test',
    executableJson: {
      configSchema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', description: 'API key' },
          maxRetries: { type: 'number', default: 3 },
          enabled: { type: 'boolean', default: true },
          mode: { type: 'string', enum: ['fast', 'safe', 'thorough'] },
        },
        required: ['apiKey'],
      },
    },
  });
  vi.mocked(updateAgentSkillConfig).mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// Dialog content renders into a portal on document.body, not into `host`.
// All queries target document.body so they catch the portalled content.
async function waitForSkillFetch() {
  // Two microtask flushes covers fetchSkillDetail resolution + useState commit.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ConfigureModal — dynamic form (S22)', () => {
  it('renders one input per configSchema property', async () => {
    const { cleanup } = await mount({ open: true, initialConfig: { apiKey: 'k' } });
    await waitForSkillFetch();
    const form = document.body.querySelector('[data-testid="configure-modal-form"]');
    expect(form).toBeTruthy();
    expect(document.body.querySelector('[data-testid="configure-field-apiKey"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="configure-field-maxRetries"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="configure-field-enabled"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="configure-field-mode"]')).toBeTruthy();
    await cleanup();
  });

  it('falls back to a raw JSON textarea when no configSchema is present', async () => {
    vi.mocked(fetchSkillDetail).mockResolvedValueOnce({
      id: 'skill-1',
      slug: 'test-skill',
      name: 'Test skill',
      description: 'Test',
      executableJson: {},
    });
    const { cleanup } = await mount({ open: true });
    await waitForSkillFetch();
    expect(document.body.querySelector('[data-testid="configure-modal-raw-json"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="configure-modal-form"]')).toBeNull();
    await cleanup();
  });

  it('Save calls updateAgentSkillConfig with edited values', async () => {
    const onSaved = vi.fn();
    const { cleanup } = await mount({
      open: true,
      initialConfig: { apiKey: 'old-key', maxRetries: 3, enabled: true, mode: 'fast' },
      onSaved,
    });
    await waitForSkillFetch();
    const apiKeyInput = document.body.querySelector('[data-testid="configure-field-apiKey"]') as HTMLInputElement;
    expect(apiKeyInput).toBeTruthy();
    await act(async () => {
      // React tracks the previous value via a hidden property on the input;
      // assigning via the native HTMLInputElement.prototype setter clears it
      // so the next input event fires React's onChange synthetic handler.
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(apiKeyInput, 'new-key');
      apiKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = document.body.querySelector('[data-testid="configure-modal-save"]') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateAgentSkillConfig).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(updateAgentSkillConfig).mock.calls[0];
    expect(callArgs[0]).toBe('agent-1'); // agentId
    expect(callArgs[1]).toBe('skill-1'); // skillId
    expect(callArgs[2]).toMatchObject({ apiKey: 'new-key' });
    expect(onSaved).toHaveBeenCalled();
    await cleanup();
  });
});
