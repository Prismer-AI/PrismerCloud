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
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { getWorkspaceToken, imFetch } from './lib/im-api';
import { useTaskStream } from './lib/use-task-stream';
import { springHeavy } from './lib/design';
import { TopBar } from './components/top-bar';
import { LeftRail } from './components/left-rail';
import { ImChannel } from './components/im-channel';
import { TaskBoard } from './components/task-board';
import { TaskDetailDrawer } from './components/task-detail-drawer';
import { WorkspaceTour, hasSeenWorkspaceTour } from './components/workspace-tour';
import { WorkspaceOnboarding } from './components/workspace-onboarding';
import { LibrarySurface } from './components/library-surface';
import { LibrarySearchModal } from './components/library-search-modal';
import { SaveAsMemoryModal, type SaveAsMemorySource } from './components/save-as-memory-modal';
import { LibraryProposalReviewModal } from './components/library-proposal-review-modal';
import { listProposals } from './lib/memory-api';
import { RuntimeManager } from './components/runtime-manager';
import { ContactsPanel } from './components/contacts-panel';
import { NewAgentDialog } from './components/new-agent-dialog';
import { NewChannelDialog } from './components/new-channel-dialog';
import { NewTaskDialog } from './components/new-task-dialog';
import { UnifiedCreationModal, type UnifiedCreationEvent } from './components/unified-creation';
import dynamic from 'next/dynamic';
import type { WorkspaceInspector } from './components/workspace-inspector-dialog';
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
import { MobileSessionsList } from './components/mobile-sessions-list';
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
  // Workspace tour: shown to first-time users after bootstrap. localStorage
  // flag (in workspace-tour.tsx) prevents replay on subsequent visits.
  const [tourOpen, setTourOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return Boolean(localStorage.getItem('prismer.onboardingChecklistDismissed.v1'));
    } catch {
      return false;
    }
  });
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadTarget, setUploadTarget] = useState<{
    conversationId?: string | null;
    sourceTaskId?: string | null;
  } | null>(null);

  // Modal open state.
  const [newAgentOpen, setNewAgentOpen] = useState(false);
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
  void setUnifiedInitialMode;
  const [newTaskInitialColumn, setNewTaskInitialColumn] = useState<KanbanColumnKey | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Fallback for tasks that aren't on the board (agent_run subtasks live under
  // the parent work_item — the kanban filters them out, but a click on
  // "Open card" in chat or on a breadcrumb chip still has to find them).
  const [selectedTaskFallback, setSelectedTaskFallback] = useState<TaskDTO | null>(null);
  const taskFetchCacheRef = useRef<Map<string, { task: TaskDTO; ts: number }>>(new Map());
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);
  const [imCollapsed, setImCollapsed] = useState(false);
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
  // Wave-8 W4: which mobile surface is active (independent of desktop
  // `activeSurface` because mobile has a 'sessions' surface that desktop
  // doesn't — desktop combines sessions + main pane in the same flex row).
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('sessions');
  // Resizable session panel: width persisted in localStorage so the operator's
  // chat/board ratio survives reload. Keep the session pane bounded so the
  // kanban remains the dominant work surface at the default desktop ratio.
  const IM_WIDTH_MIN = 340;
  const IM_WIDTH_MAX = 520;
  const IM_WIDTH_DEFAULT = 400;
  const [imWidth, setImWidth] = useState<number>(IM_WIDTH_DEFAULT);
  const [imDragging, setImDragging] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem('workspace:im:width');
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= IM_WIDTH_MIN && parsed <= IM_WIDTH_MAX) {
      setImWidth(parsed);
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('workspace:im:width', String(imWidth));
  }, [imWidth]);
  const startImResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = imWidth;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setImDragging(true);
      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.min(IM_WIDTH_MAX, Math.max(IM_WIDTH_MIN, startWidth + delta));
        setImWidth(next);
      };
      const onUp = (ev: PointerEvent) => {
        if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        setImDragging(false);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    },
    [imWidth],
  );
  const [inspector, setInspector] = useState<WorkspaceInspector | null>(null);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>('tasks');
  // Asset inspector overlays motion.main with `absolute inset-0 z-40`, so on
  // desktop it sits on top of whatever surface is active. When the user
  // navigates to a non-library surface (left rail, mobile nav, task drawer's
  // "Open in Library" + back, etc.), close the overlay so it doesn't trap
  // them on top of the wrong surface.
  useEffect(() => {
    if (inspector?.kind === 'asset' && activeSurface !== 'library') {
      setInspector(null);
    }
  }, [activeSurface, inspector]);
  const [prefillContactUserId, setPrefillContactUserId] = useState<string | null>(null);
  // Wave-9 Phase 3.3: when the task drawer's "Open in Library" lands,
  // we both flip activeSurface to 'library' AND pass this folder down to
  // the LibrarySurface so it pre-selects the per-task auto-folder. Reset
  // to undefined after consumed so subsequent library navigations don't
  // get stuck on the same filter.
  const [libraryInitialFolder, setLibraryInitialFolder] = useState<string | null | undefined>(undefined);
  // Memory Line B: ⌘K + Asset detail "View as Memory" routes through here.
  const [memoryJumpPath, setMemoryJumpPath] = useState<string | null>(null);
  const [saveAsMemorySource, setSaveAsMemorySource] = useState<SaveAsMemorySource | null>(null);
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
    setActiveSurface('contacts');
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
      `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(wsId)}`,
    );
    if (res.ok) setRuntimeInstallations(res.data ?? []);
  }, []);

  const reloadProfiles = useCallback(async (wsId: string) => {
    const res = await imFetch<AgentProfileDTO[]>(`/agent_profiles?workspaceId=${encodeURIComponent(wsId)}`);
    // 4xx is treated as "no profiles to show" rather than fatal — the
    // /agent_profiles endpoint requires agentId in many deployments.
    if (res.ok) setProfiles(res.data ?? []);
  }, []);

  const reloadConversations = useCallback(
    async (wsId: string) => {
      const res = await imFetch<ConversationDTO[]>(`/conversations?workspaceId=${encodeURIComponent(wsId)}`);
      if (res.ok) {
        setConversations(res.data ?? []);
      } else {
        addToast(`Workspace sessions: ${res.message}`, 'error');
      }
    },
    [addToast],
  );

  const reloadAssets = useCallback(async (wsId: string) => {
    const [assetsRes, filesRes] = await Promise.all([
      imFetch<AssetDTO[]>(`/assets?workspaceId=${encodeURIComponent(wsId)}&limit=100`),
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
        imFetch<ConversationDTO[]>(`/conversations?workspaceId=${encodeURIComponent(defaultWs.id)}`),
        loadOwnedAgents(),
      ]);
      if (cancelled) return;

      if (meRes.ok) setMe(meRes.data ?? null);
      setAgents(agentsRes);
      if (convRes.ok) {
        setConversations(convRes.data ?? []);
        const first = (convRes.data ?? [])[0];
        // Wave-8 W4: on mobile we want to land on the sessions LIST, not on
        // the channel itself — auto-selecting a session on mobile would skip
        // straight to the full-screen ImChannel and bypass MobileSessionsList.
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
          `/api/workspace/runtime-installations?workspaceId=${encodeURIComponent(defaultWs.id)}`,
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
      if (runtimeInstallationsRes.ok) setRuntimeInstallations(runtimeInstallationsRes.data ?? []);
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
    const res = await imFetch<TaskDTO[]>(
      `/tasks?workspaceId=${encodeURIComponent(workspaceId)}&view=board&kind=work_item,goal&limit=100`,
    );
    if (!res.ok) {
      setTaskError(res.message);
      setTasksLoading(false);
      return;
    }
    setTasks((res.data ?? []).filter(isBoardProjectionTask));
    setTasksLoading(false);
  }, [workspaceId]);

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

    const es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}&since=0`);
    const handler = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as { type?: string };
        if (typeof event.type !== 'string') return;
        if (event.type.startsWith('contact.')) {
          // Single re-pull for friends + sent + received covers every event
          // type — cheap relative to the visible UX win.
          void reloadContacts();
          return;
        }
        if (event.type.startsWith('task.')) {
          // The task-stream hook owns the kanban refresh.
          return;
        }
        if (event.type.startsWith('runtime.')) {
          if (workspaceId) void reloadRuntimeInstallations(workspaceId);
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
    };
  }, [isAuthenticated, isAuthLoading, reloadContacts, workspaceId, reloadRuntimeInstallations]);

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
    reloadAssets,
    workspaceId,
  ]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

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
  const [currentTime] = useState(() => Date.now());

  const recentAssets = useMemo(() => {
    if (!selectedConversationId) return [] as AssetDTO[];
    const cutoff = currentTime - 7 * 24 * 60 * 60 * 1000;
    return assets
      .filter((asset) => {
        const meta = asset.metadata ?? {};
        const cid = typeof meta.conversationId === 'string' ? meta.conversationId : null;
        if (cid !== selectedConversationId) return false;
        const ts = Date.parse(asset.createdAt);
        return Number.isFinite(ts) && ts >= cutoff;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 3);
  }, [assets, currentTime, selectedConversationId]);

  const taskStats = useMemo(() => {
    const total = tasks.length;
    const inProgress = tasks.filter((task) => task.status === 'running' || task.status === 'review').length;
    const done = tasks.filter((task) => task.status === 'completed').length;
    return { total, inProgress, done };
  }, [tasks]);

  // Wave-8 W10 — task drawer reverse-link. Drops the user back into the IM
  // panel, selects the conversation, and (on mobile) flips to the sessions
  // surface so the chat is actually visible. Closing the drawer would be
  // jarring as a side effect, so we leave it open — users can click the
  // chip on the chat header strip to come back to the same task.
  const onOpenChatFromTask = useCallback(
    (conversationId: string) => {
      setSelectedConversationId(conversationId);
      setImCollapsed(false);
      if (isMobileViewport) {
        setMobileSurface('sessions');
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
  const onOpenAssetInspector = useCallback((assetId: string) => {
    setActiveSurface('library');
    setMobileSurface('library');
    setInspector({ kind: 'asset', assetId });
  }, []);

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
          setImCollapsed(false);
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
              setImCollapsed(false);
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

  const onNewSession = useCallback(async () => {
    if (!workspaceId || !addToast) return;
    const title = `Session ${new Date().toLocaleDateString('zh-CN')}`;
    const res = await imFetch<{ id: string }>('/groups', {
      method: 'POST',
      body: JSON.stringify({ title, members: [] }),
    });
    if (!res.ok) {
      addToast(`Create session failed: ${res.message}`, 'error');
      return;
    }
    await reloadConversations(workspaceId);
    setSelectedConversationId(res.data.id);
    setImCollapsed(false);
  }, [workspaceId, addToast, reloadConversations]);

  const onChannelCreated = useCallback(
    async (newConvId: string) => {
      if (!workspaceId) return;
      await reloadConversations(workspaceId);
      setSelectedConversationId(newConvId);
      setImCollapsed(false);
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
        setImCollapsed(true);
      }
      if (workspaceId) await reloadConversations(workspaceId);
      addToast('Session archived.', 'success');
    },
    [addToast, reloadConversations, selectedConversationId, workspaceId],
  );

  const onDeleteSession = useCallback(
    async (session: ConversationDTO) => {
      if (!window.confirm(`Leave "${session.displayTitle || session.title || 'this session'}"?`)) return;
      const res = await imFetch(`/conversations/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast(`Leave failed: ${res.message}`, 'error');
        return;
      }
      if (selectedConversationId === session.id) {
        setSelectedConversationId(null);
        setImCollapsed(true);
      }
      if (workspaceId) await reloadConversations(workspaceId);
      addToast('Session left.', 'success');
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
        setImCollapsed(false);
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
      setImCollapsed(false);
    },
    [addToast, reloadConversations, workspaceId],
  );

  const onSelectSession = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) {
        setSelectedConversationId(null);
        setImCollapsed(true);
        return;
      }
      // Re-clicking the active session: always expand the IM panel. The
      // previous toggle behaviour fought with onChannelCreated(), which opens
      // the panel automatically — a follow-up row click in the seed flow
      // (which the W4 spec helper performs) would otherwise re-collapse it.
      if (sessionId === selectedConversationId) {
        setImCollapsed(false);
        return;
      }
      setSelectedConversationId(sessionId);
      setImCollapsed(false);
    },
    [selectedConversationId],
  );

  const onUploadAsset = useCallback(() => {
    setUploadTarget(null);
    uploadInputRef.current?.click();
  }, []);

  const onUploadTaskAttachment = useCallback(
    (taskId: string) => {
      setUploadTarget({ sourceTaskId: taskId, conversationId: selectedConversationId });
      uploadInputRef.current?.click();
    },
    [selectedConversationId],
  );

  const uploadAssetFiles = useCallback(
    async (files: File[], target?: { conversationId?: string | null; sourceTaskId?: string | null } | null) => {
      if (!workspaceId || files.length === 0) return;
      let lastAsset: AssetDTO | null = null;
      const effectiveTarget = target ?? uploadTarget;
      for (const file of files) {
        const form = new FormData();
        form.set('workspaceId', workspaceId);
        form.set('file', file);
        form.set('kind', file.type.startsWith('image/') ? 'image' : 'file');
        // Wave-8 W10: when the upload originates inside a session (the
        // attachments panel button or the chat composer's paperclip), tag
        // the asset metadata with `conversationId` so the linked-context
        // strip on the chat header can surface it back as a recent asset.
        const meta: Record<string, unknown> = { title: file.name };
        if (effectiveTarget?.conversationId ?? selectedConversationId) {
          meta.conversationId = effectiveTarget?.conversationId ?? selectedConversationId;
        }
        if (effectiveTarget?.sourceTaskId) {
          form.set('sourceTaskId', effectiveTarget.sourceTaskId);
          meta.taskId = effectiveTarget.sourceTaskId;
        }
        form.set('metadata', JSON.stringify(meta));
        const res = await imFetch<AssetDTO>('/assets', {
          method: 'POST',
          body: form,
          headers: {},
        });
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
      }
      await reloadAssets(workspaceId);
      if (lastAsset && !effectiveTarget?.sourceTaskId) onOpenAssetInspector(lastAsset.id);
      setUploadTarget(null);
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
            } catch (err) {
              console.error('[Workspace] simple-team post-success refresh failed', err);
              addToast('团队已创建,但侧边栏刷新失败,请手动刷新页面', 'info');
            }
            // Navigate ALWAYS runs: conversationId is backend-confirmed and
            // the navigate itself doesn't depend on the reload succeeding.
            setSelectedConversationId(event.conversationId);
            setImCollapsed(false);
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
      reloadConversations,
      reloadProfiles,
      reloadRuntime,
      reloadRuntimeInstallations,
    ],
  );

  const onOpenNewTask = useCallback((column?: KanbanColumnKey) => {
    setNewTaskInitialColumn(column ?? null);
    setNewTaskOpen(true);
  }, []);

  const onOpenTaskById = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveSurface('tasks');
  }, []);

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
        myRole={selectedConversation.myRole}
        pinned={Boolean(selectedConversation.pinned)}
        muted={Boolean(selectedConversation.muted)}
        onAddMember={() => setAddMemberOpen(true)}
        onRename={() => setRenameOpen(true)}
        onTogglePin={() => void togglePinSession(selectedConversation.id, !selectedConversation.pinned)}
        onToggleMute={() => void toggleMuteSession(selectedConversation.id, !selectedConversation.muted)}
        onArchive={() => void onArchiveSession(selectedConversation)}
        onLeave={() => void onDeleteSession(selectedConversation)}
        onDelete={() => void onDeleteSession(selectedConversation)}
      />
    );
  }, [selectedConversation, isDark, togglePinSession, toggleMuteSession, onArchiveSession, onDeleteSession]);

  // First-visit tour gating: open after bootstrap completes if user has not
  // seen it. Decoupled from bootstrap so the tour overlays a settled UI.
  // Auto-skips under automation (navigator.webdriver true) so Playwright
  // specs covering downstream surfaces don't get blocked by the overlay's
  // pointer-event capture — production users still see the tour as normal.
  useEffect(() => {
    if (bootstrapping || bootstrapError) return;
    if (hasSeenWorkspaceTour()) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    // Brief delay for layout to settle (lg-only setup-progress anchor needs
    // its width to compute before we measure).
    const t = window.setTimeout(() => setTourOpen(true), 400);
    return () => window.clearTimeout(t);
  }, [bootstrapping, bootstrapError]);

  const dismissOnboardingChecklist = useCallback(() => {
    setOnboardingDismissed(true);
    try {
      localStorage.setItem('prismer.onboardingChecklistDismissed.v1', String(Date.now()));
    } catch {
      /* private browsing */
    }
  }, []);

  // Show floating onboarding checklist when:
  //   - tour has been completed/skipped (tour overlay would conflict)
  //   - user hasn't dismissed
  //   - at least one of the 4 setup steps is incomplete
  //   - we're not running under Playwright/automation (the card's "Create
  //     agent / Open session / Dispatch task / Add asset" buttons confuse
  //     accessible-name selectors in downstream specs)
  const allSetupDone = agents.length > 0 && conversations.length > 0 && tasks.length > 0 && assets.length > 0;
  const isAutomation = typeof navigator !== 'undefined' && navigator.webdriver;
  const showOnboardingChecklist =
    !bootstrapping && !bootstrapError && !tourOpen && !onboardingDismissed && !allSetupDone && !isAutomation;

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
      // ClientLayout's <main> consumes pt-[88px] + pb-12 = 136px. Page must
      // match or it overflows main → browser-level scroll.
      className={`flex h-[calc(100vh-136px)] flex-col overflow-hidden ${
        isDark
          ? 'bg-zinc-950 text-zinc-200'
          : 'bg-[linear-gradient(180deg,#fbfbff_0%,#f7f8fc_48%,#fbfbff_100%)] text-zinc-900'
      }`}
    >
      <TopBar
        isDark={isDark}
        workspace={workspace}
        streamState={streamState}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={onAssetFileSelected} />

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
          ) : mobileSurface === 'sessions' && selectedConversation ? (
            <ImChannel
              isDark={isDark}
              conversation={selectedConversation}
              currentUserId={me?.id}
              notify={addToast}
              compact
              assets={assets}
              files={workspaceFiles}
              onNewChannel={() => setNewChannelOpen(true)}
              onUploadAsset={onUploadAsset}
              onOpenAssets={() => {
                setMobileSurface('library');
                setSelectedConversationId(null);
              }}
              onOpenTask={onOpenTaskById}
              onMobileBack={() => setSelectedConversationId(null)}
              headerActions={sessionSettingsMenuElement}
              onAddMember={() => setAddMemberOpen(true)}
              linkedTasks={linkedTasks}
              linkedAgents={linkedAgents}
              recentAssets={recentAssets}
              onOpenAsset={onOpenAssetInspector}
              onOpenAgent={onOpenAgentInspector}
              onSaveMessageAsMemory={(payload) => {
                setSaveAsMemorySource({
                  conversationId: payload.conversationId,
                  messageId: payload.messageId,
                  text: payload.text,
                  authorImUserId: payload.authorImUserId,
                  createdAt: payload.createdAt,
                });
              }}
            />
          ) : mobileSurface === 'sessions' ? (
            <MobileSessionsList
              isDark={isDark}
              conversations={conversations}
              onSelect={(id) => setSelectedConversationId(id)}
              onNewChannel={() => setNewChannelOpen(true)}
            />
          ) : mobileSurface === 'tasks' ? (
            <TaskBoard
              isDark={isDark}
              tasks={tasks}
              loading={tasksLoading}
              error={taskError}
              agents={agents}
              assets={assets}
              onTaskChanged={reloadTasks}
              notify={addToast}
              onNewTask={onOpenNewTask}
              onOpenTask={(task) => void openTaskById(task.id)}
              onUploadTaskAttachment={onUploadTaskAttachment}
              onOpenAsset={onOpenAssetInspector}
              onOpenConversation={(conversationId) => {
                setSelectedConversationId(conversationId);
                setMobileSurface('sessions');
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
                onOpenInspector={setInspector}
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
                  profiles={profiles}
                  runtime={runtime}
                  assets={assets}
                  files={workspaceFiles}
                  onOpenChange={(open) => {
                    if (!open) setInspector(null);
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
          ) : mobileSurface === 'contacts' ? (
            <div
              data-testid="mobile-contacts-placeholder"
              className={`flex-1 flex flex-col items-center justify-center px-6 text-center ${
                isDark ? 'text-zinc-400' : 'text-zinc-600'
              }`}
            >
              <p className="text-sm font-semibold">Contacts</p>
              <p className="mt-1 text-xs opacity-80">Contact directory is best on a wider screen.</p>
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
                onOpenInspector={setInspector}
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
        className={`flex min-h-0 flex-1 gap-3 p-3 pt-4 ${isMobileViewport ? 'hidden' : ''}`}
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
          assets={assets}
          agents={agents}
          runtime={runtime}
          selectedSessionId={selectedConversationId}
          activeSurface={activeSurface}
          onSelectSession={onSelectSession}
          onSelectSurface={setActiveSurface}
          onOpenCreation={() => setUnifiedOpen(true)}
          onNewSession={onNewSession}
          onRenameSession={onRenameSession}
          onArchiveSession={onArchiveSession}
          onDeleteSession={onDeleteSession}
        />

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
        ) : (
          <>
            <AnimatePresence initial={false} mode="popLayout">
              {!imCollapsed ? (
                <motion.section
                  key="session-panel"
                  layout={false}
                  initial={{ opacity: 0, x: -24, scale: 0.985, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: -28, scale: 0.985, filter: 'blur(8px)' }}
                  transition={{ duration: 0 }}
                  style={{ width: imWidth }}
                  className={`hidden md:flex shrink-0 flex-col overflow-hidden border ${
                    isDark
                      ? 'border-white/[0.06] bg-zinc-950/30 shadow-[0_22px_70px_-52px_rgba(139,92,246,0.9)]'
                      : 'border-zinc-200/80 bg-white/78 shadow-[0_22px_70px_-54px_rgba(76,29,149,0.35)]'
                  } rounded-2xl`}
                >
                  {/*
                    NOTE: page.tsx wires `onOpenTask={openTaskById}` here once
                    sibling W7 lands the message-level "Open card" affordance
                    in im-channel.tsx (it adds the prop on ImChannelProps).
                    For now we keep the prop unwired — the helper is exported
                    via the drawer's `onOpenTask` and the board's `onOpenTask`
                    so breadcrumb + board flows still exercise the fallback
                    fetch, which is the part that was broken on board cache
                    misses. T3's chat-message path is dead code without W7.
                  */}
                  <ImChannel
                    isDark={isDark}
                    conversation={selectedConversation}
                    currentUserId={me?.id}
                    notify={addToast}
                    compact
                    assets={assets}
                    files={workspaceFiles}
                    onNewChannel={() => setNewChannelOpen(true)}
                    onUploadAsset={onUploadAsset}
                    onOpenAssets={() => setActiveSurface('library')}
                    onOpenTask={onOpenTaskById}
                    onCollapse={() => setImCollapsed(true)}
                    headerActions={sessionSettingsMenuElement}
                    onAddMember={() => setAddMemberOpen(true)}
                    linkedTasks={linkedTasks}
                    linkedAgents={linkedAgents}
                    recentAssets={recentAssets}
                    onOpenAsset={onOpenAssetInspector}
                    onOpenAgent={onOpenAgentInspector}
                    onSaveMessageAsMemory={(payload) => {
                      setSaveAsMemorySource({
                        conversationId: payload.conversationId,
                        messageId: payload.messageId,
                        text: payload.text,
                        authorImUserId: payload.authorImUserId,
                        createdAt: payload.createdAt,
                      });
                    }}
                  />
                </motion.section>
              ) : null}
            </AnimatePresence>

            {!imCollapsed ? (
              <div
                role="separator"
                aria-label="Resize session panel"
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={startImResize}
                onDoubleClick={() => setImWidth(IM_WIDTH_DEFAULT)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    setImWidth((w) => Math.max(IM_WIDTH_MIN, w - 16));
                    e.preventDefault();
                  } else if (e.key === 'ArrowRight') {
                    setImWidth((w) => Math.min(IM_WIDTH_MAX, w + 16));
                    e.preventDefault();
                  }
                }}
                data-testid="im-panel-resizer"
                className={`hidden md:flex group relative -mx-2 w-4 shrink-0 cursor-col-resize items-center justify-center select-none ${
                  imDragging ? 'cursor-col-resize' : ''
                }`}
                title="Drag to resize · double-click to reset"
              >
                <span
                  className={`h-12 w-[3px] rounded-full transition-colors ${
                    imDragging
                      ? isDark
                        ? 'bg-violet-300/80'
                        : 'bg-violet-500/80'
                      : isDark
                        ? 'bg-white/[0.08] group-hover:bg-violet-300/60'
                        : 'bg-zinc-300 group-hover:bg-violet-500/60'
                  }`}
                />
              </div>
            ) : null}

            <motion.main
              layout
              transition={springHeavy}
              className={`relative min-w-0 flex flex-1 flex-col overflow-hidden border ${
                isDark
                  ? 'border-white/[0.06] bg-zinc-950/30 shadow-[0_22px_70px_-52px_rgba(139,92,246,0.9)]'
                  : 'border-zinc-200/80 bg-white/78 shadow-[0_22px_70px_-54px_rgba(76,29,149,0.35)]'
              } rounded-2xl`}
            >
              {activeSurface === 'tasks' ? (
                <TaskBoard
                  isDark={isDark}
                  tasks={tasks}
                  loading={tasksLoading}
                  error={taskError}
                  agents={agents}
                  assets={assets}
                  onTaskChanged={reloadTasks}
                  notify={addToast}
                  onNewTask={onOpenNewTask}
                  onOpenTask={(task) => void openTaskById(task.id)}
                  onUploadTaskAttachment={onUploadTaskAttachment}
                  onOpenAsset={onOpenAssetInspector}
                  onOpenConversation={(conversationId) => {
                    setSelectedConversationId(conversationId);
                    setImCollapsed(false);
                  }}
                />
              ) : activeSurface === 'contacts' ? (
                <ContactsPanel
                  isDark={isDark}
                  me={me}
                  friends={contacts}
                  agents={agents}
                  receivedRequests={receivedRequests}
                  sentRequests={sentRequests}
                  prefillUserId={prefillContactUserId}
                  onReload={reloadContacts}
                  onStartChat={onStartContactChat}
                  onOpenAgentProfile={onOpenAgentInspector}
                  onOpenSession={async (conversationId) => {
                    // Reload conversations BEFORE selecting so the LeftRail
                    // session row exists by the time the ImChannel queries
                    // selectedConversation. Otherwise React renders an empty
                    // middle panel for one frame before the list arrives.
                    if (workspaceId) await reloadConversations(workspaceId);
                    setSelectedConversationId(conversationId);
                    setImCollapsed(false);
                  }}
                  notify={addToast}
                />
              ) : activeSurface === 'library' ? (
                <LibrarySurface
                  isDark={isDark}
                  workspaceId={workspaceId}
                  assets={assets}
                  files={workspaceFiles}
                  onUploadAsset={onUploadAsset}
                  onOpenInspector={setInspector}
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
                  onOpenInspector={setInspector}
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
                assets={assets}
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
              {inspector?.kind === 'asset' ? (
                <WorkspaceInspectorDialog
                  open
                  isDark={isDark}
                  workspaceName={workspace?.name ?? 'Personal Workspace'}
                  inspector={inspector}
                  agents={agents}
                  profiles={profiles}
                  runtime={runtime}
                  assets={assets}
                  files={workspaceFiles}
                  onOpenChange={(open) => {
                    if (!open) setInspector(null);
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
            </motion.main>
          </>
        )}
      </motion.div>

      <LibrarySearchModal
        isDark={isDark}
        workspaceId={workspaceId}
        assets={assets}
        onOpenInspector={(next) => {
          // Asset overlay is only rendered inside the library surface (mobile
          // gates by `mobileSurface === 'library'`; desktop's auto-close
          // effect requires `activeSurface === 'library'`). Search can fire
          // from any surface, so align both surface states first.
          if (next.kind === 'asset') {
            setActiveSurface('library');
            setMobileSurface('library');
          }
          setInspector(next);
        }}
        onOpenMemoryPage={(path) => {
          setMemoryJumpPath(path);
          setActiveSurface('library');
          setMobileSurface('library');
        }}
      />

      <SaveAsMemoryModal
        open={saveAsMemorySource !== null}
        workspaceId={workspaceId}
        isDark={isDark}
        source={saveAsMemorySource}
        onClose={() => setSaveAsMemorySource(null)}
        onSaved={(page) => {
          setSaveAsMemorySource(null);
          setMemoryJumpPath(page.path);
          setActiveSurface('library');
          setMobileSurface('library');
        }}
        notify={addToast}
      />

      <LibraryProposalReviewModal
        open={proposalReviewOpen}
        workspaceId={workspaceId}
        isDark={isDark}
        onClose={() => setProposalReviewOpen(false)}
        onChanged={() => setProposalRefreshTick((tick) => tick + 1)}
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
        profiles={profiles}
        runtime={runtime}
        assets={assets}
        files={workspaceFiles}
        onOpenChange={(open) => {
          if (!open) setInspector(null);
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
      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={setNewAgentOpen}
        workspaceId={workspace?.id ?? null}
        onCreated={onAgentCreated}
        isDark={isDark}
        notify={addToast}
      />
      {workspace ? (
        <>
          <NewChannelDialog
            open={newChannelOpen}
            onOpenChange={setNewChannelOpen}
            workspaceId={workspace.id}
            agents={agents}
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
            defaultAssigneeId={defaultTaskAssigneeId}
            conversationId={selectedConversation?.id}
            initialColumn={newTaskInitialColumn}
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
            agents={agents}
            profiles={profiles}
            initialMode={unifiedInitialMode}
            onCreated={onUnifiedCreated}
          />
          {/* Wave-8 W4: settings menu dialogs (controlled by ⋮ menu in ImChannel header) */}
          {selectedConversation && selectedConversation.type !== 'direct' ? (
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
          {selectedConversation ? (
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
          Routes between Sessions / Tasks / Assets / Contacts / Devices surfaces. */}
      {isMobileViewport ? (
        <MobileNav
          isDark={isDark}
          active={mobileSurface}
          onSelect={(surface) => {
            setMobileSurface(surface);
            // Switching to a non-session surface should also drop any open
            // session so the next time the user taps Sessions they land on
            // the list, not on the previously-opened channel.
            if (surface !== 'sessions') {
              setSelectedConversationId(null);
            }
            // Keep desktop activeSurface in sync where it overlaps so layout
            // stays consistent across viewport changes (e.g. user rotates a
            // tablet, or our matchMedia listener fires post-resize).
            if (surface === 'tasks' || surface === 'library' || surface === 'contacts' || surface === 'runtime') {
              setActiveSurface(surface);
            }
          }}
        />
      ) : null}

      {/* First-visit tour overlay — anchored to topbar elements via data-tour-anchor */}
      <WorkspaceTour open={tourOpen} isDark={isDark} onDone={() => setTourOpen(false)} />

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
              channelsCount={conversations.length}
              tasksCount={tasks.length}
              assetsCount={assets.length}
              onNewAgent={() => setNewAgentOpen(true)}
              onNewChannel={() => setNewChannelOpen(true)}
              onNewTask={() => onOpenNewTask()}
              onUploadAsset={onUploadAsset}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
