'use client';

/**
 * Snapshot share modal — release201/08 §9.5, release201/13 §3.3 (S22).
 *
 * Generates a snapshot URL + key pair via POST /api/im/skills/:id/share/snapshot
 * and surfaces them for copy-paste. Used by Lifecycle Publish controls once
 * a skill is in the published state and the reviewer wants to share with a
 * different workspace / org.
 */

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/contexts/i18n-context';
import { createSnapshot } from '../types';

interface SnapshotShareModalProps {
  isDark: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillId: string | null;
}

export function SnapshotShareModal({ isDark, open, onOpenChange, skillId }: SnapshotShareModalProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ url: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!skillId) return;
    setBusy(true);
    setError(null);
    const result = await createSnapshot(skillId, 7);
    setBusy(false);
    if (!result.ok || !result.snapshotUrl || !result.snapshotKey) {
      setError(result.error ?? t('evolution.studio.lifecycle.snapshot.failed'));
      return;
    }
    setSnapshot({ url: result.snapshotUrl, key: result.snapshotKey });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="snapshot-share-modal">
        <DialogHeader>
          <DialogTitle>{t('evolution.studio.lifecycle.snapshot.title')}</DialogTitle>
          <DialogDescription>{t('evolution.studio.lifecycle.snapshot.description')}</DialogDescription>
        </DialogHeader>
        {snapshot ? (
          <div className="space-y-3 text-xs">
            <div>
              <p className={`mb-1 uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.lifecycle.snapshot.url')}
              </p>
              <code
                className={`block break-all rounded-md border p-2 font-mono text-[11px] ${isDark ? 'border-white/[0.06] bg-white/[0.04]' : 'border-zinc-200 bg-zinc-50'}`}
              >
                {snapshot.url}
              </code>
            </div>
            <div>
              <p className={`mb-1 uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t('evolution.studio.lifecycle.snapshot.key')}
              </p>
              <code
                className={`block break-all rounded-md border p-2 font-mono text-[11px] ${isDark ? 'border-white/[0.06] bg-white/[0.04]' : 'border-zinc-200 bg-zinc-50'}`}
              >
                {snapshot.key}
              </code>
            </div>
          </div>
        ) : (
          <p className="text-xs opacity-70">{t('evolution.studio.lifecycle.snapshot.empty')}</p>
        )}
        {error && <p className={`text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          {!snapshot && (
            <Button onClick={() => void generate()} disabled={busy || !skillId}>
              {busy
                ? t('evolution.studio.lifecycle.snapshot.generating')
                : t('evolution.studio.lifecycle.snapshot.generate')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
