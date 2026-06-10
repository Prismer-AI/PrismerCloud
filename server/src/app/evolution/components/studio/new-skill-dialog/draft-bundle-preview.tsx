'use client';

/**
 * Right-rail draft package preview + readiness checklist — extracted from
 * new-skill-dialog.tsx in the v2.0.8 A5+A6+A7 hotfix. Tightened from the
 * original aside (smaller column, no sticky positioning) so the dialog
 * fits within max-h-[85vh].
 */

import { CheckCircle2, Circle, FileText, Paperclip, Terminal } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import { type AttachmentDraft, type DraftInputMode } from './helpers';

export function DraftBundlePreview({
  isDark,
  mode,
  draftFileCount,
  hasScript,
  scriptPath,
  attachments,
  readiness,
}: {
  isDark: boolean;
  mode: DraftInputMode;
  draftFileCount: number;
  hasScript: boolean;
  scriptPath: string | null;
  attachments: AttachmentDraft[];
  readiness: Array<{ label: string; done: boolean }>;
}) {
  const { t } = useI18n();
  return (
    <aside
      data-testid="studio-new-skill-bundle"
      className={`h-fit rounded-xl border p-3 ${
        isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50/70'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.newSkill.packageTitle')}
        </span>
        <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('evolution.studio.newSkill.packageCount', { count: draftFileCount })}
        </span>
      </div>
      <div className="mt-2.5 space-y-1.5" data-testid="studio-new-skill-bundle-files">
        <PackageItem
          isDark={isDark}
          icon={FileText}
          title={t('evolution.studio.newSkill.packageSkillMd')}
          detail="SKILL.md"
        />
        <PackageItem
          isDark={isDark}
          icon={FileText}
          title={t('evolution.studio.newSkill.packageManifest')}
          detail="skill.json"
        />
        <PackageItem
          isDark={isDark}
          icon={FileText}
          title={t('evolution.studio.newSkill.packageRequest')}
          detail="authoring/request.json"
        />
        {hasScript && scriptPath && (
          <PackageItem
            isDark={isDark}
            icon={Terminal}
            title={t('evolution.studio.newSkill.packageScript')}
            detail={scriptPath}
          />
        )}
        {attachments.length > 0 && (
          <PackageItem
            isDark={isDark}
            icon={Paperclip}
            title={t('evolution.studio.newSkill.packageAttachments')}
            detail={t('evolution.studio.newSkill.packageAttachmentCount', { count: attachments.length })}
          />
        )}
      </div>
      <div className={`my-2.5 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
      <p className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('evolution.studio.newSkill.readyTitle')}
      </p>
      <div className="mt-1.5 space-y-1.5" data-testid="studio-new-skill-readiness">
        {readiness.map((item) => (
          <div
            key={item.label}
            className={`flex items-start gap-2 text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
          >
            {item.done ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Circle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
            )}
            <span className={item.done ? undefined : isDark ? 'text-zinc-500' : 'text-zinc-500'}>{item.label}</span>
          </div>
        ))}
      </div>
      {!readiness.every((item) => item.done) && (
        <p className={`mt-2.5 text-[11px] leading-relaxed ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
          {t(`evolution.studio.newSkill.missingAction.${mode}`)}
        </p>
      )}
    </aside>
  );
}

function PackageItem({
  isDark,
  icon: Icon,
  title,
  detail,
}: {
  isDark: boolean;
  icon: typeof FileText;
  title: string;
  detail: string;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2 text-xs ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <span className="shrink-0">{title}</span>
      <span className={`truncate font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{detail}</span>
    </div>
  );
}
