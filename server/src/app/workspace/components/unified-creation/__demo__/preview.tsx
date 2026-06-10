'use client';

/**
 * §30 B3.1 + B3.2 — UnifiedCreationModal preview harness.
 *
 * Standalone client component for manual / visual verification. B3.1
 * exercises the shell; B3.2 wires the SimpleStep1Industry picker so the
 * 6×4 grid can be eyeballed (selected/hover states, 800ms hover caption,
 * radiogroup keyboard nav) without booting the full workspace shell.
 *
 * Two modes:
 *   - "Open modal" — full shell with Step 1 plugged in
 *   - "Step 1 standalone" — render the picker bare-on-bg to inspect tokens
 *     without modal chrome / sticky header noise
 *
 * NOT imported by routing — to preview, render this from a temporary
 * page or paste it into a Playground route. Kept under `__demo__/` so it
 * stays out of TopBar / page.tsx wiring.
 */

import { useMemo, useState } from 'react';

import { UnifiedCreationModal, type UnifiedCreationEvent } from '..';
import { CapacityExceededModal } from '../CapacityExceededModal';
import { ProModeFlow } from '../ProModeFlow';
import { SimpleStep1Industry } from '../SimpleStep1Industry';
import { SimpleStep2Team } from '../SimpleStep2Team';
import { SimpleStep3Launch } from '../SimpleStep3Launch';
import type { SimpleProvisioningPlan, SimpleProvisioningResult } from '../use-simple-provisioning';
import { renderTemplate } from '../../../lib/templates/render';
import type { IndustryKey, RenderedRole, SizeKey } from '../../../lib/templates/types';
import type { ProxyProvider } from '../../proxy-provider-select';

export function UnifiedCreationPreview() {
  const [open, setOpen] = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [lastEvent, setLastEvent] = useState<UnifiedCreationEvent | null>(null);
  const [industry, setIndustry] = useState<IndustryKey | null>(null);
  const [size, setSize] = useState<SizeKey | null>(null);
  const [organizationName, setOrganizationName] = useState('Demo Organization');
  const [step2Slugs, setStep2Slugs] = useState<Set<string>>(new Set());
  const [model, setModel] = useState('us-kimi-k2.6');
  const [proxyProvider, setProxyProvider] = useState<ProxyProvider>('newapi');

  function handleCreated(event: UnifiedCreationEvent) {
    setLastEvent(event);
    console.log('[UnifiedCreationPreview] onCreated', event);
  }

  function handleStep1Change(nextIndustry: IndustryKey | null, nextSize: SizeKey | null) {
    setIndustry(nextIndustry);
    setSize(nextSize);
    // Seed Step 2 selection whenever (industry, size) gains both halves.
    if (nextIndustry && nextSize) {
      const seeded = new Set(renderTemplate(nextIndustry, nextSize, 'zh').map((r) => r.slug));
      setStep2Slugs(seeded);
    } else {
      setStep2Slugs(new Set());
    }
  }

  return (
    <div className={`min-h-screen p-8 ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-bold">UnifiedCreationModal preview</h1>
          <p className="text-sm opacity-70">§30 B3.1 shell + B3.2 Simple Step 1 picker. B3.3-B3.5 follow.</p>
        </header>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500"
          >
            Open modal
          </button>
          <button
            type="button"
            onClick={() => setIsDark((p) => !p)}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              isDark ? 'bg-white/[0.06] text-zinc-200' : 'bg-zinc-200 text-zinc-700'
            }`}
          >
            Toggle theme (currently {isDark ? 'dark' : 'light'})
          </button>
          <button
            type="button"
            onClick={() => setCapacityOpen(true)}
            className="rounded-xl bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-white/[0.1]"
            data-testid="open-capacity-modal"
          >
            Open capacity-exceeded modal
          </button>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Step 1 — standalone</h2>
          <p className="text-xs opacity-60">
            Organization: <span className="font-mono">{organizationName || '—'}</span> · Selected:{' '}
            <span className="font-mono">{industry ?? '—'}</span> / <span className="font-mono">{size ?? '—'}</span>
          </p>
          <div
            className={`rounded-2xl border p-5 ${
              isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-white/80'
            }`}
          >
            <SimpleStep1Industry
              isDark={isDark}
              initialOrganizationName={organizationName}
              initialIndustry={industry ?? undefined}
              initialSize={size ?? undefined}
              model={model}
              proxyProvider={proxyProvider}
              onOrganizationNameChange={setOrganizationName}
              onModelChange={setModel}
              onProxyProviderChange={setProxyProvider}
              onSelectionChange={handleStep1Change}
            />
          </div>
        </section>

        {industry && size ? (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Step 2 — standalone</h2>
            <p className="text-xs opacity-60">
              Selected slugs: <span className="font-mono">{Array.from(step2Slugs).join(', ') || '—'}</span>
            </p>
            <div
              className={`rounded-2xl border p-5 ${
                isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-white/80'
              }`}
            >
              <SimpleStep2Team
                isDark={isDark}
                industry={industry}
                size={size}
                selectedSlugs={step2Slugs}
                onSelectionChange={setStep2Slugs}
              />
            </div>
          </section>
        ) : (
          <p className="text-xs opacity-50">(Step 2 preview will appear once you pick industry + size in Step 1.)</p>
        )}

        {industry && size && step2Slugs.size > 0 ? (
          <Step3PreviewBlock
            isDark={isDark}
            industry={industry}
            size={size}
            slugs={step2Slugs}
            onSuccess={(r) => console.log('[UnifiedCreationPreview] Step3 success', r)}
            onCancel={() => console.log('[UnifiedCreationPreview] Step3 cancel')}
          />
        ) : (
          <p className="text-xs opacity-50">(Step 3 preview will appear once at least 1 role is selected in Step 2.)</p>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Pro mode — standalone (B3.5)</h2>
          <p className="text-xs opacity-60">
            5-tile picker (Workspace disabled). Click a tile → AnimatePresence slides into sub-panel; Back returns.
          </p>
          <div
            className={`rounded-2xl border p-5 ${
              isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-white/80'
            }`}
          >
            <ProModeFlow
              isDark={isDark}
              workspaceId="demo-workspace-id"
              agents={[]}
              profiles={[]}
              onCreated={handleCreated}
            />
          </div>
        </section>

        {lastEvent ? (
          <pre className="rounded-xl border border-white/[0.08] bg-black/40 p-4 text-xs">
            {JSON.stringify(lastEvent, null, 2)}
          </pre>
        ) : (
          <p className="text-xs opacity-50">
            (No onCreated event yet — open the modal and walk through Simple steps to Launch.)
          </p>
        )}
      </div>

      <UnifiedCreationModal
        open={open}
        onOpenChange={setOpen}
        isDark={isDark}
        workspaceId="demo-workspace-id"
        agents={[]}
        profiles={[]}
        onCreated={handleCreated}
      />

      <CapacityExceededModal
        open={capacityOpen}
        onOpenChange={setCapacityOpen}
        isDark={isDark}
        used={3}
        total={3}
        deviceCount={1}
        onPurchaseDevice={() => {
          console.log('[UnifiedCreationPreview] capacity → purchase device');
          setCapacityOpen(false);
        }}
        onUpgradePlan={() => {
          console.log('[UnifiedCreationPreview] capacity → upgrade plan');
          setCapacityOpen(false);
        }}
        onManageAgents={() => {
          console.log('[UnifiedCreationPreview] capacity → manage agents');
          setCapacityOpen(false);
        }}
      />
    </div>
  );
}

export default UnifiedCreationPreview;

// ───────────────────────── Step 3 preview wrapper ─────────────────────────
//
// Builds a `SimpleProvisioningPlan` from the Step 1+2 selections and mounts
// `<SimpleStep3Launch />`. The provisioning hook starts on mount, so the
// preview will hit `/api/im/register` etc. — only useful inside the workspace
// page when an IM auth token is available in localStorage. For unauthenticated
// preview, the first API call will fail and the failure UI will render.
//
// "Mount" gating: the block is rendered in a fresh div that's KEYED by the
// slug-set so re-selecting roles after a failed run resets the hook.

function Step3PreviewBlock({
  isDark,
  industry,
  size,
  slugs,
  onSuccess,
  onCancel,
}: {
  isDark: boolean;
  industry: IndustryKey;
  size: SizeKey;
  slugs: Set<string>;
  onSuccess: (r: SimpleProvisioningResult) => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  const plan = useMemo<SimpleProvisioningPlan | null>(() => {
    if (!mounted) return null;
    const rendered = renderTemplate(industry, size, 'zh');
    // Filter to selected + preserve order (CEO first since renderTemplate
    // emits primary roles first).
    const roles: RenderedRole[] = rendered.filter((r) => slugs.has(r.slug));
    return {
      workspaceId: 'demo-workspace-id',
      organizationName: 'Demo Organization',
      model: 'us-kimi-k2.6',
      roles,
      conversationTitle: '团队会议',
      usernames: {} as Record<string, string>,
    };
  }, [industry, size, slugs, mounted]);

  const keySig = Array.from(slugs).sort().join(',');

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Step 3 — provisioning loader</h2>
      <p className="text-xs opacity-60">
        Plan: <span className="font-mono">{plan ? plan.roles.map((r) => r.slug).join(', ') : '(click Mount)'}</span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMounted(true)}
          disabled={mounted}
          className="rounded-xl bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mount &amp; start
        </button>
        <button
          type="button"
          onClick={() => setMounted(false)}
          disabled={!mounted}
          className="rounded-xl bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Unmount
        </button>
      </div>
      <div
        key={keySig}
        className={`rounded-2xl border p-5 ${
          isDark ? 'border-white/[0.06] bg-zinc-900/40' : 'border-zinc-200 bg-white/80'
        }`}
      >
        {mounted && plan ? (
          <SimpleStep3Launch isDark={isDark} plan={plan} onSuccess={onSuccess} onCancel={onCancel} />
        ) : (
          <p className="text-xs opacity-50">(Click &ldquo;Mount &amp; start&rdquo; to begin provisioning.)</p>
        )}
      </div>
    </section>
  );
}
