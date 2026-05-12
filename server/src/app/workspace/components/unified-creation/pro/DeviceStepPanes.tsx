'use client';

/**
 * §30 B3.5 — Step panes for ProTileDevice (template / resources / confirm)
 * + the ResourceRow choice-chip group. Extracted so ProTileDevice stays
 * under the 250-line budget. Behaviour mirrors K8sProvisionWizard
 * lines 212-309 verbatim, with chrome rewritten to design.ts tokens.
 */

import { Layers } from 'lucide-react';

import { radius, s } from '../../../lib/design';
import { CPU_CHOICES, GPU_CHOICES, MEM_CHOICES, TEMPLATES, type K8sTemplate } from './device-catalog';

// ───────────────────────── Template pane ─────────────────────────

export function TemplatePane({
  isDark,
  templateId,
  onSelect,
}: {
  isDark: boolean;
  templateId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div data-testid="pro-tile-device-pane-template" className="grid gap-2">
      {TEMPLATES.map((t) => {
        const active = templateId === t.id;
        return (
          <button
            type="button"
            key={t.id}
            data-testid={`pro-tile-device-template-${t.id}`}
            data-selected={active ? 'true' : 'false'}
            onClick={() => onSelect(t.id)}
            className={`w-full border px-4 py-3 text-left transition-colors ${radius.card} ${
              active
                ? isDark
                  ? 'border-violet-400/40 bg-violet-400/5'
                  : 'border-violet-300 bg-violet-50/40'
                : isDark
                  ? 'border-white/10 hover:bg-white/[0.03]'
                  : 'border-zinc-200 hover:bg-zinc-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4" />
              <span className="text-sm font-semibold">{t.label}</span>
              <span className={`ml-auto font-mono text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {t.image}
              </span>
            </div>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{t.description}</p>
            <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Recommended for: {t.recommendedFor}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Resource picker row ─────────────────────────

export function ResourceRow({
  isDark,
  icon,
  label,
  testidPrefix,
  choices,
  value,
  onChange,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  testidPrefix: string;
  choices: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className={`border px-4 py-3 ${radius.card} ${isDark ? 'border-white/10' : 'border-zinc-200'}`}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        {icon}
        {label}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((c) => {
          const active = value === c.id;
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`${testidPrefix}-${c.id}`}
              data-selected={active ? 'true' : 'false'}
              onClick={() => onChange(c.id)}
              className={`border px-3 py-1 text-[11px] font-semibold transition-colors ${radius.chip} ${
                active
                  ? isDark
                    ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                    : 'border-violet-300 bg-violet-50 text-violet-700'
                  : isDark
                    ? 'border-white/10 text-zinc-400 hover:bg-white/[0.04]'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Confirm pane ─────────────────────────

export function ConfirmPane({
  isDark,
  template,
  cpuId,
  memId,
  gpuId,
  error,
}: {
  isDark: boolean;
  template: K8sTemplate;
  cpuId: string;
  memId: string;
  gpuId: string;
  error: string | null;
}) {
  const theme = isDark ? 'dark' : 'light';
  const cpu = CPU_CHOICES.find((c) => c.id === cpuId) ?? CPU_CHOICES[1];
  const mem = MEM_CHOICES.find((m) => m.id === memId) ?? MEM_CHOICES[1];
  const gpu = GPU_CHOICES.find((g) => g.id === gpuId) ?? GPU_CHOICES[0];
  return (
    <dl
      data-testid="pro-tile-device-pane-confirm"
      className={`grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 border px-4 py-3 text-xs ${radius.card} ${s(theme, 'inset')}`}
    >
      <dt className="font-semibold">Template</dt>
      <dd>{template.label}</dd>
      <dt className="font-semibold">Image</dt>
      <dd className="truncate font-mono text-[11px]">{template.image}</dd>
      <dt className="font-semibold">CPU</dt>
      <dd>
        {cpu.label} (request {cpu.cpuRequest}, limit {cpu.cpuLimit})
      </dd>
      <dt className="font-semibold">Memory</dt>
      <dd>
        {mem.label} (request {mem.memoryRequest}, limit {mem.memoryLimit})
      </dd>
      <dt className="font-semibold">GPU</dt>
      <dd>{gpu.label}</dd>
      {error ? (
        <>
          <dt className="font-semibold text-red-400">Error</dt>
          <dd className="text-red-400">{error}</dd>
        </>
      ) : null}
    </dl>
  );
}
