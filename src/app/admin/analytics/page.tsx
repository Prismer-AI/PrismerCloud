'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  RefreshCw, TrendingUp, Users, MessageSquare, CreditCard, Zap,
  Database, Bot, Activity, Shield, Brain, Clock, Wifi, Server,
  Package, Download, AlertTriangle, CheckCircle, RotateCw,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface AnalyticsData {
  overview: {
    totalUsers: number;
    activeUsers30d: number;
    totalApiKeys: number;
    activeApiKeys: number;
    totalBalance: number;
    creditsUsed30d: number;
    revenue30d: number;
  };
  usage: {
    chart: Array<{ date: string; requests: number; credits: number; activeUsers: number }>;
    byType: Array<{ type: string; count: number; credits: number; avgTime: number }>;
    cacheHitRate: number;
    avgProcessingTime: number;
    errorRate: number;
  };
  im: {
    chart: Array<{ date: string; messages: number }>;
    totalUsers: number;
    totalAgents: number;
    totalMessages: number;
    activeConversations: number;
    topAgents: Array<{ userId: string; username: string; displayName: string; messageCount: number }>;
  };
  revenue: {
    chart: Array<{ date: string; revenue: number; creditsSold: number }>;
    totalRevenue: number;
    totalPayments: number;
    avgPayment: number;
    totalCreditsSold: number;
    planDistribution: Array<{ plan: string; count: number }>;
  };
  topUsers: Array<{ userId: number; requests: number; creditsUsed: number; lastActive: string }>;
  // Layer 1: Observability
  latency?: {
    p50: number;
    p95: number;
    p99: number;
    byEndpoint: Array<{ endpoint: string; p50: number; p95: number; count: number }>;
  };
  imDetail?: {
    messagesByType: Array<{ type: string; count: number }>;
    agentOnlineRate: number;
    onlineAgents: number;
    totalAgentsWithCard: number;
  };
  creditsByType?: Array<{ date: string; context: number; parse: number; im: number; other: number }>;
  // Layer 2: Feature usage + runtime metrics
  features?: {
    tasks: { total: number; completed: number; failed: number; pending: number };
    memoryFiles: number;
    memoryAgents: number;
    evolutionCapsules: { total: number; success: number; failed: number };
    evolutionAgents: number;
    signingKeys: number;
    signedMessages: number;
  };
  realtime?: {
    endpoints: Array<{ endpoint: string; count: number; errorCount: number; errorRate: number; p50: number; p95: number; p99: number }>;
    externalApis: Array<{ service: string; requestCount: number; avgLatency: number; p95Latency: number; errorRate: number }>;
    connections: { ws: number; sse: number };
  };
}

type Period = '7d' | '30d' | '90d';

// ============================================================================
// Chart colors
// ============================================================================

const COLORS = ['#724CFF', '#34D399', '#FBBF24', '#F87171', '#60A5FA', '#A78BFA', '#F472B6', '#38BDF8'];

// ============================================================================
// Components
// ============================================================================

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon?: any }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
        {Icon && <Icon className="w-4 h-4 text-zinc-400" />}
      </div>
      <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-400 mt-1">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{children}</h2>;
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatUSD(n: number): string {
  return '$' + n.toFixed(2);
}

function formatPct(n: number): string {
  return n.toFixed(1) + '%';
}

function formatMs(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 's';
  return Math.round(n) + 'ms';
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const tooltipStyle = { backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px', fontSize: 12 };

// ============================================================================
// Main Page
// ============================================================================

function getAuthToken(): string | null {
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (!stored) return null;
    const auth = JSON.parse(stored);
    if (auth.token && auth.expiresAt > Date.now()) return auth.token;
  } catch { /* ignore */ }
  return null;
}

export default function AdminAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [period, setPeriod] = useState<Period>('30d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const token = getAuthToken();
    if (!token) {
      window.location.href = '/auth';
      return;
    }

    try {
      const res = await fetch(`/api/admin/analytics?period=${period}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        window.location.href = '/auth';
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to load');
      setData(json.data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (forbidden) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-200">Access Denied</h1>
          <p className="text-zinc-500 mt-2">Admin access only.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Prismer Analytics</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Platform-wide business & observability metrics</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Period selector */}
            <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
              {(['7d', '30d', '90d'] as Period[]).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    period === p
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                      : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <button
              onClick={fetchData}
              disabled={loading}
              className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="w-6 h-6 animate-spin text-zinc-400" />
            <span className="ml-2 text-zinc-500">Loading analytics...</span>
          </div>
        ) : data && (
          <>
            {/* ============================================================ */}
            {/* Section 1: Overview Cards */}
            {/* ============================================================ */}
            <div>
              <SectionTitle>Platform Overview</SectionTitle>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
                <StatCard label="Total Users" value={formatNum(data.overview.totalUsers)} icon={Users} />
                <StatCard label="Active (30d)" value={formatNum(data.overview.activeUsers30d)} icon={Activity} />
                <StatCard label="API Keys" value={`${data.overview.activeApiKeys} / ${data.overview.totalApiKeys}`} sub="active / total" icon={Zap} />
                <StatCard label="Credit Balance" value={formatNum(data.overview.totalBalance)} sub="platform total" icon={Database} />
                <StatCard label="Credits Used (30d)" value={formatNum(data.overview.creditsUsed30d)} icon={TrendingUp} />
                <StatCard label="Revenue (30d)" value={formatUSD(data.overview.revenue30d)} icon={CreditCard} />
                <StatCard label="IM Agents" value={formatNum(data.im.totalAgents)} sub={`${data.im.totalUsers} total IM users`} icon={Bot} />
              </div>
            </div>

            {/* ============================================================ */}
            {/* Section 2: API Usage + Latency (Layer 1) */}
            {/* ============================================================ */}
            <div>
              <SectionTitle>API Usage & Latency</SectionTitle>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-4 mb-4">
                <StatCard label="Cache Hit Rate" value={formatPct(data.usage.cacheHitRate)} icon={Database} />
                <StatCard label="Avg Processing" value={formatMs(data.usage.avgProcessingTime)} icon={Activity} />
                <StatCard label="Error Rate" value={formatPct(data.usage.errorRate)} icon={Zap} />
                {data.latency && (
                  <>
                    <StatCard label="Latency p50" value={formatMs(data.latency.p50)} icon={Clock} />
                    <StatCard label="Latency p95" value={formatMs(data.latency.p95)} icon={Clock} />
                    <StatCard label="Latency p99" value={formatMs(data.latency.p99)} icon={Clock} />
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Line chart: daily requests + credits */}
                <ChartCard title="Daily Requests & Credits">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.usage.chart}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                        <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Line yAxisId="left" type="monotone" dataKey="requests" stroke="#724CFF" strokeWidth={2} dot={false} name="Requests" />
                        <Line yAxisId="right" type="monotone" dataKey="credits" stroke="#34D399" strokeWidth={2} dot={false} name="Credits" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>

                {/* Latency by endpoint table */}
                {data.latency && data.latency.byEndpoint.length > 0 && (
                  <ChartCard title="Latency by Endpoint">
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {data.latency.byEndpoint.map(ep => (
                        <div key={ep.endpoint} className="flex items-center justify-between py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                          <div>
                            <div className="text-sm font-mono">{ep.endpoint}</div>
                            <div className="text-xs text-zinc-500">{formatNum(ep.count)} requests</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-mono">p50: {formatMs(ep.p50)}</div>
                            <div className="text-xs text-zinc-500">p95: {formatMs(ep.p95)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ChartCard>
                )}

                {/* Pie chart: request type distribution */}
                <ChartCard title="Request Type Distribution">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.usage.byType}
                          dataKey="count"
                          nameKey="type"
                          cx="50%"
                          cy="50%"
                          outerRadius={80}
                          label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                          labelLine={false}
                          fontSize={11}
                        >
                          {data.usage.byType.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle}
                          formatter={(value: any, name: any) => [`${formatNum(Number(value))} requests`, name]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>
              </div>
            </div>

            {/* ============================================================ */}
            {/* Section 3: Credits by Type (Layer 1) */}
            {/* ============================================================ */}
            {data.creditsByType && data.creditsByType.length > 0 && (
              <div>
                <SectionTitle>Credit Consumption by Type</SectionTitle>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <ChartCard title="Daily Credit Usage (Stacked)">
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data.creditsByType}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }} />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          <Area type="monotone" dataKey="context" stackId="1" stroke="#724CFF" fill="#724CFF" fillOpacity={0.6} name="Context" />
                          <Area type="monotone" dataKey="parse" stackId="1" stroke="#34D399" fill="#34D399" fillOpacity={0.6} name="Parse" />
                          <Area type="monotone" dataKey="im" stackId="1" stroke="#FBBF24" fill="#FBBF24" fillOpacity={0.6} name="IM" />
                          <Area type="monotone" dataKey="other" stackId="1" stroke="#60A5FA" fill="#60A5FA" fillOpacity={0.6} name="Other" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </ChartCard>
                  <ChartCard title="Daily Active Users">
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data.usage.chart}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }} />
                          <Line type="monotone" dataKey="activeUsers" stroke="#60A5FA" strokeWidth={2} dot={false} name="Active Users" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </ChartCard>
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* Section 4: IM & Agents (with Layer 1 detail) */}
            {/* ============================================================ */}
            <div>
              <SectionTitle>IM & Agents</SectionTitle>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-4">
                <StatCard label="IM Users" value={formatNum(data.im.totalUsers)} icon={Users} />
                <StatCard label="Agents" value={formatNum(data.im.totalAgents)} icon={Bot} />
                <StatCard label="Total Messages" value={formatNum(data.im.totalMessages)} icon={MessageSquare} />
                <StatCard label="Active Conversations" value={formatNum(data.im.activeConversations)} sub={`in last ${period}`} icon={Activity} />
                {data.imDetail && (
                  <>
                    <StatCard
                      label="Agents Online"
                      value={`${data.imDetail.onlineAgents} / ${data.imDetail.totalAgentsWithCard}`}
                      sub={`${formatPct(data.imDetail.agentOnlineRate * 100)} online rate`}
                      icon={Wifi}
                    />
                    <StatCard
                      label="Connections"
                      value={data.realtime ? `${data.realtime.connections.ws} WS` : 'N/A'}
                      sub={data.realtime ? `${data.realtime.connections.sse} SSE` : ''}
                      icon={Server}
                    />
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Message volume chart */}
                <ChartCard title="Daily Message Volume">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.im.chart}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }} />
                        <Bar dataKey="messages" fill="#724CFF" radius={[4, 4, 0, 0]} name="Messages" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>

                {/* Message type distribution (Layer 1) */}
                {data.imDetail && data.imDetail.messagesByType.length > 0 && (
                  <ChartCard title="Message Type Distribution">
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={data.imDetail.messagesByType}
                            dataKey="count"
                            nameKey="type"
                            cx="50%"
                            cy="50%"
                            outerRadius={80}
                            label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                            labelLine={false}
                            fontSize={11}
                          >
                            {data.imDetail.messagesByType.map((_, i) => (
                              <Cell key={i} fill={COLORS[i % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={tooltipStyle} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </ChartCard>
                )}

                {/* Top Agents table */}
                <ChartCard title="Top Agents (by messages)">
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {data.im.topAgents.length === 0 ? (
                      <p className="text-sm text-zinc-500 text-center py-8">No agent data</p>
                    ) : (
                      data.im.topAgents.map((agent, i) => (
                        <div key={agent.userId} className="flex items-center justify-between py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-zinc-400 w-5">#{i + 1}</span>
                            <div>
                              <div className="text-sm font-medium">{agent.displayName || agent.username}</div>
                              <div className="text-xs text-zinc-500">@{agent.username}</div>
                            </div>
                          </div>
                          <span className="text-sm font-mono">{formatNum(agent.messageCount)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </ChartCard>
              </div>
            </div>

            {/* ============================================================ */}
            {/* Section 5: Agent Intelligence v1.7.2 (Layer 2) */}
            {/* ============================================================ */}
            {data.features && (
              <div>
                <SectionTitle>Agent Intelligence (v1.7.2)</SectionTitle>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
                  <StatCard
                    label="Tasks"
                    value={formatNum(data.features.tasks.total)}
                    sub={`${data.features.tasks.completed} done, ${data.features.tasks.pending} active`}
                    icon={Activity}
                  />
                  <StatCard
                    label="Task Success"
                    value={data.features.tasks.total > 0
                      ? formatPct(data.features.tasks.completed / data.features.tasks.total * 100)
                      : 'N/A'}
                    sub={`${data.features.tasks.failed} failed`}
                    icon={TrendingUp}
                  />
                  <StatCard
                    label="Memory Files"
                    value={formatNum(data.features.memoryFiles)}
                    sub={`${data.features.memoryAgents} agents`}
                    icon={Database}
                  />
                  <StatCard
                    label="Evolution"
                    value={formatNum(data.features.evolutionCapsules.total)}
                    sub={`${data.features.evolutionAgents} agents evolving`}
                    icon={Brain}
                  />
                  <StatCard
                    label="Evo Success"
                    value={data.features.evolutionCapsules.total > 0
                      ? formatPct(data.features.evolutionCapsules.success / data.features.evolutionCapsules.total * 100)
                      : 'N/A'}
                    sub={`${data.features.evolutionCapsules.failed} failed`}
                    icon={TrendingUp}
                  />
                  <StatCard
                    label="Signing Keys"
                    value={formatNum(data.features.signingKeys)}
                    sub="registered"
                    icon={Shield}
                  />
                  <StatCard
                    label="Signed Messages"
                    value={formatNum(data.features.signedMessages)}
                    sub="with Ed25519"
                    icon={Shield}
                  />
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* Section 5.5: Evolution A/B Experiment */}
            {/* ============================================================ */}
            {(() => {
              const evo = (data as unknown as Record<string, unknown>).evolutionExperiment as {
                standard?: { ssr?: number; rp?: number; gd?: number; er?: number; totalCapsules?: number };
                hypergraph?: { ssr?: number; rp?: number; gd?: number; er?: number; totalCapsules?: number };
                verdict?: string;
              } | null | undefined;
              if (!evo) return null;
              const verdictColors: Record<string, string> = {
                hypergraph_better: 'bg-emerald-500/20 text-emerald-400',
                standard_better: 'bg-amber-500/20 text-amber-400',
                no_significant_difference: 'bg-zinc-500/20 text-zinc-400',
                insufficient_data: 'bg-zinc-700/20 text-zinc-500',
              };
              const verdictLabels: Record<string, string> = {
                hypergraph_better: 'Hypergraph Better',
                standard_better: 'Standard Better',
                no_significant_difference: 'No Significant Difference',
                insufficient_data: 'Insufficient Data',
              };
              const v = evo.verdict || 'insufficient_data';
              return (
                <div>
                  <SectionTitle>Evolution Experiment (Standard vs Hypergraph)</SectionTitle>
                  <div className="space-y-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${verdictColors[v] || verdictColors.insufficient_data}`}>
                      {verdictLabels[v] || v}
                    </span>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {['standard', 'hypergraph'].map(mode => {
                        const m = (evo as Record<string, unknown>)[mode] as { ssr?: number; rp?: number; gd?: number; er?: number; totalCapsules?: number } | undefined;
                        return (
                          <div key={mode} className="p-3 rounded-lg bg-zinc-100 dark:bg-zinc-800/50">
                            <div className="text-xs font-medium mb-2 text-zinc-600 dark:text-zinc-300 capitalize">{mode} Mode</div>
                            {m && m.totalCapsules ? (
                              <div className="grid grid-cols-2 gap-2">
                                <StatCard label="SSR" value={m.ssr != null ? formatPct(m.ssr * 100) : 'N/A'} />
                                <StatCard label="Routing Precision" value={m.rp != null ? formatPct(m.rp * 100) : 'N/A'} />
                                <StatCard label="Gene Diversity" value={m.gd != null ? m.gd.toFixed(3) : 'N/A'} />
                                <StatCard label="Capsules" value={String(m.totalCapsules)} />
                              </div>
                            ) : (
                              <div className="text-xs text-zinc-400 dark:text-zinc-500">No data yet</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ============================================================ */}
            {/* Section 6: External APIs & Runtime (Layer 2) */}
            {/* ============================================================ */}
            {data.realtime && data.realtime.externalApis.length > 0 && (
              <div>
                <SectionTitle>External API Performance (5-min window)</SectionTitle>
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-sm text-zinc-500 dark:text-zinc-400">
                        <th className="px-5 py-3 font-medium">Service</th>
                        <th className="px-5 py-3 font-medium text-right">Requests</th>
                        <th className="px-5 py-3 font-medium text-right">Avg Latency</th>
                        <th className="px-5 py-3 font-medium text-right">p95 Latency</th>
                        <th className="px-5 py-3 font-medium text-right">Error Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.realtime.externalApis.map(api => (
                        <tr key={api.service} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                          <td className="px-5 py-3 text-sm font-medium">{api.service}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatNum(api.requestCount)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatMs(api.avgLatency)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatMs(api.p95Latency)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatPct(api.errorRate * 100)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* Section 7: Endpoint Performance (Layer 2 runtime) */}
            {/* ============================================================ */}
            {data.realtime && data.realtime.endpoints.length > 0 && (
              <div>
                <SectionTitle>Endpoint Performance (5-min window)</SectionTitle>
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-sm text-zinc-500 dark:text-zinc-400">
                        <th className="px-5 py-3 font-medium">Endpoint</th>
                        <th className="px-5 py-3 font-medium text-right">Requests</th>
                        <th className="px-5 py-3 font-medium text-right">p50</th>
                        <th className="px-5 py-3 font-medium text-right">p95</th>
                        <th className="px-5 py-3 font-medium text-right">Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.realtime.endpoints.map(ep => (
                        <tr key={ep.endpoint} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                          <td className="px-5 py-3 text-sm font-mono">{ep.endpoint}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatNum(ep.count)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatMs(ep.p50)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{formatMs(ep.p95)}</td>
                          <td className="px-5 py-3 text-sm text-right font-mono">{ep.errorCount} ({formatPct(ep.errorRate * 100)})</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ============================================================ */}
            {/* Section 8: Revenue & Credits */}
            {/* ============================================================ */}
            <div>
              <SectionTitle>Revenue & Credits</SectionTitle>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <StatCard label="Revenue" value={formatUSD(data.revenue.totalRevenue)} sub={`in last ${period}`} icon={CreditCard} />
                <StatCard label="Payments" value={formatNum(data.revenue.totalPayments)} icon={TrendingUp} />
                <StatCard label="Avg Payment" value={formatUSD(data.revenue.avgPayment)} icon={CreditCard} />
                <StatCard label="Credits Sold" value={formatNum(data.revenue.totalCreditsSold)} icon={Zap} />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Revenue chart */}
                <ChartCard title="Daily Revenue">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.revenue.chart}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={v => '$' + v} />
                        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }}
                          formatter={(value: any, name: any) => [name === 'revenue' ? formatUSD(Number(value)) : formatNum(Number(value)), name]}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="revenue" fill="#34D399" radius={[4, 4, 0, 0]} name="Revenue (USD)" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>

                {/* Credits sold chart */}
                <ChartCard title="Daily Credits Sold">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.revenue.chart}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.2} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => d.slice(5)} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#a1a1aa' }} />
                        <Line type="monotone" dataKey="creditsSold" stroke="#FBBF24" strokeWidth={2} dot={false} name="Credits Sold" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>

                {/* Plan distribution */}
                <ChartCard title="User Plan Distribution">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.revenue.planDistribution}
                          dataKey="count"
                          nameKey="plan"
                          cx="50%"
                          cy="50%"
                          outerRadius={80}
                          label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                          labelLine={false}
                          fontSize={11}
                        >
                          {data.revenue.planDistribution.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>
              </div>
            </div>

            {/* ============================================================ */}
            {/* Section 9: Top Users */}
            {/* ============================================================ */}
            <div>
              <SectionTitle>Top Users</SectionTitle>
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-sm text-zinc-500 dark:text-zinc-400">
                      <th className="px-5 py-3 font-medium">#</th>
                      <th className="px-5 py-3 font-medium">User ID</th>
                      <th className="px-5 py-3 font-medium text-right">Requests</th>
                      <th className="px-5 py-3 font-medium text-right">Credits Used</th>
                      <th className="px-5 py-3 font-medium text-right">Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topUsers.map((user, i) => (
                      <tr key={user.userId} className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="px-5 py-3 text-sm text-zinc-400">{i + 1}</td>
                        <td className="px-5 py-3 text-sm font-mono">{user.userId}</td>
                        <td className="px-5 py-3 text-sm text-right font-mono">{formatNum(user.requests)}</td>
                        <td className="px-5 py-3 text-sm text-right font-mono">{user.creditsUsed.toFixed(2)}</td>
                        <td className="px-5 py-3 text-sm text-right text-zinc-500">{timeAgo(user.lastActive)}</td>
                      </tr>
                    ))}
                    {data.topUsers.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-5 py-8 text-center text-sm text-zinc-500">No usage data</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
