'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownPlugin } from '@platejs/markdown';
import { BaseParagraphPlugin, TrailingBlockPlugin, type Value } from 'platejs';
import { Plate, PlateContent, usePlateEditor } from 'platejs/react';
import { Check, FileText, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import MarkdownRenderer from '@/components/ui/markdown-renderer';

const EMPTY_VALUE: Value = [{ type: 'p', children: [{ text: '' }] }];

type Mode = 'plate' | 'rendered' | 'raw';

export interface PlateMarkdownEditorProps {
  markdown: string;
  title: string;
  isDark: boolean;
  /**
   * When provided, the editor becomes savable: Plate + Raw modes accept edits
   * and a Save affordance writes the current content back via this callback
   * (which persists a new asset revision). Resolve with the canonical saved
   * markdown so the baseline can re-sync. When omitted the component is the
   * previous read-only renderer (chat attachments, synthetic AssetDTOs, etc.).
   */
  onSave?: (content: string) => Promise<void>;
}

export function PlateMarkdownEditor({ markdown, title, isDark, onSave }: PlateMarkdownEditorProps) {
  const editable = typeof onSave === 'function';
  const [failed, setFailed] = useState<string | null>(null);
  // 2026-05-20 — default to `rendered` (preview) mode, not `plate` (editor).
  // Asset viewer is opened from chat attachments + library list; the user's
  // first intent is "see what's in this file", not "edit it". The Plate
  // editor is one toolbar click away when needed.
  const [mode, setMode] = useState<Mode>('rendered');
  // Edit buffer. `draft` mirrors the latest content the user is editing;
  // `baseline` is the last-persisted markdown — dirty = draft !== baseline.
  const [draft, setDraft] = useState(markdown);
  const [baseline, setBaseline] = useState(markdown);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const editor = usePlateEditor({
    plugins: [BaseParagraphPlugin, MarkdownPlugin, TrailingBlockPlugin],
    value: EMPTY_VALUE,
  });

  // When the upstream markdown prop changes (new asset / refetch after save),
  // reset both draft and baseline so we never resurrect a stale buffer.
  useEffect(() => {
    setDraft(markdown);
    setBaseline(markdown);
    setSaveError(null);
  }, [markdown]);

  const editorKey = useMemo(() => `${title}:${baseline.length}`, [baseline.length, title]);

  useEffect(() => {
    let cancelled = false;
    let nextFailed: string | null = null;
    try {
      const nodes = editor.getApi(MarkdownPlugin).markdown.deserialize(baseline);
      editor.tf.setValue(Array.isArray(nodes) && nodes.length > 0 ? nodes : EMPTY_VALUE);
    } catch (err) {
      nextFailed = err instanceof Error ? err.message : 'Plate markdown editor failed.';
    }
    queueMicrotask(() => {
      if (!cancelled) setFailed(nextFailed);
    });
    return () => {
      cancelled = true;
    };
  }, [editor, baseline]);

  const serializePlate = useCallback((): string => {
    try {
      return editor.getApi(MarkdownPlugin).markdown.serialize();
    } catch {
      return draft;
    }
  }, [editor, draft]);

  const isDirty = editable && draft !== baseline;

  const handleSave = useCallback(async () => {
    if (!onSave || saving) return;
    // In Plate mode the source of truth is the editor; serialize fresh.
    const content = mode === 'plate' && !failed ? serializePlate() : draft;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(content);
      // Optimistic local sync — caller will also re-feed `markdown`, but
      // settle immediately so the dirty state clears without a flash.
      setBaseline(content);
      setDraft(content);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [onSave, saving, mode, failed, serializePlate, draft]);

  const header = (
    <MarkdownPreviewHeader
      title={title}
      isDark={isDark}
      mode={failed ? 'rendered' : mode}
      onModeChange={setMode}
      failed={failed}
      editable={editable}
      isDirty={isDirty}
      saving={saving}
      saveError={saveError}
      justSaved={justSaved}
      onSave={handleSave}
    />
  );

  if (failed || mode === 'rendered') {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-markdown-rendered">
        {header}
        <div
          className={`min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}
        >
          <MarkdownRenderer content={isDirty ? draft : baseline} />
        </div>
      </div>
    );
  }

  if (mode === 'raw') {
    if (editable) {
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-markdown-raw">
          {header}
          <textarea
            data-testid="asset-preview-markdown-raw-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className={`min-h-0 flex-1 resize-none overflow-auto p-4 font-mono text-sm leading-relaxed outline-none ${
              isDark
                ? 'bg-zinc-950 text-zinc-200 caret-violet-200'
                : 'bg-white text-zinc-800 caret-violet-700'
            }`}
            placeholder="Edit markdown"
          />
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-markdown-raw">
        {header}
        <pre className={`min-h-0 flex-1 overflow-auto p-4 text-sm ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {baseline}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-plate-markdown">
      {header}
      <div
        className={`min-h-0 flex-1 overflow-auto ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-zinc-900'}`}
      >
        <Plate
          key={editorKey}
          editor={editor}
          // Sync `draft` on every edit (serialize is cheap markdown), not just
          // onBlur — otherwise `isDirty` lags and Save stays disabled until the
          // editor loses focus ("first Save click does nothing").
          onValueChange={editable ? () => setDraft(serializePlate()) : undefined}
        >
          <PlateContent
            readOnly={!editable}
            onBlur={editable ? () => setDraft(serializePlate()) : undefined}
            className={`mx-auto min-h-full w-full max-w-3xl px-6 py-5 text-sm leading-7 outline-none ${
              isDark ? 'caret-violet-200' : 'caret-violet-700'
            }`}
            placeholder={editable ? 'Edit markdown' : 'Markdown'}
          />
        </Plate>
      </div>
    </div>
  );
}

function MarkdownPreviewHeader({
  title,
  isDark,
  mode,
  failed,
  onModeChange,
  editable,
  isDirty,
  saving,
  saveError,
  justSaved,
  onSave,
}: {
  title: string;
  isDark: boolean;
  mode: Mode;
  failed: string | null;
  onModeChange: (mode: Mode) => void;
  editable: boolean;
  isDirty: boolean;
  saving: boolean;
  saveError: string | null;
  justSaved: boolean;
  onSave: () => void;
}) {
  const modes: Array<{ id: Mode; label: string }> = [
    { id: 'plate', label: 'Plate' },
    { id: 'rendered', label: 'Preview' },
    { id: 'raw', label: 'Raw' },
  ];
  const statusLabel = saveError
    ? `Save failed: ${saveError}`
    : failed
      ? `Plate fallback: ${failed}`
      : isDirty
        ? 'Unsaved changes'
        : justSaved
          ? 'Saved'
          : 'Markdown';
  return (
    <div
      className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
    >
      <div className="min-w-0">
        <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</p>
        <p
          className={`flex items-center gap-1 text-[11px] ${
            saveError || failed
              ? 'text-amber-500'
              : isDirty
                ? isDark
                  ? 'text-violet-300'
                  : 'text-violet-600'
                : 'text-zinc-500'
          }`}
        >
          {justSaved && !isDirty && !saveError ? <Check className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
          {statusLabel}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className={`flex rounded-md border p-0.5 ${isDark ? 'border-white/[0.08]' : 'border-zinc-200'}`}>
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onModeChange(item.id)}
              disabled={Boolean(failed && item.id === 'plate')}
              className={`rounded px-2 py-1 text-xs font-medium ${
                mode === item.id
                  ? isDark
                    ? 'bg-white/[0.12] text-zinc-100'
                    : 'bg-zinc-900 text-white'
                  : isDark
                    ? 'text-zinc-500 hover:text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {editable ? (
          <Button
            type="button"
            size="sm"
            variant={isDirty ? 'default' : 'outline'}
            disabled={saving || (!isDirty && !saveError)}
            onClick={onSave}
            data-testid="asset-preview-markdown-save"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? 'Saving' : saveError ? 'Retry' : 'Save'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
