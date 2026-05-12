'use client';

/**
 * /settings — Account & workspace settings root.
 *
 * Wave-7 §30 §2.8.6 / Wave-7 §31 §2.1: surfaces the CEO Authorization
 * panel. Triggering CeoAuthorizationModal from a deliberate Settings
 * entry — NOT auto-popped on Simple Mode completion — is the active
 * trigger path until §31 dispatch lands (after which the dispatch
 * path will simply read `metadata.ceoPermissions`).
 *
 * Future sections (workspace, security, notifications, …) live under
 * the same shell — left rail picks the section, right pane renders it.
 * For now CEO Authorization is the only section, so the rail collapses
 * to a single-item nav (visible so the layout reads as "Settings →
 * CEO Authorization" rather than "single page").
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Crown, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';

import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { CeoAuthorizationModal } from '@/app/workspace/components/unified-creation';
import { radius, s, springSnap } from '@/app/workspace/lib/design';

interface CeoPermissions {
  canCreateAgents: boolean;
  canDispatch: boolean;
}

const DEFAULT_PERMS: CeoPermissions = { canCreateAgents: false, canDispatch: false };

async function fetchPermissions(): Promise<CeoPermissions> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token) headers['Authorization'] = `Bearer ${parsed.token}`;
    }
  } catch {
    /* ignore — request just runs unauthenticated and the server 401s */
  }
  const resp = await fetch('/api/users/me/ceo-permissions', { headers, cache: 'no-store' });
  if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);
  const body = await resp.json();
  if (!body?.success) throw new Error(body?.error?.message ?? 'GET failed');
  return body.data as CeoPermissions;
}

async function patchPermissions(patch: Partial<CeoPermissions>): Promise<CeoPermissions> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token) headers['Authorization'] = `Bearer ${parsed.token}`;
    }
  } catch {
    /* ignore */
  }
  const resp = await fetch('/api/users/me/ceo-permissions', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`PATCH failed: ${resp.status}`);
  const body = await resp.json();
  if (!body?.success) throw new Error(body?.error?.message ?? 'PATCH failed');
  return body.data as CeoPermissions;
}

function PermissionToggle({
  isDark,
  label,
  description,
  checked,
  disabled,
  onChange,
  testId,
}: {
  isDark: boolean;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div
      className={`flex items-start justify-between gap-4 border p-4 ${s(isDark ? 'dark' : 'light', 'inset')} ${radius.card}`}
    >
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{label}</p>
        <p className={`mt-0.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{description}</p>
      </div>
      <motion.button
        type="button"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        disabled={disabled}
        whileTap={reduce || disabled ? undefined : { scale: 0.96 }}
        transition={springSnap}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        } ${checked ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500' : isDark ? 'bg-zinc-700' : 'bg-zinc-300'}`}
      >
        <motion.span
          layout
          transition={springSnap}
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </motion.button>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthLoading, addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [perms, setPerms] = useState<CeoPermissions>(DEFAULT_PERMS);
  const [loading, setLoading] = useState(true);
  const [persisting, setPersisting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Redirect unauthenticated callers — same shape as /dashboard
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.push('/auth?redirect=/settings');
    }
  }, [isAuthLoading, isAuthenticated, router]);

  // Initial load
  useEffect(() => {
    if (!isAuthenticated) return;
    let alive = true;
    setLoading(true);
    fetchPermissions()
      .then((data) => {
        if (alive) setPerms(data);
      })
      .catch((err) => {
        console.error('[Settings] Failed to load CEO permissions', err);
        if (alive) addToast('加载 CEO 授权状态失败', 'error');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isAuthenticated, addToast]);

  const onAuthorize = useCallback(async () => {
    setPersisting(true);
    try {
      const next = await patchPermissions({ canCreateAgents: true, canDispatch: true });
      setPerms(next);
      setModalOpen(false);
      addToast('CEO 已永久授权', 'success');
    } catch (err) {
      console.error('[Settings] Authorize failed', err);
      addToast(err instanceof Error ? err.message : '授权失败', 'error');
    } finally {
      setPersisting(false);
    }
  }, [addToast]);

  const onToggle = useCallback(
    async (key: keyof CeoPermissions, next: boolean) => {
      // Optimistic UX so the switch is responsive; rollback on failure.
      const prev = perms;
      const optimistic = { ...perms, [key]: next };
      setPerms(optimistic);
      try {
        const persisted = await patchPermissions({ [key]: next } as Partial<CeoPermissions>);
        setPerms(persisted);
      } catch (err) {
        console.error('[Settings] Toggle failed', err);
        addToast(err instanceof Error ? err.message : '更新失败', 'error');
        setPerms(prev);
      }
    },
    [perms, addToast],
  );

  if (isAuthLoading || !isAuthenticated) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  const authorized = perms.canCreateAgents || perms.canDispatch;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10 min-h-[calc(100vh-64px)] space-y-6">
      <header>
        <h1 className={`text-2xl sm:text-3xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Settings</h1>
        <p className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>管理 CEO 授权、账户与工作区偏好</p>
      </header>

      {/* CEO Authorization section */}
      <section
        data-testid="settings-ceo-authorization"
        className={`border p-5 sm:p-6 ${s(isDark ? 'dark' : 'light', 'card')} ${radius.pane}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
              style={{
                backgroundImage: 'linear-gradient(135deg, #8b5cf6 0%, #d946ef 50%, #22d3ee 100%)',
              }}
            >
              <Crown className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className={`text-base sm:text-lg font-semibold ${isDark ? 'text-zinc-50' : 'text-zinc-900'}`}>
                CEO Authorization
              </h2>
              <p className={`mt-0.5 text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                授权 CEO agent 在你不在场时代你创建团队成员、分派任务
              </p>
            </div>
          </div>

          {/* Status pill */}
          <span
            data-testid="settings-ceo-status"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ${radius.chip} ${
              authorized
                ? isDark
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-emerald-100 text-emerald-700'
                : isDark
                  ? 'bg-zinc-700/40 text-zinc-300'
                  : 'bg-zinc-200 text-zinc-700'
            }`}
          >
            {authorized ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
            {authorized ? '已授权' : '未授权'}
          </span>
        </div>

        <div className="mt-5">
          {loading ? (
            <div
              className={`flex items-center gap-2 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
              data-testid="settings-ceo-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> 加载中...
            </div>
          ) : authorized ? (
            <div className="flex flex-col gap-3" data-testid="settings-ceo-toggles">
              <PermissionToggle
                isDark={isDark}
                checked={perms.canCreateAgents}
                onChange={(next) => void onToggle('canCreateAgents', next)}
                label="创建团队角色"
                description="允许 CEO 在现有 Device 容量内 register 新 agent"
                testId="settings-ceo-toggle-canCreateAgents"
              />
              <PermissionToggle
                isDark={isDark}
                checked={perms.canDispatch}
                onChange={(next) => void onToggle('canDispatch', next)}
                label="派任务给团队成员"
                description="允许 CEO 把你的任务转派给其他 agent 执行"
                testId="settings-ceo-toggle-canDispatch"
              />
              <p className={`mt-1 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                注:销毁 agent / 创建 Device 永远需要你单独 approve,不在此处永久授权。
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3" data-testid="settings-ceo-unauthorized">
              <p className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                你尚未授权 CEO 代理决策。授权后 CEO 可在你不在场时帮你 onboard 新角色、把任务派给合适的 agent。
              </p>
              <div>
                <motion.button
                  type="button"
                  data-testid="settings-ceo-authorize-button"
                  onClick={() => setModalOpen(true)}
                  whileTap={{ scale: 0.97 }}
                  transition={springSnap}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white ${radius.button}`}
                  style={{
                    backgroundImage: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d946ef 100%)',
                    boxShadow: '0 12px 24px -10px rgba(124, 58, 237, 0.55)',
                  }}
                >
                  <Crown className="h-4 w-4" />
                  授权 CEO
                </motion.button>
              </div>
            </div>
          )}
        </div>
      </section>

      <CeoAuthorizationModal
        open={modalOpen}
        onOpenChange={(open) => {
          if (!persisting) setModalOpen(open);
        }}
        isDark={isDark}
        authorizing={persisting}
        onAuthorize={onAuthorize}
      />
    </div>
  );
}
