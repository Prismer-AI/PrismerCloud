'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AtSign,
  AlertCircle,
  Archive,
  Ban,
  BellOff,
  Bot,
  Brain,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  CloudDownload,
  Command,
  File,
  FileText,
  ImageIcon,
  Keyboard,
  MapPin,
  Mic,
  Music,
  PanelLeftClose,
  Pin,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  Search,
  ArrowUp,
  Smile,
  Sparkles,
  Target,
  UserMinus,
  Users,
  Video,
  XCircle,
  Wrench,
  X,
} from 'lucide-react';

import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { getGroupDetails, kickGroupMember, sendMessage, type GroupMember } from '../lib/mutations';
import { avatarGradient, avatarInitials, radius, springSnap, springSoft, surface } from '../lib/design';
import { MentionPicker, type MentionPickerHandle } from './mention-picker';
import { useI18n } from '@/contexts/i18n-context';
import type { AgentDTO, AssetDTO, ConversationDTO, TaskDTO, WorkspaceFileDTO } from '../lib/types';

interface ImChannelProps {
  isDark: boolean;
  conversation: ConversationDTO | null;
  currentUserId?: string | null;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  compact?: boolean;
  assets?: AssetDTO[];
  files?: WorkspaceFileDTO[];
  onNewChannel?: () => void;
  onUploadAsset?: () => void;
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
  /** Up to 3 most-recent assets uploaded into this session within 7 days. */
  recentAssets?: AssetDTO[];
  /** Open an asset in the workspace inspector. */
  onOpenAsset?: (assetId: string) => void;
  /** Open an agent profile in the workspace inspector. */
  onOpenAgent?: (agentId: string) => void;
  /**
   * Memory Line B / B4 — fired from a message bubble's contextmenu /
   * long-press handler. The host is expected to open the
   * `<SaveAsMemoryModal />` with the supplied source payload.
   */
  onSaveMessageAsMemory?: (payload: {
    conversationId: string;
    messageId: string;
    text: string;
    authorImUserId: string;
    createdAt: string;
  }) => void;
}

interface MessageDTO {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  contentType?: string;
  type?: string;
  createdAt: string;
  metadata?: string | Record<string, unknown>;
  pending?: boolean;
  failed?: boolean;
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

// Wave-8 W7 — task completion → chat reverse-link.
// `task_status_event` is the metadata.kind cloud writes onto a `type='system'`
// message when a task with a linked conversationId reaches a terminal state.
// We render those rows as a centred chip (not a regular bubble) and surface
// a small ✓/✗ chip on the trigger message they reference.
type TaskStatusEventStatus = 'completed' | 'failed' | 'cancelled';

interface TaskStatusEventInfo {
  taskId: string;
  taskTitle: string;
  status: TaskStatusEventStatus;
  error?: string;
  triggerMessageId?: string;
}

function readTaskStatusEvent(message: MessageDTO): TaskStatusEventInfo | null {
  // The cloud always writes `type='system'`, but a stray `system_event` with
  // the same metadata.kind shouldn't slip through. Normalise both.
  const t = message.type;
  if (t !== 'system' && t !== 'system_event') return null;
  const meta = normalizeMetadata(message.metadata);
  if (meta.kind !== 'task_status_event') return null;
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
  const status = typeof meta.status === 'string' ? meta.status : null;
  if (!taskId || (status !== 'completed' && status !== 'failed' && status !== 'cancelled')) {
    return null;
  }
  const taskTitle = typeof meta.taskTitle === 'string' ? meta.taskTitle : '';
  const triggerMessageId =
    typeof meta.triggerMessageId === 'string' && meta.triggerMessageId ? (meta.triggerMessageId as string) : undefined;
  const error = typeof meta.error === 'string' ? (meta.error as string) : undefined;
  return { taskId, taskTitle, status, triggerMessageId, error };
}

const GROUP_GAP_MS = 5 * 60 * 1000;

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

const COMPOSER_EMOJIS = ['👍', '🙏', '🙌', '🙂', '🔥', '✅', '👀', '💡', '🚀', '📌', '🧠', '⚡'] as const;

export function ImChannel({
  isDark,
  conversation,
  currentUserId,
  notify,
  compact = false,
  assets = [],
  files = [],
  onNewChannel,
  onUploadAsset,
  onOpenAssets,
  onOpenTask,
  onCollapse,
  headerActions,
  onAddMember,
  onMobileBack,
  linkedTasks = [],
  linkedAgents = [],
  recentAssets = [],
  onOpenAsset,
  onOpenAgent,
  onSaveMessageAsMemory,
}: ImChannelProps) {
  const { t } = useI18n();
  const theme: 'dark' | 'light' = isDark ? 'dark' : 'light';
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'details'>('chat');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [composerPanel, setComposerPanel] = useState<ComposerPanel>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [draggingAsset, setDraggingAsset] = useState(false);
  const [agentTasks, setAgentTasks] = useState<Map<string, AgentTaskStatus>>(new Map());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MessageSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const searchRequestSeq = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [mentionFilter, setMentionFilter] = useState<string | null>(null);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const mentionPickerRef = useRef<MentionPickerHandle | null>(null);
  // Picker should not let the user @-mention themselves. `currentUserId`
  // may be undefined while the session is loading — in that case fall
  // back to the unfiltered list rather than hiding everyone.
  const mentionMembers = useMemo(
    () => (currentUserId ? members.filter((m) => m.userId !== currentUserId) : members),
    [members, currentUserId],
  );

  const conversationId = conversation?.id ?? null;
  const conversationType = conversation?.type ?? null;
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

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setMembers([]);
      setError(null);
      setDraft('');
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
    setActiveTab('chat');

    imFetch<MessageHistoryResponse | MessageDTO[]>(`/messages/${conversationId}?limit=60`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        // Cloud's GET /messages returns chronological order (oldest → newest)
        // — see src/im/models/message.ts:100. ImChannel renders messages
        // top-to-bottom in that same order so the newest reply lives at the
        // bottom of the scroll, matching standard chat UX. Do NOT reverse;
        // the previous `.reverse()` here was a leftover from when cloud
        // returned desc, and it flipped the timeline upside-down.
        const list = Array.isArray(res.data) ? res.data : (res.data?.messages ?? []);
        setMessages(list);
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
  }, [conversationId, conversationType]);

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

  useEffect(() => {
    if (!conversation) return;
    const token = getWorkspaceToken();
    if (!token) return;

    const conversationId = conversation.id;
    const es = new EventSource(`/api/im/sync/stream?token=${encodeURIComponent(token)}&since=0`);

    es.addEventListener('sync', (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent).data) as {
          type?: string;
          data?: MessageDTO;
        };
        const msg = event.data;
        if (event.type !== 'message.new' || !msg || msg.conversationId !== conversationId) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
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
  }, [conversation]);

  // Wave-7: subscribe to typed task.* SSE so the chat surface can show
  // an ephemeral "Thinking…" / "Executing: …" row while the assigned
  // agent works on a dispatched task. The cloud filter on
  // /api/im/tasks/events already restricts events to creator/assignee;
  // we additionally narrow on conversationId so a sibling group's
  // task progress doesn't bleed into this channel.
  useEffect(() => {
    if (!conversation) return;
    const token = getWorkspaceToken();
    if (!token) return;
    setAgentTasks(new Map());

    const conversationId = conversation.id;
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

    const handle = (eventName: string, raw: MessageEvent) => {
      let payload: {
        taskId?: string;
        conversationId?: string | null;
        statusMessage?: string | null;
        progress?: number | null;
      };
      try {
        payload = JSON.parse(raw.data);
      } catch {
        return;
      }
      const taskId = payload.taskId;
      if (!taskId) return;
      // Only events that belong to the active conversation drive the
      // typing indicator. Tasks created against other channels (e.g.
      // workspace board direct creates) skip the ephemeral row entirely.
      if (payload.conversationId && payload.conversationId !== conversationId) return;
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
  }, [conversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, loading, agentTasks.size]);

  const typingRows = useMemo(
    () => Array.from(agentTasks.values()).sort((a, b) => a.updatedAt - b.updatedAt),
    [agentTasks],
  );

  const memberById = useMemo(() => {
    const map = new Map<string, GroupMember>();
    for (const member of members) map.set(member.userId, member);
    return map;
  }, [members]);

  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const fileByAssetId = useMemo(() => new Map(files.map((file) => [file.assetId, file])), [files]);

  // Wave-8 W7 — when conversation.muted is true, suppress task_status_event
  // chip rows on the client. The audit trail still lives in the DB (we never
  // skip writing the system message); we just hide it from the visible feed
  // so muted sessions don't keep buzzing the chat with completion lines.
  const muteTaskStatusEvents = Boolean(conversation?.muted);

  const renderedMessages = useMemo<RenderedMessage[]>(() => {
    // First pass: filter out task_status_event rows when muted, then walk
    // the remaining list in display order to compute date/show-sender flags.
    const filtered = muteTaskStatusEvents ? messages.filter((m) => readTaskStatusEvent(m) === null) : messages;
    return filtered.map((message, index) => {
      const prev = index > 0 ? filtered[index - 1] : null;
      const ts = Date.parse(message.createdAt);
      const day = Number.isFinite(ts) ? new Date(ts).toDateString() : '';
      const prevTs = prev ? Date.parse(prev.createdAt) : NaN;
      const prevDay = prev && Number.isFinite(prevTs) ? new Date(prevTs).toDateString() : '';
      const dateLabel = day !== prevDay ? formatDateDivider(message.createdAt) : null;
      const showSender =
        !prev ||
        prev.senderId !== message.senderId ||
        !Number.isFinite(ts) ||
        !Number.isFinite(prevTs) ||
        ts - prevTs > GROUP_GAP_MS ||
        Boolean(dateLabel);
      return { message, dateLabel, showSender };
    });
  }, [messages, muteTaskStatusEvents]);

  // Wave-8 W7 — index task_status_event rows by their `triggerMessageId`
  // so MessageRow can show an inline ✓/✗ chip next to the user's original
  // trigger message. Last-seen status wins (a task can only land in one
  // terminal state, but if cloud somehow re-emits we want the latest).
  const triggerStatusMap = useMemo(() => {
    const map = new Map<string, TaskStatusEventInfo>();
    for (const message of messages) {
      const info = readTaskStatusEvent(message);
      if (!info?.triggerMessageId) continue;
      map.set(info.triggerMessageId, info);
    }
    return map;
  }, [messages]);

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
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      i--;
    }
    setMentionFilter(null);
    mentionRangeRef.current = null;
  }, []);

  const onDraftChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setDraft(value);
      updateMentionState(value, e.target.selectionStart ?? value.length);
    },
    [updateMentionState],
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

  const sendAssetAttachment = useCallback(
    async (payload: DroppedAssetPayload) => {
      if (!conversation || sending) return;
      const known = assetById.get(payload.id);
      const file = fileByAssetId.get(payload.id);
      const title = file?.path || payload.title || known?.contentHash?.slice(0, 16) || payload.id;
      const mime = known?.mime ?? payload.mime ?? null;
      const kind = known?.kind ?? payload.kind;
      const sizeBytes = known?.sizeBytes ?? payload.sizeBytes ?? null;
      const contentHash = known?.contentHash ?? payload.contentHash;
      const content = `Attached asset: ${title}`;
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
          title,
          kind,
          mime,
          sizeBytes,
          contentHash,
        },
      };
      const tempId = `tmp-asset-${Date.now()}`;
      const optimistic: MessageDTO = {
        id: tempId,
        conversationId: conversation.id,
        senderId: 'me',
        content,
        type: 'markdown',
        contentType: 'markdown',
        metadata,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setMessages((prev) => [...prev, optimistic]);
      setSending(true);
      const res = await sendMessage({ conversationId: conversation.id, content, type: 'markdown', metadata });
      setSending(false);
      if (!res.ok) {
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
        notify(`Asset attach failed: ${res.message}`, 'error');
        return;
      }
      setMessages((prev) => {
        const persistedId = res.data.message.id;
        const withoutDup = prev.filter((m) => m.id !== persistedId);
        return withoutDup.map((m) => (m.id === tempId ? { ...res.data.message, pending: false } : m));
      });
      notify(`Attached ${title}.`, 'success');
    },
    [assetById, conversation, fileByAssetId, notify, sending],
  );

  const onAssetDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const raw = event.dataTransfer.getData('application/x-prismer-asset');
      if (!raw) return;
      event.preventDefault();
      setDraggingAsset(false);
      try {
        const parsed = JSON.parse(raw) as DroppedAssetPayload;
        if (!parsed.id) throw new Error('missing asset id');
        void sendAssetAttachment(parsed);
      } catch {
        notify('Could not attach that asset.', 'error');
      }
    },
    [notify, sendAssetAttachment],
  );

  const onSend = useCallback(async () => {
    if (!conversation || !draft.trim() || sending) return;
    const content = draft.trim();
    const tempId = `tmp-${Date.now()}`;
    const optimistic: MessageDTO = {
      id: tempId,
      conversationId: conversation.id,
      senderId: 'me',
      content,
      type: 'text',
      contentType: 'text',
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft('');
    setSending(true);
    setMentionFilter(null);
    setComposerPanel(null);
    const res = await sendMessage({ conversationId: conversation.id, content });
    setSending(false);
    if (!res.ok) {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
      setDraft(content);
      notify(`Send failed: ${res.message}`, 'error');
      return;
    }
    const persisted = res.data.message;
    setMessages((prev) => {
      const withoutDup = prev.filter((m) => m.id !== persisted.id);
      return withoutDup.map((m) => (m.id === tempId ? { ...persisted, pending: false } : m));
    });
    if (res.data.routing?.mode === 'explicit' && res.data.routing.targets.length > 0) {
      notify(`Mentioned ${res.data.routing.targets.map((t) => t.username ?? t.userId.slice(-6)).join(', ')}`, 'info');
    }
  }, [conversation, draft, sending, notify]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && (composerPanel !== null || mentionFilter !== null)) {
        e.preventDefault();
        setComposerPanel(null);
        setMentionFilter(null);
        mentionRangeRef.current = null;
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
      if (
        (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) ||
        ((e.metaKey || e.ctrlKey) && e.key === 'Enter')
      ) {
        e.preventDefault();
        void onSend();
      }
    },
    [composerPanel, mentionFilter, onSend],
  );

  const onKick = useCallback(
    async (member: GroupMember) => {
      if (!conversation) return;
      if (member.role === 'owner') {
        notify("You can't kick the owner.", 'error');
        return;
      }
      const ok = window.confirm(`Remove @${member.username} from this session?`);
      if (!ok) return;
      const res = await kickGroupMember(conversation.id, member.userId);
      if (!res.ok) {
        notify(`Couldn't kick member: ${res.message}`, 'error');
        return;
      }
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      notify(`@${member.username} removed.`, 'success');
    },
    [conversation, notify],
  );

  const jumpToSearchResult = useCallback((result: MessageSearchResult) => {
    setMessages((prev) => {
      if (prev.some((message) => message.id === result.id)) return prev;
      return [...prev, result].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    });
    setHighlightedMessageId(result.id);
    window.setTimeout(() => {
      messageRefs.current.get(result.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
    window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === result.id ? null : current));
    }, 4000);
  }, []);

  return (
    <section
      className={`flex-1 flex flex-col min-w-0 relative overflow-hidden ${searchOpen ? 'z-30' : 'z-0'} ${surface.pane[theme]}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('application/x-prismer-asset')) setDraggingAsset(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-prismer-asset')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAsset(false);
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
            className={`pointer-events-none absolute inset-3 z-30 flex items-center justify-center border-2 border-dashed ${radius.pane} ${
              isDark
                ? 'border-violet-300/50 bg-violet-500/10 text-violet-100'
                : 'border-violet-300 bg-violet-50/80 text-violet-900'
            }`}
          >
            <div className="flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold backdrop-blur-xl">
              <Archive className="h-4 w-4" />
              Drop asset into this session
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
            title="Back to sessions"
            aria-label="Back to sessions"
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
            title="Collapse chat panel"
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
                title="Pinned"
                aria-label="Pinned"
                className="ml-1.5 inline-flex align-middle"
              >
                <Pin className="h-3.5 w-3.5 text-violet-400" strokeWidth={1.5} fill="currentColor" />
              </span>
            ) : null}
            {conversation?.muted ? (
              <span
                data-testid="channel-muted-indicator"
                title="Muted"
                aria-label="Muted"
                className="ml-1 inline-flex align-middle"
              >
                <BellOff className="h-3.5 w-3.5 text-zinc-400" strokeWidth={1.5} />
              </span>
            ) : null}
          </h2>
          <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {conversation
              ? members.length > 0
                ? `${members.length} members`
                : compact
                  ? 'Session chat'
                  : 'Workspace session'
              : 'Open a session to coordinate the active task board'}
          </p>
        </div>
        {members.length > 0 ? (
          <button
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
          title="Search session"
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
      {conversation ? (
        <LinkedContextRow
          isDark={isDark}
          tasks={linkedTasks}
          agents={linkedAgents}
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
                ? 'You'
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
                  <Avatar seed={member.userId} label={member.displayName || member.username} isAgent />
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
        className={`relative flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 ${
          isDark
            ? 'bg-[radial-gradient(circle_at_40%_0%,rgba(139,92,246,0.08),transparent_32%),radial-gradient(circle_at_100%_55%,rgba(34,211,238,0.06),transparent_36%)]'
            : 'bg-[radial-gradient(circle_at_30%_0%,rgba(139,92,246,0.07),transparent_34%),radial-gradient(circle_at_100%_60%,rgba(34,211,238,0.07),transparent_36%)]'
        }`}
      >
        {activeTab === 'details' ? (
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
            Failed to load messages: {error}
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
                New session
              </motion.button>
            ) : null}
          </section>
        ) : messages.length === 0 ? (
          <SessionEmpty isDark={isDark} members={members} onFocus={() => textareaRef.current?.focus()} />
        ) : (
          <ul className="space-y-0.5" data-testid="message-list">
            {renderedMessages.map(({ message, dateLabel, showSender }) => {
              const taskStatusEvent = readTaskStatusEvent(message);
              const triggerStatus = triggerStatusMap.get(message.id);
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
                  {taskStatusEvent ? (
                    <TaskStatusEventRow event={taskStatusEvent} isDark={isDark} onOpenTask={onOpenTask} />
                  ) : (
                    <MessageRow
                      message={message}
                      member={memberById.get(message.senderId)}
                      showSender={showSender}
                      isOwn={message.senderId === 'me' || (!!currentUserId && message.senderId === currentUserId)}
                      isDark={isDark}
                      onOpenTask={onOpenTask}
                      onOpenAsset={onOpenAsset}
                      triggerStatus={triggerStatus}
                      linkedTaskIds={linkedTaskIds}
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
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <AnimatePresence initial={false}>
          {typingRows.map((task) => (
            <TypingRow key={task.taskId} status={task} isDark={isDark} />
          ))}
        </AnimatePresence>
        <div ref={endRef} />
      </div>

      <footer
        className={`relative border-t px-3 py-3 ${isDark ? 'border-white/[0.06] bg-zinc-950/38' : 'border-zinc-200/80 bg-white/60'}`}
      >
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
                  <span className={`font-mono text-xs ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>/{cmd.name}</span>
                  <span className={`text-xs truncate ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{cmd.hint}</span>
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <motion.div
          layout
          transition={springSoft}
          className={`border p-2 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.75)] backdrop-blur-2xl ${radius.card} ${
            isDark ? 'border-white/[0.08] bg-white/[0.045]' : 'border-zinc-200/80 bg-white/88'
          }`}
        >
          <AnimatePresence initial={false}>
            {composerPanel === 'attachments' ? (
              <AttachmentPanel
                isDark={isDark}
                showAssets={Boolean(onOpenAssets)}
                onUploadAsset={onUploadAsset}
                onOpenAssets={onOpenAssets}
                onInsert={insertDraftTextAtCaret}
                onShareLocation={shareLocation}
                onClose={() => setComposerPanel(null)}
              />
            ) : null}
            {composerPanel === 'emoji' ? (
              <EmojiPanel
                isDark={isDark}
                onSelect={(emoji) => insertDraftTextAtCaret(emoji)}
                onClose={() => setComposerPanel(null)}
              />
            ) : null}
            {composerPanel === 'commands' ? (
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
                isDark ? 'border-white/[0.06] bg-white/[0.03] text-zinc-300' : 'border-zinc-200 bg-white text-zinc-700'
              }`}
            >
              <button
                type="button"
                onClick={() => setVoiceMode(false)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-zinc-100'}`}
                title="Keyboard mode"
              >
                <Keyboard className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">Voice mode</p>
                <p className={`truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Browser speech capture is not enabled here. Switch to keyboard to send.
                </p>
              </div>
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            rows={compact ? 2 : 3}
            className={`max-h-32 min-h-[46px] w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none ${
              isDark ? 'text-zinc-100 placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'
            }`}
            placeholder="Message..."
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            onSelect={(e) => {
              const ta = e.currentTarget;
              updateMentionState(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            disabled={sending}
          />
          <div className="mt-2 flex items-center gap-1.5">
            <ComposerTool
              isDark={isDark}
              title={voiceMode ? 'Keyboard' : 'Voice'}
              onClick={() => setVoiceMode((value) => !value)}
            >
              {voiceMode ? <Keyboard className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </ComposerTool>
            <ComposerTool
              isDark={isDark}
              title="Mention"
              onClick={() => insertDraftTextAtCaret('@', { openMention: true })}
            >
              <AtSign className="w-3.5 h-3.5" />
            </ComposerTool>
            <ComposerTool
              isDark={isDark}
              title="Slash commands"
              active={composerPanel === 'commands'}
              onClick={() => setComposerPanel((panel) => (panel === 'commands' ? null : 'commands'))}
            >
              <Command className="w-3.5 h-3.5" />
            </ComposerTool>
            {draft.trim() ? (
              <span className={`ml-1 hidden text-[10px] xl:inline ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                Cmd/Ctrl+Enter
              </span>
            ) : null}
            <ComposerTool
              isDark={isDark}
              title="Emoji"
              active={composerPanel === 'emoji'}
              onClick={() => setComposerPanel((panel) => (panel === 'emoji' ? null : 'emoji'))}
            >
              <Smile className="w-3.5 h-3.5" />
            </ComposerTool>
            <ComposerTool
              isDark={isDark}
              title="Attachments"
              active={composerPanel === 'attachments'}
              onClick={() => setComposerPanel((panel) => (panel === 'attachments' ? null : 'attachments'))}
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
              disabled={!draft.trim() || sending}
              data-testid="composer-send"
              whileHover={!draft.trim() || sending ? undefined : { scale: 1.06, y: -1 }}
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
              title={agentTasks.size > 0 ? `Agents working (${agentTasks.size}) — send to interrupt` : 'Send'}
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
      <ComposerPanelHeader isDark={isDark} label="Emoji" title="Close emoji" onClose={onClose} />
      <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
        {COMPOSER_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`Insert ${emoji}`}
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
      <ComposerPanelHeader isDark={isDark} label="Commands" title="Close commands" onClose={onClose} />
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
  const items = [
    { label: 'File', icon: <File className="h-4 w-4" />, action: onUploadAsset },
    { label: 'Photos', icon: <ImageIcon className="h-4 w-4" />, action: onUploadAsset },
    { label: 'Camera', icon: <Camera className="h-4 w-4" />, action: onUploadAsset },
    { label: 'Location', icon: <MapPin className="h-4 w-4" />, action: onShareLocation },
    ...(showAssets ? [{ label: 'Assets', icon: <Archive className="h-4 w-4" />, action: onOpenAssets }] : []),
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
      <ComposerPanelHeader isDark={isDark} label="Attach" title="Close attachments" onClose={onClose} />
      <div className="grid grid-cols-5 gap-1.5">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              item.action?.();
              if (item.label === 'File' && !item.action) onInsert('[File]');
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

function ComposerTool({
  isDark,
  title,
  active = false,
  onClick,
  children,
}: {
  isDark: boolean;
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${
        active
          ? isDark
            ? 'bg-violet-500/20 text-violet-200'
            : 'bg-violet-100 text-violet-700'
          : isDark
            ? 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-200'
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {children}
    </button>
  );
}

function SessionEmpty({ isDark, members, onFocus }: { isDark: boolean; members: GroupMember[]; onFocus: () => void }) {
  return (
    <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center px-4">
      <div
        className={`w-12 h-12 ${radius.pane} flex items-center justify-center border ${isDark ? 'border-white/[0.08] bg-white/[0.03] text-cyan-200' : 'border-zinc-200 bg-white text-cyan-700'}`}
      >
        <Sparkles className="w-5 h-5" />
      </div>
      <p className={`mt-3 text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Start the session</p>
      <p className={`mt-1 max-w-[260px] text-xs leading-relaxed ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
        Mention a role agent to dispatch context, or use /task to turn this thread into tracked work.
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
        {members.length > 0 ? 'Mention an agent' : 'Say hello'}
      </button>
    </div>
  );
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
  const lastActiveAt = conversation?.lastMessageAt ? formatDateDivider(conversation.lastMessageAt) : null;

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

function TypingRow({ status, isDark }: { status: AgentTaskStatus; isDark: boolean }) {
  const label = status.phase === 'executing' ? 'Executing' : 'Thinking';
  const detail = status.message?.trim();
  const progressPct = typeof status.progress === 'number' ? Math.round(status.progress * 100) : null;
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
          <Bot className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="flex min-w-0 max-w-[82%] flex-col items-start">
        <div
          className={`relative overflow-hidden rounded-[22px] rounded-bl-md border px-3.5 py-2.5 backdrop-blur-xl ${
            isDark
              ? 'border-white/[0.08] bg-white/[0.05] text-zinc-200'
              : 'border-zinc-200/80 bg-white/85 text-zinc-700'
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
          </div>
          {detail ? (
            <p className={`mt-1 text-[13px] leading-relaxed ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{detail}</p>
          ) : null}
        </div>
      </div>
    </motion.div>
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
  onOpenTask,
  onOpenAsset,
  triggerStatus,
  linkedTaskIds,
  onSaveAsMemory,
}: {
  message: MessageDTO;
  member?: GroupMember;
  showSender: boolean;
  isOwn: boolean;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
  onOpenAsset?: (assetId: string) => void;
  triggerStatus?: TaskStatusEventInfo;
  /** TaskIds that resolve to a real kanban card in this conversation. */
  linkedTaskIds?: ReadonlySet<string>;
  /** Memory Line B / B4 — opens the SaveAsMemoryModal at the workspace level. */
  onSaveAsMemory?: () => void;
}) {
  const senderName = isOwn ? 'You' : member?.displayName || member?.username || message.senderId.slice(-10);
  const contentType = message.contentType ?? message.type ?? 'text';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.985, filter: 'blur(4px)' }}
      animate={{ opacity: message.pending ? 0.62 : 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      transition={springSoft}
      className={`flex w-full gap-2.5 ${isOwn ? 'justify-end' : 'justify-start'} ${showSender ? 'mt-3' : 'mt-1'}`}
    >
      {!isOwn ? (
        <div className="w-8 shrink-0 pt-5">
          {showSender ? <Avatar seed={message.senderId} label={senderName} isAgent /> : null}
        </div>
      ) : null}
      {/*
        Outer column owns the row's max-width budget (82% of the message
        list). The inner column shrinks to fit the bubble width, while
        siblings (MessageActionBar) can grow up to the outer cap so short
        bubbles like "在的 👋" don't wrap the action chips onto two lines.
      */}
      <div className={`flex min-w-0 max-w-[82%] flex-col overflow-hidden ${isOwn ? 'items-end' : 'items-start'}`}>
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
                  title="Failed to send"
                >
                  <AlertCircle className="h-3 w-3" /> failed
                </span>
              ) : null}
            </div>
          ) : null}
          <div
            data-testid={`im-message-bubble-${message.id}`}
            onContextMenu={
              onSaveAsMemory
                ? (event) => {
                    event.preventDefault();
                    onSaveAsMemory();
                  }
                : undefined
            }
            className={`relative max-w-full overflow-hidden border px-3.5 py-2.5 shadow-[0_18px_60px_-35px_rgba(15,23,42,0.8)] backdrop-blur-xl [overflow-wrap:anywhere] ${
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
            <MessageBody message={message} contentType={contentType} isOwn={isOwn} />
            <MessageAssetAttachment message={message} isDark={isDark} inOwnBubble={isOwn} onOpenAsset={onOpenAsset} />
            <MessageTaskLinks message={message} isDark={isDark} inOwnBubble={isOwn} onOpenTask={onOpenTask} />
          </div>
        </div>
        <MessageActionBar message={message} isDark={isDark} onOpenTask={onOpenTask} linkedTaskIds={linkedTaskIds} />
        {triggerStatus ? (
          <MessageTriggerStatusChip
            triggerMessageId={message.id}
            event={triggerStatus}
            isDark={isDark}
            onOpenTask={onOpenTask}
          />
        ) : null}
        {!showSender ? null : isOwn && !message.failed ? (
          <span className={`mt-1 px-1 text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {message.pending ? 'Sending' : 'Sent'}
          </span>
        ) : null}
      </div>
      {isOwn ? <div className="w-1 shrink-0" /> : null}
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
  const palette =
    event.status === 'completed'
      ? isDark
        ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : event.status === 'failed'
        ? isDark
          ? 'border-rose-300/30 bg-rose-500/10 text-rose-200'
          : 'border-rose-200 bg-rose-50 text-rose-700'
        : isDark
          ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-300'
          : 'border-zinc-200 bg-zinc-50 text-zinc-600';
  const Icon = event.status === 'completed' ? Check : event.status === 'failed' ? X : CircleSlash;
  const label =
    event.status === 'completed' ? 'Task completed' : event.status === 'failed' ? 'Task failed' : 'Task cancelled';
  const clickable = Boolean(onOpenTask);
  return (
    <button
      type="button"
      onClick={() => onOpenTask?.(event.taskId)}
      disabled={!clickable}
      data-testid={`message-trigger-status-${triggerMessageId}`}
      data-status={event.status}
      data-task-id={event.taskId}
      className={`mt-1 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${palette} disabled:cursor-default disabled:opacity-80`}
      title={clickable ? `Open ${event.taskTitle || 'task'}` : event.taskTitle || label}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

// Wave-8 W7 — centred chip row rendered for `metadata.kind='task_status_event'`
// system messages. Distinct from regular MessageRow: no avatar, no sender
// label, no bubble — just a horizontal pill that floats in the middle of
// the feed.
function TaskStatusEventRow({
  event,
  isDark,
  onOpenTask,
}: {
  event: TaskStatusEventInfo;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
}) {
  const palette =
    event.status === 'completed'
      ? isDark
        ? 'border-emerald-300/30 bg-emerald-500/10 text-emerald-100'
        : 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : event.status === 'failed'
        ? isDark
          ? 'border-rose-300/30 bg-rose-500/10 text-rose-100'
          : 'border-rose-200 bg-rose-50 text-rose-800'
        : isDark
          ? 'border-zinc-300/20 bg-zinc-500/10 text-zinc-200'
          : 'border-zinc-200 bg-zinc-50 text-zinc-700';
  const StatusIcon = event.status === 'completed' ? CheckCircle2 : event.status === 'failed' ? XCircle : Ban;
  const label =
    event.status === 'completed' ? 'Task completed' : event.status === 'failed' ? 'Task failed' : 'Task cancelled';
  const titleText = event.taskTitle || event.taskId.slice(-8);
  const clickable = Boolean(onOpenTask);
  return (
    <div className="my-2 flex w-full justify-center" data-testid={`task-status-event-${event.taskId}`}>
      <button
        type="button"
        onClick={() => onOpenTask?.(event.taskId)}
        disabled={!clickable}
        data-status={event.status}
        className={`inline-flex max-w-[80%] items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur transition-colors ${palette} disabled:cursor-default disabled:opacity-90`}
        title={clickable ? `Open ${titleText}` : titleText}
      >
        <StatusIcon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
        <span>{label}:</span>
        <span className="truncate">{titleText}</span>
        {event.status === 'failed' && event.error ? (
          <span className={`truncate text-[10px] opacity-80`}>· {event.error}</span>
        ) : null}
      </button>
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

function MessageActionBar({
  message,
  isDark,
  onOpenTask,
  linkedTaskIds,
}: {
  message: MessageDTO;
  isDark: boolean;
  onOpenTask?: (taskId: string) => void;
  /** When provided, "Open card" only renders for taskIds that resolve to a
   *  real kanban card. Without this, every agent_reply gets the chip even
   *  when the run was an internal/already-deleted task. */
  linkedTaskIds?: ReadonlySet<string>;
}) {
  const meta = useMemo(() => normalizeMetadata(message.metadata), [message.metadata]);
  const isAgentReply = meta.kind === 'agent_reply';
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<TaskLogEntry[] | null>(null);
  const [taskMeta, setTaskMeta] = useState<TaskLogResponse['task'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set after the first fetch reveals: 404 (task gone) or 0 progress logs.
  // When true, the entire action bar disappears so the user isn't left with
  // a dead "Show actions" chip that pops a "Failed" or "No tool actions"
  // banner on every click.
  const [actionsUnavailable, setActionsUnavailable] = useState(false);

  const actions = useMemo(() => {
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
  }, [logs]);

  const onToggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (logs || !taskId) return;
    setLoading(true);
    setError(null);
    const res = await imFetch<TaskLogResponse>(`/tasks/${taskId}`);
    setLoading(false);
    if (!res.ok) {
      // Task was deleted/internal/never persisted — pop the action bar
      // entirely so the dead chip stops cluttering the message.
      setActionsUnavailable(true);
      return;
    }
    const fetchedLogs = res.data.logs ?? [];
    const progressCount = fetchedLogs.filter((log) => log.action === 'progress').length;
    if (progressCount === 0) {
      // Agent answered without tool calls — same treatment, retire the bar
      // instead of expanding to "No tool actions" every time.
      setActionsUnavailable(true);
      return;
    }
    setLogs(fetchedLogs);
    setTaskMeta(res.data.task ?? null);
  }, [expanded, logs, taskId]);

  // Gate logic:
  //   · `isAgentReply + taskId` — required base condition (revert of the
  //     orphan `showTaskControls` guard from aebe2d10).
  //   · `actionsUnavailable` — first fetch revealed the task is gone or
  //     has no actions; collapse the whole footer.
  //   · `hasCard` — taskId resolves to a real kanban card in linkedTasks.
  //     Decides whether "Open card" chip renders.
  // If neither chip would render (no card AND actions unavailable), the
  // entire bar is null.
  if (!isAgentReply || !taskId) return null;
  const hasCard = !!linkedTaskIds && linkedTaskIds.has(taskId);
  if (actionsUnavailable && !hasCard) return null;

  const actionCount = logs ? actions.length : null;
  const durationLabel = taskMeta?.durationMs != null ? `${(taskMeta.durationMs / 1000).toFixed(1)}s` : null;
  const statusChipClass = isDark
    ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.06]'
    : 'border-zinc-200 bg-white/70 text-zinc-600 hover:bg-zinc-50';

  return (
    <div className="mt-1.5 flex max-w-full flex-col overflow-hidden">
      {/*
        Chips lay out in a flex row that wraps only if the entire action
        bar (sized by the outer 82% row column, not the bubble) runs out
        of space. Each chip is whitespace-nowrap + shrink-0 so the label
        text never breaks across two lines.
      */}
      <div className="flex max-w-full flex-row flex-wrap items-center gap-1 overflow-hidden">
        {actionsUnavailable ? null : (
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
                  ? 'Loading actions…'
                  : 'Show actions'
                : `${actionCount} action${actionCount === 1 ? '' : 's'}`}
            </span>
            {durationLabel ? <span className="opacity-60">· {durationLabel}</span> : null}
          </button>
        )}
        {hasCard && onOpenTask ? (
          <button
            type="button"
            onClick={() => onOpenTask(taskId)}
            data-testid={`message-open-task-${taskId}`}
            className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${statusChipClass}`}
          >
            <MessageSquare className="h-3 w-3" />
            Open card
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
                <p className="text-rose-500">Failed: {error}</p>
              ) : loading ? (
                <p className="opacity-70">Loading…</p>
              ) : actions.length === 0 ? (
                <p className="opacity-70">Agent answered without tool calls.</p>
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
  const [open, setOpen] = useState(false);
  const isReasoning = entry.kind === 'reasoning';
  const Icon = isReasoning ? Brain : Wrench;
  const title = isReasoning ? 'Reasoning' : entry.tool || entry.message || 'tool';
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
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider opacity-60">arguments</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(entry.arguments, null, 2)}</pre>
            </details>
          ) : null}
          {entry.result != null ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider opacity-60">result</summary>
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
interface AttachmentMeta {
  id: string;
  title: string;
  mime: string | null;
  kind: string;
  sizeBytes: number | null;
}

function parseAttachmentsFromMetadata(meta: Record<string, unknown>): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : typeof obj.assetId === 'string' ? obj.assetId : null;
    if (!id || seen.has(id)) return;
    seen.add(id);
    const kindStr = typeof obj.kind === 'string' ? obj.kind : 'asset';
    out.push({
      id,
      title: typeof obj.title === 'string' && obj.title ? obj.title : `[${kindStr}]`,
      mime: typeof obj.mime === 'string' ? obj.mime : null,
      kind: kindStr,
      sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : null,
    });
  };
  // Legacy single-attachment shape (current sendAssetAttachment writes this).
  if (meta.kind === 'workspace_asset_attachment' && typeof meta.asset === 'object') push(meta.asset);
  // Forward-compatible plural shape — future SDK or import flows may write
  // `metadata.attachments: [{...}]` for batch attachments. Either shape is
  // accepted; both can coexist in a single message.
  if (Array.isArray(meta.attachments)) {
    for (const item of meta.attachments) push(item);
  }
  return out;
}

function attachmentMimeBucket(mime: string | null): 'image' | 'video' | 'audio' | 'pdf' | 'other' {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m.endsWith('/pdf')) return 'pdf';
  return 'other';
}

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
  const metadata = normalizeMetadata(message.metadata);
  const attachments = useMemo(() => parseAttachmentsFromMetadata(metadata), [metadata]);
  if (attachments.length === 0) return null;
  const MAX_RENDER = 4;
  const visible = attachments.slice(0, MAX_RENDER);
  const overflow = attachments.length - visible.length;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {visible.map((att) => (
        <AttachmentPreview
          key={att.id}
          attachment={att}
          isDark={isDark}
          inOwnBubble={inOwnBubble}
          onOpenAsset={onOpenAsset}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => onOpenAsset?.(attachments[MAX_RENDER]!.id)}
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
  );
}

/**
 * One asset row inside a chat bubble. Image / video / audio render inline
 * media; pdf and generic files render a click-to-open file row. All clicks
 * fire `onOpenAsset(id)` so the inspector dialog handles full preview.
 */
function AttachmentPreview({
  attachment,
  isDark,
  inOwnBubble,
  onOpenAsset,
}: {
  attachment: AttachmentMeta;
  isDark: boolean;
  inOwnBubble: boolean;
  onOpenAsset?: (assetId: string) => void;
}) {
  const bucket = attachmentMimeBucket(attachment.mime);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Image / video / audio bytes need an auth header. We pre-fetch and feed
  // an object URL to the native <img/video/audio src>. Pdf + generic don't
  // preview inline so we skip the bytes fetch.
  const wantsBytes = bucket === 'image' || bucket === 'video' || bucket === 'audio';
  useEffect(() => {
    if (!wantsBytes) return;
    let cancelled = false;
    let url: string | null = null;
    const token = getWorkspaceToken();
    if (!token) {
      setLoadError('No auth token');
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/im/assets/${encodeURIComponent(attachment.id)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.id, wantsBytes]);

  const onActivate = useCallback(() => onOpenAsset?.(attachment.id), [attachment.id, onOpenAsset]);

  // Image — inline <img> thumbnail, click opens inspector.
  if (bucket === 'image') {
    return (
      <button
        type="button"
        onClick={onActivate}
        title={attachment.title}
        data-testid={`chat-asset-thumb-${attachment.id}`}
        className={`group relative block max-w-full overflow-hidden rounded-2xl border sm:max-w-[240px] ${
          inOwnBubble ? 'border-white/20' : isDark ? 'border-white/[0.08]' : 'border-zinc-200'
        }`}
      >
        {objectUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={objectUrl}
            alt={attachment.title || '[image]'}
            loading="lazy"
            className="h-auto max-h-60 w-full max-w-[240px] object-cover"
          />
        ) : (
          <span
            className={`flex h-32 w-full min-w-[180px] max-w-[240px] items-center justify-center text-[10px] ${
              inOwnBubble
                ? 'bg-white/10 text-white/70'
                : isDark
                  ? 'bg-white/[0.04] text-zinc-500'
                  : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            {loadError ? `image · ${loadError}` : 'loading image…'}
          </span>
        )}
      </button>
    );
  }

  // Video — inline <video> with a play-icon overlay; click opens inspector.
  if (bucket === 'video') {
    return (
      <button
        type="button"
        onClick={onActivate}
        title={attachment.title}
        data-testid={`chat-asset-thumb-${attachment.id}`}
        className={`group relative block max-w-full overflow-hidden rounded-2xl border sm:max-w-[240px] ${
          inOwnBubble ? 'border-white/20' : isDark ? 'border-white/[0.08]' : 'border-zinc-200'
        }`}
      >
        {objectUrl ? (
          <>
            <video
              src={objectUrl}
              preload="metadata"
              muted
              playsInline
              controlsList="nodownload"
              className="h-auto max-h-60 w-full max-w-[240px] object-cover"
            />
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition group-hover:bg-black/45"
              aria-hidden="true"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/85 text-zinc-900 shadow-lg">
                <Play className="h-4 w-4" />
              </span>
            </span>
          </>
        ) : (
          <span
            className={`flex h-32 w-[240px] items-center justify-center gap-2 text-[10px] ${
              inOwnBubble
                ? 'bg-white/10 text-white/70'
                : isDark
                  ? 'bg-white/[0.04] text-zinc-500'
                  : 'bg-zinc-100 text-zinc-500'
            }`}
          >
            <Video className="h-3 w-3" />
            {loadError ? `video · ${loadError}` : 'loading video…'}
          </span>
        )}
      </button>
    );
  }

  // Audio — inline <audio controls>. Title row clickable for inspector;
  // <audio> element captures its own clicks for play/seek.
  if (bucket === 'audio') {
    return (
      <div
        data-testid={`chat-asset-thumb-${attachment.id}`}
        className={`flex max-w-[280px] flex-col gap-1.5 rounded-2xl border px-3 py-2 ${
          inOwnBubble
            ? 'border-white/20 bg-white/15'
            : isDark
              ? 'border-white/[0.08] bg-white/[0.04]'
              : 'border-zinc-200 bg-zinc-50'
        }`}
      >
        <button
          type="button"
          onClick={onActivate}
          className={`flex items-center gap-2 text-left ${
            inOwnBubble ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          <Music className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{attachment.title || '[audio]'}</span>
          {attachment.sizeBytes != null ? (
            <span
              className={`shrink-0 text-[10px] ${
                inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
              }`}
            >
              {formatBytes(attachment.sizeBytes)}
            </span>
          ) : null}
        </button>
        {objectUrl ? (
          <audio src={objectUrl} controls preload="metadata" className="w-full" />
        ) : (
          <span className={`text-[10px] ${inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {loadError ? `audio · ${loadError}` : 'loading audio…'}
          </span>
        )}
      </div>
    );
  }

  // PDF + everything else — file row. Differentiated icon (FileText for pdf,
  // Archive otherwise) but otherwise one shared layout.
  const Icon = bucket === 'pdf' ? FileText : Archive;
  const subline = `${attachment.kind} · ${attachment.mime ?? 'unknown mime'}${
    attachment.sizeBytes != null ? ` · ${formatBytes(attachment.sizeBytes)}` : ''
  }`;
  return (
    <button
      type="button"
      onClick={onActivate}
      title={attachment.title}
      data-testid={`chat-asset-file-${attachment.id}`}
      className={`flex w-full max-w-[320px] items-center gap-2 rounded-2xl border px-3 py-2 text-left transition ${
        inOwnBubble
          ? 'border-white/20 bg-white/15 hover:bg-white/20'
          : isDark
            ? 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07]'
            : 'border-zinc-200 bg-zinc-50 hover:bg-zinc-100'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          inOwnBubble
            ? 'bg-white/15 text-white'
            : isDark
              ? 'bg-violet-500/15 text-violet-200'
              : 'bg-violet-100 text-violet-700'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs font-semibold ${
            inOwnBubble ? 'text-white' : isDark ? 'text-zinc-100' : 'text-zinc-900'
          }`}
        >
          {attachment.title || `[${attachment.kind}]`}
        </span>
        <span
          className={`block truncate text-[10px] ${
            inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-500'
          }`}
        >
          {subline}
        </span>
      </span>
      <CloudDownload
        className={`h-3.5 w-3.5 ${inOwnBubble ? 'text-white/70' : isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      />
    </button>
  );
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

function Avatar({ seed, label, isAgent }: { seed: string; label: string; isAgent?: boolean }) {
  const grad = avatarGradient(seed || label);
  return (
    <span
      className="inline-flex w-7 h-7 items-center justify-center rounded-xl text-[10px] font-bold text-white shadow-sm"
      style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
      title={label}
    >
      {isAgent ? <Bot className="w-3.5 h-3.5" /> : avatarInitials(label)}
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
  assets,
  onOpenTask,
  onOpenAgent,
  onOpenAsset,
}: {
  isDark: boolean;
  tasks: TaskDTO[];
  agents: AgentDTO[];
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

  const agentChip = (agent: AgentDTO) => (
    <button
      key={agent.userId}
      type="button"
      data-testid={`channel-linked-agent-${agent.agentId}`}
      onClick={() => onOpenAgent?.(agent.agentId)}
      title={`@${agent.name}`}
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 leading-4 ${
        isDark
          ? 'border-violet-300/20 bg-violet-500/10 text-violet-200 hover:bg-violet-500/15'
          : 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100'
      }`}
    >
      <Bot className="h-3 w-3 shrink-0" />
      <span className="max-w-[120px] truncate">@{agent.name}</span>
    </button>
  );

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

function formatDateDivider(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const day = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
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

function MessageBody({ message, contentType, isOwn }: { message: MessageDTO; contentType: string; isOwn: boolean }) {
  if (contentType !== 'text' && contentType !== 'markdown') {
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
      className={`prose-chat max-w-full break-words text-[15px] leading-relaxed [&_*]:max-w-full [&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_strong]:font-semibold [&_em]:italic [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-2 [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:opacity-80 [&_hr]:my-2 [&_hr]:opacity-30`}
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
                className={`rounded px-1 py-0.5 font-mono text-[13px] ${
                  isOwn ? 'bg-white/15' : 'bg-black/[0.06] dark:bg-white/[0.08]'
                }`}
                {...props}
              >
                {children}
              </code>
            );
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
