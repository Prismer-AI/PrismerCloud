'use client';

import { usePathname } from 'next/navigation';
import { Navbar } from '@/components/navbar';
import { Footer } from '@/components/footer';
import { ToastContainer } from '@/components/ui/toast';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { toasts, removeToast } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Show footer only on landing and docs pages
  const showFooter = pathname === '/' || pathname === '/docs' || pathname?.startsWith('/evolution');
  
  // Landing page has its own dynamic background
  const isLanding = pathname === '/';

  return (
    <div className={`min-h-screen font-sans bg-grid relative transition-colors flex flex-col ${
      isDark ? 'bg-zinc-950 text-zinc-50' : 'bg-white text-zinc-900'
    }`}>
      {/* Subtle gradient background for non-landing pages */}
      {!isLanding && (
        <div className="fixed inset-0 z-0">
          {/* Base gradient */}
          <div className={`absolute inset-0 ${
            isDark 
              ? 'bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950' 
              : 'bg-gradient-to-br from-white via-slate-50 to-white'
          }`} />
          {/* Accent gradients */}
          <div className={`absolute top-0 left-1/4 w-[600px] h-[600px] rounded-full blur-[150px] ${
            isDark ? 'bg-violet-600/5' : 'bg-violet-400/10'
          }`} />
          <div className={`absolute bottom-1/4 right-1/4 w-[500px] h-[500px] rounded-full blur-[120px] ${
            isDark ? 'bg-cyan-600/5' : 'bg-cyan-400/8'
          }`} />
          <div className={`absolute top-1/2 right-0 w-[400px] h-[400px] rounded-full blur-[100px] ${
            isDark ? 'bg-blue-600/5' : 'bg-blue-400/8'
          }`} />
          {/* Noise overlay for texture */}
          <div className={`absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg viewBox=%270 0 256 256%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27noise%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.8%27 numOctaves=%274%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23noise)%27/%3E%3C/svg%3E')] ${
            isDark ? 'opacity-30' : 'opacity-10'
          }`} />
        </div>
      )}
      
      <Navbar />

      <main className="relative z-10 pt-[88px] pb-12 flex-1">
        {children}
      </main>

      {showFooter && (
        <div className="relative z-10">
          <Footer />
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}

