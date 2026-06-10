'use client';

/**
 * Configure modal — release201/13 §3.4, S22.
 *
 * Renders a dynamic form from `IMSkill.executableJson.configSchema`
 * (release201/07 §2.6). Schema shape:
 *
 *   {
 *     type: 'object',
 *     properties: {
 *       <key>: { type: 'string'|'number'|'boolean', default?, enum?, description? }
 *     },
 *     required?: string[]
 *   }
 *
 * Field rendering:
 *   - type=string  → <input type=text>
 *   - type=number  → <input type=number>
 *   - type=boolean → <input type=checkbox>
 *   - .enum        → <select>
 *
 * Falls back to a raw JSON textarea when no configSchema is present.
 * Submits via PATCH /api/im/agents/:agentId/skills/:skillId (S22 endpoint
 * landed in agents.ts via S20).
 */

import { useEffect, useMemo, useState } from 'react';
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
import { type SkillConfigSchema, type SkillDetail, fetchSkillDetail, updateAgentSkillConfig } from '../types';

interface ConfigureModalProps {
  isDark: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string | null;
  skillId: string | null;
  skillName?: string | null;
  /** Initial config (read from IMAgentSkill.config). */
  initialConfig?: Record<string, unknown>;
  onSaved?: () => void;
}

export function ConfigureModal({
  isDark,
  open,
  onOpenChange,
  agentId,
  skillId,
  skillName,
  initialConfig,
  onSaved,
}: ConfigureModalProps) {
  const { t } = useI18n();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(initialConfig ?? {});
  const [rawJson, setRawJson] = useState<string>(JSON.stringify(initialConfig ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !skillId) return;
    let cancelled = false;
    setLoading(true);
    void fetchSkillDetail(skillId).then((detail) => {
      if (cancelled) return;
      setSkill(detail);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, skillId]);

  // Re-seed values whenever the modal opens with a new initial config.
  useEffect(() => {
    if (!open) return;
    setValues(initialConfig ?? {});
    setRawJson(JSON.stringify(initialConfig ?? {}, null, 2));
    setError(null);
  }, [open, initialConfig]);

  const configSchema: SkillConfigSchema | null = useMemo(() => {
    const cs = skill?.executableJson?.configSchema;
    return cs && cs.properties ? cs : null;
  }, [skill]);

  const handleSave = async () => {
    if (!agentId || !skillId) return;
    setSaving(true);
    setError(null);
    let payload: Record<string, unknown>;
    if (configSchema) {
      payload = values;
    } else {
      try {
        payload = JSON.parse(rawJson || '{}');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('config must be a JSON object');
        }
      } catch (err) {
        setError(t('evolution.studio.lifecycle.configure.invalidJson', { message: (err as Error).message }));
        setSaving(false);
        return;
      }
    }
    const result = await updateAgentSkillConfig(agentId, skillId, payload);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? t('evolution.studio.lifecycle.configure.saveFailed'));
      return;
    }
    onSaved?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="configure-modal" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('evolution.studio.lifecycle.configure.title')}</DialogTitle>
          <DialogDescription>
            {t('evolution.studio.lifecycle.configure.description', {
              skill: skillName ?? t('evolution.studio.lifecycle.configure.thisSkill'),
            })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-xs opacity-70">{t('evolution.studio.lifecycle.configure.loading')}</p>
        ) : configSchema ? (
          <DynamicForm isDark={isDark} schema={configSchema} values={values} onChange={setValues} />
        ) : (
          <div className="space-y-2">
            <p className={`text-[11px] ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
              {t('evolution.studio.lifecycle.configure.noSchema')}
            </p>
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              rows={8}
              className={`w-full rounded-md border px-2 py-1.5 font-mono text-[11px] ${
                isDark ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
              }`}
              data-testid="configure-modal-raw-json"
            />
          </div>
        )}
        {error && <p className={`text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving} data-testid="configure-modal-save">
            {saving ? t('evolution.studio.lifecycle.configure.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dynamic form ───────────────────────────────────────────────────

function DynamicForm({
  isDark,
  schema,
  values,
  onChange,
}: {
  isDark: boolean;
  schema: SkillConfigSchema;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  const setValue = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  return (
    <div className="space-y-3" data-testid="configure-modal-form">
      {Object.entries(properties).map(([key, prop]) => {
        const current = values[key] ?? prop.default ?? '';
        const isReq = required.has(key);
        const labelClass = `mb-1 block text-[11px] uppercase tracking-wider ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`;
        const inputClass = `w-full rounded-md border px-2 py-1 text-xs ${
          isDark ? 'border-white/[0.06] bg-white/[0.04] text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
        }`;
        return (
          <div key={key} data-field-key={key}>
            <label className={labelClass}>
              {key}
              {isReq && <span className={isDark ? 'text-rose-300' : 'text-rose-600'}> *</span>}
            </label>
            {prop.enum ? (
              <select
                value={String(current ?? '')}
                onChange={(e) => setValue(key, e.target.value)}
                className={inputClass}
                data-testid={`configure-field-${key}`}
              >
                {!isReq && <option value="">—</option>}
                {prop.enum.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
            ) : prop.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(current)}
                  onChange={(e) => setValue(key, e.target.checked)}
                  data-testid={`configure-field-${key}`}
                />
                <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>
                  {t('evolution.studio.lifecycle.configure.enable')}
                </span>
              </label>
            ) : prop.type === 'number' ? (
              <input
                type="number"
                value={Number.isFinite(current as number) ? (current as number) : ''}
                onChange={(e) => setValue(key, e.target.value === '' ? null : Number(e.target.value))}
                className={inputClass}
                data-testid={`configure-field-${key}`}
              />
            ) : (
              <input
                type="text"
                value={String(current ?? '')}
                onChange={(e) => setValue(key, e.target.value)}
                className={inputClass}
                data-testid={`configure-field-${key}`}
              />
            )}
            {prop.description && (
              <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{prop.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
