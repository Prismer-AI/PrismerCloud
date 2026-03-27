'use client';

import { useState, useRef, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  Network,
  Eye,
  Code2,
  Zap,
  Server,
  Link as LinkIcon,
  Dna,
  Shield,
  Brain,
  Clock,
  Wrench,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { HeroGlobe } from '@/components/landing/hero-globe';
import { MeshGradient } from '@paper-design/shaders-react';
import { useTheme } from '@/contexts/theme-context';
import { VERSION } from '@/lib/version';
import { CreditPurchaseSlider } from '@/components/credit-purchase-slider';
import { TiltCard } from '@/components/evolution/tilt-card';

// Category icon/color mapping
const CATEGORY_CONFIG: Record<string, { icon: typeof Wrench; color: string; label: string }> = {
  repair: { icon: Wrench, color: 'text-orange-400', label: 'Repair' },
  optimize: { icon: Zap, color: 'text-cyan-400', label: 'Optimize' },
  innovate: { icon: Sparkles, color: 'text-violet-400', label: 'Innovate' },
};

// Evolution Showcase Section (Landing Page Section 2)
function EvolutionShowcase({ isDark }: { isDark: boolean }) {
  const [stats, setStats] = useState({ total_genes: 0, total_capsules: 0, avg_success_rate: 0, active_agents: 0 });
  const [hotGenes, setHotGenes] = useState<
    Array<{
      id: string;
      category: string;
      title?: string;
      description?: string;
      signals_match: Array<string | { type: string; provider?: string }>;
      strategy: Array<string | unknown>;
      success_count: number;
      failure_count: number;
      visibility?: string;
      created_by: string;
    }>
  >([]);

  useEffect(() => {
    fetch('/api/im/evolution/public/stats')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setStats(d.data);
      })
      .catch(() => {});
    fetch('/api/im/evolution/public/hot?limit=6')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setHotGenes(d.data);
      })
      .catch(() => {});
  }, []);

  return (
    <section
      className={`relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 border-t ${isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'}`}
    >
      <h2 className={`text-2xl sm:text-3xl font-bold mb-4 text-center ${isDark ? 'text-white' : 'text-zinc-900'}`}>
        An Evolving{' '}
        <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)]">
          Ecosystem
        </span>
      </h2>
      <p className={`text-center mb-8 md:mb-12 max-w-xl mx-auto ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        Proven strategies, evolved by agents, shared openly.
      </p>

      {/* KPI Bar - Glassmorphism */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8 md:mb-12 stagger-children">
        {[
          { label: 'Active Genes', value: stats.total_genes, icon: Dna },
          { label: 'Total Capsules', value: stats.total_capsules, icon: Zap },
          { label: 'Avg Success', value: `${stats.avg_success_rate}%`, icon: TrendingUp },
          { label: 'Active Agents', value: stats.active_agents, icon: Network },
        ].map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className={`text-center p-4 rounded-xl spring-hover ${
              isDark
                ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
            }`}
          >
            <Icon className={`w-5 h-5 mx-auto mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
            <div className={`text-2xl sm:text-3xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {typeof value === 'number' ? value.toLocaleString() : value}
            </div>
            <div className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</div>
          </div>
        ))}
      </div>

      {/* Hot Genes Grid */}
      {hotGenes.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6 stagger-children">
          {hotGenes.slice(0, 6).map((gene) => {
            const cat = CATEGORY_CONFIG[gene.category] || CATEGORY_CONFIG.repair;
            const CatIcon = cat.icon;
            const total = gene.success_count + gene.failure_count;
            const successRate = total > 0 ? Math.round((gene.success_count / total) * 100) : 0;
            const isSeed = gene.visibility === 'seed' || gene.created_by?.includes('seed');
            const glowColor =
              gene.category === 'repair'
                ? 'rgba(251,146,60,0.15)'
                : gene.category === 'optimize'
                  ? 'rgba(34,211,238,0.15)'
                  : 'rgba(139,92,246,0.15)';

            return (
              <TiltCard key={gene.id} glowColor={glowColor} maxTilt={4} scale={1.01} className="rounded-2xl">
                <div
                  className={`rounded-2xl p-5 h-full ${
                    isDark
                      ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                      : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <CatIcon className={`w-4 h-4 ${cat.color}`} />
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-600'
                        }`}
                      >
                        {cat.label}
                      </span>
                    </div>
                    {isSeed && (
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-100 text-violet-600'
                        }`}
                      >
                        Official Seed
                      </span>
                    )}
                  </div>
                  <h3 className={`font-bold mb-1.5 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                    {gene.title ||
                      (typeof gene.signals_match[0] === 'string'
                        ? gene.signals_match[0]
                        : ((gene.signals_match[0] as Record<string, unknown>)?.type as string)) ||
                      'Untitled Gene'}
                  </h3>
                  <p className={`text-xs mb-3 line-clamp-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                    {gene.description || (typeof gene.strategy[0] === 'string' ? gene.strategy[0] : '') || ''}
                  </p>
                  <div className="flex items-center gap-3">
                    {total > 0 ? (
                      <>
                        <span className={`text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                          {successRate}% success
                        </span>
                        <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                          {total.toLocaleString()} uses
                        </span>
                      </>
                    ) : (
                      <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>Prismer Verified</span>
                    )}
                  </div>
                </div>
              </TiltCard>
            );
          })}
        </div>
      )}

      <div className="text-center mt-8">
        <Link
          href="/evolution"
          className={`inline-flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium transition-all duration-200 ${
            isDark
              ? 'bg-zinc-800 text-white hover:bg-zinc-700 border border-white/10'
              : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 border border-zinc-200'
          }`}
        >
          Explore All Genes <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </section>
  );
}

// Feature cards data with gradient colors from the palette (kept for reference but no longer rendered)
const featureCards = [
  {
    title: 'Global Caching Layer',
    desc: "Once a URL is processed by any agent, it's cached globally on our edge network. Subsequent hits take <20ms. The world's knowledge, indexed once, served instantly.",
    icon: Zap,
    iconColor: 'text-yellow-400',
    gradientFrom: '#41086D',
    gradientTo: '#5622E5',
    span: 'col-span-1 sm:col-span-2',
  },
  {
    title: 'Visual Understanding',
    desc: "We don't just grab text. Our pipelines extract semantics from charts, tables, and diagrams using multimodal models.",
    icon: Eye,
    iconColor: 'text-cyan-400',
    gradientFrom: '#0F3E82',
    gradientTo: '#7285FF',
    span: 'col-span-1',
  },
  {
    title: 'Developer Ready',
    desc: 'Simple API, powerful results. Just one line to fetch high-quality context for your AI agents.',
    icon: Code2,
    iconColor: 'text-emerald-400',
    gradientFrom: '#123391',
    gradientTo: '#6297EB',
    span: 'col-span-1',
    showCode: true,
  },
  {
    title: 'Dedicated GPU Clusters',
    desc: 'We maintain a fleet of H100s and 4090s specifically optimized for OCR and layout analysis tasks, ensuring you never hit a bottleneck.',
    icon: Server,
    iconColor: 'text-violet-400',
    gradientFrom: '#400084',
    gradientTo: '#724CFF',
    span: 'col-span-1 sm:col-span-2',
  },
];

export default function LandingPage() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [inputUrl, setInputUrl] = useState('');
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Dynamic mesh gradient colors based on theme
  const meshColors = isDark
    ? ['#0a0a0a', '#41086D', '#123391', '#1a1a2e']
    : ['#FFFFFF', '#E7D3F9', '#F4FAFE', '#F3E9FF'];

  const handleStartSubmit = (e: FormEvent) => {
    e.preventDefault();
    const urlToUse = inputUrl.trim() || 'https://www.figure.ai/news/helix';
    router.push(`/playground?url=${encodeURIComponent(urlToUse)}`);
  };

  return (
    <div className="w-full flex flex-col items-center relative transition-colors">
      {/* Dynamic Mesh Gradient Background */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <MeshGradient
          className="w-full h-full"
          colors={meshColors}
          speed={0.3}
          style={{ backgroundColor: isDark ? '#0a0a0a' : '#FFFFFF' }}
        />
        {/* Overlay to ensure content readability */}
        <div
          className={`absolute inset-0 ${
            isDark
              ? 'bg-gradient-to-b from-transparent via-zinc-950/50 to-zinc-950'
              : 'bg-gradient-to-b from-transparent via-white/30 to-white/80'
          }`}
        />
      </div>

      {/* Ambient lighting effects */}
      <div className="fixed inset-0 pointer-events-none z-[1]">
        <div
          className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full blur-[120px] animate-pulse"
          style={{
            animationDuration: '8s',
            backgroundColor: isDark ? 'rgba(124, 58, 237, 0.1)' : 'rgba(200, 124, 227, 0.15)',
          }}
        />
        <div
          className="absolute bottom-1/3 right-1/4 w-72 h-72 rounded-full blur-[100px] animate-pulse"
          style={{
            animationDuration: '6s',
            animationDelay: '2s',
            backgroundColor: isDark ? 'rgba(59, 130, 246, 0.1)' : 'rgba(114, 133, 255, 0.12)',
          }}
        />
        <div
          className="absolute top-1/2 right-1/3 w-64 h-64 rounded-full blur-[80px] animate-pulse"
          style={{
            animationDuration: '10s',
            animationDelay: '1s',
            backgroundColor: isDark ? 'rgba(6, 182, 212, 0.05)' : 'rgba(34, 211, 238, 0.1)',
          }}
        />
      </div>

      {/* Hero Section */}
      <section
        ref={containerRef}
        className="relative z-10 w-full max-w-[1600px] mx-auto px-4 sm:px-6 pt-24 pb-16 md:pt-28 md:pb-24 min-h-[calc(100vh-64px)] md:min-h-screen flex flex-col lg:flex-row items-center gap-8 lg:gap-8 overflow-hidden"
      >
        {/* Left: Copy */}
        <div className="flex-1 space-y-6 md:space-y-10 text-center lg:text-left z-20 pointer-events-auto max-w-2xl order-2 lg:order-1">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--prismer-primary)]/10 border border-[var(--prismer-primary)]/20 text-[var(--prismer-primary)] text-xs font-medium font-mono uppercase tracking-wider animate-in slide-in-from-left-4 fade-in duration-700 backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--prismer-primary)] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--prismer-primary)]"></span>
            </span>
            v{VERSION} Now Public
          </div>

          <h1
            className={`text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-bold tracking-tight leading-[1.1] ${isDark ? 'text-white' : 'text-zinc-900'}`}
          >
            The Intelligence Runtime for{' '}
            <span
              className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--prismer-primary)] via-[var(--prismer-primary-light)] to-[var(--prismer-primary-lighter)]"
              style={{ animation: 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
            >
              AI Agents
            </span>
            .
          </h1>

          <p
            className={`text-base sm:text-lg md:text-xl max-w-xl mx-auto lg:mx-0 leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
          >
            Where agents{' '}
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              evolve, collaborate, and remember
            </span>
            .
          </p>

          <form
            onSubmit={handleStartSubmit}
            className="flex flex-col sm:flex-row gap-2 sm:gap-0 max-w-lg mx-auto lg:mx-0 pt-2 md:pt-4 relative group"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)] opacity-20 group-hover:opacity-40 blur-xl transition-opacity rounded-xl"></div>

            <div
              className={`relative flex-1 flex items-center backdrop-blur-xl border rounded-xl sm:rounded-l-xl sm:rounded-r-none focus-within:border-[var(--prismer-primary)] transition-colors overflow-hidden ${
                isDark ? 'bg-zinc-900/80 border-white/10' : 'bg-white/80 border-[var(--prismer-primary)]/20'
              }`}
            >
              <div className={`pl-3 sm:pl-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <LinkIcon className="w-4 h-4 sm:w-5 sm:h-5" />
              </div>
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="Paste What Agent Want..."
                className={`w-full bg-transparent border-none px-3 sm:px-4 py-3 sm:py-4 focus:outline-none font-mono text-xs sm:text-sm ${
                  isDark ? 'text-white placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'
                }`}
              />
            </div>
            <button
              type="submit"
              className={`relative px-6 sm:px-8 py-3 sm:py-4 font-bold text-xs sm:text-sm uppercase tracking-wide transition-colors rounded-xl sm:rounded-l-none sm:rounded-r-xl flex items-center justify-center gap-2 ${
                isDark
                  ? 'bg-white hover:bg-zinc-200 text-zinc-950'
                  : 'bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary)]/90 text-white'
              }`}
            >
              Start <span className="hidden sm:inline">Building</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
          <div className="flex items-center gap-3 max-w-lg mx-auto lg:mx-0">
            <p className={`text-xs pl-1 hidden sm:block ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Press Enter to extract context immediately
            </p>
            <Link
              href="/evolution"
              className={`hidden sm:inline-flex items-center gap-1.5 text-xs font-medium transition-colors ${
                isDark
                  ? 'text-violet-400 hover:text-violet-300'
                  : 'text-[var(--prismer-primary)] hover:text-[var(--prismer-primary-light)]'
              }`}
            >
              <Dna className="w-3 h-3" />
              Explore Gene Market
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>

        {/* Right: Globe Canvas Animation */}
        <div className="order-1 lg:order-2 w-full lg:w-auto">
          <HeroGlobe containerRef={containerRef} />
        </div>
      </section>

      {/* Section 2: Evolution Showcase */}
      <EvolutionShowcase isDark={isDark} />

      {/* Section 3: Platform Capabilities */}
      <section
        className={`relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 border-t ${isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'}`}
      >
        <div className="text-center mb-8 md:mb-12">
          <h2 className={`text-2xl sm:text-3xl font-bold mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Everything Agents{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)]">
              Need
            </span>
          </h2>
          <p className={`max-w-xl mx-auto ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            One line of code. Your agent evolves, orchestrates, remembers, and stays secure.
          </p>
          <pre
            className={`inline-block mt-4 px-4 py-2 rounded-lg text-xs font-mono ${
              isDark
                ? 'bg-zinc-900/80 text-zinc-300 border border-zinc-800'
                : 'bg-zinc-100 text-zinc-700 border border-zinc-200'
            }`}
          >
            <span className="text-[var(--prismer-primary)]">const</span> prismer ={' '}
            <span className="text-[var(--prismer-primary)]">new</span> PrismerSDK({'{'} apiKey:{' '}
            <span className="text-emerald-500">&quot;sk-prismer-...&quot;</span> {'}'});
          </pre>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 stagger-children">
          {[
            {
              icon: Dna,
              title: 'Evolution',
              desc: 'Agents learn from every execution. Genes evolve via natural selection.',
              metric: '78% avg success rate after 5 runs',
              color: 'violet',
              glow: 'rgba(139,92,246,0.12)',
            },
            {
              icon: Zap,
              title: 'Orchestration',
              desc: 'Cloud tasks, scheduling, multi-agent coordination with retry and cron.',
              metric: '<200ms p95 task dispatch latency',
              color: 'yellow',
              glow: 'rgba(250,204,21,0.12)',
            },
            {
              icon: Shield,
              title: 'Security',
              desc: 'Ed25519 signing, anti-replay, key audit log with hash chain.',
              metric: 'Zero-trust agent auth chain',
              color: 'emerald',
              glow: 'rgba(16,185,129,0.12)',
            },
            {
              icon: Brain,
              title: 'Memory',
              desc: 'Cross-session knowledge, compaction, auto-load MEMORY.md pattern.',
              metric: '10x less context loss across turns',
              color: 'cyan',
              glow: 'rgba(34,211,238,0.12)',
            },
          ].map(({ icon: Icon, title, desc, metric, color, glow }) => (
            <TiltCard key={title} glowColor={glow} maxTilt={5} scale={1.02} className="rounded-2xl">
              <div
                className={`rounded-2xl p-6 h-full ${
                  isDark
                    ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                    : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
                }`}
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 bg-${color}-500/15`}>
                  <Icon className={`w-6 h-6 text-${color}-400`} />
                </div>
                <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>{title}</h3>
                <p className={`text-sm mb-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{desc}</p>
                <p className={`text-xs font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{metric}</p>
                <Link
                  href="/docs"
                  className={`inline-flex items-center gap-1 text-xs mt-3 transition-colors ${
                    isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  Learn more <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </TiltCard>
          ))}
        </div>
      </section>

      {/* Integrations Section */}
      <section
        className={`relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 border-t ${isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'}`}
      >
        <h2 className={`text-2xl sm:text-3xl font-bold mb-4 text-center ${isDark ? 'text-white' : 'text-zinc-900'}`}>
          Works With Your{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)]">
            Stack
          </span>
        </h2>
        <p className={`text-center mb-8 md:mb-12 max-w-2xl mx-auto ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
          Official SDKs, MCP server for AI coding assistants, and OpenClaw channel plugin for agent frameworks.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {/* MCP Server */}
          <div
            className={`group relative rounded-2xl p-6 transition-all duration-300 hover:translate-y-[-4px] ${
              isDark
                ? 'bg-zinc-900/40 border border-white/10 hover:border-violet-500/30 backdrop-blur-xl'
                : 'bg-white/60 border border-zinc-200 hover:border-violet-300 backdrop-blur-xl'
            }`}
          >
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${isDark ? 'bg-violet-500/15' : 'bg-violet-100'}`}
            >
              <Code2 className="w-6 h-6 text-violet-400" />
            </div>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>MCP Server</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              26 tools for context, parsing, messaging, evolution, memory, tasks, and skills. Works with Claude Code,
              Cursor, and Windsurf.
            </p>
            <pre
              className={`text-xs font-mono p-3 rounded-lg ${isDark ? 'bg-zinc-950/80 text-zinc-300 border border-zinc-800' : 'bg-zinc-100 text-zinc-700 border border-zinc-200'}`}
            >
              npx -y @prismer/mcp-server
            </pre>
          </div>

          {/* OpenClaw Plugin */}
          <div
            className={`group relative rounded-2xl p-6 transition-all duration-300 hover:translate-y-[-4px] ${
              isDark
                ? 'bg-zinc-900/40 border border-white/10 hover:border-emerald-500/30 backdrop-blur-xl'
                : 'bg-white/60 border border-zinc-200 hover:border-emerald-300 backdrop-blur-xl'
            }`}
          >
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${isDark ? 'bg-emerald-500/15' : 'bg-emerald-100'}`}
            >
              <Network className="w-6 h-6 text-emerald-400" />
            </div>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>OpenClaw Channel</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              14 agent tools: context, parsing, messaging, discovery, evolution, memory, and recall. Auto-register,
              WebSocket inbound, real-time delivery.
            </p>
            <pre
              className={`text-xs font-mono p-3 rounded-lg ${isDark ? 'bg-zinc-950/80 text-zinc-300 border border-zinc-800' : 'bg-zinc-100 text-zinc-700 border border-zinc-200'}`}
            >
              openclaw plugins install @prismer/openclaw-channel
            </pre>
          </div>

          {/* SDKs */}
          <div
            className={`group relative rounded-2xl p-6 transition-all duration-300 hover:translate-y-[-4px] ${
              isDark
                ? 'bg-zinc-900/40 border border-white/10 hover:border-blue-500/30 backdrop-blur-xl'
                : 'bg-white/60 border border-zinc-200 hover:border-blue-300 backdrop-blur-xl'
            }`}
          >
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${isDark ? 'bg-blue-500/15' : 'bg-blue-100'}`}
            >
              <Code2 className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Official SDKs</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              TypeScript, Python, Go, and Rust. Context, Parse, IM, Evolution, Memory, real-time WebSocket/SSE, and
              offline-first support.
            </p>
            <div className={`space-y-2 text-xs font-mono ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <p>
                <span className="text-blue-400">npm</span> i @prismer/sdk
              </p>
              <p>
                <span className="text-yellow-400">pip</span> install prismer
              </p>
              <p>
                <span className="text-cyan-400">go get</span> github.com/Prismer-AI/Prismer/sdk/golang
              </p>
              <p>
                <span className="text-orange-400">cargo</span> add prismer-sdk
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section
        id="pricing"
        className={`relative z-10 w-full max-w-7xl mx-auto px-4 sm:px-6 py-16 md:py-24 border-t ${isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'}`}
      >
        <h2
          className={`text-2xl sm:text-3xl font-bold mb-8 md:mb-16 text-center ${isDark ? 'text-white' : 'text-zinc-900'}`}
        >
          Credit{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)]">
            Pricing
          </span>
        </h2>
        <CreditPurchaseSlider variant="landing" />
      </section>
    </div>
  );
}
