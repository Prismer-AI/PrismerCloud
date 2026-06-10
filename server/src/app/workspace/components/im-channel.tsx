'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AtSign,
  AlertCircle,
  Archive,
  Ban,
  BellOff,
  Brain,
  Bookmark,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Command,
  Copy,
  File,
  FileText,
  Forward,
  Hourglass,
  ImageIcon,
  Keyboard,
  MapPin,
  Mic,
  PanelLeftClose,
  Pin,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  ArrowUp,
  Smile,
  Sparkles,
  Target,
  UserMinus,
  Users,
  XCircle,
  Wrench,
  X,
} from 'lucide-react';

import { copyText } from '@/lib/clipboard';
import { getWorkspaceToken, imFetch, imFetchWithMeta } from '../lib/im-api';
import { loadCursor, saveCursor } from '../lib/sse-cursor';
import {
  getGroupDetails,
  kickGroupMember,
  sendMessage,
  type GroupMember,
  type MessageAttachmentDTO,
} from '../lib/mutations';
import {
  fetchActiveTaskPhases,
  fetchSyncEvents,
  fetchTaskTimeline,
  resolveLatestTaskRunId,
  type ActivityTimelineStep,
} from '../lib/sync-api';
import { useReconciledStream, type ReconciledItem } from '../hooks/use-reconciled-stream';
import { AgentWorkingIndicator } from './agent-working-indicator';
import { AgentAvatar } from './agent-avatar';
import type { AgentLiveStatus } from '../lib/agent-status';
import type { AgentPhaseRow } from '../lib/agent-phase-store';
import { deriveMessageDeliveryState, type MessageDeliveryState } from '../lib/message-delivery-state';
import { DeliveryTimelineChip } from './delivery-timeline-chip';
import { avatarGradient, avatarInitials, radius, springSnap, springSoft, surface } from '../lib/design';
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import { MentionPicker, type MentionPickerHandle } from './mention-picker';
import { AssetPicker, type AssetPickerHandle } from './asset-picker';
import { ApprovalCard } from './approval-card';
import { TaskReviewBar } from './task-review-bar';
import {
  TaskDigestCard,
  readTaskDigestPayload,
  type AgentTaskPhase as TaskDigestAgentPhase,
  type TaskDigestPayload,
} from './task-digest-card';
import { useI18n } from '@/contexts/i18n-context';
import type { AgentDTO, AssetDTO, ConversationDTO, TaskDTO, WorkspaceFileDTO } from '../lib/types';
import { MessageContentBlocks, parseContentBlocks, type ContentBlock } from './content-blocks';
// v2.0.8 P1-2 (doc 21 §2) — revived InlineActivityStrip + cross-component
// pub/sub bus. See file-head REGRESSION GUARD notice in both files.
import { InlineActivityStrip } from './inline-activity-strip';
// release201/32 P1 — unified <AgentMessage> behind a default-OFF client flag.
import { AgentMessageContainer } from './agent-message/AgentMessageContainer';
import { isUnifiedAgentMessageEnabled } from './agent-message/flag';
import { MessageAssetCard, legacyFileUrlToAsset, type MessageAsset } from './message-asset-card';
import { MessageAssetViewerModal } from './message-asset-viewer-modal';
import { emitTaskStep } from '../lib/task-step-bus';

type WorkspaceT = ReturnType<typeof useI18n>['t'];

interface ImChannelProps {
  isDark: boolean;
  conversation: ConversationDTO | null;
  currentUserId?: string | null;
  /** Workspace ID — used by AssetPicker for autocomplete fetches and localStorage key. */
  workspaceId?: string | null;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  compact?: boolean;
  stageMode?: boolean;
  assets?: AssetDTO[];
  files?: WorkspaceFileDTO[];
  onNewChannel?: () => void;
  onUploadAsset?: () => void;
  /**
   * Composer attachment-panel upload entry (File / Photos / Camera). When
   * provided the panel prefers this over `onUploadAsset` — the parent wires
   * it to a handler that not only uploads the asset but also POSTs an
   * attachment message into the current conversation, so the file appears
   * in the chat stream instead of silently landing in the asset library.
   */
  onComposerUploadAsset?: () => void;
  /** Paste files/screenshots directly into the composer and attach them to the current conversation. */
  onComposerPasteFiles?: (files: File[]) => void | Promise<void>;
  onOpenAssets?: () => void;
  onOpenTask?: (taskId: string) => void;
  onCollapse?: () => void;
  /** Wave-8 W4: extra header actions (e.g. <SessionSettingsMenu />). */
  headerActions?: React.ReactNode;
  /** Wave-8 W4: when set, members panel shows an "Add member" button. */
  onAddMember?: () => void;
  /**
   * Wave-8 W4: mobile-only back button — renders a `<ChevronLeft />` chevron
   * at the leftmost slot of the header when defined. The desktop layout never
   * sets this (panels are juxtaposed, not stacked), so the testid is unique
   * to the mobile shell.
   */
  onMobileBack?: () => void;
  // ─── Wave-8 W10: session linked context chips ────────────────────────
  // Page-level state already knows everything: tasks/agents/assets are
  // loaded into the workspace shell at bootstrap. We pass the *filtered*
  // slices in so this component never re-derives or re-fetches. Empty
  // arrays render the "no linked context yet" hint instead.
  /** Tasks where `task.conversationId === conversation.id`. */
  linkedTasks?: TaskDTO[];
  /** Agents who appear as participants in this conversation. */
  linkedAgents?: AgentDTO[];
  /**
   * Lookup map { imUserId → role slug (`agentType`) }. Drives role-specific
   * avatar icons in message bubbles + the members panel (Crown for CEO,
   * Wrench for Engineer, etc.). Presence in this map ALSO doubles as the
   * "this id is an agent" signal — humans aren't in here, so the Avatar
   * falls back to initials. Built once in page.tsx from the workspace
   * agents list and passed down unchanged.
   */
  agentTypeByImUserId?: Record<string, string>;
  /**
   * imUserId → ASCII username (ceo/engineer/marketer). The RELIABLE role-icon
   * source for message avatars — agentType is a generic tier that maps to no
   * icon and localized names never match. Built in page.tsx from the agents
   * list and passed down unchanged.
   */
  usernameByImUserId?: Record<string, string>;
  /**
   * All known agent usernames. Used to detect agent senders by the
   * conversation member's username when the message `senderId` is a duplicate
   * im_users row (cloudUserId numericId-vs-userId divergence) not present in
   * `agentTypeByImUserId` / `usernameByImUserId` (keyed by the /me/agents row id).
   */
  agentUsernames?: Set<string>;
  /**
   * Task 3 — workspace-wide agent live-status map. Drives the avatar
   * status ring + hover popover for sender chips, members popover, and
   * the linked-context agent chips. Computed once in page.tsx, passed
   * down unchanged.
   */
  agentStatuses?: Map<string, AgentLiveStatus>;
  /**
   * P1 (Debug Pipeline 2026-05-24) — workspace-wide task-phase rows
   * sourced from the shared `useAgentPhaseMap()` singleton in page.tsx.
   * Forwarded down so the DeliveryTimelineChip can show "Working ·
   * tool_use" / "Stuck" without subscribing to its own SSE.
   */
  taskPhaseMap?: Map<string, AgentPhaseRow>;
  /**
   * 2026-05-29 (doc 14 §4.4.2 / doc 21 §5) — in-flight dispatch index
   * per agent imUserId → set of dispatchIds the cloud has acknowledged
   * but the daemon hasn't yet replied to. Page-level state accumulates
   * this from the `dispatch.lifecycle` SSE stream and forwards it down
   * so we can render a `running` placeholder AgentResponseCard the
   * instant the dispatch frame lands — without waiting for the daemon
   * to commit the reply. Empty / absent map ⇒ no placeholders.
   */
  dispatchInFlight?: Map<string, Set<string>>;
  /**
   * P1 (Debug Pipeline 2026-05-24) — host-supplied retry callback for the
   * DeliveryTimelineChip. Wired up to the daemon dispatch retry endpoint
   * by P2; in P1 the host stub just logs.
   */
  onRetryMessage?: (messageId: string) => void;
  /**
   * release201/26 §8 Phase 4 — retry a run whose daemon resume failed
   * (`IMTaskRun.status='resume_failed'`). Fired from the conversation-timeline
   * "任务中断，点击重试" strip. Host re-dispatches the run; in the absence of a
   * dedicated daemon re-dispatch endpoint the host stub surfaces a toast
   * (same staged rollout as `onRetryMessage`).
   */
  onRetryRun?: (taskId: string) => void;
  /** Up to 3 most-recent assets uploaded into this session within 7 days. */
  recentAssets?: AssetDTO[];
  /** Open an asset in the workspace inspector. */
  onOpenAsset?: (assetId: string) => void;
  /** Open an agent profile in the workspace inspector. */
  onOpenAgent?: (agentId: string) => void;
  /** Refresh task surfaces after composer-level review actions. */
  onTaskChanged?: () => void | Promise<void>;
  /**
   * Bubble action bar — Save button. Host implements one-click save (no
   * modal) by POSTing to `/memory/pages` with workspace defaults.
   */
  onSaveMessageAsMemory?: (payload: {
    conversationId: string;
    messageId: string;
    text: string;
    authorImUserId: string;
    createdAt: string;
  }) => void;
  /**
   * Bubble action bar — Forward button. Host opens a target-picker dialog
   * with the supplied payload and relays the message via `sendMessage` to
   * each chosen conversation.
   */
  onForwardMessage?: (payload: {
    conversationId: string;
    messageId: string;
    text: string;
    senderName: string;
    createdAt: string;
  }) => void;
  /**
   * release201/30 Phase 2 — inline upload progress.
   *
   * Page-level owns the active upload state and forwards a slim shape
   * the channel renders inside the composer attachment tray. `null`
   * (default) hides the row entirely. Errors stay in the toast layer
   * (page.tsx already pipes `notify('error', ...)` on failure), so this
   * surface is success-path only.
   */
  uploadProgress?: ComposerUploadProgressView | null;
}

/**
 * Inline upload progress payload — a narrowed `AssetUploadProgress` slice
 * pre-formatted for the composer row. The shape stays decoupled from the
 * underlying `asset-upload` types so the channel doesn't have to import
 * the full phase enum.
 */
export interface ComposerUploadProgressView {
  filename: string;
  /** 0..100 or null when phase doesn't expose a percentage. */
  percent: number | null;
  /** Short label like "Uploading" / "Hashing" / "Preparing upload". */
  phaseLabel: string;
  /** `2/5` style multi-file counter when relevant. */
  multiLabel?: string | null;
}

interface MessageDTO extends ReconciledItem {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  contentType?: string;
  type?: string;
  createdAt: string;
  metadata?: string | Record<string, unknown>;
  attachments?: MessageAttachmentDTO[] | null;
  /**
   * v2.0 §4.6 (Wave 4 E5) — multimodal ContentBlock[]. Coexists with
   * `content` (single string) and `attachments` (legacy) for the 6-sprint
   * double-write window per migration 406. When this array is populated,
   * `<MessageContentBlocks>` takes over rendering; otherwise the legacy
   * AttachmentRenderer path renders via `attachments` + `content`. Server
   * may surface this as a parsed array or a JSON-encoded string —
   * `parseContentBlocks()` accepts both.
   */
  contentBlocks?: ContentBlock[] | string | null;
  /** Server alias for the column name (some endpoints surface the raw JSON column). */
  contentBlocksJson?: ContentBlock[] | string | null;
  pending?: boolean;
  failed?: boolean;
  // Wave 3 §4.1 — reconcile fields.
  /** Per-conversation monotonic seq. NULL for optimistic locals not yet echoed. */
  boundarySeq?: number | null;
  /** Echo of the client-supplied idempotency key. Used to match optimistic + server twins. */
  idempotencyKey?: string | null;
  // Wave 4 §4.4.7 — streaming partial render fields.
  /** True while the server is still flushing partial chunks; flips false on isFinal=true. */
  streaming?: boolean;
  /** Highest chunkSeq applied; used to dedup arriving partial events. */
  streamChunkSeq?: number;
}

// Wave-7: agent dispatch state surfaced via the typed task.* SSE stream.
// `phase` follows the task lifecycle: assigned → executing (>=1 progress
// event) → terminal. We collapse the row when terminal lands and let the
// real agent reply message bubble take over via the existing sync stream.
type AgentTaskPhase = 'assigned' | 'executing';

interface AgentTaskStatus {
  taskId: string;
  phase: AgentTaskPhase;
  message: string | null;
  progress: number | null;
  updatedAt: number;
}

interface DroppedAssetPayload {
  id: string;
  title: string;
  kind: string;
  mime: string | null;
  sizeBytes: number | null;
  contentHash: string;
}

interface MessageHistoryResponse {
  messages: MessageDTO[];
}

interface MessageSearchResult extends MessageDTO {
  snippet?: string;
  matchRanges?: Array<{ start: number; end: number }>;
}

interface ConversationDetailsResponse {
  participants?: Array<{
    role: string;
    user: {
      id: string;
      username: string;
      displayName: string;
      role: string;
      agentType?: string | null;
    };
  }>;
}

interface RenderedMessage {
  message: MessageDTO;
  dateLabel: string | null;
  showSender: boolean;
}

// Wave-8 W7 — task/agent run terminal status → chat reverse-link.
// `task_status_event` is reserved for real kanban/work-item tasks.
// `agent_status_event` is used for chat mentions so the run protocol does
// not leak into the user-facing label as "Task failed".
//
// 2026-05-22 (doc 12): `awaiting_approval` is non-terminal — agent
// called `prismer.approval.request_human_approval` and the run is
// parked until the human decides. Renders as a yellow ⏳ pill instead
// of the red failure pill so users don't think the agent crashed.
// release201/26 §8 Phase 4 — `resume_failed` is a non-terminal interruption:
// the daemon couldn't resume an interrupted run from its local checkpoint
// (kill -9 / crash). Renders as an amber "任务中断，点击重试" pill with a retry
// action — distinct from a hard `failed` (red, terminal, has an agent reply).
type TaskStatusEventStatus = 'completed' | 'failed' | 'cancelled' | 'awaiting_approval' | 'resume_failed';
type StatusEventKind = 'task' | 'agent';

export interface TaskStatusEventInfo {
  taskId: string;
  taskTitle: string;
  status: TaskStatusEventStatus;
  kind: StatusEventKind;
  error?: string;
  triggerMessageId?: string;
}

/**
 * `mention_dispatch_failed` system_event — emitted by the cloud when an
 * @-mention couldn't reach the agent (agent offline, no profile, daemon
 * unreachable). These bubbles are noise in the chat history; we hide
 * them and instead render a small "delivery failed" chip pinned to the
 * user's trigger message.
 */
interface DispatchFailedEventInfo {
  agentImUserId: string;
  triggerMessageId: string;
  errorMessage: string;
}

function readDispatchFailedEvent(message: MessageDTO): DispatchFailedEventInfo | null {
  const t = message.type;
  if (t !== 'system' && t !== 'system_event') return null;
  const meta = normalizeMetadata(message.metadata);
  if (meta.kind !== 'mention_dispatch_failed') return null;
  const triggerMessageId = typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : '';
  if (!triggerMessageId) return null;
  return {
    agentImUserId: typeof meta.agentImUserId === 'string' ? meta.agentImUserId : '',
    triggerMessageId,
    errorMessage: typeof message.content === 'string' ? message.content : '',
  };
}

// Exported for unit testing (release201/26 §8 Phase 4 strip coverage). The
// renderer + status filter are otherwise internal to ImChannel.
export function readTaskStatusEvent(message: MessageDTO): TaskStatusEventInfo | null {
  // The cloud always writes `type='system'`, but a stray `system_event` with
  // the same metadata.kind shouldn't slip through. Normalise both.
  const t = message.type;
  if (t !== 'system' && t !== 'system_event') return null;
  const meta = normalizeMetadata(message.metadata);
  const metadataKind = typeof meta.kind === 'string' ? meta.kind : '';
  const sourceKind = typeof meta.sourceKind === 'string' ? meta.sourceKind : '';
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const eventKind: StatusEventKind | null =
    metadataKind === 'agent_status_event' ||
    sourceKind === 'chat_mention' ||
    content.startsWith('⚠️ Agent failed:') ||
    content.startsWith('⏳ Waiting for human approval')
      ? 'agent'
      : metadataKind === 'task_status_event'
        ? 'task'
        : null;
  if (!eventKind) return null;
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
  const status = typeof meta.status === 'string' ? meta.status : null;
  if (
    !taskId ||
    (status !== 'completed' &&
      status !== 'failed' &&
      status !== 'cancelled' &&
      status !== 'awaiting_approval' &&
      status !== 'resume_failed')
  ) {
    return null;
  }
  const taskTitle = typeof meta.taskTitle === 'string' ? meta.taskTitle : '';
  const triggerMessageId =
    typeof meta.triggerMessageId === 'string' && meta.triggerMessageId ? (meta.triggerMessageId as string) : undefined;
  const error = typeof meta.error === 'string' ? (meta.error as string) : undefined;
  return { taskId, taskTitle, status, kind: eventKind, triggerMessageId, error };
}

const GROUP_GAP_MS = 5 * 60 * 1000;

// Per-conversation scroll position, MODULE-LEVEL so it survives ImChannel
// unmount/remount. Opening an asset preview switches activeSurface to 'library'
// (page.tsx onOpenAssetInspector), which unmounts the chat surface; a
// component-local ref would be wiped, so on close the restore would fall back
// to scrollIntoView('end') and snap to the bottom. Keying by conversationId
// keeps it bounded and lets "return to where I left off" work across the
// preview round-trip. (release202 — preview round-trip scroll restore.)
const CONVERSATION_SCROLL_MEMORY = new Map<string, number>();

const SLASH_COMMANDS = [
  {
    name: 'task',
    hint: 'Dispatch work to a long-running agent',
    template: '/task @agent ',
  },
  {
    name: 'ask',
    hint: 'Ask the current session for context',
    template: '/ask ',
  },
  {
    name: 'assign',
    hint: 'Route a thread to a role owner',
    template: '/assign @agent ',
  },
  {
    name: 'summarize',
    hint: 'Request a compact session summary',
    template: '/summarize last 24h',
  },
] as const;

type ComposerPanel = 'attachments' | 'emoji' | 'commands' | null;

interface PastedTextBlock {
  id: string;
  text: string;
}

interface ComposerFileBlock {
  id: string;
  file: File;
  previewUrl: string | null;
  kind: 'image' | 'file';
}

const COMPOSER_EMOJIS = ['👍', '🙏', '🙌', '🙂', '🔥', '✅', '👀', '💡', '🚀', '📌', '🧠', '⚡'] as const;

export function ImChannel({
  isDark,
  conversation,
  currentUserId,
  workspaceId = null,
  notify,
  compact = false,
  stageMode = false,
  assets = [],
  files = [],
  onNewChannel,
  onUploadAsset,
  onComposerUploadAsset,
  onComposerPasteFiles,
  onOpenAssets,
  onOpenTask,
  onCollapse,
  headerActions,
  onAddMember,
  onMobileBack,
  linkedTasks = [],
  linkedAgents = [],
  agentTypeByImUserId,
  usernameByImUserId,
  agentUsernames,
  agentStatuses,
  taskPhaseMap,
  // dispatchInFlight prop is still accepted (parent passes it) but no longer
  // consumed here — release201/32 §9 removed the dispatch.lifecycle-based
  // pendingDispatches; the running mount derives from `typingRows` instead.
  onRetryMessage,
  onRetryRun,
  recentAssets = [],
  onOpenAsset,
  onOpenAgent,
  onTaskChanged,
  onSaveMessageAsMemory,
  onForwardMessage,
  uploadProgress = null,
}: ImChannelProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  // Wave 3 §4.1: messages are backed by a per-conversation reconciled stream.
  // boundarySeq drives gap detection + catch-up; localStorage cursor survives
  // F5. We still expose a `messages` array (derived from the hook) so the
  // sprawling render logic downstream needs no changes.
  const conversationIdForStream = conversation?.id ?? '';
  const stream = useReconciledStream<MessageDTO>({
    scope: { kind: 'conversation', id: conversationIdForStream },
    initialLoader: useCallback(async () => {
      if (!conversationIdForStream) return { items: [], lastSeq: 0 };
      const res = await imFetchWithMeta<MessageHistoryResponse | MessageDTO[]>(
        `/messages/${conversationIdForStream}?limit=60`,
      );
      if (!res.ok) return { items: [], lastSeq: 0 };
      const list = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
      let maxSeq = 0;
      for (const m of list) {
        if (typeof m.boundarySeq === 'number' && m.boundarySeq > maxSeq) maxSeq = m.boundarySeq;
      }
      return { items: list, lastSeq: maxSeq };
    }, [conversationIdForStream]),
    catchUp: useCallback(
      async (afterSeq: number) => {
        if (!conversationIdForStream) return { items: [] };
        const res = await fetchSyncEvents({ conversationId: conversationIdForStream, afterSeq });
        if (!res.ok) return { items: [] };
        // Each sync event whose `type === 'message.new'` carries the full
        // message in `.data`; we lift those into MessageDTO and discard
        // non-message event types (the reconcile loop only cares about
        // message rows for now).
        const items: MessageDTO[] = [];
        for (const evt of res.data.events) {
          if (evt.type !== 'message.new' && evt.type !== 'message.updated' && evt.type !== 'message.edit') continue;
          const msg = evt.data as MessageDTO | undefined;
          if (!msg || msg.conversationId !== conversationIdForStream) continue;
          items.push({ ...msg, boundarySeq: evt.boundarySeq ?? null });
        }
        return { items };
      },
      [conversationIdForStream],
    ),
    compareItems: useCallback((a: MessageDTO, b: MessageDTO) => {
      // Message lists are time-ordered (createdAt). When both rows have a
      // boundarySeq they agree with createdAt for same-conversation rows;
      // but optimistic locals (no boundarySeq) must still slot in correctly,
      // so we sort by createdAt primarily and fall back to id.
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      const aS = a.boundarySeq;
      const bS = b.boundarySeq;
      if (aS != null && bS != null && aS !== bS) return aS - bS;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }, []),
  });
  const messages = stream.items;
  // Pending sends are tracked here so the 5s "failed to send" timer can find
  // them by idempotencyKey. Key = idempotencyKey, value = timer id.
  const pendingSendTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // idempotencyKey → optimistic message id. Cleared when the SSE echo lands
  // (echo arrives with the same idempotencyKey + a real server id; the hook
  // dedups by id, and we use this map to delete the optimistic row).
  const optimisticByIdemKey = useRef<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F17 (2026-05-20) — infinite scroll up. Pre-F17 im-channel fetched the
  // most recent 60 messages once on conversation switch and never paged
  // older history; users seeing scrollbar at top had no way to reach
  // earlier turns. Total comes from the API meta block; we know to stop
  // fetching once messages.length >= totalCount or the API returns < page.
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // stageMode 下 composer 是浮动 absolute，scroll 区底部必须留出它的实际高度，
  // 否则最后一条消息被盖住（魔数 pb-48 在 composer 变高时不够）。ResizeObserver
  // 实时量 footer 高度，动态设 paddingBottom。
  const footerRef = useRef<HTMLElement | null>(null);
  const [composerH, setComposerH] = useState(0);
  const olderRequestSeq = useRef(0);
  // release201/32 P2 — unified <AgentMessage> is now the DEFAULT. Computed in an
  // effect (not inline) so SSR renders the legacy path and the client flips
  // post-mount → no hydration mismatch. Opt OUT via ?unifiedMsg=0 / localStorage
  // '0' / NEXT_PUBLIC_FF_UNIFIED_AGENT_MESSAGE=false (see agent-message/flag.ts).
  const [unifiedAgentMsg, setUnifiedAgentMsg] = useState(false);
  useEffect(() => {
    setUnifiedAgentMsg(isUnifiedAgentMessageEnabled());
  }, []);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  // Refs scoped to the members popover. Used by the outside-click effect
  // below so a click on the toggle button (which is OUTSIDE the panel DOM
  // tree) doesn't immediately re-close the panel it just opened.
  const membersPanelRef = useRef<HTMLDivElement | null>(null);
  const membersToggleRef = useRef<HTMLButtonElement | null>(null);
  // release201/07 §6.1 — `/skill new` slash command routes to Studio
  // Authoring via deep-link. We do NOT spawn an ephemeral authoring agent
  // inside chat (forbidden pattern); the slash handler hands off to Studio
  // and lets the chat session continue uninterrupted.
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const [draft, setDraft] = useState('');
  const [pastedTextBlocks, setPastedTextBlocks] = useState<PastedTextBlock[]>([]);
  const [composerFileBlocks, setComposerFileBlocks] = useState<ComposerFileBlock[]>([]);
  const [editingPasteId, setEditingPasteId] = useState<string | null>(null);
  const [editingPasteDraft, setEditingPasteDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [composerPanel, setComposerPanel] = useState<ComposerPanel>(null);
  const [approvalRefreshKey, setApprovalRefreshKey] = useState(0);
  const [voiceMode, setVoiceMode] = useState(false);
  // Wave-3.5 W5 (14b §6.2 P4) — drag state is now a discriminated union so the
  // composer can tell OS-file drops apart from workspace-asset chip drops.
  //  - 'asset': someone is dragging an `application/x-prismer-asset` chip from
  //    the asset library; existing onAssetDrop path (W10 contract) handles it.
  //  - 'file' : someone is dragging real files from Finder/Explorer; we treat
  //    each `dataTransfer.files[i]` like a clipboard paste and run the same
  //    `onComposerPasteFiles` pipeline (multi-file, real upload, no mock).
  const [draggingAsset, setDraggingAsset] = useState<null | 'asset' | 'file'>(null);
  // Wave-3.5 W5 — hidden multi-file input. AttachmentPanel "File"/"Photos"
  // buttons trigger this when no parent `onComposerUploadAsset` is wired,
  // so power users still get batch select (Cmd-click multi-select). Files
  // selected here ride the same `onComposerPasteFiles` path as paste/drop.
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFilePreviewUrlsRef = useRef<Set<string>>(new Set());
  const [agentTasks, setAgentTasks] = useState<Map<string, AgentTaskStatus>>(new Map());
  const lastReadMarkRef = useRef<{ conversationId: string; at: number } | null>(null);
  // Wave 3 §4.4.3 — keep the latest phase per taskId for TaskDigestCard.
  // Driven by `task.phase.changed` / `task.phase.stuck` / `task.phase.recovered`
  // sync events. We never derive phase from `task.updated` because the
  // status SSE stream is intentionally disjoint from the phase stream
  // (§12.4 invariant).
  const [taskPhases, setTaskPhases] = useState<
    Map<
      string,
      {
        phase: TaskDigestAgentPhase | null;
        lastStep?: { toolName?: string | null } | null;
        lastHeartbeatAt?: string | null;
      }
    >
  >(new Map());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MessageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const stageCompact = compact || stageMode;
  const visibleActiveTab = stageMode ? 'chat' : activeTab;
  const composerExpanded =
    draft.length > 240 || draft.includes('\n\n') || draft.split('\n').length > 3 || editingPasteId !== null;

  const revokeComposerFilePreview = useCallback((block: ComposerFileBlock) => {
    if (!block.previewUrl) return;
    URL.revokeObjectURL(block.previewUrl);
    composerFilePreviewUrlsRef.current.delete(block.previewUrl);
  }, []);

  const clearComposerFileBlocks = useCallback(() => {
    setComposerFileBlocks((prev) => {
      prev.forEach(revokeComposerFilePreview);
      return [];
    });
  }, [revokeComposerFilePreview]);

  const restoreComposerFileBlocks = useCallback(
    (files: File[]) => {
      setComposerFileBlocks((prev) => {
        prev.forEach(revokeComposerFilePreview);
        return files.map((file) => {
          const isImage = file.type.startsWith('image/');
          const kind: ComposerFileBlock['kind'] = isImage ? 'image' : 'file';
          const previewUrl = isImage ? URL.createObjectURL(file) : null;
          if (previewUrl) composerFilePreviewUrlsRef.current.add(previewUrl);
          return {
            id:
              typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            previewUrl,
            kind,
          };
        });
      });
    },
    [revokeComposerFilePreview],
  );

  const stageComposerFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setComposerFileBlocks((prev) => [
      ...prev,
      ...files.map((file) => {
        const isImage = file.type.startsWith('image/');
        const kind: ComposerFileBlock['kind'] = isImage ? 'image' : 'file';
        const previewUrl = isImage ? URL.createObjectURL(file) : null;
        if (previewUrl) composerFilePreviewUrlsRef.current.add(previewUrl);
        return {
          id:
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          previewUrl,
          kind,
        };
      }),
    ]);
    setComposerPanel(null);
  }, []);

  const removeComposerFileBlock = useCallback(
    (id: string) => {
      setComposerFileBlocks((prev) => {
        const target = prev.find((block) => block.id === id);
        if (target) revokeComposerFilePreview(target);
        return prev.filter((block) => block.id !== id);
      });
    },
    [revokeComposerFilePreview],
  );

  useEffect(() => {
    return () => {
      for (const url of composerFilePreviewUrlsRef.current) URL.revokeObjectURL(url);
      composerFilePreviewUrlsRef.current.clear();
    };
  }, []);

  const markConversationRead = useCallback((conversationId: string) => {
    const now = Date.now();
    const last = lastReadMarkRef.current;
    if (last?.conversationId === conversationId && now - last.at < 2000) return;
    lastReadMarkRef.current = { conversationId, at: now };
    void imFetch(`/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST' });
  }, []);
  const searchRequestSeq = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [mentionFilter, setMentionFilter] = useState<string | null>(null);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const mentionPickerRef = useRef<MentionPickerHandle | null>(null);
  const [assetFilter, setAssetFilter] = useState<string | null>(null);
  const assetRangeRef = useRef<{ start: number; end: number } | null>(null);
  const assetPickerRef = useRef<AssetPickerHandle | null>(null);
  // Picker should not let the user @-mention themselves. `currentUserId`
  // may be undefined while the session is loading — in that case fall
  // back to the unfiltered list rather than hiding everyone.
  const mentionMembers = useMemo(
    () => (currentUserId ? members.filter((m) => m.userId !== currentUserId) : members),
    [members, currentUserId],
  );

  const conversationId = conversation?.id ?? null;
  const conversationType = conversation?.type ?? null;
  const readOnlyObserver = conversation
    ? !(conversation.viewerAccess?.canSendMessage ?? conversation.myRole !== 'observer')
    : false;
  const draftKey = conversation ? `workspace:im:draft:${conversation.id}` : null;

  // Set of taskIds that correspond to real kanban cards in this conversation.
  // Used by MessageActionBar to gate the "Open card" chip — only show if the
  // referenced task is actually a board projection (not a deleted/internal
  // run that would 404 on click).
  const linkedTaskIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of linkedTasks) set.add(t.id);
    return set;
  }, [linkedTasks]);

  // 缺陷 5b fix (2026-05-22): when force-retry succeeds, the original
  // "Agent failed" system_event message stays in history forever. The chip
  // would otherwise stay sticky on "failed" because `readTaskStatusEvent`
  // only looks at the historical message metadata. We index linked tasks
  // by id so the renderer can override stale failure events with the
  // current authoritative task.status (completion wins over earlier failure).
  const linkedTaskById = useMemo(() => {
    const map = new Map<string, TaskDTO>();
    for (const t of linkedTasks) map.set(t.id, t);
    return map;
  }, [linkedTasks]);

  /**
   * Bug 3 (2026-05-29) — also reconcile `awaiting_approval` once the agent
   * has been redispatched and the run has reached a terminal state. Two
   * authoritative signals can override the stale historical event:
   *
   *   ① `linkedTaskById` (live TaskDTO row) — works for kanban-projected
   *      tasks (board cards).
   *   ② A more-recent `task_status_event` / `agent_status_event` for the
   *      same `taskId` in the message feed — works for chat-mention runs
   *      that have no board projection but emit a fresh system_event when
   *      the post-approval reply finally lands as `failed` (or, if the
   *      reply was successful and no system_event was minted, the implicit
   *      signal is "a normal agent_reply message arrived from this agent
   *      after the awaiting_approval event"). We treat that as `completed`
   *      so the orange pending strip clears.
   *
   * The pre-existing `failed → completed/cancelled` behaviour (缺陷 5b
   * fix from 2026-05-22) is preserved unchanged.
   */
  const taskStatusOverrides = useMemo(() => {
    // Build (taskId → reconciled terminal status) keyed by message order.
    // A later message wins over an earlier one for the same taskId.
    const map = new Map<string, TaskStatusEventStatus>();
    for (const message of messages) {
      const meta = normalizeMetadata(message.metadata);
      const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
      if (!taskId) continue;
      const info = readTaskStatusEvent(message);
      if (info && info.status !== 'awaiting_approval') {
        map.set(taskId, info.status);
        continue;
      }
      // Implicit signal: a regular agent reply (kind='agent_reply') landing
      // after the awaiting_approval system_event means the post-decision
      // redispatch succeeded. Treat as 'completed' so the historical
      // awaiting_approval pill stops loitering.
      if (meta.kind === 'agent_reply' && !map.has(taskId)) {
        map.set(taskId, 'completed');
      }
    }
    return map;
  }, [messages]);

  const reconcileTaskStatusEvent = useCallback(
    (info: TaskStatusEventInfo): TaskStatusEventInfo => {
      // Bug 3 — awaiting_approval is non-terminal; once any later signal
      // proves the run resumed, override the historical event so the
      // orange "等待人工确认" pill clears.
      if (info.status === 'awaiting_approval') {
        const override = taskStatusOverrides.get(info.taskId);
        if (override && override !== 'awaiting_approval') {
          return { ...info, status: override, error: undefined };
        }
        const live = linkedTaskById.get(info.taskId);
        if (live?.status === 'completed') return { ...info, status: 'completed', error: undefined };
        if (live?.status === 'failed') return { ...info, status: 'failed', error: undefined };
        if (live?.status === 'cancelled') return { ...info, status: 'cancelled', error: undefined };
        return info;
      }
      // 缺陷 5b (2026-05-22): force-retry success overrides stale failure.
      if (info.status !== 'failed') return info;
      const live = linkedTaskById.get(info.taskId);
      if (!live) return info;
      if (live.status === 'completed') {
        return { ...info, status: 'completed', error: undefined };
      }
      if (live.status === 'cancelled') {
        return { ...info, status: 'cancelled', error: undefined };
      }
      return info;
    },
    [linkedTaskById, taskStatusOverrides],
  );

  useEffect(() => {
    if (!readOnlyObserver) return;
    setDraft('');
    setPastedTextBlocks([]);
    clearComposerFileBlocks();
    setEditingPasteId(null);
    setEditingPasteDraft('');
    setComposerPanel(null);
    setVoiceMode(false);
  }, [clearComposerFileBlocks, readOnlyObserver]);

  useEffect(() => {
    if (!conversationId) {
      // Wave 3 §4.1: the reconcile hook handles its own reset on scope.id
      // change (currently empty string when conversation is null). Other
      // local-only UI state still needs explicit teardown.
      setMembers([]);
      setError(null);
      setDraft('');
      setPastedTextBlocks([]);
      clearComposerFileBlocks();
      setEditingPasteId(null);
      setEditingPasteDraft('');
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setSearchError(null);
      setHighlightedMessageId(null);
      setActiveTab('chat');
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setShowMembers(false);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchError(null);
    setHighlightedMessageId(null);
    setPastedTextBlocks([]);
    clearComposerFileBlocks();
    setEditingPasteId(null);
    setEditingPasteDraft('');
    setActiveTab('chat');

    setTotalCount(0);
    setReachedTop(false);
    setLoadingOlder(false);
    // F17 pagination meta still needs the `meta.total` block — the reconcile
    // hook owns the message rows, but it doesn't surface fetch envelope meta
    // (and we don't want to widen its contract for this one consumer). Issue
    // a HEAD-ish call to learn `total` so the infinite-scroll-up loop knows
    // when to stop. The rows themselves are loaded once by the hook's
    // initialLoader.
    imFetchWithMeta<MessageHistoryResponse | MessageDTO[]>(`/messages/${conversationId}?limit=60`, {
      signal: ctrl.signal,
    })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        const list = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
        const total = typeof res.meta?.total === 'number' ? res.meta.total : list.length;
        setTotalCount(total);
        if (list.length >= total) setReachedTop(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });

    if (conversationType === 'group') {
      getGroupDetails(conversationId).then((res) => {
        if (ctrl.signal.aborted) return;
        setMembers(res.ok ? (res.data.members ?? []) : []);
      });
    } else {
      imFetch<ConversationDetailsResponse>(`/conversations/${conversationId}`, { signal: ctrl.signal }).then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          setMembers([]);
          return;
        }
        setMembers(
          (res.data.participants ?? []).map((participant) => ({
            userId: participant.user.id,
            username: participant.user.username,
            displayName: participant.user.displayName,
            role: participant.role,
          })),
        );
      });
    }

    return () => ctrl.abort();
  }, [clearComposerFileBlocks, conversationId, conversationType]);

  // F17 (2026-05-20) — load older messages on scroll-up. Triggered by the
  // scroll handler attached to the message list container, the WS "ws msg
  // ← message.new" path keeps the bottom fresh while this fills upward.
  //
  // Pagination: API uses cursor-by-message-id (`before=<id>`); we pass the
  // current oldest message's id, expecting the API to return messages
  // strictly older than it (server takes care of `cursor: { id }, skip: 1`).
  // We pre-save the container's `scrollHeight` so we can restore the visual
  // anchor after the prepended messages render — without this, the scroll
  // position would visually "jump" to a different place every time older
  // history loads.
  const loadOlder = useCallback(async () => {
    if (!conversationId) return;
    if (loadingOlder || reachedTop) return;
    if (messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (!oldestId) return;
    const seq = ++olderRequestSeq.current;
    setLoadingOlder(true);
    const containerEl = scrollContainerRef.current;
    const anchorHeight = containerEl?.scrollHeight ?? 0;
    const anchorScrollTop = containerEl?.scrollTop ?? 0;
    try {
      const res = await imFetchWithMeta<MessageHistoryResponse | MessageDTO[]>(
        `/messages/${conversationId}?before=${encodeURIComponent(oldestId)}&limit=60`,
      );
      if (seq !== olderRequestSeq.current) return; // a newer load superseded us
      if (!res.ok) {
        // Don't surface as fatal — banner could be added later. Silently
        // stop trying so we don't loop on a broken endpoint.
        setReachedTop(true);
        return;
      }
      const older = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
      if (older.length === 0) {
        setReachedTop(true);
        return;
      }
      // F17 prepend: the reconcile hook (§4.1) is the SoT for message rows.
      // markLocal upserts by id, so duplicates from the cursor edge are
      // collapsed for free. We do NOT advance the boundarySeq cursor with
      // these — older rows are below the current cursor; the hook treats
      // them as historical fills.
      for (const m of older) {
        stream.markLocal({ ...m, boundarySeq: m.boundarySeq ?? null });
      }
      const total = typeof res.meta?.total === 'number' ? res.meta.total : 0;
      if (total > 0) setTotalCount(total);
      // If page came back smaller than requested OR we now have all rows,
      // we've reached the top — stop polling further loads.
      if (older.length < 60 || (total > 0 && messages.length + older.length >= total)) {
        setReachedTop(true);
      }
      // Restore scroll anchor on the next paint so user's reading position
      // is preserved despite the list growing upward.
      requestAnimationFrame(() => {
        const after = scrollContainerRef.current;
        if (!after) return;
        const delta = after.scrollHeight - anchorHeight;
        after.scrollTop = anchorScrollTop + delta;
      });
    } finally {
      if (seq === olderRequestSeq.current) setLoadingOlder(false);
    }
  }, [conversationId, loadingOlder, reachedTop, messages]);

  // F17 — scroll-up trigger. When the top of the scroll container reaches
  // within 80px of the start, fire `loadOlder`. Intentionally fires on
  // `scroll` (not `IntersectionObserver`) because the list ref is dynamic
  // (component re-renders) and avoiding observer setup keeps the code
  // simple. The 80px hysteresis avoids spamming when the user lingers near
  // the top edge.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const SCROLL_TRIGGER_PX = 80;
    const onScroll = () => {
      if (el.scrollTop <= SCROLL_TRIGGER_PX) void loadOlder();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loadOlder]);

  useEffect(() => {
    if (!conversation || !searchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }

    const ctrl = new AbortController();
    const requestSeq = ++searchRequestSeq.current;
    setSearchResults([]);
    setSearchError(null);
    setSearching(true);
    const timer = window.setTimeout(() => {
      imFetch<MessageSearchResult[]>(
        `/messages/${encodeURIComponent(conversation.id)}?q=${encodeURIComponent(query)}&limit=20`,
        { signal: ctrl.signal },
      )
        .then((res) => {
          if (ctrl.signal.aborted || requestSeq !== searchRequestSeq.current) return;
          if (!res.ok) {
            setSearchError(res.message);
            setSearchResults([]);
            return;
          }
          const rawResults = Array.isArray(res.data) ? res.data : [];
          const lowered = query.toLowerCase();
          setSearchResults(
            rawResults.filter((message) => {
              const text = `${message.snippet ?? ''}\n${message.content ?? ''}`.toLowerCase();
              return text.includes(lowered);
            }),
          );
        })
        .finally(() => {
          if (!ctrl.signal.aborted && requestSeq === searchRequestSeq.current) setSearching(false);
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [conversation, searchOpen, searchQuery]);

  useEffect(() => {
    if (!draftKey || typeof window === 'undefined') return;
    setDraft(window.localStorage.getItem(draftKey) ?? '');
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey || typeof window === 'undefined') return;
    if (draft.trim()) {
      window.localStorage.setItem(draftKey, draft);
    } else {
      window.localStorage.removeItem(draftKey);
    }
  }, [draftKey, draft]);

  // Auto-dismiss the members popover when the user interacts with anything
  // outside it. Tied to `showMembers` so listeners only attach while the
  // panel is open. The toggle button ref is excluded explicitly so a
  // re-click on the toggle goes through its own handler (toggle behavior)
  // rather than getting eaten as an outside-click + immediate re-open.
  useEffect(() => {
    if (!showMembers) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (membersPanelRef.current?.contains(target)) return;
      if (membersToggleRef.current?.contains(target)) return;
      setShowMembers(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowMembers(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [showMembers]);

  useEffect(() => {
    if (!conversation) return;
    markConversationRead(conversation.id);
  }, [conversation, markConversationRead]);

  // 2026-05-30 (A1) — gate the SSE EventSource on `conversationId` (string)
  // instead of `conversation` (object). The page-level state owns a
  // `setConversations` that re-creates the full ConversationDTO on every
  // SSE tick; before this change, every such tick tore down + reopened the
  // ImChannel EventSource, opening a brief window where `message.new`
  // events arriving in that gap could be lost. The reconcile cursor +
  // catch-up still recovers eventually, but until then the message list
  // appears blank on the surface that just re-mounted. Keying on the
  // stable id string avoids the churn entirely.
  useEffect(() => {
    if (!conversationId) return;
    const token = getWorkspaceToken();
    if (!token) return;

    // P2 (2026-05-25): cursor-based SSE replay. Shares cursor with the
    // page-level subscriber (both target /api/im/sync/stream), so we use
    // the same `'sync'` stream key — whichever effect writes last wins,
    // which is fine because both observe identical seq sequences from
    // the cloud's per-user fan-out.
    const cursorStream = 'sync';
    const initialCursor = currentUserId ? loadCursor(cursorStream, currentUserId) : 0;
    const es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}&since=${initialCursor}`);

    es.addEventListener('sync', (raw) => {
      try {
        // Wave 2-B1 envelope: { seq, boundarySeq, type, data, conversationId, at }.
        // `boundarySeq` is per-conversation monotonic; we forward it onto the
        // MessageDTO so the reconcile hook can detect gaps + dedup echoes.
        const event = JSON.parse((raw as MessageEvent).data) as {
          type?: string;
          data?: MessageDTO | { conversationId?: string | null };
          boundarySeq?: number | null;
          seq?: number;
          replayed?: boolean;
        };
        // P2 control envelopes.
        if (event.type === 'sync.backfill.done') {
          // Advance the cursor to the high-water seq the server replayed so
          // the next reconnect resumes here instead of falling back to 0.
          const doneSeq = (event as { seq?: number }).seq;
          if (currentUserId && typeof doneSeq === 'number' && doneSeq > 0) {
            saveCursor(cursorStream, currentUserId, doneSeq);
          }
          return;
        }
        if (event.type === 'sync.backfill.truncated') {
          // Resume from the newest replayed seq — NOT resetCursor(→0), which
          // makes the next reconnect re-replay the whole history and
          // re-truncate forever. newestSeq lets successive reconnects drain
          // the backlog in BACKFILL_CAP chunks until caught up.
          console.warn('[im-channel] SSE backfill truncated — resuming from newestSeq');
          const newestSeq = (event as { newestSeq?: number }).newestSeq;
          if (currentUserId && typeof newestSeq === 'number' && newestSeq > 0) {
            saveCursor(cursorStream, currentUserId, newestSeq);
          }
          return;
        }
        // Persist last-seen seq for the next reconnect.
        if (typeof event.seq === 'number' && event.seq > 0 && currentUserId) {
          saveCursor(cursorStream, currentUserId, event.seq);
        }
        if (event.type === 'approval.requested' || event.type === 'approval.decided') {
          const data = event.data as { conversationId?: string | null } | undefined;
          if (!data?.conversationId || data.conversationId === conversationId) {
            setApprovalRefreshKey((value) => value + 1);
          }
          return;
        }
        // v2.0.8 P1-2 (doc 21) — task.step.appended re-wired to the
        // task-step-bus singleton so the revived InlineActivityStrip can
        // render real-time tool_call / phase_change / reasoning rows. The
        // bus filters by (taskRunId, conversationId) so cross-conversation
        // events don't leak into the wrong Strip. Persistence + replay
        // still come from `GET /tasks/:taskRunId/timeline` (W4 endpoint).
        if (event.type === 'task.step.appended') {
          const payload = (
            event as {
              data?: {
                taskRunId?: string;
                taskId?: string;
                step?: {
                  seq?: number;
                  kind?: string;
                  payload?: unknown;
                  occurredAt?: string;
                  durationMs?: number | null;
                };
                conversationId?: string | null;
              };
            }
          ).data;
          const taskRunId = payload?.taskRunId;
          const taskId = payload?.taskId ?? taskRunId;
          const step = payload?.step;
          if (!taskRunId || !taskId || !step || typeof step.seq !== 'number' || typeof step.kind !== 'string') {
            return;
          }
          emitTaskStep({
            taskRunId,
            taskId,
            step: {
              // The recorder service derives the row id from (taskRunId,
              // seq) — within a single run, seq is the unique key the
              // front-end cares about; using `${taskRunId}:${seq}` keeps
              // it stable for memoised renderers.
              id: `${taskRunId}:${step.seq}`,
              seq: step.seq,
              kind: step.kind,
              payloadJson: step.payload ?? {},
              occurredAt: step.occurredAt ?? new Date().toISOString(),
              durationMs: typeof step.durationMs === 'number' ? step.durationMs : null,
            },
            conversationId: payload?.conversationId ?? null,
          });
          return;
        }
        // Wave 4 §4.4.7 — streaming partial render.
        // The cloud stream.service flushes ~200ms partial chunks to a
        // synthetic `message.partial` envelope on the same SSE channel.
        // We render a placeholder MessageDTO keyed by the server-minted
        // messageId; each partial appends to its `content`. The final
        // `message.new` outbox event arrives with the same messageId and
        // a real `boundarySeq`, at which point `applyExternal` overlays
        // the persisted row over the placeholder (same id → upsert).
        if (event.type === 'message.partial') {
          const partial = event.data as
            | {
                messageId?: string;
                conversationId?: string;
                senderId?: string;
                partialContent?: string;
                chunkSeq?: number;
                isFinal?: boolean;
              }
            | undefined;
          if (
            !partial ||
            !partial.messageId ||
            !partial.senderId ||
            partial.conversationId !== conversationId ||
            typeof partial.chunkSeq !== 'number'
          ) {
            return;
          }
          const existing = stream.items.find((m) => m.id === partial.messageId);
          // Dedup — if we've already applied a chunkSeq >= this one, drop.
          if (existing && (existing.streamChunkSeq ?? 0) >= partial.chunkSeq) return;

          if (existing) {
            stream.patchLocal(partial.messageId, {
              content: (existing.content ?? '') + (partial.partialContent ?? ''),
              streaming: !partial.isFinal,
              streamChunkSeq: partial.chunkSeq,
            } as Partial<MessageDTO>);
          } else {
            // First chunk — build a placeholder. boundarySeq null so it
            // doesn't advance the reconcile cursor; the `message.new`
            // echo will arrive later with the real boundarySeq.
            stream.markLocal({
              id: partial.messageId,
              conversationId,
              senderId: partial.senderId,
              content: partial.partialContent ?? '',
              type: 'text',
              createdAt: new Date().toISOString(),
              boundarySeq: null,
              streaming: !partial.isFinal,
              streamChunkSeq: partial.chunkSeq,
            } as MessageDTO);
          }
          return;
        }

        const msg = event.data as MessageDTO | undefined;
        if (
          (event.type === 'message.updated' || event.type === 'message.edit') &&
          msg &&
          msg.conversationId === conversationId
        ) {
          // Two server-side emit paths converge here: app-router attachment-
          // patch fires `message.updated` (src/app/api/im/[...path]/route.ts),
          // in-process IM `update()` fires `message.edit`
          // (src/im/services/message.service.ts:748). Both mean the same
          // thing for the client — patch by id in-place. Updates do NOT
          // advance the reconcile cursor (boundarySeq is allocated once per
          // message.new write).
          stream.patchLocal(msg.id, { ...msg, metadata: msg.metadata });
          return;
        }
        if (event.type !== 'message.new' || !msg || msg.conversationId !== conversationId) return;
        // §4.1 reconcile loop — feed the event through the hook. If it's
        // the echo of an optimistic send (same idempotencyKey), we first
        // delete the optimistic row by its key-as-id so the server-id row
        // takes over cleanly. Without this, both rows would briefly
        // coexist (different ids).
        if (msg.idempotencyKey) {
          const optimisticId = optimisticByIdemKey.current.get(msg.idempotencyKey);
          if (optimisticId && optimisticId !== msg.id) {
            stream.removeLocal(optimisticId);
            optimisticByIdemKey.current.delete(msg.idempotencyKey);
          }
          // Clear the 5s "failed-to-send" watchdog if it's still armed.
          const t = pendingSendTimers.current.get(msg.idempotencyKey);
          if (t) {
            clearTimeout(t);
            pendingSendTimers.current.delete(msg.idempotencyKey);
          }
        }
        // Wave 4 §4.4.7 — if this message.new is the persisted twin of a
        // streaming placeholder, drop the placeholder by its stream-id so
        // the canonical row (with real boundarySeq) takes over cleanly.
        const incomingMeta = normalizeMetadata(msg.metadata);
        const streamPlaceholderId =
          typeof incomingMeta.streamMessageId === 'string' ? (incomingMeta.streamMessageId as string) : null;
        if (streamPlaceholderId && streamPlaceholderId !== msg.id) {
          stream.removeLocal(streamPlaceholderId);
        }
        stream.applyExternal({ ...msg, boundarySeq: event.boundarySeq ?? null });
        if (msg.senderId !== currentUserId) {
          markConversationRead(conversationId);
        }
        // When the agent reply for a task lands in the timeline, drop
        // the corresponding ephemeral typing row even if task.completed
        // hasn't reached us yet (the SSE stream can race the IM fan-out
        // by ~50-300ms; without this the row briefly survives next to
        // the real bubble).
        const meta = normalizeMetadata(msg.metadata);
        const taskId =
          typeof meta.taskId === 'string' && meta.taskId
            ? meta.taskId
            : typeof meta.task_id === 'string' && (meta.task_id as string)
              ? (meta.task_id as string)
              : null;
        if (taskId) {
          setAgentTasks((prev) => {
            if (!prev.has(taskId)) return prev;
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
        }
      } catch {
        /* ignore malformed sync events */
      }
    });

    return () => es.close();
    // `stream` reference changes every render (useReconciledStream returns
    // a fresh object) but its memoised callbacks (applyExternal/markLocal/
    // patchLocal/removeLocal) are stable across renders — so the closure
    // remains correct without re-subscribing. Including `stream` here would
    // re-tear-down the EventSource on every render, defeating A1's fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUserId, markConversationRead]);

  // §4.4.2 page-load hydration. Without this, F5 / conversation switch /
  // cross-device reopen loses the phase chips because they're in-memory
  // (line ~447). We rebuild the map from the server BEFORE the SSE stream
  // opens so the user immediately sees "N agents working" instead of an
  // empty footer while waiting for the next event tick.
  //
  // Uses `GET /api/im/conversations/:cid/active-task-phases`, not the broad
  // `/tasks?conversationId=` fallback, so old pending/assigned board cards do
  // not come back as fake "executing" rows after page refresh.
  useEffect(() => {
    if (!conversationId) return;
    const ctrl = new AbortController();
    fetchActiveTaskPhases({ conversationId, signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res.ok) return;
        const map = new Map<string, AgentTaskStatus>();
        for (const t of res.data.tasks) {
          // §4.4.2 maps `currentPhase` directly onto AgentTaskStatus.phase.
          // Until the dedicated endpoint lands, `currentPhase` is the
          // placeholder 'executing' string returned by the helper — we
          // gate against the current narrow enum ('assigned' | 'executing')
          // and default to 'executing' for non-terminal tasks.
          const phase: AgentTaskPhase = t.currentPhase === 'assigned' ? 'assigned' : 'executing';
          const last = t.lastHeartbeatAt ? Date.parse(t.lastHeartbeatAt) : Date.now();
          map.set(t.taskId, {
            taskId: t.taskId,
            phase,
            message: t.statusMessage,
            progress: t.progress,
            updatedAt: Number.isFinite(last) ? last : Date.now(),
          });
        }
        setAgentTasks(map);
      })
      .catch(() => {
        /* swallow — non-critical: SSE will eventually rebuild state */
      });
    return () => ctrl.abort();
    // 2026-05-30 (A1) — gate on the stable id, not the full conversation
    // object (page-level setConversations re-creates the DTO on every tick).
  }, [conversationId]);

  // Wave-7: subscribe to typed task.* SSE so the chat surface can show
  // an ephemeral "Thinking…" / "Executing: …" row while the assigned
  // agent works on a dispatched task. The cloud filter on
  // /api/im/tasks/events already restricts events to creator/assignee;
  // we additionally narrow on conversationId so a sibling group's
  // task progress doesn't bleed into this channel.
  useEffect(() => {
    if (!conversationId) return;
    const token = getWorkspaceToken();
    if (!token) return;
    // 缺陷 5 fix (2026-05-22): also clear agentTasks on conversation switch.
    // The hydration effect above re-seeds it from the new conversation's
    // /tasks endpoint — without this clear, the typing rows / "Show actions"
    // chips from the previously-active conversation persisted until the
    // hydration response arrived, and worse, never got cleaned up when the
    // user switched back to a conversation whose tasks had since terminated.
    // taskPhases (Wave 3-C3) has no hydration path; reset on switch too.
    setAgentTasks(new Map());
    setTaskPhases(new Map());

    const es = new EventSource(`/api/im/tasks/events?token=${encodeURIComponent(token)}`);

    const upsert = (taskId: string, patch: Partial<AgentTaskStatus> & { phase: AgentTaskPhase }) => {
      setAgentTasks((prev) => {
        const next = new Map(prev);
        const existing = next.get(taskId);
        next.set(taskId, {
          taskId,
          phase: patch.phase,
          message: patch.message ?? existing?.message ?? null,
          progress: patch.progress ?? existing?.progress ?? null,
          updatedAt: Date.now(),
        });
        return next;
      });
    };
    const drop = (taskId: string) => {
      setAgentTasks((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
    };

    const validPhases: TaskDigestAgentPhase[] = [
      'assigned',
      'thinking',
      'tool_use',
      'reasoning',
      'responding',
      'waiting_user',
      'waiting_dep',
      'stuck',
    ];

    const handle = (eventName: string, raw: MessageEvent) => {
      let payload: {
        taskId?: string;
        conversationId?: string | null;
        statusMessage?: string | null;
        progress?: number | null;
        approvalId?: string | null;
        currentPhase?: string | null;
        lastHeartbeatAt?: string | null;
        lastStep?: { toolName?: string | null } | null;
      };
      try {
        payload = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (eventName === 'approval.requested' || eventName === 'approval.decided') {
        if (payload.conversationId && payload.conversationId !== conversationId) return;
        setApprovalRefreshKey((value) => value + 1);
        return;
      }
      const taskId = payload.taskId;
      if (!taskId) return;
      // Only events that belong to the active conversation drive the
      // typing indicator. Tasks created against other channels (e.g.
      // workspace board direct creates) skip the ephemeral row entirely.
      if (payload.conversationId && payload.conversationId !== conversationId) return;
      if (payload.approvalId) {
        setApprovalRefreshKey((value) => value + 1);
      }
      // Wave 3 — phase signal stream is disjoint from status. Update
      // taskPhases for any task we hear about, regardless of conversation
      // filter on status (the conversation filter is already applied above).
      if (eventName === 'task.phase.stuck') {
        setTaskPhases((prev) => {
          const next = new Map(prev);
          next.set(taskId, {
            phase: 'stuck',
            lastStep: payload.lastStep ?? next.get(taskId)?.lastStep ?? null,
            lastHeartbeatAt: payload.lastHeartbeatAt ?? next.get(taskId)?.lastHeartbeatAt ?? null,
          });
          return next;
        });
        return;
      }
      if (eventName === 'task.phase.changed' || eventName === 'task.phase.recovered') {
        const candidate = payload.currentPhase;
        const next: TaskDigestAgentPhase | null =
          candidate && validPhases.includes(candidate as TaskDigestAgentPhase)
            ? (candidate as TaskDigestAgentPhase)
            : null;
        setTaskPhases((prev) => {
          const out = new Map(prev);
          out.set(taskId, {
            phase: next,
            lastStep: payload.lastStep ?? out.get(taskId)?.lastStep ?? null,
            lastHeartbeatAt: payload.lastHeartbeatAt ?? out.get(taskId)?.lastHeartbeatAt ?? null,
          });
          return out;
        });
        return;
      }
      if (eventName === 'task.assigned' || eventName === 'task.created') {
        if (!payload.conversationId) return;
        upsert(taskId, { phase: 'assigned' });
      } else if (eventName === 'task.progress' || eventName === 'task.updated') {
        if (!payload.conversationId) return;
        upsert(taskId, {
          phase: 'executing',
          message: payload.statusMessage ?? null,
          progress: typeof payload.progress === 'number' ? payload.progress : null,
        });
      } else if (eventName === 'task.completed' || eventName === 'task.failed' || eventName === 'task.cancelled') {
        drop(taskId);
        // Drop terminal phase records too — the badge should disappear.
        setTaskPhases((prev) => {
          if (!prev.has(taskId)) return prev;
          const next = new Map(prev);
          next.delete(taskId);
          return next;
        });
      }
    };

    const types = [
      'task.created',
      'task.assigned',
      'task.progress',
      'task.updated',
      'task.completed',
      'task.failed',
      'task.cancelled',
      'task.phase.changed',
      'task.phase.stuck',
      'task.phase.recovered',
      'approval.requested',
      'approval.decided',
    ];
    const listeners = types.map((type) => {
      const fn = (raw: MessageEvent) => handle(type, raw);
      es.addEventListener(type, fn as EventListener);
      return [type, fn] as const;
    });

    return () => {
      for (const [type, fn] of listeners) es.removeEventListener(type, fn as EventListener);
      es.close();
    };
    // 2026-05-30 (A1) — gate on stable id, see comment above.
  }, [conversationId]);

  // ─── 滚动到底部 / 新消息跳转按钮 ───────────────────────────────────────
  // 旧逻辑无条件 scrollIntoView，会在用户往上翻看历史时把人强拽回底部。改为：
  // 只有用户本就在底部附近时才自动跟随；否则浮现"↓ 回到底部"按钮(新消息 append
  // 时仍在底层进行，用户主动点才回跳)。
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const atBottomRef = useRef(true);
  // 每个 conversation 记住上次离开时的 scrollTop；切回来恢复到那里而非跳顶/跳底。
  // 用 MODULE-LEVEL map(见上),这样打开 asset 预览(切到 library surface → 本组件
  // unmount)再关闭回来时,滚动位置不会丢 → 不再被拽到底部。
  const scrollMemoryRef = useRef<Map<string, number>>(CONVERSATION_SCROLL_MEMORY);
  // 当前 conversation 是否已完成「恢复滚动位置」（gate 自动跟随，避免恢复前被拽到底）。
  const restoredConvRef = useRef<string | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist < 80; // 容差 80px
      atBottomRef.current = atBottom;
      setShowJumpToBottom(!atBottom);
      // 持续记录当前 session 的滚动位置（恢复完成后才记，避免记到恢复中途的瞬时值）
      if (conversationId && restoredConvRef.current === conversationId) {
        scrollMemoryRef.current.set(conversationId, el.scrollTop);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  const jumpToBottom = useCallback(() => {
    // Scroll to the TRUE bottom (into the reserved composer padding), NOT to
    // endRef: endRef sits at content-end BEFORE the container's paddingBottom,
    // so scrollIntoView('end') stops short and leaves the last message hidden
    // behind the floating composer (user then has to nudge-scroll again).
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  // 切换 session：消息就绪后恢复到上次离开的滚动位置；没记录过则落底。
  // restoredConvRef gate 保证每个 conversation 只恢复一次，且在恢复完成前
  // 下面的自动跟随 effect 不会把人拽到底。
  useEffect(() => {
    if (!conversationId) return;
    if (loading) return; // 等本 session 消息加载完
    if (messages.length === 0) return; // rows 尚未填充，避免恢复到空列表底部
    if (restoredConvRef.current === conversationId) return; // 已恢复过
    const el = scrollContainerRef.current;
    if (!el) return;
    const saved = scrollMemoryRef.current.get(conversationId);
    if (saved != null) {
      el.scrollTop = saved;
      // On remount the message heights (images / pdf thumbnails) lay out
      // ASYNC, so scrollHeight starts small and `scrollTop = saved` clamps to a
      // too-small maxScroll (lands mid-conversation instead of where we left).
      // Re-apply across a few frames as the layout grows so the position
      // actually sticks. Bounded + stops once it lands or the conversation
      // changes, so it never fights the user.
      let frames = 0;
      const reapply = () => {
        const c = scrollContainerRef.current;
        if (!c || restoredConvRef.current !== conversationId) return;
        const maxScroll = c.scrollHeight - c.clientHeight;
        if (Math.abs(c.scrollTop - saved) > 4 && maxScroll >= saved - 4) {
          c.scrollTop = saved;
        }
        if (++frames < 30) requestAnimationFrame(reapply);
      };
      requestAnimationFrame(reapply);
    } else {
      el.scrollTop = el.scrollHeight; // true bottom (into composer padding), not endRef
    }
    restoredConvRef.current = conversationId;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 80;
    setShowJumpToBottom(!atBottomRef.current);
  }, [conversationId, loading, messages.length]);

  useEffect(() => {
    // 仅当「本 session 已恢复完毕」且用户已在底部时跟随；否则保持位置(按钮浮现)。
    if (restoredConvRef.current !== conversationId) return;
    if (atBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight; // true bottom (clears floating composer)
    }
  }, [messages.length, loading, agentTasks.size, conversationId]);

  // 量浮动 composer 高度 → 动态留白，保证最后一条消息能滚到 composer 之上。
  useEffect(() => {
    const el = footerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setComposerH(el.offsetHeight));
    ro.observe(el);
    setComposerH(el.offsetHeight);
    return () => ro.disconnect();
  }, [stageMode]);

  const typingRows = useMemo(() => {
    // 2026-05-29 — exclude sample/work-item tasks from the typing indicator.
    // New workspaces seed a `launchTourSeed:true` work_item task that lands
    // as `task.assigned` SSE the moment the user opens the new chat; without
    // this filter the user sees a permanent "EXECUTING + more" three-dot
    // chip with no real agent activity behind it (and the timeline fetch
    // 404s because IMTask ≠ IMTaskRun). Real chat-mention dispatches always
    // carry a non-work_item metadata kind, so they're unaffected.
    return Array.from(agentTasks.values())
      .filter((t) => {
        const linked = linkedTaskById.get(t.taskId);
        if (!linked) return true; // unknown task — keep (chat-mention runs don't have a linkedTasks entry, only IMTasks do)
        const meta = (linked.metadata ?? {}) as Record<string, unknown>;
        if (meta.launchTourSeed === true) return false;
        if (meta.kind === 'work_item' || meta.kind === 'goal') return false;
        return true;
      })
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }, [agentTasks, linkedTaskById]);

  const memberById = useMemo(() => {
    const map = new Map<string, GroupMember>();
    for (const member of members) map.set(member.userId, member);
    return map;
  }, [members]);

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const fileByAssetId = useMemo(() => new Map(files.map((file) => [file.assetId, file])), [files]);

  // Wave-8 W7 — when conversation.muted is true, suppress terminal status
  // chip rows on the client. The audit trail still lives in the DB (we never
  // skip writing the system message); we just hide it from the visible feed
  // so muted sessions don't keep buzzing the chat with completion lines.
  const muteTaskStatusEvents = Boolean(conversation?.muted);

  const renderedMessages = useMemo<RenderedMessage[]>(() => {
    // First pass: filter out terminal status rows when muted, then walk
    // the remaining list in display order to compute date/show-sender flags.
    // `mention_dispatch_failed` system_events are ALWAYS hidden — they
    // surface as a chip on the trigger message instead, since their bare
    // bubble form is just noise.
    const filtered = messages.filter((m) => {
      if (readDispatchFailedEvent(m) !== null) return false;
      if (muteTaskStatusEvents && readTaskStatusEvent(m) !== null) return false;
      return true;
    });
    return filtered.map((message, index) => {
      const prev = index > 0 ? filtered[index - 1] : null;
      const ts = Date.parse(message.createdAt);
      const day = Number.isFinite(ts) ? new Date(ts).toDateString() : '';
      const prevTs = prev ? Date.parse(prev.createdAt) : NaN;
      const prevDay = prev && Number.isFinite(prevTs) ? new Date(prevTs).toDateString() : '';
      const dateLabel = day !== prevDay ? formatDateDivider(message.createdAt, t) : null;
      // 2026-05-29 (C4) — every `agent_reply` is a dispatch turn boundary
      // (its own taskId + InlineActivityStrip + duration signature). The
      // legacy WhatsApp-style "same sender within 5min → collapse header"
      // grouping made two consecutive marketer replies look like the
      // second one had eaten the first ("吞消息" complaint): no avatar +
      // no name + tight mt-1 spacing on the second bubble. Force header
      // back on for any agent_reply so each dispatch reads as a distinct
      // turn — and also force it when the previous message was an
      // agent_reply (so a following human/system row gets its own
      // header back, not inherited grouping).
      const meta = normalizeMetadata(message.metadata);
      const prevMeta = prev ? normalizeMetadata(prev.metadata) : null;
      const isAgentReplyBoundary = meta.kind === 'agent_reply' || prevMeta?.kind === 'agent_reply';
      const showSender =
        !prev ||
        prev.senderId !== message.senderId ||
        !Number.isFinite(ts) ||
        !Number.isFinite(prevTs) ||
        ts - prevTs > GROUP_GAP_MS ||
        Boolean(dateLabel) ||
        isAgentReplyBoundary;
      return { message, dateLabel, showSender };
    });
  }, [messages, muteTaskStatusEvents, t]);

  // Wave-8 W7 — index terminal status rows by their `triggerMessageId`
  // so MessageRow can show an inline ✓/✗ chip next to the user's original
  // trigger message. Last-seen status wins (a task can only land in one
  // terminal state, but if cloud somehow re-emits we want the latest).
  const triggerStatusMap = useMemo(() => {
    const map = new Map<string, TaskStatusEventInfo>();
    for (const message of messages) {
      const info = readTaskStatusEvent(message);
      if (!info?.triggerMessageId) continue;
      // 缺陷 5b — let live linkedTasks status override stale failed events.
      map.set(info.triggerMessageId, reconcileTaskStatusEvent(info));
    }
    return map;
  }, [messages, reconcileTaskStatusEvent]);

  // Parallel index for `mention_dispatch_failed` events — same shape as
  // triggerStatusMap, keyed by the same triggerMessageId. Last-seen wins
  // (cloud may re-emit on retry).
  const dispatchFailedMap = useMemo(() => {
    const map = new Map<string, DispatchFailedEventInfo>();
    for (const message of messages) {
      const info = readDispatchFailedEvent(message);
      if (!info) continue;
      map.set(info.triggerMessageId, info);
    }
    return map;
  }, [messages]);

  // release201/32 §9 — unified running mount. Source of "which runs are active"
  // is `typingRows` (agentTasks executing) — the SAME set that drives the legacy
  // TypingRow, which the existing code already lifecycle-prunes correctly (drops
  // on terminal). We do NOT build our own active-set from the replayed step
  // stream (that surfaced completed historical runs as zombie cards). For each
  // active taskId we resolve the assignee ONCE via `GET /tasks/:taskId` (cheap,
  // cached); the <AgentMessageContainer> resolves taskId→taskRunId + timeline
  // itself, so we pass dispatchId=taskId and render immediately (generic agent
  // until the assignee resolves, then it snaps in).
  const [taskAgentById, setTaskAgentById] = useState<Map<string, string | null>>(() => new Map());
  const resolvingTaskAgentRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!unifiedAgentMsg) return;
    const liveTaskIds = new Set(typingRows.map((t) => t.taskId));

    // Prune caches for tasks that finished (no longer executing). Pruning the
    // ref also lets a re-dispatched taskId resolve again. setState returns the
    // same map when nothing is stale, so this never triggers a cascade render.
    for (const id of [...resolvingTaskAgentRef.current]) {
      if (!liveTaskIds.has(id)) resolvingTaskAgentRef.current.delete(id);
    }
    setTaskAgentById((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const id of [...prev.keys()]) {
        if (!liveTaskIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Resolve the assignee once per active task (deduped). GET /tasks/:id →
    // { runs: [{ id, taskId, assigneeId, ... }] }; identity is the latest run's
    // assigneeId (tasks.ts §in-flight shape).
    for (const t of typingRows) {
      const taskId = t.taskId;
      if (resolvingTaskAgentRef.current.has(taskId)) continue;
      resolvingTaskAgentRef.current.add(taskId);
      // running mount 的 taskId 在 chat 路径上是 IMTaskRun.id(同 timeline 用的 id)。
      // 用 RUN 端点 `GET /tasks/runs/:runId`(返回 run.assigneeId);之前误用 detail
      // 端点 `/tasks/:id`(只认 task id)→ 对 runId 一律 404,既造 404 风暴又解不到
      // assignee → running 头像永远是通用 "Agent"。
      void imFetch<{ run?: { assigneeId?: string | null } }>(`/tasks/runs/${encodeURIComponent(taskId)}`)
        .then((res) => {
          if (!res.ok) {
            // Transient failure → drop the dedup marker so a later render retries
            // instead of caching a permanent generic agent.
            resolvingTaskAgentRef.current.delete(taskId);
            return;
          }
          const assigneeId = res.data?.run?.assigneeId ?? null;
          setTaskAgentById((prev) => {
            const next = new Map(prev);
            next.set(taskId, assigneeId);
            return next;
          });
        })
        .catch(() => {
          resolvingTaskAgentRef.current.delete(taskId); // allow retry
        });
    }
  }, [unifiedAgentMsg, typingRows]);

  // Stable placeholder AdapterMessageInput per running task (avoid model churn).
  const runningPlaceholderMsgs = useMemo(() => {
    const m = new Map<string, { id: string; content: string }>();
    for (const t of typingRows) m.set(t.taskId, { id: `pending:${t.taskId}`, content: '' });
    return m;
  }, [typingRows]);

  // v2.0.8 P1 → 2026-05-29 update (doc 14 §4.4.3-4.4.4) — `agentReplyId →
  // dispatch summary` reverse index. The InlineActivityStrip used to mount
  // under the user's trigger message (wrong per doc 14 §4.4.4 "紧贴 Task
  // DigestCard 下方，与该 task 同一视觉单元" — Task DigestCard sits on the
  // AGENT side). Re-keyed by the agent reply's own message id and the
  // Strip now mounts immediately ABOVE the agent reply bubble so it reads
  // as that reply's lifecycle signature.
  // release201/30 §8 (Phase 1 landed 2026-05-31) — cloud lie-detector is
  // now warn-only telemetry; `systemFlags.lie_intercepted` is no longer
  // written. The map state collapses to just `'done'` here. We keep the
  // `originalOutput` field hard-null so InlineActivityStrip's ActionRow
  // never shows the "view logs" affordance (the rose-banner state was
  // dead UI after Phase 1 — Phase 2 deletes both the state and the
  // banner in inline-activity-strip below).
  const dispatchStripMap = useMemo(() => {
    const map = new Map<
      string,
      {
        dispatchId: string;
        agentImUserId: string;
        state: 'done';
        originalOutput: null;
        durationMs: number | null;
        fileCount: number;
      }
    >();
    // Build (id → message) lookup so we can compute dispatch duration as
    // (reply.createdAt − trigger.createdAt). One pass over messages is
    // enough — chat panels render at most ~60 messages.
    const messageById = new Map<string, MessageDTO>();
    // 2026-05-29 — also bucket `type='file'` messages by the trigger
    // they were posted in response to. `cloud file send` (invoked by an
    // agent inside the sandbox) creates a real file-typed message via
    // POST /api/im/messages but it's authenticated with the user's
    // PRISMER_API_KEY, so senderId comes back as the user, not the
    // agent. That makes the file appear on the user side of the bubble
    // column, and disconnects it from the agent reply's
    // `metadata.attachments` array — strip then reads `attachments=[]`
    // and shows "0 个文件" while a real PDF is sitting two rows above.
    //
    // We attribute these file-typed messages to the most recent agent
    // reply that points back to the same user trigger via
    // `metadata.triggerMessageId`. Heuristic: file message createdAt
    // falls inside [trigger.createdAt, trigger.createdAt + 10min] and
    // the file message's content/filename was emitted close enough in
    // time to the agent reply. We use a simple time-window match keyed
    // on triggerMessageId so the same file isn't double-counted across
    // dispatches.
    const fileByTrigger = new Map<string, number>();
    for (const m of messages) messageById.set(m.id, m);
    for (const m of messages) {
      if (m.type !== 'file') continue;
      // Find the closest agent reply for this conversation whose trigger
      // user message is within 10 minutes before this file message.
      // Iterate replies once; the inner-loop count is bounded by the
      // visible message window.
      let bestTrigger: string | null = null;
      let bestDeltaMs = Number.POSITIVE_INFINITY;
      for (const reply of messages) {
        const replyMeta = normalizeMetadata(reply.metadata);
        if (replyMeta.kind !== 'agent_reply') continue;
        const triggerMessageId = typeof replyMeta.triggerMessageId === 'string' ? replyMeta.triggerMessageId : null;
        if (!triggerMessageId) continue;
        const trigger = messageById.get(triggerMessageId);
        if (!trigger) continue;
        const triggerTs = Date.parse(trigger.createdAt);
        const fileTs = Date.parse(m.createdAt);
        if (!Number.isFinite(triggerTs) || !Number.isFinite(fileTs)) continue;
        const delta = fileTs - triggerTs;
        if (delta < 0 || delta > 10 * 60 * 1000) continue;
        if (delta < bestDeltaMs) {
          bestDeltaMs = delta;
          bestTrigger = triggerMessageId;
        }
      }
      if (bestTrigger) {
        fileByTrigger.set(bestTrigger, (fileByTrigger.get(bestTrigger) ?? 0) + 1);
      }
    }

    for (const reply of messages) {
      const meta = normalizeMetadata(reply.metadata);
      if (meta.kind !== 'agent_reply') continue;
      const triggerMessageId = typeof meta.triggerMessageId === 'string' ? meta.triggerMessageId : null;
      const dispatchId = typeof meta.taskId === 'string' ? meta.taskId : null;
      if (!dispatchId) continue;
      const attachments = Array.isArray(meta.attachments) ? meta.attachments : [];
      const trigger = triggerMessageId ? messageById.get(triggerMessageId) : null;
      const durationMs =
        trigger != null ? Math.max(0, Date.parse(reply.createdAt) - Date.parse(trigger.createdAt)) : null;
      // Real attachments on the reply itself + ambient file messages
      // attributed to the same trigger. The latter catches the
      // `cloud file send` case where the file rides as a sibling user
      // message instead of an attachment on the reply.
      const ambientFiles = triggerMessageId ? (fileByTrigger.get(triggerMessageId) ?? 0) : 0;
      map.set(reply.id, {
        dispatchId,
        agentImUserId: reply.senderId,
        state: 'done',
        originalOutput: null,
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        fileCount: attachments.length + ambientFiles,
      });
    }
    return map;
  }, [messages]);

  // P1 (Debug Pipeline 2026-05-24) — DeliveryTimelineChip data feed.
  // Builds a per-message-id lifecycle row for the current user's
  // self-sent messages so the bubble can show "Working 8s · tool_use"
  // instead of the static "Sent" label. Computed inside ImChannel
  // (rather than page.tsx, as the original P1 brief sketched) because
  // page-level state has no access to the message stream — messages
  // live inside `useReconciledStream` here.
  //
  // Re-tick every 10s so elapsed-time strings age naturally even when
  // no SSE event lands (matches the page-level statusTick cadence).
  const [deliveryTick, setDeliveryTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDeliveryTick((tick) => tick + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  const messageDeliveryStates = useMemo(() => {
    const map = new Map<string, MessageDeliveryState>();
    if (!linkedTasks || linkedTasks.length === 0) return map;
    const ownerId = currentUserId;
    const now = Date.now();
    for (const message of messages) {
      // Only humans-as-self get the lifecycle chip. Agent replies and
      // other-user messages keep their existing presentation.
      const isOwn = message.senderId === 'me' || (!!ownerId && message.senderId === ownerId);
      if (!isOwn) continue;
      const state = deriveMessageDeliveryState({
        message: { id: message.id, createdAt: message.createdAt },
        tasks: linkedTasks,
        taskPhases: taskPhaseMap,
        now,
      });
      if (state) map.set(message.id, state);
    }
    return map;
    // deliveryTick intentional — drives the recompute. ESLint warns but
    // the tick value is unused inside the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, linkedTasks, taskPhaseMap, currentUserId, deliveryTick]);

  const slashFilter = useMemo(() => {
    const trimmedLeft = draft.replace(/^\s+/, '');
    if (!trimmedLeft.startsWith('/')) return null;
    const token = trimmedLeft.slice(1).split(/\s/)[0] ?? '';
    if (token.length > 24) return null;
    return token;
  }, [draft]);

  const slashMatches = useMemo(() => {
    if (slashFilter === null) return [];
    return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(slashFilter.toLowerCase()));
  }, [slashFilter]);

  const headerLabel = useMemo(() => {
    if (!conversation) return '';
    return (
      conversation.displayTitle?.trim() ||
      conversation.title?.trim() ||
      (conversation.type === 'direct' ? 'Direct session' : 'Untitled session')
    );
  }, [conversation]);

  const updateMentionState = useCallback((value: string, caret: number) => {
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        setAssetFilter(null);
        assetRangeRef.current = null;
        const prev = value[i - 1];
        if (i === 0 || prev === ' ' || prev === '\n' || prev === '\t') {
          const token = value.slice(i + 1, caret);
          if (/^[a-zA-Z0-9_-]*$/.test(token)) {
            setMentionFilter(token);
            mentionRangeRef.current = { start: i, end: caret };
            return;
          }
        }
        break;
      }
      if (ch === '#') {
        setMentionFilter(null);
        mentionRangeRef.current = null;
        const prev = value[i - 1];
        if (i === 0 || prev === ' ' || prev === '\n' || prev === '\t') {
          const token = value.slice(i + 1, caret);
          // Filenames allow dots, dashes, underscores, spaces
          if (/^[a-zA-Z0-9._\-\s]+$/.test(token)) {
            setAssetFilter(token);
            assetRangeRef.current = { start: i, end: caret };
            return;
          }
        }
        break;
      }
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      i--;
    }
    setMentionFilter(null);
    setAssetFilter(null);
    mentionRangeRef.current = null;
    assetRangeRef.current = null;
  }, []);

  const onDraftChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setDraft(value);
      updateMentionState(value, e.target.selectionStart ?? value.length);
    },
    [updateMentionState],
  );

  const commitPastedTextEdit = useCallback(() => {
    if (!editingPasteId) return;
    const next = editingPasteDraft.trim();
    if (!next) {
      setPastedTextBlocks((prev) => prev.filter((block) => block.id !== editingPasteId));
    } else {
      setPastedTextBlocks((prev) =>
        prev.map((block) => (block.id === editingPasteId ? { ...block, text: editingPasteDraft } : block)),
      );
    }
    setEditingPasteId(null);
    setEditingPasteDraft('');
  }, [editingPasteDraft, editingPasteId]);

  const openPastedTextEditor = useCallback((block: PastedTextBlock) => {
    setEditingPasteId(block.id);
    setEditingPasteDraft(block.text);
  }, []);

  const removePastedTextBlock = useCallback(
    (id: string) => {
      setPastedTextBlocks((prev) => prev.filter((block) => block.id !== id));
      if (editingPasteId === id) {
        setEditingPasteId(null);
        setEditingPasteDraft('');
      }
    },
    [editingPasteId],
  );

  const focusComposer = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }, []);

  const focusComposerAtEnd = useCallback(
    (next: string) => {
      focusComposer(next.length);
    },
    [focusComposer],
  );

  const insertDraftTextAtCaret = useCallback(
    (snippet: string, options: { closePanel?: boolean; openMention?: boolean } = {}) => {
      const textarea = textareaRef.current;
      setDraft((prev) => {
        const start = textarea?.selectionStart ?? prev.length;
        const end = textarea?.selectionEnd ?? start;
        const before = prev.slice(0, start);
        const after = prev.slice(end);
        const needsSpaceBefore = Boolean(before && !/\s$/.test(before) && snippet !== '\n');
        const insert = `${needsSpaceBefore ? ' ' : ''}${snippet}`;
        const next = `${before}${insert}${after}`;
        const caret = before.length + insert.length;
        if (options.openMention && snippet.includes('@')) {
          const atOffset = insert.lastIndexOf('@');
          const atIndex = before.length + (atOffset >= 0 ? atOffset : insert.length - 1);
          mentionRangeRef.current = { start: atIndex, end: caret };
          setMentionFilter('');
        } else {
          updateMentionState(next, caret);
        }
        focusComposer(caret);
        return next;
      });
      if (options.closePanel !== false) setComposerPanel(null);
    },
    [focusComposer, updateMentionState],
  );

  const onSelectMention = useCallback(
    (member: GroupMember) => {
      const range = mentionRangeRef.current;
      if (!range) return;
      setDraft((prev) => {
        const before = prev.slice(0, range.start);
        const after = prev.slice(range.end);
        const insert = `@${member.username} `;
        const next = `${before}${insert}${after}`;
        focusComposer(before.length + insert.length);
        return next;
      });
      setMentionFilter(null);
      mentionRangeRef.current = null;
    },
    [focusComposer],
  );

  const onSelectAsset = useCallback(
    (item: { id: string; filename: string | null }) => {
      const range = assetRangeRef.current;
      if (!range) return;
      const name = item.filename || 'untitled';
      setDraft((prev) => {
        const before = prev.slice(0, range.start);
        const after = prev.slice(range.end);
        const insert = `#${name} `;
        const next = `${before}${insert}${after}`;
        focusComposer(before.length + insert.length);
        return next;
      });
      setAssetFilter(null);
      assetRangeRef.current = null;
    },
    [focusComposer],
  );

  const insertSlashCommand = useCallback(
    (template: string) => {
      setDraft(template);
      setMentionFilter(null);
      setComposerPanel(null);
      focusComposerAtEnd(template);
    },
    [focusComposerAtEnd],
  );

  const shareLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      notify('Location sharing is unavailable in this browser.', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude.toFixed(5);
        const lon = position.coords.longitude.toFixed(5);
        insertDraftTextAtCaret(`[Location: ${lat}, ${lon}]`);
      },
      (err) => notify(`Location failed: ${err.message}`, 'error'),
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }, [insertDraftTextAtCaret, notify]);

  // §4.1 — 5 second watchdog. If the SSE echo (matched by idempotencyKey)
  // hasn't arrived in time, mark the optimistic row as failed so the user
  // sees a red badge instead of a permanent "sending..." spinner. Cleared
  // by the SSE `message.new` handler above when the echo lands.
  const arm5sTimeout = useCallback(
    (idempotencyKey: string, optimisticId: string, content: string) => {
      const existing = pendingSendTimers.current.get(idempotencyKey);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pendingSendTimers.current.delete(idempotencyKey);
        // Only mark failed if the optimistic row is still in flight. The
        // happy-path SSE handler already cleared this timer; if we reach
        // here we lost the race → surface to the user.
        stream.patchLocal(optimisticId, {
          pending: false,
          failed: true,
        } as Partial<MessageDTO>);
        notify('Send did not confirm in 5s — server may have lost the message', 'error');
        // Keep the typed content so the user can re-send. We do NOT delete
        // the optimistic row because the red "failed" badge IS the surfaced
        // signal — deleting would make the failure invisible.
        void content; // (reference for future i18n / replay button)
      }, 5_000);
      pendingSendTimers.current.set(idempotencyKey, timer);
    },
    [notify, stream],
  );

  // Cleanup any pending watchdog timers on unmount / conv switch.
  useEffect(() => {
    const timers = pendingSendTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      optimisticByIdemKey.current.clear();
    };
  }, [conversationIdForStream]);

  const sendAssetAttachment = useCallback(
    async (payload: DroppedAssetPayload) => {
      if (!conversation || sending || readOnlyObserver) return;
      const known = assetById.get(payload.id);
      const file = fileByAssetId.get(payload.id);
      const title = file?.path || payload.title || known?.contentHash?.slice(0, 16) || payload.id;
      const mime = known?.mime ?? payload.mime ?? null;
      const kind = known?.kind ?? payload.kind;
      const sizeBytes = known?.sizeBytes ?? payload.sizeBytes ?? null;
      const contentHash = known?.contentHash ?? payload.contentHash;
      const intent = assetIntentFromMetadata(known?.metadata);
      const content = `Attached asset: ${title}`;
      const attachment: MessageAttachmentDTO = {
        kind: attachmentKindFromMime(kind, mime),
        assetId: payload.id,
        title,
        filename: title,
        mime,
        sizeBytes,
        contentHash,
        thumbnailUrl: known?.thumbnailUrl ?? null,
        previewUrls: normalizeMessagePreviewUrls(known?.previewUrls),
        revision: known?.revision ?? null,
        role: 'attachment',
      };
      const metadata = {
        kind: 'workspace_asset_attachment',
        // `assetIds` is the dispatcher contract (wave-8 W1, see
        // src/im/services/message.service.ts extractAttachedAssetIds):
        // backend reads it as string[] and aggregates IDs into the
        // task.metadata.assets.aggregatedAssetIds the daemon hydrates
        // into payload.assetRefs. Without this the agent never sees
        // the user's drag-attached asset.
        assetIds: [payload.id],
        // `asset` is the FE-render shape (see MessageAssetAttachment
        // parser later in this file). Kept alongside assetIds for the
        // chat bubble's thumbnail lookup.
        asset: {
          id: payload.id,
          assetId: payload.id,
          title,
          kind,
          mime,
          sizeBytes,
          contentHash,
          intent,
        },
      };
      // §4.1 — idempotencyKey is the optimistic row's id AND the X-Idempotency-Key
      // header. The SSE echo carries the same key, letting us locate + replace
      // the row by key rather than by the old `tmp-{Date.now()}` dance.
      const idempotencyKey =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const optimistic: MessageDTO = {
        id: idempotencyKey,
        conversationId: conversation.id,
        senderId: 'me',
        content,
        type: 'markdown',
        contentType: 'markdown',
        metadata,
        attachments: [attachment],
        createdAt: new Date().toISOString(),
        pending: true,
        idempotencyKey,
        boundarySeq: null,
      };
      stream.markLocal(optimistic);
      optimisticByIdemKey.current.set(idempotencyKey, idempotencyKey);
      arm5sTimeout(idempotencyKey, idempotencyKey, content);
      setSending(true);
      const res = await sendMessage({
        conversationId: conversation.id,
        content,
        type: 'markdown',
        metadata,
        attachments: [attachment],
        idempotencyKey,
      });
      setSending(false);
      if (!res.ok) {
        // Synchronous failure (network / 4xx): clear the watchdog and flip the
        // optimistic row to failed=true so the badge shows immediately. We
        // keep the row in place — the user can see what they tried to send.
        const t = pendingSendTimers.current.get(idempotencyKey);
        if (t) {
          clearTimeout(t);
          pendingSendTimers.current.delete(idempotencyKey);
        }
        stream.patchLocal(idempotencyKey, { pending: false, failed: true });
        notify(`Asset attach failed: ${res.message}`, 'error');
        return;
      }
      // POST response carries the persisted message id + boundarySeq. We
      // apply it via markLocal which advances the reconcile cursor
      // synchronously (no need to wait for the SSE echo). The SSE echo will
      // arrive shortly with the same id; the hook dedups by id.
      const persisted = res.data.message;
      // Remove the optimistic row (its id was the idempotencyKey, not the
      // server id). Then markLocal the persisted row.
      stream.removeLocal(idempotencyKey);
      optimisticByIdemKey.current.delete(idempotencyKey);
      stream.markLocal({
        ...persisted,
        pending: false,
        boundarySeq: persisted.boundarySeq ?? null,
      } as MessageDTO);
      const t = pendingSendTimers.current.get(idempotencyKey);
      if (t) {
        clearTimeout(t);
        pendingSendTimers.current.delete(idempotencyKey);
      }
      notify(`Attached ${title}.`, 'success');
    },
    [arm5sTimeout, assetById, conversation, fileByAssetId, notify, readOnlyObserver, sending, stream],
  );

  // Wave-3.5 W5 (14b §6.2 P4) — upload guardrails shared by paste / drop /
  // file-picker. 50 MB matches the docs/release200/14b §6.3 backlog threshold
  // (>50 MB / >1 GB are explicit non-goals for v2.0). Anything bigger is
  // rejected with a clear toast and the composer text is NOT cleared so the
  // user can keep typing while they pick a smaller file.
  const COMPOSER_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

  // Filter incoming files by size + dedupe (same source can come in via
  // `items` and `files` simultaneously on Chrome). Returns the accepted
  // subset and side-effects a toast for each rejected file so the user
  // sees per-file feedback (3 too-large + 2 OK → 2 upload + 2 toasts).
  const filterUploadCandidates = useCallback(
    (raw: File[], origin: 'paste' | 'drop' | 'picker'): File[] => {
      const seen = new Set<string>();
      const accepted: File[] = [];
      for (const file of raw) {
        if (!file || file.size <= 0) continue;
        const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (file.size > COMPOSER_UPLOAD_MAX_BYTES) {
          const sizeMb = (file.size / 1024 / 1024).toFixed(1);
          notify(`File too large (${sizeMb} MB; 50 MB max): ${file.name}. Smaller files still attach.`, 'error');
          continue;
        }
        accepted.push(file);
      }
      if (accepted.length === 0 && raw.length > 0 && origin !== 'paste') {
        // For drop / picker we already flagged the offenders above; just
        // bail silently so we don't double-toast. For paste we treat
        // "no usable files" as a no-op (textarea behaviour unchanged).
      }
      return accepted;
    },
    [COMPOSER_UPLOAD_MAX_BYTES, notify],
  );

  const dispatchComposerFiles = useCallback(
    (files: File[], origin: 'paste' | 'drop' | 'picker') => {
      if (files.length === 0) return;
      setComposerPanel(null);
      if (!onComposerPasteFiles) {
        notify('Attachments cannot be added in this conversation.', 'error');
        return;
      }
      stageComposerFiles(files);
      if (origin === 'paste') notify(`${files.length === 1 ? files[0].name : `${files.length} files`} staged.`, 'info');
    },
    [notify, onComposerPasteFiles, stageComposerFiles],
  );

  const onAssetDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // Wave-3.5 W5 — single drop entry point handles BOTH workspace asset
      // chips (`application/x-prismer-asset`) and OS file drops
      // (`dataTransfer.files`). We branch by inspecting the payload type
      // rather than wiring two listeners, because the browser fires only
      // one `drop` event per dataTransfer.
      const raw = event.dataTransfer.getData('application/x-prismer-asset');
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      const wasDragging = draggingAsset;
      if (!raw && droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingAsset(null);

      if (raw) {
        try {
          const parsed = JSON.parse(raw) as DroppedAssetPayload;
          if (!parsed.id) throw new Error('missing asset id');
          void sendAssetAttachment(parsed);
          return;
        } catch {
          notify('Could not attach that asset.', 'error');
          return;
        }
      }

      if (readOnlyObserver || sending) {
        if (wasDragging === 'file') notify('Cannot attach in a read-only session.', 'error');
        return;
      }
      const accepted = filterUploadCandidates(droppedFiles, 'drop');
      dispatchComposerFiles(accepted, 'drop');
    },
    [
      dispatchComposerFiles,
      draggingAsset,
      filterUploadCandidates,
      notify,
      readOnlyObserver,
      sendAssetAttachment,
      sending,
    ],
  );

  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (readOnlyObserver || sending) return;
      const byItem = Array.from(event.clipboardData.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const byFile = Array.from(event.clipboardData.files ?? []);
      const merged = [...byItem, ...byFile];
      if (merged.length === 0) {
        const pastedText = event.clipboardData.getData('text/plain');
        if (!stageMode || pastedText.trim().length < 120) return;
        event.preventDefault();
        const id =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setPastedTextBlocks((prev) => [...prev, { id, text: pastedText }]);
        setEditingPasteId(null);
        setEditingPasteDraft('');
        setComposerPanel(null);
        return;
      }

      event.preventDefault();
      const accepted = filterUploadCandidates(merged, 'paste');
      if (accepted.length === 0) return;
      dispatchComposerFiles(accepted, 'paste');
    },
    [dispatchComposerFiles, filterUploadCandidates, readOnlyObserver, sending, stageMode],
  );

  // Wave-3.5 W5 — multi-file picker change handler. Wired to a hidden
  // `<input type="file" multiple>` rendered just above the composer; the
  // AttachmentPanel "File"/"Photos" buttons click() into it when no parent
  // `onComposerUploadAsset` callback is provided. Real DOM input, real
  // browser file dialog, real upload — no mocks.
  const onComposerFilePicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (picked.length === 0) return;
      const accepted = filterUploadCandidates(picked, 'picker');
      dispatchComposerFiles(accepted, 'picker');
    },
    [dispatchComposerFiles, filterUploadCandidates],
  );

  const openComposerFilePicker = useCallback(() => {
    if (readOnlyObserver || sending) return;
    composerFileInputRef.current?.click();
  }, [readOnlyObserver, sending]);

  const onSend = useCallback(async () => {
    const pastedText = pastedTextBlocks.map((block) => block.text.trim()).filter(Boolean);
    const stagedFiles = composerFileBlocks.map((block) => block.file);
    const content = [draft.trim(), ...pastedText.map((text, index) => `Pasted context ${index + 1}:\n${text}`)]
      .filter(Boolean)
      .join('\n\n');
    if (!conversation || readOnlyObserver || sending || (!content && stagedFiles.length === 0)) return;
    if (stagedFiles.length > 0 && !onComposerPasteFiles) {
      notify('Attachments cannot be added in this conversation.', 'error');
      return;
    }

    // release201/07 §6.1 — slash command `/skill new [--from doc|code|service] [<intent>]`
    // intercepts the send pipeline and deep-links to Studio Authoring instead
    // of posting a chat message or spawning an ephemeral agent.
    const trimmedDraft = draft.trim();
    if (trimmedDraft.startsWith('/skill new')) {
      const rest = trimmedDraft.slice('/skill new'.length).trim();
      let from: string = 'inline-spec';
      let intent = rest;
      const fromMatch = rest.match(/--from\s+(\S+)/);
      if (fromMatch) {
        const raw = fromMatch[1];
        if (raw === 'doc') from = 'doc-url';
        else if (raw === 'code') from = 'code-source';
        else if (raw === 'service') from = 'service-endpoint';
        else if (raw === 'inline') from = 'inline-spec';
        else from = raw;
        intent = rest.replace(/--from\s+\S+\s*/, '').trim();
      }
      // release201/08 §3.0 / S21 — tag the current conversation with
      // skillDev.role='business' before handing off to Studio. The
      // authoring agent's dev session and downstream test/review sessions
      // will reference this conversation via parentConversationId. Fire and
      // forget: the redirect proceeds whether or not the tag write succeeds
      // (the API can backfill once createDraft returns).
      void fetch(`/api/im/conversations/${conversation.id}/skill-dev-role`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          role: 'business',
          skillDraftId: null,
        }),
      }).catch(() => {
        /* best-effort */
      });
      const params = new URLSearchParams();
      params.set('tab', 'studio');
      params.set('view', 'authoring');
      params.set('from', from);
      // 把 parent business conversation id 透传到 Studio,以便后续 createDraft
      // 时能在 metadata.authoring.parentConversationId 中回写,完成 4 角色
      // session 链路 (business→dev→test→review)。
      params.set('parentConversationId', conversation.id);
      if (intent) params.set('intent', intent);
      router.push(`/evolution?${params.toString()}`);
      setDraft('');
      notify(`Opening Studio Authoring (source: ${from})…`, 'info');
      return;
    }

    setDraft('');
    setPastedTextBlocks([]);
    clearComposerFileBlocks();
    setEditingPasteId(null);
    setEditingPasteDraft('');
    setSending(true);
    setMentionFilter(null);
    setComposerPanel(null);

    if (content) {
      // §4.1 — generate idempotencyKey up front; it is the optimistic row's id,
      // the X-Idempotency-Key header, AND the echo-match key for the SSE handler.
      const idempotencyKey =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const optimistic: MessageDTO = {
        id: idempotencyKey,
        conversationId: conversation.id,
        senderId: 'me',
        content,
        type: 'text',
        contentType: 'text',
        createdAt: new Date().toISOString(),
        pending: true,
        idempotencyKey,
        boundarySeq: null,
      };
      stream.markLocal(optimistic);
      optimisticByIdemKey.current.set(idempotencyKey, idempotencyKey);
      arm5sTimeout(idempotencyKey, idempotencyKey, content);
      const res = await sendMessage({ conversationId: conversation.id, content, idempotencyKey });
      if (!res.ok) {
        const t = pendingSendTimers.current.get(idempotencyKey);
        if (t) {
          clearTimeout(t);
          pendingSendTimers.current.delete(idempotencyKey);
        }
        stream.patchLocal(idempotencyKey, { pending: false, failed: true });
        setDraft(draft.trim());
        setPastedTextBlocks(pastedText.map((text, index) => ({ id: `${idempotencyKey}-paste-${index}`, text })));
        restoreComposerFileBlocks(stagedFiles);
        setSending(false);
        notify(`Send failed: ${res.message}`, 'error');
        return;
      }
      const persisted = res.data.message;
      stream.removeLocal(idempotencyKey);
      optimisticByIdemKey.current.delete(idempotencyKey);
      stream.markLocal({
        ...persisted,
        pending: false,
        boundarySeq: persisted.boundarySeq ?? null,
      } as MessageDTO);
      const t = pendingSendTimers.current.get(idempotencyKey);
      if (t) {
        clearTimeout(t);
        pendingSendTimers.current.delete(idempotencyKey);
      }
      if (res.data.routing?.mode === 'explicit' && res.data.routing.targets.length > 0) {
        notify(`Mentioned ${res.data.routing.targets.map((t) => t.username ?? t.userId.slice(-6)).join(', ')}`, 'info');
      }
    }

    if (stagedFiles.length > 0 && onComposerPasteFiles) {
      try {
        await onComposerPasteFiles(stagedFiles);
      } catch (err) {
        restoreComposerFileBlocks(stagedFiles);
        setSending(false);
        notify(`Attachment send failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
        return;
      }
    }

    setSending(false);
  }, [
    arm5sTimeout,
    clearComposerFileBlocks,
    composerFileBlocks,
    conversation,
    draft,
    notify,
    onComposerPasteFiles,
    pastedTextBlocks,
    readOnlyObserver,
    restoreComposerFileBlocks,
    router,
    sending,
    stream,
  ]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && (composerPanel !== null || mentionFilter !== null || assetFilter !== null)) {
        e.preventDefault();
        setComposerPanel(null);
        setMentionFilter(null);
        setAssetFilter(null);
        mentionRangeRef.current = null;
        assetRangeRef.current = null;
        return;
      }
      // Mention picker keyboard nav. Cmd/Ctrl+Enter intentionally falls
      // through to the send branch below so power users can force-send
      // even while the picker is open.
      if (mentionFilter !== null && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mentionPickerRef.current?.move(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mentionPickerRef.current?.move(-1);
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
          if (mentionPickerRef.current?.commit()) {
            e.preventDefault();
            return;
          }
        }
      }
      // Asset picker keyboard nav — same pattern as mention picker.
      if (assetFilter !== null && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          assetPickerRef.current?.move(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          assetPickerRef.current?.move(-1);
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
          if (assetPickerRef.current?.commit()) {
            e.preventDefault();
            return;
          }
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void onSend();
      }
    },
    [composerPanel, mentionFilter, assetFilter, onSend],
  );

  const onKick = useCallback(
    async (member: GroupMember) => {
      if (!conversation) return;
      if (member.role === 'owner') {
        notify(t('workspace.session.cannotKickOwner'), 'error');
        return;
      }
      const ok = window.confirm(t('workspace.session.removeMemberConfirm', { username: member.username }));
      if (!ok) return;
      const res = await kickGroupMember(conversation.id, member.userId);
      if (!res.ok) {
        notify(t('workspace.session.kickMemberFailed', { message: res.message }), 'error');
        return;
      }
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      notify(t('workspace.session.memberRemoved', { username: member.username }), 'success');
    },
    [conversation, notify, t],
  );

  const jumpToSearchResult = useCallback(
    (result: MessageSearchResult) => {
      // §4.1: route search-result jumps through the reconcile hook so the
      // jumped-to row participates in dedup + ordering with the rest of the
      // timeline. markLocal does not advance the cursor for historical rows.
      stream.markLocal({ ...result, boundarySeq: result.boundarySeq ?? null });
      setHighlightedMessageId(result.id);
      window.setTimeout(() => {
        messageRefs.current.get(result.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 80);
      window.setTimeout(() => {
        setHighlightedMessageId((current) => (current === result.id ? null : current));
      }, 4000);
    },
    [stream],
  );

  // WS1 — live authoritative deliverable resolver for the completed
  // TaskDigestCard. Targeted per-task fetch (NOT a filter over the
  // workspace-level 100-cap `/assets` list — that坑 is documented in
  // task-detail-drawer.tsx 2026-05-23: agent-output rows get pushed past the
  // cutoff). Maps AssetDTO → the card's lightweight ref shape. The card itself
  // gates the call to completed + resultAssetCount > 0 and fires it once per
  // mount (no polling).
  const resolveTaskDigestAssets = useCallback(
    async (taskId: string): Promise<{ assetId: string; filename?: string | null; mime?: string | null }[]> => {
      if (!workspaceId) return [];
      const res = await imFetch<AssetDTO[]>(
        `/assets?workspaceId=${encodeURIComponent(workspaceId)}&taskId=${encodeURIComponent(taskId)}&limit=50`,
      );
      if (!res.ok || !Array.isArray(res.data)) return [];
      return res.data.map((a) => ({ assetId: a.id, filename: a.filename, mime: a.mime }));
    },
    [workspaceId],
  );

  return (
    <section
      data-testid="im-channel-panel"
      data-launch-tour-anchor="chat-panel"
      data-stage-mode={stageMode ? 'true' : undefined}
      className={`flex-1 flex flex-col min-w-0 relative overflow-hidden ${searchOpen ? 'z-30' : 'z-0'} ${surface.pane[theme]}`}
      onDragEnter={(event) => {
        // Wave-3.5 W5 (14b §6.2 P4) — detect BOTH workspace asset chips and
        // OS file drops. `Files` is the standardised DataTransfer type set
        // by Finder/Explorer/file managers when the user drags real files.
        if (event.dataTransfer.types.includes('application/x-prismer-asset')) setDraggingAsset('asset');
        else if (event.dataTransfer.types.includes('Files')) setDraggingAsset('file');
      }}
      onDragOver={(event) => {
        // Browsers REQUIRE preventDefault in dragover for the drop event to
        // fire — without this the drop is silently ignored. We accept both
        // workspace chips and OS files.
        if (
          event.dataTransfer.types.includes('application/x-prismer-asset') ||
          event.dataTransfer.types.includes('Files')
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAsset(null);
      }}
      onDrop={onAssetDrop}
    >
      <AnimatePresence>
        {draggingAsset ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={springSoft}
            data-testid={`composer-drop-overlay-${draggingAsset}`}
            className={`pointer-events-none absolute inset-3 z-30 flex items-center justify-center border-2 border-dashed ${radius.pane} ${
              isDark
                ? 'border-violet-300/50 bg-violet-500/10 text-violet-100'
                : 'border-violet-300 bg-violet-50/80 text-violet-900'
            }`}
          >
            <div className="flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold backdrop-blur-xl">
              {draggingAsset === 'asset' ? <Archive className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
              {draggingAsset === 'asset' ? t('workspace.session.dropAsset') : t('workspace.session.dropFileToAttach')}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <header
        className={`flex min-h-[64px] items-center gap-2 border-b px-3 py-2.5 backdrop-blur-2xl ${
          isDark ? 'border-white/[0.06] bg-zinc-950/35 text-zinc-200' : 'border-zinc-200/80 bg-white/55 text-zinc-800'
        }`}
      >
        {onMobileBack ? (
          <button
            type="button"
            onClick={onMobileBack}
            data-testid="im-channel-back"
            title={t('workspace.session.backToSessions')}
            aria-label={t('workspace.session.backToSessions')}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
              isDark
                ? 'text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            data-testid="im-panel-collapse"
            title={t('workspace.session.collapseChatPanel')}
            aria-label={t('workspace.session.collapseChatPanel')}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
              isDark
                ? 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : null}
        <div
          className={`w-10 h-10 rounded-2xl flex items-center justify-center border shadow-[0_16px_50px_-28px_rgba(124,58,237,0.85)] ${
            isDark
              ? 'border-violet-300/15 bg-violet-500/15 text-violet-200'
              : 'border-violet-100 bg-violet-50 text-violet-700'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold truncate">
            {conversation ? headerLabel : t('workspace.session.noSessionSelected')}
            {conversation?.pinned ? (
              <span
                data-testid="channel-pinned-indicator"
                title={t('workspace.session.pinned')}
                aria-label={t('workspace.session.pinned')}
                className="ml-1.5 inline-flex align-middle"
              >
                <Pin className="h-3.5 w-3.5 text-violet-400" strokeWidth={1.5} fill="currentColor" />
              </span>
            ) : null}
            {conversation?.muted ? (
              <span
                data-testid="channel-muted-indicator"
                title={t('workspace.session.muted')}
                aria-label={t('workspace.session.muted')}
                className="ml-1 inline-flex align-middle"
              >
                <BellOff className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.5} />
              </span>
            ) : null}
          </h2>
          <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {conversation
              ? members.length > 0
                ? t('workspace.session.membersCount', { count: members.length })
                : compact
                  ? t('workspace.session.sessionChat')
                  : t('workspace.session.workspace')
              : t('workspace.session.openSessionPrompt')}
          </p>
        </div>
        {members.length > 0 ? (
          <button
            ref={membersToggleRef}
            type="button"
            onClick={() => setShowMembers((v) => !v)}
            data-testid="channel-members-toggle"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${radius.button} text-xs border transition-colors ${
              showMembers
                ? isDark
                  ? 'bg-violet-500/20 border-violet-400/30 text-violet-200'
                  : 'bg-violet-50 border-violet-200 text-violet-700'
                : isDark
                  ? 'border-white/[0.06] text-zinc-400 hover:bg-white/[0.04]'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            {members.length}
          </button>
        ) : null}
        {headerActions}
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          data-testid="session-search-toggle"
          title={t('workspace.session.searchSession')}
          aria-label={t('workspace.session.searchSession')}
          className={`inline-flex h-8 w-8 items-center justify-center ${radius.button} border transition-colors ${
            searchOpen
              ? isDark
                ? 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200'
                : 'border-cyan-200 bg-cyan-50 text-cyan-700'
              : isDark
                ? 'border-white/[0.06] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
          }`}
        >
          <Search className="w-3.5 h-3.5" />
        </button>
      </header>

      {!stageMode ? (
        <div
          className={`flex h-9 shrink-0 items-end border-b px-3 ${
            isDark ? 'border-white/[0.05] bg-zinc-950/24' : 'border-zinc-200/70 bg-white/42'
          }`}
          data-testid="channel-tabs"
        >
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`relative h-full px-4 text-xs font-semibold ${
              activeTab === 'chat'
                ? isDark
                  ? 'text-zinc-100'
                  : 'text-zinc-900'
                : isDark
                  ? 'text-zinc-500 hover:text-zinc-300'
                  : 'text-zinc-500 hover:text-zinc-700'
            }`}
            aria-pressed={activeTab === 'chat'}
          >
            {t('workspace.session.chat')}
            {activeTab === 'chat' ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-violet-500" />
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('details')}
            className={`relative h-full px-4 text-xs font-semibold ${
              activeTab === 'details'
                ? isDark
                  ? 'text-zinc-100'
                  : 'text-zinc-900'
                : isDark
                  ? 'text-zinc-500 hover:text-zinc-300'
                  : 'text-zinc-500 hover:text-zinc-700'
            }`}
            aria-pressed={activeTab === 'details'}
          >
            {t('workspace.session.details')}
            {activeTab === 'details' ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-violet-500" />
            ) : null}
          </button>
        </div>
      ) : conversation ? (
        <AgentStateStrip
          isDark={isDark}
          agents={linkedAgents}
          agentStatuses={agentStatuses}
          onOpenAgent={onOpenAgent}
        />
      ) : null}

      {/*
        Wave-8 W10: linked-context strip.
        Sits directly under the header. Renders three sub-groups
        (tasks · agents · assets) when their slices are non-empty;
        when all three are empty AND we have a real conversation we
        show a faint "no linked context yet" hint. Hidden entirely
        when there's no conversation (the empty-channel surface
        already explains itself).

        Mobile: the strip stays on a single row but uses
        `overflow-x-auto` + `truncate` on long titles, so a cramped
        viewport gets a horizontal scroll instead of wrap-stacking.
      */}
      {conversation && (!stageMode || linkedTasks.length > 0 || recentAssets.length > 0) ? (
        <LinkedContextRow
          isDark={isDark}
          tasks={linkedTasks}
          // In stage mode agent state has a dedicated strip above the
          // timeline, so this row only carries task / artifact context.
          // In direct sessions the peer agent is already named in the header.
          agents={stageMode || conversationType === 'direct' ? [] : linkedAgents}
          agentStatuses={agentStatuses}
          assets={recentAssets}
          onOpenTask={onOpenTask}
          onOpenAgent={onOpenAgent}
          onOpenAsset={onOpenAsset}
        />
      ) : null}

      <AnimatePresence>
        {searchOpen ? (
          <SessionSearchPanel
            isDark={isDark}
            query={searchQuery}
            results={searchResults}
            searching={searching}
            error={searchError}
            senderLabelFor={(message) =>
              memberById.get(message.senderId)?.displayName ||
              memberById.get(message.senderId)?.username ||
              (message.senderId === 'me' || (!!currentUserId && message.senderId === currentUserId)
                ? t('workspace.session.you')
                : message.senderId.slice(-10))
            }
            onQueryChange={setSearchQuery}
            onClose={() => setSearchOpen(false)}
            onSelect={jumpToSearchResult}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showMembers ? (
          <motion.div
            ref={membersPanelRef}
            data-testid="channel-members-panel"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={springSoft}
            className={`absolute right-3 top-14 z-20 w-72 max-h-80 overflow-y-auto border ${radius.card} ${surface.modal[theme]}`}
          >
            {onAddMember && conversation?.type !== 'direct' ? (
              <div className="border-b border-current/10 px-3 py-2">
                <button
                  type="button"
                  data-testid="channel-members-add"
                  onClick={onAddMember}
                  className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                    isDark
                      ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/20'
                      : 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                  }`}
                >
                  + {t('workspace.session.addMember')}
                </button>
              </div>
            ) : null}
            <ul className="py-1">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className={`flex items-center gap-2 px-3 py-2 text-sm border-b last:border-b-0 ${
                    isDark ? 'border-white/[0.05] text-zinc-200' : 'border-zinc-100 text-zinc-800'
                  }`}
                >
                  {agentTypeByImUserId?.[member.userId] ? (
                    <AgentAvatar
                      agent={{
                        agentId: member.userId,
                        userId: member.userId,
                        name: member.displayName || member.username,
                        username: member.username,
                        agentType: agentTypeByImUserId[member.userId],
                      }}
                      avatarUrl={member.avatarUrl}
                      status={agentStatuses?.get(member.userId) ?? null}
                      size="sm"
                      isDark={isDark}
                    />
                  ) : (
                    <Avatar
                      seed={member.userId}
                      label={member.displayName || member.username}
                      isAgent={false}
                      avatarUrl={member.avatarUrl}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold truncate">{member.displayName || member.username}</p>
                    <p className={`text-[11px] truncate ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      @{member.username} · {member.role}
                    </p>
                  </div>
                  {member.role !== 'owner' ? (
                    <button
                      type="button"
                      onClick={() => onKick(member)}
                      data-testid={`member-kick-${member.username}`}
                      title={t('workspace.session.removeFromSession')}
                      className={`p-1.5 ${radius.small} ${isDark ? 'text-rose-300 hover:bg-rose-500/10' : 'text-rose-600 hover:bg-rose-50'}`}
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll-container"
        // 2026-05-29 (Q6) — stage scroll surface tuning:
        //   1. `px-3` (was `px-4`) shaves 8px of horizontal whitespace so
        //      bubbles use more of the workspace width on wide monitors;
        //      matches the footer composer's own px-3 vocabulary.
        //   2. `pb-48` (was `pb-36`) reserves enough room so the floating
        //      footer (`absolute bottom-0` in stageMode) never crops the
        //      bottom-most TypingRow strip when ApprovalCard / TaskReviewBar
        //      are also visible above the textarea. 192px covers
        //      pt-10+pb-4 (56px) + textarea + bars buffer.
        className={`relative flex-1 overflow-y-auto overflow-x-hidden ${stageMode ? 'px-3 pt-4' : 'px-3 py-4'} ${
          isDark
            ? 'bg-[radial-gradient(circle_at_40%_0%,rgba(139,92,246,0.08),transparent_32%),radial-gradient(circle_at_100%_55%,rgba(34,211,238,0.06),transparent_36%)]'
            : 'bg-[radial-gradient(circle_at_30%_0%,rgba(139,92,246,0.07),transparent_34%),radial-gradient(circle_at_100%_60%,rgba(34,211,238,0.07),transparent_36%)]'
        }`}
        // stageMode：浮动 composer 的实际高度 + 24px 余量，最后一条消息永远能滚过它。
        style={stageMode ? { paddingBottom: composerH + 24 } : undefined}
      >
        {visibleActiveTab === 'chat' && !loading && !error && conversation && messages.length > 0 ? (
          <div
            className={`flex items-center justify-center pb-2 text-[11px] ${
              isDark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
            data-testid="message-load-older-status"
          >
            {loadingOlder ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('workspace.session.loadingOlderMessages')}
              </span>
            ) : reachedTop ? (
              <span>
                {totalCount > 0
                  ? t('workspace.session.allMessagesLoaded', { count: totalCount })
                  : t('workspace.session.beginningOfConversation')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void loadOlder()}
                className={`underline-offset-2 hover:underline ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                {totalCount > 0
                  ? t('workspace.session.loadOlderMessagesWithCount', { loaded: messages.length, total: totalCount })
                  : t('workspace.session.loadOlderMessages')}
              </button>
            )}
          </div>
        ) : null}
        {visibleActiveTab === 'details' ? (
          <SessionDetailsPanel
            isDark={isDark}
            conversation={conversation}
            members={members}
            linkedTasks={linkedTasks}
            recentAssets={recentAssets}
            onSearch={() => {
              setActiveTab('chat');
              setSearchOpen(true);
            }}
            onOpenAssets={onOpenAssets}
            onToggleMembers={() => setShowMembers(true)}
          />
        ) : loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
          </div>
        ) : error ? (
          <div
            className={`text-xs px-3 py-2 border ${radius.button} ${isDark ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-rose-50 border-rose-200 text-rose-700'}`}
          >
            {t('workspace.session.failedToLoadMessages', { message: error })}
          </div>
        ) : !conversation ? (
          <section className="flex h-full flex-col items-center justify-center text-center">
            <div
              className={`w-14 h-14 ${radius.pane} flex items-center justify-center border ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.04] text-violet-200'
                  : 'border-zinc-200 bg-white text-violet-700'
              }`}
            >
              <MessageSquare className="w-6 h-6" />
            </div>
            <p className={`mt-4 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {t('workspace.session.noSessionSelected')}
            </p>
            <p className={`mt-1 max-w-[260px] text-xs leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {t('workspace.session.emptyHint')}
            </p>
            {onNewChannel ? (
              <motion.button
                type="button"
                onClick={onNewChannel}
                whileTap={{ scale: 0.96 }}
                transition={springSnap}
                className={`mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white ${radius.button} bg-gradient-to-br from-violet-500 to-cyan-500`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                {t('workspace.chats.newSession')}
              </motion.button>
            ) : null}
          </section>
        ) : messages.length === 0 ? (
          <SessionEmpty
            isDark={isDark}
            members={members}
            conversationType={conversationType === 'direct' || conversationType === 'group' ? conversationType : null}
            onFocus={() => textareaRef.current?.focus()}
            onInsertSlash={(prefix) => {
              const ta = textareaRef.current;
              if (!ta) return;
              ta.focus();
              setDraft((prev) => (prev.startsWith(prefix) ? prev : `${prefix} ${prev}`.trimEnd() + ' '));
            }}
          />
        ) : (
          <ul
            // 2026-05-29 (Q6) — widen message-list cap from 1180px → 1280px so
            // bubbles use more horizontal real estate on wide monitors per
            // user feedback on excessive whitespace. Matches Tailwind's
            // screen-xl breakpoint and stays narrower than the 1440px+
            // desktop viewport so side rails breathe.
            className={stageMode ? 'mx-auto w-full max-w-[1280px] space-y-1' : 'space-y-0.5'}
            data-testid="message-list"
          >
            {renderedMessages.map(({ message, dateLabel, showSender }) => {
              // P9 — prefer the digest renderer when the message carries the
              // `taskDigest` metadata shape. Pre-P9 messages still expose
              // `metadata.kind='task_status_event'` and fall through to the
              // legacy TaskStatusEventRow chip.
              const digestPayload: TaskDigestPayload | null =
                message.type === 'system' || message.type === 'system_event'
                  ? readTaskDigestPayload(normalizeMetadata(message.metadata))
                  : null;
              const rawTaskStatusEvent = digestPayload ? null : readTaskStatusEvent(message);
              // 缺陷 5b — same reconciliation as triggerStatusMap so the
              // centered TaskStatusEventRow chip also clears when the
              // underlying task later succeeded via force-retry.
              const reconciledStatusEvent = rawTaskStatusEvent ? reconcileTaskStatusEvent(rawTaskStatusEvent) : null;
              // Bug 3 (2026-05-29) — once a historical `awaiting_approval`
              // event has been reconciled (the agent was redispatched and
              // either completed or failed), don't render the stale orange
              // pending strip at all. The post-decision agent reply IS the
              // visible closure signal; leaving a relabelled chip behind
              // would clutter the feed with redundant terminal pills.
              const awaitingApprovalCleared =
                rawTaskStatusEvent?.status === 'awaiting_approval' &&
                reconciledStatusEvent?.status !== 'awaiting_approval';
              const taskStatusEvent = awaitingApprovalCleared ? null : reconciledStatusEvent;
              const triggerStatus = triggerStatusMap.get(message.id);
              const dispatchFailed = dispatchFailedMap.get(message.id);
              return (
                <li
                  key={message.id}
                  ref={(node) => {
                    if (node) messageRefs.current.set(message.id, node);
                    else messageRefs.current.delete(message.id);
                  }}
                  data-message-id={message.id}
                  data-highlighted={highlightedMessageId === message.id ? 'true' : undefined}
                  className={`rounded-2xl transition-colors ${
                    highlightedMessageId === message.id
                      ? isDark
                        ? 'bg-cyan-400/10 ring-1 ring-cyan-300/30'
                        : 'bg-cyan-50 ring-1 ring-cyan-200'
                      : ''
                  }`}
                >
                  {dateLabel ? <DateDivider label={dateLabel} isDark={isDark} /> : null}
                  {digestPayload ? (
                    <>
                      <TaskDigestCard
                        digest={(() => {
                          // Wave 3 §4.4.3 — overlay live phase signal (from
                          // task.phase.* SSE) on top of the persisted digest
                          // payload. The digest is the "shape", phase is the
                          // "real-time decoration". Persisted payload wins if
                          // present (replay-safe).
                          const livePhase = taskPhases.get(digestPayload.taskId);
                          if (!livePhase) return digestPayload;
                          return {
                            ...digestPayload,
                            phase: digestPayload.phase ?? livePhase.phase ?? null,
                            lastStep: digestPayload.lastStep ?? livePhase.lastStep ?? null,
                            lastHeartbeatAt: digestPayload.lastHeartbeatAt ?? livePhase.lastHeartbeatAt ?? null,
                          } satisfies TaskDigestPayload;
                        })()}
                        isDark={isDark}
                        onOpenTask={onOpenTask}
                        onOpenAsset={onOpenAsset}
                        notify={notify}
                        resolveTaskAssets={resolveTaskDigestAssets}
                      />
                    </>
                  ) : taskStatusEvent ? (
                    <TaskStatusEventRow
                      event={taskStatusEvent}
                      isDark={isDark}
                      onOpenTask={onOpenTask}
                      onRetryRun={onRetryRun}
                    />
                  ) : unifiedAgentMsg &&
                    !(message.senderId === 'me' || (!!currentUserId && message.senderId === currentUserId)) &&
                    message.type !== 'system' &&
                    message.type !== 'system_event' ? (
                    // release201/32 P1/P2 — flag-gated unified <AgentMessage>.
                    // Replaces (InlineActivityStrip + MessageRow) for agent
                    // replies (system messages excluded — they keep the legacy
                    // centred row). Same `w-8` avatar spacer so the left edge
                    // stays flush. Default OFF → this branch never runs in prod.
                    <div className="flex w-full gap-2.5">
                      <div className="w-8 shrink-0" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <AgentMessageContainer
                          message={message}
                          conversationId={conversation?.id ?? null}
                          dispatchId={
                            dispatchStripMap.get(message.id)?.dispatchId ??
                            (message.metadata && typeof message.metadata === 'object'
                              ? ((message.metadata as Record<string, unknown>).taskId as string | undefined)
                              : undefined) ??
                            null
                          }
                          sender={{
                            id: message.senderId,
                            name:
                              memberById.get(message.senderId)?.displayName ??
                              memberById.get(message.senderId)?.username ??
                              'Agent',
                            role: agentTypeByImUserId?.[message.senderId] ?? undefined,
                            isAgent: true,
                            avatarSeed: message.senderId,
                            // release202/09 avatar consistency — username is the
                            // reliable role-icon source; avatarUrl shows the
                            // agent's uploaded image over the role icon.
                            username:
                              usernameByImUserId?.[message.senderId] ??
                              memberById.get(message.senderId)?.username ??
                              null,
                            avatarUrl: memberById.get(message.senderId)?.avatarUrl ?? null,
                          }}
                          isDark={isDark}
                          onCopy={() => {
                            const text = typeof message.content === 'string' ? message.content : '';
                            void copyText(text).then((res) => {
                              if (res.ok) notify?.(t('workspace.session.copiedToClipboard'), 'success');
                              else notify?.(res.error ?? t('workspace.session.copyFailed'), 'error');
                            });
                          }}
                          onForward={
                            onForwardMessage && conversation
                              ? () =>
                                  onForwardMessage({
                                    conversationId: conversation.id,
                                    messageId: message.id,
                                    text: typeof message.content === 'string' ? message.content : '',
                                    senderName:
                                      memberById.get(message.senderId)?.displayName ??
                                      memberById.get(message.senderId)?.username ??
                                      'Agent',
                                    createdAt: message.createdAt,
                                  })
                              : undefined
                          }
                          onSaveToMemory={
                            onSaveMessageAsMemory && conversation
                              ? () =>
                                  onSaveMessageAsMemory({
                                    conversationId: conversation.id,
                                    messageId: message.id,
                                    text: typeof message.content === 'string' ? message.content : '',
                                    authorImUserId: message.senderId,
                                    createdAt: message.createdAt,
                                  })
                              : undefined
                          }
                          onOpenAsset={(asset) => onOpenAsset?.(asset.id)}
                          onOpenTask={(task) => onOpenTask?.(task.id)}
                          scrollContainer={scrollContainerRef}
                          bodyExtras={
                            // P2 parity — clickable prismer:// links inside the
                            // agent reply body (extractPrismerChatLinks is not
                            // exported, so reuse the component via a slot).
                            <MessagePrismerLinks
                              message={message}
                              assets={assets}
                              files={files}
                              isDark={isDark}
                              onOpenAsset={onOpenAsset}
                            />
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* 2026-05-29 (doc 14 §4.4.3-4.4.4) — Strip mounts
                          immediately ABOVE the agent reply so the dispatch
                          lifecycle (thinking / tool / asset_upload / done
                          12s · 4 step · 1 file) reads as that reply's own
                          signature. Replaces the earlier (wrong) placement
                          under the user trigger message: that variant
                          left every agent message in the chat un-decorated
                          and forced the user to mentally trace dispatch
                          state back upward to their own bubble. */}
                      {(() => {
                        const summary = dispatchStripMap.get(message.id);
                        if (!summary) return null;
                        const agentMember = memberById.get(summary.agentImUserId);
                        const agentName = agentMember?.displayName ?? agentMember?.username ?? 'Agent';
                        // 2026-05-29 (Bug 5) — wrap the strip in the same
                        // `flex w-full gap-2.5` + `w-8` avatar spacer that
                        // MessageRow uses for !isOwn rows so the strip's
                        // left edge sits flush with the agent reply bubble
                        // that follows it, instead of hugging the chat
                        // container's left edge.
                        return (
                          <div className="flex w-full gap-2.5">
                            <div className="w-8 shrink-0" aria-hidden />
                            <div className="min-w-0 flex-1">
                              <InlineActivityStrip
                                dispatchId={summary.dispatchId}
                                agentName={agentName}
                                conversationId={conversation?.id ?? null}
                                state={summary.state}
                                originalOutput={summary.originalOutput}
                                durationMs={summary.durationMs}
                                fileCount={summary.fileCount}
                                isDark={isDark}
                              />
                            </div>
                          </div>
                        );
                      })()}
                      <MessageRow
                        message={message}
                        member={memberById.get(message.senderId)}
                        showSender={showSender}
                        isOwn={message.senderId === 'me' || (!!currentUserId && message.senderId === currentUserId)}
                        isDark={isDark}
                        selfAvatarUrl={
                          // Own-message avatar: the current user's uploaded
                          // image. senderId may be the optimistic 'me' (no
                          // member row) so resolve via currentUserId too.
                          memberById.get(message.senderId)?.avatarUrl ??
                          (currentUserId ? memberById.get(currentUserId)?.avatarUrl : null) ??
                          null
                        }
                        assets={assets}
                        files={files}
                        onOpenTask={onOpenTask}
                        onOpenAsset={onOpenAsset}
                        triggerStatus={triggerStatus}
                        dispatchFailed={dispatchFailed}
                        linkedTaskIds={linkedTaskIds}
                        agentTypeByImUserId={agentTypeByImUserId}
                        usernameByImUserId={usernameByImUserId}
                        agentUsernames={agentUsernames}
                        agentStatuses={agentStatuses}
                        deliveryState={messageDeliveryStates.get(message.id) ?? null}
                        taskPhaseMap={taskPhaseMap}
                        stageMode={stageMode}
                        onRetryMessage={onRetryMessage}
                        onSaveAsMemory={
                          onSaveMessageAsMemory && conversation
                            ? () =>
                                onSaveMessageAsMemory({
                                  conversationId: conversation.id,
                                  messageId: message.id,
                                  text: typeof message.content === 'string' ? message.content : '',
                                  authorImUserId: message.senderId,
                                  createdAt: message.createdAt,
                                })
                            : undefined
                        }
                        onForwardRequest={
                          onForwardMessage && conversation
                            ? (senderName) =>
                                onForwardMessage({
                                  conversationId: conversation.id,
                                  messageId: message.id,
                                  text: typeof message.content === 'string' ? message.content : '',
                                  senderName,
                                  createdAt: message.createdAt,
                                })
                            : undefined
                        }
                        notify={notify}
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {/* 2026-05-29 ROLLBACK history: a placeholder card alongside TypingRow
            showed two "agent is working" signals for the same dispatch, so the
            running placeholder was disabled pending a "unified signal source".
            release201/32 §9 (below) IS that source — flag-ON renders ONE unified
            running card from `typingRows` and suppresses TypingRow; the old
            dispatch.lifecycle-based `pendingDispatches` memo (which never fired,
            `pushed`-gated) was removed. */}
        {/* 2026-05-29 (Q6) — TypingRow's outer column was unconstrained, so
            on stage-mode the row hugged the scroll container's left edge while
            message bubbles above were centred inside `mx-auto max-w-[1280px]`.
            Wrap the AnimatePresence in the same width budget so the strip
            (the visible "EXECUTING · N% + steps" chip user reported) sits flush
            with the message column above it instead of drifting left. The
            AnimatePresence stays direct-parent of the motion children so
            exit animations still work.

            Note: previous Q5 attempt (commit 2b5d09e8) wrapped
            `InlineActivityStrip` with a `w-8` avatar spacer. That mount-point
            renders the *delivery summary* strip inside the message <ul>; the
            *live typing* strip user sees in image-28 is this `TypingRow`,
            rendered as a sibling AFTER the </ul> closes — so the Q5 fix never
            affected the visible artifact. */}
        <div className={stageMode ? 'mx-auto w-full max-w-[1280px]' : ''}>
          {/* release201/32 §9 — unified running mount. Driven by `typingRows`
              (agentTasks executing — already lifecycle-pruned, same source as the
              legacy TypingRow), agent resolved once per task. flag ON → unified
              running cards (suppress TypingRow). flag OFF → legacy TypingRow. */}
          {unifiedAgentMsg && typingRows.length > 0 ? (
            <div className="space-y-5">
              {typingRows.map((task) => {
                const assigneeId = taskAgentById.get(task.taskId) ?? null;
                const member = assigneeId ? memberById.get(assigneeId) : undefined;
                const placeholder = runningPlaceholderMsgs.get(task.taskId);
                if (!placeholder) return null;
                return (
                  <div key={`pending:${task.taskId}`} className="flex w-full gap-2.5">
                    <div className="w-8 shrink-0" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <AgentMessageContainer
                        runningPlaceholder
                        message={placeholder}
                        conversationId={conversation?.id ?? null}
                        dispatchId={task.taskId}
                        sender={{
                          id: assigneeId ?? task.taskId,
                          name: member?.displayName ?? member?.username ?? 'Agent',
                          role: assigneeId ? (agentTypeByImUserId?.[assigneeId] ?? undefined) : undefined,
                          isAgent: true,
                          avatarSeed: assigneeId ?? task.taskId,
                        }}
                        isDark={isDark}
                        scrollContainer={scrollContainerRef}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {typingRows.map((task) => (
                <TypingRow key={task.taskId} status={task} isDark={isDark} />
              ))}
            </AnimatePresence>
          )}
        </div>
        <div ref={endRef} />
      </div>

      <footer
        ref={footerRef}
        className={
          stageMode
            ? 'pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4 pt-10'
            : `relative border-t px-3 py-3 ${isDark ? 'border-white/[0.06] bg-zinc-950/38' : 'border-zinc-200/80 bg-white/60'}`
        }
      >
        <div className={stageMode ? 'pointer-events-auto relative mx-auto w-full max-w-[1080px]' : 'relative'}>
          {/* release201/32 — 回到底部按钮：锚定 composer 上沿（bottom-full，
              不用魔数 offset，composer 多高都不重叠）+ 品牌高亮渐变。 */}
          {showJumpToBottom ? (
            <button
              type="button"
              onClick={jumpToBottom}
              aria-label="回到底部"
              className="absolute bottom-full left-1/2 z-30 mb-3 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium text-white shadow-[0_8px_24px_-6px_rgba(124,76,255,0.55)] ring-1 ring-white/20 transition-transform hover:scale-105"
              style={{ backgroundImage: 'linear-gradient(135deg, #22d3ee, #724cff)' }}
            >
              <ChevronDown className="h-3.5 w-3.5" />
              回到底部
            </button>
          ) : null}
          {mentionFilter !== null ? (
            <MentionPicker
              ref={mentionPickerRef}
              isDark={isDark}
              members={mentionMembers}
              filter={mentionFilter}
              onSelect={onSelectMention}
              onClose={() => setMentionFilter(null)}
            />
          ) : null}
          {assetFilter !== null && workspaceId ? (
            <AssetPicker
              ref={assetPickerRef}
              isDark={isDark}
              workspaceId={workspaceId}
              filter={assetFilter}
              onSelect={onSelectAsset}
              onClose={() => {
                setAssetFilter(null);
                assetRangeRef.current = null;
              }}
            />
          ) : null}

          <AnimatePresence>
            {slashMatches.length > 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={springSoft}
                className={`absolute left-3 right-3 bottom-[92px] z-20 border ${radius.card} ${surface.modal[theme]} overflow-hidden`}
              >
                {slashMatches.map((cmd) => (
                  <button
                    key={cmd.name}
                    type="button"
                    onClick={() => insertSlashCommand(cmd.template)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm border-b last:border-b-0 ${
                      isDark ? 'border-white/[0.05] hover:bg-white/[0.04]' : 'border-zinc-100 hover:bg-zinc-50'
                    }`}
                  >
                    <Command className={`w-4 h-4 ${isDark ? 'text-violet-300' : 'text-violet-700'}`} />
                    <span className={`font-mono text-xs ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                      /{cmd.name}
                    </span>
                    <span className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{cmd.hint}</span>
                  </button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <motion.div
            layout
            transition={springSoft}
            className={`border p-2 backdrop-blur-2xl transition-[background-color,border-color,box-shadow] focus-within:shadow-[0_26px_76px_-30px_rgba(99,102,241,0.78)] ${stageMode ? 'rounded-2xl shadow-[0_24px_70px_-32px_rgba(15,23,42,0.72)]' : `${radius.card} shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)]`} ${
              isDark
                ? stageMode
                  ? 'border-white/[0.08] bg-zinc-950/88 focus-within:border-violet-300/30 focus-within:bg-zinc-950/72'
                  : 'border-white/[0.08] bg-white/[0.035] focus-within:bg-white/[0.055]'
                : stageMode
                  ? 'border-zinc-200/90 bg-zinc-50/88 focus-within:border-violet-300/60 focus-within:bg-white/96'
                  : 'border-zinc-200/80 bg-white/82 focus-within:bg-white/94'
            }`}
            data-composer-expanded={composerExpanded ? 'true' : undefined}
          >
            <ApprovalCard
              isDark={isDark}
              workspaceId={workspaceId}
              conversationId={conversation?.id}
              refreshKey={approvalRefreshKey}
              notify={notify}
            />
            <TaskReviewBar
              isDark={isDark}
              tasks={linkedTasks}
              notify={notify}
              onOpenTask={onOpenTask}
              onTaskChanged={onTaskChanged}
            />
            <AnimatePresence initial={false}>
              {!readOnlyObserver && composerPanel === 'attachments' ? (
                <AttachmentPanel
                  isDark={isDark}
                  showAssets={Boolean(onOpenAssets)}
                  // Wave-3.5 W5 — File / Photos prefer the parent-provided
                  // upload entry (which threads through full asset library
                  // semantics), but fall back to the hidden multi-file input
                  // so users can still batch-select even on surfaces that
                  // didn't wire a custom upload modal.
                  onUploadAsset={onComposerUploadAsset ?? onUploadAsset ?? openComposerFilePicker}
                  onOpenAssets={onOpenAssets}
                  onInsert={insertDraftTextAtCaret}
                  onShareLocation={shareLocation}
                  onClose={() => setComposerPanel(null)}
                />
              ) : null}
              {!readOnlyObserver && composerPanel === 'emoji' ? (
                <EmojiPanel
                  isDark={isDark}
                  onSelect={(emoji) => insertDraftTextAtCaret(emoji)}
                  onClose={() => setComposerPanel(null)}
                />
              ) : null}
              {!readOnlyObserver && composerPanel === 'commands' ? (
                <CommandPanel
                  isDark={isDark}
                  onSelect={(template) => insertSlashCommand(template)}
                  onClose={() => setComposerPanel(null)}
                />
              ) : null}
            </AnimatePresence>

            {voiceMode ? (
              <div
                className={`mb-2 flex items-center gap-2 rounded-2xl border px-3 py-2 ${
                  isDark
                    ? 'border-white/[0.06] bg-white/[0.03] text-zinc-300'
                    : 'border-zinc-200 bg-white text-zinc-700'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setVoiceMode(false)}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-zinc-100'}`}
                  title={t('workspace.session.keyboardMode')}
                  aria-label={t('workspace.session.keyboardMode')}
                >
                  <Keyboard className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold">{t('workspace.session.voiceMode')}</p>
                  <p className={`truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {t('workspace.session.voiceUnavailable')}
                  </p>
                </div>
              </div>
            ) : null}

            {/* Wave-3.5 W5 (14b §6.2 P4) — hidden multi-file input. The
              AttachmentPanel "File"/"Photos" buttons click() into this when
              no parent upload modal is wired. `multiple` enables batch
              select; we omit `accept` so all MIME types reach the
              filterUploadCandidates guardrail (50 MB cap, dedupe). */}
            <input
              ref={composerFileInputRef}
              type="file"
              multiple
              data-testid="composer-file-input"
              className="hidden"
              onChange={onComposerFilePicked}
            />
            <textarea
              ref={textareaRef}
              data-testid="composer-input"
              rows={composerExpanded ? 6 : stageCompact ? 2 : 3}
              className={`${composerExpanded ? 'max-h-[42vh]' : 'max-h-32'} min-h-[44px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none ${
                isDark ? 'text-zinc-100 placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'
              }`}
              placeholder={
                readOnlyObserver
                  ? t('workspace.session.readOnlyAgentSession')
                  : t('workspace.session.messagePlaceholder')
              }
              value={draft}
              onChange={onDraftChange}
              onKeyDown={onKeyDown}
              onPaste={onComposerPaste}
              onSelect={(e) => {
                const ta = e.currentTarget;
                updateMentionState(ta.value, ta.selectionStart ?? ta.value.length);
              }}
              disabled={sending || readOnlyObserver}
            />
            <PastedTextTray
              isDark={isDark}
              blocks={pastedTextBlocks}
              editingId={editingPasteId}
              editingDraft={editingPasteDraft}
              onOpenEdit={openPastedTextEditor}
              onDraftChange={setEditingPasteDraft}
              onCommitEdit={commitPastedTextEdit}
              onCancelEdit={() => {
                setEditingPasteId(null);
                setEditingPasteDraft('');
              }}
              onRemove={removePastedTextBlock}
            />
            <ComposerFileTray isDark={isDark} blocks={composerFileBlocks} onRemove={removeComposerFileBlock} />
            {uploadProgress ? <ComposerUploadProgressRow isDark={isDark} progress={uploadProgress} /> : null}
            <div className="mt-2 flex items-center gap-1.5">
              <ComposerTool
                isDark={isDark}
                title={voiceMode ? t('workspace.session.keyboard') : t('workspace.session.voice')}
                onClick={() => setVoiceMode((value) => !value)}
                disabled={readOnlyObserver}
              >
                {voiceMode ? <Keyboard className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              </ComposerTool>
              <ComposerTool
                isDark={isDark}
                title={t('workspace.session.mention')}
                onClick={() => insertDraftTextAtCaret('@', { openMention: true })}
                disabled={readOnlyObserver}
              >
                <AtSign className="w-3.5 h-3.5" />
              </ComposerTool>
              <ComposerTool
                isDark={isDark}
                title={t('workspace.session.slashCommands')}
                active={composerPanel === 'commands'}
                onClick={() => setComposerPanel((panel) => (panel === 'commands' ? null : 'commands'))}
                disabled={readOnlyObserver}
              >
                <Command className="w-3.5 h-3.5" />
              </ComposerTool>
              {draft.trim() || pastedTextBlocks.length > 0 || composerFileBlocks.length > 0 ? (
                <span className={`ml-1 hidden text-[10px] xl:inline ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {t('workspace.session.sendShortcut')}
                </span>
              ) : null}
              <ComposerTool
                isDark={isDark}
                title={t('workspace.session.emoji')}
                active={composerPanel === 'emoji'}
                onClick={() => setComposerPanel((panel) => (panel === 'emoji' ? null : 'emoji'))}
                disabled={readOnlyObserver}
              >
                <Smile className="w-3.5 h-3.5" />
              </ComposerTool>
              <ComposerTool
                isDark={isDark}
                title={t('workspace.session.attachments')}
                active={composerPanel === 'attachments'}
                onClick={() => setComposerPanel((panel) => (panel === 'attachments' ? null : 'attachments'))}
                disabled={readOnlyObserver}
              >
                <Plus className="w-3.5 h-3.5" />
              </ComposerTool>
              {/* Send button — three states:
                 1. idle (no agent working, no in-flight POST): static arrow
                 2. sending (POST in flight): loader spinner
                 3. chain-active (at least one agent task running for this conv):
                    breathing pulse on the gradient ring + arrow stays clickable
                    so the human can "interrupt" by sending a new message; the
                    new message creates fresh dispatches and supersedes the
                    chain (hop-cap eventually clears stale pending). */}
              <motion.button
                type="button"
                onClick={() => void onSend()}
                disabled={
                  (!draft.trim() && pastedTextBlocks.length === 0 && composerFileBlocks.length === 0) ||
                  sending ||
                  readOnlyObserver
                }
                data-testid="composer-send"
                whileHover={
                  (!draft.trim() && pastedTextBlocks.length === 0 && composerFileBlocks.length === 0) ||
                  sending ||
                  readOnlyObserver
                    ? undefined
                    : { scale: 1.06, y: -1 }
                }
                whileTap={{ scale: 0.92 }}
                animate={
                  agentTasks.size > 0 && !sending
                    ? {
                        boxShadow: [
                          '0 18px 50px -18px rgba(139,92,246,0.85)',
                          '0 22px 60px -14px rgba(34,211,238,0.95)',
                          '0 18px 50px -18px rgba(139,92,246,0.85)',
                        ],
                      }
                    : { boxShadow: '0 18px 50px -18px rgba(139,92,246,0.85)' }
                }
                transition={
                  agentTasks.size > 0 && !sending ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' } : springSnap
                }
                className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white bg-gradient-to-br from-violet-500 to-cyan-500 disabled:opacity-35 disabled:cursor-not-allowed"
                title={
                  readOnlyObserver
                    ? t('workspace.session.readOnlyAgentSession')
                    : agentTasks.size > 0
                      ? t('workspace.session.agentsWorkingInterrupt', { count: agentTasks.size })
                      : t('workspace.session.send')
                }
              >
                {sending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : agentTasks.size > 0 ? (
                  <motion.div
                    animate={{ y: [-1, 1, -1] }}
                    transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                  >
                    <ArrowUp className="w-4 h-4" />
                  </motion.div>
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </motion.button>
            </div>
          </motion.div>
        </div>
      </footer>
    </section>
  );
}

function SessionSearchPanel({
  isDark,
  query,
  results,
  searching,
  error,
  senderLabelFor,
  onQueryChange,
  onClose,
  onSelect,
}: {
  isDark: boolean;
  query: string;
  results: MessageSearchResult[];
  searching: boolean;
  error: string | null;
  senderLabelFor: (message: MessageSearchResult) => string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onSelect: (message: MessageSearchResult) => void;
}) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const trimmed = query.trim();

  return (
    <motion.div
      data-testid="session-search-panel"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={springSoft}
      className={`absolute left-3 right-3 top-[116px] z-40 flex max-h-[min(560px,calc(100%_-_128px))] flex-col overflow-hidden border sm:left-auto sm:w-96 ${radius.card} ${surface.modal[theme]}`}
    >
      <div className={`border-b p-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-100'}`}>
        <div className="flex items-center gap-2">
          <div
            className={`flex h-9 flex-1 items-center gap-2 rounded-2xl border px-3 ${
              isDark ? 'border-white/[0.06] bg-white/[0.04]' : 'border-zinc-200 bg-white'
            }`}
          >
            <Search className={`h-4 w-4 shrink-0 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
            <input
              autoFocus
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose();
                if (event.key === 'Enter' && results[0]) onSelect(results[0]);
              }}
              placeholder={t('workspace.session.searchMessagesInSession')}
              data-testid="session-search-input"
              className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-500 ${
                isDark ? 'text-zinc-100' : 'text-zinc-900'
              }`}
            />
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" /> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-2xl ${
              isDark ? 'text-zinc-400 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'
            }`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-[140px] overflow-y-auto p-2">
        {error ? (
          <div
            className={`m-1 rounded-2xl border px-3 py-2 text-xs ${
              isDark ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            {error}
          </div>
        ) : searching && results.length === 0 ? (
          <SearchEmptyState isDark={isDark} label={t('workspace.session.searchingMessages')} />
        ) : !trimmed ? (
          <SearchEmptyState isDark={isDark} label={t('workspace.session.searchMessagesInSession')} />
        ) : !searching && results.length === 0 ? (
          <SearchEmptyState isDark={isDark} label={t('workspace.session.noMatchingMessages')} />
        ) : (
          <ul className="space-y-1" data-testid="session-search-results">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onSelect(result)}
                  data-testid={`session-search-result-${result.id}`}
                  className={`w-full rounded-2xl border px-3 py-2 text-left transition-colors ${
                    isDark
                      ? 'border-white/[0.06] bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
                      : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      {senderLabelFor(result)}
                    </span>
                    <time className={`shrink-0 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      {formatMessageTime(result.createdAt)}
                    </time>
                  </div>
                  <p
                    className={`mt-1 line-clamp-2 text-xs leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                  >
                    {renderSearchSnippet(result.snippet || result.content, trimmed, isDark)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </motion.div>
  );
}

function SearchEmptyState({ isDark, label }: { isDark: boolean; label: string }) {
  return (
    <div
      className={`flex min-h-[130px] items-center justify-center text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
    >
      {label}
    </div>
  );
}

function EmojiPanel({
  isDark,
  onSelect,
  onClose,
}: {
  isDark: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <motion.div
      key="emoji-panel"
      data-testid="composer-emoji-panel"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={springSoft}
      className={`mb-2 border p-2 ${radius.card} ${isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white'}`}
    >
      <ComposerPanelHeader
        isDark={isDark}
        label={t('workspace.session.emoji')}
        title={t('workspace.session.closeEmoji')}
        onClose={onClose}
      />
      <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
        {COMPOSER_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={t('workspace.session.insertEmoji', { emoji })}
            onClick={() => onSelect(emoji)}
            className={`flex h-9 w-full items-center justify-center rounded-xl text-lg transition-colors ${
              isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-zinc-100'
            }`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function CommandPanel({
  isDark,
  onSelect,
  onClose,
}: {
  isDark: boolean;
  onSelect: (template: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <motion.div
      key="command-panel"
      data-testid="composer-command-panel"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={springSoft}
      className={`mb-2 border p-2 ${radius.card} ${isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white'}`}
    >
      <ComposerPanelHeader
        isDark={isDark}
        label={t('workspace.session.commands')}
        title={t('workspace.session.closeCommands')}
        onClose={onClose}
      />
      <div className="grid gap-1.5">
        {SLASH_COMMANDS.map((cmd) => (
          <button
            key={cmd.name}
            type="button"
            onClick={() => onSelect(cmd.template)}
            className={`flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
              isDark ? 'text-zinc-200 hover:bg-white/[0.05]' : 'text-zinc-800 hover:bg-zinc-100'
            }`}
          >
            <Command className={`h-4 w-4 shrink-0 ${isDark ? 'text-violet-300' : 'text-violet-700'}`} />
            <span className="w-24 shrink-0 font-mono text-xs">/{cmd.name}</span>
            <span className={`min-w-0 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{cmd.hint}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function ComposerPanelHeader({
  isDark,
  label,
  title,
  onClose,
}: {
  isDark: boolean;
  label: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="mb-1 flex items-center justify-between px-1">
      <span className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {label}
      </span>
      <button
        type="button"
        onClick={onClose}
        title={title}
        className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${isDark ? 'text-zinc-500 hover:bg-white/[0.05]' : 'text-zinc-500 hover:bg-zinc-100'}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AttachmentPanel({
  isDark,
  showAssets,
  onUploadAsset,
  onOpenAssets,
  onInsert,
  onShareLocation,
  onClose,
}: {
  isDark: boolean;
  showAssets: boolean;
  onUploadAsset?: () => void;
  onOpenAssets?: () => void;
  onInsert: (snippet: string) => void;
  onShareLocation: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const items = [
    { key: 'file', label: t('workspace.session.file'), icon: <File className="h-4 w-4" />, action: onUploadAsset },
    {
      key: 'photos',
      label: t('workspace.session.photos'),
      icon: <ImageIcon className="h-4 w-4" />,
      action: onUploadAsset,
    },
    {
      key: 'camera',
      label: t('workspace.session.camera'),
      icon: <Camera className="h-4 w-4" />,
      action: onUploadAsset,
    },
    {
      key: 'location',
      label: t('workspace.session.location'),
      icon: <MapPin className="h-4 w-4" />,
      action: onShareLocation,
    },
    ...(showAssets
      ? [
          {
            key: 'assets',
            label: t('workspace.session.assets'),
            icon: <Archive className="h-4 w-4" />,
            action: onOpenAssets,
          },
        ]
      : []),
  ];
  return (
    <motion.div
      data-testid="composer-attachment-panel"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={springSoft}
      className={`mb-2 border p-2 ${radius.card} ${isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white'}`}
    >
      <ComposerPanelHeader
        isDark={isDark}
        label={t('workspace.session.attach')}
        title={t('workspace.session.closeAttachments')}
        onClose={onClose}
      />
      <div className="grid grid-cols-5 gap-1.5">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              item.action?.();
              if (item.key === 'file' && !item.action) onInsert('[File]');
              onClose();
            }}
            className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-2xl text-[10px] transition-colors ${
              isDark ? 'text-zinc-300 hover:bg-white/[0.05]' : 'text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-2xl ${isDark ? 'bg-white/[0.05]' : 'bg-zinc-100'}`}
            >
              {item.icon}
            </span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function PastedTextTray({
  isDark,
  blocks,
  editingId,
  editingDraft,
  onOpenEdit,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onRemove,
}: {
  isDark: boolean;
  blocks: PastedTextBlock[];
  editingId: string | null;
  editingDraft: string;
  onOpenEdit: (block: PastedTextBlock) => void;
  onDraftChange: (value: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  if (blocks.length === 0) return null;

  return (
    <div className="mt-2 grid min-w-0 gap-2">
      {blocks.map((block) => {
        const editing = editingId === block.id;
        const compactText = block.text.trim().replace(/\s+/g, ' ');
        return (
          <div
            key={block.id}
            className={`min-w-0 rounded-2xl border p-2 ${
              isDark ? 'border-white/[0.07] bg-zinc-950/42' : 'border-zinc-200 bg-white/80'
            }`}
          >
            {editing ? (
              <>
                <textarea
                  value={editingDraft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') onCancelEdit();
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onCommitEdit();
                  }}
                  autoFocus
                  rows={6}
                  className={`max-h-[34vh] min-h-[132px] w-full resize-y rounded-xl border px-3 py-2 text-sm leading-relaxed outline-none ${
                    isDark
                      ? 'border-white/[0.08] bg-zinc-950/70 text-zinc-100 focus:ring-1 focus:ring-violet-400/40'
                      : 'border-zinc-200 bg-white text-zinc-950 focus:ring-1 focus:ring-violet-300'
                  }`}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className={`inline-flex h-8 items-center rounded-lg border px-3 text-xs font-semibold ${
                      isDark
                        ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]'
                        : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                    }`}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={onCommitEdit}
                    className="inline-flex h-8 items-center rounded-lg bg-violet-600 px-3 text-xs font-semibold text-white"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenEdit(block)}
                  title={t('workspace.session.editPastedText')}
                  aria-label={t('workspace.session.editPastedText')}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                    isDark
                      ? 'border-cyan-300/20 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15'
                      : 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100'
                  }`}
                >
                  <FileText className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenEdit(block)}
                  className="min-w-0 flex-1 text-left"
                  title={t('workspace.session.editPastedText')}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`shrink-0 text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                      {t('workspace.session.pastedText')}
                    </span>
                    <span className={`shrink-0 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                      {t('workspace.session.characterCount', { count: block.text.length.toLocaleString() })}
                    </span>
                  </span>
                  <span
                    className={`block max-w-full truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                  >
                    {compactText.slice(0, 96)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(block.id)}
                  title={t('workspace.session.removePastedText')}
                  aria-label={t('workspace.session.removePastedText')}
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    isDark
                      ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                  }`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * release201/30 Phase 2 — inline upload progress.
 *
 * Replaces the bottom-right `AssetUploadProgressOverlay` toast with a
 * compose-area row anchored to the conversation that triggered the
 * upload. The card desaturates the filename + overlays a progress bar so
 * the user sees the upload coupled to "the thing I just dragged in",
 * not floating chrome at the page corner.
 *
 * Indeterminate phases (`percent: null`) animate a slim shimmer bar.
 */
function ComposerUploadProgressRow({ isDark, progress }: { isDark: boolean; progress: ComposerUploadProgressView }) {
  const pct = progress.percent != null ? Math.min(100, Math.max(0, progress.percent)) : null;
  return (
    <div
      data-testid="composer-upload-progress"
      className={`mt-2 flex w-full items-center gap-3 rounded-2xl border px-3 py-2 opacity-90 ${
        isDark ? 'border-white/[0.07] bg-zinc-950/55' : 'border-zinc-200 bg-white/90'
      }`}
    >
      <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${isDark ? 'text-violet-300' : 'text-violet-600'}`} />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {progress.filename}
        </p>
        <p className={`mt-0.5 truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {progress.phaseLabel}
          {progress.multiLabel ? ` · ${progress.multiLabel}` : ''}
        </p>
        <div className={`mt-1.5 h-1.5 overflow-hidden rounded-full ${isDark ? 'bg-white/[0.08]' : 'bg-zinc-200'}`}>
          {pct == null ? (
            <div className="h-full w-1/3 animate-[composer-upload-shimmer_1.1s_ease-in-out_infinite] rounded-full bg-violet-500" />
          ) : (
            <div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} />
          )}
        </div>
      </div>
      {pct != null ? (
        <span className={`shrink-0 text-[11px] tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
          {pct}%
        </span>
      ) : null}
      <style>{`
        @keyframes composer-upload-shimmer {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}

function ComposerFileTray({
  isDark,
  blocks,
  onRemove,
}: {
  isDark: boolean;
  blocks: ComposerFileBlock[];
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  if (blocks.length === 0) return null;

  return (
    <div className="mt-2 flex min-w-0 gap-2 overflow-x-auto pb-1" data-testid="composer-file-tray">
      {blocks.map((block) => {
        const sizeLabel = formatBytes(block.file.size);
        return (
          <div
            key={block.id}
            className={`relative flex h-20 w-40 shrink-0 overflow-hidden rounded-2xl border ${
              isDark ? 'border-white/[0.07] bg-zinc-950/48' : 'border-zinc-200 bg-white/85'
            }`}
            title={block.file.name}
          >
            <button
              type="button"
              onClick={() => onRemove(block.id)}
              className="absolute right-1.5 top-1.5 z-10 rounded-lg bg-black/45 p-1 text-white hover:bg-black/65"
              aria-label={t('workspace.session.removeFile', { name: block.file.name })}
              title={t('workspace.session.removeFile', { name: block.file.name })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <div
              className={`flex h-full w-16 shrink-0 items-center justify-center ${isDark ? 'bg-white/[0.04]' : 'bg-zinc-100'}`}
            >
              {block.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={block.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : block.kind === 'image' ? (
                <ImageIcon className={`h-5 w-5 ${isDark ? 'text-cyan-200' : 'text-cyan-700'}`} />
              ) : (
                <File className={`h-5 w-5 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`} />
              )}
            </div>
            <button type="button" className="min-w-0 flex-1 p-2 text-left" title={block.file.name}>
              <span className={`block truncate text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                {block.kind === 'image' ? t('workspace.session.imageInput') : t('workspace.session.file')}
              </span>
              <span className={`mt-1 block truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                {block.file.name}
              </span>
              <span className={`mt-0.5 block text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                {sizeLabel}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ComposerTool({
  isDark,
  title,
  active = false,
  onClick,
  disabled = false,
  children,
}: {
  isDark: boolean;
  title: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? isDark
            ? 'bg-violet-500/20 text-violet-200'
            : 'bg-violet-100 text-violet-700'
          : isDark
            ? 'text-zinc-500 enabled:hover:bg-white/[0.05] enabled:hover:text-zinc-200'
            : 'text-zinc-500 enabled:hover:bg-zinc-100 enabled:hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function SessionEmpty({
  isDark,
  members,
  conversationType,
  onFocus,
  onInsertSlash,
}: {
  isDark: boolean;
  members: GroupMember[];
  conversationType: 'direct' | 'group' | null;
  onFocus: () => void;
  onInsertSlash: (prefix: string) => void;
}) {
  const { t } = useI18n();
  const isDirect = conversationType === 'direct';
  // Direct sessions are 1:1 — there's no @mention concept (only one peer).
  // Surface slash-commands + composer actions instead.
  if (isDirect) {
    const peer = members.find((m) => m.role !== 'observer') ?? members[0] ?? null;
    const peerName = peer?.displayName || peer?.username || null;
    return (
      <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-4">
        <div
          className={`w-12 h-12 ${radius.pane} flex items-center justify-center border ${isDark ? 'border-white/[0.08] bg-white/[0.03] text-cyan-200' : 'border-zinc-200 bg-white text-cyan-700'}`}
        >
          <Sparkles className="w-5 h-5" />
        </div>
        <p className={`mt-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
          {peerName ? t('workspace.session.startChatWith', { name: peerName }) : t('workspace.session.startChatting')}
        </p>
        <p className={`mt-1 max-w-[280px] text-xs leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('workspace.session.directEmptyHint')}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <SlashChip
            isDark={isDark}
            label="/task"
            hint={t('workspace.session.dispatchTaskHint')}
            onClick={() => onInsertSlash('/task')}
          />
          <SlashChip
            isDark={isDark}
            label="/file"
            hint={t('workspace.session.uploadFileHint')}
            onClick={() => onInsertSlash('/file')}
          />
          <SlashChip
            isDark={isDark}
            label="/memory"
            hint={t('workspace.session.saveMemoryHint')}
            onClick={() => onInsertSlash('/memory')}
          />
          <button
            type="button"
            onClick={onFocus}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
              isDark
                ? 'border-white/[0.08] text-zinc-200 hover:bg-white/[0.04]'
                : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t('workspace.session.writeMessage')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-4">
      <div
        className={`w-12 h-12 ${radius.pane} flex items-center justify-center border ${isDark ? 'border-white/[0.08] bg-white/[0.03] text-cyan-200' : 'border-zinc-200 bg-white text-cyan-700'}`}
      >
        <Sparkles className="w-5 h-5" />
      </div>
      <p className={`mt-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
        {t('workspace.session.startSession')}
      </p>
      <p className={`mt-1 max-w-[260px] text-xs leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {t('workspace.session.groupEmptyHint')}
      </p>
      <button
        type="button"
        onClick={onFocus}
        className={`mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border ${radius.button} ${
          isDark
            ? 'border-white/[0.08] text-zinc-200 hover:bg-white/[0.04]'
            : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
        }`}
      >
        {members.length > 0 ? <AtSign className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />}
        {members.length > 0 ? t('workspace.session.mentionAgent') : t('workspace.session.sayHello')}
      </button>
    </div>
  );
}

function SlashChip({
  isDark,
  label,
  hint,
  onClick,
}: {
  isDark: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
        isDark
          ? 'border-violet-300/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
          : 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100'
      }`}
    >
      <span className="font-mono text-[11px]">{label}</span>
      <span className={`text-[10px] ${isDark ? 'opacity-60' : 'opacity-70'}`}>{hint}</span>
    </button>
  );
}

function AgentStateStrip({
  isDark,
  agents,
  agentStatuses,
  onOpenAgent,
}: {
  isDark: boolean;
  agents: AgentDTO[];
  agentStatuses?: Map<string, AgentLiveStatus>;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const sorted = agents
    .slice()
    .sort((a, b) => agentStatusRank(agentStatuses?.get(a.userId)) - agentStatusRank(agentStatuses?.get(b.userId)));
  const activeCount = sorted.filter((agent) => {
    const kind = agentStatuses?.get(agent.userId)?.kind;
    return kind === 'working' || kind === 'waiting' || kind === 'stuck';
  }).length;

  return (
    <div
      data-testid="agent-state-strip"
      className={`flex min-h-[52px] shrink-0 items-center gap-2 overflow-x-auto border-b px-4 py-2 ${
        isDark ? 'border-white/[0.05] bg-zinc-950/24 text-zinc-400' : 'border-zinc-200/70 bg-white/45 text-zinc-600'
      }`}
    >
      <div className="shrink-0 pr-1">
        <p className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('workspace.session.agents')}
        </p>
        <p className={`text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
          {sorted.length === 0
            ? t('workspace.session.noAgents')
            : t('workspace.session.activeAgentCount', { active: activeCount, total: sorted.length })}
        </p>
      </div>
      {sorted.length > 0 ? (
        <div className="flex min-w-0 items-center gap-1.5">
          {sorted.map((agent) => {
            const status = agentStatuses?.get(agent.userId) ?? null;
            const tone = agentStatusTone(status, isDark);
            return (
              <button
                key={agent.userId}
                type="button"
                onClick={() => onOpenAgent?.(agent.agentId)}
                title={`${agent.name} · ${agentStatusLabel(status, t)}`}
                data-status-kind={status?.kind ?? 'unknown'}
                className={`inline-flex h-9 max-w-[220px] shrink-0 items-center gap-2 rounded-xl border px-2 text-left transition-colors ${tone}`}
              >
                <AgentAvatar agent={coerceAgentForAvatar(agent)} status={status} size="xs" isDark={isDark} />
                <span className="min-w-0">
                  <span
                    className={`block truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
                  >
                    {agent.name}
                  </span>
                  <span className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    {agentStatusSummary(status, t)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
          {t('workspace.session.humanOnlySession')}
        </span>
      )}
    </div>
  );
}

function agentStatusRank(status: AgentLiveStatus | null | undefined): number {
  if (status?.kind === 'stuck') return 0;
  if (status?.kind === 'waiting') return 1;
  if (status?.kind === 'working') return 2;
  if (status?.kind === 'idle') return 3;
  return 4;
}

function agentStatusLabel(status: AgentLiveStatus | null | undefined, t: WorkspaceT): string {
  if (!status) return t('workspace.session.agentStatusUnknown');
  if (status.kind === 'working') return t('workspace.session.agentStatusWorking');
  if (status.kind === 'waiting') return t('workspace.session.agentStatusWaiting');
  if (status.kind === 'stuck') return t('workspace.session.agentStatusBlocked');
  if (status.kind === 'offline') return t('workspace.session.agentStatusOffline');
  return t('workspace.session.agentStatusIdle');
}

function agentStatusSummary(status: AgentLiveStatus | null | undefined, t: WorkspaceT): string {
  if (!status) return t('workspace.session.agentStatusUnknown');
  if (status.currentTask?.lastStepLabel) return status.currentTask.lastStepLabel;
  if (status.currentTask?.title) return status.currentTask.title;
  if (status.parallelTasks.length > 0)
    return t('workspace.session.parallelTasks', { count: status.parallelTasks.length });
  if (status.recentCompletedTasks.length > 0) {
    return t('workspace.session.doneTask', { title: status.recentCompletedTasks[0].title });
  }
  return agentStatusLabel(status, t);
}

function agentStatusTone(status: AgentLiveStatus | null | undefined, isDark: boolean): string {
  if (status?.kind === 'working') {
    return isDark
      ? 'border-emerald-400/25 bg-emerald-500/10 hover:bg-emerald-500/15'
      : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100';
  }
  if (status?.kind === 'waiting') {
    return isDark
      ? 'border-amber-400/25 bg-amber-500/10 hover:bg-amber-500/15'
      : 'border-amber-200 bg-amber-50 hover:bg-amber-100';
  }
  if (status?.kind === 'stuck') {
    return isDark
      ? 'border-rose-400/25 bg-rose-500/10 hover:bg-rose-500/15'
      : 'border-rose-200 bg-rose-50 hover:bg-rose-100';
  }
  return isDark
    ? 'border-white/[0.06] bg-white/[0.035] hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white/80 hover:bg-zinc-50';
}

function coerceAgentForAvatar(agent: AgentDTO) {
  return {
    agentId: agent.agentId,
    userId: agent.userId,
    name: agent.name,
    agentType: agent.agentType,
    username: agent.username,
  };
}

function SessionDetailsPanel({
  isDark,
  conversation,
  members,
  linkedTasks,
  recentAssets,
  onSearch,
  onOpenAssets,
  onToggleMembers,
}: {
  isDark: boolean;
  conversation: ConversationDTO | null;
  members: GroupMember[];
  linkedTasks: TaskDTO[];
  recentAssets: AssetDTO[];
  onSearch: () => void;
  onOpenAssets?: () => void;
  onToggleMembers: () => void;
}) {
  const { t } = useI18n();
  const title =
    conversation?.displayTitle?.trim() ||
    conversation?.title?.trim() ||
    (conversation?.type === 'direct' ? t('workspace.session.direct') : t('workspace.session.workspace'));
  const working = linkedTasks.filter((task) => task.status === 'running' || task.status === 'review').length;
  const total = linkedTasks.length;
  const completed = linkedTasks.filter((task) => task.status === 'completed').length;
  const lastActiveAt = conversation?.lastMessageAt ? formatDateDivider(conversation.lastMessageAt, t) : null;

  return (
    <section className="mx-auto flex min-h-full w-full max-w-[520px] flex-col px-1 py-2">
      <div
        className={`rounded-2xl border p-4 ${
          isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
              isDark ? 'bg-violet-500/12 text-violet-200' : 'bg-violet-50 text-violet-700'
            }`}
          >
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={`truncate text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>
              {title}
            </h3>
            <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {conversation
                ? `${conversation.type === 'direct' ? t('workspace.session.direct') : t('workspace.session.group')}${
                    lastActiveAt ? ` - ${t('workspace.session.lastActive', { time: lastActiveAt })}` : ''
                  }`
                : t('workspace.session.noSessionSelected')}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <DetailStat isDark={isDark} label={t('workspace.session.members')} value={String(members.length)} />
        <DetailStat isDark={isDark} label={t('workspace.session.activeTasks')} value={String(working)} />
        <DetailStat isDark={isDark} label={t('workspace.session.completed')} value={String(completed)} />
      </div>

      <div
        className={`mt-3 w-full overflow-hidden rounded-2xl border ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
      >
        <DetailsRow
          isDark={isDark}
          icon={<Search className="h-4 w-4" />}
          label={t('workspace.session.searchMessages')}
          onClick={onSearch}
        />
        <DetailsRow
          isDark={isDark}
          icon={<Users className="h-4 w-4" />}
          label={t('workspace.session.members')}
          detail={`${members.length}`}
          onClick={onToggleMembers}
        />
        <DetailsRow
          isDark={isDark}
          icon={<ImageIcon className="h-4 w-4" />}
          label={t('workspace.session.recentAssets')}
          detail={t('workspace.session.recentCount', { count: recentAssets.length })}
          onClick={onOpenAssets}
        />
        <DetailsRow
          isDark={isDark}
          icon={<Target className="h-4 w-4" />}
          label={t('workspace.session.linkedTasks')}
          detail={`${total}`}
        />
      </div>
    </section>
  );
}

function DetailStat({ isDark, label, value }: { isDark: boolean; label: string; value: string }) {
  return (
    <div
      className={`rounded-2xl border px-3 py-2 ${
        isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white'
      }`}
    >
      <p className={`text-[10px] font-semibold uppercase ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
      <p className={`mt-1 text-lg font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-950'}`}>{value}</p>
    </div>
  );
}

function DetailsRow({
  isDark,
  icon,
  label,
  detail,
  onClick,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex h-12 w-full items-center gap-3 border-b px-4 text-left last:border-b-0 disabled:cursor-default ${
        isDark
          ? 'border-white/[0.06] text-zinc-200 enabled:hover:bg-white/[0.04]'
          : 'border-zinc-200 text-zinc-900 enabled:hover:bg-zinc-50'
      }`}
    >
      <span className={isDark ? 'text-zinc-400' : 'text-zinc-700'}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
      {detail ? <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{detail}</span> : null}
      {onClick ? <ChevronRight className={`h-4 w-4 shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} /> : null}
    </button>
  );
}

type TypingExpandTier = 0 | 3 | 10;

function TypingRow({ status, isDark }: { status: AgentTaskStatus; isDark: boolean }) {
  const label = status.phase === 'executing' ? 'Executing' : 'Thinking';
  const detail = status.message?.trim();
  const progressPct = typeof status.progress === 'number' ? Math.round(status.progress * 100) : null;
  // 2026-05-24 — three-tier expand. Click cycles 3 → 10 → 0 → 3. When > 0
  // the row polls /tasks/:id/timeline every 2s for fresh steps.
  // 2026-05-29 (C3) — default flipped 0 → 3 per user complaint that the
  // typing row had degraded to a featureless "EXECUTING · 99% · terminal"
  // chip with no action detail. Earlier builds surfaced the live
  // tool_call / reasoning_chunk stream by default; restoring that as the
  // baseline so users see "what the agent is doing right now" without
  // an extra click. Collapsed (0) is still reachable via the cycle.
  const [expand, setExpand] = useState<TypingExpandTier>(3);
  const cycleExpand = useCallback(() => {
    setExpand((prev) => (prev === 3 ? 10 : prev === 10 ? 0 : 3));
  }, []);
  return (
    <motion.div
      data-testid={`agent-typing-${status.taskId}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={springSoft}
      className="mt-3 flex w-full justify-start gap-2.5"
    >
      <div className="w-8 shrink-0 pt-2">
        <span
          className={`inline-flex h-7 w-7 items-center justify-center rounded-xl text-white shadow-sm ${
            isDark
              ? 'bg-gradient-to-br from-violet-500/40 via-fuchsia-500/30 to-cyan-400/30'
              : 'bg-gradient-to-br from-violet-500 to-cyan-500'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="flex min-w-0 max-w-[82%] flex-col items-start">
        <div
          role="button"
          tabIndex={0}
          onClick={cycleExpand}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              cycleExpand();
            }
          }}
          aria-expanded={expand > 0}
          data-testid={`agent-typing-toggle-${status.taskId}`}
          data-expand-tier={expand}
          className={`relative cursor-pointer overflow-hidden rounded-[22px] rounded-bl-md border px-3.5 py-2.5 text-left backdrop-blur-xl transition-colors ${
            isDark
              ? 'border-white/[0.08] bg-white/[0.05] text-zinc-200 hover:bg-white/[0.08]'
              : 'border-zinc-200/80 bg-white/85 text-zinc-700 hover:bg-white'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1" aria-hidden>
              <Dot delay={0} isDark={isDark} />
              <Dot delay={0.15} isDark={isDark} />
              <Dot delay={0.3} isDark={isDark} />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider">
              {label}
              {progressPct != null ? ` · ${progressPct}%` : ''}
            </span>
            <span aria-hidden className={`ml-1 text-[10px] tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {expand === 3 ? '+ more' : expand === 10 ? 'collapse' : '+ steps'}
            </span>
          </div>
          {detail ? (
            <p className={`mt-1 text-[13px] leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{detail}</p>
          ) : null}
        </div>
        {expand > 0 ? <TypingExpand taskId={status.taskId} limit={expand} isDark={isDark} /> : null}
      </div>
    </motion.div>
  );
}

/**
 * Live mini-feed that polls /tasks/:id/timeline every 2s and renders the
 * tail (most recent) up to `limit`. Backs off the polling if the request
 * fails twice in a row — a long-stuck task shouldn't hammer the cloud.
 *
 * Visual: low-saturation rows. For tool_use we surface tool name; for
 * reasoning_chunk we show the latest fragment text faded; phase_change
 * gets a compact "→ name" marker.
 */
function TypingExpand({ taskId, limit, isDark }: { taskId: string; limit: TypingExpandTier; isDark: boolean }) {
  const [steps, setSteps] = useState<ActivityTimelineStep[]>([]);
  const [resolvedRunId, setResolvedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve IMTaskRun.id once per taskId; fall back to taskId so the
  // legacy-agent-run path still works (same trick InlineActivityStream
  // used to use before it was removed).
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    void resolveLatestTaskRunId({ taskId, signal: ctrl.signal })
      .then((runId) => {
        if (cancelled) return;
        setResolvedRunId(runId ?? taskId);
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedRunId(taskId);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [taskId]);

  useEffect(() => {
    if (!resolvedRunId) return;
    let cancelled = false;
    let failCount = 0;
    const tick = async () => {
      const ctrl = new AbortController();
      try {
        const res = await fetchTaskTimeline({ taskRunId: resolvedRunId, limit, signal: ctrl.signal });
        if (cancelled) return;
        if (!res.ok) {
          failCount += 1;
          if (failCount >= 2) setError(res.message);
          return;
        }
        failCount = 0;
        setError(null);
        // Tail = newest `limit` rows. Server returns ascending, we keep the
        // last N for display so the most recent action stays at the bottom.
        const all = res.data.steps;
        setSteps(all.length > limit ? all.slice(-limit) : all);
      } catch {
        // AbortError on unmount is expected — silent.
      }
    };
    void tick();
    const id = window.setInterval(() => {
      if (failCount >= 2) return; // backed off until next tier change
      void tick();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [resolvedRunId, limit]);

  const baseRow = `text-[11px] leading-snug ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`;
  return (
    <motion.div
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`mt-1.5 w-full max-w-full overflow-hidden rounded-xl border px-3 py-2 ${
        isDark ? 'border-white/[0.05] bg-white/[0.02]' : 'border-zinc-200/70 bg-white/40'
      }`}
      data-testid={`agent-typing-steps-${taskId}`}
    >
      {error || steps.length === 0 ? (
        // 2026-05-29 — collapse the "404 Task not found" surface to the same
        // empty-state copy. 404 here means the user clicked into an IMTask id
        // that has no IMTaskRun yet (sample task / un-dispatched seed). The
        // error string had no fix the user could take — surfacing it as
        // bright red prose just looked broken. Silent "waiting" is correct.
        <p className={baseRow}>等待动作…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {steps.map((step) => (
            <li key={step.id} className={baseRow}>
              <TypingStepRow step={step} isDark={isDark} />
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function TypingStepRow({ step, isDark }: { step: ActivityTimelineStep; isDark: boolean }) {
  // Render rules per step kind. All low-saturation — this is a sub-feed
  // beneath the primary chip, not a focal artifact.
  const payload = (step.payloadJson ?? {}) as Record<string, unknown>;
  const occurred = new Date(step.occurredAt);
  const ts = `${String(occurred.getHours()).padStart(2, '0')}:${String(occurred.getMinutes()).padStart(2, '0')}:${String(occurred.getSeconds()).padStart(2, '0')}`;
  const tone = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const subtle = isDark ? 'text-zinc-600' : 'text-zinc-400';
  let body: string;
  if (step.kind === 'tool_call' || step.kind === 'tool_start' || step.kind === 'tool_use') {
    const tool =
      typeof payload.tool === 'string' ? payload.tool : typeof payload.name === 'string' ? payload.name : 'tool';
    body = `→ ${tool}`;
  } else if (step.kind === 'tool_result' || step.kind === 'tool_completed') {
    const tool = typeof payload.tool === 'string' ? payload.tool : 'tool';
    body = `✓ ${tool}`;
  } else if (step.kind === 'reasoning_chunk' || step.kind === 'reasoning') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    body = text.length > 120 ? `${text.slice(0, 120)}…` : text || 'reasoning…';
  } else if (step.kind === 'phase_change') {
    const to = typeof payload.to === 'string' ? payload.to : typeof payload.phase === 'string' ? payload.phase : '';
    body = to ? `phase → ${to}` : 'phase change';
  } else if (step.kind === 'progress') {
    const msg = typeof payload.message === 'string' ? payload.message : '';
    body = msg || 'progress';
  } else if (step.kind === 'error') {
    const msg = typeof payload.message === 'string' ? payload.message : 'error';
    body = `✗ ${msg}`;
  } else {
    body = step.kind;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={`shrink-0 font-mono text-[10px] ${subtle}`}>{ts}</span>
      <span className={`min-w-0 flex-1 truncate ${tone}`}>{body}</span>
    </span>
  );
}

function Dot({ delay, isDark }: { delay: number; isDark: boolean }) {
  return (
    <motion.span
      className={`inline-block h-1.5 w-1.5 rounded-full ${isDark ? 'bg-violet-300' : 'bg-violet-500'}`}
      initial={{ opacity: 0.35, y: 0 }}
      animate={{ opacity: [0.35, 1, 0.35], y: [0, -2, 0] }}
      transition={{ duration: 0.9, repeat: Infinity, delay, ease: 'easeInOut' }}
    />
  );
}

function DateDivider({ label, isDark }: { label: string; isDark: boolean }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className={`h-px flex-1 ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
      <span className={`text-[10px] uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        {label}
      </span>
      <span className={`h-px flex-1 ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
    </div>
  );
}

function MessageRow({
  message,
  member,
  showSender,
  isOwn,
  isDark,
  assets,
  files,
  onOpenTask,
  onOpenAsset,
  triggerStatus,
  dispatchFailed,
  linkedTaskIds,
  agentTypeByImUserId,
  usernameByImUserId,
  agentUsernames,
  agentStatuses,
  deliveryState,
  taskPhaseMap,
  stageMode = false,
  onRetryMessage,
  onSaveAsMemory,
  onForwardRequest,
  notify,
  selfAvatarUrl,
}: {
  message: MessageDTO;
  member?: GroupMember;
  showSender: boolean;
  isOwn: boolean;
  isDark: boolean;
  /** Current user's uploaded avatar — rendered on the own-message side. */
  selfAvatarUrl?: string | null;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  onOpenTask?: (taskId: string) => void;
  onOpenAsset?: (assetId: string) => void;
  triggerStatus?: TaskStatusEventInfo;
  /** Set when this message triggered a dispatch that failed (agent offline / no profile / etc). */
  dispatchFailed?: DispatchFailedEventInfo;
  /** TaskIds that resolve to a real kanban card in this conversation. */
  linkedTaskIds?: ReadonlySet<string>;
  /** Forwarded down for the message-bubble avatar's role icon. */
  agentTypeByImUserId?: Record<string, string>;
  /** imUserId → ASCII username — reliable role-icon source for the message avatar. */
  usernameByImUserId?: Record<string, string>;
  /** Known agent usernames — detects agent senders by member username past the id divergence. */
  agentUsernames?: Set<string>;
  /** Task 3 — agent live-status map for ring + hover popover. */
  agentStatuses?: Map<string, AgentLiveStatus>;
  /**
   * P1 (Debug Pipeline) — pre-derived lifecycle row for this message,
   * or null when no task is linked. The chip falls back to the legacy
   * "Sent" label when null.
   */
  deliveryState?: MessageDeliveryState | null;
  /** Workspace-wide phase rows — forwarded to the chip popover. */
  taskPhaseMap?: Map<string, AgentPhaseRow>;
  /** Chat-first workspace stage: wider timeline rules and less side-panel chrome. */
  stageMode?: boolean;
  /** Host-supplied retry callback for failed/timeout deliveries. */
  onRetryMessage?: (messageId: string) => void;
  /**
   * Auto-saves the message as a memory page (no modal). Host implements the
   * actual `createMemoryPage` call with workspace defaults — see page.tsx.
   */
  onSaveAsMemory?: () => void;
  /**
   * Opens the forward picker dialog. Host owns the conversation list +
   * `sendMessage` plumbing; the bubble only passes up the resolved sender
   * display name (which the host doesn't have access to).
   */
  onForwardRequest?: (senderName: string) => void;
  notify?: (message: string, type: 'success' | 'error' | 'info') => void;
}) {
  const { t } = useI18n();
  const senderName = isOwn
    ? t('workspace.session.you')
    : member?.displayName || member?.username || message.senderId.slice(-10);
  const contentType = message.contentType ?? message.type ?? 'text';

  // Agent-sender detection + role-icon source resolution (release202/09 avatar
  // consistency). A sender is an agent if its id is in the agentType map OR —
  // when the message `senderId` is a duplicate im_users row not in that map
  // (cloudUserId numericId-vs-userId divergence) — its conversation member
  // username matches a known agent username. `senderUsername` is the reliable
  // role-icon source (agentType is a generic tier; localized names never
  // match): prefer the member's username, fall back to the username map keyed
  // by the sender id. Only genuinely human senders fall through to initials.
  const senderUsername = usernameByImUserId?.[message.senderId] ?? member?.username ?? null;
  const senderIsAgent =
    Boolean(agentTypeByImUserId?.[message.senderId]) ||
    Boolean(member?.username && agentUsernames?.has(member.username));

  // Quick-action handlers for the action bar below each bubble.
  // The bar only renders for text content — for attachments / system / agent
  // payloads the semantics of "copy the message" are ambiguous.
  const plainText = typeof message.content === 'string' ? message.content : '';
  const showQuickActions = (contentType === 'text' || contentType === 'markdown') && plainText.trim().length > 0;

  const onCopyMessage = async () => {
    const res = await copyText(plainText);
    if (res.ok) notify?.(t('workspace.session.copiedToClipboard'), 'success');
    else notify?.(res.error ?? t('workspace.session.copyFailed'), 'error');
  };
  // Forward = open the host's target-picker dialog. The handler resolves the
  // sender display name from in-bubble scope (the host doesn't have member
  // membership maps) and lets the host own the conversation list + POST.
  const onForwardClick = onForwardRequest ? () => onForwardRequest(senderName) : undefined;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.985, filter: 'blur(4px)' }}
      animate={{ opacity: message.pending ? 0.62 : 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      transition={springSoft}
      className={`group/message flex w-full gap-2.5 ${isOwn ? 'justify-end' : 'justify-start'} ${showSender ? (stageMode ? 'mt-4' : 'mt-3') : 'mt-1'}`}
    >
      {!isOwn ? (
        <div className="w-8 shrink-0 pt-5">
          {showSender ? (
            senderIsAgent ? (
              <AgentAvatar
                agent={{
                  agentId: message.senderId,
                  userId: message.senderId,
                  name: senderName,
                  username: senderUsername ?? undefined,
                  agentType: agentTypeByImUserId?.[message.senderId],
                }}
                avatarUrl={member?.avatarUrl}
                status={agentStatuses?.get(message.senderId) ?? null}
                size="sm"
                isDark={isDark}
              />
            ) : (
              <Avatar seed={message.senderId} label={senderName} isAgent={false} avatarUrl={member?.avatarUrl} />
            )
          ) : null}
        </div>
      ) : null}
      {/*
        Outer column owns the row's max-width budget. 2026-05-29 fix per
        doc 21 §B: user message stays narrow (read-comfortable right-aligned
        chat) while agent message takes a wider budget — it carries the
        InlineActivityStrip + body + footer triad and needs the horizontal
        room. mobile (<768px) keeps the legacy 82% cap so neither side
        crowds the viewport.
          - isOwn (user):  ≤ 70% / 720px desktop, 82% mobile fallback
          - !isOwn (agent): ≤ 94% / 1100px desktop, 82% mobile fallback
        stageMode tightens the agent cap to 1000px so the strip stays
        visually anchored when the chat fills the workspace stage.
      */}
      <div
        className={`flex min-w-0 flex-col overflow-hidden ${
          isOwn
            ? 'max-w-[82%] md:max-w-[min(70%,720px)]'
            : stageMode
              ? 'max-w-[82%] md:max-w-[min(94%,1000px)]'
              : 'max-w-[82%] md:max-w-[min(94%,1100px)]'
        } ${isOwn ? 'items-end' : 'items-start'}`}
      >
        <div className={`flex min-w-0 max-w-full flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
          {showSender ? (
            <div
              className={`mb-1 flex max-w-full items-baseline gap-2 px-1 ${isOwn ? 'justify-end' : 'justify-start'}`}
            >
              {!isOwn ? (
                <span className={`truncate text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {senderName}
                </span>
              ) : null}
              <time
                className={`shrink-0 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}
                dateTime={message.createdAt}
              >
                {formatMessageTime(message.createdAt)}
              </time>
              {message.failed ? (
                <span
                  className={`flex items-center gap-1 text-[10px] ${isDark ? 'text-rose-300' : 'text-rose-600'}`}
                  title={t('workspace.session.failedToSend')}
                >
                  <AlertCircle className="h-3 w-3" /> {t('workspace.session.failed')}
                </span>
              ) : null}
            </div>
          ) : null}
          <div
            data-testid={`im-message-bubble-${message.id}`}
            className={`relative min-w-0 max-w-full overflow-hidden border px-3.5 py-2.5 shadow-[0_18px_60px_-35px_rgba(15,23,42,0.8)] backdrop-blur-xl [overflow-wrap:anywhere] ${
              isOwn
                ? `rounded-[22px] rounded-br-md ${
                    isDark
                      ? 'border-cyan-300/20 bg-gradient-to-br from-violet-500/30 via-fuchsia-500/20 to-cyan-400/25 text-white'
                      : 'border-violet-200/80 bg-gradient-to-br from-violet-500 to-cyan-500 text-white shadow-violet-500/20'
                  }`
                : `rounded-[22px] rounded-bl-md ${
                    isDark
                      ? 'border-white/[0.08] bg-white/[0.055] text-zinc-100'
                      : 'border-zinc-200/80 bg-white/85 text-zinc-900 shadow-zinc-200/70'
                  }`
            }`}
          >
            {/* v2.0 §4.6 (Wave 4 E5) — when the server surfaces ContentBlock[]
                for this message, the new dispatcher takes over the bubble
                body (text + image + audio + video + file + tool_use +
                tool_result + reasoning). Otherwise we fall back to the
                legacy MessageBody + MessageAssetAttachment path (string
                content + attachments JSON). Migration 406 keeps both
                columns; double-write window per spec is 6 sprints. */}
            <MessageBubbleBody message={message} contentType={contentType} isOwn={isOwn} isDark={isDark} />
            <MessagePrismerLinks
              message={message}
              assets={assets}
              files={files}
              isDark={isDark}
              inOwnBubble={isOwn}
              onOpenAsset={onOpenAsset}
            />
            {extractContentBlocks(message) == null ? (
              <MessageAssetAttachment message={message} isDark={isDark} inOwnBubble={isOwn} onOpenAsset={onOpenAsset} />
            ) : null}
            <MessageTaskLinks message={message} isDark={isDark} inOwnBubble={isOwn} onOpenTask={onOpenTask} />
          </div>
          {showQuickActions ? (
            // 2026-05-29 — replace `hidden ↔ block` with permanent ghost
            // (opacity 30 / hover-100). The display toggle was the cause of
            // the "message list shifts every time I hover" complaint:
            // hiding a 24px row from layout reflows everything below it.
            // Permanent reservation + opacity keeps the layout stable; the
            // 30% ghost stays discoverable without competing with body text.
            <div
              className={
                stageMode
                  ? 'opacity-40 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100'
                  : ''
              }
            >
              <MessageQuickActions
                isDark={isDark}
                isOwn={isOwn}
                onCopy={() => void onCopyMessage()}
                onForward={onForwardClick}
                onSave={onSaveAsMemory}
              />
            </div>
          ) : null}
        </div>
        <MessageActionBar
          message={message}
          isDark={isDark}
          onOpenTask={onOpenTask}
          linkedTaskIds={linkedTaskIds}
          stageMode={stageMode}
        />
        {/* 2026-05-25 — MessageTriggerStatusChip removed; DeliveryTimelineChip
            below covers the same data (and more — ack/working/timeout, not
            just terminal system_events) with a click-to-expand popover. Two
            chips for the same task state was visually confusing
            (大 amber pill + 小 chip + standalone bubble = 三层重复). The
            standalone system_event bubble below in the message list still
            serves as the conversation-timeline audit trail. */}
        {dispatchFailed ? (
          <MessageDispatchFailedChip triggerMessageId={message.id} event={dispatchFailed} isDark={isDark} />
        ) : null}
        {!showSender ? null : isOwn && !message.failed ? (
          <span className="mt-1 px-1">
            <DeliveryTimelineChip
              state={deliveryState ?? null}
              isDark={isDark}
              pending={Boolean(message.pending)}
              taskPhases={taskPhaseMap}
              onOpenTask={onOpenTask}
              onRetry={onRetryMessage ? () => onRetryMessage(message.id) : undefined}
            />
          </span>
        ) : null}
      </div>
      {isOwn ? (
        <div className="w-8 shrink-0 pt-5">
          {showSender ? (
            // Own-message avatar — the current user's uploaded image (or
            // initials fallback). Human fallback only: no role icon.
            <Avatar seed={message.senderId} label={senderName} isAgent={false} avatarUrl={selfAvatarUrl ?? null} />
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

// Wave-8 W7 — small status chip rendered on the user's trigger message
// (the message whose @-mention created the task that just reached a
// terminal state). Complementary to TaskStatusEventRow which shows the
// centred system row.
function MessageTriggerStatusChip({
  triggerMessageId,
  event,
  isDark,
  onOpenTask,
}: {
  triggerMessageId: string;
  event: TaskStatusEventInfo;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const palette =
    event.status === 'completed'
      ? isDark
        ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : event.status === 'failed'
        ? isDark
          ? 'border-rose-300/30 bg-rose-500/10 text-rose-200'
          : 'border-rose-200 bg-rose-50 text-rose-700'
        : // doc 12 (2026-05-22) — awaiting_approval uses amber so it
          // visually distinguishes "the agent did its job; humans, your
          // turn" from a hard failure (rose) or a quiet cancel (zinc).
          event.status === 'awaiting_approval'
          ? isDark
            ? 'border-amber-300/30 bg-amber-500/10 text-amber-200'
            : 'border-amber-200 bg-amber-50 text-amber-700'
          : isDark
            ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-300'
            : 'border-zinc-200 bg-zinc-50 text-zinc-600';
  const Icon =
    event.status === 'completed'
      ? Check
      : event.status === 'failed'
        ? X
        : event.status === 'awaiting_approval'
          ? Hourglass
          : CircleSlash;
  const noun = event.kind === 'agent' ? t('workspace.session.agentNoun') : t('workspace.session.taskNoun');
  const label =
    event.status === 'completed'
      ? t('workspace.session.statusCompleted', { noun })
      : event.status === 'failed'
        ? t('workspace.session.statusFailed', { noun })
        : event.status === 'awaiting_approval'
          ? t('workspace.session.waitingForHumanApproval')
          : t('workspace.session.statusCancelled', { noun });
  const clickable = event.kind === 'task' && Boolean(onOpenTask);
  const taskTitle = event.taskTitle || t('workspace.session.taskNoun').toLowerCase();
  return (
    <button
      type="button"
      onClick={() => {
        if (event.kind === 'task') onOpenTask?.(event.taskId);
      }}
      disabled={!clickable}
      data-testid={`message-trigger-status-${triggerMessageId}`}
      data-status={event.status}
      data-task-id={event.taskId}
      className={`mt-1 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${palette} disabled:cursor-default disabled:opacity-80`}
      title={clickable ? t('workspace.session.openNamed', { name: taskTitle }) : event.taskTitle || label}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

/**
 * Inline chip rendered on the user's trigger message when the @-mention
 * couldn't be delivered (agent offline / no profile / daemon unreachable).
 * Replaces the bare `[system_event]` bubble the cloud used to emit. The
 * full error text is exposed via `title=` so power users can hover for
 * the diagnostic.
 */
function MessageDispatchFailedChip({
  triggerMessageId,
  event,
  isDark,
}: {
  triggerMessageId: string;
  event: DispatchFailedEventInfo;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const palette = isDark
    ? 'border-amber-300/30 bg-amber-500/10 text-amber-200'
    : 'border-amber-200 bg-amber-50 text-amber-800';
  return (
    <span
      data-testid={`message-dispatch-failed-${triggerMessageId}`}
      title={event.errorMessage || t('workspace.session.agentDidNotReceive')}
      className={`mt-1 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${palette}`}
    >
      <AlertCircle className="h-3 w-3" />
      <span>{t('workspace.session.deliveryFailedAgentOffline')}</span>
    </span>
  );
}

// Wave-8 W7 — centred chip row rendered for terminal status system messages.
// Distinct from regular MessageRow: no avatar, no sender label, no bubble —
// just a horizontal pill that floats in the middle of the feed.
// Exported for unit testing (release201/26 §8 Phase 4 strip coverage).
export function TaskStatusEventRow({
  event,
  isDark,
  onOpenTask,
  onRetryRun,
}: {
  event: TaskStatusEventInfo;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
  // release201/26 §8 Phase 4 — retry a run whose daemon resume failed.
  onRetryRun?: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const palette =
    event.status === 'completed'
      ? isDark
        ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100'
        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : event.status === 'failed'
        ? isDark
          ? 'border-rose-300/30 bg-rose-500/10 text-rose-100'
          : 'border-rose-200 bg-rose-50 text-rose-800'
        : // resume_failed shares amber with awaiting_approval — both are
          // non-terminal "needs a human nudge" states, distinct from a hard
          // red failure. The RotateCcw icon + "点击重试" label disambiguates.
          event.status === 'awaiting_approval' || event.status === 'resume_failed'
          ? isDark
            ? 'border-amber-300/30 bg-amber-500/10 text-amber-100'
            : 'border-amber-200 bg-amber-50 text-amber-800'
          : isDark
            ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-200'
            : 'border-zinc-200 bg-zinc-50 text-zinc-700';
  const StatusIcon =
    event.status === 'completed'
      ? CheckCircle2
      : event.status === 'failed'
        ? XCircle
        : event.status === 'resume_failed'
          ? RotateCcw
          : event.status === 'awaiting_approval'
            ? Hourglass
            : Ban;
  const noun = event.kind === 'agent' ? t('workspace.session.agentNoun') : t('workspace.session.taskNoun');
  const label =
    event.status === 'completed'
      ? t('workspace.session.statusCompleted', { noun })
      : event.status === 'failed'
        ? t('workspace.session.statusFailed', { noun })
        : event.status === 'resume_failed'
          ? t('workspace.session.statusResumeFailed')
          : event.status === 'awaiting_approval'
            ? t('workspace.session.waitingForHumanApproval')
            : t('workspace.session.statusCancelled', { noun });
  const titleText =
    event.kind === 'agent' ? event.taskTitle || event.taskId.slice(-8) : event.taskTitle || event.taskId.slice(-8);
  // resume_failed is always clickable → fires retry. Other statuses keep the
  // existing open-task behaviour (task-kind only).
  const isResumeFailed = event.status === 'resume_failed';
  const clickable = isResumeFailed ? Boolean(onRetryRun) : event.kind === 'task' && Boolean(onOpenTask);

  // Long-error path: when a failure carries a multi-line error message
  // (typical for capability gates / daemon retry summaries), render a
  // wider wrap-friendly card with an explicit copy button instead of the
  // single-line truncated pill. Short successes / cancellations keep the
  // compact pill so the timeline stays scannable.
  const isLongError =
    (event.status === 'failed' || event.status === 'resume_failed') &&
    Boolean(event.error) &&
    (event.error?.length ?? 0) > 40;

  if (isLongError) {
    return (
      <div className="my-2 flex w-full justify-center" data-testid={`${event.kind}-status-event-${event.taskId}`}>
        <ErrorEventCard
          isDark={isDark}
          palette={palette}
          StatusIcon={StatusIcon}
          label={label}
          titleText={titleText}
          taskId={event.taskId}
          error={event.error ?? ''}
          isResumeFailed={isResumeFailed}
          clickable={clickable}
          onPrimary={() => {
            if (isResumeFailed) onRetryRun?.(event.taskId);
            else if (event.kind === 'task') onOpenTask?.(event.taskId);
          }}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className="my-2 flex w-full justify-center" data-testid={`${event.kind}-status-event-${event.taskId}`}>
      <button
        type="button"
        onClick={() => {
          if (isResumeFailed) {
            onRetryRun?.(event.taskId);
          } else if (event.kind === 'task') {
            onOpenTask?.(event.taskId);
          }
        }}
        disabled={!clickable}
        data-status={event.status}
        data-task-id={event.taskId}
        className={`inline-flex max-w-[80%] items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur transition-colors ${palette} disabled:cursor-default disabled:opacity-90`}
        title={
          isResumeFailed
            ? t('workspace.session.statusResumeFailed')
            : clickable
              ? t('workspace.session.openNamed', { name: titleText })
              : titleText
        }
      >
        <StatusIcon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
        <span>{label}:</span>
        <span className="truncate">{titleText}</span>
        {(event.status === 'failed' || event.status === 'resume_failed') && event.error ? (
          <span className={`truncate text-[10px] opacity-80`}>· {event.error}</span>
        ) : null}
      </button>
    </div>
  );
}

function ErrorEventCard({
  isDark,
  palette,
  StatusIcon,
  label,
  titleText,
  taskId,
  error,
  isResumeFailed,
  clickable,
  onPrimary,
  t,
}: {
  isDark: boolean;
  palette: string;
  StatusIcon: typeof XCircle;
  label: string;
  titleText: string;
  taskId: string;
  error: string;
  isResumeFailed: boolean;
  clickable: boolean;
  onPrimary: () => void;
  t: (key: 'workspace.session.statusResumeFailed') => string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const payload = `${label}: ${titleText} (${taskId})\n${error}`;
  const onCopy = useCallback(async () => {
    const res = await copyText(payload);
    if (res.ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }, [payload]);

  const lineCount = error.split('\n').length + Math.ceil(error.length / 100);
  const showExpander = lineCount > 3;
  const errorClass = expanded || !showExpander ? 'whitespace-pre-wrap' : 'line-clamp-3 whitespace-pre-wrap';

  return (
    <div
      className={`w-full max-w-[680px] rounded-2xl border px-3 py-2 text-xs ${palette}`}
      data-status={isResumeFailed ? 'resume_failed' : 'failed'}
      data-task-id={taskId}
    >
      <div className="flex items-start gap-2">
        <StatusIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate font-semibold">
              {label}: <span className="font-normal opacity-80">{titleText}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void onCopy()}
                aria-label="Copy error"
                title="复制错误"
                className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-zinc-900/5'
                }`}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
              {clickable ? (
                <button
                  type="button"
                  onClick={onPrimary}
                  className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                    isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-zinc-900/5 hover:bg-zinc-900/10'
                  }`}
                >
                  {isResumeFailed ? t('workspace.session.statusResumeFailed') : '打开任务'}
                </button>
              ) : null}
            </div>
          </div>
          <p className={`mt-1 break-words text-[11px] leading-relaxed opacity-90 ${errorClass}`}>{error}</p>
          {showExpander ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-[10px] font-medium underline-offset-2 hover:underline"
            >
              {expanded ? '收起' : '展开全部'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface TaskLogEntry {
  id: string;
  taskId: string;
  actorId: string;
  action: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface TaskLogResponse {
  task: { id: string; status: string; durationMs?: number | null; completedAt?: string | null; createdAt: string };
  logs: TaskLogEntry[];
}

interface TaskRunEventEntry {
  id: string;
  runId: string;
  taskId: string | null;
  actorId: string | null;
  type: string;
  level: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface TaskRunResponse {
  run: { id: string; status: string; completedAt?: string | null; createdAt: string };
  events: TaskRunEventEntry[];
}

interface MessageActionEntry {
  id: string;
  kind: string;
  event: string | null;
  tool: string | null;
  summary: string | null;
  text: string | null;
  message: string | null;
  createdAt: string;
  arguments: unknown;
  result: unknown;
}

/**
 * Per-bubble quick-action strip — Copy / Forward / Save (memory).
 *
 * Renders below the bubble for text/markdown messages only. The previous
 * right-click "Save as memory" affordance was removed at the product's
 * request; these explicit buttons replace it. Save is one-click + toast,
 * no modal — host (page.tsx) implements the actual `createMemoryPage`
 * call.
 */
function MessageQuickActions({
  isDark,
  isOwn,
  onCopy,
  onForward,
  onSave,
}: {
  isDark: boolean;
  isOwn: boolean;
  onCopy: () => void;
  onForward?: () => void;
  onSave?: () => void;
}) {
  const { t } = useI18n();
  const btn = (label: string, onClick: () => void, Icon: typeof Copy, testId: string, disabled = false) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={label}
      aria-label={label}
      data-testid={testId}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        isDark
          ? 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
          : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  return (
    <div
      className={`mt-1 flex items-center gap-0.5 ${isOwn ? 'justify-end' : 'justify-start'}`}
      data-testid="im-message-quick-actions"
    >
      {btn(t('workspace.session.copyMessage'), onCopy, Copy, 'im-msg-action-copy')}
      {btn(
        t('workspace.session.forwardMessage'),
        onForward ?? (() => {}),
        Forward,
        'im-msg-action-forward',
        !onForward,
      )}
      {btn(t('workspace.session.saveToMemory'), onSave ?? (() => {}), Bookmark, 'im-msg-action-save', !onSave)}
    </div>
  );
}

function MessageActionBar({
  message,
  isDark,
  onOpenTask,
  linkedTaskIds,
  stageMode = false,
}: {
  message: MessageDTO;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
  /** When provided, "Open card" only renders for taskIds that resolve to a
   *  real kanban card. Without this, every agent_reply gets the chip even
   *  when the run was an internal/already-deleted task. */
  linkedTaskIds?: ReadonlySet<string>;
  stageMode?: boolean;
}) {
  const { t } = useI18n();
  const meta = useMemo(() => normalizeMetadata(message.metadata), [message.metadata]);
  const isAgentReply = meta.kind === 'agent_reply';
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<TaskLogEntry[] | null>(null);
  const [taskMeta, setTaskMeta] = useState<TaskLogResponse['task'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runActions, setRunActions] = useState<MessageActionEntry[] | null>(null);
  // Set after the first fetch reveals: 404 (task gone) or 0 progress logs.
  // When true, the entire action bar disappears so the user isn't left with
  // a dead "Show actions" chip that pops a "Failed" or "No tool actions"
  // banner on every click.
  const [actionsUnavailable, setActionsUnavailable] = useState(false);

  const actions = useMemo(() => {
    if (runActions) return runActions;
    if (!logs) return [];
    return logs
      .filter((log) => log.action === 'progress')
      .map((log) => {
        const detailMeta = log.metadata ?? {};
        const kind = typeof detailMeta.kind === 'string' ? detailMeta.kind : 'tool';
        const tool = typeof detailMeta.tool === 'string' ? detailMeta.tool : null;
        const summary = typeof detailMeta.summary === 'string' ? detailMeta.summary : null;
        const text = typeof detailMeta.text === 'string' ? detailMeta.text : null;
        const previewVal = (detailMeta as { preview?: unknown }).preview;
        const previewStr =
          typeof previewVal === 'string'
            ? previewVal
            : previewVal != null
              ? JSON.stringify(previewVal).slice(0, 200)
              : null;
        return {
          id: log.id,
          kind,
          event: typeof detailMeta.event === 'string' ? detailMeta.event : null,
          tool,
          summary: summary ?? previewStr,
          text,
          message: log.message,
          createdAt: log.createdAt,
          arguments: detailMeta.arguments,
          result: detailMeta.result,
        };
      });
  }, [logs, runActions]);

  const onToggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (logs || runActions || !taskId) return;
    setLoading(true);
    setError(null);
    const runRes = await imFetch<TaskRunResponse>(`/tasks/runs/${taskId}`);
    if (runRes.ok) {
      setLoading(false);
      const fetchedEvents = runRes.data.events ?? [];
      const progressActions = fetchedEvents
        .filter((event) => event.type === 'run.progress' || event.type === 'run.dispatched')
        .map((event) => {
          const detailMeta = event.payload ?? {};
          const kind = typeof detailMeta.kind === 'string' ? detailMeta.kind : 'tool';
          const tool = typeof detailMeta.tool === 'string' ? detailMeta.tool : null;
          const summary = typeof detailMeta.summary === 'string' ? detailMeta.summary : null;
          const text = typeof detailMeta.text === 'string' ? detailMeta.text : null;
          const previewVal = (detailMeta as { preview?: unknown }).preview;
          const previewStr =
            typeof previewVal === 'string'
              ? previewVal
              : previewVal != null
                ? JSON.stringify(previewVal).slice(0, 200)
                : null;
          return {
            id: event.id,
            kind,
            event: typeof detailMeta.event === 'string' ? detailMeta.event : event.type,
            tool,
            summary: summary ?? previewStr,
            text,
            message: event.message,
            createdAt: event.createdAt,
            arguments: detailMeta.arguments,
            result: detailMeta.result,
          };
        });
      setRunActions(progressActions);
      setTaskMeta({
        id: runRes.data.run.id,
        status: runRes.data.run.status,
        completedAt: runRes.data.run.completedAt ?? null,
        createdAt: runRes.data.run.createdAt,
      });
      return;
    }

    const res = await imFetch<TaskLogResponse>(`/tasks/${taskId}`);
    setLoading(false);
    if (!res.ok) {
      setError(res.message || 'Unable to load actions');
      return;
    }
    const fetchedLogs = res.data.logs ?? [];
    setLogs(fetchedLogs);
    setTaskMeta(res.data.task ?? null);
  }, [expanded, logs, runActions, taskId]);

  if (!isAgentReply || !taskId) return null;
  const hasCard = !!linkedTaskIds && linkedTaskIds.has(taskId);
  // Don't null the component when expanded — if the fetch failed or had no
  // progress logs, the expanded panel below handles that (error / "no tool
  // calls"). Nulling mid-flight would swallow the feedback the user waited
  // for. Only skip rendering when fully collapsed with nothing to show.
  if (actionsUnavailable && !hasCard && !expanded) return null;

  const hasLoadedActions = actions.length > 0;
  const actionCount = logs || runActions ? actions.length : null;
  const durationLabel = taskMeta?.durationMs != null ? `${(taskMeta.durationMs / 1000).toFixed(1)}s` : null;
  const statusChipClass = isDark
    ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white/70 text-zinc-600 hover:bg-zinc-50';
  const showActionToggle = !stageMode || expanded || loading || hasLoadedActions;
  const showCardChip = hasCard && onOpenTask;
  if (stageMode && !showActionToggle && !showCardChip) return null;

  return (
    <div
      className={`mt-1.5 max-w-full flex-col overflow-hidden ${
        stageMode && !expanded ? 'hidden group-hover/message:flex group-focus-within/message:flex' : 'flex'
      }`}
    >
      {/*
        Chips lay out in a flex row that wraps only if the entire action
        bar (sized by the outer 82% row column, not the bubble) runs out
        of space. Each chip is whitespace-nowrap + shrink-0 so the label
        text never breaks across two lines.
      */}
      <div className="flex max-w-full flex-row flex-wrap items-center gap-1 overflow-hidden">
        {actionsUnavailable || !showActionToggle ? null : (
          <button
            type="button"
            onClick={() => void onToggle()}
            data-testid={`actionbar-toggle-${taskId}`}
            className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${statusChipClass}`}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>
              {actionCount == null
                ? loading
                  ? t('workspace.session.loadingActions')
                  : stageMode
                    ? t('workspace.session.actions')
                    : t('workspace.session.showActions')
                : t('workspace.session.actionCount', { count: actionCount })}
            </span>
            {durationLabel ? <span className="opacity-60">· {durationLabel}</span> : null}
          </button>
        )}
        {showCardChip ? (
          <button
            type="button"
            onClick={() => onOpenTask(taskId)}
            data-testid={`message-open-task-${taskId}`}
            className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${statusChipClass}`}
          >
            <MessageSquare className="h-3 w-3" />
            {t('workspace.session.openCard')}
          </button>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div
              className={`mt-1.5 rounded-2xl border px-3 py-2 text-[12px] ${
                isDark
                  ? 'border-white/[0.06] bg-white/[0.03] text-zinc-300'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-700'
              }`}
            >
              {error ? (
                <p className="text-rose-500">{t('workspace.session.failedWithMessage', { message: error })}</p>
              ) : loading ? (
                <p className="opacity-70">{t('common.loading')}…</p>
              ) : actions.length === 0 ? (
                <p className="opacity-70">{t('workspace.session.agentAnsweredNoTools')}</p>
              ) : (
                <ol className="space-y-2">
                  {actions.map((entry, idx) => (
                    <ActionRow key={entry.id} entry={entry} index={idx + 1} isDark={isDark} />
                  ))}
                </ol>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ActionRow({
  entry,
  index,
  isDark,
}: {
  entry: {
    id: string;
    kind: string;
    event: string | null;
    tool: string | null;
    summary: string | null;
    text: string | null;
    message: string | null;
    createdAt: string;
    arguments: unknown;
    result: unknown;
  };
  index: number;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isReasoning = entry.kind === 'reasoning';
  const Icon = isReasoning ? Brain : Wrench;
  const title = isReasoning
    ? t('workspace.session.reasoning')
    : entry.tool || entry.message || t('workspace.session.tool');
  const event = entry.event || (isReasoning ? 'reasoning.available' : 'tool');
  const headline = entry.summary || entry.text || entry.message || '';
  const hasDetail = entry.arguments != null || entry.result != null || (entry.text && entry.text !== headline);
  const ts = formatMessageTime(entry.createdAt);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex items-start gap-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        disabled={!hasDetail}
      >
        <span
          className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            isDark ? 'bg-white/[0.06] text-violet-200' : 'bg-violet-100 text-violet-700'
          }`}
        >
          <Icon className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`text-[10px] font-mono opacity-50 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {String(index).padStart(2, '0')}
            </span>
            <span className={`text-[12px] font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{title}</span>
            <span className="text-[10px] opacity-60">{event}</span>
            {ts ? <span className="ml-auto text-[10px] opacity-50">{ts}</span> : null}
          </span>
          {headline ? <span className="block truncate text-[12px] opacity-80">{headline}</span> : null}
        </span>
        {hasDetail ? (
          <ChevronDown
            className={`mt-1 h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${
              isDark ? 'text-zinc-500' : 'text-zinc-400'
            }`}
          />
        ) : null}
      </button>
      {open && hasDetail ? (
        <div
          className={`ml-7 mt-1 rounded-lg border px-2 py-1.5 font-mono text-[11px] leading-relaxed ${
            isDark ? 'border-white/[0.06] bg-black/[0.25] text-zinc-300' : 'border-zinc-200 bg-white text-zinc-700'
          }`}
        >
          {entry.text && entry.text !== headline ? (
            <pre className="whitespace-pre-wrap break-words opacity-90">{entry.text}</pre>
          ) : null}
          {entry.arguments != null ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider opacity-60">
                {t('workspace.session.arguments')}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(entry.arguments, null, 2)}</pre>
            </details>
          ) : null}
          {entry.result != null ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider opacity-60">
                {t('workspace.session.result')}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words">
                {typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ─── Wave-8 W6 A6 — chat bubble asset thumbnails ─────────────────────────
//
// `MessageAssetAttachment` parses the `metadata.kind='workspace_asset_attachment'`
// envelope produced by `sendAssetAttachment` and renders a compact preview
// instead of the old generic file row. Mime → preview matrix:
//
//   image/*       → inline <img> (object-cover, max ~240×240)
//   video/*       → inline <video preload="metadata" muted> + play overlay
//   audio/*       → inline <audio controls>
//   application/pdf → file icon + filename + size (no inline render)
//   anything else → generic file icon + filename + size + mime
//
// Click on any preview/row calls `onOpenAsset(id)` which matches the same
// handler the linked-context strip uses (W10) — both surfaces converge on
// the workspace inspector dialog.
//
// Multiple attachments are supported via `metadata.attachments: [...]` (an
// array of the same shape as `metadata.asset`). Up to 4 attachments render;
// extras collapse into a "+N more" trailing chip.
//
// Image / video / audio bytes require an `Authorization: Bearer …` header
// (the `/api/im/assets/:id` route is auth-gated), so the component fetches
// with `getWorkspaceToken()` and feeds the `<img/video/audio src>` an
// object URL. This matches the inspector dialog's existing pattern.
// release201/30 Phase 2 — unified attachment-shape parser.
//
// Priority order (caller-facing → legacy):
//   1) `message.attachments[]` — Phase 1 dual-write output of
//      `populateFileMessageAttachments` (cloud-side). The new canonical shape.
//   2) `metadata.kind === 'workspace_asset_attachment'` single `asset`
//      blob, or `metadata.attachments: [...]` plural shape (legacy
//      sendAssetAttachment + forward-compat path).
//   3) `metadata.fileUrl` + `metadata.uploadId` (legacy SDK file message
//      that predates Phase 1 dual-write). One synthesised asset.
//
// Returned `MessageAsset` is the same surface the new `MessageAssetCard`
// renders against.
function parseAttachmentsFromMessage(message: MessageDTO): MessageAsset[] {
  const out: MessageAsset[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : typeof obj.assetId === 'string' ? obj.assetId : null;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const previewUrls =
      obj.previewUrls && typeof obj.previewUrls === 'object' ? (obj.previewUrls as MessageAsset['previewUrls']) : null;
    out.push({
      id,
      // We deliberately stop synthesising "[file]" / "[asset]" titles.
      // The card now reads `filename ?? mime ?? generic icon`, so a real
      // missing filename surfaces as the mime label instead of a noisy
      // bracketed placeholder.
      filename:
        typeof obj.title === 'string' && obj.title
          ? obj.title
          : typeof obj.filename === 'string' && obj.filename
            ? obj.filename
            : null,
      mime: typeof obj.mime === 'string' ? obj.mime : null,
      sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : null,
      cdnUrl: typeof obj.cdnUrl === 'string' ? obj.cdnUrl : null,
      thumbnailUrl: typeof obj.thumbnailUrl === 'string' ? obj.thumbnailUrl : null,
      previewUrls,
      blurHash: typeof obj.blurHash === 'string' && obj.blurHash ? obj.blurHash : null,
      previewText: typeof obj.previewText === 'string' && obj.previewText ? obj.previewText : null,
      source: 'attachment',
    });
  };
  if (Array.isArray(message.attachments)) {
    for (const item of message.attachments) push(item);
  }
  const meta = normalizeMetadata(message.metadata);
  if (meta.kind === 'workspace_asset_attachment' && typeof meta.asset === 'object') push(meta.asset);
  if (Array.isArray(meta.attachments)) {
    for (const item of meta.attachments) push(item);
  }
  // Legacy fallback — only when no attachments were resolved at all. The
  // synthesised asset has source='legacy-file-url' so the card knows to
  // skip the `/api/im/assets/{id}` auth-fetch (the id is a synthetic
  // legacy-{messageId} marker) and go straight to cdnUrl.
  if (out.length === 0) {
    const legacy = legacyFileUrlToAsset({ messageId: message.id, meta });
    if (legacy) out.push(legacy);
  }
  return out;
}

function attachmentKindFromMime(kind: string, mime: string | null): MessageAttachmentDTO['kind'] {
  if (kind === 'file' || kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'asset') return kind;
  const normalizedMime = mime ?? '';
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime.startsWith('video/')) return 'video';
  return 'file';
}

function assetIntentFromMetadata(metadata: AssetDTO['metadata'] | undefined): 'vision_input' | 'file_attachment' {
  const explicit =
    metadata && typeof metadata.intent === 'string'
      ? metadata.intent
      : metadata && typeof metadata.inputIntent === 'string'
        ? metadata.inputIntent
        : null;
  return explicit === 'vision_input' || explicit === 'image_input' ? 'vision_input' : 'file_attachment';
}

function normalizeMessagePreviewUrls(
  previewUrls: AssetDTO['previewUrls'] | null | undefined,
): MessageAttachmentDTO['previewUrls'] {
  if (!previewUrls) return null;
  const out: NonNullable<MessageAttachmentDTO['previewUrls']> = {};
  for (const key of ['small', 'medium', 'large'] as const) {
    const value = previewUrls[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

// release201/30 Phase 2 — `attachmentMimeBucket` removed (superseded by
// `bucketForMime` exported from `./message-asset-card`). The legacy
// `AttachmentPreview` sub-component was deleted in the same commit; the
// new `MessageAssetCard` owns mime-driven rendering end-to-end.

function MessageAssetAttachment({
  message,
  isDark,
  inOwnBubble = false,
  onOpenAsset,
}: {
  message: MessageDTO;
  isDark: boolean;
  inOwnBubble?: boolean;
  onOpenAsset?: (assetId: string) => void;
}) {
  const attachments = useMemo(() => parseAttachmentsFromMessage(message), [message]);
  // release201/30 Phase 2 — local preview Modal for non-IMAsset shapes
  // (legacy fileUrl) and for the lightweight inline peek; for real
  // IMAsset rows the caller's `onOpenAsset` still takes precedence so
  // the full workspace inspector dialog opens.
  const [previewAsset, setPreviewAsset] = useState<MessageAsset | null>(null);
  if (attachments.length === 0) return null;
  const MAX_RENDER = 4;
  const visible = attachments.slice(0, MAX_RENDER);
  const overflow = attachments.length - visible.length;
  const handlePreview = (asset: MessageAsset) => {
    if (asset.source === 'attachment' && onOpenAsset) {
      onOpenAsset(asset.id);
      return;
    }
    // Legacy fallback path — no real IMAsset row, so the workspace
    // inspector wouldn't find anything. Open the local viewer instead.
    setPreviewAsset(asset);
  };
  return (
    <>
      <div className="mt-2 flex flex-col gap-1.5">
        {visible.map((att) => (
          <MessageAssetCard
            key={att.id}
            asset={att}
            isDark={isDark}
            inOwnBubble={inOwnBubble}
            onPreview={handlePreview}
          />
        ))}
        {overflow > 0 ? (
          <button
            type="button"
            onClick={() => {
              const extra = attachments[MAX_RENDER];
              if (extra) handlePreview(extra);
            }}
            className={`self-start rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              inOwnBubble
                ? 'border-white/20 bg-white/10 text-white/85 hover:bg-white/20'
                : isDark
                  ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.07]'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100'
            }`}
            data-testid={`chat-asset-overflow-${message.id}`}
          >
            +{overflow} more attachment{overflow === 1 ? '' : 's'}
          </button>
        ) : null}
      </div>
      <MessageAssetViewerModal
        asset={previewAsset}
        open={previewAsset != null}
        onClose={() => setPreviewAsset(null)}
        isDark={isDark}
      />
    </>
  );
}

const PRISMER_URI_PATTERN = /prismer:\/\/[^\s<>()\]]+/g;
const PRISMER_URI_TRAILING_PUNCTUATION = /[.,;:!?]+$/;

type ParsedPrismerUri =
  | { type: 'asset'; raw: string; hash: string }
  | { type: 'file'; raw: string; path: string }
  | { type: 'unknown'; raw: string };

interface PrismerChatLink {
  uri: string;
  type: 'asset' | 'file';
  assetId: string | null;
  title: string;
  subtitle: string;
}

function MessagePrismerLinks({
  message,
  assets,
  files,
  isDark,
  inOwnBubble = false,
  onOpenAsset,
}: {
  message: MessageDTO;
  assets: AssetDTO[];
  files: WorkspaceFileDTO[];
  isDark: boolean;
  inOwnBubble?: boolean;
  onOpenAsset?: (assetId: string) => void;
}) {
  const links = useMemo(
    () => extractPrismerChatLinks(message.content, assets, files),
    [message.content, assets, files],
  );
  if (links.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {links.slice(0, 6).map((link) => {
        const resolved = Boolean(link.assetId && onOpenAsset);
        const Icon = link.type === 'file' ? File : FileText;
        return (
          <button
            key={`${link.uri}-${link.assetId ?? 'unresolved'}`}
            type="button"
            disabled={!resolved}
            onClick={() => {
              if (link.assetId) onOpenAsset?.(link.assetId);
            }}
            data-testid={`chat-prismer-link-${link.assetId ?? 'unresolved'}`}
            title={link.uri}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold transition ${
              inOwnBubble
                ? 'border-white/20 bg-white/15 text-white hover:bg-white/20 disabled:opacity-70'
                : isDark
                  ? 'border-cyan-300/20 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/15 disabled:opacity-60'
                  : 'border-cyan-200 bg-cyan-50 text-cyan-800 hover:bg-cyan-100 disabled:opacity-60'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 max-w-[220px] truncate">{link.title}</span>
            <span className={inOwnBubble ? 'text-white/65' : isDark ? 'text-cyan-100/65' : 'text-cyan-800/65'}>
              {link.subtitle}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function extractPrismerChatLinks(content: string, assets: AssetDTO[], files: WorkspaceFileDTO[]): PrismerChatLink[] {
  if (!content.includes('prismer://')) return [];
  const assetByHash = new Map<string, AssetDTO>();
  const assetById = new Map<string, AssetDTO>();
  for (const asset of assets) {
    assetById.set(asset.id, asset);
    if (asset.contentHash) assetByHash.set(asset.contentHash, asset);
  }
  const fileByPath = new Map<string, WorkspaceFileDTO>();
  for (const file of files) {
    fileByPath.set(normalizePrismerPath(file.path), file);
  }

  const out: PrismerChatLink[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(PRISMER_URI_PATTERN)) {
    const raw = trimPrismerUri(match[0]);
    if (seen.has(raw)) continue;
    seen.add(raw);
    const parsed = parsePrismerUri(raw);
    if (parsed.type === 'asset') {
      const asset = assetByHash.get(parsed.hash) ?? assetById.get(parsed.hash) ?? null;
      out.push({
        uri: raw,
        type: 'asset',
        assetId: asset?.id ?? null,
        title: asset ? assetChatTitle(asset, files) : `asset ${parsed.hash.slice(0, 10)}`,
        subtitle: asset?.sizeBytes != null ? formatBytes(asset.sizeBytes) : 'not synced',
      });
      continue;
    }
    if (parsed.type === 'file') {
      const file = fileByPath.get(normalizePrismerPath(parsed.path)) ?? null;
      const asset = file?.assetId ? (assetById.get(file.assetId) ?? null) : null;
      out.push({
        uri: raw,
        type: 'file',
        assetId: file?.assetId ?? null,
        title: file?.path ?? parsed.path,
        subtitle: asset?.sizeBytes != null ? formatBytes(asset.sizeBytes) : 'file',
      });
    }
  }
  return out;
}

function trimPrismerUri(uri: string): string {
  return uri.replace(PRISMER_URI_TRAILING_PUNCTUATION, '');
}

function parsePrismerUri(uri: string): ParsedPrismerUri {
  const raw = trimPrismerUri(uri);
  const body = raw.slice('prismer://'.length);
  const parts = body.split('/').filter(Boolean).map(safeDecodeURIComponent);
  if (parts[0] === 'workspace' && parts[2] === 'asset' && parts[3]) {
    return { type: 'asset', raw, hash: stripPrismerUriQuery(parts[3]) };
  }
  if (parts[0] === 'workspace' && parts[2] === 'file' && parts.length > 3) {
    return { type: 'file', raw, path: stripPrismerUriQuery(parts.slice(3).join('/')) };
  }
  const assetIdx = parts.indexOf('asset');
  if (assetIdx >= 0 && parts[assetIdx + 1]) {
    return { type: 'asset', raw, hash: stripPrismerUriQuery(parts[assetIdx + 1]) };
  }
  const fileIdx = parts.indexOf('file');
  if (fileIdx >= 0 && parts.length > fileIdx + 2) {
    return { type: 'file', raw, path: stripPrismerUriQuery(parts.slice(fileIdx + 2).join('/')) };
  }
  return { type: 'unknown', raw };
}

function stripPrismerUriQuery(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePrismerPath(path: string): string {
  return safeDecodeURIComponent(path).replace(/^\/+/, '');
}

function assetChatTitle(asset: AssetDTO, files: WorkspaceFileDTO[]): string {
  const file = files.find((item) => item.assetId === asset.id);
  if (file?.path) return file.path;
  const metadataTitle = asset.metadata?.title;
  if (typeof metadataTitle === 'string' && metadataTitle.trim()) return metadataTitle.trim();
  if (asset.filename) return asset.filename;
  return asset.contentHash ? asset.contentHash.slice(0, 16) : asset.id;
}

function MessageTaskLinks({
  message,
  isDark,
  inOwnBubble = false,
  onOpenTask,
}: {
  message: MessageDTO;
  isDark: boolean;
  inOwnBubble?: boolean;
  onOpenTask?: (taskId: string) => void;
}) {
  const meta = normalizeMetadata(message.metadata);
  if (meta.kind === 'agent_reply') return null;
  const taskIds = extractTaskIds(message);
  if (taskIds.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {taskIds.map((taskId) => (
        <button
          key={taskId}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenTask?.(taskId);
          }}
          disabled={!onOpenTask}
          data-testid={`message-task-link-${taskId}`}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            inOwnBubble
              ? 'border-white/20 bg-white/15 text-white'
              : isDark
                ? 'border-violet-300/20 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15'
                : 'border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100'
          } disabled:cursor-default disabled:opacity-70`}
          title={onOpenTask ? 'Open task card' : `Task ${taskId}`}
        >
          <MessageSquare className="h-3 w-3" />
          T-{taskId.slice(-4).toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function Avatar({
  seed,
  label,
  isAgent,
  roleSlug,
  avatarUrl,
}: {
  seed: string;
  label: string;
  isAgent?: boolean;
  /** Optional role/agentType slug — drives the role-specific icon when isAgent. */
  roleSlug?: string | null;
  /** Uploaded/custom avatar image — rendered over the gradient when set; hides itself on load error, revealing the icon/initials. */
  avatarUrl?: string | null;
}) {
  const grad = avatarGradient(seed || label);
  // Agents get a role-specific icon (Crown / Wrench / Megaphone / …);
  // unknown roles fall back to Bot. Humans render their initials.
  const RoleIcon = isAgent ? getAgentRoleIcon(roleSlug ?? null) : null;
  return (
    <span
      className="relative inline-flex w-7 h-7 items-center justify-center rounded-xl text-[10px] font-bold text-white shadow-sm"
      style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
      title={label}
    >
      {RoleIcon ? <RoleIcon className="w-3.5 h-3.5" /> : avatarInitials(label)}
      {avatarUrl ? (
        // Custom/uploaded avatar covers the gradient + icon/initials. On load
        // failure it hides itself (display:none), revealing the fallback
        // underneath — mirrors AgentAvatar's behaviour, no React state.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
          className="absolute inset-0 h-full w-full object-cover rounded-xl"
        />
      ) : null}
    </span>
  );
}

// ─── Wave-8 W10: linked-context strip ────────────────────────────────────
//
// Compact row of clickable chips that surfaces what's bound to the active
// session: tasks (where task.conversationId == this session), agents (the
// participant rows that match a registered AgentDTO), and recent assets
// (≤3 most recent uploads tagged metadata.conversationId == this session
// within the last 7 days).
//
// All three slices come pre-filtered from page.tsx — this component only
// renders. Long titles `truncate`; the row scrolls horizontally on cramped
// viewports so we never wrap and grow vertically.
function statusToneForTask(status: string): 'done' | 'busy' | 'idle' {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'idle';
  if (status === 'running' || status === 'in_progress' || status === 'assigned' || status === 'review') {
    return 'busy';
  }
  return 'idle';
}

function LinkedContextRow({
  isDark,
  tasks,
  agents,
  agentStatuses,
  assets,
  onOpenTask,
  onOpenAgent,
  onOpenAsset,
}: {
  isDark: boolean;
  tasks: TaskDTO[];
  agents: AgentDTO[];
  agentStatuses?: Map<string, AgentLiveStatus>;
  assets: AssetDTO[];
  onOpenTask?: (taskId: string) => void;
  onOpenAgent?: (agentId: string) => void;
  onOpenAsset?: (assetId: string) => void;
}) {
  const { t } = useI18n();
  const [tasksOpen, setTasksOpen] = useState(false);
  const isEmpty = tasks.length === 0 && agents.length === 0 && assets.length === 0;
  const baseRow = `relative flex h-11 items-center gap-2 overflow-visible border-b px-3 text-[11px] ${
    isDark ? 'border-white/[0.04] bg-zinc-950/20 text-zinc-400' : 'border-zinc-200/70 bg-white/45 text-zinc-600'
  }`;
  const sortedTasks = tasks.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const primaryTask = sortedTasks[0] ?? null;
  const taskSummary =
    primaryTask?.title || (tasks.length > 0 ? t('workspace.session.linkedTasks') : t('workspace.session.noTasks'));

  useEffect(() => {
    if (!tasksOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const menu = document.querySelector<HTMLElement>('[data-linked-task-menu]');
      const button = document.querySelector<HTMLElement>('[data-linked-task-button]');
      if (menu?.contains(target) || button?.contains(target)) return;
      setTasksOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setTasksOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tasksOpen]);

  if (isEmpty) {
    return (
      <div
        data-testid="channel-linked-context-row"
        className={baseRow}
        // Subtle one-line hint when nothing is linked yet. Keeps the
        // header height consistent so the message scroll area doesn't
        // jump as soon as one task/asset gets bound.
      >
        <span data-testid="channel-linked-context-empty" className="opacity-70">
          {t('workspace.session.noLinkedContext')}
        </span>
      </div>
    );
  }

  const taskTone = (task: TaskDTO) => {
    const status = statusToneForTask(task.status);
    return { status };
  };

  const taskMenuItem = (task: TaskDTO) => {
    const tone = taskTone(task);
    return (
      <button
        key={task.id}
        type="button"
        data-testid={`channel-linked-task-${task.id}`}
        onClick={() => {
          setTasksOpen(false);
          onOpenTask?.(task.id);
        }}
        title={task.title}
        className={`flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors ${
          isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-zinc-50'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            tone.status === 'done' ? 'bg-emerald-400' : tone.status === 'busy' ? 'bg-amber-400' : 'bg-zinc-400'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-900'}`}>
            {task.title || `T-${task.id.slice(-4).toUpperCase()}`}
          </span>
          <span className={`mt-0.5 block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {task.status.replace('_', ' ')}
          </span>
        </span>
      </button>
    );
  };

  const agentChip = (agent: AgentDTO) => {
    // username-first chain (ceo/engineer/marketer reliably map to a role icon;
    // agentType is often a generic tier) — keeps the chip icon identical to the
    // member popover / contacts / message avatar (release202/09 consistency).
    const RoleIcon = getAgentRoleIcon([agent.username, agent.name, agent.agentType]);
    const status = agentStatuses?.get(agent.userId) ?? null;
    const ringTone =
      status?.kind === 'working'
        ? isDark
          ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15'
          : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
        : status?.kind === 'stuck'
          ? isDark
            ? 'border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15'
            : 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'
          : isDark
            ? 'border-violet-300/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
            : 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100';
    return (
      <button
        key={agent.userId}
        type="button"
        data-testid={`channel-linked-agent-${agent.agentId}`}
        onClick={() => onOpenAgent?.(agent.agentId)}
        title={`@${agent.name}`}
        data-status-kind={status?.kind ?? 'unknown'}
        className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 leading-4 ${ringTone}`}
      >
        <RoleIcon className="h-3 w-3 shrink-0" />
        <span className="max-w-[120px] truncate">@{agent.name}</span>
      </button>
    );
  };

  const assetChip = (asset: AssetDTO) => {
    const meta = asset.metadata ?? {};
    const title =
      (typeof meta.title === 'string' && meta.title) ||
      (typeof meta.fileName === 'string' && (meta.fileName as string)) ||
      asset.kind ||
      asset.id.slice(-6);
    return (
      <button
        key={asset.id}
        type="button"
        data-testid={`channel-linked-asset-${asset.id}`}
        onClick={() => onOpenAsset?.(asset.id)}
        title={title}
        className={`inline-flex min-w-0 max-w-[150px] shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 leading-4 ${
          isDark
            ? 'border-cyan-300/20 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15'
            : 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100'
        }`}
      >
        <File className="h-3 w-3" />
        <span className="truncate">{title}</span>
      </button>
    );
  };

  return (
    <div data-testid="channel-linked-context-row" className={baseRow}>
      {tasks.length > 0 ? (
        <div className="relative min-w-0 shrink-0">
          <button
            type="button"
            data-linked-task-button
            data-testid="channel-linked-task-menu"
            onClick={() => setTasksOpen((value) => !value)}
            className={`inline-flex h-8 max-w-[240px] items-center gap-2 rounded-full border px-2.5 text-left transition-colors ${
              isDark
                ? 'border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.07]'
                : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50'
            }`}
            title={taskSummary}
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className="shrink-0 font-semibold uppercase tracking-wide opacity-70">
              {t('workspace.session.tasks')}
            </span>
            <span className="shrink-0 opacity-60">({tasks.length})</span>
            <span className="min-w-0 truncate">{taskSummary}</span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${tasksOpen ? 'rotate-180' : ''}`} />
          </button>
          {tasksOpen ? (
            <div
              data-linked-task-menu
              className={`absolute left-0 top-9 z-30 w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-2xl border p-1 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.35)] ${
                isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
              }`}
            >
              <div className={`border-b px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-zinc-100'}`}>
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-60">
                  {t('workspace.session.linkedTasks')}
                </p>
              </div>
              <div className="max-h-64 overflow-y-auto py-1">{sortedTasks.map(taskMenuItem)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
      {agents.length > 0 ? (
        <>
          {tasks.length > 0 ? <span className={isDark ? 'opacity-30' : 'opacity-40'}>·</span> : null}
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">{agents.map(agentChip)}</div>
        </>
      ) : null}
      {assets.length > 0 ? (
        <>
          {tasks.length + agents.length > 0 ? <span className={isDark ? 'opacity-30' : 'opacity-40'}>·</span> : null}
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="shrink-0 font-semibold uppercase tracking-wide opacity-70">
              {t('workspace.session.recent')}
            </span>
            {assets.map(assetChip)}
          </div>
        </>
      ) : null}
    </div>
  );
}

function formatDateDivider(iso: string, t: WorkspaceT): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const day = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t('workspace.session.today');
  if (day.toDateString() === yesterday.toDateString()) return t('workspace.session.yesterday');
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMessageTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function renderSearchSnippet(snippet: string, query: string, isDark: boolean): React.ReactNode {
  if (!query) return snippet;
  const haystack = snippet.toLowerCase();
  const needle = query.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return snippet;
  return (
    <>
      {snippet.slice(0, index)}
      <mark className={`rounded px-0.5 ${isDark ? 'bg-cyan-300/20 text-cyan-100' : 'bg-cyan-100 text-cyan-900'}`}>
        {snippet.slice(index, index + query.length)}
      </mark>
      {snippet.slice(index + query.length)}
    </>
  );
}

/**
 * v2.0 §4.6 (Wave 4 E5) — pull a ContentBlock[] out of a message DTO,
 * accepting parsed array OR JSON-encoded string from either of two field
 * names the server might use (`contentBlocks` SDK-shape vs `contentBlocksJson`
 * raw-column). Returns null when neither field carries usable blocks so the
 * caller falls back to the legacy `attachments` + `content` rendering path.
 *
 * Why two field names: the SDK D1 `IMMessage` type calls it `contentBlocks`
 * but the cloud message endpoint may temporarily surface the raw MySQL
 * column as `contentBlocksJson` during the 6-sprint double-write window;
 * either should work without coordination.
 */
function extractContentBlocks(message: MessageDTO): ContentBlock[] | null {
  return parseContentBlocks(message.contentBlocks ?? message.contentBlocksJson ?? null);
}

/**
 * Wraps the bubble body: dispatches to `<MessageContentBlocks>` if the
 * message carries ContentBlock[]; otherwise renders the legacy `MessageBody`
 * (string content / markdown). The legacy `<MessageAssetAttachment>` is
 * suppressed by the caller when ContentBlocks are present (the new path
 * already surfaces files / images / audio / video inside the blocks).
 */
function MessageBubbleBody({
  message,
  contentType,
  isOwn,
  isDark,
}: {
  message: MessageDTO;
  contentType: string;
  isOwn: boolean;
  isDark: boolean;
}) {
  const blocks = extractContentBlocks(message);
  if (blocks && blocks.length > 0) {
    return <MessageContentBlocks blocks={blocks} isOwn={isOwn} isDark={isDark} />;
  }
  return <MessageBody message={message} contentType={contentType} isOwn={isOwn} />;
}

function MessageBody({ message, contentType, isOwn }: { message: MessageDTO; contentType: string; isOwn: boolean }) {
  if (contentType !== 'text' && contentType !== 'markdown') {
    // For system/system_event the cloud DOES populate `content` with a
    // human-readable diagnostic — show that instead of a bare `[system_event]`
    // placeholder. Other non-text types (tool_call / image / etc) still get
    // the typed placeholder.
    if (
      (contentType === 'system_event' || contentType === 'system') &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      return (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed italic opacity-70">
          {message.content}
        </p>
      );
    }
    // File / image messages render their attachment CARD as the visual — never
    // a bare `[file]` placeholder. Show the content only when it's a real
    // caption (not empty, not the auto-filename the SDK stamps as content);
    // otherwise render nothing and let the card speak. (release202.)
    if (contentType === 'file' || contentType === 'image') {
      const fileName =
        message.metadata && typeof message.metadata === 'object'
          ? ((message.metadata as Record<string, unknown>).fileName as string | undefined)
          : undefined;
      const caption = typeof message.content === 'string' ? message.content.trim() : '';
      if (caption && caption !== fileName) {
        return <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{caption}</p>;
      }
      return null;
    }
    return (
      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed italic opacity-70">[{contentType}]</p>
    );
  }
  const truncated = message.content.length > 4_000 ? `${message.content.slice(0, 4_000)}…` : message.content;
  // Agent replies always render as markdown (Hermes returns markdown by default).
  // Human messages render markdown when type='markdown', else plain text-pre-wrap.
  const meta = normalizeMetadata(message.metadata);
  const isAgentReply = meta.kind === 'agent_reply';
  const useMarkdown = contentType === 'markdown' || isAgentReply;
  if (!useMarkdown) {
    return <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{truncated}</p>;
  }
  // Compact prose: tight paragraph spacing, monospace inline code, list bullets.
  // Color is inherited from the parent bubble (white on gradient bubbles, zinc
  // otherwise) so we don't repeat color classes per element.
  const linkColor = isOwn ? 'text-white underline underline-offset-2' : 'text-violet-500 underline underline-offset-2';
  return (
    <div
      className={`prose-chat min-w-0 max-w-full break-words text-[15px] leading-relaxed [&_:not(table):not(thead):not(tbody):not(tr):not(th):not(td)]:max-w-full [&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_strong]:font-semibold [&_em]:italic [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-2 [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:opacity-80 [&_hr]:my-2 [&_hr]:opacity-30`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v10 stopped passing `inline` — the convention is
          // now: every fenced block parses to <pre><code>...; inline `code`
          // parses to bare <code>. So we override <pre> for the block style
          // and let <code> always render as inline-styled. This avoids the
          // <p><pre> hydration error we hit when an agent reply has a fenced
          // block while a paragraph context is still open.
          pre({ children, ...props }) {
            return (
              <pre
                className={`my-2 max-w-full overflow-x-auto rounded-lg p-2.5 font-mono text-[12px] leading-relaxed ${
                  isOwn ? 'bg-white/15' : 'bg-black/[0.05] dark:bg-white/[0.06]'
                }`}
                {...props}
              >
                {children}
              </pre>
            );
          },
          code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
            const isFenced = typeof className === 'string' && className.startsWith('language-');
            if (isFenced) {
              // Inside the <pre> wrapper above; just pass the syntax class through.
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={`break-all rounded px-1 py-0.5 font-mono text-[13px] whitespace-normal ${
                  isOwn ? 'bg-white/15' : 'bg-black/[0.06] dark:bg-white/[0.08]'
                }`}
                {...props}
              >
                {children}
              </code>
            );
          },
          table({ children }) {
            return (
              <div className="my-2 block w-full max-w-full overflow-x-auto rounded-xl border border-current/10">
                <table className="min-w-[520px] border-collapse text-left text-[13px] leading-relaxed">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th
                className={`border-b border-current/10 px-3 py-2 font-semibold ${isOwn ? 'bg-white/10' : 'bg-black/[0.03]'}`}
              >
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border-b border-current/10 px-3 py-2 align-top">{children}</td>;
          },
          a({ children, ...props }) {
            return (
              <a target="_blank" rel="noreferrer" className={linkColor} {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {truncated}
      </ReactMarkdown>
    </div>
  );
}

function normalizeMetadata(metadata: MessageDTO['metadata']): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return metadata;
}

function extractTaskIds(message: MessageDTO): string[] {
  const meta = normalizeMetadata(message.metadata);
  const ids = new Set<string>();
  for (const key of ['taskId', 'task_id', 'parentTaskId', 'parent_task_id']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  }
  const task = meta.task;
  if (task && typeof task === 'object' && !Array.isArray(task)) {
    const id = (task as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  const patterns = [
    /\*\*ID:\*\*\s*`([^`]+)`/gi,
    /\btask(?:\s+id)?[:#]\s*`?([a-z0-9_-]{10,})`?/gi,
    /\bT-([A-Z0-9]{4,})\b/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message.content)) !== null) {
      const id = match[1]?.trim();
      if (id && id.length >= 10) ids.add(id);
    }
  }
  return Array.from(ids).slice(0, 4);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
