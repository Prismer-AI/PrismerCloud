'use client';

/**
 * 2026-05-30 — per-agent LLM proxy selector.
 * 2026-06-02 (release202/07) — now CONFIG-DRIVEN: fetches the provider chain
 * list from `GET /api/provider-chains` instead of a hardcoded 2-value enum.
 * Each chain is an ordered fallback list (source1 → source2 → …, unbounded);
 * the picker renders one tile per chain. `ProxyProvider` is now `string`
 * (any configured chain id). The daemon adapter rewrites base_url to
 * `/api/v1/proxy/<chain>` so the cloud walks that chain.
 *
 * Surface rules (design-system primitives + workspace tokens):
 *   - radix-ui `RadioGroup` (accessibility + keyboard nav) — same primitive
 *     pattern as `src/components/ui/tabs.tsx`, `dialog.tsx` etc.
 *   - `radius.card` + `s(theme, 'card')` from `src/app/workspace/lib/design.ts`.
 *   - `cn` from `@/lib/utils` for class composition.
 *
 * Backwards compat: when no `value` arrives we render the first chain selected
 * and fire `onChange` with it. The built-in `newapi`/`deepseek`/`default`
 * chains always exist server-side, so the fetch never comes back empty.
 */

import { useEffect, useState } from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { NEWAPI_DEFAULT_MODEL, DEEPSEEK_DEFAULT_MODEL } from '@/lib/llm/provider-sources';
import { getWorkspaceToken } from '../lib/im-api';
import { radius, s } from '../lib/design';

/** release202/07 — any configured chain id (was the `'newapi' | 'deepseek'` enum). */
export type ProxyProvider = string;

interface ChainOption {
  id: string;
  label: string;
  sources: string[];
  /** release202/12 C1 — the chain's default model (from /api/provider-chains). */
  primaryDefaultModel?: string | null;
}

export interface ProxyProviderSelectProps {
  value: ProxyProvider;
  /**
   * release202/12 C1 — second arg is the picked chain's `primaryDefaultModel`
   * (when known) so the caller can reset the model field to a CUSTOM chain's
   * real default instead of `undefined`. Existing single-arg consumers are
   * unaffected (the extra arg is simply ignored).
   */
  onChange: (value: ProxyProvider, primaryDefaultModel?: string | null) => void;
  isDark: boolean;
}

// Friendly copy for the built-in chains; custom chains get a generic line
// derived from their source list.
const KNOWN_COPY: Record<string, { label: string; description: string; badge: string }> = {
  newapi: { label: 'NewAPI (默认推荐)', description: '走平台聚合代理，支持所有模型（gemini / kimi 等）。', badge: '推荐' },
  default: { label: 'NewAPI (默认推荐)', description: '平台聚合代理，无 fallback。', badge: '推荐' },
  deepseek: { label: 'DeepSeek 直连', description: '绕过 NewAPI 直连 DeepSeek，用于速度 / 效果对比。', badge: '对比' },
};

const FALLBACK_CHAINS: ChainOption[] = [
  { id: 'newapi', label: 'newapi', sources: ['newapi'], primaryDefaultModel: NEWAPI_DEFAULT_MODEL },
  { id: 'deepseek', label: 'deepseek', sources: ['deepseek'], primaryDefaultModel: DEEPSEEK_DEFAULT_MODEL },
];

export function ProxyProviderSelect({ value, onChange, isDark }: ProxyProviderSelectProps) {
  const theme = isDark ? 'dark' : 'light';
  const [chains, setChains] = useState<ChainOption[]>(FALLBACK_CHAINS);

  useEffect(() => {
    let cancelled = false;
    const token = getWorkspaceToken();
    fetch('/api/provider-chains', { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((res) => (res.ok ? res.json() : Promise.reject(String(res.status))))
      .then((body: { chains?: ChainOption[] }) => {
        if (cancelled) return;
        const list = Array.isArray(body.chains) ? body.chains : [];
        // Hide the internal `default` alias — it duplicates `newapi` for users.
        const visible = list.filter((c) => c.id !== 'default');
        if (visible.length > 0) setChains(visible);
      })
      // (chains carry primaryDefaultModel — surfaced via onChange below.)
      .catch(() => {
        /* keep FALLBACK_CHAINS */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <RadioGroupPrimitive.Root
      data-testid="proxy-provider-select"
      value={value}
      onValueChange={(next) => {
        const picked = chains.find((c) => c.id === next);
        onChange(next, picked?.primaryDefaultModel);
      }}
      className="grid gap-2"
      aria-label="LLM proxy provider"
    >
      {chains.map((chain) => {
        const active = chain.id === value;
        const copy = KNOWN_COPY[chain.id];
        const label = copy?.label ?? chain.label;
        const description =
          copy?.description ??
          (chain.sources.length > 1
            ? `Fallback 链：${chain.sources.join(' → ')}`
            : `直连 source：${chain.sources[0] ?? chain.id}`);
        const badge = copy?.badge ?? (chain.sources.length > 1 ? `链 ×${chain.sources.length}` : 'source');
        return (
          <RadioGroupPrimitive.Item
            key={chain.id}
            value={chain.id}
            data-testid={`proxy-provider-option-${chain.id}`}
            className={cn(
              'group relative grid cursor-pointer gap-1 border px-3 py-2.5 text-left transition-colors',
              radius.card,
              s(theme, 'card'),
              active
                ? isDark
                  ? 'border-violet-400/45 bg-violet-500/10 ring-1 ring-violet-400/30'
                  : 'border-violet-300 bg-violet-50 ring-1 ring-violet-300/60'
                : isDark
                  ? 'hover:border-white/15 hover:bg-white/[0.04]'
                  : 'hover:border-zinc-300 hover:bg-zinc-50/80',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  'text-xs font-semibold',
                  active
                    ? isDark
                      ? 'text-violet-200'
                      : 'text-violet-800'
                    : isDark
                      ? 'text-zinc-200'
                      : 'text-zinc-800',
                )}
              >
                {label}
              </span>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  active
                    ? isDark
                      ? 'border-violet-300/60 bg-violet-400/15 text-violet-100'
                      : 'border-violet-300 bg-white/80 text-violet-700'
                    : isDark
                      ? 'border-white/10 bg-white/[0.04] text-zinc-400'
                      : 'border-zinc-200 bg-white/70 text-zinc-500',
                )}
              >
                {badge}
              </span>
            </div>
            <p className={cn('text-[11px] leading-4', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
              {description}
            </p>
            <RadioGroupPrimitive.Indicator
              className={cn(
                'absolute right-2 top-2 grid size-4 place-items-center rounded-full border',
                isDark ? 'border-violet-300/70 bg-violet-400/40' : 'border-violet-400 bg-violet-500',
              )}
            >
              <span className={cn('size-1.5 rounded-full', isDark ? 'bg-zinc-50' : 'bg-white')} />
            </RadioGroupPrimitive.Indicator>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

export default ProxyProviderSelect;
