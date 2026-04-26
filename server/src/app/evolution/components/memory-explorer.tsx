'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Brain, Search, Link2, FileText, AlertTriangle, Loader2,
  ChevronRight, Pencil, Trash2, Copy, Tag, RefreshCw, X, Moon,
} from 'lucide-react';
import { glass, timeAgo } from './helpers';

interface MemoryExplorerProps {
  isDark: boolean;
}

interface MemoryFile {
  id: string;
  path: string;
  content?: string;
  memoryType?: string;
  description?: string;
  version?: number;
  stale?: boolean;
  size?: number;
  createdAt?: string;
  updatedAt?: string;
  linkedGenes?: LinkedGene[];
}

interface MemoryStats {
  totalFiles: number;
  staleFiles: number;
  linkedCount: number;
  totalBytes: number;
  lastDreamAt?: string;
  dreamStatus?: string;
  dreamCooldownRemaining?: number;
}

interface RecallResult {
  id: string;
  path: string;
  snippet?: string;
  score: number;
  memoryType?: string;
  updatedAt?: string;
}

interface MemoryLinkGroup {
  memoryId: string;
  memoryPath: string;
  genes: Array<{
    geneId: string;
    title: string;
    linkType: string;
    strength: number;
    successRate: number;
  }>;
}

interface LinkedGene {
  geneId: string;
  title?: string;
  linkType?: string;
  strength?: number;
}

const TYPE_COLORS: Record<string, string> = {
  feedback: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  project: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  reference: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  user: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
};
const TYPE_COLORS_LIGHT: Record<string, string> = {
  feedback: 'bg-amber-100 text-amber-700 border-amber-200',
  project: 'bg-blue-100 text-blue-700 border-blue-200',
  reference: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  user: 'bg-violet-100 text-violet-700 border-violet-200',
};

const MEMORY_TYPES = [
  { key: '', label: 'All' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'project', label: 'Project' },
  { key: 'reference', label: 'Reference' },
  { key: 'user', label: 'User' },
];

const TABS = [
  { key: 'all', label: 'All', icon: FileText },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'links', label: 'Links', icon: Link2 },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function getToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token ?? null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function strengthDots(s: number): string {
  const filled = Math.round(s * 4);
  return '●'.repeat(filled) + '○'.repeat(4 - filled);
}

function typeBadge(type: string | undefined, isDark: boolean) {
  const t = (type || 'untyped').toLowerCase();
  const colors = isDark ? TYPE_COLORS[t] : TYPE_COLORS_LIGHT[t];
  const cls = colors || (isDark ? 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40' : 'bg-zinc-100 text-zinc-500 border-zinc-200');
  return <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${cls}`}>{t}</span>;
}

function TimeAgo({ ts, className }: { ts: string; className?: string }) {
  const [text, setText] = useState('');
  useEffect(() => { setText(timeAgo(ts)); }, [ts]);
  return <span className={className} suppressHydrationWarning>{text}</span>;
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function MemoryExplorer({ isDark }: MemoryExplorerProps) {
  const [tab, setTab] = useState<TabKey>('search');
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selected, setSelected] = useState<MemoryFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editType, setEditType] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dreamLoading, setDreamLoading] = useState(false);
  const [dreamMsg, setDreamMsg] = useState('');

  // Search state
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecallResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Links state
  const [linkGroups, setLinkGroups] = useState<MemoryLinkGroup[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch('/api/im/memory/stats', { headers: authHeaders() });
      if (r.ok) { const d = await r.json(); setStats(d.data || d); }
    } catch {}
  }, []);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort: 'updatedAt', order: 'desc' });
      if (typeFilter) params.set('memoryType', typeFilter);
      if (staleOnly) params.set('stale', 'true');
      const r = await fetch(`/api/im/memory/files?${params}`, { headers: authHeaders() });
      if (r.ok) { const d = await r.json(); setFiles(d.data || []); }
    } catch {}
    setLoading(false);
  }, [typeFilter, staleOnly]);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/im/memory/files/${id}`, { headers: authHeaders() });
      if (r.ok) { const d = await r.json(); setSelected(d.data || d); }
    } catch {}
  }, []);

  const fetchLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const r = await fetch('/api/im/memory/links', { headers: authHeaders() });
      if (r.ok) {
        const d = await r.json();
        setLinkGroups(d.data?.links || []);
      }
    } catch {}
    setLinksLoading(false);
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { if (tab === 'all') fetchFiles(); }, [tab, fetchFiles]);
  useEffect(() => { if (tab === 'links') fetchLinks(); }, [tab, fetchLinks]);

  // Debounced search
  useEffect(() => {
    if (tab !== 'search' || !query.trim()) { setSearchResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/im/recall?q=${encodeURIComponent(query)}&scope=memory&limit=10`, { headers: authHeaders() });
        if (r.ok) { const d = await r.json(); setSearchResults(d.data || []); }
      } catch {}
      setSearching(false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, tab]);

  const handleDream = async () => {
    setDreamLoading(true);
    setDreamMsg('');
    try {
      const r = await fetch('/api/im/memory/consolidate', { method: 'POST', headers: authHeaders() });
      if (r.ok) {
        const d = await r.json();
        const data = d.data || {};
        if (data.triggered) {
          setDreamMsg(`Merged ${data.merged ?? 0}, staled ${data.staleMarked ?? 0}`);
        } else {
          setDreamMsg(data.reason || 'Cooldown active');
        }
      }
      await fetchStats();
    } catch {}
    setDreamLoading(false);
    setTimeout(() => setDreamMsg(''), 6000);
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/im/memory/files/${id}`, { method: 'DELETE', headers: authHeaders() });
      setSelected(null);
      setDeleting(null);
      fetchFiles();
      fetchStats();
    } catch {}
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await fetch(`/api/im/memory/files/${selected.id}/metadata`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ memoryType: editType || null, description: editDesc }),
      });
      if (editContent !== (selected.content || '')) {
        await fetch(`/api/im/memory/files/${selected.id}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'replace', content: editContent }),
        });
      }
      await fetchDetail(selected.id);
      setEditing(false);
      fetchFiles();
    } catch {}
    setSaving(false);
  };

  const handleToggleStale = async (file: MemoryFile) => {
    try {
      await fetch(`/api/im/memory/files/${file.id}/metadata`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ stale: !file.stale }),
      });
      await fetchDetail(file.id);
      fetchFiles();
      fetchStats();
    } catch {}
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const startEdit = (file: MemoryFile) => {
    setEditContent(file.content || '');
    setEditDesc(file.description || '');
    setEditType(file.memoryType || '');
    setEditing(true);
  };

  const isEmpty = !loading && files.length === 0 && !typeFilter && !staleOnly;
  const txt = isDark ? 'text-zinc-300' : 'text-zinc-600';
  const txtMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';

  return (
    <div className="space-y-4">
      {/* Stats Bar */}
      {stats && (
        <div className={`grid grid-cols-5 gap-2 rounded-xl p-3 ${glass(isDark, 'subtle')}`}>
          <StatCard isDark={isDark} label="Files" value={stats.totalFiles} />
          <StatCard isDark={isDark} label="Stale" value={stats.staleFiles}
            warn={stats.staleFiles > 0} />
          <StatCard isDark={isDark} label="Links" value={stats.linkedCount} />
          <StatCard isDark={isDark} label="Storage" value={formatBytes(stats.totalBytes)} />
          <div className="flex flex-col items-center gap-0.5">
            <span className={`text-[10px] ${txtMuted}`}>Last Dream</span>
            <span className={`text-xs font-medium ${txt}`}>
              {stats.lastDreamAt ? <TimeAgo ts={stats.lastDreamAt} /> : '—'}
            </span>
            {stats.dreamStatus === 'ready' && (
              <button onClick={handleDream} disabled={dreamLoading}
                title="Consolidate: merge related memories, mark stale entries"
                className={`mt-0.5 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition
                  ${isDark ? 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30' : 'bg-violet-100 text-violet-600 hover:bg-violet-200'}`}>
                {dreamLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                Run
              </button>
            )}
            {stats.dreamStatus === 'cooldown' && stats.dreamCooldownRemaining != null && (
              <span className={`text-[9px] ${txtMuted}`}>{stats.dreamCooldownRemaining}h cooldown</span>
            )}
            {dreamMsg && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700'}`}>
                {dreamMsg}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex gap-1">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition
                ${active
                  ? isDark ? 'bg-white/10 text-white' : 'bg-zinc-900 text-white'
                  : isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5' : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
                }`}>
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* All Tab */}
      {tab === 'all' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
              className={`text-xs rounded-lg px-2 py-1.5 border outline-none ${isDark
                ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-white border-zinc-200 text-zinc-700'}`}>
              {MEMORY_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <button onClick={() => setStaleOnly(!staleOnly)}
              className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border transition ${staleOnly
                ? isDark ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-amber-100 border-amber-200 text-amber-700'
                : isDark ? 'border-white/10 text-zinc-400 hover:border-white/20' : 'border-zinc-200 text-zinc-500 hover:border-zinc-300'
              }`}>
              <AlertTriangle size={12} />
              Stale
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={20} className={`animate-spin ${txtMuted}`} /></div>
          ) : isEmpty ? (
            <EmptyState isDark={isDark} />
          ) : (
            <div className="space-y-1">
              {files.map(f => (
                <button key={f.id} onClick={() => { setSelected(f); fetchDetail(f.id); setEditing(false); setDeleting(null); }}
                  className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg transition group
                    ${selected?.id === f.id
                      ? isDark ? 'bg-white/8 border border-white/10' : 'bg-zinc-100 border border-zinc-200'
                      : isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50'}`}>
                  <FileText size={14} className={txtMuted} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {typeBadge(f.memoryType, isDark)}
                      <span className={`text-xs truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{f.path}</span>
                      {f.stale && <AlertTriangle size={11} className="text-amber-400 shrink-0" />}
                    </div>
                    {f.description && (
                      <p className={`text-[11px] truncate mt-0.5 ${txtMuted}`}>{f.description}</p>
                    )}
                  </div>
                  <span className={`text-[10px] ${txtMuted}`}>v{f.version || 1}</span>
                  {f.updatedAt && <TimeAgo ts={f.updatedAt} className={`text-[10px] shrink-0 ${txtMuted}`} />}
                  <ChevronRight size={12} className={`${txtMuted} opacity-0 group-hover:opacity-100 transition`} />
                </button>
              ))}
            </div>
          )}

          {/* Detail Panel */}
          {selected && tab === 'all' && (
            <DetailPanel isDark={isDark} file={selected} editing={editing} deleting={deleting}
              editContent={editContent} editDesc={editDesc} editType={editType} saving={saving}
              onEdit={() => startEdit(selected)} onCancelEdit={() => setEditing(false)}
              onSave={handleSave} onDelete={() => setDeleting(selected.id)}
              onConfirmDelete={() => handleDelete(selected.id)}
              onCancelDelete={() => setDeleting(null)}
              onToggleStale={() => handleToggleStale(selected)}
              onCopy={() => handleCopy(selected.content || '')}
              onClose={() => { setSelected(null); setEditing(false); setDeleting(null); }}
              setEditContent={setEditContent} setEditDesc={setEditDesc} setEditType={setEditType}
              txt={txt} txtMuted={txtMuted} />
          )}
        </div>
      )}

      {/* Search Tab */}
      {tab === 'search' && (
        <div className="space-y-3">
          <div className="relative">
            <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${txtMuted}`} />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search memories..."
              className={`w-full text-xs pl-8 pr-3 py-2 rounded-lg border outline-none ${isDark
                ? 'bg-white/5 border-white/10 text-zinc-200 placeholder:text-zinc-600'
                : 'bg-white border-zinc-200 text-zinc-800 placeholder:text-zinc-400'}`} />
            {query && (
              <button onClick={() => setQuery('')}
                className={`absolute right-2 top-1/2 -translate-y-1/2 ${txtMuted}`}>
                <X size={14} />
              </button>
            )}
          </div>

          {searching && <div className="flex justify-center py-8"><Loader2 size={18} className={`animate-spin ${txtMuted}`} /></div>}
          {!searching && query && searchResults.length === 0 && (
            <p className={`text-xs text-center py-8 ${txtMuted}`}>No results for &ldquo;{query}&rdquo;</p>
          )}

          {searchResults.map(r => (
            <button key={r.id} onClick={() => { fetchDetail(r.id); setEditing(false); setDeleting(null); }}
              className={`w-full text-left p-3 rounded-lg transition ${glass(isDark, 'subtle')} ${isDark ? 'hover:bg-white/[0.04]' : 'hover:bg-zinc-50'}`}>
              <div className="flex items-center gap-2 mb-1">
                {typeBadge(r.memoryType, isDark)}
                <span className={`text-xs font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{r.path}</span>
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-mono ${isDark
                  ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700'}`}>
                  {(r.score * 100).toFixed(0)}%
                </span>
              </div>
              <p className={`text-[11px] line-clamp-2 ${txtMuted}`}>
                {(r.snippet || '').slice(0, 200)}
              </p>
              {r.updatedAt && <TimeAgo ts={r.updatedAt} className={`text-[10px] mt-1 block ${txtMuted}`} />}
            </button>
          ))}

          {selected && tab === 'search' && (
            <DetailPanel isDark={isDark} file={selected} editing={editing} deleting={deleting}
              editContent={editContent} editDesc={editDesc} editType={editType} saving={saving}
              onEdit={() => startEdit(selected)} onCancelEdit={() => setEditing(false)}
              onSave={handleSave} onDelete={() => setDeleting(selected.id)}
              onConfirmDelete={() => handleDelete(selected.id)}
              onCancelDelete={() => setDeleting(null)}
              onToggleStale={() => handleToggleStale(selected)}
              onCopy={() => handleCopy(selected.content || '')}
              onClose={() => { setSelected(null); setEditing(false); setDeleting(null); }}
              setEditContent={setEditContent} setEditDesc={setEditDesc} setEditType={setEditType}
              txt={txt} txtMuted={txtMuted} />
          )}
        </div>
      )}

      {/* Links Tab */}
      {tab === 'links' && (
        <div className="space-y-2">
          {linksLoading && <div className="flex justify-center py-12"><Loader2 size={18} className={`animate-spin ${txtMuted}`} /></div>}
          {!linksLoading && linkGroups.length === 0 && (
            <p className={`text-xs text-center py-12 ${txtMuted}`}>No knowledge links yet. Links form as your Agent uses memories during evolution.</p>
          )}
          {!linksLoading && linkGroups.map(g => (
            <div key={g.memoryId} className={`rounded-lg p-3 ${glass(isDark, 'subtle')}`}>
              <div className="flex items-center gap-2 mb-2">
                <FileText size={13} className={txtMuted} />
                <span className={`text-xs font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  {g.memoryPath}
                </span>
                <span className={`text-[10px] ${txtMuted}`}>{g.genes.length} link{g.genes.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="space-y-1.5 ml-5">
                {g.genes.map((gene, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Tag size={11} className={isDark ? 'text-violet-400' : 'text-violet-500'} />
                    <span className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>{gene.title || gene.geneId}</span>
                    <span className={`text-[10px] px-1 py-0.5 rounded ${isDark ? 'bg-white/5 text-zinc-500' : 'bg-zinc-100 text-zinc-400'}`}>
                      {gene.linkType}
                    </span>
                    <span className={`text-[10px] font-mono tracking-wider ${isDark ? 'text-cyan-400/70' : 'text-cyan-600/70'}`}>
                      {strengthDots(gene.strength)}
                    </span>
                    {gene.successRate != null && (
                      <span className={`text-[10px] ${txtMuted}`}>{(gene.successRate * 100).toFixed(0)}%</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────── */

function StatCard({ isDark, label, value, warn }: { isDark: boolean; label: string; value: string | number; warn?: boolean }) {
  const txtMuted = isDark ? 'text-zinc-500' : 'text-zinc-400';
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-[10px] ${txtMuted}`}>{label}</span>
      <span className={`text-sm font-semibold ${warn
        ? 'text-amber-400' : isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
        {value}
      </span>
    </div>
  );
}

function EmptyState({ isDark }: { isDark: boolean }) {
  return (
    <div className={`text-center py-16 px-6 rounded-xl ${glass(isDark, 'subtle')}`}>
      <Brain size={36} className={`mx-auto mb-4 ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`} />
      <p className={`text-sm font-medium mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
        Your Agent hasn&apos;t stored any memories yet
      </p>
      <p className={`text-xs mb-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        Memories are created automatically when your Agent completes coding sessions.
      </p>
      <div className={`inline-block text-left text-xs space-y-1 ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
        <p>To get started:</p>
        <p>1. Install the Prismer Plugin</p>
        <p>2. Use your Agent in a few sessions</p>
        <p>3. Memories will appear here automatically</p>
      </div>
    </div>
  );
}

interface DetailPanelProps {
  isDark: boolean;
  file: MemoryFile;
  editing: boolean;
  deleting: string | null;
  editContent: string;
  editDesc: string;
  editType: string;
  saving: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onToggleStale: () => void;
  onCopy: () => void;
  onClose: () => void;
  setEditContent: (v: string) => void;
  setEditDesc: (v: string) => void;
  setEditType: (v: string) => void;
  txt: string;
  txtMuted: string;
}

function DetailPanel({
  isDark, file, editing, deleting, editContent, editDesc, editType, saving,
  onEdit, onCancelEdit, onSave, onDelete, onConfirmDelete, onCancelDelete,
  onToggleStale, onCopy, onClose, setEditContent, setEditDesc, setEditType,
  txt, txtMuted,
}: DetailPanelProps) {
  return (
    <div className={`rounded-xl p-4 ${glass(isDark, 'elevated')}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {typeBadge(file.memoryType, isDark)}
          <span className={`text-xs font-medium truncate ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{file.path}</span>
          {file.stale && <AlertTriangle size={12} className="text-amber-400 shrink-0" />}
        </div>
        <button onClick={onClose} className={`${txtMuted} hover:opacity-70`}><X size={14} /></button>
      </div>

      {/* Delete confirmation */}
      {deleting === file.id && (
        <div className={`flex items-center gap-2 mb-3 p-2 rounded-lg text-xs ${isDark
          ? 'bg-red-500/10 border border-red-500/20 text-red-300' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <span>{file.path === 'MEMORY.md' ? 'WARNING: This is the memory index. Deleting it will lose all memory structure. Continue?' : 'Delete this memory?'}</span>
          <button onClick={onCancelDelete}
            className={`px-2 py-0.5 rounded ${isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-white hover:bg-zinc-100'}`}>
            Cancel
          </button>
          <button onClick={onConfirmDelete}
            className={`px-2 py-0.5 rounded ${isDark ? 'bg-red-500/30 hover:bg-red-500/40 text-red-200' : 'bg-red-500 hover:bg-red-600 text-white'}`}>
            Delete
          </button>
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            <select value={editType} onChange={e => setEditType(e.target.value)}
              className={`text-xs rounded px-2 py-1 border outline-none ${isDark
                ? 'bg-white/5 border-white/10 text-zinc-300' : 'bg-white border-zinc-200 text-zinc-700'}`}>
              <option value="">Untyped</option>
              {MEMORY_TYPES.slice(1).map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <input value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description..."
              className={`flex-1 text-xs rounded px-2 py-1 border outline-none ${isDark
                ? 'bg-white/5 border-white/10 text-zinc-300 placeholder:text-zinc-600'
                : 'bg-white border-zinc-200 text-zinc-700 placeholder:text-zinc-400'}`} />
          </div>
          <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
            className={`w-full text-xs rounded-lg p-3 border outline-none font-mono resize-y min-h-[160px] ${isDark
              ? 'bg-white/[0.02] border-white/10 text-zinc-300' : 'bg-zinc-50 border-zinc-200 text-zinc-800'}`} />
          <div className="flex gap-2 justify-end">
            <button onClick={onCancelEdit} className={`text-xs px-3 py-1 rounded-lg ${isDark
              ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100'}`}>Cancel</button>
            <button onClick={onSave} disabled={saving}
              className={`text-xs px-3 py-1 rounded-lg flex items-center gap-1 ${isDark
                ? 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30' : 'bg-violet-500 text-white hover:bg-violet-600'}`}>
              {saving && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          {file.description && (
            <p className={`text-[11px] mb-2 ${txtMuted}`}>{file.description}</p>
          )}
          <pre className={`whitespace-pre-wrap text-xs leading-relaxed max-h-64 overflow-y-auto p-3 rounded-lg mb-3 ${isDark
            ? 'bg-white/[0.02] text-zinc-300' : 'bg-zinc-50 text-zinc-700'}`}>
            {file.content || '(empty)'}
          </pre>

          {/* Linked genes */}
          {file.linkedGenes && file.linkedGenes.length > 0 && (
            <div className="mb-3">
              <p className={`text-[10px] uppercase tracking-wider mb-1.5 ${txtMuted}`}>Linked Genes</p>
              <div className="flex flex-wrap gap-1.5">
                {file.linkedGenes.map((g, i) => (
                  <span key={i} className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${isDark
                    ? 'bg-violet-500/10 text-violet-300 border border-violet-500/20'
                    : 'bg-violet-50 text-violet-600 border border-violet-100'}`}>
                    <Tag size={9} />
                    {g.title || g.geneId}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <ActionBtn isDark={isDark} icon={Pencil} label="Edit" onClick={onEdit} />
            <ActionBtn isDark={isDark} icon={Moon} label={file.stale ? 'Mark Active' : 'Mark Stale'} onClick={onToggleStale} />
            <ActionBtn isDark={isDark} icon={Copy} label="Copy" onClick={onCopy} />
            <ActionBtn isDark={isDark} icon={Trash2} label="Delete" onClick={onDelete} danger />
          </div>
        </>
      )}
    </div>
  );
}

function ActionBtn({ isDark, icon: Icon, label, onClick, danger }: {
  isDark: boolean; icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean;
}) {
  const base = danger
    ? isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'
    : isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100';
  return (
    <button onClick={onClick} className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg transition ${base}`}>
      <Icon size={12} />
      {label}
    </button>
  );
}

