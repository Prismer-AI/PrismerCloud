'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, GitFork, Loader2, PackageOpen, Search, X } from 'lucide-react';

import { imFetch } from '../../../lib/im-api';
import { fuzzyFilter } from '../../../lib/templates/fuzzy';

interface AgentPackRow {
  id: string;
  slug: string;
  version: string;
  publisherDid?: string;
  metadata?: Record<string, unknown> | null;
  license?: string;
  curatedQuality?: string;
  createdAt?: string;
}

interface AgentPackListResponse {
  items?: AgentPackRow[];
  nextCursor?: string;
}

export interface AgentPackForkResult {
  newImUserId: string;
  agentSpec?: { workspaceId?: string };
  package?: AgentPackRow;
  [key: string]: unknown;
}

export interface AgentPackCatalogProps {
  isDark: boolean;
  targetWorkspaceId: string;
  onForked: (result: AgentPackForkResult) => void;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function titleFor(pack: AgentPackRow): string {
  return readString(pack.metadata?.title) || pack.slug.replace(/[-_]+/g, ' ');
}

function descriptionFor(pack: AgentPackRow): string {
  return readString(pack.metadata?.description) || `${pack.slug}@${pack.version}`;
}

export function AgentPackCatalog({ isDark, targetWorkspaceId, onForked }: AgentPackCatalogProps) {
  const [items, setItems] = useState<AgentPackRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentPackRow | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const res = await imFetch<AgentPackListResponse>('/agent-packs?limit=100', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setError(res.message || 'Agent Pack 加载失败');
        setItems([]);
      } else {
        setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      }
      setLoading(false);
    })();
    return () => controller.abort();
  }, []);

  const fuzzyInputs = useMemo(
    () =>
      items.map((item) => ({
        slug: item.slug,
        raw: item,
        searchText: [
          item.slug,
          item.version,
          titleFor(item),
          descriptionFor(item),
          item.publisherDid,
          item.license,
          item.curatedQuality,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      })),
    [items],
  );
  const visible = useMemo(() => fuzzyFilter(query, fuzzyInputs).map((item) => item.raw), [fuzzyInputs, query]);

  function openFork(pack: AgentPackRow) {
    setSelected(pack);
    setDisplayName(titleFor(pack));
    setForkError(null);
  }

  async function forkSelected() {
    if (!selected || forking) return;
    setForking(true);
    setForkError(null);
    const res = await imFetch<AgentPackForkResult>(`/agent-packs/${encodeURIComponent(selected.id)}/fork`, {
      method: 'POST',
      body: JSON.stringify({
        targetWorkspaceId,
        displayName: displayName.trim() || titleFor(selected),
      }),
    });
    setForking(false);
    if (!res.ok) {
      setForkError(res.message || 'Fork failed');
      return;
    }
    onForked(res.data);
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="agent-pack-catalog">
      <label className="relative">
        <Search
          aria-hidden
          className={cx(
            'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2',
            isDark ? 'text-zinc-500' : 'text-zinc-400',
          )}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? '加载 Agent Pack…' : `搜索 ${items.length} 个 Agent Pack`}
          aria-label="搜索 Agent Pack"
          data-testid="agent-pack-catalog-search"
          className={cx(
            'w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-violet-400/60',
            isDark
              ? 'border-white/[0.08] text-zinc-100 placeholder:text-zinc-500'
              : 'border-zinc-200 text-zinc-800 placeholder:text-zinc-400',
          )}
        />
        {loading ? (
          <Loader2
            aria-hidden
            className={cx(
              'absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin',
              isDark ? 'text-zinc-500' : 'text-zinc-400',
            )}
          />
        ) : null}
      </label>

      {error ? (
        <div className={cx('flex items-center gap-1.5 text-[11px]', isDark ? 'text-amber-300' : 'text-amber-600')}>
          <AlertCircle aria-hidden className="h-3.5 w-3.5" />
          <span>{error}</span>
        </div>
      ) : null}

      <div
        className={cx(
          'min-h-0 flex-1 overflow-y-auto rounded-lg border',
          isDark ? 'border-white/[0.06] bg-black/10' : 'border-zinc-200 bg-zinc-50/70',
        )}
        role="region"
        aria-label="Agent Pack"
      >
        {visible.length === 0 ? (
          <div className={cx('flex items-center justify-center px-3 py-12 text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
            {loading ? '正在加载 Agent Pack…' : query ? `没有匹配 "${query}" 的 Agent Pack` : '没有可用 Agent Pack'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
            {visible.map((pack) => (
              <button
                key={pack.id}
                type="button"
                onClick={() => openFork(pack)}
                data-testid={`agent-pack-card-${pack.slug}`}
                className={cx(
                  'group flex h-[118px] items-start gap-3 overflow-hidden rounded-lg border p-3 text-left transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
                  isDark
                    ? 'border-white/[0.06] bg-black/20 hover:border-emerald-400/30 hover:bg-white/[0.04]'
                    : 'border-zinc-200 bg-white hover:border-emerald-300 hover:bg-white',
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                    isDark ? 'bg-emerald-400/15 text-emerald-200' : 'bg-emerald-100 text-emerald-700',
                  )}
                >
                  <PackageOpen className="h-5 w-5" strokeWidth={1.7} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cx('truncate text-sm font-medium', isDark ? 'text-zinc-100' : 'text-zinc-900')}>
                    {titleFor(pack)}
                  </span>
                  <span className={cx('line-clamp-2 text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                    {descriptionFor(pack)}
                  </span>
                  <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[10px]">
                    <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>{pack.version}</span>
                    {pack.license ? <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>· {pack.license}</span> : null}
                    {pack.curatedQuality ? (
                      <span className={isDark ? 'text-zinc-600' : 'text-zinc-400'}>· {pack.curatedQuality}</span>
                    ) : null}
                  </span>
                </span>
                <GitFork
                  aria-hidden
                  className={cx('h-4 w-4 shrink-0 opacity-60 group-hover:opacity-100', isDark ? 'text-emerald-200' : 'text-emerald-700')}
                  strokeWidth={1.8}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Fork Agent Pack"
          className={cx(
            'rounded-lg border p-3',
            isDark ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-emerald-200 bg-emerald-50',
          )}
          data-testid="agent-pack-fork-panel"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={cx('truncate text-sm font-medium', isDark ? 'text-emerald-100' : 'text-emerald-900')}>
                {titleFor(selected)}
              </p>
              <p className={cx('mt-0.5 line-clamp-1 text-xs', isDark ? 'text-emerald-200/70' : 'text-emerald-800/70')}>
                {selected.slug}@{selected.version}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="关闭"
              className={cx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                isDark ? 'text-emerald-100/70 hover:bg-white/10' : 'text-emerald-800/70 hover:bg-emerald-100',
              )}
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-label="Fork 后的 agent 名称"
              data-testid="agent-pack-fork-name"
              className={cx(
                'min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-400/60',
                isDark ? 'border-emerald-300/20 text-zinc-100' : 'border-emerald-200 text-zinc-900',
              )}
            />
            <button
              type="button"
              onClick={forkSelected}
              disabled={forking}
              data-testid="agent-pack-fork-submit"
              className={cx(
                'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium',
                forking ? 'opacity-60' : '',
                isDark ? 'bg-emerald-400 text-emerald-950 hover:bg-emerald-300' : 'bg-emerald-600 text-white hover:bg-emerald-700',
              )}
            >
              {forking ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <GitFork aria-hidden className="h-4 w-4" />}
              Fork
            </button>
          </div>
          {forkError ? (
            <p className={cx('mt-2 text-[11px]', isDark ? 'text-amber-200' : 'text-amber-700')}>{forkError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
