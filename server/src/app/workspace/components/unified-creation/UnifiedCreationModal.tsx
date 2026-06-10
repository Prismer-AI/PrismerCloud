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

import { useI18n } from '@/contexts/i18n-context';

import { radius, s, springHeavy, springSnap, springSoft } from '../../lib/design';
import {
  loadPreferredCreationMode,
  setPreferredCreationMode,
  suggestUsernameSeed,
  type CreationMode,
} from '../../lib/mutations';
import { getAvailableRoles, renderTemplate } from '../../lib/templates/render';
import type { IndustryKey, RenderedRole, SizeKey } from '../../lib/templates/types';
import type { AgentDTO, AgentProfileDTO, AssetDTO, RuntimeInstallationDTO } from '../../lib/types';
import { imFetch, getWorkspaceToken } from '../../lib/im-api';
import { createProject } from '../../lib/projects-api';
import { FooterButton, ModeToggle, StepDots } from './parts';
import { ProModeFlow } from './ProModeFlow';
import { SimpleStep1Industry } from './SimpleStep1Industry';
import { SimpleStep2Team } from './SimpleStep2Team';
import { SimpleStep3Launch } from './SimpleStep3Launch';
import { SimpleStepUpload } from './SimpleStepUpload';
import { useSimpleProvisioning, type SimpleProvisioningPlan } from './use-simple-provisioning';
import { DEFAULT_MODEL } from './pro/profile-config';
import { getDefaultModelForProvider, type ProviderChainDefault } from '../../lib/model-defaults';
import type { ProxyProvider } from '../proxy-provider-select';

// ───────────────────────── Public types ─────────────────────────

// Discriminated union + context hooks are defined in `./context.ts` so child
// step components can import them without forming a circular dependency with
// this parent module. We re-export the public names here for back-compat.
export { type UnifiedCreationEvent, useDeviceSelector, useWorkspaceId } from './context';
import { DeviceSelCtx, WsCtx, type UnifiedCreationEvent } from './context';

export interface UnifiedCreationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  workspaceId: string;
  /**
   * Existing organization name on this workspace (workspace ↔ organization
   * is 1:1). When non-empty, Simple-mode Step 1 surfaces it as a read-only
   * badge instead of asking the user to retype.
   */
  existingOrganizationName?: string | null;
  /** Shared state for child flows (Pro Conversation / Pro Task). */
  agents: AgentDTO[];
  /** Shared state for child flows (Pro Task). */
  profiles: AgentProfileDTO[];
  /** Single discriminated callback — parent demuxes by `event.kind`. */
  onCreated: (event: UnifiedCreationEvent) => void;
  /** Defaults to 'simple'. Persisted preference (if any) wins on open. */
  initialMode?: CreationMode;
  /**
   * release201 v2.0.8 F-bug — project 抽象引导. 当前 ProjectSwitcher 选中
   * 的项目 id (null / 'all' / '__unscoped' 都视为 workspace 级别), 用于在
   * 创建流程顶部显示 "正在为项目 X 创建" 上下文条; null/sentinel 时显示
   * "未归入项目" + "先创建项目" inline link.
   */
  activeProjectId?: string | null;
  /** 当前 active project 的 name (id 命中真实项目时传入). */
  activeProjectName?: string | null;
  /** 用户点击 "先创建项目" 时触发 — 通常打开 ProjectSwitcher 的 new-project flow. */
  onCreateProject?: () => void;
  /**
   * 2026-05-29 — full project list (active only) for the inline picker
   * shown in the banner. When omitted the banner falls back to the
   * label-only mode that was here before.
   */
  projects?: Array<{ id: string; name: string }>;
  /**
   * 2026-05-29 — setter for the modal's active project context. Called
   * with the project id (or null for unscoped) when the user picks a
   * different project mid-flow. Omitting it locks the banner to
   * label-only.
   */
  onActiveProjectIdChange?: (id: string | null) => void;
  /**
   * 2026-05-29 — reload trigger for the project list. Called after the
   * inline-create flow successfully mints a new project so the parent's
   * useProjects() hook re-fetches and the new row shows up in the
   * picker without forcing the user to reopen the modal.
   */
  onReloadProjects?: () => Promise<void> | void;
}

function deriveProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64);
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
// Bumped from 3 → 10 (2026-05-19) — base subscription policy update, see
// migration 340 + register.ts fallback.
const FALLBACK_DEVICE_MAX_AGENTS = 10;

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
  existingOrganizationName,
  agents,
  profiles,
  onCreated,
  initialMode = 'simple',
  activeProjectId,
  activeProjectName,
  onCreateProject,
  projects,
  onActiveProjectIdChange,
  onReloadProjects,
}: UnifiedCreationModalProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tHeavy: Transition = reduce ? REDUCED : springHeavy;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;
  const { t } = useI18n();

  // release201 v2.0.8 F-bug — project 抽象引导. activeProjectId 是 ProjectSwitcher
  // 选中的 id (null / 'all' / '__unscoped' 都视为 workspace 级别). 创建出来的资源
  // 会按 use-simple-provisioning §M448 / Pro mode 各自的逻辑落到当前 project,
  // 因此用户必须先感知到 scope. 见 release201/20 Gap B (创建逻辑接 project 抽象).
  const isProjectScoped = Boolean(activeProjectId && activeProjectId !== 'all' && activeProjectId !== '__unscoped');

  // 2026-05-29 — inline project create. When the user picks "+ 先创建项目"
  // from the picker, switch the banner into a tiny inline form (name input
  // + create/cancel buttons) instead of bouncing to ProjectSwitcher behind
  // the modal. createProject() then runs in-place; success calls
  // onReloadProjects() so the new id shows up next time the picker reads
  // its list, and we eagerly setActiveProjectIdChange(newId) so the user
  // immediately sees the new scope in the banner.
  const [inlineCreatingProject, setInlineCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  const handleInlineCreateProject = useCallback(async () => {
    if (!workspaceId) return;
    const name = newProjectName.trim();
    if (!name) {
      setCreateProjectError(t('workspace.project.nameRequired'));
      return;
    }
    const slug = deriveProjectSlug(name);
    if (!slug) {
      setCreateProjectError(t('workspace.project.nameNeedsLetter'));
      return;
    }
    setCreatingProject(true);
    setCreateProjectError(null);
    try {
      const res = await createProject({ workspaceId, slug, name });
      if (res.ok && res.data) {
        const newId = res.data.id;
        await onReloadProjects?.();
        onActiveProjectIdChange?.(newId);
        setInlineCreatingProject(false);
        setNewProjectName('');
      } else if (!res.ok) {
        setCreateProjectError(res.message || t('workspace.project.createFailed'));
      }
    } catch (err) {
      setCreateProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProject(false);
    }
  }, [workspaceId, newProjectName, onReloadProjects, onActiveProjectIdChange, t]);

  // Mode + step state. Mode persists; step resets on close/mode-change.
  //
  // Task 42 — simple-mode is now 4 steps: 0 Industry → 1 Team → 2 Upload → 3 Launch.
  const [mode, setMode] = useState<CreationMode>(initialMode);
  const [simpleStep, setSimpleStep] = useState<0 | 1 | 2 | 3>(0);

  // Simple-mode flow state (industry + size + selected role slugs). These
  // live on the shell so the back-button can survive remounts of the inner
  // step components, and so they reset when the modal closes.
  const [simpleOrganizationName, setSimpleOrganizationName] = useState('');
  const [simpleModel, setSimpleModel] = useState(DEFAULT_MODEL);
  // 2026-05-30 — per-agent LLM proxy provider for every Hermes profile minted
  // in this Simple-mode run. Lives on the shell (not Step 1 local state) so
  // it survives Back/Next navigation and feeds into `simplePlan.proxyProvider`
  // for `use-simple-provisioning` to write into every AgentProfile's config.
  // Default `newapi` matches the daemon-side zod default in
  // HermesProfileConfigSchema.proxyProvider.
  const [simpleProxyProvider, setSimpleProxyProvider] = useState<ProxyProvider>('newapi');
  // release202/12 C1 — fetched provider-chain list (each carries
  // `primaryDefaultModel`). Feeds `getDefaultModelForProvider` so switching to
  // a CUSTOM chain resets the model to that chain's real default instead of
  // `undefined`. Built-in defaults still apply before this resolves.
  const [providerChains, setProviderChains] = useState<ProviderChainDefault[]>([]);
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
  const [simpleBrowserRoles, setSimpleBrowserRoles] = useState<RenderedRole[]>([]);

  // Task 42 — company-materials upload step state. `simpleUploadedAssets` is the
  // full AssetDTO list (used by post-provisioning to compose an attachment
  // message); `simpleUploadedAssetIds` is the parallel string[] surfaced to
  // the page.tsx `simple-team` event for downstream wiring. They are kept in
  // lockstep — see the `onAssetUploaded` / `onAssetRemoved` handlers below.
  const [simpleUploadedAssets, setSimpleUploadedAssets] = useState<AssetDTO[]>([]);
  const [simpleUploadedAssetIds, setSimpleUploadedAssetIds] = useState<string[]>([]);

  // P3-7 — device capacity probe. Resolved on Step 2 entry (idempotent — keyed
  // on `workspaceId + open` so it runs once per modal session). Null while the
  // probe is in-flight; populated with a real number from the API or the
  // {@link FALLBACK_DEVICE_MAX_AGENTS} fallback when the probe fails / no
  // candidate exists. Step 2's counter and Step 3's reuse logic both read off
  // this so the two surfaces never disagree.
  const [deviceCapacity, setDeviceCapacity] = useState<DeviceCapacityProbe | null>(null);

  // Stable callback for DeviceSelCtx — prevents re-render churn in consumers.
  const handleDeviceSelected = useCallback((deviceId: string, daemonId: string, maxAgents: number) => {
    setDeviceCapacity({ installation: { id: deviceId, daemonId, used: 0, maxAgents }, maxAgents });
  }, []);

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

  useEffect(() => {
    if (!open) {
      hydratedFor.current = false;
      setSimpleStep(0);
      setSimpleOrganizationName('');
      setSimpleModel(DEFAULT_MODEL);
      setSimpleProxyProvider('newapi');
      setSimpleIndustry(null);
      setSimpleSize(null);
      setSimpleSelectedSlugs(new Set());
      setSimpleSlugDrafts({});
      setSimpleSlugErrors({});
      setSimpleSlugConflict(null);
      setSimpleBrowserRoles([]);
      setSimpleUploadedAssets([]);
      setSimpleUploadedAssetIds([]);
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

  // release202/12 C1 — fetch the configured chain list once the modal opens so
  // `getDefaultModelForProvider` can resolve a CUSTOM chain's real default model
  // (each chain carries `primaryDefaultModel`). Mirrors the fetch in
  // ProxyProviderSelect; tolerant of failure (built-in defaults still apply).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const token = getWorkspaceToken();
    fetch('/api/provider-chains', { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((res) => (res.ok ? res.json() : Promise.reject(String(res.status))))
      .then((body: { chains?: ProviderChainDefault[] }) => {
        if (cancelled) return;
        if (Array.isArray(body.chains)) setProviderChains(body.chains);
      })
      .catch(() => {
        /* keep built-in defaults */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 2026-05-30 — proxyProvider × model 紧耦合. Simple wizard 切 proxyProvider
  // (Step 1 AdvancedProxyAccordion) 时 model 自动 reset 到该 provider 漏斗的
  // default. prev-value ref 保证只在「真切换」时触发, 不把 open reset / 初次
  // mount 已经设过的 model 又冲掉一次. 模态关闭后 ref 归位, 下次开始重新比.
  // 2026-06-06 (C1) — 传 providerChains 让自定义 chain 也拿到真实 default。
  const prevSimpleProxyProviderRef = useRef<ProxyProvider | null>(null);
  useEffect(() => {
    if (!open) {
      prevSimpleProxyProviderRef.current = null;
      return;
    }
    if (prevSimpleProxyProviderRef.current === null) {
      prevSimpleProxyProviderRef.current = simpleProxyProvider;
      return;
    }
    if (prevSimpleProxyProviderRef.current === simpleProxyProvider) return;
    prevSimpleProxyProviderRef.current = simpleProxyProvider;
    setSimpleModel(getDefaultModelForProvider(simpleProxyProvider, providerChains));
  }, [open, simpleProxyProvider, providerChains]);

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
  // Step 2 (Upload, Task 42) renders its own continue/skip buttons inside the
  // content area — the shell footer is hidden on Step 2+.
  // Step 3 owns its own UI (provisioning loader); the footer hides there too.
  const canAdvance = useMemo(() => {
    if (simpleStep === 0)
      return simpleOrganizationName.trim().length > 0 && simpleIndustry !== null && simpleSize !== null;
    if (simpleStep === 1) return simpleSelectedSlugs.size > 0;
    return false;
  }, [simpleStep, simpleOrganizationName, simpleIndustry, simpleSize, simpleSelectedSlugs]);

  // Footer primary action — routes by mode + step. Pro mode's submit is
  // owned by each sub-panel (B3.5), so the shell-level button is a no-op
  // there.
  const handlePrimary = useCallback(() => {
    if (mode !== 'simple') return;
    if (!canAdvance) return;
    if (simpleStep < 2) {
      setSimpleStep((p) => (p + 1) as 0 | 1 | 2 | 3);
    }
  }, [mode, simpleStep, canAdvance]);

  // Step 3 provisioning plan — only valid once industry + size + ≥1 slug
  // are all set. The renderTemplate call resolves the rendered roles in
  // the order CEO-first, matching the use-simple-provisioning contract.
  const simplePlan = useMemo<SimpleProvisioningPlan | null>(() => {
    const organizationName = simpleOrganizationName.trim();
    if (!organizationName) return null;
    if (!simpleIndustry || !simpleSize) return null;
    if (simpleSelectedSlugs.size === 0) return null;
    try {
      const recommended = renderTemplate(simpleIndustry, simpleSize, 'zh');
      const localAvailable = getAvailableRoles(simpleIndustry, simpleSize, 'zh');
      const seen = new Set<string>();
      const catalog = [...recommended, ...localAvailable, ...simpleBrowserRoles].filter((role) => {
        if (seen.has(role.slug)) return false;
        seen.add(role.slug);
        return true;
      });
      const roles: RenderedRole[] = catalog.filter((r) => simpleSelectedSlugs.has(r.slug));
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
        organizationName,
        model: simpleModel.trim() || DEFAULT_MODEL,
        // 2026-05-30 — Simple wizard 的 proxyProvider 高级选项 (Step 1
        // AdvancedProxyAccordion)。透给 use-simple-provisioning 后,
        // `buildSimpleProfileConfig` 写进每条 AgentProfile.config.
        proxyProvider: simpleProxyProvider,
        roles,
        usernames,
        conversationTitle: '团队会议',
        // P3-7 — feed the same probe result the Step 2 counter shows to the
        // provisioning hook's device-reuse decision. When the probe found a
        // spare device the hook will reuse it (and pass its daemonId so the
        // server-side capacity guard fires against the right row); when null
        // the hook falls back to a live list query or fresh provision.
        preferredInstallation: deviceCapacity?.installation ?? null,
        // Task 42 — drive the new "attach materials" provisioning step. The
        // hook reads this through `planRef`, so edits between Step 2 (upload)
        // and Step 3 (launch) don't churn the steps array. Empty list → step
        // is a no-op (silently skipped, no message posted).
        uploadedAssets: simpleUploadedAssets,
      };
    } catch {
      return null;
    }
  }, [
    simpleOrganizationName,
    simpleModel,
    simpleProxyProvider,
    simpleIndustry,
    simpleSize,
    simpleSelectedSlugs,
    simpleSlugDrafts,
    simpleBrowserRoles,
    workspaceId,
    deviceCapacity,
    simpleUploadedAssets,
  ]);

  const handleStep3Success = useCallback(
    (res: { conversationId: string; agentIds: string[] }) => {
      onCreated({
        kind: 'simple-team',
        agentIds: res.agentIds,
        conversationId: res.conversationId,
        organizationName: simpleOrganizationName.trim() || undefined,
        // Task 42 — empty array stays empty (no `undefined`) so downstream
        // consumers can rely on `Array.isArray(uploadedAssetIds)`.
        uploadedAssetIds: simpleUploadedAssetIds,
      });
      onOpenChange(false);
    },
    [onCreated, onOpenChange, simpleOrganizationName, simpleUploadedAssetIds],
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

                    {/* ── Project context strip (release201 v2.0.8 F-bug) ──
                        让用户在 Simple / Pro 两种 flow 都先感知到自己正在为
                        哪个 project 创建.

                        release201 v2.0.8 follow-up — Simple mode 现在会在
                        runFrom() 启动时自动 POST /projects 创建 "{org} 主项目",
                        因此 unscoped 文案改成 "将自动创建主项目", 不再露出
                        "先创建项目 →" inline link (那是 simple mode 的反语义).
                        Pro mode 维持现行 explicit-link 行为, 让 power user
                        显式选 / 建 project. 见 docs/release201/20 §F-bug. */}
                    <div
                      data-testid="unified-creation-project-context"
                      data-project-scope={isProjectScoped ? 'project' : 'workspace'}
                      data-mode={mode}
                      className={`shrink-0 border-b px-5 py-2 text-xs ${
                        isProjectScoped
                          ? isDark
                            ? 'border-white/[0.04] bg-violet-500/[0.08] text-violet-200'
                            : 'border-zinc-200 bg-violet-50/60 text-violet-800'
                          : isDark
                            ? 'border-white/[0.04] bg-white/[0.02] text-zinc-400'
                            : 'border-zinc-200 bg-zinc-50/60 text-zinc-600'
                      }`}
                    >
                      {/* 2026-05-29 — inline project picker (release201/20 Gap B).
                          Previously this banner was a label-only "正在为项目 X
                          创建" surface; users had no way to change scope mid
                          flow without leaving the modal. When `projects` +
                          `onActiveProjectIdChange` are supplied, we render a
                          real picker that lists every active project + an
                          unscoped option + an inline "新建项目" trigger.
                          Falls back to the legacy label when the parent
                          didn't wire the new props. */}
                      {projects && onActiveProjectIdChange ? (
                        inlineCreatingProject ? (
                          // Inline create form — runs createProject in-place
                          // so the user never leaves the modal.
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="shrink-0">
                              {t('workspace.unifiedCreation.projectContext.pickerLabel')}
                            </span>
                            <input
                              data-testid="unified-creation-project-inline-name"
                              autoFocus
                              type="text"
                              value={newProjectName}
                              onChange={(e) => {
                                setNewProjectName(e.target.value);
                                if (createProjectError) setCreateProjectError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !creatingProject) {
                                  e.preventDefault();
                                  void handleInlineCreateProject();
                                } else if (e.key === 'Escape') {
                                  setInlineCreatingProject(false);
                                  setNewProjectName('');
                                  setCreateProjectError(null);
                                }
                              }}
                              placeholder={t('workspace.project.namePlaceholder')}
                              disabled={creatingProject}
                              className={`h-7 flex-1 min-w-[160px] rounded-md border px-2 text-xs outline-none disabled:opacity-50 ${
                                isDark
                                  ? 'border-white/[0.08] bg-zinc-900/40 text-zinc-200'
                                  : 'border-zinc-200 bg-white/80 text-zinc-700'
                              }`}
                            />
                            <button
                              type="button"
                              data-testid="unified-creation-project-inline-confirm"
                              onClick={() => void handleInlineCreateProject()}
                              disabled={creatingProject || !newProjectName.trim()}
                              className={`h-7 rounded-md px-2 text-xs font-medium disabled:opacity-50 ${
                                isDark
                                  ? 'bg-violet-500/30 text-violet-100 hover:bg-violet-500/40'
                                  : 'bg-violet-600 text-white hover:bg-violet-700'
                              }`}
                            >
                              {creatingProject ? t('workspace.project.creating') : t('workspace.project.create')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setInlineCreatingProject(false);
                                setNewProjectName('');
                                setCreateProjectError(null);
                              }}
                              disabled={creatingProject}
                              className={`h-7 rounded-md px-2 text-xs disabled:opacity-50 ${
                                isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'
                              }`}
                            >
                              {t('common.cancel')}
                            </button>
                            {createProjectError ? (
                              <span className={`text-[11px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>
                                {createProjectError}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="shrink-0">
                              {t('workspace.unifiedCreation.projectContext.pickerLabel')}
                            </span>
                            <select
                              data-testid="unified-creation-project-picker"
                              value={
                                activeProjectId && activeProjectId !== 'all' && activeProjectId !== '__unscoped'
                                  ? activeProjectId
                                  : '__unscoped'
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === '__new__') {
                                  setInlineCreatingProject(true);
                                  return;
                                }
                                onActiveProjectIdChange(v === '__unscoped' ? null : v);
                              }}
                              className={`h-7 rounded-md border px-2 text-xs ${
                                isDark
                                  ? 'border-white/[0.08] bg-zinc-900/40 text-zinc-200'
                                  : 'border-zinc-200 bg-white/80 text-zinc-700'
                              }`}
                            >
                              <option value="__unscoped">
                                {t('workspace.unifiedCreation.projectContext.unscopedOption')}
                              </option>
                              {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                              <option value="__new__">
                                + {t('workspace.unifiedCreation.projectContext.createCta')}
                              </option>
                            </select>
                            {!isProjectScoped && mode === 'simple' ? (
                              <span
                                data-testid="unified-creation-project-context-simple-auto"
                                className={`opacity-75 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                              >
                                · {t('workspace.unifiedCreation.projectContext.simpleAuto')}
                              </span>
                            ) : null}
                          </div>
                        )
                      ) : isProjectScoped ? (
                        <span>
                          {t('workspace.unifiedCreation.projectContext.scoped', {
                            projectName: activeProjectName ?? '...',
                          })}
                        </span>
                      ) : mode === 'simple' ? (
                        <span data-testid="unified-creation-project-context-simple-auto">
                          {t('workspace.unifiedCreation.projectContext.simpleAuto')}
                        </span>
                      ) : (
                        <span>
                          {t('workspace.unifiedCreation.projectContext.unscoped')}
                          {onCreateProject ? (
                            <button
                              type="button"
                              onClick={onCreateProject}
                              data-testid="unified-creation-project-context-create"
                              className={`ml-1 underline-offset-2 hover:underline ${
                                isDark ? 'text-violet-300' : 'text-violet-700'
                              }`}
                            >
                              {t('workspace.unifiedCreation.projectContext.createCta')} →
                            </button>
                          ) : null}
                        </span>
                      )}
                    </div>

                    {/* ── Content area (flex-1, overflow-y-auto) ─ */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                      <WsCtx.Provider value={workspaceId}>
                        <DeviceSelCtx.Provider value={handleDeviceSelected}>
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
                                  workspaceId={workspaceId}
                                  organizationName={simpleOrganizationName}
                                  lockedOrganizationName={existingOrganizationName ?? null}
                                  industry={simpleIndustry}
                                  size={simpleSize}
                                  model={simpleModel}
                                  proxyProvider={simpleProxyProvider}
                                  onOrganizationNameChange={setSimpleOrganizationName}
                                  onModelChange={setSimpleModel}
                                  onProxyProviderChange={setSimpleProxyProvider}
                                  onIndustrySizeChange={(nextIndustry, nextSize) => {
                                    setSimpleIndustry(nextIndustry);
                                    setSimpleSize(nextSize);
                                    setSimpleBrowserRoles([]);
                                  }}
                                  selectedSlugs={simpleSelectedSlugs}
                                  onSelectionChange={setSimpleSelectedSlugs}
                                  onRoleCatalogChange={setSimpleBrowserRoles}
                                  slugDrafts={simpleSlugDrafts}
                                  slugErrors={simpleSlugErrors}
                                  onSlugChange={handleSlugChange}
                                  deviceMaxAgents={deviceCapacity?.maxAgents ?? FALLBACK_DEVICE_MAX_AGENTS}
                                  plan={simplePlan}
                                  provisioning={provisioning}
                                  slugConflict={simpleSlugConflict}
                                  capacityError={simpleCapacityError}
                                  uploadedAssetIds={simpleUploadedAssetIds}
                                  onAssetUploaded={(asset) => {
                                    setSimpleUploadedAssets((prev) => [...prev, asset]);
                                    setSimpleUploadedAssetIds((prev) => [...prev, asset.id]);
                                  }}
                                  onAssetRemoved={(id) => {
                                    setSimpleUploadedAssets((prev) => prev.filter((a) => a.id !== id));
                                    setSimpleUploadedAssetIds((prev) => prev.filter((aid) => aid !== id));
                                  }}
                                  onUploadSkip={() => setSimpleStep(3)}
                                  onUploadContinue={() => setSimpleStep(3)}
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
                        </DeviceSelCtx.Provider>
                      </WsCtx.Provider>
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
                            onClick={() => setSimpleStep((p) => (p > 0 ? ((p - 1) as 0 | 1 | 2 | 3) : p))}
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
  workspaceId,
  organizationName,
  lockedOrganizationName,
  industry,
  size,
  model,
  proxyProvider,
  onOrganizationNameChange,
  onModelChange,
  onProxyProviderChange,
  onIndustrySizeChange,
  selectedSlugs,
  onSelectionChange,
  onRoleCatalogChange,
  slugDrafts,
  slugErrors,
  onSlugChange,
  deviceMaxAgents,
  plan,
  provisioning,
  slugConflict,
  capacityError,
  uploadedAssetIds,
  onAssetUploaded,
  onAssetRemoved,
  onUploadSkip,
  onUploadContinue,
  onStep3Success,
  onStep3Cancel,
  onStep3SlugConflict,
  onStep3CapacityExceeded,
  onStep3Back,
}: {
  isDark: boolean;
  step: 0 | 1 | 2 | 3;
  workspaceId: string;
  organizationName: string;
  lockedOrganizationName: string | null;
  industry: IndustryKey | null;
  size: SizeKey | null;
  model: string;
  proxyProvider: ProxyProvider;
  onOrganizationNameChange: (name: string) => void;
  onModelChange: (model: string) => void;
  onProxyProviderChange: (value: ProxyProvider) => void;
  onIndustrySizeChange: (industry: IndustryKey | null, size: SizeKey | null) => void;
  selectedSlugs: Set<string>;
  onSelectionChange: (slugs: Set<string>) => void;
  onRoleCatalogChange: (roles: RenderedRole[]) => void;
  slugDrafts: Record<string, string>;
  slugErrors: Record<string, string | null>;
  onSlugChange: (roleSlug: string, next: string) => void;
  deviceMaxAgents: number;
  plan: SimpleProvisioningPlan | null;
  provisioning: ReturnType<typeof useSimpleProvisioning>;
  slugConflict: { roleSlug: string; message: string } | null;
  capacityError: { used: number; max: number; message: string } | null;
  uploadedAssetIds: string[];
  onAssetUploaded: (asset: AssetDTO) => void;
  onAssetRemoved: (assetId: string) => void;
  onUploadSkip: () => void;
  onUploadContinue: () => void;
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
        initialOrganizationName={organizationName}
        lockedOrganizationName={lockedOrganizationName}
        initialIndustry={industry ?? undefined}
        initialSize={size ?? undefined}
        model={model}
        proxyProvider={proxyProvider}
        onOrganizationNameChange={onOrganizationNameChange}
        onModelChange={onModelChange}
        onProxyProviderChange={onProxyProviderChange}
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
        onRoleCatalogChange={onRoleCatalogChange}
        slugDrafts={slugDrafts}
        slugErrors={slugErrors}
        onSlugChange={onSlugChange}
        deviceMaxAgents={deviceMaxAgents}
      />
    );
  }
  if (step === 2) {
    // Task 42 — company materials upload step (optional).
    return (
      <SimpleStepUpload
        isDark={isDark}
        workspaceId={workspaceId}
        uploadedAssetIds={uploadedAssetIds}
        onAssetUploaded={onAssetUploaded}
        onAssetRemoved={onAssetRemoved}
        onSkip={onUploadSkip}
        onContinue={onUploadContinue}
      />
    );
  }
  // step === 3 — provisioning loader. Plan must be ready here; if it isn't
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
