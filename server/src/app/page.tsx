'use client';

import { useState, useRef, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Link as LinkIcon, Dna } from 'lucide-react';
import { HeroGlobe } from '@/components/landing/hero-globe';
import { MeshGradient } from '@paper-design/shaders-react';
import { useTheme } from '@/contexts/theme-context';
import { VERSION } from '@/lib/version';
import { CreditPurchaseSlider } from '@/components/credit-purchase-slider';

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
            The Harness Evolution for{' '}
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
