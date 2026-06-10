'use client';

/**
 * 2026-05-30 — shared "Advanced (Proxy Provider)" accordion used by both the
 * Simple-mode NewAgentDialog and the Pro-mode ProTileAgent panel.
 *
 * Design-system surface:
 *   - radix `Accordion` for the collapse + ARIA wiring (mirrors
 *     `src/components/ui/tabs.tsx` etc.).
 *   - workspace `design.ts` token vocabulary (no magic Tailwind values).
 *   - `ProxyProviderSelect` is the actual radio surface — this is just the
 *     collapsible shell so the dialog stays compact for the 95% case.
 */

import { Accordion as AccordionPrimitive } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProxyProviderSelect, type ProxyProvider } from '../../proxy-provider-select';

export interface AdvancedProxyAccordionProps {
  isDark: boolean;
  proxyProvider: ProxyProvider;
  onProxyProviderChange: (value: ProxyProvider) => void;
  /** Distinct test-id prefix so the Simple + Pro surfaces don't collide. */
  testIdPrefix?: string;
}

export function AdvancedProxyAccordion({
  isDark,
  proxyProvider,
  onProxyProviderChange,
  testIdPrefix = 'new-agent',
}: AdvancedProxyAccordionProps) {
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      data-testid={`${testIdPrefix}-advanced-accordion`}
      className={cn(
        'overflow-hidden rounded-xl border',
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50/60',
      )}
    >
      <AccordionPrimitive.Item value="proxy-provider" className="grid">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger
            data-testid={`${testIdPrefix}-advanced-trigger`}
            className={cn(
              'group flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium',
              isDark ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-700 hover:text-zinc-900',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="uppercase tracking-[0.08em]">高级 (Proxy Provider)</span>
              <span
                data-testid={`${testIdPrefix}-proxy-provider-summary`}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  isDark ? 'border-white/10 bg-white/[0.04] text-zinc-400' : 'border-zinc-200 bg-white/70 text-zinc-500',
                )}
              >
                {proxyProvider}
              </span>
            </span>
            <ChevronDown
              className="size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <AccordionPrimitive.Content className="overflow-hidden">
          <div className="border-t border-white/[0.04] px-3 pb-3 pt-3">
            <ProxyProviderSelect value={proxyProvider} onChange={onProxyProviderChange} isDark={isDark} />
          </div>
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}

export default AdvancedProxyAccordion;
