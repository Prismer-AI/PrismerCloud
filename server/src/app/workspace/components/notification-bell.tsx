'use client';

/**
 * Wave-8 W9 — Workspace Bell drawer.
 *
 * Aggregates three event streams the workspace shell already emits into a
 * single popover the operator can scan-read between surfaces:
 *
 *   • Tasks      — `task_assigned` / `task_status` / `task_approval_requested`
 *   • Contacts   — `contact_request` / `contact_accepted` / `contact_blocked`
 *                  (legacy `contact` ref-type from Wave-8 W3 also flows here)
 *   • Runtime    — `runtime_install_verified` / `runtime_install_failed`
 *                  / `runtime_agent_declared` / `runtime_degraded`
 *
 * The drawer reads from `/api/notifications` (FF_NOTIFICATIONS_LOCAL must be
 * on; without the flag pc_notifications stays empty and the drawer
 * gracefully reports "No notifications yet"). Click-through routes to the
 * surface in the parent — the parent owns `setActiveSurface` /
 * `setSelectedTaskId` so this component stays presentational.
 *
 * NOTE: this component lives next to the workspace shell rather than reusing
 * `src/components/navbar.tsx`'s NotificationDropdown because the workspace
 * needs:
 *   - tab-grouped views (the navbar drawer is flat),
 *   - per-row click-through routing into workspace surfaces,
 *   - SSE-driven refresh (not polling).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, Loader2, MessageSquare, Server, ListChecks } from 'lucide-react';
import { getWorkspaceToken } from '../lib/im-api';

export type NotificationTab = 'all' | 'tasks' | 'contacts' | 'runtime';

const TAB_QUERY: Record<Exclude<NotificationTab, 'all'>, string> = {
  tasks: 'tasks',
  contacts: 'contacts',
  runtime: 'runtime',
};

const TASK_KINDS = ['task_status', 'task_assigned', 'task_approval_requested', 'approval_requested'] as const;
const CONTACT_KINDS = ['contact_request', 'contact_accepted', 'contact_blocked', 'contact'] as const;
const RUNTIME_KINDS = [
  'runtime_degraded',
  'runtime_install_verified',
  'runtime_install_failed',
  'runtime_agent_declared',
] as const;

export interface NotificationDTO {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  time: string;
  read: boolean;
  referenceType?: string;
  referenceId?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface NotificationClickContext {
  taskId?: string;
  contactUserId?: string;
  /**
   * Set when the row is a contact event (contact_request / accepted / blocked
   * / contact). Lets the parent route to the Contacts surface even when the
   * payload doesn't carry a userId (W3 contact_request rows pre-date payload).
   */
  isContactEvent?: boolean;
  runtimeInstallationId?: string;
  conversationId?: string | null;
}

interface NotificationBellProps {
  isDark: boolean;
  /**
   * Click-through: parent maps the row to a surface + selection. Returning
   * `false` keeps the drawer open (e.g. row was for a kind the parent
   * doesn't know how to route — fallback is a no-op + leave drawer open).
   */
  onNotificationClick?: (notification: NotificationDTO, ctx: NotificationClickContext) => void;
  /**
   * Optional refreshTrigger — when the parent's SSE listener picks up a
   * task/contact/runtime event it bumps this number to force the bell to
   * re-pull. Cleaner than threading callbacks through both directions.
   */
  refreshTrigger?: number;
}

interface FetchResult {
  data: NotificationDTO[];
  unreadCount: number;
  unreadByKind: Record<string, number>;
}

async function fetchNotifications(token: string, kind: NotificationTab): Promise<FetchResult> {
  const url = kind === 'all' ? '/api/notifications' : `/api/notifications?kind=${TAB_QUERY[kind]}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { data: [], unreadCount: 0, unreadByKind: {} };
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: NotificationDTO[];
    unreadCount?: number;
    unreadByKind?: Record<string, number>;
  } | null;
  return {
    data: body?.data ?? [],
    unreadCount: body?.unreadCount ?? 0,
    unreadByKind: body?.unreadByKind ?? {},
  };
}

function classifyKind(referenceType: string | undefined): NotificationTab {
  if (!referenceType) return 'all';
  if (TASK_KINDS.includes(referenceType as (typeof TASK_KINDS)[number])) return 'tasks';
  if (CONTACT_KINDS.includes(referenceType as (typeof CONTACT_KINDS)[number])) return 'contacts';
  if (RUNTIME_KINDS.includes(referenceType as (typeof RUNTIME_KINDS)[number])) return 'runtime';
  return 'all';
}

function unreadForTab(byKind: Record<string, number>, tab: NotificationTab): number {
  if (tab === 'all') return Object.values(byKind).reduce((sum, n) => sum + (n ?? 0), 0);
  const kinds: readonly string[] = tab === 'tasks' ? TASK_KINDS : tab === 'contacts' ? CONTACT_KINDS : RUNTIME_KINDS;
  return kinds.reduce((sum, k) => sum + (byKind[k] ?? 0), 0);
}

function rowIcon(kind: NotificationTab) {
  if (kind === 'tasks') return ListChecks;
  if (kind === 'contacts') return MessageSquare;
  if (kind === 'runtime') return Server;
  return Bell;
}

function deriveClickContext(notification: NotificationDTO): NotificationClickContext {
  const payload = (notification.payload ?? {}) as Record<string, unknown>;
  const ctx: NotificationClickContext = {};
  if (typeof payload.taskId === 'string') ctx.taskId = payload.taskId;
  if (typeof payload.runtimeInstallationId === 'string') ctx.runtimeInstallationId = payload.runtimeInstallationId;
  if (typeof payload.conversationId === 'string' || payload.conversationId === null) {
    ctx.conversationId = (payload.conversationId as string | null) ?? null;
  }
  // contact rows store the reference id as the friend-request id, not the
  // user id. The parent will look up the contact row by request id when it
  // routes; we still surface payload.userId when present for new bells.
  if (typeof payload.fromUserId === 'string') ctx.contactUserId = payload.fromUserId;
  if (typeof payload.userId === 'string' && !ctx.contactUserId) ctx.contactUserId = payload.userId;

  const tab = classifyKind(notification.referenceType);
  if (tab === 'contacts') ctx.isContactEvent = true;

  // Fallback: pre-payload rows (W3 contact_request) — referenceId IS the
  // request id, no userId in the payload. The parent's contacts panel will
  // ignore the click and just open the surface.
  if (!ctx.taskId && !ctx.runtimeInstallationId && !ctx.contactUserId && notification.referenceId) {
    if (tab === 'tasks') ctx.taskId = notification.referenceId;
    else if (tab === 'runtime') ctx.runtimeInstallationId = notification.referenceId;
  }
  return ctx;
}

export function NotificationBell({ isDark, onNotificationClick, refreshTrigger }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>('all');
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [unreadByKind, setUnreadByKind] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const totalUnread = useMemo(() => unreadForTab(unreadByKind, 'all'), [unreadByKind]);

  const reload = useCallback(async (forTab: NotificationTab) => {
    const token = getWorkspaceToken();
    if (!token) return;
    setLoading(true);
    try {
      const result = await fetchNotifications(token, forTab);
      setNotifications(result.data);
      setUnreadByKind(result.unreadByKind);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — also runs as a low-cost background poll every 60s in
  // addition to the SSE-driven refreshTrigger so any bell rows the SSE
  // stream missed (e.g. user reconnects mid-event) eventually surface.
  useEffect(() => {
    void reload(tab);
    const id = setInterval(() => void reload(tab), 60_000);
    return () => clearInterval(id);
  }, [tab, reload]);

  // Parent-driven refresh on SSE event tick
  useEffect(() => {
    if (refreshTrigger == null) return;
    void reload(tab);
  }, [refreshTrigger, tab, reload]);

  // Outside-click + Escape close
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (drawerRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleRowClick = useCallback(
    async (notification: NotificationDTO) => {
      const token = getWorkspaceToken();
      if (token && !notification.read) {
        // Optimistic — flip the row + decrement counts before the round trip
        setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
        const refType = notification.referenceType;
        if (refType) {
          setUnreadByKind((prev) => ({
            ...prev,
            [refType]: Math.max(0, (prev[refType] ?? 0) - 1),
          }));
        }
        try {
          await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/read`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          /* read flip is best-effort — server-side reload reconciles next. */
        }
      }

      const ctx = deriveClickContext(notification);
      onNotificationClick?.(notification, ctx);
      setOpen(false);
    },
    [onNotificationClick],
  );

  const handleMarkAllRead = useCallback(async () => {
    const token = getWorkspaceToken();
    if (!token) return;
    const params = tab === 'all' ? '' : `?kind=${TAB_QUERY[tab]}`;
    await fetch(`/api/notifications/mark-all-read${params}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    await reload(tab);
  }, [tab, reload]);

  const tabs: { key: NotificationTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'contacts', label: 'Contacts' },
    { key: 'runtime', label: 'Runtime' },
  ];

  return (
    <Fragment>
      <button
        ref={buttonRef}
        type="button"
        data-testid="bell-button"
        data-unread-count={totalUnread}
        onClick={() => setOpen((v) => !v)}
        title={totalUnread > 0 ? `${totalUnread} unread notifications` : 'Notifications'}
        className={`relative p-2 rounded-full transition-colors ${
          isDark
            ? 'text-zinc-400 hover:text-white hover:bg-white/5'
            : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
        }`}
      >
        <Bell className="w-[18px] h-[18px]" />
        {totalUnread > 0 ? (
          <span
            data-testid="bell-unread-badge"
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 bg-violet-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center animate-in fade-in zoom-in duration-200"
          >
            {totalUnread > 9 ? '9+' : totalUnread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={drawerRef}
          data-testid="bell-drawer"
          className={`absolute right-2 top-[calc(100%+8px)] z-50 w-[360px] max-w-[92vw] rounded-2xl border shadow-2xl overflow-hidden ${
            isDark ? 'bg-zinc-950/95 border-white/[0.08] backdrop-blur' : 'bg-white border-zinc-200'
          }`}
        >
          <div
            className={`flex items-center justify-between px-4 py-3 border-b ${
              isDark ? 'border-white/[0.06]' : 'border-zinc-200'
            }`}
          >
            <h3 className={`text-sm font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>Notifications</h3>
            <button
              type="button"
              data-testid="notification-mark-all-read"
              onClick={handleMarkAllRead}
              disabled={loading || unreadForTab(unreadByKind, tab) === 0}
              className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                unreadForTab(unreadByKind, tab) === 0
                  ? isDark
                    ? 'text-zinc-700 cursor-not-allowed'
                    : 'text-zinc-300 cursor-not-allowed'
                  : isDark
                    ? 'text-violet-400 hover:text-violet-300'
                    : 'text-violet-600 hover:text-violet-700'
              }`}
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
          </div>

          <div
            className={`flex gap-1 px-3 py-2 border-b ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
            role="tablist"
          >
            {tabs.map((t) => {
              const tabUnread = unreadForTab(unreadByKind, t.key);
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  data-testid={`bell-tab-${t.key}`}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? isDark
                        ? 'bg-violet-500/20 text-violet-200'
                        : 'bg-violet-100 text-violet-800'
                      : isDark
                        ? 'text-zinc-400 hover:bg-white/[0.04]'
                        : 'text-zinc-600 hover:bg-zinc-100'
                  }`}
                >
                  {t.label}
                  {tabUnread > 0 ? (
                    <span
                      className={`inline-flex min-w-[16px] justify-center rounded-full px-1 text-[10px] font-bold ${
                        active
                          ? isDark
                            ? 'bg-violet-500/30 text-violet-100'
                            : 'bg-violet-200 text-violet-900'
                          : isDark
                            ? 'bg-white/10 text-zinc-300'
                            : 'bg-zinc-200 text-zinc-700'
                      }`}
                    >
                      {tabUnread > 9 ? '9+' : tabUnread}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="max-h-[480px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
              </div>
            ) : notifications.length === 0 ? (
              <div
                data-testid="bell-empty"
                className={`flex flex-col items-center justify-center py-10 px-4 text-center ${
                  isDark ? 'text-zinc-500' : 'text-zinc-500'
                }`}
              >
                <Bell className="w-6 h-6 mb-2 opacity-50" />
                <p className="text-sm font-medium">No notifications yet</p>
                <p className="text-xs mt-1 opacity-80">
                  {tab === 'all'
                    ? 'Tasks, contacts, and runtime events appear here.'
                    : tab === 'tasks'
                      ? 'New task assignments and completions will appear here.'
                      : tab === 'contacts'
                        ? 'Friend requests and contact events will appear here.'
                        : 'Runtime install + readiness events will appear here.'}
                </p>
              </div>
            ) : (
              <ul className="py-1">
                {notifications.map((notification) => {
                  const kind = classifyKind(notification.referenceType);
                  const Icon = rowIcon(kind);
                  const tone =
                    notification.type === 'success'
                      ? 'text-emerald-500'
                      : notification.type === 'warning'
                        ? 'text-amber-500'
                        : notification.type === 'error'
                          ? 'text-red-500'
                          : isDark
                            ? 'text-zinc-300'
                            : 'text-zinc-700';
                  return (
                    <li key={notification.id}>
                      <button
                        type="button"
                        data-testid={`notification-row-${notification.id}`}
                        data-kind={kind}
                        data-read={notification.read ? 'true' : 'false'}
                        onClick={() => void handleRowClick(notification)}
                        className={`relative flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                          isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50'
                        } ${notification.read ? 'opacity-70' : ''}`}
                      >
                        {!notification.read ? (
                          <span
                            className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-violet-500"
                            aria-hidden
                          />
                        ) : null}
                        <span className={`mt-0.5 ${tone}`}>
                          <Icon className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span
                              className={`text-sm font-semibold truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}
                            >
                              {notification.title}
                            </span>
                            <span
                              className={`shrink-0 text-[10px] uppercase tracking-wider ${
                                isDark ? 'text-zinc-500' : 'text-zinc-400'
                              }`}
                            >
                              {notification.time}
                            </span>
                          </span>
                          <span
                            className={`mt-0.5 block text-xs leading-snug ${
                              isDark ? 'text-zinc-400' : 'text-zinc-600'
                            }`}
                          >
                            {notification.message}
                          </span>
                        </span>
                        {notification.read ? (
                          <Check className={`w-3.5 h-3.5 shrink-0 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`} />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Fragment>
  );
}
