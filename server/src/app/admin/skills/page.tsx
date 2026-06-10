'use client';

/**
 * release202/09 §P4-b — Built-in skill catalog governance.
 *
 * `/admin/skills` lets an admin review every built-in skill (slug, description,
 * category) and enable the general (B-list) ones ONE AT A TIME by flipping the
 * catalog-level `defaultEnabled` flag. System-capability (A-list) skills are
 * shown but their toggle is locked always-on.
 *
 * This is catalog-level governance, NOT per-agent install state — flipping
 * `defaultEnabled` only changes whether NEW agents auto-install the skill.
 *
 * Shell + data-fetch (`imFetch`) + optimistic-toggle patterns mirror the
 * `/admin/criteria-templates` reference composite. Uses design-system
 * primitives (`Badge`, `Button` from `src/components/ui`) + semantic
 * `dark:`-variant tokens so it honours the admin shell's light/dark theme.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';

import { imFetch } from '@/app/workspace/lib/im-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToastContainer } from '@/components/ui/toast';
import type { ToastMessage } from '@/types';

interface BuiltInSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  isSystem: boolean;
  defaultEnabled: boolean;
  status: string;
}

export default function AdminSkillsPage() {
  const [rows, setRows] = useState<BuiltInSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await imFetch<BuiltInSkill[]>('/skills/admin/built-ins');
      if (res.ok) {
        setRows(res.data ?? []);
      } else {
        pushToast('error', `Load failed: ${res.message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggleDefaultEnabled = useCallback(
    async (skill: BuiltInSkill, next: boolean) => {
      // Optimistic flip.
      setRows((prev) => prev.map((r) => (r.slug === skill.slug ? { ...r, defaultEnabled: next } : r)));
      setSavingSlug(skill.slug);
      const res = await imFetch<BuiltInSkill>(
        `/skills/admin/${encodeURIComponent(skill.slug)}/default-enabled`,
        {
          method: 'PATCH',
          body: JSON.stringify({ defaultEnabled: next }),
        },
      );
      setSavingSlug(null);
      if (!res.ok) {
        // Roll back on failure.
        setRows((prev) =>
          prev.map((r) => (r.slug === skill.slug ? { ...r, defaultEnabled: !next } : r)),
        );
        pushToast('error', `Could not update ${skill.name}: ${res.message}`);
        return;
      }
      pushToast('success', `${skill.name} ${next ? 'enabled' : 'disabled'} by default`);
    },
    [pushToast],
  );

  const { systemSkills, generalSkills } = useMemo(() => {
    const system = rows.filter((r) => r.isSystem);
    const general = rows.filter((r) => !r.isSystem);
    return { systemSkills: system, generalSkills: general };
  }, [rows]);

  const enabledGeneral = generalSkills.filter((s) => s.defaultEnabled).length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Built-in Skill Catalog</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Catalog-level governance. System-capability skills are always on. Review and enable the
            general skills one at a time — flipping a toggle only changes whether{' '}
            <strong>new</strong> agents auto-install that skill by default.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Reload
        </Button>
      </header>

      {loading && rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : (
        <div className="space-y-8">
          <SkillGroup
            title="System capability"
            subtitle="Always on — required infrastructure skills. Toggle locked."
            icon={<ShieldCheck className="h-4 w-4 text-emerald-500" />}
            count={systemSkills.length}
            skills={systemSkills}
            savingSlug={savingSlug}
            onToggle={toggleDefaultEnabled}
          />
          <SkillGroup
            title="General"
            subtitle={`${enabledGeneral}/${generalSkills.length} enabled by default — flip individually.`}
            icon={<Sparkles className="h-4 w-4 text-violet-500" />}
            count={generalSkills.length}
            skills={generalSkills}
            savingSlug={savingSlug}
            onToggle={toggleDefaultEnabled}
          />
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

interface SkillGroupProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  count: number;
  skills: BuiltInSkill[];
  savingSlug: string | null;
  onToggle: (skill: BuiltInSkill, next: boolean) => void;
}

function SkillGroup({ title, subtitle, icon, count, skills, savingSlug, onToggle }: SkillGroupProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
      <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold">{title}</h2>
          <Badge variant="secondary">{count}</Badge>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </header>

      {skills.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm italic text-zinc-500 dark:text-zinc-400">
          No skills in this group.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-5 py-2 font-medium">Skill</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-5 py-2 text-right font-medium">Default enabled</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr
                key={skill.id}
                className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/30"
              >
                <td className="px-5 py-3 align-top">
                  <div className="font-medium">{skill.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {skill.slug}
                  </div>
                </td>
                <td className="px-3 py-3 align-top text-zinc-600 dark:text-zinc-300">
                  <span className="line-clamp-2">{skill.description || '—'}</span>
                </td>
                <td className="px-3 py-3 align-top">
                  <Badge variant="outline">{skill.category}</Badge>
                </td>
                <td className="px-5 py-3 text-right align-top">
                  <ToggleSwitch
                    checked={skill.defaultEnabled}
                    disabled={skill.isSystem || savingSlug === skill.slug}
                    locked={skill.isSystem}
                    onChange={(next) => onToggle(skill, next)}
                    label={`Toggle default-enabled for ${skill.name}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  locked?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

/**
 * Accessible switch built on design-system tokens (no `Switch` primitive exists
 * in `src/components/ui` yet). Uses `role="switch"` + `aria-checked`, focus ring
 * from the same token vocabulary as `button.tsx`, and `bg-primary` when on.
 * System skills render `locked` (always-on, non-interactive).
 */
function ToggleSwitch({ checked, disabled, locked, onChange, label }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={locked ? 'System skill — always on' : undefined}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
