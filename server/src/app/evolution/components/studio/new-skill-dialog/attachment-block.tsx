'use client';

/**
 * Compact attachment uploader — extracted from new-skill-dialog.tsx during
 * the v2.0.8 A5+A6+A7 UX hotfix. Keeps the chip-style pills the original used
 * (we only own the file body, not the picker visuals).
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Paperclip, UploadCloud, X } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { type AttachmentDraft, formatBytes } from './helpers';

const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 } as const;

export function AttachmentBlock({
  isDark,
  labelClass,
  attachments,
  onFiles,
  onRemove,
  prominent = false,
}: {
  isDark: boolean;
  labelClass: string;
  attachments: AttachmentDraft[];
  onFiles: (files: FileList | null) => void | Promise<void>;
  onRemove: (index: number) => void;
  prominent?: boolean;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);

  // release201/24 §UX — real drag & drop. The whole block is a dropzone; in
  // `prominent` (doc) mode it renders as a big dashed drop target.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) void onFiles(e.dataTransfer.files);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };

  const dropBorder = dragging
    ? isDark
      ? 'border-violet-400/70 bg-violet-500/[0.08]'
      : 'border-violet-400 bg-violet-50'
    : isDark
      ? 'border-white/[0.08] bg-white/[0.03] hover:border-white/[0.16]'
      : 'border-zinc-300 bg-zinc-50/70 hover:border-zinc-400';

  return (
    <div
      data-testid="studio-new-skill-attachments"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={prominent ? 'rounded-xl' : undefined}
    >
      <span className={labelClass}>{t('evolution.studio.newSkill.attachmentsLabel')}</span>
      {/* dropzone */}
      <label
        data-testid="studio-new-skill-dropzone"
        data-dragging={dragging ? '1' : '0'}
        className={`mt-1 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 text-center transition-colors ${dropBorder} ${
          prominent ? 'py-7' : 'py-4'
        }`}
      >
        <UploadCloud
          className={`h-5 w-5 ${dragging ? (isDark ? 'text-violet-300' : 'text-violet-600') : isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
        />
        <span className={`text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {dragging ? t('evolution.studio.newSkill.dropActive') : t('evolution.studio.newSkill.dropHere')}
        </span>
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void onFiles(e.target.files);
            e.currentTarget.value = '';
          }}
        />
      </label>
      {attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <motion.span
              key={`${attachment.name}-${index}`}
              layout
              initial={{ opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={SPRING}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-700'
              }`}
            >
              <Paperclip className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{attachment.name}</span>
              <span className="shrink-0 opacity-50">{formatBytes(attachment.size)}</span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={t('evolution.studio.newSkill.removeAttachment')}
                className="rounded-full opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </motion.span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
