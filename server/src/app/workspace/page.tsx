'use client';

/**
 * /workspace — first-class Personal Workspace surface.
 *
 * v1 was read-only (54release Cloud Session 1). v5.4 web-first pivot wires up
 * the six mutation flows the Wave-6b Playwright e2e harness needs:
 *
 *   1. Create agent           → POST /api/im/register {type:'agent'}
 *   2. Create conversation    → POST /api/im/groups
 *   3. Send message           → POST /api/im/messages/:cid
 *   4. @mention picker        → GET /api/im/groups/:cid → members[].username
 *   5. Create task            → POST /api/im/tasks
 *   6. Cancel task            → DELETE /api/im/tasks/:id
 *   7. Kick member            → DELETE /api/im/groups/:gid/members/:userId
 *
 * Architecture rules enforced here:
 *  - No imports from `src/im/**` (CLAUDE.md). Page talks to `/api/im/*` only.
 *  - Calls only the new first-class workspace endpoints (`/workspaces`,
 *    `/tasks?workspaceId=&view=board`, `/conversations?workspaceId=`, `/agents`,
 *    `/agent_profiles`, `/workspaces/:id/files`). Legacy
 *    `/api/im/workspace?scope=` is reserved for the `/evolution` page only.
 *  - Single-workspace assumption (54release): we always pick `isDefault=true`
 *    and never render a switcher. See docs/54release/02-product-architecture.md.
 *
 * Wire shapes are derived from the cookbook MDs under `docs/cookbook/`; do not
 * re-derive in this file. See `lib/mutations.ts` for the typed helpers.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { getWorkspaceToken, imFetch } from './lib/im-api';
import { loadCursor, saveCursor } from './lib/sse-cursor';
import { publishAssetChanged } from './lib/asset-event-bus';
import { isCurrentlyContested, listAgentBindings } from './lib/agent-bindings-api';
import {
  createDirectConversation,
  seedLaunchTourContent,
  sendMessage,
  type LaunchTourSeed,
  type MessageAttachmentDTO,
} from './lib/mutations';
import { uploadAssetWithDirectFallback, type AssetUploadProgress } from './lib/asset-upload';
import { useTaskStream } from './lib/use-task-stream';
import { useAgentPhaseMap } from './lib/agent-phase-store';
import { deriveWorkspaceAgentStatuses, type AgentLiveStatus } from './lib/agent-status';
import { springHeavy } from './lib/design';
import { TopBar } from './components/top-bar';
import { LeftRail } from './components/left-rail';
import { ProjectSwitcher } from './components/project-switcher';
import { InsightsSurface, type InsightsCustomRange, type InsightsView } from './components/insights/insights-surface';
import type { InsightsRange } from './lib/insights-api';
import { ProjectOverviewDrawer } from './components/project-overview';
import { useProjects } from './hooks/use-projects';
import { ChatsSurface } from './components/chats-surface';
import { TaskBoard } from './components/task-board';
import { TaskDetailDrawer } from './components/task-detail-drawer';
import { WorkspaceTour } from './components/workspace-tour';
import { LaunchTour } from './components/launch-tour';
import { WorkspaceOnboarding } from './components/workspace-onboarding';
import { LibrarySurface } from './components/library-surface';
import { LibrarySearchModal } from './components/library-search-modal';
import { LibraryProposalReviewModal } from './components/library-proposal-review-modal';
import { MessageForwardDialog, type MessageForwardSource } from './components/message-forward-dialog';
import { createMemoryPage, listProposals } from './lib/memory-api';
import { RuntimeManager } from './components/runtime-manager';
import { NewChannelDialog } from './components/new-channel-dialog';
import { NewTaskDialog } from './components/new-task-dialog';
import { UnifiedCreationModal, type UnifiedCreationEvent } from './components/unified-creation';
import dynamic from 'next/dynamic';
import type { WorkspaceInspector } from './components/workspace-inspector-dialog';
import { SurfaceWithPreviewDock } from './components/SurfaceWithPreviewDock';
// react-pdf inside the inspector references DOM-only globals (DOMMatrix); load on client.
const WorkspaceInspectorDialog = dynamic(
  () => import('./components/workspace-inspector-dialog').then((m) => m.WorkspaceInspectorDialog),
  { ssr: false },
);
// Wave-8 W4: session settings + mobile nav
import { SessionSettingsMenu } from './components/session-settings-menu';
import { AddMemberDialog } from './components/add-member-dialog';
import { RenameSessionDialog } from './components/rename-session-dialog';
import { MobileNav, type MobileSurface } from './components/mobile-nav';
import type { WorkspaceSurface } from './components/left-rail';
import { isBoardProjectionTask } from './lib/types';
import type {
  AgentDTO,
  AgentProfileDTO,
  AssetDTO,
  ContactFriendDTO,
  ContactRequestDTO,
  ConversationDTO,
  KanbanColumnKey,
  RuntimeInstallationDTO,
  TaskDTO,
  UserProfileDTO,
  WorkspaceFileDTO,
  WorkspaceDTO,
  WorkspaceRuntimeDTO,
} from './lib/types';

const RECENT_DEVICE_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

function isFailedRuntimeInstallation(row: RuntimeInstallationDTO): boolean {
  return row.status === 'errored' || row.status === 'failed' || row.phase === 'failed';
}

function isRecentRuntimeInstallation(row: RuntimeInstallationDTO, now = Date.now()): boolean {
  const ts = Date.parse(row.stoppedAt ?? row.updatedAt ?? row.createdAt);
  return Number.isFinite(ts) && now - ts <= RECENT_DEVICE_ATTEMPT_WINDOW_MS;
}

function filterRuntimeInstallationsForWorkspaceUi(rows: RuntimeInstallationDTO[]): RuntimeInstallationDTO[] {
  const now = Date.now();
  return rows.filter((row) => !isFailedRuntimeInstallation(row) || isRecentRuntimeInstallation(row, now));
}

function hasRecentDeviceAttempt(rows: RuntimeInstallationDTO[]): boolean {
  const now = Date.now();
  return rows.some((row) => !isFailedRuntimeInstallation(row) || isRecentRuntimeInstallation(row, now));
}

function replaceWorkspaceAssetQuery(assetId: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (assetId) {
    url.searchParams.set('asset', assetId);
  } else {
    url.searchParams.delete('asset');
  }
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function conversationAccess(conversation: ConversationDTO | null) {
  const role = conversation?.myRole;
  return {
    canAddMember: conversation?.viewerAccess?.canAddMember ?? (role === 'owner' || role === 'admin'),
    canRename: conversation?.viewerAccess?.canRename ?? (role === 'owner' || role === 'admin'),
    canPin: conversation?.viewerAccess?.canPin ?? Boolean(role && role !== 'observer'),
    canMute: conversation?.viewerAccess?.canMute ?? Boolean(role && role !== 'observer'),
    canArchive: conversation?.viewerAccess?.canArchive ?? (role === 'owner' || role === 'admin'),
    canDelete: conversation?.viewerAccess?.canDelete ?? role === 'owner',
    canLeave: conversation?.viewerAccess?.canLeave ?? Boolean(role && role !== 'observer' && role !== 'owner'),
  };
}

const VALID_INSIGHTS_VIEWS = new Set<InsightsView>(['overview', 'project', 'agent']);
const VALID_INSIGHTS_RANGES = new Set<InsightsRange>(['24h', '7d', '30d', '90d']);

export default function WorkspacePage() {
  const router = useRouter();
  const { isAuthenticated, isAuthLoading, addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const addToastRef = useRef(addToast);

  const [workspace, setWorkspace] = useState<WorkspaceDTO | null>(null);
  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [agents, setAgents] = useState<AgentDTO[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileDTO[]>([]);
  const [me, setMe] = useState<UserProfileDTO | null>(null);
  const [contacts, setContacts] = useState<ContactFriendDTO[]>([]);
  const [receivedRequests, setReceivedRequests] = useState<ContactRequestDTO[]>([]);
  const [sentRequests, setSentRequests] = useState<ContactRequestDTO[]>([]);
  const [runtime, setRuntime] = useState<WorkspaceRuntimeDTO | null>(null);
  const [runtimeInstallations, setRuntimeInstallations] = useState<RuntimeInstallationDTO[]>([]);
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [assets, setAssets] = useState<AssetDTO[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileDTO[]>([]);

  const [bootstrapping, setBootstrapping] = useState(true);
  // Workspace tour: shown to fresh users (devices.length === 0) on every land.
  // Task 40 (launch-flow rewire) drops the localStorage gate — the right
  // "fresh user" predicate is server-derived state, not a client cookie that
  // bleeds across accounts on the same browser. The tour will re-open on
  // every visit until the user creates a device, at which point the
  // condition in the gating useEffect goes false.
  const [tourOpen, setTourOpen] = useState(false);
  // release201 v2.0.8 F-bug — onboarding dismissal is now **persisted per
  // workspace** in localStorage. 用户原话："device 为 0 的情况下每次刷新只
  // 出现一次", 即:
  //   - device=0 → 显示, 直到用户主动 dismiss
  //   - dismiss 一次 → 持久化 (`prismer_onboarding_dismissed_<workspaceId>`)
  //     后续刷新 / 新 tab 都不再显示, 即使 device 数从 0 重新归 0 也不重显
  //   - 用户清浏览器 localStorage 才会重新看到引导
  //
  // (workspace?.id 在初始 render 时 undefined; useEffect 在 workspace 加载后
  // 同步实际值, 见下方 effect.)
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  // SSE handler reads "currently selected conversation" and "current user id"
  // without re-binding the EventSource. Refs keep their values fresh across
  // re-renders without invalidating the long-lived effect that owns the ES.
  const selectedConversationIdRef = useRef<string | null>(null);
  const meIdRef = useRef<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<{
    conversationId?: string | null;
    sourceTaskId?: string | null;
    // When true, after the asset is uploaded we also POST a markdown message
    // with the asset as an attachment into `conversationId`, so the file is
    // visible in the chat stream (same shape as drag-drop sendAssetAttachment).
    // Without this flag the upload stays asset-only (library / onboarding path).
    attachToConversation?: boolean;
    inputIntent?: 'vision_input' | 'file_attachment';
  } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    filename: string;
    fileIndex: number;
    totalFiles: number;
    progress: AssetUploadProgress;
  } | null>(null);

  // Modal open state.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // §30 B3.7 — unified creation modal state. Single `+` button in
  // TopBar + the left-rail "+" shortcuts open this. Existing per-dialog
  // state above (newAgentOpen/newChannelOpen/newTaskOpen) is retained
  // for the underlying dialog JSX (currently dead UX, no triggers).
  // unifiedInitialMode is a placeholder for future left-rail "+"
  // pre-routing (Pro→Conversation etc.) — for v1 every entry just opens
  // Simple, so the setter is intentionally retained for forward-compat.
  const [unifiedOpen, setUnifiedOpen] = useState(false);
  const [unifiedInitialMode, setUnifiedInitialMode] = useState<'simple' | 'pro'>('simple');
  // Task 41 — Auto-open Simple Mode on fresh-user land. Session-scoped flag
  // (one-shot per page session) so we don't re-open the modal after the
  // user dismisses it but before devices/agents land. Resets on full reload.
  const [autoOpenedSimple, setAutoOpenedSimple] = useState(false);
  // Task 43 — Launch-tour seed produced by `seedLaunchTourContent` after
  // Simple Mode completes. The downstream LaunchTour component (separate
  // task) reads this to pick which task / asset card to highlight.
  // `launchTourStage` lets the same downstream component coordinate
  // pending→running→done without storing in localStorage.
  const [launchTourSeed, setLaunchTourSeed] = useState<LaunchTourSeed | null>(null);
  const [launchTourStage, setLaunchTourStage] = useState<'idle' | 'pending' | 'running' | 'done'>('idle');
  const [newTaskInitialColumn, setNewTaskInitialColumn] = useState<KanbanColumnKey | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Fallback for tasks that aren't on the board (agent_run subtasks live under
  // the parent work_item — the kanban filters them out, but a click on
  // "Open card" in chat or on a breadcrumb chip still has to find them).
  const [selectedTaskFallback, setSelectedTaskFallback] = useState<TaskDTO | null>(null);
  const taskFetchCacheRef = useRef<Map<string, { task: TaskDTO; ts: number }>>(new Map());
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);
  // Wave-8 W4: session settings dialogs (mounted at root, controlled by ⋮ menu).
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // Wave-8 W4: mobile breakpoint — when true, render <MobileNav /> bottom bar.
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setIsMobileViewport(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('chats');
  const [inspector, setInspector] = useState<WorkspaceInspector | null>(null);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>('chats');
  // Asset preview layout (desktop). The dock reports whether the content area
  // is wide enough to split; narrow areas always go full screen. `maximized`
  // is the user's per-open override (the header maximize/restore button).
  const [previewContainerWide, setPreviewContainerWide] = useState(true);
  const previewContainerWideRef = useRef(true);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  // Surface the full-screen preview is pinned to. Used to auto-close the
  // overlay when the user navigates to a *different* surface (so it doesn't
  // trap them), without closing when they merely maximize in place.
  const previewSurfaceRef = useRef<WorkspaceSurface | null>(null);
  const onMeasurePreviewWide = useCallback((wide: boolean) => {
    previewContainerWideRef.current = wide;
    setPreviewContainerWide(wide);
  }, []);
  const previewLayout: 'split' | 'full' = !previewContainerWide || previewMaximized ? 'full' : 'split';
  // release201 S12 — Insights as an in-shell surface. View / range / scoped
  // ids live in the URL so deep-links (counter drill-down, business cards,
  // project-overview drawer) survive a refresh and reload pre-scoped.
  const [insightsView, setInsightsView] = useState<InsightsView>('overview');
  const [insightsRange, setInsightsRange] = useState<InsightsRange>('7d');
  const [insightsProjectId, setInsightsProjectId] = useState<string | null>(null);
  const [insightsAgentId, setInsightsAgentId] = useState<string | null>(null);
  const [insightsRefreshNonce, setInsightsRefreshNonce] = useState(0);
  // S38 (release201/12 v2.0.9) — custom range UX. When set, picker shows
  // "Custom <from> → <to>"; URL syncs `range=custom&from=YYYY-MM-DD&to=…`.
  // BFF (`fetchOverview/Project/Agent`) still receives the preset `range`
  // value since the endpoint shape didn't change in this PR — custom is a
  // local visual concept until 12 §7 adds custom support upstream.
  const [insightsCustomRange, setInsightsCustomRange] = useState<InsightsCustomRange | null>(null);
  // Drives "Last updated X min ago" in the surface header. Bumped whenever
  // a view successfully renders fresh data (refreshNonce or initial load).
  // For S38 we bump on refreshNonce change as a coarse proxy — sufficient
  // for the picker; views still own their own asOf timestamp display.
  const [insightsLastUpdated, setInsightsLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    setInsightsLastUpdated(new Date());
  }, [insightsRefreshNonce, insightsView, insightsRange, insightsProjectId, insightsAgentId, insightsCustomRange]);
  // In full-screen mode the asset inspector overlays the library surface, so
  // navigating to a non-library surface (left rail, mobile nav, task drawer's
  // "Open in Library" + back, etc.) should close it so it doesn't trap the
  // user on top of the wrong surface. In split mode the preview is docked
  // beside whatever surface is active, so it's fine to keep it open across
  // surface switches.
  useEffect(() => {
    if (
      previewLayout === 'full' &&
      inspector?.kind === 'asset' &&
      previewSurfaceRef.current &&
      activeSurface !== previewSurfaceRef.current
    ) {
      setInspector(null);
      setPreviewMaximized(false);
      previewSurfaceRef.current = null;
      replaceWorkspaceAssetQuery(null);
    }
  }, [activeSurface, inspector, previewLayout]);
  const [prefillContactUserId, setPrefillContactUserId] = useState<string | null>(null);
  // Wave-9 Phase 3.3: when the task drawer's "Open in Library" lands,
  // we both flip activeSurface to 'library' AND pass this folder down to
  // the LibrarySurface so it pre-selects the per-task auto-folder. Reset
  // to undefined after consumed so subsequent library navigations don't
  // get stuck on the same filter.
  const [libraryInitialFolder, setLibraryInitialFolder] = useState<string | null | undefined>(undefined);
  // Memory Line B: ⌘K + Asset detail "View as Memory" routes through here.
  const [memoryJumpPath, setMemoryJumpPath] = useState<string | null>(null);
  const [forwardSource, setForwardSource] = useState<MessageForwardSource | null>(null);
  const [proposalReviewOpen, setProposalReviewOpen] = useState(false);
  const [pendingProposalCount, setPendingProposalCount] = useState(0);
  const [proposalRefreshTick, setProposalRefreshTick] = useState(0);

  // ─── Auth guard — bounce to /auth once we know the user is signed out ────
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.replace('/auth?redirect=/workspace');
    }
  }, [isAuthLoading, isAuthenticated, router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const contactId = new URLSearchParams(window.location.search).get('addContact');
    if (!contactId) return;
    setPrefillContactUserId(contactId);
    setActiveSurface('chats');
    setMobileSurface('chats');
    window.history.replaceState(null, '', '/workspace');
  }, []);

  // W2-T3: deep-link / chat-share affordance — `?focusTaskId=…` opens the
  // drawer on mount (the chat-message "Open card" path, the LeftRail asset
  // → task badge, and Lumin push notifications all share this).  Subtasks
  // that aren't on the board fall through to openTaskById's fallback fetch.
  const [pendingFocusTaskId, setPendingFocusTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const focusId = new URLSearchParams(window.location.search).get('focusTaskId');
    if (!focusId) return;
    setPendingFocusTaskId(focusId);
    window.history.replaceState(null, '', '/workspace');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const assetId = new URLSearchParams(window.location.search).get('asset');
    if (!assetId) return;
    setActiveSurface('library');
    setMobileSurface('library');
    setInspector({ kind: 'asset', assetId });
  }, []);

  // release201 S12 — when Insights is active, mirror its scope into the URL
  // so deep-links survive (refresh + share). When Insights is not active,
  // strip the insights params so other surfaces don't carry stale scope in
  // the URL. Uses `router.replace` so the browser history isn't polluted.
  const syncInsightsUrl = useCallback(
    (next: {
      surface?: WorkspaceSurface;
      view?: InsightsView;
      range?: InsightsRange;
      projectId?: string | null;
      agentId?: string | null;
      // S38 — `customRange === null` clears `?from=&to=` AND resets `?range=`
      // back to the preset; `customRange === undefined` leaves whatever was
      // there in place. Symmetric with the project/agent id treatment above.
      customRange?: InsightsCustomRange | null;
    }) => {
      if (typeof window === 'undefined') return;
      const sp = new URLSearchParams(window.location.search);
      const surface = next.surface ?? activeSurface;
      if (surface === 'insights') {
        sp.set('surface', 'insights');
        sp.set('view', next.view ?? insightsView);
        const effectiveCustom = next.customRange !== undefined ? next.customRange : insightsCustomRange;
        if (effectiveCustom) {
          sp.set('range', 'custom');
          sp.set('from', effectiveCustom.from);
          sp.set('to', effectiveCustom.to);
        } else {
          sp.set('range', next.range ?? insightsRange);
          sp.delete('from');
          sp.delete('to');
        }
        const pid = next.projectId !== undefined ? next.projectId : insightsProjectId;
        if (pid) sp.set('projectId', pid);
        else sp.delete('projectId');
        const aid = next.agentId !== undefined ? next.agentId : insightsAgentId;
        if (aid) sp.set('agentId', aid);
        else sp.delete('agentId');
      } else {
        sp.delete('surface');
        sp.delete('view');
        sp.delete('range');
        sp.delete('from');
        sp.delete('to');
        sp.delete('projectId');
        sp.delete('agentId');
      }
      const qs = sp.toString();
      router.replace(qs ? `/workspace?${qs}` : '/workspace');
    },
    [activeSurface, insightsView, insightsRange, insightsProjectId, insightsAgentId, insightsCustomRange, router],
  );

  /**
   * release201 S12 — open Insights as an in-shell surface, optionally
   * pre-scoped to a project or agent. Single entry-point for all the
   * deep-link callers (business event cards, session-context-sidebar,
   * project-overview drawer). Replaces the legacy
   * `window.location.href = '/workspace/insights?...'` pattern.
   */
  const openInsightsSurface = useCallback(
    (opts?: { view?: InsightsView; projectId?: string | null; agentId?: string | null }) => {
      const view = opts?.view ?? (opts?.projectId ? 'project' : opts?.agentId ? 'agent' : insightsView);
      setInsightsView(view);
      if (opts?.projectId !== undefined) setInsightsProjectId(opts.projectId);
      if (opts?.agentId !== undefined) setInsightsAgentId(opts.agentId);
      setActiveSurface('insights');
      setMobileSurface('insights');
      syncInsightsUrl({
        surface: 'insights',
        view,
        projectId: opts?.projectId !== undefined ? opts.projectId : insightsProjectId,
        agentId: opts?.agentId !== undefined ? opts.agentId : insightsAgentId,
      });
    },
    [insightsView, insightsProjectId, insightsAgentId, syncInsightsUrl],
  );

  // Keep the URL in sync when the user navigates surfaces (left rail / mobile
  // nav / programmatic setActiveSurface from other actions). Idempotent —
  // syncInsightsUrl re-reads the current location each call, so duplicate
  // pushes still produce the same query string.
  useEffect(() => {
    syncInsightsUrl({ surface: activeSurface });
    // intentionally exclude syncInsightsUrl dep — we want to re-run on surface
    // changes, not on every state update that re-creates the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSurface]);

  // release201 S12 — read `?surface=insights&view=…&range=…&projectId=…&agentId=…`
  // on mount so deep links (legacy /workspace/insights redirect + business cards
  // + project-overview "Open dashboard") land on the right view with the
  // right scope. Sentinel sentinels: invalid view/range → fall back to
  // overview/7d (matches the old standalone page's behaviour).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const surface = sp.get('surface');
    const view = sp.get('view');
    const range = sp.get('range');
    const fromParam = sp.get('from');
    const toParam = sp.get('to');
    const projectId = sp.get('projectId');
    const agentId = sp.get('agentId');
    if (view && VALID_INSIGHTS_VIEWS.has(view as InsightsView)) {
      setInsightsView(view as InsightsView);
    }
    if (range && VALID_INSIGHTS_RANGES.has(range as InsightsRange)) {
      setInsightsRange(range as InsightsRange);
    }
    // S38 — `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` rehydrates the
    // custom range from a shared URL. Only accept ISO `YYYY-MM-DD` shape;
    // bad input is silently dropped (we keep the preset range).
    if (
      range === 'custom' &&
      fromParam &&
      toParam &&
      /^\d{4}-\d{2}-\d{2}$/.test(fromParam) &&
      /^\d{4}-\d{2}-\d{2}$/.test(toParam) &&
      fromParam <= toParam
    ) {
      setInsightsCustomRange({ from: fromParam, to: toParam });
    }
    if (projectId) setInsightsProjectId(projectId);
    if (agentId) setInsightsAgentId(agentId);
    if (surface === 'insights') {
      setActiveSurface('insights');
      setMobileSurface('insights');
    } else if (surface === 'tasks' || surface === 'library' || surface === 'runtime' || surface === 'chats') {
      setActiveSurface(surface);
      setMobileSurface(surface === 'runtime' ? 'runtime' : (surface as MobileSurface));
    }
  }, []);

  // ─── Reload helpers — share between bootstrap + post-mutation refreshes ──

  const loadOwnedAgents = useCallback(async (): Promise<AgentDTO[]> => {
    const res = await imFetch<
      Array<{
        id: string;
        username: string;
        displayName: string;
        agentType?: string | null;
        card?: {
          name?: string | null;
          description?: string | null;
          capabilities?: string[];
          status?: string | null;
        } | null;
      }>
    >('/me/agents');
    if (!res.ok) return [];
    return (res.data ?? []).map((agent) => ({
      agentId: agent.id,
      userId: agent.id,
      name: agent.card?.name || agent.displayName || agent.username,
      // §30 B3.8 Q2: surface IM slug so inline rename UI has the source value.
      username: agent.username,
      description: agent.card?.description ?? null,
      agentType: agent.agentType ?? null,
      capabilities: agent.card?.capabilities ?? [],
      status: agent.card?.status ?? 'offline',
      load: 0,
    }));
  }, []);

  const reloadAgents = useCallback(async () => {
    setAgents(await loadOwnedAgents());
  }, [loadOwnedAgents]);

  const reloadContacts = useCallback(async () => {
    const [friendsRes, receivedRes, sentRes] = await Promise.all([
      imFetch<ContactFriendDTO[]>('/contacts/friends?limit=100'),
      imFetch<ContactRequestDTO[]>('/contacts/requests/received?limit=100'),
      imFetch<ContactRequestDTO[]>('/contacts/requests/sent?limit=100'),
    ]);
    if (friendsRes.ok) setContacts(friendsRes.data ?? []);
    if (receivedRes.ok) setReceivedRequests(receivedRes.data ?? []);
    if (sentRes.ok) setSentRequests(sentRes.data ?? []);
  }, []);

  // Workspace runtime topology (devices + agents) — drives the LeftRail tree.
  // Cloud 4 daemon heartbeats feed `/workspaces/:wsId/runtime`; per-resource
  // failures shouldn't nuke the bootstrap, so a 4xx just clears the tree.
  const reloadRuntime = useCallback(async (wsId: string) => {
    const res = await imFetch<WorkspaceRuntimeDTO>(`/workspaces/${encodeURIComponent(wsId)}/runtime`);
    setRuntime(res.ok ? (res.data ?? null) : null);
  }, []);

  const reloadRuntimeInstallations = useCallback(async (wsId: string) => {
    const res = await imFetch<RuntimeInstallationDTO[]>(
      `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(wsId)}&includeStopped=true`,
    );
    if (res.ok) setRuntimeInstallations(filterRuntimeInstallationsForWorkspaceUi(res.data ?? []));
  }, []);

  const reloadProfiles = useCallback(async (wsId: string) => {
    const res = await imFetch<AgentProfileDTO[]>(`/agent_profiles?workspaceId=${encodeURIComponent(wsId)}`);
    // 4xx is treated as "no profiles to show" rather than fatal — the
    // /agent_profiles endpoint requires agentId in many deployments.
    if (res.ok) setProfiles(res.data ?? []);
  }, []);

  const reloadConversations = useCallback(
    async (wsId: string) => {
      // withUnread=true — the server only computes unreadCount when this flag
      // is set (default 0). Without it the session-list unread badge resets to
      // 0 on every reload and only ever flashes via the live message.new bump.
      const res = await imFetch<ConversationDTO[]>(
        `/conversations?workspaceId=${encodeURIComponent(wsId)}&withUnread=true`,
      );
      if (res.ok) {
        setConversations(res.data ?? []);
      } else {
        addToast(`Workspace sessions: ${res.message}`, 'error');
      }
    },
    [addToast],
  );

  const reloadAssets = useCallback(async (wsId: string) => {
    // 2026-05-23: bumped limit 100→200 (server cap) so task-board's
    // `assetsByTaskId` map can populate Paperclip badges + counts for the
    // bulk of task-produced artifacts. Workspaces with >200 total assets
    // still lose the badge for older tasks; the drawer's targeted
    // /assets?taskId=... fetch (task-detail-drawer.tsx) covers that gap.
    const [assetsRes, filesRes] = await Promise.all([
      imFetch<AssetDTO[]>(`/assets?workspaceId=${encodeURIComponent(wsId)}&limit=200`),
      imFetch<WorkspaceFileDTO[]>(`/workspaces/${encodeURIComponent(wsId)}/files`),
    ]);
    if (assetsRes.ok) setAssets(assetsRes.data ?? []);
    if (filesRes.ok) setWorkspaceFiles(filesRes.data ?? []);
  }, []);

  // ─── Load default workspace + sibling resources on mount ────────────────
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setBootstrapping(true);
    setBootstrapError(null);

    (async () => {
      const wsRes = await imFetch<WorkspaceDTO[]>('/workspaces');
      if (cancelled) return;
      if (!wsRes.ok) {
        setBootstrapError(wsRes.message);
        setBootstrapping(false);
        return;
      }
      const list = wsRes.data ?? [];
      const defaultWs = list.find((w) => w.isDefault) ?? list[0] ?? null;
      setWorkspace(defaultWs);

      if (!defaultWs) {
        // No workspace yet — leave the panes empty; surface a friendly notice.
        setBootstrapping(false);
        return;
      }

      // The workspace shell should render as soon as the workspace exists.
      // Sessions, agents, runtime, contacts, and assets hydrate in the
      // background; none of them should block the board/chat skeleton.
      setBootstrapping(false);

      const [meRes, convRes, agentsRes] = await Promise.all([
        imFetch<UserProfileDTO>('/users/me'),
        imFetch<ConversationDTO[]>(`/conversations?workspaceId=${encodeURIComponent(defaultWs.id)}&withUnread=true`),
        loadOwnedAgents(),
      ]);
      if (cancelled) return;

      if (meRes.ok) setMe(meRes.data ?? null);
      setAgents(agentsRes);
      if (convRes.ok) {
        setConversations(convRes.data ?? []);
        const first = (convRes.data ?? [])[0];
        // On mobile we land on the Chats directory, not directly inside the
        // first conversation, so Sessions / People stay reachable first.
        const isMobile =
          typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
        if (first && !isMobile) setSelectedConversationId(first.id);
      } else {
        addToastRef.current(`Workspace sessions: ${convRes.message}`, 'error');
      }

      const [
        profilesRes,
        contactsRes,
        receivedRequestsRes,
        sentRequestsRes,
        runtimeRes,
        runtimeInstallationsRes,
        assetsRes,
        filesRes,
      ] = await Promise.all([
        imFetch<AgentProfileDTO[]>(`/agent_profiles?workspaceId=${encodeURIComponent(defaultWs.id)}`),
        imFetch<ContactFriendDTO[]>('/contacts/friends?limit=100'),
        imFetch<ContactRequestDTO[]>('/contacts/requests/received?limit=100'),
        imFetch<ContactRequestDTO[]>('/contacts/requests/sent?limit=100'),
        imFetch<WorkspaceRuntimeDTO>(`/workspaces/${encodeURIComponent(defaultWs.id)}/runtime`),
        imFetch<RuntimeInstallationDTO[]>(
          `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(defaultWs.id)}&includeStopped=true`,
        ),
        imFetch<AssetDTO[]>(`/assets?workspaceId=${encodeURIComponent(defaultWs.id)}&limit=100`),
        imFetch<WorkspaceFileDTO[]>(`/workspaces/${encodeURIComponent(defaultWs.id)}/files`),
      ]);
      if (cancelled) return;

      if (profilesRes.ok) setProfiles(profilesRes.data ?? []);
      if (contactsRes.ok) setContacts(contactsRes.data ?? []);
      if (receivedRequestsRes.ok) setReceivedRequests(receivedRequestsRes.data ?? []);
      if (sentRequestsRes.ok) setSentRequests(sentRequestsRes.data ?? []);
      if (runtimeRes.ok) setRuntime(runtimeRes.data ?? null);
      if (runtimeInstallationsRes.ok) {
        setRuntimeInstallations(filterRuntimeInstallationsForWorkspaceUi(runtimeInstallationsRes.data ?? []));
      }
      if (assetsRes.ok) setAssets(assetsRes.data ?? []);
      if (filesRes.ok) setWorkspaceFiles(filesRes.data ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // ─── Task list — refreshable; SSE/polling drives reload ────────────────
  // Capture the id outside useCallback so the inferred dependency matches the
  // stated one (`workspaceId`). Referencing `workspace?.id` from inside the
  // callback would make React Compiler infer the broader `workspace` dep and
  // skip memoization.
  const workspaceId = workspace?.id ?? null;

  // release201/09 Phase 1 — Project scope (opt-in 中间层). Phase 1 不接入资源
  // filter,Phase 2 起 task-board/library/chats 才会消费 activeProjectFilter.
  // release201/09 Phase 4 — adds soft-archive UI surface: archived projects
  // are lazy-loaded on toggle, never made the active filter, restorable via
  // PATCH status='active'.
  const {
    projects: projectsList,
    loading: projectsLoading,
    activeFilter: activeProjectFilter,
    setActiveFilter: setActiveProjectFilter,
    reload: reloadProjects,
    showArchived: showArchivedProjects,
    setShowArchived: setShowArchivedProjects,
    archivedProjects,
    archivedLoading: archivedProjectsLoading,
  } = useProjects(workspaceId);
  // Project overview drawer state (09 §15.1 Phase 4 §8.7). Selected id is
  // independent of the active filter so the user can view (e.g.) an
  // archived project without changing the surface scope.
  const [projectOverviewId, setProjectOverviewId] = useState<string | null>(null);

  /**
   * One-click save for chat messages — replaces the old SaveAsMemoryModal
   * flow. Defaults match what the modal used (`pageType: 'leaf'`,
   * `visibility: 'workspace'`, auto-suggested path). No popup; toast only.
   */
  const saveMessageAsMemory = useCallback(
    async (payload: {
      conversationId: string;
      messageId: string;
      text: string;
      authorImUserId: string;
      createdAt: string;
    }) => {
      if (!workspaceId) {
        addToast('Cannot save — workspace not loaded.', 'error');
        return;
      }
      const slug =
        payload.text
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .replace(/-{2,}/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'untitled';
      const stamp = new Date(payload.createdAt || Date.now()).toISOString().slice(0, 10);
      const path = `memory/notes/${stamp}-${slug}.md`;
      const content = [
        '# Captured chat message',
        '',
        `> From **${payload.authorImUserId}** at ${payload.createdAt}`,
        '',
        payload.text,
      ].join('\n');
      const sourceRefs = [
        `conversation:${payload.conversationId}`,
        `message:${payload.messageId}`,
        `actor:${payload.authorImUserId}`,
      ];
      const res = await createMemoryPage({
        workspaceId,
        path,
        content,
        pageType: 'leaf',
        visibility: 'workspace',
        sourceRefs,
        rationale: 'Saved from chat via bubble action bar',
      });
      if (res.ok) addToast('Saved to memory.', 'success');
      else addToast(`Save failed: ${res.message}`, 'error');
    },
    [workspaceId, addToast],
  );

  // Memory Line B / B7 — pending proposal counter for the rail badge.
  useEffect(() => {
    if (!workspaceId) {
      setPendingProposalCount(0);
      return undefined;
    }
    const ac = new AbortController();
    listProposals({ workspaceId, status: 'pending', limit: 100, signal: ac.signal }).then((res) => {
      if (ac.signal.aborted) return;
      if (res.ok) setPendingProposalCount(res.data?.length ?? 0);
    });
    return () => ac.abort();
  }, [workspaceId, proposalRefreshTick]);

  const reloadTasks = useCallback(async () => {
    if (!workspaceId) return;
    setTasksLoading(true);
    setTaskError(null);
    // release201/09 §4.2 Phase 2 — forward the active project filter so the
    // service can scope task list (`__unscoped` / specific id / 'all'). The
    // chip's `'all'` sentinel resolves to "no filter" on the server side
    // (parseProjectIdFilter), so we still send it for analytics symmetry.
    const projectParam =
      activeProjectFilter && activeProjectFilter !== 'all'
        ? `&projectId=${encodeURIComponent(activeProjectFilter)}`
        : '';
    const res = await imFetch<TaskDTO[]>(
      `/tasks?workspaceId=${encodeURIComponent(workspaceId)}&view=board&kind=work_item,goal&limit=100${projectParam}`,
    );
    if (!res.ok) {
      setTaskError(res.message);
      setTasksLoading(false);
      return;
    }
    setTasks((res.data ?? []).filter(isBoardProjectionTask));
    setTasksLoading(false);
  }, [workspaceId, activeProjectFilter]);

  useEffect(() => {
    if (workspaceId) void reloadTasks();
  }, [workspaceId, reloadTasks]);

  // Poll runtime every 5s — δ acceptance was "5s polling adequate" but the
  // implementation only refetched on mutation callbacks. Without a steady
  // poll, daemon heartbeat changes (offline → online cascade) never update
  // the LeftRail tree until the user clicks Refresh.
  useEffect(() => {
    if (!workspaceId) return;
    const id = setInterval(() => {
      void reloadRuntime(workspaceId);
      void reloadRuntimeInstallations(workspaceId);
    }, 5_000);
    return () => clearInterval(id);
  }, [workspaceId, reloadRuntime, reloadRuntimeInstallations]);

  /**
   * Wave 3 C2 §4.8.2.3 — track contested-binding count at page level so the
   * Devices tile in LeftRail shows a red badge even when the user hasn't
   * opened the Devices surface yet. We poll lazily (60s) and on every
   * `agent.binding.*` SSE event — the count is small ({0, 1, 2, ...}) so
   * a thin polling layer is the simplest correct mechanism. RuntimeManager
   * still owns the full binding list for its own panel.
   */
  const [contestedBindingCount, setContestedBindingCount] = useState(0);
  const reloadContestedBindings = useCallback(async () => {
    if (!workspaceId) {
      setContestedBindingCount(0);
      return;
    }
    const res = await listAgentBindings(workspaceId);
    if (!res.ok) return;
    setContestedBindingCount(res.data.bindings.filter((b) => isCurrentlyContested(b)).length);
  }, [workspaceId]);
  useEffect(() => {
    void reloadContestedBindings();
    if (!workspaceId) return;
    const id = setInterval(() => void reloadContestedBindings(), 5_000);
    return () => clearInterval(id);
  }, [workspaceId, reloadContestedBindings]);

  // Coalesced SSE-driven invalidation (2026-05-30).
  //
  // The sync stream pushes one envelope per domain event (live tail *and*
  // cursor backfill). The handler below used to fire a full REST refetch
  // per envelope — e.g. every replayed `agent.binding.*` triggered a fresh
  // agent-bindings GET, *and* re-dispatched a window event that made
  // RuntimeManager refetch the same list again. A reconnect that replayed
  // N binding events therefore produced ~2N back-to-back requests. We now
  // accumulate the dirty domains and flush each at most once per ~250ms
  // tick, so a burst (replay gap or a rebind that emits
  // contested→rebound→contestCleared) collapses to a single refetch per
  // domain. The cursor fix below keeps the replay gap small in the first
  // place; this is defense-in-depth against bursts.
  type InvalidationDomain = 'assets' | 'contacts' | 'runtime' | 'bindings';
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyDomainsRef = useRef<Set<InvalidationDomain>>(new Set());
  const flushInvalidations = useCallback(() => {
    invalidateTimerRef.current = null;
    const dirty = dirtyDomainsRef.current;
    if (dirty.size === 0) return;
    dirtyDomainsRef.current = new Set();
    if (dirty.has('contacts')) void reloadContacts();
    if (dirty.has('bindings')) {
      void reloadContestedBindings();
      // Fan out to RuntimeManager's own list panel via the existing window
      // event — but only once per coalesced flush, not once per envelope.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('prismer:agent-binding', { detail: { type: 'invalidate', payload: null } }),
        );
      }
    }
    if (workspaceId) {
      if (dirty.has('assets')) void reloadAssets(workspaceId);
      if (dirty.has('runtime')) void reloadRuntimeInstallations(workspaceId);
    }
  }, [workspaceId, reloadContacts, reloadContestedBindings, reloadAssets, reloadRuntimeInstallations]);
  const invalidate = useCallback(
    (domain: InvalidationDomain) => {
      dirtyDomainsRef.current.add(domain);
      if (invalidateTimerRef.current) return; // flush already scheduled
      invalidateTimerRef.current = setTimeout(flushInvalidations, 250);
    },
    [flushInvalidations],
  );

  // Wave-8 W8 C7 + W9: workspace-shell SSE subscriber.
  //
  // W8 covers `contact.*` events; W9 extends to `task.*` and `runtime.*`. The
  // cloud's services fan these out via syncService.writeEvent → Redis pub/sub
  // `im:sync:<userId>`, which /api/im/sync/stream surfaces. Workspace only
  // refreshes its local panels; notification UI belongs to the global topbar.
  //
  // Lives at page level (not in ContactsPanel) so the state stays fresh even
  // when the panel isn't currently mounted (e.g. user is on Tasks).
  useEffect(() => {
    if (!isAuthenticated || isAuthLoading) return;
    if (typeof window === 'undefined') return;
    const token = getWorkspaceToken();
    if (!token) return;

    // P2 (2026-05-25): cursor-based SSE replay. Read the last-seen seq
    // from localStorage and pass it via &since= so the cloud replays
    // events missed during the disconnect window.
    //
    // 2026-05-30 fix: gate the connection on a *resolved* identity. The old
    // code read `meIdRef.current`, which is populated by a separate effect
    // and was frequently still null on first authenticated render — so the
    // cursor lookup fell through to `since=0`, asking the server to replay
    // the user's entire event history on every connect (and re-truncate +
    // reconnect when it exceeded BACKFILL_CAP). We now wait for `me.id` and
    // re-subscribe exactly once when identity resolves (null → id is a
    // one-shot transition, so this does not thrash the long-lived stream).
    const uid = me?.id ?? null;
    if (!uid) return;
    const cursorStream = 'sync';
    const initialCursor = loadCursor(cursorStream, uid);
    const es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}&since=${initialCursor}`);
    const handler = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as {
          type?: string;
          data?: { workspaceId?: string | null; assetId?: string | null };
          seq?: number;
          replayed?: boolean;
        };
        if (typeof event.type !== 'string') return;
        // P2 control envelopes — don't advance cursor, just react.
        if (event.type === 'sync.backfill.done') {
          // Persist the high-water seq the server replayed so the *next*
          // reconnect resumes from here instead of falling back to since=0.
          // Without this the cursor never advances past the bootstrap value
          // and every reconnect re-replays the full gap.
          const doneSeq = (event as { seq?: number }).seq;
          if (typeof doneSeq === 'number' && doneSeq > 0) saveCursor(cursorStream, uid, doneSeq);
          return;
        }
        if (event.type === 'sync.backfill.truncated') {
          // Cursor was too stale for the backfill cap. Resume from the
          // *newest* replayed seq rather than resetting to 0 — resetting
          // made the next reconnect request since=0, which re-replays the
          // entire history and immediately re-truncates: an infinite
          // full-replay storm. Persisting newestSeq closes the loop (the
          // server's own design note says clients should "re-establish from
          // the newest replayed seq"). One coalesced bootstrap reconcile
          // covers the gap above newestSeq.
          console.warn('[workspace] SSE backfill truncated — resuming from newestSeq + reconciling');
          const newestSeq = (event as { newestSeq?: number }).newestSeq;
          if (typeof newestSeq === 'number' && newestSeq > 0) saveCursor(cursorStream, uid, newestSeq);
          invalidate('assets');
          invalidate('runtime');
          invalidate('contacts');
          invalidate('bindings');
          // EventSource reconnects on its own (the server closed); the next
          // open uses the newestSeq cursor we just saved.
          return;
        }
        // Persist cursor for next reconnect — only for real events with
        // a meaningful seq (synthetic control envelopes already returned
        // above).
        if (typeof event.seq === 'number' && event.seq > 0) {
          saveCursor(cursorStream, uid, event.seq);
        }
        // 2026-05-22 — page-level fan-out for message.new so the left-rail
        // session list reflects unread state without depending on the user
        // opening that conversation. ImChannel's own SSE listener only
        // updates the *currently open* conversation; before this branch was
        // here, every other session's `unreadCount` was frozen at whatever
        // the bootstrap fetch returned.
        if (event.type === 'message.new') {
          const msg = (
            event as {
              data?: {
                conversationId?: string;
                senderId?: string;
                createdAt?: string;
                type?: string;
                attachments?: unknown;
              };
            }
          ).data;
          const convId = msg?.conversationId;
          // release202 ROOT FIX — a new asset created via the MESSAGE path
          // (deriveFileMessageAttachment, i.e. `cloud file send` / cli-send)
          // emits NO `asset.changed` event, and `publishAssetChanged` (the
          // upload path) targets the asset OWNER (the agent), not the human —
          // so the human's frontend gets ZERO refresh signal for an
          // agent-delivered file. The workspace `assets` list (and the session
          // sidebar's `sessionAssets` derived from it) therefore stay stale,
          // and the inspector resolves the clicked asset against that stale
          // list → "Asset unavailable". The ONE event that reliably reaches the
          // human here is `message.new` (the chat updates). A `type:'file'`
          // message (or any message carrying attachments) means a new asset
          // exists → refresh the asset list so it appears in list + sidebar and
          // the inspector can resolve it.
          const attachments = msg?.attachments;
          const hasAttachments =
            (Array.isArray(attachments) && attachments.length > 0) ||
            (typeof attachments === 'string' && attachments.length > 2 && attachments !== 'null');
          if (workspaceId && (msg?.type === 'file' || hasAttachments)) {
            invalidate('assets');
            // Per-asset nudge: for agent/cli-delivered files the human never
            // receives `asset.changed` over the SSE sync stream (the sync row
            // is scoped to the agent owner / conversation participants, and this
            // event has conversationId=null). `message.new` is the one signal
            // that reliably reaches the human — forward each attachment's asset
            // id into the asset-event bus so the just-mounted MessageAssetCard
            // re-fetches its own `/:id/detail` and picks up the thumbnail
            // derivative once it lands, without a whole-page reload.
            const rawAttachments = Array.isArray(attachments)
              ? attachments
              : typeof attachments === 'string'
                ? (() => {
                    try {
                      return JSON.parse(attachments) as unknown[];
                    } catch {
                      return [];
                    }
                  })()
                : [];
            for (const att of rawAttachments) {
              if (att && typeof att === 'object') {
                const a = att as { id?: unknown; assetId?: unknown };
                const aid = typeof a.id === 'string' ? a.id : typeof a.assetId === 'string' ? a.assetId : null;
                if (aid) publishAssetChanged(aid);
              }
            }
          }
          if (convId) {
            const isSelfSent = !!msg?.senderId && msg.senderId === meIdRef.current;
            const isOpen = convId === selectedConversationIdRef.current;
            setConversations((prev) =>
              prev.map((c) => {
                if (c.id !== convId) return c;
                const nextLastAt = msg?.createdAt ?? c.lastMessageAt ?? new Date().toISOString();
                // Don't bump unread for self-sent messages or when the user
                // currently has that conversation open. Either case "reads"
                // the message implicitly.
                const bumped = !isSelfSent && !isOpen;
                return {
                  ...c,
                  lastMessageAt: nextLastAt,
                  unreadCount: bumped ? (c.unreadCount ?? 0) + 1 : (c.unreadCount ?? 0),
                };
              }),
            );
          }
          return;
        }
        if (event.type === 'workspace_file.changed' || event.type.startsWith('asset.')) {
          const eventWorkspaceId = event.data?.workspaceId;
          if (workspaceId && (!eventWorkspaceId || eventWorkspaceId === workspaceId)) {
            invalidate('assets');
          }
          // Per-asset fan-out: forward the specific asset id into the in-process
          // asset-event bus so an individual chat-attachment card (which resolves
          // its own thumbnail via /:id/detail) can re-fetch ONLY its own row when
          // its derivative lands — no dependence on the coarse list invalidate
          // above, and reaches cards even when the event's workspace can't be
          // matched (agent-delivered assets whose payload may omit workspaceId).
          if (event.type === 'asset.changed') {
            publishAssetChanged(event.data?.assetId ?? null);
          }
          return;
        }
        if (event.type.startsWith('contact.')) {
          // Single re-pull for friends + sent + received covers every event
          // type — cheap relative to the visible UX win.
          invalidate('contacts');
          return;
        }
        if (event.type.startsWith('task.')) {
          // The task-stream hook owns the kanban refresh.
          return;
        }
        if (event.type.startsWith('approval.')) {
          return;
        }
        // v2.0.8 P0-3 (doc 21 §5.2) — accumulate dispatch in-flight set
        // so AgentStateStrip lights the agent's ring immediately. We
        // mutate by key, but React state needs a new Map instance to
        // trigger the agentStatuses recompute, so each update clones the
        // outer map shallowly. The inner Sets are also cloned only for
        // the affected agent — leaves untouched entries reference-stable
        // so the memo upstream short-circuits cleanly.
        if (event.type === 'dispatch.lifecycle') {
          const data = (
            event as {
              data?: {
                agentImUserId?: string;
                dispatchId?: string;
                lifecycle?: 'received' | 'started' | 'completed' | 'failed';
              };
            }
          ).data;
          const agentId = data?.agentImUserId;
          const dispatchId = data?.dispatchId;
          const lifecycle = data?.lifecycle;
          if (!agentId || !dispatchId || !lifecycle) return;
          setDispatchInFlight((prev) => {
            const prevSet = prev.get(agentId);
            if (lifecycle === 'received' || lifecycle === 'started') {
              if (prevSet?.has(dispatchId)) return prev;
              const nextSet = new Set(prevSet ?? []);
              nextSet.add(dispatchId);
              const next = new Map(prev);
              next.set(agentId, nextSet);
              return next;
            }
            // completed / failed → drop the dispatchId. No-op when
            // nothing to remove (e.g. we missed `received` on a stale
            // tab).
            if (!prevSet?.has(dispatchId)) return prev;
            const nextSet = new Set(prevSet);
            nextSet.delete(dispatchId);
            const next = new Map(prev);
            if (nextSet.size === 0) next.delete(agentId);
            else next.set(agentId, nextSet);
            return next;
          });
          return;
        }
        if (event.type.startsWith('runtime.')) {
          if (workspaceId) invalidate('runtime');
          return;
        }
        // Wave 3 C2 §4.8.2.3 — multi-daemon binding race surfacing. Treat
        // every agent.binding.* event as a canonical invalidation, including
        // contestCleared. Otherwise the left rail can keep a stale red badge
        // until the next poll even after the cloud cleared contestedSince.
        if (event.type.startsWith('agent.binding.')) {
          // Coalesced: marks the bindings domain dirty. The flush both
          // refetches the page-level contested count and dispatches the
          // `prismer:agent-binding` window event (once) for RuntimeManager's
          // list panel — so a replay/burst of binding events no longer fans
          // out into one duplicated REST pair per envelope.
          invalidate('bindings');
          return;
        }
      } catch {
        /* swallow malformed sync events — they don't represent contact state. */
      }
    };
    es.addEventListener('sync', handler);
    return () => {
      es.removeEventListener('sync', handler);
      es.close();
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, [
    isAuthenticated,
    isAuthLoading,
    me?.id,
    workspaceId,
    invalidate,
  ]);

  // Keep the SSE handler refs in sync with the latest selection + identity.
  // Done as plain assignments inside an effect so the long-lived ES doesn't
  // need to re-subscribe when the user clicks a different session.
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);
  useEffect(() => {
    meIdRef.current = me?.id ?? null;
  }, [me?.id]);

  // Clear unread count on the conversation the user just opened. Without
  // this the badge stays sticky even after they read the messages — the
  // server doesn't push a "read" event back to ourselves. Also persist the
  // cursor server-side; otherwise refresh recomputes the unread count from
  // the old IMReadCursor and the badge comes back.
  //
  // 2026-05-23 fix: pre-fix this was a single fire-and-forget POST that
  // silently swallowed 401/403/transient-network errors. Test DB forensic
  // showed 34 IMReadCursor rows total across 4 months + 70k messages,
  // proving most markRead writes were dropped. Now: 3 attempts with
  // exponential backoff (200ms/600ms/1.8s), explicit log on final fail.
  useEffect(() => {
    if (!selectedConversationId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConversationId && (c.unreadCount ?? 0) > 0 ? { ...c, unreadCount: 0 } : c)),
    );
    const convId = selectedConversationId;
    let cancelled = false;
    void (async () => {
      let attempt = 0;
      const maxAttempts = 3;
      while (attempt < maxAttempts && !cancelled) {
        const res = await imFetch(`/conversations/${encodeURIComponent(convId)}/read`, { method: 'POST' });
        if (res.ok) return;
        attempt += 1;
        if (attempt >= maxAttempts) {
          console.warn(
            `[workspace] markRead persistence failed after ${maxAttempts} attempts for conv ${convId}; ` +
              `unreadCount may resurface on refresh. lastError=${res.message ?? 'unknown'}`,
          );
          return;
        }
        // Exponential backoff: 200 / 600 / 1800 ms
        await new Promise((r) => setTimeout(r, 200 * 3 ** (attempt - 1)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedConversationId]);

  const streamState = useTaskStream({
    workspaceId: workspace?.id ?? null,
    onUpdate: reloadTasks,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      reloadTasks(),
      workspaceId ? reloadConversations(workspaceId) : Promise.resolve(),
      reloadAgents(),
      reloadContacts(),
      workspaceId ? reloadProfiles(workspaceId) : Promise.resolve(),
      workspaceId ? reloadRuntime(workspaceId) : Promise.resolve(),
      workspaceId ? reloadRuntimeInstallations(workspaceId) : Promise.resolve(),
      workspaceId ? reloadContestedBindings() : Promise.resolve(),
      workspaceId ? reloadAssets(workspaceId) : Promise.resolve(),
    ]);
    setRefreshing(false);
  }, [
    reloadTasks,
    reloadConversations,
    reloadAgents,
    reloadContacts,
    reloadProfiles,
    reloadRuntime,
    reloadRuntimeInstallations,
    reloadContestedBindings,
    reloadAssets,
    workspaceId,
  ]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const selectedConversationAccess = useMemo(() => conversationAccess(selectedConversation), [selectedConversation]);

  // ─── Wave-8 W10: linked-context derivations ─────────────────────────────
  //
  // Pure client-side filters over state we already hold. No new endpoints
  // (per the wave-8 plan §3.5) — everything below is cheap to recompute on
  // each conversation switch because tasks/agents/assets are workspace-
  // scoped lists already capped at 100-200 rows.
  const linkedTasks = useMemo(() => {
    if (!selectedConversationId) return [] as TaskDTO[];
    return tasks.filter((task) => task.conversationId === selectedConversationId);
  }, [tasks, selectedConversationId]);

  const linkedAgents = useMemo(() => {
    if (!selectedConversation?.participants) return [] as AgentDTO[];
    // Match participant.userId (im_users.id) against AgentDTO.userId — the
    // workspace registry exposes both, see lib/types.ts §AgentDTO.
    const participantIds = new Set(selectedConversation.participants.map((p) => p.userId));
    return agents.filter((agent) => participantIds.has(agent.userId));
  }, [selectedConversation, agents]);

  // Workspace-wide imUserId → agentType lookup. Feeds ImChannel's message
  // avatars and members panel so each agent renders with its role icon
  // (Crown for CEO, Wrench for Engineer, etc.) instead of the generic Bot.
  // Membership in this map ALSO signals "this id is an agent" — humans
  // simply aren't present, so the Avatar falls back to initials.
  const agentTypeByImUserId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const a of agents) {
      if (a.agentType) out[a.userId] = a.agentType;
    }
    return out;
  }, [agents]);

  // release202/09 avatar consistency — message avatars need the agent's ASCII
  // username (ceo/engineer/marketer) to resolve the role icon (agentType is a
  // generic tier that maps to no icon; localized names never match). AgentDTO
  // exposes only `userId` (the /me/agents row id), so we ALSO key by username
  // → username (identity bridge): the workspace can carry multiple im_users
  // rows for one logical agent (cloudUserId numericId-vs-userId divergence,
  // see register.ts cloudOwnerWhere), so a message `senderId` may be a
  // duplicate row not in this map. The companion `agentUsernames` set lets the
  // message row detect agent senders by the conversation member's username
  // even when the id misses.
  const usernameByImUserId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const a of agents) {
      if (a.username) out[a.userId] = a.username;
    }
    return out;
  }, [agents]);
  const agentUsernames = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const a of agents) {
      if (a.username) out.add(a.username);
    }
    return out;
  }, [agents]);
  const [currentTime] = useState(() => Date.now());

  // Task 3 — workspace-wide agent live-status map. Powered by the shared
  // SSE phase store (singleton subscriber, opened lazily on first mount)
  // plus the agents / tasks / runtime triple page already holds. Recomputes
  // every 10s via `statusTick` so heartbeat-aged offline/stuck transitions
  // surface without needing a separate SSE event.
  const phaseMap = useAgentPhaseMap();
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStatusTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // v2.0.8 P0-3 (doc 21 §5.2) — dispatch in-flight accumulator. SSE
  // `dispatch.lifecycle` events update this; `agentStatuses` derives
  // 'working' classification when count > 0. Keyed by agentImUserId →
  // Set<dispatchId> so duplicate `received` echoes from multiple Pods
  // don't inflate the count (idempotent add/remove). Map collapses to
  // Map<userId, number> for the deriveAgentStatus input.
  const [dispatchInFlight, setDispatchInFlight] = useState<Map<string, Set<string>>>(() => new Map());
  const dispatchInFlightByAgent = useMemo<Map<string, number>>(() => {
    const out = new Map<string, number>();
    for (const [agentId, set] of dispatchInFlight) {
      if (set.size > 0) out.set(agentId, set.size);
    }
    return out;
  }, [dispatchInFlight]);

  const agentStatuses = useMemo<Map<string, AgentLiveStatus>>(() => {
    return deriveWorkspaceAgentStatuses({
      agents,
      tasks,
      runtime,
      taskPhases: phaseMap,
      dispatchInFlightByAgent,
      now: Date.now(),
    });
    // statusTick is intentional — drives the recompute. ESLint warns but the
    // tick value is unused inside the body (only its reference triggers
    // re-derivation when heartbeats age out without new SSE events).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, tasks, runtime, phaseMap, dispatchInFlightByAgent, statusTick]);

  const sessionAssets = useMemo(() => {
    if (!selectedConversationId) return [] as AssetDTO[];
    return assets
      .filter((asset) => {
        const meta = asset.metadata ?? {};
        const cid = typeof meta.conversationId === 'string' ? meta.conversationId : null;
        if (cid !== selectedConversationId) return false;
        return asset.kind !== 'preview' && asset.sourceKind !== 'asset-derived' && !asset.derivationKind;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [assets, selectedConversationId]);

  const recentAssets = useMemo(() => {
    const cutoff = currentTime - 7 * 24 * 60 * 60 * 1000;
    return sessionAssets
      .filter((asset) => {
        const ts = Date.parse(asset.createdAt);
        return Number.isFinite(ts) && ts >= cutoff;
      })
      .slice(0, 3);
  }, [currentTime, sessionAssets]);

  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== 'cancelled'), [tasks]);

  const taskStats = useMemo(() => {
    const total = activeTasks.length;
    const inProgress = activeTasks.filter((task) => task.status === 'running' || task.status === 'review').length;
    const done = activeTasks.filter((task) => task.status === 'completed').length;
    return { total, inProgress, done };
  }, [activeTasks]);

  useEffect(() => {
    function onProfileUpdated(event: Event) {
      const updated = (event as CustomEvent<Partial<UserProfileDTO>>).detail;
      if (!updated?.id) return;
      setMe((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      setContacts((prev) =>
        prev.map((contact) =>
          contact.userId === updated.id
            ? {
                ...contact,
                username: updated.username ?? contact.username,
                displayName: updated.displayName ?? contact.displayName,
                ...(Object.prototype.hasOwnProperty.call(updated, 'avatarUrl') ? { avatarUrl: updated.avatarUrl } : {}),
              }
            : contact,
        ),
      );
      if (workspaceId) void reloadConversations(workspaceId);
    }
    window.addEventListener('prismer:im-profile-updated', onProfileUpdated);
    return () => window.removeEventListener('prismer:im-profile-updated', onProfileUpdated);
  }, [reloadConversations, workspaceId]);

  // Wave-8 W10 — task drawer reverse-link. Drops the user back into the IM
  // panel, selects the conversation, and (on mobile) flips to the sessions
  // surface so the chat is actually visible. Closing the drawer would be
  // jarring as a side effect, so we leave it open — users can click the
  // chip on the chat header strip to come back to the same task.
  const onOpenChatFromTask = useCallback(
    (conversationId: string) => {
      setSelectedConversationId(conversationId);
      setActiveSurface('chats');
      if (isMobileViewport) {
        setMobileSurface('chats');
      }
    },
    [isMobileViewport],
  );

  // Wave-8 W10 — open agent inspector from chat header chip. Re-uses the
  // existing inspector dialog which already knows how to render the agent
  // profile pane.
  const onOpenAgentInspector = useCallback((agentId: string) => {
    setInspector({ kind: 'agent', agentId });
  }, []);

  // Wave-8 W10 — open asset inspector from chat header chip.
  // Where the asset preview was opened FROM (e.g. 'chats'), so closing it
  // returns there — to the same session at its scroll position — instead of
  // stranding the user on the 'library' surface the preview forces.
  const assetInspectorOriginRef = useRef<WorkspaceSurface | null>(null);
  const onOpenAssetInspector = useCallback(
    (assetId: string) => {
      // Wide desktop: dock the preview beside the current surface (split) so
      // the user keeps their context (e.g. the chat they opened it from).
      // Narrow / mobile: keep the legacy behaviour — switch to the library
      // surface and overlay it full screen.
      const canSplit = previewContainerWideRef.current && !isMobileViewport;
      if (canSplit) {
        assetInspectorOriginRef.current = activeSurface;
        // Split docks beside the current surface — not pinned until maximized.
        previewSurfaceRef.current = null;
      } else {
        if (activeSurface !== 'library') assetInspectorOriginRef.current = activeSurface;
        setActiveSurface('library');
        setMobileSurface('library');
        // Full from the start — pinned to the library surface it overlays.
        previewSurfaceRef.current = 'library';
      }
      setPreviewMaximized(false);
      setInspector({ kind: 'asset', assetId });
      replaceWorkspaceAssetQuery(assetId);
    },
    [activeSurface, isMobileViewport],
  );

  const openInspector = useCallback(
    (next: WorkspaceInspector) => {
      if (next.kind === 'asset') {
        onOpenAssetInspector(next.assetId);
        return;
      }
      setInspector(next);
      replaceWorkspaceAssetQuery(null);
    },
    [onOpenAssetInspector],
  );

  const closeInspector = useCallback(() => {
    if (inspector?.kind === 'asset') {
      replaceWorkspaceAssetQuery(null);
      // Return to the surface the preview was opened from (e.g. the chat
      // session). The chats surface remounts ImChannel, whose module-level
      // scroll memory restores the prior scroll position.
      const origin = assetInspectorOriginRef.current;
      assetInspectorOriginRef.current = null;
      if (origin && origin !== 'library') {
        setActiveSurface(origin);
        setMobileSurface(origin);
      }
    }
    setPreviewMaximized(false);
    previewSurfaceRef.current = null;
    setInspector(null);
  }, [inspector]);

  // Wave-8 W4: pin/mute toggle helpers — backend already exposes both PATCH
  // endpoints under /conversations/:id/{pin,mute}. After mutation we just
  // reload the conversations list so LeftRail re-sorts pinned to top.
  const togglePinSession = useCallback(
    async (conversationId: string, pinned: boolean) => {
      const res = await imFetch(`/conversations/${encodeURIComponent(conversationId)}/pin`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) {
        addToast(`Pin failed: ${res.message}`, 'error');
        return;
      }
      if (workspaceId) await reloadConversations(workspaceId);
    },
    [addToast, reloadConversations, workspaceId],
  );
  const toggleMuteSession = useCallback(
    async (conversationId: string, muted: boolean) => {
      const res = await imFetch(`/conversations/${encodeURIComponent(conversationId)}/mute`, {
        method: 'PATCH',
        body: JSON.stringify({ muted }),
      });
      if (!res.ok) {
        addToast(`Mute failed: ${res.message}`, 'error');
        return;
      }
      if (workspaceId) await reloadConversations(workspaceId);
    },
    [addToast, reloadConversations, workspaceId],
  );
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    const fromBoard = tasks.find((task) => task.id === selectedTaskId);
    if (fromBoard) return fromBoard;
    if (selectedTaskFallback?.id === selectedTaskId) return selectedTaskFallback;
    return null;
  }, [tasks, selectedTaskId, selectedTaskFallback]);

  // Consume the `?focusTaskId=` query param once the workspace loads — the
  // initial bootstrap finishes before tasks arrive, so we can't openTask in
  // the URL effect itself (it would race the cache check).
  useEffect(() => {
    if (!pendingFocusTaskId || !workspace?.id) return;
    const id = pendingFocusTaskId;
    setPendingFocusTaskId(null);
    void openTaskByIdInternal(id);
    // openTaskByIdInternal is hoisted via the function declaration below; the
    // closure picks up the latest reference each render.
    function openTaskByIdInternal(taskId: string) {
      // Inline fetch (don't depend on the openTaskById callback we declare
      // below — that would create a circular dep in the React Compiler infer).
      setSelectedTaskId(taskId);
      const cached = taskFetchCacheRef.current.get(taskId);
      if (cached && Date.now() - cached.ts < 5 * 60_000) {
        setSelectedTaskFallback(cached.task);
        return Promise.resolve();
      }
      return imFetch<{ task: TaskDTO } | TaskDTO>(`/tasks/${encodeURIComponent(taskId)}`).then((res) => {
        if (!res.ok) {
          addToast(`Couldn't open task ${taskId.slice(-8)}: ${res.message}`, 'error');
          setSelectedTaskId(null);
          return;
        }
        const fetched = (res.data as { task?: TaskDTO }).task ?? (res.data as TaskDTO);
        taskFetchCacheRef.current.set(taskId, { task: fetched, ts: Date.now() });
        setSelectedTaskFallback(fetched);
      });
    }
  }, [pendingFocusTaskId, workspace?.id, addToast]);

  // Open a task by id — works for board tasks (immediate) and off-board tasks
  // like agent_run subtasks (fetches /tasks/:id with a 5-min cache so chat
  // → drawer and breadcrumb navigation don't hammer the API).
  const openTaskById = useCallback(
    async (taskId: string) => {
      setSelectedTaskId(taskId);
      // Already on the board — drawer renders from kanban data.
      if (tasks.some((task) => task.id === taskId)) {
        setSelectedTaskFallback(null);
        return;
      }
      // Cache hit — drawer renders the previously-fetched copy while its own
      // detail effect kicks off the fresh GET /tasks/:id with logs.
      const cached = taskFetchCacheRef.current.get(taskId);
      const FIVE_MIN_MS = 5 * 60_000;
      if (cached && Date.now() - cached.ts < FIVE_MIN_MS) {
        setSelectedTaskFallback(cached.task);
        return;
      }
      const res = await imFetch<{ task: TaskDTO } | TaskDTO>(`/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) {
        addToast(`Couldn't open task ${taskId.slice(-8)}: ${res.message}`, 'error');
        setSelectedTaskId(null);
        return;
      }
      // GET /tasks/:id returns a TaskDetail envelope { task, logs, ... }; fall
      // back to the bare TaskDTO shape for forward compatibility.
      const fetched = (res.data as { task?: TaskDTO }).task ?? (res.data as TaskDTO);
      taskFetchCacheRef.current.set(taskId, { task: fetched, ts: Date.now() });
      setSelectedTaskFallback(fetched);
    },
    [tasks, addToast],
  );

  // ─── Mutation callbacks ────────────────────────────────────────────────

  const onAgentCreated = useCallback(
    async (result?: { conversationId?: string }) => {
      // After register the cloud guarantees the human's default workspace
      // exists (cookbook §3 side-effect). If we didn't have one before, refetch.
      await reloadAgents();
      if (workspaceId) {
        await reloadProfiles(workspaceId);
        await reloadRuntime(workspaceId);
        await reloadRuntimeInstallations(workspaceId);
        if (result?.conversationId) {
          await reloadConversations(workspaceId);
          setSelectedConversationId(result.conversationId);
          setActiveSurface('chats');
          setMobileSurface('chats');
        }
      }
      if (!workspaceId) {
        const wsRes = await imFetch<WorkspaceDTO[]>('/workspaces');
        if (wsRes.ok) {
          const list = wsRes.data ?? [];
          const def = list.find((w) => w.isDefault) ?? list[0] ?? null;
          if (def) {
            setWorkspace(def);
            if (result?.conversationId) {
              await reloadConversations(def.id);
              setSelectedConversationId(result.conversationId);
              setActiveSurface('chats');
              setMobileSurface('chats');
            }
            await reloadRuntime(def.id);
            await reloadRuntimeInstallations(def.id);
          }
        }
      }
    },
    [reloadAgents, reloadProfiles, reloadRuntime, reloadRuntimeInstallations, reloadConversations, workspaceId],
  );

  const onCreateRuntime = useCallback(async () => {
    if (!workspaceId) return;
    const res = await imFetch<RuntimeInstallationDTO>('/api/workspace/runtime-installations', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      addToast(`Cloud device create failed: ${res.message}`, 'error');
      return;
    }
    await Promise.all([reloadRuntimeInstallations(workspaceId), reloadRuntime(workspaceId)]);
    addToast('Cloud device provisioning started.', 'success');
  }, [workspaceId, addToast, reloadRuntimeInstallations, reloadRuntime]);

  const onChannelCreated = useCallback(
    async (newConvId: string) => {
      if (!workspaceId) return;
      await reloadConversations(workspaceId);
      setSelectedConversationId(newConvId);
      setActiveSurface('chats');
      setMobileSurface('chats');
    },
    [reloadConversations, workspaceId],
  );

  const onRenameSession = useCallback(
    async (session: ConversationDTO) => {
      if (session.type === 'direct') {
        addToast('Direct session title follows the contact name.', 'info');
        return;
      }
      const currentTitle = session.displayTitle || session.title || '';
      const title = window.prompt('Rename session', currentTitle);
      if (title == null) return;
      const trimmed = title.trim();
      if (!trimmed) {
        addToast('Session title cannot be empty.', 'error');
        return;
      }
      const res = await imFetch<ConversationDTO>(`/conversations/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        addToast(`Rename failed: ${res.message}`, 'error');
        return;
      }
      if (workspaceId) await reloadConversations(workspaceId);
      addToast('Session renamed.', 'success');
    },
    [addToast, reloadConversations, workspaceId],
  );

  const onArchiveSession = useCallback(
    async (session: ConversationDTO) => {
      const res = await imFetch(`/conversations/${encodeURIComponent(session.id)}/archive`, { method: 'POST' });
      if (!res.ok) {
        addToast(`Archive failed: ${res.message}`, 'error');
        return;
      }
      if (selectedConversationId === session.id) {
        setSelectedConversationId(null);
      }
      if (workspaceId) await reloadConversations(workspaceId);
      addToast('Session archived.', 'success');
    },
    [addToast, reloadConversations, selectedConversationId, workspaceId],
  );

  const onDeleteSession = useCallback(
    async (session: ConversationDTO) => {
      const access = conversationAccess(session);
      const action = access.canDelete ? 'Delete' : 'Leave';
      if (!window.confirm(`${action} "${session.displayTitle || session.title || 'this session'}"?`)) return;
      const res = await imFetch(`/conversations/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast(`${action} failed: ${res.message}`, 'error');
        return;
      }
      if (selectedConversationId === session.id) {
        setSelectedConversationId(null);
      }
      if (workspaceId) await reloadConversations(workspaceId);
      addToast(access.canDelete ? 'Session deleted.' : 'Session left.', 'success');
    },
    [addToast, reloadConversations, selectedConversationId, workspaceId],
  );

  const onStartContactChat = useCallback(
    async (contactId: string) => {
      const existing = await imFetch<{ exists: boolean; conversationId?: string }>(
        `/direct/${encodeURIComponent(contactId)}`,
      );
      if (existing.ok && existing.data.exists && existing.data.conversationId) {
        if (workspaceId) await reloadConversations(workspaceId);
        setSelectedConversationId(existing.data.conversationId);
        setActiveSurface('chats');
        setMobileSurface('chats');
        return;
      }

      const created = await imFetch<ConversationDTO>('/conversations/direct', {
        method: 'POST',
        body: JSON.stringify({ otherUserId: contactId, workspaceId: workspaceId ?? undefined }),
      });
      if (!created.ok) {
        addToast(`Chat failed: ${created.message}`, 'error');
        return;
      }
      if (workspaceId) await reloadConversations(workspaceId);
      setSelectedConversationId(created.data.id);
      setActiveSurface('chats');
      setMobileSurface('chats');
    },
    [addToast, reloadConversations, workspaceId],
  );

  const onSelectSession = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) {
        setSelectedConversationId(null);
        return;
      }
      if (sessionId === selectedConversationId) {
        setActiveSurface('chats');
        setMobileSurface('chats');
        return;
      }
      setSelectedConversationId(sessionId);
      setActiveSurface('chats');
      setMobileSurface('chats');
    },
    [selectedConversationId],
  );

  const onUploadAsset = useCallback(() => {
    setUploadTarget(null);
    uploadInputRef.current?.click();
  }, []);

  // Composer attachment-panel entry (File / Photos / Camera in the chat input).
  // Differs from `onUploadAsset` (which is library-only) by tagging the upload
  // target with `attachToConversation` so the post-upload step also POSTs a
  // markdown message with the asset attached — otherwise files vanish into
  // the asset library instead of appearing in the conversation stream.
  const onComposerUploadAsset = useCallback(() => {
    if (!selectedConversationId) {
      setUploadTarget(null);
      uploadInputRef.current?.click();
      return;
    }
    setUploadTarget({
      conversationId: selectedConversationId,
      attachToConversation: true,
      inputIntent: 'file_attachment',
    });
    uploadInputRef.current?.click();
  }, [selectedConversationId]);

  const onUploadTaskAttachment = useCallback(
    (taskId: string) => {
      setUploadTarget({ sourceTaskId: taskId, conversationId: selectedConversationId });
      uploadInputRef.current?.click();
    },
    [selectedConversationId],
  );

  const uploadAssetFiles = useCallback(
    async (
      files: File[],
      target?: {
        conversationId?: string | null;
        sourceTaskId?: string | null;
        attachToConversation?: boolean;
        inputIntent?: 'vision_input' | 'file_attachment';
      } | null,
    ) => {
      if (!workspaceId || files.length === 0) return;
      let lastAsset: AssetDTO | null = null;
      const effectiveTarget = target ?? uploadTarget;
      for (const [fileIndex, file] of files.entries()) {
        // Wave-8 W10: when the upload originates inside a session (the
        // attachments panel button or the chat composer's paperclip), tag
        // the asset metadata with `conversationId` so the linked-context
        // strip on the chat header can surface it back as a recent asset.
        const meta: Record<string, unknown> = { title: file.name };
        if (effectiveTarget?.conversationId ?? selectedConversationId) {
          meta.conversationId = effectiveTarget?.conversationId ?? selectedConversationId;
        }
        const targetIntent =
          effectiveTarget?.inputIntent ??
          (effectiveTarget?.attachToConversation
            ? file.type.startsWith('image/')
              ? 'vision_input'
              : 'file_attachment'
            : null);
        if (targetIntent) {
          meta.intent = targetIntent;
          meta.inputIntent = targetIntent;
        }
        if (effectiveTarget?.sourceTaskId) {
          meta.taskId = effectiveTarget.sourceTaskId;
        }
        let res;
        try {
          res = await uploadAssetWithDirectFallback({
            file,
            workspaceId,
            metadata: meta,
            sourceTaskId: effectiveTarget?.sourceTaskId,
            imFetch,
            onProgress: (progress) =>
              setUploadProgress({
                filename: file.name,
                fileIndex: fileIndex + 1,
                totalFiles: files.length,
                progress,
              }),
          });
        } catch (err) {
          addToast(
            `Asset upload failed: could not hash "${file.name}" before upload (${err instanceof Error ? err.message : 'unknown error'}).`,
            'error',
          );
          continue;
        }
        if (!res.ok) {
          addToast(`Asset upload failed: ${res.message}`, 'error');
          continue;
        }
        const asset = res.data;
        lastAsset = asset;
        await imFetch<WorkspaceFileDTO>(`/workspaces/${encodeURIComponent(workspaceId)}/files`, {
          method: 'POST',
          body: JSON.stringify({ path: file.name, assetId: asset.id }),
        });

        // Composer-originated upload: also send a markdown message with the
        // asset as an attachment, mirroring im-channel's `sendAssetAttachment`
        // (drag-drop) shape so the message renders the same way and the
        // dispatcher contract (`metadata.assetIds`) reaches the daemon.
        if (effectiveTarget?.attachToConversation && effectiveTarget.conversationId) {
          const attachKind: MessageAttachmentDTO['kind'] = (() => {
            const k = asset.kind;
            if (k === 'file' || k === 'image' || k === 'audio' || k === 'video' || k === 'asset') return k;
            const m = asset.mime ?? '';
            if (m.startsWith('image/')) return 'image';
            if (m.startsWith('audio/')) return 'audio';
            if (m.startsWith('video/')) return 'video';
            return 'file';
          })();
          const title = asset.filename || file.name;
          const attachment: MessageAttachmentDTO = {
            kind: attachKind,
            assetId: asset.id,
            title,
            filename: title,
            mime: asset.mime ?? null,
            sizeBytes: asset.sizeBytes ?? null,
            contentHash: asset.contentHash ?? null,
            thumbnailUrl: asset.thumbnailUrl ?? null,
            revision: asset.revision ?? null,
            role: 'attachment',
          };
          const sendRes = await sendMessage({
            conversationId: effectiveTarget.conversationId,
            content: `Attached asset: ${title}`,
            type: 'markdown',
            metadata: {
              kind: 'workspace_asset_attachment',
              assetIds: [asset.id],
              asset: {
                id: asset.id,
                assetId: asset.id,
                title,
                kind: asset.kind,
                mime: asset.mime,
                sizeBytes: asset.sizeBytes,
                contentHash: asset.contentHash,
                intent: targetIntent ?? 'file_attachment',
              },
            },
            attachments: [attachment],
          });
          if (!sendRes.ok) {
            addToast(`Asset uploaded, but message attach failed: ${sendRes.message}`, 'error');
          }
        }
      }
      await reloadAssets(workspaceId);
      // Don't pop the asset inspector when the file was attached to a
      // conversation — the user already sees it in the chat stream, and an
      // inspector overlay would feel like a context switch they didn't ask for.
      if (lastAsset && !effectiveTarget?.sourceTaskId && !effectiveTarget?.attachToConversation) {
        onOpenAssetInspector(lastAsset.id);
      }
      setUploadTarget(null);
      setUploadProgress(null);
      addToast(
        files.length === 1 ? `Asset "${files[0].name}" uploaded.` : `${files.length} assets uploaded.`,
        'success',
      );
    },
    [workspaceId, selectedConversationId, uploadTarget, addToast, reloadAssets, onOpenAssetInspector],
  );

  const onAssetFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      const target = uploadTarget;
      setUploadTarget(null);
      await uploadAssetFiles(files, target);
    },
    [uploadAssetFiles, uploadTarget],
  );

  const onComposerPasteFiles = useCallback(
    async (files: File[]) => {
      await uploadAssetFiles(
        files,
        selectedConversationId ? { conversationId: selectedConversationId, attachToConversation: true } : null,
      );
    },
    [selectedConversationId, uploadAssetFiles],
  );

  const onTaskCreated = useCallback(async () => {
    await reloadTasks();
  }, [reloadTasks]);

  // §30 B3.7 / B3.4 — UnifiedCreationModal demux. Single "+" entry now fires
  // one of six discriminated events (workspace / device / agent / conversation
  // / task / simple-team). We mirror the existing per-flow callbacks
  // (onAgentCreated, onChannelCreated, onTaskCreated, reloadRuntimeInstallations)
  // so the main screen refreshes immediately without a manual reload.
  //
  // simple-team is the load-bearing path: Simple Mode provisions 3+ agents +
  // a "团队会议" group conversation; we must reload BOTH lists and navigate
  // to the new conversation so the user sees the CEO welcome message.
  const onUnifiedCreated = useCallback(
    (event: UnifiedCreationEvent) => {
      console.log('[Workspace] unified creation event', event);
      setUnifiedOpen(false);

      switch (event.kind) {
        case 'workspace': {
          // Workspace switching isn't wired into this surface yet. The
          // CreateWorkspace flow inside Pro Mode creates the workspace on
          // the backend; switching to it is a follow-up (would need to
          // update `workspace` state + cascade reloads). For now we log
          // and let the user pick it from the workspace switcher.
          break;
        }
        case 'device': {
          if (workspaceId) void reloadRuntimeInstallations(workspaceId);
          break;
        }
        case 'agent': {
          // Pro Mode single-agent path: no conversationId attached. Reuse
          // onAgentCreated so workspace bootstrap + profile/runtime
          // refresh still happens for the very-first-agent case.
          void onAgentCreated();
          break;
        }
        case 'conversation': {
          // Pro Mode channel creation. onChannelCreated handles
          // reloadConversations + navigate + im-pane expand.
          void onChannelCreated(event.id);
          break;
        }
        case 'task': {
          void onTaskCreated();
          break;
        }
        case 'simple-team': {
          // Simple Mode 3-stage completion: refresh agents + conversations,
          // then jump into the freshly-minted group so the user sees the
          // CEO welcome message immediately.
          //
          // Defensive against reload failure: backend has already created the
          // 3 agents + group + welcome message before this event fires, so a
          // sidebar-refresh blip must NOT block navigation. Any failure here
          // would otherwise leave the user staring at an empty workspace with
          // an unhandled rejection in console — silent UX disaster.
          void (async () => {
            try {
              if (event.organizationName && workspaceId) {
                setWorkspace((prev) =>
                  prev && prev.id === workspaceId
                    ? {
                        ...prev,
                        name: event.organizationName ?? prev.name,
                        metadata: {
                          ...(prev.metadata ?? {}),
                          organizationName: event.organizationName,
                          simpleModeOrganizationName: event.organizationName,
                        },
                      }
                    : prev,
                );
              }
              await reloadAgents();
              if (workspaceId) {
                // allSettled — refresh failures in any one source must not
                // cancel the navigate or the remaining refreshes.
                await Promise.allSettled([
                  reloadProfiles(workspaceId),
                  reloadRuntime(workspaceId),
                  reloadRuntimeInstallations(workspaceId),
                  reloadConversations(workspaceId),
                ]);
              }
              // After the group + welcome land, mint a 1:1 direct
              // conversation with each role agent so the human has a
              // private channel for each persona (kept parallel to the
              // group's "团队会议" all-hands feed). The backend dedupes by
              // (callerId, otherUserId), so re-running this on retry is
              // idempotent. We allSettled them — partial failures are
              // logged but never block navigate.
              if (event.agentIds && event.agentIds.length > 0) {
                const directs = await Promise.allSettled(
                  event.agentIds.map((agentId) => createDirectConversation(agentId, workspaceId ?? null)),
                );
                const failed = directs.filter(
                  (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok),
                ).length;
                if (failed > 0) {
                  console.warn(`[Workspace] ${failed}/${event.agentIds.length} direct sessions failed to create`);
                }
                if (workspaceId && failed < event.agentIds.length) {
                  // Refresh conversations again so the new direct rows
                  // show up in the LeftRail sessions list.
                  await reloadConversations(workspaceId);
                }
              }

              // Task 43 — Pre-seed a demo task + a product-intro markdown
              // asset so the post-creation LaunchTour subagent has real
              // cards to highlight. Best-effort: any internal failure
              // resolves to `null` ids inside the helper; an unhandled
              // throw is caught here. MUST NOT block navigation.
              const seed = await seedLaunchTourContent({
                workspaceId,
                conversationId: event.conversationId,
                agentIds: event.agentIds ?? [],
                organizationName: event.organizationName ?? null,
              }).catch((err) => {
                console.warn('[Workspace] launch-tour seed failed', err);
                return null;
              });
              if (seed) {
                setLaunchTourSeed(seed);
                setLaunchTourStage('pending');
              }
              // Refresh tasks + assets so the seeded rows are visible on
              // the kanban / library before the launch tour starts.
              if (workspaceId) {
                await Promise.allSettled([reloadTasks(), reloadAssets(workspaceId)]);
              }
            } catch (err) {
              console.error('[Workspace] simple-team post-success refresh failed', err);
              addToast('团队已创建,但侧边栏刷新失败,请手动刷新页面', 'info');
            }
            // Navigate ALWAYS runs: conversationId is backend-confirmed and
            // the navigate itself doesn't depend on the reload succeeding.
            setSelectedConversationId(event.conversationId);
            setActiveSurface('chats');
            setMobileSurface('chats');
          })();
          break;
        }
        default: {
          // Exhaustiveness guard. If a new kind is added to
          // UnifiedCreationEvent without updating this demux, TS will
          // surface it here.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    },
    [
      workspaceId,
      onAgentCreated,
      onChannelCreated,
      onTaskCreated,
      reloadAgents,
      reloadAssets,
      reloadConversations,
      reloadProfiles,
      reloadRuntime,
      reloadRuntimeInstallations,
      reloadTasks,
      addToast,
    ],
  );

  const onOpenNewTask = useCallback((column?: KanbanColumnKey) => {
    setNewTaskInitialColumn(column ?? null);
    setNewTaskOpen(true);
  }, []);

  const onOpenTaskById = useCallback(
    (taskId: string) => {
      setActiveSurface('tasks');
      setMobileSurface('tasks');
      void openTaskById(taskId);
    },
    [openTaskById],
  );

  // P1 (Debug Pipeline 2026-05-24) — stub retry callback for the
  // DeliveryTimelineChip. P2 (parallel session, daemon-retry domain)
  // wires this to `POST /api/im/tasks/runs/:id/retry` or equivalent;
  // for now we only log so the chip's [Retry] button is observably
  // present without making a half-baked network call.
  const onRetryDeliveryMessage = useCallback(
    (messageId: string) => {
      console.log('[workspace] TODO: retry delivery for message', messageId);
      addToast('Retry coming in P2 — daemon retry path still in flight.', 'info');
    },
    [addToast],
  );

  // Default assignee for "+ Task" when invoked from a conversation context:
  // pick the first non-self member of the active group. Falls back to the
  // first registered agent so the form is at least pre-populated.
  const defaultTaskAssigneeId = useMemo(() => {
    return agents[0]?.userId;
  }, [agents]);

  // Memoize the SessionSettingsMenu element so ImChannel sees a stable
  // headerActions reference across page re-renders. Without this, every
  // page render builds a fresh React element + new inline closures, and
  // the dropdown can detach mid-click as ImChannel reconciles. Keyed off
  // selectedConversation (id + flags) + theme + the relevant handlers.
  const sessionSettingsMenuElement = useMemo(() => {
    if (!selectedConversation) return null;
    return (
      <SessionSettingsMenu
        isDark={isDark}
        isGroup={selectedConversation.type !== 'direct'}
        pinned={Boolean(selectedConversation.pinned)}
        muted={Boolean(selectedConversation.muted)}
        canAddMember={selectedConversationAccess.canAddMember}
        canRename={selectedConversationAccess.canRename}
        canPin={selectedConversationAccess.canPin}
        canMute={selectedConversationAccess.canMute}
        canArchive={selectedConversationAccess.canArchive}
        canLeave={selectedConversationAccess.canLeave}
        canDelete={selectedConversationAccess.canDelete}
        onAddMember={() => setAddMemberOpen(true)}
        onRename={() => setRenameOpen(true)}
        onTogglePin={() => void togglePinSession(selectedConversation.id, !selectedConversation.pinned)}
        onToggleMute={() => void toggleMuteSession(selectedConversation.id, !selectedConversation.muted)}
        onArchive={() => void onArchiveSession(selectedConversation)}
        onLeave={() => void onDeleteSession(selectedConversation)}
        onDelete={() => void onDeleteSession(selectedConversation)}
      />
    );
  }, [
    selectedConversation,
    selectedConversationAccess,
    isDark,
    togglePinSession,
    toggleMuteSession,
    onArchiveSession,
    onDeleteSession,
  ]);

  // Task 41 — Auto-open Simple Mode for fresh users. Server-derived "no
  // devices" is the only gate (per user direction): a workspace with no
  // daemon is unusable regardless of how many orphan agent rows exist.
  // Fires once per page session via `autoOpenedSimple`. The user can still
  // close the modal; we don't re-open on close because the flag stays true.
  useEffect(() => {
    if (bootstrapping || bootstrapError) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    // 1. runtime 未加载完 — 不决策,等下一次 effect 重跑
    if (runtime === undefined || runtime === null) return;
    // 2. 已有 daemonStatus='connected' 的真实在线 device — 不弹
    const connectedDevices = runtime.devices?.filter((d) => d.daemonStatus === 'connected') ?? [];
    if (connectedDevices.length > 0) return;
    // 3. 刚创建过 / 正在创建 / 刚失败的 device — 不反复弹创建向导。
    // Runtime 面板会显示对应 failed/provisioning card 和错误详情。
    if (hasRecentDeviceAttempt(runtimeInstallations)) return;
    // 4. workspace 已标记 onboarding 完成 — 不弹(metadata 字段可能不存在,安全访问)
    if (workspace?.metadata?.onboardingComplete === true) return;
    // 5. 已经在本 session 弹过 — 不重弹
    if (autoOpenedSimple) return;
    setAutoOpenedSimple(true);
    setUnifiedInitialMode('simple');
    setUnifiedOpen(true);
  }, [bootstrapping, bootstrapError, autoOpenedSimple, runtime, runtimeInstallations, workspace]);

  // First-visit tour gating: open after bootstrap completes only when the
  // user is still on the empty state (no devices) AND the creation modal
  // isn't currently open. Task 40 dropped the localStorage gate — the
  // server-derived "no devices" check is now the only condition. The tour
  // closes itself via `onDone` when the user clicks through / skips.
  //
  // Auto-skips under automation (navigator.webdriver) so Playwright specs
  // for downstream surfaces aren't blocked by the overlay's pointer capture.
  useEffect(() => {
    if (bootstrapping || bootstrapError) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    if (unifiedOpen) return;
    const devicesCount = runtime?.devices?.length ?? 0;
    if (devicesCount > 0) return;
    if (hasRecentDeviceAttempt(runtimeInstallations)) return;
    // Task 43 — suppress the legacy 4-step WorkspaceTour while the
    // post-creation LaunchTour is pending/running. Both tours own the
    // overlay z-index and would otherwise stack. LaunchTour wins after
    // simple-mode creation; if the user never ran simple-mode (stage
    // stays `idle`) the legacy tour still opens. After LaunchTour
    // finishes (stage = `done`), we intentionally do NOT re-open the
    // legacy tour — the user has already seen the surfaces.
    if (launchTourStage !== 'idle') return;
    // Small debounce so the modal-close transition settles before the tour
    // overlay measures its anchor rects.
    const t = window.setTimeout(() => setTourOpen(true), 500);
    return () => window.clearTimeout(t);
  }, [bootstrapping, bootstrapError, unifiedOpen, runtime, runtimeInstallations, launchTourStage]);

  // Task 43 — flip launch-tour stage `pending` → `running` as soon as the
  // seed is in place. The setter is wired upstream when simple-mode
  // completes; we want a tiny debounce so the surface reload (tasks +
  // assets refresh after seed) has a chance to land before the tour
  // tries to measure its first anchor.
  useEffect(() => {
    if (launchTourStage !== 'pending') return;
    if (!launchTourSeed) return;
    const t = window.setTimeout(() => setLaunchTourStage('running'), 400);
    return () => window.clearTimeout(t);
  }, [launchTourStage, launchTourSeed]);

  // release201 v2.0.8 F-bug — persisted dismiss. localStorage key 按 workspace
  // 隔离 (一个用户切到另一个 workspace 仍会看到引导).
  const dismissOnboardingChecklist = useCallback(() => {
    setOnboardingDismissed(true);
    if (typeof window !== 'undefined' && workspace?.id) {
      try {
        window.localStorage.setItem(`prismer_onboarding_dismissed_${workspace.id}`, '1');
      } catch {
        /* localStorage full / disabled — session-scoped fallback is fine */
      }
    }
  }, [workspace?.id]);

  // release201 v2.0.8 F-bug — re-hydrate dismiss flag when workspace?.id
  // resolves. Reading localStorage in useState initializer doesn't work
  // because workspace is loaded async (bootstrap fetches default workspace
  // after first render). 当 workspace.id 切换时也重新读取 (按 workspace 隔离).
  useEffect(() => {
    if (!workspace?.id || typeof window === 'undefined') return;
    try {
      const persisted = window.localStorage.getItem(`prismer_onboarding_dismissed_${workspace.id}`);
      setOnboardingDismissed(persisted === '1');
    } catch {
      /* localStorage disabled — fall back to in-memory session flag */
    }
  }, [workspace?.id]);

  // Show floating onboarding checklist when:
  //   - tour has been completed/skipped (tour overlay would conflict)
  //   - user hasn't dismissed (persisted per-workspace via localStorage)
  //   - at least one of the 4 setup steps is incomplete
  //   - workspace has 0 online devices (user 原话："device 为 0 的情况下"
  //     才显示, 而不是 "用户从没尝试过 device 创建"). 一旦至少一台
  //     device 真正在线就隐藏; 这样既覆盖 device=0 显示, 又避免 device
  //     已就绪但用户没打开过引导的场景重复打扰.
  //   - we're not running under Playwright/automation (the card's "Create
  //     agent / Open session / Dispatch task / Add asset" buttons confuse
  //     accessible-name selectors in downstream specs)
  const allSetupDone = agents.length > 0 && conversations.length > 0 && tasks.length > 0 && assets.length > 0;
  const hasOnlineDevice = (runtime?.devices?.length ?? 0) > 0;
  const isAutomation = typeof navigator !== 'undefined' && navigator.webdriver;
  // Suppress the floating checklist whenever the unified creation modal is
  // open — Task 41 auto-opens that modal for fresh users, and a competing
  // bottom-right card would clash with the centered modal.
  const showOnboardingChecklist =
    !bootstrapping &&
    !bootstrapError &&
    !tourOpen &&
    !onboardingDismissed &&
    !allSetupDone &&
    !hasOnlineDevice &&
    !isAutomation &&
    !unifiedOpen;

  // release201/30 Phase 2 — inline upload progress shape. Bottom-right
  // overlay removed; payload is forwarded down through ChatsSurface →
  // ImChannel and rendered next to the composer file tray. Failure path
  // still flows through the existing toast queue (see `addToast(... error)`
  // in `runAssetUploadsCore`), so this surface is success-path only.
  const composerUploadProgressView = useMemo(() => {
    if (!uploadProgress) return null;
    return {
      filename: uploadProgress.filename,
      percent:
        typeof uploadProgress.progress.percent === 'number' && Number.isFinite(uploadProgress.progress.percent)
          ? Math.min(100, Math.max(0, uploadProgress.progress.percent))
          : null,
      phaseLabel: uploadPhaseLabel(uploadProgress.progress.phase),
      multiLabel:
        uploadProgress.totalFiles > 1 ? `${uploadProgress.fileIndex}/${uploadProgress.totalFiles}` : null,
    };
  }, [uploadProgress]);

  const renderChatsSurface = (showMobileBack = false) => (
    <ChatsSurface
      isDark={isDark}
      conversations={conversations}
      selectedConversation={selectedConversation}
      selectedConversationId={selectedConversationId}
      currentUserId={me?.id}
      workspaceId={workspace?.id}
      me={me}
      contacts={contacts}
      agents={agents}
      agentStatuses={agentStatuses}
      receivedRequests={receivedRequests}
      sentRequests={sentRequests}
      assets={assets}
      files={workspaceFiles}
      linkedTasks={linkedTasks}
      linkedAgents={linkedAgents}
      sessionAssets={sessionAssets}
      recentAssets={recentAssets}
      agentTypeByImUserId={agentTypeByImUserId}
      usernameByImUserId={usernameByImUserId}
      agentUsernames={agentUsernames}
      taskPhaseMap={phaseMap}
      dispatchInFlight={dispatchInFlight}
      refreshing={refreshing}
      showMobileBack={showMobileBack}
      prefillContactUserId={prefillContactUserId}
      headerActions={sessionSettingsMenuElement}
      notify={addToast}
      onSelectSession={onSelectSession}
      onNewSession={() => setNewChannelOpen(true)}
      onRefresh={onRefresh}
      onRenameSession={onRenameSession}
      onArchiveSession={onArchiveSession}
      onDeleteSession={onDeleteSession}
      onTogglePinSession={(session, pinned) => void togglePinSession(session.id, pinned)}
      onToggleMuteSession={(session, muted) => void toggleMuteSession(session.id, muted)}
      onUploadAsset={onUploadAsset}
      onComposerUploadAsset={onComposerUploadAsset}
      onComposerPasteFiles={onComposerPasteFiles}
      onOpenAssets={() => {
        setActiveSurface('library');
        setMobileSurface('library');
      }}
      onOpenTask={onOpenTaskById}
      onTaskChanged={reloadTasks}
      onAddMember={() => setAddMemberOpen(true)}
      onOpenAsset={onOpenAssetInspector}
      onOpenAgent={onOpenAgentInspector}
      onStartContactChat={onStartContactChat}
      onRetryMessage={onRetryDeliveryMessage}
      onSaveMessageAsMemory={(payload) => void saveMessageAsMemory(payload)}
      onForwardMessage={(payload) => setForwardSource(payload)}
      onOpenProjectInsights={(projectId) => openInsightsSurface({ view: 'project', projectId })}
      uploadProgress={composerUploadProgressView}
    />
  );

  // Asset preview panel (desktop). Rendered by SurfaceWithPreviewDock either
  // docked beside the surface (split) or overlaid full screen — the panel
  // switches its own root via the `layout` prop. The maximize/restore toggle
  // is only offered when the content area is wide enough to split.
  const assetPreviewPanel =
    inspector?.kind === 'asset' ? (
      <WorkspaceInspectorDialog
        open
        isDark={isDark}
        workspaceName={workspace?.name ?? 'Personal Workspace'}
        inspector={inspector}
        agents={agents}
        agentStatuses={agentStatuses}
        profiles={profiles}
        runtime={runtime}
        assets={assets}
        files={workspaceFiles}
        layout={previewLayout}
        onToggleLayout={
          previewContainerWide
            ? () =>
                setPreviewMaximized((value) => {
                  const next = !value;
                  // Entering full screen pins the overlay to the surface it's
                  // currently over so navigating away (not maximizing) closes it.
                  if (next) previewSurfaceRef.current = activeSurface;
                  return next;
                })
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
        onSelectAgent={(agentId) => setInspector({ kind: 'agent', agentId })}
        onOpenMemoryPage={(path) => {
          setMemoryJumpPath(path);
          setActiveSurface('library');
          setMobileSurface('library');
        }}
        notify={addToast}
      />
    ) : null;

  // ─── Render ─────────────────────────────────────────────────────────────
  if (isAuthLoading || (!isAuthenticated && !bootstrapError)) {
    return (
      <div className="flex h-[calc(100vh-72px)] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  return (
    <div
      className={`flex h-[calc(100vh-88px)] min-h-0 flex-col overflow-hidden ${
        isDark
          ? 'bg-zinc-950 text-zinc-200'
          : 'bg-[linear-gradient(180deg,#fbfbff_0%,#f7f8fc_48%,#fbfbff_100%)] text-zinc-900'
      }`}
    >
      <TopBar
        isDark={isDark}
        workspace={workspace}
        streamState={streamState}
        runtime={runtime}
        onRefresh={onRefresh}
        refreshing={refreshing}
        projectSwitcher={
          // release201 S12 — ProjectSwitcher lives in the workspace-level top
          // bar (was previously in left-rail). Switching project pivots the
          // active filter, which every project-scoped surface (chats / tasks
          // / library / insights) consumes via `activeProjectFilter`.
          <ProjectSwitcher
            isDark={isDark}
            workspaceId={workspaceId}
            projects={projectsList}
            loading={projectsLoading}
            activeFilter={activeProjectFilter}
            onChange={setActiveProjectFilter}
            onReload={reloadProjects}
            notify={(msg, opts) =>
              addToast(msg, opts?.kind === 'error' ? 'error' : opts?.kind === 'success' ? 'success' : 'info')
            }
            onOpenOverview={(id) => setProjectOverviewId(id)}
            showArchived={showArchivedProjects}
            onToggleShowArchived={setShowArchivedProjects}
            archivedProjects={archivedProjects}
            archivedLoading={archivedProjectsLoading}
          />
        }
      />

      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={onAssetFileSelected} />
      {/* release201/30 Phase 2 — the bottom-right AssetUploadProgressOverlay
          was retired in favour of an inline composer row. Failure path
          still toasts via addToast(..., 'error'). */}

      {isMobileViewport ? (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden pb-14">
          {bootstrapping ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className={`w-6 h-6 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
            </div>
          ) : bootstrapError ? (
            <div className="flex-1 flex items-center justify-center px-6">
              <div
                className={`max-w-md text-center text-sm rounded-xl border px-6 py-5 ${
                  isDark ? 'border-red-500/20 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'
                }`}
              >
                <p className="font-medium">Couldn’t load your workspace.</p>
                <p className="mt-1 text-xs opacity-80">{bootstrapError}</p>
              </div>
            </div>
          ) : !workspace ? (
            <div className="flex-1 flex items-center justify-center px-6">
              <div
                className={`max-w-md text-center text-sm rounded-xl border px-6 py-5 ${
                  isDark ? 'border-white/5 bg-zinc-900 text-zinc-400' : 'border-zinc-200 bg-white text-zinc-600'
                }`}
              >
                <p className="font-medium">No workspace yet.</p>
                <p className="mt-1 text-xs">Create your first agent — your workspace will be set up automatically.</p>
              </div>
            </div>
          ) : mobileSurface === 'chats' ? (
            renderChatsSurface(true)
          ) : mobileSurface === 'insights' ? (
            // release201 S12 + S32 (12 §11 Phase 4) — Insights surface in
            // mobile shell. Single column, sparkline replaces timeseries,
            // tables hidden (use desktop).
            <InsightsSurface
              isDark={isDark}
              workspaceId={workspaceId}
              view={insightsView}
              range={insightsRange}
              projectId={insightsProjectId}
              agentId={insightsAgentId}
              refreshNonce={insightsRefreshNonce}
              customRange={insightsCustomRange}
              lastUpdated={insightsLastUpdated}
              onChangeView={(v) => {
                setInsightsView(v);
                syncInsightsUrl({ view: v });
              }}
              onChangeRange={(r) => {
                setInsightsRange(r);
                setInsightsCustomRange(null);
                syncInsightsUrl({ range: r, customRange: null });
              }}
              onChangeCustomRange={(cr) => {
                setInsightsCustomRange(cr);
                syncInsightsUrl({ customRange: cr });
              }}
              onChangeProject={(projectId) => {
                setInsightsProjectId(projectId);
                syncInsightsUrl({ projectId });
              }}
              onChangeAgent={(agentId) => {
                setInsightsAgentId(agentId);
                syncInsightsUrl({ agentId });
              }}
              onRefresh={() => setInsightsRefreshNonce((n) => n + 1)}
              mobile
            />
          ) : mobileSurface === 'tasks' ? (
            <TaskBoard
              isDark={isDark}
              tasks={tasks}
              loading={tasksLoading}
              error={taskError}
              agents={agents}
              agentStatuses={agentStatuses}
              assets={assets}
              onTaskChanged={reloadTasks}
              notify={addToast}
              onNewTask={onOpenNewTask}
              onOpenTask={(task) => void openTaskById(task.id)}
              onUploadTaskAttachment={onUploadTaskAttachment}
              onOpenAsset={onOpenAssetInspector}
              onOpenConversation={(conversationId) => {
                setSelectedConversationId(conversationId);
                setActiveSurface('chats');
                setMobileSurface('chats');
              }}
            />
          ) : mobileSurface === 'library' ? (
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <LibrarySurface
                isDark={isDark}
                workspaceId={workspaceId}
                assets={assets}
                files={workspaceFiles}
                onUploadAsset={onUploadAsset}
                onUploadFiles={(files) => uploadAssetFiles(files)}
                onOpenInspector={openInspector}
                initialFolder={libraryInitialFolder}
                onAssetsChanged={async () => {
                  if (workspaceId) await reloadAssets(workspaceId);
                }}
                notify={addToast}
                memoryJumpPath={memoryJumpPath}
                onMemoryJumpHandled={() => setMemoryJumpPath(null)}
                onMemoryJumpRequest={(path) => setMemoryJumpPath(path)}
                myImUserId={me?.id ?? null}
                isOwnerHuman={me?.id != null && workspace?.ownerImUserId === me.id}
                activeTaskId={selectedTaskId}
                pendingProposalCount={pendingProposalCount}
                onOpenProposalReview={() => setProposalReviewOpen(true)}
              />
              {inspector?.kind === 'asset' ? (
                <WorkspaceInspectorDialog
                  open
                  isDark={isDark}
                  workspaceName={workspace?.name ?? 'Personal Workspace'}
                  inspector={inspector}
                  agents={agents}
                  agentStatuses={agentStatuses}
                  profiles={profiles}
                  runtime={runtime}
                  assets={assets}
                  files={workspaceFiles}
                  onOpenChange={(open) => {
                    if (!open) closeInspector();
                  }}
                  onSelectAgent={(agentId) => setInspector({ kind: 'agent', agentId })}
                  onOpenMemoryPage={(path) => {
                    setMemoryJumpPath(path);
                    setActiveSurface('library');
                    setMobileSurface('library');
                  }}
                  notify={addToast}
                />
              ) : null}
            </div>
          ) : (
            <div
              data-testid="mobile-runtime-surface"
              className={`flex-1 overflow-y-auto ${isDark ? 'bg-zinc-950/30' : 'bg-zinc-50/60'}`}
            >
              <RuntimeManager
                isDark={isDark}
                runtime={runtime}
                installations={runtimeInstallations}
                agents={agents}
                agentStatuses={agentStatuses}
                onOpenInspector={openInspector}
                onCreateRuntime={onCreateRuntime}
                onOpenCreation={() => setUnifiedOpen(true)}
                onRuntimeChanged={async () => {
                  if (!workspaceId) return;
                  await Promise.all([
                    reloadAgents(),
                    reloadProfiles(workspaceId),
                    reloadRuntimeInstallations(workspaceId),
                    reloadRuntime(workspaceId),
                  ]);
                }}
                notify={addToast}
              />
            </div>
          )}
        </div>
      ) : null}

      <motion.div
        layout
        transition={springHeavy}
        className={`flex min-h-0 flex-1 gap-2 p-2 pt-3 ${isMobileViewport ? 'hidden' : ''}`}
      >
        <LeftRail
          isDark={isDark}
          collapsed={leftRailCollapsed}
          onCollapsedChange={setLeftRailCollapsed}
          sessions={conversations}
          tasksCount={taskStats.total}
          inProgressCount={taskStats.inProgress}
          doneCount={taskStats.done}
          contacts={contacts}
          pendingContactRequests={receivedRequests.length}
          pendingMemoryProposals={pendingProposalCount}
          contestedBindingCount={contestedBindingCount}
          assets={assets}
          agents={agents}
          runtime={runtime}
          activeSurface={activeSurface}
          onSelectSurface={setActiveSurface}
          onOpenCreation={() => setUnifiedOpen(true)}
        />

        <SurfaceWithPreviewDock
          layout={previewLayout}
          preview={assetPreviewPanel}
          onMeasureWide={onMeasurePreviewWide}
        >
        {bootstrapping && !workspace ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className={`w-6 h-6 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
          </div>
        ) : bootstrapError ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <div
              className={`max-w-md text-center text-sm rounded-xl border px-6 py-5 ${
                isDark ? 'border-red-500/20 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'
              }`}
            >
              <p className="font-medium">Couldn’t load your workspace.</p>
              <p className="mt-1 text-xs opacity-80">{bootstrapError}</p>
            </div>
          </div>
        ) : !workspace ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <div
              className={`max-w-md text-center text-sm rounded-xl border px-6 py-5 ${
                isDark ? 'border-white/5 bg-zinc-900 text-zinc-400' : 'border-zinc-200 bg-white text-zinc-600'
              }`}
            >
              <p className="font-medium">No workspace yet.</p>
              <p className="mt-1 text-xs">
                Create your first agent — your Personal Workspace will be set up automatically and appear here.
              </p>
            </div>
          </div>
        ) : activeSurface === 'chats' ? (
          renderChatsSurface(false)
        ) : (
          <motion.main
            layout
            transition={springHeavy}
            className={`relative min-w-0 flex flex-1 flex-col overflow-hidden border ${
              isDark
                ? 'border-white/[0.06] bg-zinc-950/30 shadow-[0_22px_70px_-52px_rgba(139,92,246,0.9)]'
                : 'border-zinc-200/80 bg-white/78 shadow-[0_22px_70px_-54px_rgba(76,29,149,0.35)]'
            } rounded-2xl`}
          >
            {activeSurface === 'insights' ? (
              // release201 S12 — Insights is a peer surface (no longer at
              // /workspace/insights). URL params under ?surface=insights&… are
              // managed by `syncInsightsUrl` so deep links + refresh work.
              <InsightsSurface
                isDark={isDark}
                workspaceId={workspaceId}
                view={insightsView}
                range={insightsRange}
                projectId={insightsProjectId}
                agentId={insightsAgentId}
                refreshNonce={insightsRefreshNonce}
                customRange={insightsCustomRange}
                lastUpdated={insightsLastUpdated}
                onChangeView={(v) => {
                  setInsightsView(v);
                  syncInsightsUrl({ view: v });
                }}
                onChangeRange={(r) => {
                  setInsightsRange(r);
                  setInsightsCustomRange(null);
                  syncInsightsUrl({ range: r, customRange: null });
                }}
                onChangeCustomRange={(cr) => {
                  setInsightsCustomRange(cr);
                  syncInsightsUrl({ customRange: cr });
                }}
                onChangeProject={(projectId) => {
                  setInsightsProjectId(projectId);
                  syncInsightsUrl({ projectId });
                }}
                onChangeAgent={(agentId) => {
                  setInsightsAgentId(agentId);
                  syncInsightsUrl({ agentId });
                }}
                onRefresh={() => setInsightsRefreshNonce((n) => n + 1)}
              />
            ) : activeSurface === 'tasks' ? (
              <TaskBoard
                isDark={isDark}
                tasks={tasks}
                loading={tasksLoading}
                error={taskError}
                agents={agents}
                agentStatuses={agentStatuses}
                assets={assets}
                onTaskChanged={reloadTasks}
                notify={addToast}
                onNewTask={onOpenNewTask}
                onOpenTask={(task) => void openTaskById(task.id)}
                onUploadTaskAttachment={onUploadTaskAttachment}
                onOpenAsset={onOpenAssetInspector}
                onOpenConversation={(conversationId) => {
                  setSelectedConversationId(conversationId);
                  setActiveSurface('chats');
                }}
              />
            ) : activeSurface === 'library' ? (
              <LibrarySurface
                isDark={isDark}
                workspaceId={workspaceId}
                assets={assets}
                files={workspaceFiles}
                onUploadAsset={onUploadAsset}
                onUploadFiles={(files) => uploadAssetFiles(files)}
                onOpenInspector={openInspector}
                initialFolder={libraryInitialFolder}
                onAssetsChanged={async () => {
                  if (workspaceId) await reloadAssets(workspaceId);
                }}
                notify={addToast}
                memoryJumpPath={memoryJumpPath}
                onMemoryJumpHandled={() => setMemoryJumpPath(null)}
                onMemoryJumpRequest={(path) => setMemoryJumpPath(path)}
                myImUserId={me?.id ?? null}
                isOwnerHuman={me?.id != null && workspace?.ownerImUserId === me.id}
                activeTaskId={selectedTaskId}
                pendingProposalCount={pendingProposalCount}
                onOpenProposalReview={() => setProposalReviewOpen(true)}
              />
            ) : (
              <RuntimeManager
                isDark={isDark}
                runtime={runtime}
                installations={runtimeInstallations}
                agents={agents}
                agentStatuses={agentStatuses}
                onOpenInspector={openInspector}
                onCreateRuntime={onCreateRuntime}
                onOpenCreation={() => setUnifiedOpen(true)}
                onRuntimeChanged={async () => {
                  if (!workspaceId) return;
                  await Promise.all([
                    reloadAgents(),
                    reloadProfiles(workspaceId),
                    reloadRuntimeInstallations(workspaceId),
                    reloadRuntime(workspaceId),
                  ]);
                }}
                notify={addToast}
              />
            )}

            <TaskDetailDrawer
              isDark={isDark}
              task={selectedTask}
              agents={agents}
              agentStatuses={agentStatuses}
              assets={assets}
              currentUserId={me?.id ?? null}
              onClose={() => {
                setSelectedTaskId(null);
                setSelectedTaskFallback(null);
              }}
              onChanged={async () => {
                // Off-board tasks aren't in `tasks` — refresh the cached
                // fallback copy too so the drawer header reflects the
                // post-mutation state immediately.
                if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
                  taskFetchCacheRef.current.delete(selectedTaskId);
                }
                await reloadTasks();
              }}
              onOpenTask={openTaskById}
              onOpenAsset={onOpenAssetInspector}
              onOpenChat={onOpenChatFromTask}
              onOpenLibrary={(folderPath) => {
                setLibraryInitialFolder(folderPath);
                setActiveSurface('library');
                setSelectedTaskId(null);
                setSelectedTaskFallback(null);
              }}
              notify={addToast}
            />
            {/* Asset preview moved up to SurfaceWithPreviewDock so it can dock
                beside the surface (split) instead of always overlaying it. */}
          </motion.main>
        )}
        </SurfaceWithPreviewDock>
      </motion.div>

      {/* release201/09 Phase 4 — Project overview drawer. Rendered at the
          workspace root so the drawer overlays surface content uniformly
          whether the user came from ProjectSwitcher (active project),
          dropdown chevron (any project), or the archived list. */}
      <ProjectOverviewDrawer
        isDark={isDark}
        isOpen={projectOverviewId !== null}
        workspaceId={workspaceId}
        project={
          projectsList.find((p) => p.id === projectOverviewId) ??
          archivedProjects.find((p) => p.id === projectOverviewId) ??
          null
        }
        canManage={
          // workspace owner is always allowed; non-owner managers fall under
          // the project's effective role check on the server side. The UI
          // here optimistically gates affordances on workspace ownership
          // (matches §5.2 short-circuit). Server still authoritative.
          !!workspace && !!me && workspace.ownerImUserId === me.id
        }
        onClose={() => setProjectOverviewId(null)}
        onMutated={() => {
          reloadProjects();
          void reloadTasks();
        }}
        onOpenTask={(taskId) => {
          setProjectOverviewId(null);
          setActiveSurface('tasks');
          void openTaskById(taskId);
        }}
        onOpenDashboard={(projectId) => {
          // release201 S12 — Insights is an in-shell surface. Close the
          // drawer, flip to the insights surface scoped to this project,
          // and let `syncInsightsUrl` push `?surface=insights&view=project&projectId=…`.
          setProjectOverviewId(null);
          openInsightsSurface({ view: 'project', projectId });
        }}
        notify={(msg, opts) =>
          addToast(msg, opts?.kind === 'error' ? 'error' : opts?.kind === 'success' ? 'success' : 'info')
        }
      />

      <LibrarySearchModal
        isDark={isDark}
        workspaceId={workspaceId}
        assets={assets}
        onOpenInspector={(next) => {
          // Asset overlay is only rendered inside the library surface (mobile
          // gates by `mobileSurface === 'library'`; desktop's auto-close
          // effect requires `activeSurface === 'library'`). Search can fire
          // from any surface, so align both surface states first.
          openInspector(next);
        }}
        onOpenMemoryPage={(path) => {
          setMemoryJumpPath(path);
          setActiveSurface('library');
          setMobileSurface('library');
        }}
      />

      <LibraryProposalReviewModal
        open={proposalReviewOpen}
        workspaceId={workspaceId}
        isDark={isDark}
        onClose={() => setProposalReviewOpen(false)}
        onChanged={() => setProposalRefreshTick((tick) => tick + 1)}
        notify={addToast}
      />

      <MessageForwardDialog
        open={forwardSource !== null}
        isDark={isDark}
        source={forwardSource}
        conversations={conversations}
        onClose={() => setForwardSource(null)}
        notify={addToast}
      />

      <WorkspaceInspectorDialog
        open={!!inspector && inspector.kind !== 'asset'}
        isDark={isDark}
        onOpenMemoryPage={(path) => {
          setMemoryJumpPath(path);
          setActiveSurface('library');
          setMobileSurface('library');
        }}
        workspaceName={workspace?.name ?? 'Personal Workspace'}
        inspector={inspector?.kind === 'asset' ? null : inspector}
        agents={agents}
        agentStatuses={agentStatuses}
        profiles={profiles}
        runtime={runtime}
        assets={assets}
        files={workspaceFiles}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
        onSelectAgent={(agentId) => setInspector({ kind: 'agent', agentId })}
        onChanged={async () => {
          if (!workspaceId) return;
          await Promise.all([
            reloadAgents(),
            reloadProfiles(workspaceId),
            reloadRuntime(workspaceId),
            reloadRuntimeInstallations(workspaceId),
          ]);
        }}
        notify={addToast}
      />

      {/* Mutation modals — kept at root so they overlay the grid layout. */}
      {workspace ? (
        <>
          <NewChannelDialog
            open={newChannelOpen}
            onOpenChange={setNewChannelOpen}
            workspaceId={workspace.id}
            agents={agents}
            contacts={contacts}
            onCreated={onChannelCreated}
            isDark={isDark}
            notify={addToast}
          />
          <NewTaskDialog
            open={newTaskOpen}
            onOpenChange={setNewTaskOpen}
            workspaceId={workspace.id}
            agents={agents}
            profiles={profiles}
            // Wave-8 W1 / L3: thread the workspace asset list through so
            // the description editor's `#filename` picker can build
            // `assetRefs[]` at submit time.
            workspaceAssets={assets}
            defaultAssigneeId={defaultTaskAssigneeId}
            conversationId={selectedConversation?.id}
            initialColumn={newTaskInitialColumn}
            // release201/09 §8.6 — pre-seed project picker from the global
            // ProjectSwitcher selection so new tasks default to the
            // currently-viewed project. Sentinels ('all' / '__unscoped')
            // fall back to "None (workspace level)" inside the dialog.
            projects={projectsList}
            defaultProjectId={activeProjectFilter}
            onCreated={onTaskCreated}
            isDark={isDark}
            notify={addToast}
          />
          {/*
            §30 B3.7 — unified creation modal. Single entry point fed by
            the TopBar `+` button and left-rail "+" shortcuts. The
            existing per-dialog modals above are retained for now but
            have no UI triggers (dead UX). Full cleanup of those dialog
            files is deferred to a follow-up task.

            B3.4 (P0-2): onCreated demuxes the six UnifiedCreationEvent
            kinds to the existing per-flow reloaders (onAgentCreated /
            onChannelCreated / onTaskCreated / reloadRuntimeInstallations).
            See `onUnifiedCreated` above for the simple-team navigate path.
          */}
          <UnifiedCreationModal
            open={unifiedOpen}
            onOpenChange={setUnifiedOpen}
            isDark={isDark}
            workspaceId={workspace.id}
            // 1:1 invariant — when the workspace already owns an org name,
            // surface it as a locked badge in the creation flow's Step 1
            // instead of prompting the user to retype. `metadata.organizationName`
            // is the canonical source (written after first Simple-mode pass);
            // fall back to `workspace.name` when metadata is missing AND the
            // workspace name isn't the bare "Personal Workspace" default.
            existingOrganizationName={(() => {
              const fromMeta =
                typeof workspace.metadata?.organizationName === 'string'
                  ? workspace.metadata.organizationName.trim()
                  : '';
              if (fromMeta) return fromMeta;
              const name = (workspace.name ?? '').trim();
              if (!name || name === 'Personal Workspace' || name === 'Personal') return null;
              return name;
            })()}
            agents={agents}
            profiles={profiles}
            initialMode={unifiedInitialMode}
            onCreated={onUnifiedCreated}
            // release201 v2.0.8 F-bug — project 抽象引导. activeProjectFilter
            // 来自 useProjects() (ProjectSwitcher 共享 state); 当 filter 是
            // sentinel ('all' / '__unscoped') 时, modal 内部把它当作 unscoped
            // 处理. activeProjectName 用 projectsList 查表得到, 找不到时传 null
            // 让 modal fallback 到 "..."占位符.
            activeProjectId={activeProjectFilter ?? null}
            activeProjectName={
              activeProjectFilter ? (projectsList.find((p) => p.id === activeProjectFilter)?.name ?? null) : null
            }
            // 2026-05-29 — wire the inline project picker so users can switch
            // scope mid-flow without leaving the modal (release201/20 Gap B).
            // The inline create form lives inside the modal, so we forward
            // the useProjects() reload trigger so the new row shows up in
            // the picker immediately after create succeeds.
            projects={projectsList.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name }))}
            onActiveProjectIdChange={(id) => setActiveProjectFilter(id ?? 'all')}
            onReloadProjects={reloadProjects}
            onCreateProject={() => {
              // 复用 WorkspaceOnboarding 已有的 ProjectSwitcher trigger 逻辑:
              // 打开 ProjectSwitcher 下拉 → 点击 "New project". 用户在
              // ProjectSwitcher 里建好后会自动切换 active filter, 再次打开
              // unified modal 时即可看到 project 上下文.
              if (typeof document === 'undefined') return;
              const trigger = document.querySelector<HTMLButtonElement>('[data-testid="project-switcher-trigger"]');
              trigger?.click();
              window.setTimeout(() => {
                document.querySelector<HTMLButtonElement>('[data-testid="project-switcher-new"]')?.click();
              }, 50);
            }}
          />
          {/* Wave-8 W4: settings menu dialogs (controlled by ⋮ menu in ImChannel header) */}
          {selectedConversation && selectedConversation.type !== 'direct' && selectedConversationAccess.canAddMember ? (
            <AddMemberDialog
              open={addMemberOpen}
              onOpenChange={setAddMemberOpen}
              groupId={selectedConversation.id}
              existingMemberIds={(selectedConversation.participants ?? []).map((p) => p.userId)}
              onAdded={() => {
                if (workspaceId) void reloadConversations(workspaceId);
              }}
              isDark={isDark}
              notify={addToast}
            />
          ) : null}
          {selectedConversation && selectedConversationAccess.canRename ? (
            <RenameSessionDialog
              open={renameOpen}
              onOpenChange={setRenameOpen}
              conversationId={selectedConversation.id}
              currentTitle={selectedConversation.displayTitle || selectedConversation.title || ''}
              onRenamed={() => {
                if (workspaceId) void reloadConversations(workspaceId);
              }}
              isDark={isDark}
              notify={addToast}
            />
          ) : null}
        </>
      ) : null}
      {/* Wave-8 W4: mobile bottom-nav. Only renders at md: breakpoint and below.
          Routes between Chats / Tasks / Assets / Devices surfaces. */}
      {isMobileViewport ? (
        <MobileNav
          isDark={isDark}
          active={mobileSurface}
          onSelect={(surface) => {
            // release201 S12 — Insights is now an in-shell surface (no
            // separate route), so the MobileNav `onSelect` path covers all
            // five tiles uniformly. Keep desktop activeSurface in sync so
            // the same surface is active across viewport changes.
            setMobileSurface(surface);
            setActiveSurface(surface);
          }}
        />
      ) : null}

      {/* First-visit tour overlay — anchored to topbar elements via data-tour-anchor */}
      <WorkspaceTour open={tourOpen} isDark={isDark} onDone={() => setTourOpen(false)} />

      {/* Task 43 — post-creation Launch Tour. Fires when simple-mode finishes
          and the seed lands. Walks tasks → library → contacts → runtime →
          chat, then flips stage to `done` so the legacy WorkspaceTour above
          stays suppressed (its useEffect short-circuits on stage !== 'idle'). */}
      <LaunchTour
        open={launchTourStage === 'running'}
        seed={launchTourSeed}
        isDark={isDark}
        onSetSurface={(surface) => {
          setActiveSurface(surface);
          if (isMobileViewport) setMobileSurface(surface);
        }}
        onSelectConversation={(id) => {
          setSelectedConversationId(id);
          setActiveSurface('chats');
          if (isMobileViewport) setMobileSurface('chats');
        }}
        onDone={() => setLaunchTourStage('done')}
      />

      {/* Persistent onboarding checklist — floating bottom-right card.
          Only shown when tour is closed AND not all 4 setup steps are done
          AND user hasn't dismissed. Disappears naturally when allSetupDone. */}
      {showOnboardingChecklist ? (
        <div className="fixed bottom-4 right-4 z-40 hidden sm:block w-80 max-w-[calc(100vw-2rem)]">
          <div
            className={`relative rounded-2xl border shadow-2xl overflow-hidden ${
              isDark ? 'border-white/[0.08] bg-zinc-950/95 backdrop-blur' : 'border-zinc-200 bg-white/95 backdrop-blur'
            }`}
          >
            <button
              type="button"
              onClick={dismissOnboardingChecklist}
              aria-label="Dismiss checklist"
              className={`absolute right-2 top-2 z-10 p-1.5 rounded-lg transition-colors ${
                isDark ? 'hover:bg-zinc-800 text-zinc-500' : 'hover:bg-zinc-100 text-zinc-400'
              }`}
            >
              <span className="text-base leading-none">×</span>
            </button>
            <WorkspaceOnboarding
              isDark={isDark}
              agentsCount={agents.length}
              projectsCount={projectsList.length}
              channelsCount={conversations.length}
              tasksCount={taskStats.total}
              devicesCount={runtime?.devices?.length ?? 0}
              onSetupTeam={() => {
                setUnifiedInitialMode('simple');
                setUnifiedOpen(true);
              }}
              onNewAgent={() => {
                // §30 B3.7 — single creation entry = unified flow. Onboarding's
                // "create agent" step opens Pro mode (agent/executor tiles) instead
                // of the retired NewAgentDialog.
                setUnifiedInitialMode('pro');
                setUnifiedOpen(true);
              }}
              onCreateProject={() => {
                // release201/20 Gap B — onboarding 6-step flow.
                // ProjectSwitcher owns the create-project UI; we drive it via
                // its stable testids: open dropdown → click "New project".
                if (typeof document === 'undefined') return;
                const trigger = document.querySelector<HTMLButtonElement>('[data-testid="project-switcher-trigger"]');
                trigger?.click();
                window.setTimeout(() => {
                  document.querySelector<HTMLButtonElement>('[data-testid="project-switcher-new"]')?.click();
                }, 50);
              }}
              onPairDevice={() => {
                setUnifiedInitialMode('simple');
                setUnifiedOpen(true);
              }}
              onNewChannel={() => setNewChannelOpen(true)}
              onNewTask={() => onOpenNewTask()}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// release201/30 Phase 2 — `AssetUploadProgressOverlay` removed in favour
// of the inline composer-area progress row in ImChannel (see
// ComposerUploadProgressRow). The pure helper `uploadPhaseLabel` is
// retained because page.tsx still maps the underlying phase enum into
// the inline view's `phaseLabel`.

function uploadPhaseLabel(phase: AssetUploadProgress['phase']): string {
  switch (phase) {
    case 'hashing':
      return 'Hashing';
    case 'requesting-upload':
      return 'Preparing upload';
    case 'uploading':
      return 'Uploading';
    case 'completing':
      return 'Finalizing';
    case 'fallback':
      return 'Uploading through server';
    case 'done':
      return 'Uploaded';
  }
}

// `formatUploadBytes` was the byte-count formatter for the deleted
// AssetUploadProgressOverlay. The inline composer row doesn't surface a
// bytes counter (the percent label + filename are enough at composer
// scale), so the helper is removed alongside its only caller.

