'use client';

/**
 * RenameSessionDialog — replaces the old `window.prompt` rename path.
 *
 * Wave-8 W4 audit S11: free-typing into a native browser prompt is jarring,
 * doesn't theme with the rest of the workspace surface, and skips trim/empty
 * validation. This dialog gives the same single-input shape but is themed,
 * disables submit on empty/no-change, and surfaces server-side errors inline.
 */

import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { renameConversation } from '../lib/mutations';

interface RenameSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** Current title — used as the input's default + dirty check. */
  currentTitle: string;
  onRenamed: (nextTitle: string) => void;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
}

export function RenameSessionDialog({
  open,
  onOpenChange,
  conversationId,
  currentTitle,
  onRenamed,
  isDark,
  notify,
}: RenameSessionDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(currentTitle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) {
      setValue(currentTitle);
      setError(null);
      setSubmitting(false);
    }
  }, [open, currentTitle]);

  const trimmed = value.trim();
  const canSubmit = !submitting && trimmed.length > 0 && trimmed !== currentTitle.trim();

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const res = await renameConversation(conversationId, trimmed);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      notify(t('workspace.renameSession.failed', { message: res.message }), 'error');
      return;
    }
    notify(t('workspace.renameSession.success', { title: trimmed }), 'success');
    onRenamed(trimmed);
    onOpenChange(false);
  }

  const inputClass = `w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-1 ${
    isDark
      ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
      : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400'
  }`;
  const labelClass = `text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workspace.renameSession.title')}</DialogTitle>
        </DialogHeader>
        <label className="grid gap-1" htmlFor={inputId}>
          <span className={labelClass}>{t('workspace.renameSession.fieldTitle')}</span>
          <input
            id={inputId}
            data-testid="rename-session-input"
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder={t('workspace.renameSession.placeholder')}
            maxLength={120}
            autoFocus
          />
        </label>
        {error ? (
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="rename-session-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {t('workspace.renameSession.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
