'use client';

/**
 * Wave-8 W1 / L2-L3 — task description editor with `#filename` asset
 * autocomplete.
 *
 * Reusable wrapper around the same `<AssetPicker>` already wired into the
 * IM composer. Used in three places (Drawer F2, CardEditPopover, NewTaskDialog)
 * so the glue (mention-state tracking + keyboard interception + URI insertion)
 * lives in a single component instead of being copy-pasted three times.
 *
 * Contract:
 *   - Caller passes `value` / `onChange` like a regular textarea (this is
 *     intentionally controlled — drawer / dialog already own the local edit
 *     state and need to drive optimistic UI off it).
 *   - Caller supplies `workspaceId` so the picker can fetch + the URI we
 *     insert is the correct `prismer://workspace/<wsId>/asset/<hash>`.
 *   - Caller can OPT-OUT of the picker by passing `workspaceId={null}` (e.g.
 *     a degenerate state where the task hasn't been attached to a workspace
 *     yet). The component degrades to a plain textarea in that case.
 *   - On Cmd/Ctrl+Enter we call `onSubmit?.()`. Escape closes the picker
 *     first (if open) and otherwise calls `onCancel?.()`. Both handlers
 *     stay optional — NewTaskDialog uses its own footer button instead.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { AssetPicker, type AssetPickerHandle } from './asset-picker';
import { buildAssetMarkdownLink } from '../lib/task-asset-refs';

export interface TaskDescriptionEditorProps {
  isDark: boolean;
  value: string;
  onChange: (next: string) => void;
  /**
   * Workspace context for the picker. `null` disables the picker entirely
   * (the task has no workspace yet — degrade to plain textarea).
   */
  workspaceId: string | null;
  /** Cmd/Ctrl+Enter — usually maps to "Save". Optional. */
  onSubmit?: () => void;
  /** Escape (when picker is closed). Usually maps to "Cancel". Optional. */
  onCancel?: () => void;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  'data-testid'?: string;
  id?: string;
  maxLength?: number;
}

export interface TaskDescriptionEditorHandle {
  focus: () => void;
}

export const TaskDescriptionEditor = forwardRef<
  TaskDescriptionEditorHandle,
  TaskDescriptionEditorProps
>(function TaskDescriptionEditor(props, ref) {
  const {
    isDark,
    value,
    onChange,
    workspaceId,
    onSubmit,
    onCancel,
    disabled,
    rows = 6,
    placeholder,
    className,
    autoFocus,
    id,
    maxLength,
    ...rest
  } = props;
  const testId = (rest as Record<string, unknown>)['data-testid'] as string | undefined;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const assetPickerRef = useRef<AssetPickerHandle | null>(null);
  const [assetFilter, setAssetFilter] = useState<string | null>(null);
  const assetRangeRef = useRef<{ start: number; end: number } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  );

  // Recompute the picker open/close state from the cursor + text. Mirrors
  // the logic in `im-channel.tsx::updateMentionState` — walks backward from
  // the caret until it finds a `#` that's at a word boundary (start of text
  // or preceded by whitespace), and treats everything from there to the
  // caret as the filter token. The token may include filename chars
  // (letters, digits, `.`, `-`, `_`, spaces). Any other character → picker
  // closes.
  const updateAssetState = useCallback(
    (next: string, caret: number) => {
      if (!workspaceId) {
        setAssetFilter(null);
        assetRangeRef.current = null;
        return;
      }
      let i = caret - 1;
      while (i >= 0) {
        const ch = next[i];
        if (ch === '#') {
          const prev = next[i - 1];
          if (i === 0 || prev === ' ' || prev === '\n' || prev === '\t') {
            const token = next.slice(i + 1, caret);
            if (/^[a-zA-Z0-9._\-\s]*$/.test(token)) {
              setAssetFilter(token);
              assetRangeRef.current = { start: i, end: caret };
              return;
            }
          }
          break;
        }
        // Newline closes the picker — `#` autocompletes only inside a single
        // line (otherwise a fragment from a previous line could keep the
        // picker open accidentally).
        if (ch === '\n') break;
        i--;
      }
      setAssetFilter(null);
      assetRangeRef.current = null;
    },
    [workspaceId],
  );

  const onChangeInternal = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      onChange(next);
      updateAssetState(next, e.target.selectionStart ?? next.length);
    },
    [onChange, updateAssetState],
  );

  const onSelectAsset = useCallback(
    (item: { id: string; contentHash: string; filename: string | null }) => {
      if (!workspaceId) return;
      const range = assetRangeRef.current;
      if (!range) return;
      const before = value.slice(0, range.start);
      const after = value.slice(range.end);
      // Markdown-link form: `[filename](prismer://...)`. Adds a trailing
      // space so the user can keep typing without manually separating.
      const insert = `${buildAssetMarkdownLink(workspaceId, item.contentHash, item.filename)} `;
      const next = `${before}${insert}${after}`;
      onChange(next);
      const newCaret = before.length + insert.length;
      // Defer focus + caret placement until React has flushed the new value
      // through to the textarea — otherwise `setSelectionRange` runs on the
      // stale text.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      });
      setAssetFilter(null);
      assetRangeRef.current = null;
    },
    [onChange, value, workspaceId],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Asset-picker keyboard nav — same pattern as im-channel.
      if (assetFilter !== null && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          assetPickerRef.current?.move(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          assetPickerRef.current?.move(-1);
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
          if (assetPickerRef.current?.commit()) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Escape') {
          // Close the picker WITHOUT propagating Escape up — only when no
          // picker is open should Escape trigger onCancel.
          e.preventDefault();
          setAssetFilter(null);
          assetRangeRef.current = null;
          return;
        }
      }
      // Cmd/Ctrl+Enter → submit (when handler provided).
      if (
        onSubmit &&
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey) &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        onSubmit();
        return;
      }
      // Bare Escape → cancel (only when the picker isn't open; that path
      // returned early above).
      if (onCancel && e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
    },
    [assetFilter, onSubmit, onCancel],
  );

  // Keep picker state in sync when the controlled `value` changes from
  // outside (e.g. parent component reset). We can't observe caret changes
  // without focus events, so we just close the picker on prop-driven value
  // changes — the user can re-type `#` to reopen.
  const lastSyncedValueRef = useRef(value);
  useEffect(() => {
    if (lastSyncedValueRef.current !== value && assetFilter !== null) {
      // External value rewrite (not user typing) — close the picker.
      const ta = textareaRef.current;
      if (!ta || document.activeElement !== ta) {
        setAssetFilter(null);
        assetRangeRef.current = null;
      }
    }
    lastSyncedValueRef.current = value;
  }, [value, assetFilter]);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        id={id}
        autoFocus={autoFocus}
        value={value}
        disabled={disabled}
        rows={rows}
        maxLength={maxLength}
        onChange={onChangeInternal}
        onKeyDown={onKeyDown}
        // Track caret moves from arrow keys / clicks so the picker can
        // re-open when the user navigates back into a `#`-prefixed token.
        onSelect={(e) => {
          const target = e.target as HTMLTextAreaElement;
          updateAssetState(target.value, target.selectionStart ?? target.value.length);
        }}
        placeholder={placeholder}
        data-testid={testId}
        className={className}
      />
      {assetFilter !== null && workspaceId ? (
        <AssetPicker
          ref={assetPickerRef}
          isDark={isDark}
          workspaceId={workspaceId}
          filter={assetFilter}
          onSelect={onSelectAsset}
          onClose={() => {
            setAssetFilter(null);
            assetRangeRef.current = null;
          }}
        />
      ) : null}
    </div>
  );
});
