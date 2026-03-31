'use client';

import Link from 'next/link';
import { Github, Twitter } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';

export function Footer() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <footer className={`w-full border-t transition-colors ${
      isDark 
        ? 'border-white/5 bg-zinc-950/80' 
        : 'border-[var(--prismer-primary)]/10 bg-white/80'
    } backdrop-blur-sm`}>
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 flex items-center justify-center">
                <img 
                  src={isDark ? '/cloud_dark.svg' : '/cloud_regular.svg'} 
                  alt="Prismer Cloud" 
                  className="w-8 h-8 object-contain"
                  />
              </div>
              <span className={`font-bold text-lg ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                Prismer Cloud
              </span>
            </div>
            <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
              The Knowledge Drive for AI Agents.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Product</h4>
            <ul className={`space-y-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <li>
                <Link href="/playground" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Playground
                </Link>
              </li>
              <li>
                <Link href="/docs" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Documentation
                </Link>
              </li>
              <li>
                <Link href="/#pricing" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/dashboard" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Dashboard
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Resources</h4>
            <ul className={`space-y-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <li>
                <Link href="/docs" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  API Reference
                </Link>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Status
                </a>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Changelog
                </a>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Blog
                </a>
              </li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className={`font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Company</h4>
            <ul className={`space-y-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  About
                </a>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Contact
                </a>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="#" className={`transition-colors ${isDark ? 'hover:text-white' : 'hover:text-zinc-900'}`}>
                  Terms of Service
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className={`border-t mt-12 pt-8 flex flex-col md:flex-row items-center justify-between gap-4 ${
          isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'
        }`}>
          <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
            © {new Date().getFullYear()} Prismer Cloud. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a 
              href="https://github.com/Prismer-AI/Prismer"
              target="_blank"
              rel="noopener noreferrer"
              className={`transition-colors ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-500 hover:text-zinc-900'}`}
            >
              <Github className="w-5 h-5" />
            </a>
            <a 
              href="https://twitter.com" 
              target="_blank"
              rel="noopener noreferrer"
              className={`transition-colors ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-500 hover:text-zinc-900'}`}
            >
              <Twitter className="w-5 h-5" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
