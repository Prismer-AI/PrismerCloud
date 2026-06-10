/**
 * @vitest-environment jsdom
 *
 * Plate-mode edit wiring. The real Plate DOM is heavy/non-deterministic in
 * jsdom, so we mock platejs/react with a lightweight harness: the editor
 * serializes to a mutable buffer and <Plate> exposes its onValueChange. This
 * lets us simulate a LIVE edit (no blur) and assert the regression fix —
 * editing in Plate mode immediately enables Save and submits the serialized
 * content, instead of staying disabled until the editor loses focus.
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/markdown-renderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md-rendered">{content}</div>,
}));

const plateState = vi.hoisted(() => ({
  serialized: '',
  onValueChange: undefined as undefined | (() => void),
}));

vi.mock('@platejs/markdown', () => ({ MarkdownPlugin: { key: 'markdown' } }));
vi.mock('platejs', () => ({
  BaseParagraphPlugin: { key: 'p' },
  TrailingBlockPlugin: { key: 'trailing' },
}));
vi.mock('platejs/react', () => {
  const ReactMod = require('react');
  return {
    usePlateEditor: () => ({
      getApi: () => ({
        markdown: {
          deserialize: (md: string) => [{ type: 'p', children: [{ text: md }] }],
          serialize: () => plateState.serialized,
        },
      }),
      tf: { setValue: () => {} },
    }),
    Plate: ({ children, onValueChange }: { children: React.ReactNode; onValueChange?: () => void }) => {
      plateState.onValueChange = onValueChange;
      return ReactMod.createElement(ReactMod.Fragment, null, children);
    },
    PlateContent: (props: Record<string, unknown>) =>
      ReactMod.createElement('div', { 'data-testid': 'plate-content', contentEditable: !props.readOnly }),
  };
});

import { PlateMarkdownEditor } from '../plate-markdown-editor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('PlateMarkdownEditor — Plate mode save (live, no blur)', () => {
  afterEach(() => {
    plateState.serialized = '';
    plateState.onValueChange = undefined;
    vi.restoreAllMocks();
  });

  it('enables Save and submits serialized content after editing without blurring', async () => {
    plateState.serialized = '# hello';
    const onSave = vi.fn(async () => {});
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    await act(async () => {
      root.render(<PlateMarkdownEditor markdown="# hello" title="note.md" isDark={false} onSave={onSave} />);
    });
    await flush();

    // switch to Plate mode (the live editor surface)
    const plateBtn = Array.from(rootEl.querySelectorAll('button')).find(
      (b) => b.textContent === 'Plate',
    ) as HTMLButtonElement;
    await act(async () => plateBtn.click());
    await flush();

    // before any edit Save is disabled (draft === baseline)
    const saveBefore = rootEl.querySelector('[data-testid="asset-preview-markdown-save"]') as HTMLButtonElement;
    expect(saveBefore.disabled).toBe(true);

    // simulate a live edit: editor value changes, Plate fires onValueChange.
    // NO blur happens here — this is exactly the regression path.
    plateState.serialized = '# hello edited live';
    await act(async () => {
      plateState.onValueChange?.();
    });
    await flush();

    const saveAfter = rootEl.querySelector('[data-testid="asset-preview-markdown-save"]') as HTMLButtonElement;
    expect(saveAfter.disabled).toBe(false); // dirty without blur

    await act(async () => saveAfter.click());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('# hello edited live');

    await act(async () => root.unmount());
    rootEl.remove();
  });
});
