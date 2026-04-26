'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Code, LogOut, ChevronDown, Sun, Moon, Github, Menu, X, UserCircle, Dna, LayoutDashboard } from 'lucide-react';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';

// Auth headers for notification API calls (mirrors pattern from src/lib/api.ts)
function getNotificationAuthHeaders(): Record<string, string> {
  try {
    const authStored = localStorage.getItem('prismer_auth');
    if (authStored) {
      const authData = JSON.parse(authStored);
      if (authData.token && authData.expiresAt > Date.now()) return { Authorization: `Bearer ${authData.token}` };
    }
    const apiKeyStored = localStorage.getItem('prismer_active_api_key');
    if (apiKeyStored) {
      const keyData = JSON.parse(apiKeyStored);
      if (keyData.key && keyData.status === 'ACTIVE') return { Authorization: `Bearer ${keyData.key}` };
    }
  } catch {}
  return {};
}

// Generate avatar URL from email using DiceBear
function getAvatarUrl(email: string): string {
  const seed = encodeURIComponent(email);
  return `https://api.dicebear.com/7.x/initials/svg?seed=${seed}&backgroundColor=6366f1,8b5cf6,a855f7&backgroundType=gradientLinear`;
}

const NAV_ITEMS = [
  { href: '/playground', label: 'Playground' },
  { href: '/evolution', label: 'Evolution' },
  { href: '/community', label: 'Community' },
  { href: '/docs', label: 'Docs' },
  { href: '/#pricing', label: 'Pricing' },
];

export function Navbar() {
  const pathname = usePathname();
  const { isAuthenticated, isAuthLoading, logout, addToast, user } = useApp();
  const { resolvedTheme, toggleTheme } = useTheme();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [headerVisible, setHeaderVisible] = useState(true);
  const bellRef = useRef<HTMLButtonElement>(null);
  const lastScrollY = useRef(0);

  const isDark = resolvedTheme === 'dark';
  const showAuthenticatedUI = !isAuthLoading && isAuthenticated;
  const effectiveHeaderVisible = headerVisible || mobileMenuOpen || showNotifications || showProfileMenu;

  // Scroll detection — background change + direction-based hide/show
  useEffect(() => {
    const THRESHOLD = 5;
    const handleScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY.current;
      if (Math.abs(delta) < THRESHOLD) return;

      if (currentY <= 10) {
        setHeaderVisible(true);
      } else if (delta > 0) {
        setHeaderVisible(false); // scrolling DOWN → hide
      } else {
        setHeaderVisible(true); // scrolling UP → show
      }
      lastScrollY.current = currentY;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  // Fetch initial unread count
  useEffect(() => {
    if (!showAuthenticatedUI) return;
    fetch('/api/notifications', { headers: getNotificationAuthHeaders() })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setUnreadCount(data.unreadCount || 0);
      })
      .catch(() => {});
  }, [showAuthenticatedUI]);

  const handleLogout = () => {
    logout();
    addToast('Successfully logged out.', 'info');
    setShowProfileMenu(false);
    setMobileMenuOpen(false);
  };

  // Build nav items — Dashboard only when authenticated
  const allNavItems = showAuthenticatedUI ? [{ href: '/dashboard', label: 'Dashboard' }, ...NAV_ITEMS] : NAV_ITEMS;

  function isNavActive(href: string): boolean {
    if (href === '/#pricing') return false;
    return pathname === href;
  }

  const NavLink = ({ href, label }: { href: string; label: string }) => {
    const active = isNavActive(href);
    return (
      <Link
        href={href}
        className={`relative px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200
          ${
            active
              ? isDark
                ? 'text-white'
                : 'text-[var(--prismer-primary)]'
              : isDark
                ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
          }`}
      >
        {label}
        {active && (
          <span
            className={`absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-4/5 h-0.5 rounded-full
            animate-in fade-in zoom-in-50 duration-300
            ${
              isDark
                ? 'bg-gradient-to-r from-violet-400 to-violet-600'
                : 'bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)]'
            }`}
          />
        )}
      </Link>
    );
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 px-3 sm:px-5 pt-3 transition-transform duration-300 ${effectiveHeaderVisible ? 'translate-y-0' : '-translate-y-full'}`}
    >
      {/* Floating container — frosted glass */}
      <div
        className={`rounded-2xl backdrop-blur-xl backdrop-saturate-150 border shadow-lg ${
          isDark ? 'bg-zinc-950/60 border-white/10 shadow-black/25' : 'bg-white/65 border-white/40 shadow-black/[0.08]'
        }`}
      >
        {/* Main bar */}
        <div className="px-4 h-14 flex items-center justify-between">
          {/* LEFT: Logo */}
          <Link href="/" className="flex items-center gap-2 cursor-pointer group shrink-0">
            <div className="w-7 h-7 flex items-center justify-center">
              <img
                src={isDark ? '/animation-dark-small.webp' : '/animation-light-small.webp'}
                alt="Prismer Cloud"
                className="w-7 h-7 object-contain"
              />
            </div>
            <span
              className={`font-bold text-lg tracking-tight transition-colors ${
                isDark
                  ? 'text-white group-hover:text-violet-400'
                  : 'text-zinc-900 group-hover:text-[var(--prismer-primary)]'
              }`}
            >
              Prismer Cloud
            </span>
          </Link>

          {/* CENTER: Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-1">
            {allNavItems.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </div>

          {/* RIGHT: Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* GitHub icon (desktop) */}
            <a
              href="https://github.com/Prismer-AI/PrismerCloud"
              target="_blank"
              rel="noopener noreferrer"
              className={`hidden md:flex p-2 rounded-lg transition-all duration-200 ${
                isDark
                  ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                  : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
              }`}
              aria-label="GitHub"
            >
              <Github className="w-[18px] h-[18px]" />
            </a>

            {/* Theme toggle (desktop) */}
            <button
              onClick={toggleTheme}
              className={`hidden md:flex p-2 rounded-lg transition-all duration-200 ${
                isDark
                  ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                  : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
              }`}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
            </button>

            {/* Desktop auth section */}
            <div className="hidden md:flex items-center gap-2">
              {!showAuthenticatedUI ? (
                <>
                  <Link
                    href="/auth"
                    className={`text-sm font-medium transition-colors ${
                      isDark ? 'text-zinc-300 hover:text-white' : 'text-zinc-700 hover:text-zinc-900'
                    }`}
                  >
                    Sign In
                  </Link>
                  <Link
                    href="/auth?redirect=/dashboard?tab=keys"
                    className="relative group px-4 py-1.5 rounded-full text-sm font-bold text-white overflow-hidden bg-[var(--prismer-primary)] border border-[var(--prismer-primary-light)]/30 hover:border-[var(--prismer-primary-light)] transition-all duration-300"
                  >
                    <span className="absolute inset-0 bg-gradient-to-r from-[var(--prismer-primary)] to-[var(--prismer-primary-light)] opacity-0 group-hover:opacity-100 transition-opacity duration-300"></span>
                    <span className="relative z-10 flex items-center gap-2">
                      Get API Key <Code className="w-3 h-3" />
                    </span>
                  </Link>
                </>
              ) : (
                <>
                  {/* Notification bell */}
                  <div className="relative">
                    <button
                      ref={bellRef}
                      onClick={() => {
                        setShowNotifications(!showNotifications);
                        setShowProfileMenu(false);
                      }}
                      className={`relative p-2 rounded-lg transition-colors ${
                        isDark
                          ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                          : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
                      }`}
                    >
                      <Bell className="w-[18px] h-[18px]" />
                      {unreadCount > 0 && (
                        <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 bg-[var(--prismer-primary-light)] rounded-full text-[10px] font-bold text-white flex items-center justify-center">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </button>

                    {/* Notification dropdown */}
                    {showNotifications && (
                      <NotificationDropdown
                        isDark={isDark}
                        onClose={() => setShowNotifications(false)}
                        onUnreadCountChange={setUnreadCount}
                      />
                    )}
                  </div>

                  <div className={`h-6 w-px ${isDark ? 'bg-white/10' : 'bg-[var(--prismer-primary)]/10'}`} />

                  {/* Profile */}
                  <div className="relative">
                    <button
                      className="flex items-center gap-2 cursor-pointer group outline-none"
                      onClick={() => {
                        setShowProfileMenu(!showProfileMenu);
                        setShowNotifications(false);
                      }}
                      onBlur={() => setTimeout(() => setShowProfileMenu(false), 200)}
                    >
                      <img
                        src={user?.avatar || (user?.email ? getAvatarUrl(user.email) : '')}
                        alt={user?.email || 'User'}
                        className={`w-7 h-7 rounded-full border ${isDark ? 'border-white/10' : 'border-[var(--prismer-primary)]/20'}`}
                        onError={(e) => {
                          if (user?.email) {
                            (e.target as HTMLImageElement).src = getAvatarUrl(user.email);
                          }
                        }}
                      />
                      <ChevronDown
                        className={`w-3 h-3 transition-transform duration-200 ${showProfileMenu ? 'rotate-180' : ''} ${
                          isDark ? 'text-zinc-500' : 'text-zinc-400'
                        }`}
                      />
                    </button>

                    {showProfileMenu && (
                      <div
                        className={`absolute right-0 top-full mt-2 w-56 border rounded-xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 ${
                          isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-[var(--prismer-primary)]/10'
                        }`}
                      >
                        <div
                          className={`px-4 py-3 border-b ${isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'}`}
                        >
                          <p className="text-xs text-zinc-500">Signed in as</p>
                          <p className={`text-sm font-bold truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                            {user?.email || 'User'}
                          </p>
                        </div>
                        <div className="p-1">
                          <Link
                            href="/dashboard"
                            onClick={() => setShowProfileMenu(false)}
                            className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-2 ${
                              isDark
                                ? 'text-zinc-300 hover:bg-white/5'
                                : 'text-zinc-700 hover:bg-[var(--prismer-primary)]/5'
                            }`}
                          >
                            <LayoutDashboard className="w-4 h-4 shrink-0 opacity-80" />
                            Dashboard
                          </Link>
                          <Link
                            href="/community/my"
                            onClick={() => setShowProfileMenu(false)}
                            className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-2 ${
                              isDark
                                ? 'text-zinc-300 hover:bg-white/5'
                                : 'text-zinc-700 hover:bg-[var(--prismer-primary)]/5'
                            }`}
                          >
                            <UserCircle className="w-4 h-4 shrink-0 opacity-80" />
                            My Community
                          </Link>
                          <Link
                            href="/evolution"
                            onClick={() => setShowProfileMenu(false)}
                            className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-colors flex items-center gap-2 ${
                              isDark
                                ? 'text-zinc-300 hover:bg-white/5'
                                : 'text-zinc-700 hover:bg-[var(--prismer-primary)]/5'
                            }`}
                          >
                            <Dna className="w-4 h-4 shrink-0 opacity-80" />
                            Evolution Space
                          </Link>
                          <div className={`h-px my-1 ${isDark ? 'bg-white/5' : 'bg-[var(--prismer-primary)]/10'}`} />
                          <button
                            onClick={handleLogout}
                            className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex items-center gap-2"
                          >
                            <LogOut className="w-4 h-4" /> Sign Out
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Hamburger (mobile only) */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className={`md:hidden p-2 rounded-lg transition-all duration-200 ${
                isDark
                  ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                  : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
              }`}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Menu — inside floating container */}
        <div
          className={`md:hidden overflow-hidden transition-all duration-300 ease-out ${
            mobileMenuOpen ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'
          }`}
        >
          <div
            className={`px-4 py-4 space-y-1 border-t ${
              isDark ? 'border-white/5' : 'border-[var(--prismer-primary)]/10'
            }`}
          >
            {/* Nav items */}
            {allNavItems.map((item, index) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`block px-4 py-3 rounded-lg text-base font-medium transition-all duration-200 ${
                  isNavActive(item.href)
                    ? isDark
                      ? 'bg-white/10 text-white'
                      : 'bg-[var(--prismer-primary)]/10 text-[var(--prismer-primary)]'
                    : isDark
                      ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
                }`}
                style={{
                  transitionDelay: mobileMenuOpen ? `${index * 50}ms` : '0ms',
                }}
              >
                {item.label}
              </Link>
            ))}

            {/* Divider */}
            <div className={`my-3 h-px ${isDark ? 'bg-white/10' : 'bg-[var(--prismer-primary)]/10'}`} />

            {/* GitHub + Theme toggle row */}
            <div className="flex items-center gap-3 px-4 py-2">
              <a
                href="https://github.com/Prismer-AI/PrismerCloud"
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-2 text-sm transition-colors ${
                  isDark ? 'text-zinc-400 hover:text-white' : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                <Github className="w-5 h-5" />
                <span>GitHub</span>
              </a>

              <div className="flex-1" />

              <button
                onClick={toggleTheme}
                className={`p-2 rounded-lg transition-all duration-200 ${
                  isDark
                    ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-[var(--prismer-primary)]/5'
                }`}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            </div>

            {/* Mobile auth section */}
            {!showAuthenticatedUI ? (
              <div className="px-4 pt-2 pb-1 space-y-2">
                <Link
                  href="/auth"
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block text-center py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isDark
                      ? 'text-zinc-300 hover:text-white hover:bg-white/5'
                      : 'text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  Sign In
                </Link>
                <Link
                  href="/auth?redirect=/dashboard?tab=keys"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block text-center py-2.5 rounded-lg text-sm font-bold text-white bg-[var(--prismer-primary)] hover:bg-[var(--prismer-primary-light)] transition-colors"
                >
                  Get API Key
                </Link>
              </div>
            ) : (
              <div className="px-4 pt-2 pb-1">
                <div className="flex items-center gap-3 py-2">
                  <img
                    src={user?.avatar || (user?.email ? getAvatarUrl(user.email) : '')}
                    alt={user?.email || 'User'}
                    className={`w-8 h-8 rounded-full border ${isDark ? 'border-white/10' : 'border-[var(--prismer-primary)]/20'}`}
                    onError={(e) => {
                      if (user?.email) {
                        (e.target as HTMLImageElement).src = getAvatarUrl(user.email);
                      }
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                      {user?.email || 'User'}
                    </p>
                  </div>
                </div>
                <Link
                  href="/community/my"
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium ${
                    isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-[var(--prismer-primary)]/5'
                  }`}
                >
                  <UserCircle className="w-4 h-4 shrink-0" />
                  My Community
                </Link>
                <Link
                  href="/evolution"
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium ${
                    isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-700 hover:bg-[var(--prismer-primary)]/5'
                  }`}
                >
                  <Dna className="w-4 h-4 shrink-0" />
                  Evolution Space
                </Link>
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex items-center gap-2"
                >
                  <LogOut className="w-4 h-4" /> Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

// ============================================================================
// Notification Dropdown (inline, no separate file needed for now)
// ============================================================================

interface NotificationItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  time: string;
  read: boolean;
}

function NotificationDropdown({
  isDark,
  onClose,
  onUnreadCountChange,
}: {
  isDark: boolean;
  onClose: () => void;
  onUnreadCountChange: (count: number) => void;
}) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch notifications
  useEffect(() => {
    fetch('/api/notifications', { headers: getNotificationAuthHeaders() })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setNotifications(data.data || []);
          onUnreadCountChange(data.unreadCount || 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [onUnreadCountChange]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the same click
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const markAllRead = async () => {
    try {
      const res = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getNotificationAuthHeaders() },
        body: JSON.stringify({ markAllRead: true }),
      });
      const data = await res.json();
      if (data.success) {
        setNotifications(data.data || []);
        onUnreadCountChange(data.unreadCount || 0);
      }
    } catch {}
  };

  const dismiss = async (id: string) => {
    try {
      const res = await fetch(`/api/notifications?id=${id}`, {
        method: 'DELETE',
        headers: getNotificationAuthHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        setNotifications(data.data || []);
        onUnreadCountChange(data.unreadCount || 0);
      }
    } catch {}
  };

  const typeColors: Record<string, string> = {
    success: 'text-emerald-400',
    warning: 'text-amber-400',
    error: 'text-red-400',
    info: 'text-blue-400',
  };

  return (
    <div
      ref={panelRef}
      className={`absolute right-0 top-full mt-2 w-80 border rounded-xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 ${
        isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'
      }`}
    >
      {/* Header */}
      <div
        className={`px-4 py-3 flex items-center justify-between border-b ${
          isDark ? 'border-white/5' : 'border-zinc-200'
        }`}
      >
        <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Notifications</h3>
        {notifications.some((n) => !n.read) && (
          <button onClick={markAllRead} className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
            Mark all read
          </button>
        )}
      </div>

      {/* List */}
      <div className="max-h-[360px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-zinc-600 border-t-violet-400 rounded-full animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div className={`py-8 text-center text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
            No notifications
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`px-4 py-3 flex gap-3 group transition-colors ${
                !n.read ? (isDark ? 'bg-white/[0.02]' : 'bg-violet-50/50') : ''
              } ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50'}`}
            >
              <div
                className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                  !n.read ? 'bg-violet-400' : isDark ? 'bg-zinc-700' : 'bg-zinc-300'
                }`}
              />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
                  <span className={typeColors[n.type] || typeColors.info}>
                    {n.type === 'error' ? '!' : n.type === 'warning' ? '!' : ''}
                  </span>{' '}
                  {n.title}
                </p>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{n.message}</p>
                <p className={`text-xs mt-1 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>{n.time}</p>
              </div>
              <button
                onClick={() => dismiss(n.id)}
                className={`opacity-0 group-hover:opacity-100 p-1 rounded transition-all ${
                  isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'
                }`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
