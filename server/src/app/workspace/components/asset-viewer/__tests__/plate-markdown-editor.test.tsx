/**
 * @vitest-environment jsdom
 *
 * Editable markdown asset: the Save affordance writes the current buffer
 * back through onSave (which the asset-max-preview wires to
 * POST /api/im/assets/:id/revisions). We drive the Raw-mode textarea path —
 * it's the deterministic edit surface (Plate's DOM is heavy in jsdom).
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// MarkdownRenderer pulls in ThemeProvider context; it isn't under test here.
vi.mock('@/components/ui/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md-rendered">{content}</div>,
}));

import { PlateMarkdownEditor } from '../plate-markdown-editor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('PlateMarkdownEditor save', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is read-only when no onSave is provided (no Save button)', async () => {
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);
    await act(async () => {
      root.render(<PlateMarkdownEditor markdown="# hello" title="note.md" isDark={false} />);
    });
    await flush();
    expect(rootEl.querySelector('[data-testid="asset-preview-markdown-save"]')).toBeNull();
    await act(async () => root.unmount());
    rootEl.remove();
  });

  it('edits in raw mode and calls onSave with the new content', async () => {
    const onSave = vi.fn(async () => {});
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(<PlateMarkdownEditor markdown="# hello" title="note.md" isDark={false} onSave={onSave} />);
    });
    await flush();

    // switch to Raw mode (the editable textarea surface)
    const rawBtn = Array.from(rootEl.querySelectorAll('button')).find((b) => b.textContent === 'Raw') as HTMLButtonElement;
    await act(async () => rawBtn.click());

    const textarea = rootEl.querySelector('[data-testid="asset-preview-markdown-raw-input"]') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('# hello');

    await act(async () => {
      setTextareaValue(textarea, '# hello edited');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = rootEl.querySelector('[data-testid="asset-preview-markdown-save"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false); // dirty enables save
    await act(async () => saveBtn.click());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('# hello edited');

    await act(async () => root.unmount());
    rootEl.remove();
  });

  it('surfaces a save error and offers retry', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('HTTP 503');
    });
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(<PlateMarkdownEditor markdown="body" title="note.md" isDark={false} onSave={onSave} />);
    });
    await flush();

    const rawBtn = Array.from(rootEl.querySelectorAll('button')).find((b) => b.textContent === 'Raw') as HTMLButtonElement;
    await act(async () => rawBtn.click());
    const textarea = rootEl.querySelector('[data-testid="asset-preview-markdown-raw-input"]') as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(textarea, 'body!');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveBtn = rootEl.querySelector('[data-testid="asset-preview-markdown-save"]') as HTMLButtonElement;
    await act(async () => saveBtn.click());
    await flush();

    expect(rootEl.textContent).toContain('Save failed: HTTP 503');
    const retryBtn = rootEl.querySelector('[data-testid="asset-preview-markdown-save"]') as HTMLButtonElement;
    expect(retryBtn.textContent).toContain('Retry');

    await act(async () => root.unmount());
    rootEl.remove();
  });
});
