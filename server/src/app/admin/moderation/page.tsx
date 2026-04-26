'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Flag,
  Users,
  FileText,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  ShieldOff,
  ShieldCheck,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Dna,
  Wrench,
  Clock,
  Ban,
  Unlock,
  Trash2,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

type Tab = 'reports' | 'users' | 'content';

interface Report {
  id: string;
  reporterId: string;
  reporterName: string;
  targetType: 'gene' | 'skill';
  targetId: string;
  targetTitle: string;
  targetAuthor: string;
  reason: string;
  reasonDetail: string | null;
  status: 'pending' | 'upheld' | 'dismissed';
  frozenCredits: number;
  createdAt: string;
}

interface ModerationUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  banned: boolean;
  bannedAt: string | null;
  banReason: string | null;
  reportBanUntil: string | null;
  quarantineCount: number;
  publishCount: number;
  balance: number;
  trustTier: number;
}

interface ContentItem {
  id: string;
  contentType: 'gene' | 'skill';
  title?: string;
  name?: string;
  category: string;
  visibility?: string;
  status?: string;
  qualityScore: number;
  ownerAgentId?: string;
  author?: string;
  createdAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ============================================================================
// Auth helper
// ============================================================================

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const authStored = localStorage.getItem('prismer_auth');
    if (authStored) {
      const authData = JSON.parse(authStored);
      if (authData.token && authData.expiresAt > Date.now()) {
        headers['Authorization'] = `Bearer ${authData.token}`;
      }
    }
  } catch {}
  return headers;
}

// ============================================================================
// Shared sub-components
// ============================================================================

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'reports', label: 'Reports', Icon: Flag },
    { id: 'users', label: 'Users', Icon: Users },
    { id: 'content', label: 'Content', Icon: FileText },
  ];
  return (
    <div className="flex gap-1 p-1 rounded-xl backdrop-blur-xl bg-white/50 dark:bg-zinc-800/50 border border-white/20 dark:border-white/10 shadow w-fit">
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            active === id
              ? 'bg-white dark:bg-zinc-700 shadow text-zinc-900 dark:text-white'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
          }`}
        >
          <Icon size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}

function Pagination({ meta, onPage }: { meta: PaginationMeta; onPage: (p: number) => void }) {
  if (meta.totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-4 text-sm text-zinc-500 dark:text-zinc-400">
      <span>
        {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
      </span>
      <div className="flex gap-1">
        <button
          disabled={meta.page <= 1}
          onClick={() => onPage(meta.page - 1)}
          className="p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-zinc-700/60 disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="px-2 py-1">
          {meta.page} / {meta.totalPages}
        </span>
        <button
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
          className="p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-zinc-700/60 disabled:opacity-30"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    upheld: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    dismissed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700/40 dark:text-zinc-400',
    quarantined: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    published: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    banned: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? 'bg-zinc-100 text-zinc-500'}`}>
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: 'gene' | 'skill' }) {
  return type === 'gene' ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
      <Dna size={11} /> Gene
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
      <Wrench size={11} /> Skill
    </span>
  );
}

function QualityScore({ score }: { score: number }) {
  const color =
    score >= 0.5
      ? 'text-green-600 dark:text-green-400'
      : score >= 0.01
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400';
  return <span className={`font-mono text-xs font-semibold ${color}`}>{score.toFixed(3)}</span>;
}

// ============================================================================
// Tab 1 — Reports
// ============================================================================

function ReportsTab() {
  const [reports, setReports] = useState<Report[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const fetchReports = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (statusFilter !== 'all') params.set('status', statusFilter);
        const res = await fetch(`/api/im/admin/moderation/reports?${params}`, {
          headers: getAuthHeaders(),
        });
        const json = await res.json();
        if (json.ok) {
          setReports(json.data);
          setMeta({ ...meta, total: json.meta?.total || 0, totalPages: Math.ceil((json.meta?.total || 0) / 20) });
        }
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    fetchReports(1);
  }, [fetchReports]);

  async function decide(id: string, decision: 'upheld' | 'dismissed') {
    setActing(id);
    try {
      await fetch(`/api/im/admin/moderation/reports/${id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ decision }),
      });
      fetchReports(meta.page);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="upheld">Upheld</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <button
          onClick={() => fetchReports(meta.page)}
          className="p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-zinc-700/60 text-zinc-500 dark:text-zinc-400"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <span className="text-xs text-zinc-400 ml-auto">{meta.total} reports</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/20 dark:border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="backdrop-blur-xl bg-white/40 dark:bg-zinc-800/40 border-b border-white/20 dark:border-white/10">
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Target</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Reporter</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Reason</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Frozen</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Date</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && reports.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                  Loading...
                </td>
              </tr>
            ) : reports.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                  No reports found.
                </td>
              </tr>
            ) : (
              reports.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-b border-white/10 dark:border-white/5 transition-colors hover:bg-white/30 dark:hover:bg-zinc-700/30 ${
                    i % 2 === 0 ? 'bg-white/10 dark:bg-zinc-900/10' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate max-w-[180px]">
                        {r.targetTitle}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <TypeBadge type={r.targetType} />
                        <span className="text-xs text-zinc-400 truncate max-w-[100px]">by {r.targetAuthor}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300 text-xs">{r.reporterName}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-700 dark:text-zinc-200 text-xs">{r.reason}</div>
                    {r.reasonDetail && (
                      <div className="text-zinc-400 text-xs mt-0.5 truncate max-w-[160px]">{r.reasonDetail}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-amber-600 dark:text-amber-400">
                    {r.frozenCredits > 0 ? r.frozenCredits : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3">
                    {r.status === 'pending' ? (
                      <div className="flex gap-1.5">
                        <button
                          disabled={acting === r.id}
                          onClick={() => decide(r.id, 'upheld')}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50"
                        >
                          <CheckCircle size={12} /> Uphold
                        </button>
                        <button
                          disabled={acting === r.id}
                          onClick={() => decide(r.id, 'dismissed')}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                        >
                          <XCircle size={12} /> Dismiss
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination meta={meta} onPage={(p) => fetchReports(p)} />
    </div>
  );
}

// ============================================================================
// Tab 2 — Users
// ============================================================================

function UsersTab() {
  const [users, setUsers] = useState<ModerationUser[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const fetchUsers = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (search) params.set('search', search);
        if (filter !== 'all') params.set('filter', filter);
        const res = await fetch(`/api/im/admin/moderation/users?${params}`, {
          headers: getAuthHeaders(),
        });
        const json = await res.json();
        if (json.ok) {
          setUsers(json.data);
          setMeta({ ...meta, total: json.meta?.total || 0, totalPages: Math.ceil((json.meta?.total || 0) / 20) });
        }
      } finally {
        setLoading(false);
      }
    },
    [search, filter],
  );

  useEffect(() => {
    fetchUsers(1);
  }, [fetchUsers]);

  async function toggleBan(user: ModerationUser) {
    if (user.banned) {
      setActing(user.id);
      try {
        await fetch(`/api/im/admin/users/${user.id}/ban`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({ banned: false }),
        });
        fetchUsers(meta.page);
      } finally {
        setActing(null);
      }
    } else {
      const reason = window.prompt(`Ban reason for @${user.username}:`);
      if (reason === null) return;
      setActing(user.id);
      try {
        await fetch(`/api/im/admin/users/${user.id}/ban`, {
          method: 'PATCH',
          headers: getAuthHeaders(),
          body: JSON.stringify({ banned: true, reason }),
        });
        fetchUsers(meta.page);
      } finally {
        setActing(null);
      }
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchUsers(1)}
            placeholder="Search username…"
            className="pl-8 pr-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 w-48"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="all">All</option>
          <option value="banned">Banned</option>
          <option value="report-banned">Report-Banned</option>
        </select>
        <button
          onClick={() => fetchUsers(meta.page)}
          className="p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-zinc-700/60 text-zinc-500 dark:text-zinc-400"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <span className="text-xs text-zinc-400 ml-auto">{meta.total} users</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/20 dark:border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="backdrop-blur-xl bg-white/40 dark:bg-zinc-800/40 border-b border-white/20 dark:border-white/10">
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">User</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Role / Tier</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Balance</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">
                Published / Quarantined
              </th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Report Ban</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                  Loading...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-400">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((u, i) => (
                <tr
                  key={u.id}
                  className={`border-b border-white/10 dark:border-white/5 transition-colors hover:bg-white/30 dark:hover:bg-zinc-700/30 ${
                    u.banned ? 'bg-red-50/40 dark:bg-red-900/10' : i % 2 === 0 ? 'bg-white/10 dark:bg-zinc-900/10' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">@{u.username}</div>
                    <div className="text-xs text-zinc-400">{u.displayName}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                    <div>{u.role}</div>
                    <div className="mt-0.5">T{u.trustTier}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-300">
                    {u.balance.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-300">
                    <span className="text-blue-600 dark:text-blue-400">{u.publishCount}</span>
                    {' / '}
                    <span className={u.quarantineCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-zinc-400'}>
                      {u.quarantineCount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {u.reportBanUntil ? (
                      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <Clock size={11} />
                        {new Date(u.reportBanUntil).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.banned ? (
                      <div>
                        <StatusBadge status="banned" />
                        {u.banReason && (
                          <div className="text-xs text-zinc-400 mt-1 truncate max-w-[120px]">{u.banReason}</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400">active</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.banned ? (
                      <button
                        disabled={acting === u.id}
                        onClick={() => toggleBan(u)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50"
                      >
                        <Unlock size={12} /> Unban
                      </button>
                    ) : (
                      <button
                        disabled={acting === u.id}
                        onClick={() => toggleBan(u)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                      >
                        <Ban size={12} /> Ban
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination meta={meta} onPage={(p) => fetchUsers(p)} />
    </div>
  );
}

// ============================================================================
// Tab 3 — Content
// ============================================================================

function ContentTab() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scoreEdit, setScoreEdit] = useState<{ id: string; value: string } | null>(null);

  const fetchContent = useCallback(
    async (page = 1) => {
      setLoading(true);
      setSelected(new Set());
      try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (search) params.set('search', search);
        if (typeFilter !== 'all') params.set('type', typeFilter);
        if (statusFilter !== 'all') params.set('filter', statusFilter);
        const res = await fetch(`/api/im/admin/moderation/content?${params}`, {
          headers: getAuthHeaders(),
        });
        const json = await res.json();
        if (json.ok) {
          setItems(json.data);
          setMeta({ ...meta, total: json.meta?.total || 0, totalPages: Math.ceil((json.meta?.total || 0) / 20) });
        }
      } finally {
        setLoading(false);
      }
    },
    [search, typeFilter, statusFilter],
  );

  useEffect(() => {
    fetchContent(1);
  }, [fetchContent]);

  async function patchContent(id: string, contentType: 'gene' | 'skill', action: string, score?: number) {
    setActing(id);
    try {
      await fetch(`/api/im/admin/moderation/content/${id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, contentType, ...(score !== undefined ? { score } : {}) }),
      });
      fetchContent(meta.page);
    } finally {
      setActing(null);
    }
  }

  async function batchAction(action: 'quarantine' | 'restore', contentType: 'gene' | 'skill') {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await fetch('/api/im/admin/moderation/content/batch', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, contentType, ids }),
      });
      setSelected(new Set());
      fetchContent(meta.page);
    } catch {}
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((i) => i.id)));
    }
  }

  function getStatus(item: ContentItem): string {
    return item.status ?? item.visibility ?? 'unknown';
  }

  const selectedGenes = items.filter((i) => selected.has(i.id) && i.contentType === 'gene');
  const selectedSkills = items.filter((i) => selected.has(i.id) && i.contentType === 'skill');

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchContent(1)}
            placeholder="Search content…"
            className="pl-8 pr-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 w-48"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="all">All Types</option>
          <option value="gene">Gene</option>
          <option value="skill">Skill</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm border border-white/20 dark:border-white/10 backdrop-blur-xl bg-white/70 dark:bg-zinc-800/70 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="all">All Status</option>
          <option value="published">Published</option>
          <option value="quarantined">Quarantined</option>
          <option value="low-score">Low Score</option>
        </select>
        <button
          onClick={() => fetchContent(meta.page)}
          className="p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-zinc-700/60 text-zinc-500 dark:text-zinc-400"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <span className="text-xs text-zinc-400 ml-auto">{meta.total} items</span>
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl backdrop-blur-xl bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/20 text-sm">
          <span className="font-medium text-blue-700 dark:text-blue-300">{selected.size} selected</span>
          {selectedGenes.length > 0 && (
            <>
              <button
                onClick={() => batchAction('quarantine', 'gene')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
              >
                <ShieldOff size={12} /> Quarantine {selectedGenes.length} gene{selectedGenes.length > 1 ? 's' : ''}
              </button>
              <button
                onClick={() => batchAction('restore', 'gene')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors"
              >
                <ShieldCheck size={12} /> Restore {selectedGenes.length} gene{selectedGenes.length > 1 ? 's' : ''}
              </button>
            </>
          )}
          {selectedSkills.length > 0 && (
            <>
              <button
                onClick={() => batchAction('quarantine', 'skill')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors"
              >
                <ShieldOff size={12} /> Quarantine {selectedSkills.length} skill{selectedSkills.length > 1 ? 's' : ''}
              </button>
              <button
                onClick={() => batchAction('restore', 'skill')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors"
              >
                <ShieldCheck size={12} /> Restore {selectedSkills.length} skill{selectedSkills.length > 1 ? 's' : ''}
              </button>
            </>
          )}
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/20 dark:border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="backdrop-blur-xl bg-white/40 dark:bg-zinc-800/40 border-b border-white/20 dark:border-white/10">
              <th className="px-4 py-3 w-8">
                <input
                  type="checkbox"
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={toggleAll}
                  className="rounded"
                />
              </th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Title</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Type</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Category</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Score</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Author</th>
              <th className="px-4 py-3 text-left font-semibold text-zinc-600 dark:text-zinc-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-400">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-400">
                  No content found.
                </td>
              </tr>
            ) : (
              items.map((item, i) => {
                const title = item.title ?? item.name ?? item.id;
                const status = getStatus(item);
                const isActing = acting === item.id;
                return (
                  <tr
                    key={item.id}
                    className={`border-b border-white/10 dark:border-white/5 transition-colors hover:bg-white/30 dark:hover:bg-zinc-700/30 ${
                      selected.has(item.id)
                        ? 'bg-blue-50/30 dark:bg-blue-900/10'
                        : i % 2 === 0
                          ? 'bg-white/10 dark:bg-zinc-900/10'
                          : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate max-w-[200px] block">
                        {title}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <TypeBadge type={item.contentType} />
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">{item.category}</td>
                    <td className="px-4 py-3">
                      {scoreEdit?.id === item.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.01}
                            value={scoreEdit.value}
                            onChange={(e) => setScoreEdit({ id: item.id, value: e.target.value })}
                            className="w-16 px-1.5 py-0.5 rounded text-xs border border-white/20 dark:border-white/10 bg-white/70 dark:bg-zinc-700/70 text-zinc-800 dark:text-zinc-100 focus:outline-none"
                          />
                          <button
                            onClick={() => {
                              const score = parseFloat(scoreEdit.value);
                              if (!isNaN(score)) {
                                patchContent(item.id, item.contentType, 'set-score', score);
                              }
                              setScoreEdit(null);
                            }}
                            className="text-xs text-green-600 dark:text-green-400 hover:underline"
                          >
                            Save
                          </button>
                          <button onClick={() => setScoreEdit(null)} className="text-xs text-zinc-400 hover:underline">
                            ✕
                          </button>
                        </div>
                      ) : (
                        <QualityScore score={item.qualityScore} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[100px]">
                      {item.author ?? item.ownerAgentId?.slice(0, 8) ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 flex-wrap">
                        {status !== 'quarantined' ? (
                          <button
                            disabled={isActing}
                            onClick={() => patchContent(item.id, item.contentType, 'quarantine')}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors disabled:opacity-50"
                          >
                            <Trash2 size={11} /> Quarantine
                          </button>
                        ) : (
                          <button
                            disabled={isActing}
                            onClick={() => patchContent(item.id, item.contentType, 'restore')}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50"
                          >
                            <RotateCcw size={11} /> Restore
                          </button>
                        )}
                        <button
                          onClick={() => setScoreEdit({ id: item.id, value: String(item.qualityScore) })}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-500/20 border border-zinc-500/20 transition-colors"
                        >
                          <SlidersHorizontal size={11} /> Score
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination meta={meta} onPage={(p) => fetchContent(p)} />
    </div>
  );
}

// ============================================================================
// Page root
// ============================================================================

export default function ModerationPage() {
  const [tab, setTab] = useState<Tab>('reports');

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl backdrop-blur-xl bg-white/60 dark:bg-zinc-800/60 border border-white/20 dark:border-white/10 shadow">
          <AlertTriangle size={20} className="text-amber-500" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-white">Content Moderation</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Manage reports, users, and content quality</p>
        </div>
      </div>

      {/* Tab bar */}
      <TabBar active={tab} onChange={setTab} />

      {/* Panel */}
      <div className="backdrop-blur-xl bg-white/80 dark:bg-zinc-900/80 rounded-2xl border border-white/20 dark:border-white/10 shadow-xl p-6">
        {tab === 'reports' && <ReportsTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'content' && <ContentTab />}
      </div>
    </div>
  );
}
