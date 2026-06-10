'use client';

/**
 * Templates — private-template editor (right Sheet, editable).
 *
 * A forked private template lives in localStorage and IS editable here: name,
 * description, required-skills, MCP servers and operating principles. Skills /
 * MCP / principles are edited as newline- (or comma-) separated lists — robust,
 * markdown-friendly, no nested form widgets (matches the "markdown over JSON"
 * memory). Save writes back through `updatePrivateTemplate`.
 *
 * Apply is **honestly gated**: there is no server path to apply a custom
 * (non-curated) template — `/role_templates/:slug/apply` only resolves real
 * catalogue slugs — so the Apply control is disabled with a "待后端支持" hint.
 * We never fake-apply.
 *
 * Indigo atelier accent. ui/sheet + ui/alert-dialog (0 direct @radix).
 */

import { useEffect, useState } from 'react';
import { Info, Save, Stamp, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { s } from '@/app/workspace/lib/design';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';

import type { PrivateTemplate, PrivateTemplatePatch } from './private-store';

interface PrivateEditorProps {
  template: PrivateTemplate | null;
  isDark: boolean;
  theme: 'dark' | 'light';
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, patch: PrivateTemplatePatch) => void;
  onRemove: (id: string) => void;
}

/** newline/comma separated text → trimmed list. */
function toList(text: string): string[] {
  return text
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function PrivateEditor({
  template,
  isDark,
  theme,
  onOpenChange,
  onSave,
  onRemove,
}: PrivateEditorProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [skills, setSkills] = useState('');
  const [mcp, setMcp] = useState('');
  const [principles, setPrinciples] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Re-seed the form whenever a different private template is opened.
  useEffect(() => {
    if (!template) return;
    setName(template.name);
    setDescription(template.description);
    setSkills(template.requiredSkills.join('\n'));
    setMcp(template.mcpServers.join('\n'));
    setPrinciples(template.operatingPrinciples.join('\n'));
  }, [template]);

  const fieldClass = cn(
    'w-full rounded-lg border px-3 py-2 text-sm outline-none placeholder:text-zinc-500',
    s(theme, 'inset'),
    isDark ? 'text-zinc-100' : 'text-zinc-900',
  );
  const labelClass = cn(
    'mb-1 block text-[11px] font-semibold uppercase tracking-wider',
    isDark ? 'text-zinc-400' : 'text-zinc-500',
  );

  const handleSave = () => {
    if (!template) return;
    onSave(template.id, {
      name: name.trim() || template.name,
      description: description.trim(),
      requiredSkills: toList(skills),
      mcpServers: toList(mcp),
      operatingPrinciples: toList(principles),
    });
  };

  return (
    <Sheet open={template !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" aria-describedby={undefined}>
        {template ? (
          <>
            <SheetHeader className="border-b pb-4">
              <SheetTitle className="text-base leading-tight">
                {t('common.edit')} · {template.name}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {template.source}
              </SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div>
                <label className={labelClass} htmlFor="pt-name">
                  {t('evolution.studio.v2.templates.editName')}
                </label>
                <input
                  id="pt-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={fieldClass}
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="pt-desc">
                  {t('evolution.studio.v2.templates.editDescription')}
                </label>
                <textarea
                  id="pt-desc"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={cn(fieldClass, 'resize-y')}
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="pt-skills">
                  {t('evolution.studio.v2.templates.skillset')}
                </label>
                <textarea
                  id="pt-skills"
                  rows={4}
                  value={skills}
                  onChange={(e) => setSkills(e.target.value)}
                  placeholder={t('evolution.studio.v2.templates.editListHint')}
                  className={cn(fieldClass, 'resize-y font-mono text-xs')}
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="pt-mcp">
                  {t('evolution.studio.v2.templates.mcp')}
                </label>
                <textarea
                  id="pt-mcp"
                  rows={3}
                  value={mcp}
                  onChange={(e) => setMcp(e.target.value)}
                  placeholder={t('evolution.studio.v2.templates.editListHint')}
                  className={cn(fieldClass, 'resize-y font-mono text-xs')}
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="pt-principles">
                  {t('evolution.studio.v2.templates.principles')}
                </label>
                <textarea
                  id="pt-principles"
                  rows={5}
                  value={principles}
                  onChange={(e) => setPrinciples(e.target.value)}
                  placeholder={t('evolution.studio.v2.templates.editListHint')}
                  className={cn(fieldClass, 'resize-y')}
                />
              </div>

              {/* Honest apply gate — no server path for custom templates. */}
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-snug',
                  s(theme, 'inset'),
                  isDark ? 'text-zinc-400' : 'text-zinc-500',
                )}
              >
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{t('evolution.studio.v2.templates.applyPrivateGated')}</span>
              </div>
            </div>

            <SheetFooter className="flex-row gap-2 border-t">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setConfirmRemove(true)}
                aria-label={t('evolution.studio.v2.templates.removeFromPrivate')}
                title={t('evolution.studio.v2.templates.removeFromPrivate')}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
              {/* Gated apply — disabled, never fake. */}
              <Button
                variant="outline"
                className="flex-1"
                disabled
                title={t('evolution.studio.v2.templates.applyPrivateGated')}
              >
                <Stamp className="size-4" aria-hidden />
                {t('evolution.studio.v2.templates.applyPending')}
              </Button>
              <Button className="flex-1" onClick={handleSave}>
                <Save className="size-4" aria-hidden />
                {t('common.save')}
              </Button>
            </SheetFooter>

            <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('evolution.studio.v2.templates.removeConfirmTitle', { template: template.name })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('evolution.studio.v2.templates.removeConfirmBody')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setConfirmRemove(false);
                      onRemove(template.id);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t('common.remove')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
