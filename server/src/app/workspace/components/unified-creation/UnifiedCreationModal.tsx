'use client';

/**
 * UnifiedCreationModal — §30 B3.1 shell.
 *
 * Hosts both Simple and Pro creation flows behind a single `+` button.
 * This file is the FOUNDATION — Simple steps (B3.2-B3.4) and Pro picker
 * (B3.5) plug into the two child slots; B3.7 wires it to TopBar.
 *
 * Anatomy (5-layer per §2.8.3):
 *   - Overlay: fixed inset-0, bg-black/40 + backdrop-blur-sm (200ms fade)
 *   - Container: fixed inset-0 grid place-items-center, pointer-events-none
 *   - Modal box: pointer-events-auto, springHeavy enter / springSnap exit
 *     - Header (sticky, h-60): ✕ close + segmented mode toggle + ⋯ slot
 *     - Step indicator (h-32, Simple only): springSnap on step change
 *     - Content (flex-1, overflow-y-auto, AnimatePresence mode='wait')
 *     - Footer (sticky, h-72): Back + Next/Submit, right-aligned
 *
 * Reduced motion: when `prefers-reduced-motion: reduce`, springs degrade
 * to `duration: 0.12, ease: 'easeOut'`. Backdrop-blur stays (low
 * vestibular impact per §2.8.2).
 *
 * Mode persistence: reads `user.metadata.preferredCreationMode` via the
 * `loadPreferredCreationMode()` helper (localStorage shadow + server-side
 * source of truth). On toggle, writes via `setPreferredCreationMode()`
 * fire-and-forget. Helpers live in mutations.ts.
 *
 * Internal leaf components (mode toggle, step dots, footer button,
 * placeholders) are in `./parts.tsx` to keep this file focused on
 * layout + state plumbing.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { X } from 'lucide-react';

import { radius, s, springHeavy, springSnap, springSoft } from '../../lib/design';
import {
  loadPreferredCreationMode,
  setPreferredCreationMode,
  suggestUsernameSeed,
  type CreationMode,
} from '../../lib/mutations';
import { renderTemplate } from '../../lib/templates/render';
import type { IndustryKey, RenderedRole, SizeKey } from '../../lib/templates/types';
import type { AgentDTO, AgentProfileDTO, RuntimeInstallationDTO } from '../../lib/types';
import { imFetch } from '../../lib/im-api';
import { FooterButton, ModeToggle, StepDots } from './parts';
import { ProModeFlow } from './ProModeFlow';
import { SimpleStep1Industry } from './SimpleStep1Industry';
import { SimpleStep2Team } from './SimpleStep2Team';
import { SimpleStep3Launch } from './SimpleStep3Launch';
import { useSimpleProvisioning, type SimpleProvisioningPlan } from './use-simple-provisioning';

// ───────────────────────── Public types ─────────────────────────

/**
 * Discriminated union per B0 audit (docs/54release/30-b0-dialog-audit.md
 * "Cross-component shared state"). Parents demux by `kind`.
 *
 * NOTE the spec for B3.1 narrows the shape to the names listed below
 * (`workspace`, `device`, `agent`, `conversation`, `task`, `simple-team`)
 * — the audit's earlier shape used `channel` instead of `conversation`
 * and didn't have `simple-team`. We follow the task spec because Simple
 * mode's atomic outcome is a 3-agent team + a group chat, not 5 separate
 * created entities.
 */
export type UnifiedCreationEvent =
  | { kind: 'workspace'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'agent'; ids: string[] }
  | { kind: 'conversation'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'simple-team'; agentIds: string[]; conversationId: string };

export interface UnifiedCreationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  workspaceId: string;
  /** Shared state for child flows (Pro Conversation / Pro Task). */
  agents: AgentDTO[];
  /** Shared state for child flows (Pro Task). */
  profiles: AgentProfileDTO[];
  /** Single discriminated callback — parent demuxes by `event.kind`. */
  onCreated: (event: UnifiedCreationEvent) => void;
  /** Defaults to 'simple'. Persisted preference (if any) wins on open. */
  initialMode?: CreationMode;
}

// ───────────────────────── Inner motion presets ─────────────────────────

/** Replace spring with a 120ms ease-out fallback when reduced motion is on. */
const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };

/**
 * P3-7 — fallback agent capacity when the API probe fails or no candidate
 * installation exists yet (fresh workspace). Mirrors the server-side default
 * in `assertDeviceCapacityAvailable` and the SQL `DEFAULT 3` on
 * `im_containers.maxAgents` so the UX is consistent with the eventual ceiling
 * the user would hit if they did provision a device here.
 */
const FALLBACK_DEVICE_MAX_AGENTS = 3;

/**
 * P3-7 — selected reuse target + capacity for the Simple flow. `installation`
 * is null when no eligible row was found (fresh workspace) — Step 3 will
 * provision a new one. `maxAgents` defaults to {@link FALLBACK_DEVICE_MAX_AGENTS}
 * in that case so Step 2's `(N/M)` counter still has a real number.
 */
interface DeviceCapacityProbe {
  installation: { id: string; daemonId: string; used: number; maxAgents: number } | null;
  maxAgents: number;
}

// ───────────────────────── Component ────────────────────────────

export function UnifiedCreationModal({
  open,
  onOpenChange,
  isDark,
  workspaceId,
  agents,
  profiles,
  onCreated,
  initialMode = 'simple',
}: UnifiedCreationModalProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tHeavy: Transition = reduce ? REDUCED : springHeavy;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;

  // Mode + step state. Mode persists; step resets on close/mode-change.
  const [mode, setMode] = useState<CreationMode>(initialMode);
  const [simpleStep, setSimpleStep] = useState<0 | 1 | 2>(0);

  // Simple-mode flow state (industry + size + selected role slugs). These
  // live on the shell so the back-button can survive remounts of the inner
  // step components, and so they reset when the modal closes.
  const [simpleIndustry, setSimpleIndustry] = useState<IndustryKey | null>(null);
  const [simpleSize, setSimpleSize] = useState<SizeKey | null>(null);
  const [simpleSelectedSlugs, setSimpleSelectedSlugs] = useState<Set<string>>(() => new Set());

  // Task 3 — per-role @handle drafts (keyed by role.slug) + inline errors
  // surfaced from Step 3 provisioning (e.g. 409 collisions). The drafts are
  // seeded from `suggestUsernameSeed(displayName)` (no random suffix) when
  // the recommended team is rendered. The user can edit each row before
  // committing on Step 3. `simpleSlugConflict` is the last conflict surfaced
  // by provisioning — owned here (not inside SimpleStep3Launch) so the
  // Step 2 ↔ 3 back/forward path keeps the "返回上一步修改" CTA stable.
  const [simpleSlugDrafts, setSimpleSlugDrafts] = useState<Record<string, string>>({});
  const [simpleSlugErrors, setSimpleSlugErrors] = useState<Record<string, string | null>>({});
  const [simpleSlugConflict, setSimpleSlugConflict] = useState<{ roleSlug: string; message: string } | null>(null);

  // P3-7 — device capacity probe. Resolved on Step 2 entry (idempotent — keyed
  // on `workspaceId + open` so it runs once per modal session). Null while the
  // probe is in-flight; populated with a real number from the API or the
  // {@link FALLBACK_DEVICE_MAX_AGENTS} fallback when the probe fails / no
  // candidate exists. Step 2's counter and Step 3's reuse logic both read off
  // this so the two surfaces never disagree.
  const [deviceCapacity, setDeviceCapacity] = useState<DeviceCapacityProbe | null>(null);

  // P3-7 — server-side CAPACITY_EXCEEDED surfaced from Step 3's register call.
  // The user can't fix this by editing handles, so we don't route back to
  // Step 2; instead SimpleStep3Launch shows an inline error with cancel as
  // the primary out (and a "管理 agent" link the operator can act on after
  // closing the modal). Lifted to the shell so the message survives a back
  // button press to Step 2 and back.
  const [simpleCapacityError, setSimpleCapacityError] = useState<{ used: number; max: number; message: string } | null>(
    null,
  );

  // Seed Step 2 selections from the recommended template the first time the
  // user lands on Step 2 with a fresh (industry, size) pair. We DO NOT
  // re-seed on every render — only when both halves are picked and the
  // current selection is empty. This lets users uncheck recommended roles
  // without us forcibly re-adding them. The setState-in-effect is
  // intentional: we're synchronizing a one-shot seed from a deterministic
  // template lookup (external system) to React state; `seededFor` is the
  // guard preventing the loop the linter is concerned about.
  const seededFor = useRef<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!simpleIndustry || !simpleSize) return;
    const key = `${simpleIndustry}:${simpleSize}`;
    if (seededFor.current === key) return;
    seededFor.current = key;
    try {
      const rendered = renderTemplate(simpleIndustry, simpleSize, 'zh');
      const recommendedSlugs = rendered.map((r) => r.slug);
      // Solo template max = 3 agents.
      setSimpleSelectedSlugs(new Set(recommendedSlugs.slice(0, 3)));
      // Seed slug drafts from displayName — no random suffix.
      const drafts: Record<string, string> = {};
      for (const r of rendered) {
        drafts[r.slug] = suggestUsernameSeed(r.displayName) || r.slug;
      }
      setSimpleSlugDrafts(drafts);
      setSimpleSlugErrors({});
      setSimpleSlugConflict(null);
    } catch {
      /* unknown industry/size pair — leave selection alone */
    }
  }, [simpleIndustry, simpleSize]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // P3-7 — device capacity probe. Fires once per modal session when the user
  // first reaches Step 2 (or earlier if simpleStep is hoisted). Keyed on
  // `${open}:${workspaceId}` so re-opening on a different workspace re-probes
  // cleanly, and same-session re-renders don't re-fetch. Failure tolerated
  // gracefully — we fall back to {@link FALLBACK_DEVICE_MAX_AGENTS} so Step 2
  // can still render a sane `(N/M)` counter (capacity is informational; it
  // must NOT block Simple Mode from running).
  const capacityProbedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (mode !== 'simple') return;
    if (simpleStep < 1) return; // Step 0 doesn't need it yet — defer until user crosses into Step 2.
    const probeKey = `${workspaceId}`;
    if (capacityProbedFor.current === probeKey) return;
    capacityProbedFor.current = probeKey;

    let cancelled = false;
    void (async () => {
      try {
        const res = await imFetch<RuntimeInstallationDTO[]>(
          `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        if (cancelled) return;
        if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
          // Fresh workspace / no candidate / probe failure → fallback. UI
          // shows `(N/3)` and the device step in Step 3 will provision a
          // new installation (which also defaults to maxAgents=3 today).
          setDeviceCapacity({ installation: null, maxAgents: FALLBACK_DEVICE_MAX_AGENTS });
          return;
        }
        // Pick the best candidate by:
        //   1. online first, then provisioning
        //   2. among those, the one with the most spare capacity (greedy —
        //      gives the user the biggest team slot regardless of order).
        const eligible = res.data
          .filter((row) => row.phase === 'online' || row.phase === 'provisioning')
          .map((row) => ({
            row,
            spare: Math.max(0, row.maxAgents - (row.hostedAgentSummary?.declared ?? 0)),
          }))
          .filter(({ spare }) => spare > 0)
          .sort((a, b) => {
            if (a.row.phase !== b.row.phase) return a.row.phase === 'online' ? -1 : 1;
            return b.spare - a.spare;
          });
        if (eligible.length === 0) {
          // All installations full / none online. We still surface the
          // FIRST row's maxAgents so the counter reads its real value
          // (e.g. (3/3) on a saturated device) — the user will see they
          // can't add and the server-side guard will reject as expected.
          // If none exist at all, fallback to default.
          const firstAny = res.data[0];
          if (firstAny) {
            setDeviceCapacity({
              installation: {
                id: firstAny.id,
                daemonId: firstAny.daemonId,
                used: firstAny.hostedAgentSummary?.declared ?? 0,
                maxAgents: firstAny.maxAgents,
              },
              maxAgents: firstAny.maxAgents,
            });
          } else {
            setDeviceCapacity({ installation: null, maxAgents: FALLBACK_DEVICE_MAX_AGENTS });
          }
          return;
        }
        const best = eligible[0].row;
        const used = best.hostedAgentSummary?.declared ?? 0;
        setDeviceCapacity({
          installation: { id: best.id, daemonId: best.daemonId, used, maxAgents: best.maxAgents },
          maxAgents: best.maxAgents,
        });
      } catch {
        if (!cancelled) {
          setDeviceCapacity({ installation: null, maxAgents: FALLBACK_DEVICE_MAX_AGENTS });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, simpleStep, workspaceId]);

  // On open: hydrate mode preference (one-shot per open). We deliberately
  // do NOT re-hydrate on every render — the modal should remember whatever
  // the user toggled to during this open session. On close: reset transient
  // step state so the next open starts fresh.
  //
  // The setState-in-effect here is intentional: we're synchronizing a
  // *one-shot* preference read (from localStorage) and a *reset* with an
  // external state transition (`open` → false). React Compiler warns about
  // setState in effects in general, but this pattern doesn't loop —
  // `hydratedFor` is the guard, and the reset only runs when `open` flips.
  const hydratedFor = useRef<boolean>(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) {
      hydratedFor.current = false;
      setSimpleStep(0);
      setSimpleIndustry(null);
      setSimpleSize(null);
      setSimpleSelectedSlugs(new Set());
      setSimpleSlugDrafts({});
      setSimpleSlugErrors({});
      setSimpleSlugConflict(null);
      setDeviceCapacity(null);
      setSimpleCapacityError(null);
      seededFor.current = null;
      capacityProbedFor.current = null;
      return;
    }
    if (hydratedFor.current) return;
    hydratedFor.current = true;
    const stored = loadPreferredCreationMode();
    setMode(stored ?? initialMode);
  }, [open, initialMode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist on toggle (fire-and-forget — the local cache update is what
  // matters for UX; the server write is best-effort).
  const handleModeChange = useCallback((next: CreationMode) => {
    setMode((prev) => {
      if (prev === next) return prev;
      void setPreferredCreationMode(next).catch(() => {
        /* swallow — local cache already updated */
      });
      return next;
    });
    // Mode change resets step indicator (we may be deep in Simple step 2
    // when the user flips to Pro — switching back should start fresh).
    setSimpleStep(0);
  }, []);

  // Step 0 → 1 transition is gated on both industry + size selected.
  // Step 1 → 2 transition is gated on at least one role selected.
  // Step 2 owns its own UI (provisioning loader); the footer hides there.
  const canAdvance = useMemo(() => {
    if (simpleStep === 0) return simpleIndustry !== null && simpleSize !== null;
    if (simpleStep === 1) return simpleSelectedSlugs.size > 0;
    return false;
  }, [simpleStep, simpleIndustry, simpleSize, simpleSelectedSlugs]);

  // Footer primary action — routes by mode + step. Pro mode's submit is
  // owned by each sub-panel (B3.5), so the shell-level button is a no-op
  // there.
  const handlePrimary = useCallback(() => {
    if (mode !== 'simple') return;
    if (!canAdvance) return;
    if (simpleStep < 2) {
      setSimpleStep((p) => (p + 1) as 0 | 1 | 2);
    }
  }, [mode, simpleStep, canAdvance]);

  // Step 3 provisioning plan — only valid once industry + size + ≥1 slug
  // are all set. The renderTemplate call resolves the rendered roles in
  // the order CEO-first, matching the use-simple-provisioning contract.
  const simplePlan = useMemo<SimpleProvisioningPlan | null>(() => {
    if (!simpleIndustry || !simpleSize) return null;
    if (simpleSelectedSlugs.size === 0) return null;
    try {
      const rendered = renderTemplate(simpleIndustry, simpleSize, 'zh');
      const roles: RenderedRole[] = rendered.filter((r) => simpleSelectedSlugs.has(r.slug));
      if (roles.length === 0) return null;
      // Build the username map from the user's drafts (Step 2). Fallback to
      // the seed of displayName, then to role.slug verbatim — never mint a
      // random suffix here (Task 3 — Discord-2023 lesson).
      const usernames: Record<string, string> = {};
      for (const r of roles) {
        const draft = simpleSlugDrafts[r.slug]?.trim();
        usernames[r.slug] = draft && draft.length > 0 ? draft : suggestUsernameSeed(r.displayName) || r.slug;
      }
      return {
        workspaceId,
        roles,
        usernames,
        conversationTitle: '团队会议',
        // P3-7 — feed the same probe result the Step 2 counter shows to the
        // provisioning hook's device-reuse decision. When the probe found a
        // spare device the hook will reuse it (and pass its daemonId so the
        // server-side capacity guard fires against the right row); when null
        // the hook falls back to a live list query or fresh provision.
        preferredInstallation: deviceCapacity?.installation ?? null,
      };
    } catch {
      return null;
    }
  }, [simpleIndustry, simpleSize, simpleSelectedSlugs, simpleSlugDrafts, workspaceId, deviceCapacity]);

  const handleStep3Success = useCallback(
    (res: { conversationId: string; agentIds: string[] }) => {
      onCreated({ kind: 'simple-team', agentIds: res.agentIds, conversationId: res.conversationId });
      onOpenChange(false);
    },
    [onCreated, onOpenChange],
  );

  const handleStep3Cancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Task 3 — when an agent register hits 409 on Step 3, store the message
  // against the offending role so Step 2 can render an inline error.
  const handleSlugConflict = useCallback((roleSlug: string, message: string) => {
    setSimpleSlugErrors((prev) => ({ ...prev, [roleSlug]: message }));
    setSimpleSlugConflict({ roleSlug, message });
  }, []);

  // P3-7 — capacity 409. The hook surfaces this separately from slug-conflict
  // because the resolution is different: the user can't fix it by editing
  // handles; they need to upgrade / free a slot. Lifted state survives back
  // navigation to Step 2 so the inline error keeps explaining why Step 3
  // failed even if the user wanders back.
  const handleCapacityExceeded = useCallback((used: number, max: number, message: string) => {
    setSimpleCapacityError({ used, max, message });
  }, []);

  // Drop the user back on Step 2 (the team review step) so they can edit
  // the conflicting handle.
  const handleStep3Back = useCallback(() => {
    setSimpleStep(1);
  }, []);

  // Editing a row's slug input clears its previous server-side error.
  const handleSlugChange = useCallback((roleSlug: string, next: string) => {
    setSimpleSlugDrafts((prev) => ({ ...prev, [roleSlug]: next }));
    setSimpleSlugErrors((prev) => {
      if (!prev[roleSlug]) return prev;
      const copy = { ...prev };
      delete copy[roleSlug];
      return copy;
    });
    setSimpleSlugConflict((prev) => (prev?.roleSlug === roleSlug ? null : prev));
  }, []);

  // Hoisted provisioning hook — survives Step 2 ↔ 3 navigation so already-
  // registered agents are NOT re-fetched (and therefore won't 409 on
  // themselves) after the user fixes a conflicting handle. The hook itself
  // gates on `plan` being non-null; we pass `simplePlan` (null until ready).
  const provisioning = useSimpleProvisioning(simplePlan, {
    onSlugConflict: handleSlugConflict,
    onCapacityExceeded: handleCapacityExceeded,
  });

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <AnimatePresence>
          {open ? (
            <Fragment>
              {/* ── Overlay ─────────────────────────────────────── */}
              <DialogPrimitive.Overlay asChild>
                <motion.div
                  data-testid="unified-creation-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? REDUCED : { duration: 0.2, ease: 'easeOut' }}
                  className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
                />
              </DialogPrimitive.Overlay>

              {/* ── Container + Modal box ──────────────────────── */}
              <DialogPrimitive.Content
                asChild
                aria-describedby={undefined}
                onOpenAutoFocus={(e) => {
                  // Prevent Radix auto-focusing the close button — let
                  // users tab into the toggle naturally. Visual fidelity
                  // beats default focus heuristic here.
                  e.preventDefault();
                }}
              >
                <div className="fixed inset-0 z-50 grid place-items-center pointer-events-none">
                  <motion.div
                    data-testid="unified-creation-modal"
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 12 }}
                    transition={reduce ? REDUCED : tHeavy}
                    onClick={(e) => e.stopPropagation()}
                    className={`pointer-events-auto flex w-[clamp(420px,56vw,720px)] max-h-[88vh] flex-col overflow-hidden border ${s(
                      theme,
                      'modal',
                    )} ${radius.pane}`}
                  >
                    {/* a11y: required by Radix Dialog. Visually hidden — the
                        mode toggle in the header already labels the dialog
                        for sighted users. */}
                    <DialogPrimitive.Title asChild>
                      <span className="sr-only">Create</span>
                    </DialogPrimitive.Title>

                    {/* ── Header (sticky top, ~h-60) ───────────── */}
                    <header
                      className={`sticky top-0 z-10 flex h-[60px] shrink-0 items-center gap-3 border-b px-4 ${
                        isDark ? 'border-white/[0.06]' : 'border-zinc-200'
                      }`}
                    >
                      <DialogPrimitive.Close asChild>
                        <button
                          type="button"
                          data-testid="unified-creation-close"
                          aria-label="Close"
                          className={`inline-flex h-8 w-8 items-center justify-center ${radius.button} ${
                            isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-100'
                          }`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </DialogPrimitive.Close>

                      <div className="flex-1 flex justify-center">
                        <ModeToggle mode={mode} onChange={handleModeChange} isDark={isDark} transition={tSnap} />
                      </div>

                      {/* Right-side ⋯ menu slot removed pending B3.2 — no
                          inert affordances. Spacer keeps the toggle centered
                          relative to the close button on the left. */}
                      <div aria-hidden className="h-8 w-8" />
                    </header>

                    {/* ── Step indicator (Simple only, ~h-32) ──── */}
                    <AnimatePresence initial={false}>
                      {mode === 'simple' ? (
                        <motion.div
                          key="step-indicator"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 32 }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={tSnap}
                          className={`flex shrink-0 items-center justify-center gap-3 overflow-hidden border-b text-xs ${
                            isDark ? 'border-white/[0.04] text-zinc-400' : 'border-zinc-200 text-zinc-500'
                          }`}
                          data-testid="unified-creation-step-indicator"
                        >
                          <StepDots active={simpleStep} isDark={isDark} transition={tSnap} />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    {/* ── Content area (flex-1, overflow-y-auto) ─ */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={mode}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={tSoft}
                          data-testid={`unified-creation-content-${mode}`}
                        >
                          {mode === 'simple' ? (
                            <SimpleFlowSwitch
                              isDark={isDark}
                              step={simpleStep}
                              industry={simpleIndustry}
                              size={simpleSize}
                              onIndustrySizeChange={(nextIndustry, nextSize) => {
                                setSimpleIndustry(nextIndustry);
                                setSimpleSize(nextSize);
                              }}
                              selectedSlugs={simpleSelectedSlugs}
                              onSelectionChange={setSimpleSelectedSlugs}
                              slugDrafts={simpleSlugDrafts}
                              slugErrors={simpleSlugErrors}
                              onSlugChange={handleSlugChange}
                              deviceMaxAgents={deviceCapacity?.maxAgents ?? FALLBACK_DEVICE_MAX_AGENTS}
                              plan={simplePlan}
                              provisioning={provisioning}
                              slugConflict={simpleSlugConflict}
                              capacityError={simpleCapacityError}
                              onStep3Success={handleStep3Success}
                              onStep3Cancel={handleStep3Cancel}
                              onStep3SlugConflict={handleSlugConflict}
                              onStep3CapacityExceeded={handleCapacityExceeded}
                              onStep3Back={handleStep3Back}
                            />
                          ) : (
                            <ProModeFlow
                              isDark={isDark}
                              workspaceId={workspaceId}
                              agents={agents}
                              profiles={profiles}
                              onCreated={(event) => {
                                onCreated(event);
                                onOpenChange(false);
                              }}
                            />
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* ── Footer (sticky bottom, ~h-72) ──────────
                        Simple mode owns the shell-level Back/Next for Step 0/1.
                        Step 2 hides the footer — the provisioning loader owns
                        its own cancel/retry/skip controls. Pro mode renders no
                        footer here — B3.5's per-tile panel owns its own
                        action area. */}
                    {mode === 'simple' && simpleStep < 2 ? (
                      <footer
                        className={`sticky bottom-0 z-10 flex h-[72px] shrink-0 items-center justify-end gap-2 border-t px-5 ${
                          isDark ? 'border-white/[0.06] bg-zinc-950/40' : 'border-zinc-200 bg-white/60'
                        }`}
                      >
                        {simpleStep > 0 ? (
                          <FooterButton
                            isDark={isDark}
                            variant="ghost"
                            onClick={() => setSimpleStep((p) => (p > 0 ? ((p - 1) as 0 | 1 | 2) : p))}
                            data-testid="unified-creation-back"
                          >
                            Back
                          </FooterButton>
                        ) : null}

                        <FooterButton
                          isDark={isDark}
                          variant="primary"
                          onClick={handlePrimary}
                          disabled={!canAdvance}
                          aria-disabled={!canAdvance}
                          data-testid="unified-creation-next"
                          style={!canAdvance ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                        >
                          Next
                        </FooterButton>
                      </footer>
                    ) : null}
                  </motion.div>
                </div>
              </DialogPrimitive.Content>
            </Fragment>
          ) : null}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default UnifiedCreationModal;

// ───────────────────────── Simple-flow router ─────────────────────────
//
// Inline switch component that routes Step 0/1/2 inside the modal's content
// area. Kept local to the modal because it's tightly coupled to the shell's
// state shape (industry/size/slug controls + plan) — exporting it would
// require duplicating the prop surface.
function SimpleFlowSwitch({
  isDark,
  step,
  industry,
  size,
  onIndustrySizeChange,
  selectedSlugs,
  onSelectionChange,
  slugDrafts,
  slugErrors,
  onSlugChange,
  deviceMaxAgents,
  plan,
  provisioning,
  slugConflict,
  capacityError,
  onStep3Success,
  onStep3Cancel,
  onStep3SlugConflict,
  onStep3CapacityExceeded,
  onStep3Back,
}: {
  isDark: boolean;
  step: 0 | 1 | 2;
  industry: IndustryKey | null;
  size: SizeKey | null;
  onIndustrySizeChange: (industry: IndustryKey | null, size: SizeKey | null) => void;
  selectedSlugs: Set<string>;
  onSelectionChange: (slugs: Set<string>) => void;
  slugDrafts: Record<string, string>;
  slugErrors: Record<string, string | null>;
  onSlugChange: (roleSlug: string, next: string) => void;
  deviceMaxAgents: number;
  plan: SimpleProvisioningPlan | null;
  provisioning: ReturnType<typeof useSimpleProvisioning>;
  slugConflict: { roleSlug: string; message: string } | null;
  capacityError: { used: number; max: number; message: string } | null;
  onStep3Success: (result: { conversationId: string; agentIds: string[] }) => void;
  onStep3Cancel: () => void;
  onStep3SlugConflict: (roleSlug: string, message: string) => void;
  onStep3CapacityExceeded: (used: number, max: number, message: string) => void;
  onStep3Back: () => void;
}) {
  if (step === 0) {
    return (
      <SimpleStep1Industry
        isDark={isDark}
        initialIndustry={industry ?? undefined}
        initialSize={size ?? undefined}
        onSelectionChange={onIndustrySizeChange}
      />
    );
  }
  if (step === 1) {
    // Defensive — should never hit; canAdvance gates step transition.
    if (!industry || !size) return null;
    return (
      <SimpleStep2Team
        isDark={isDark}
        industry={industry}
        size={size}
        selectedSlugs={selectedSlugs}
        onSelectionChange={onSelectionChange}
        slugDrafts={slugDrafts}
        slugErrors={slugErrors}
        onSlugChange={onSlugChange}
        deviceMaxAgents={deviceMaxAgents}
      />
    );
  }
  // step === 2 — provisioning loader. Plan must be ready here; if it isn't
  // (race condition / unknown industry pair) fall back to cancel.
  if (!plan) {
    return (
      <div className={`p-6 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
        <p>无法构建配置计划,请返回上一步重新选择。</p>
      </div>
    );
  }
  return (
    <SimpleStep3Launch
      isDark={isDark}
      plan={plan}
      provisioning={provisioning}
      slugConflict={slugConflict}
      capacityError={capacityError}
      onSuccess={onStep3Success}
      onCancel={onStep3Cancel}
      onSlugConflict={onStep3SlugConflict}
      onCapacityExceeded={onStep3CapacityExceeded}
      onBack={onStep3Back}
    />
  );
}
