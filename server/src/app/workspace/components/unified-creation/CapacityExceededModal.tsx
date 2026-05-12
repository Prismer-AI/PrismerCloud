'use client';

/**
 * §30 B3.6 — CapacityExceededModal.
 *
 * Quota modal (NOT error) per §2.8.7: temperate tone, violet hero on
 * neutral chrome, no red palette, no ⚠️ emoji, body lists solutions.
 * Width clamp(360px,42vw,520px) — narrower than UnifiedCreationModal
 * (decision-moment UX). Hero "N / N" violet gradient, scale 0.85→1
 * springHeavy. 4 equal-height row buttons (purchase/upgrade/manage/
 * temp-disable), each icon + content + chevron, hover bg-white/[0.04].
 * Ghost "取消" + top-right X. "Temp disable" routes to manage-agents
 * since that's where you stop agents today.
 */

import { Fragment } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { ChevronRight, CreditCard, Power, ShoppingCart, Users, X } from 'lucide-react';

import { radius, s, springHeavy, springSnap } from '../../lib/design';

export interface CapacityExceededModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  used: number;
  total: number;
  deviceCount: number;
  /** Routes user to billing add-device flow. */
  onPurchaseDevice: () => void;
  /** Routes user to upgrade-plan settings. */
  onUpgradePlan: () => void;
  /** Routes user to team management (where they can disable / delete agents). */
  onManageAgents: () => void;
}

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };

type SolutionKey = 'purchase' | 'upgrade' | 'manage' | 'disable';
const SOLUTIONS: ReadonlyArray<{
  key: SolutionKey;
  primary?: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
}> = [
  {
    key: 'purchase',
    primary: true,
    icon: <ShoppingCart className="h-4 w-4" />,
    title: '加购 1 × Cloud Device',
    detail: '增加 3 个 agent 槽位 (按月计费)',
  },
  { key: 'upgrade', icon: <CreditCard className="h-4 w-4" />, title: '升级订阅', detail: '切到包含更多 device 的套餐' },
  {
    key: 'manage',
    icon: <Users className="h-4 w-4" />,
    title: '删除一个现有 agent',
    detail: '到团队管理移除不再需要的 agent',
  },
  { key: 'disable', icon: <Power className="h-4 w-4" />, title: '临时关一个 agent', detail: '保留数据,只释放运行槽位' },
];

const ROW_STYLES = {
  primaryDark: {
    row: 'border-violet-400/30 bg-violet-500/[0.08] hover:bg-violet-500/[0.14]',
    icon: 'bg-violet-500/20 text-violet-300',
    title: 'text-violet-100',
  },
  primaryLight: {
    row: 'border-violet-300 bg-violet-50 hover:bg-violet-100',
    icon: 'bg-violet-100 text-violet-600',
    title: 'text-violet-900',
  },
  baseDark: {
    row: 'border-white/[0.06] hover:bg-white/[0.04]',
    icon: 'bg-white/[0.06] text-zinc-300',
    title: 'text-zinc-100',
  },
  baseLight: { row: 'border-zinc-200 hover:bg-zinc-50', icon: 'bg-zinc-100 text-zinc-600', title: 'text-zinc-900' },
} as const;

function SolutionRow({
  isDark,
  icon,
  title,
  detail,
  primary,
  onClick,
  testId,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  primary?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  const sty = ROW_STYLES[`${primary ? 'primary' : 'base'}${isDark ? 'Dark' : 'Light'}` as keyof typeof ROW_STYLES];
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`group flex w-full items-center gap-3 border px-4 py-3 text-left transition-colors ${radius.card} ${sty.row}`}
    >
      <span
        aria-hidden
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center ${radius.small} ${sty.icon}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`text-sm font-semibold ${sty.title}`}>{title}</span>
        <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>{detail}</span>
      </span>
      <ChevronRight
        aria-hidden
        className={`h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      />
    </button>
  );
}

// ───────────────────────── Component ────────────────────────────

export function CapacityExceededModal({
  open,
  onOpenChange,
  isDark,
  used,
  total,
  deviceCount,
  onPurchaseDevice,
  onUpgradePlan,
  onManageAgents,
}: CapacityExceededModalProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tHeavy: Transition = reduce ? REDUCED : springHeavy;
  const tSnap: Transition = reduce ? REDUCED : springSnap;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <AnimatePresence>
          {open ? (
            <Fragment>
              <DialogPrimitive.Overlay asChild>
                <motion.div
                  data-testid="capacity-exceeded-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? REDUCED : { duration: 0.2, ease: 'easeOut' }}
                  className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
                />
              </DialogPrimitive.Overlay>

              <DialogPrimitive.Content asChild aria-describedby={undefined}>
                <div className="fixed inset-0 z-50 grid place-items-center pointer-events-none">
                  <motion.div
                    data-testid="capacity-exceeded-modal"
                    initial={{ opacity: 0, y: 18, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    transition={tSnap}
                    onClick={(e) => e.stopPropagation()}
                    className={`pointer-events-auto relative flex w-[clamp(360px,42vw,520px)] max-h-[88vh] flex-col overflow-hidden border p-6 ${s(
                      theme,
                      'modal',
                    )} ${radius.pane}`}
                  >
                    <DialogPrimitive.Title asChild>
                      <span className="sr-only">设备容量已满</span>
                    </DialogPrimitive.Title>

                    <DialogPrimitive.Close asChild>
                      <button
                        type="button"
                        aria-label="关闭"
                        data-testid="capacity-exceeded-close"
                        className={`absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center ${radius.button} ${
                          isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-100'
                        }`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </DialogPrimitive.Close>

                    {/* Hero number — violet gradient, springHeavy scale-in */}
                    <div className="flex flex-col items-center pt-4 pb-2">
                      <motion.div
                        initial={{ scale: 0.85, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={tHeavy}
                        data-testid="capacity-exceeded-hero"
                        className="text-5xl font-bold tabular-nums tracking-tight bg-gradient-to-br from-violet-400 via-fuchsia-400 to-rose-400 bg-clip-text text-transparent"
                      >
                        {used} / {total}
                      </motion.div>
                      <p className={`mt-3 text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                        你的 Cloud Device 满了
                      </p>
                      <p className={`mt-1 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>
                        当前 {deviceCount} × Cloud Device 已经在跑 {used} 个 agent。要加新 agent 需要:
                      </p>
                    </div>

                    {/* Solution list */}
                    <div className="mt-4 flex flex-col gap-2" role="list">
                      {SOLUTIONS.map((row) => {
                        const handler =
                          row.key === 'purchase'
                            ? onPurchaseDevice
                            : row.key === 'upgrade'
                              ? onUpgradePlan
                              : onManageAgents;
                        return (
                          <SolutionRow
                            key={row.key}
                            isDark={isDark}
                            primary={row.primary}
                            icon={row.icon}
                            title={row.title}
                            detail={row.detail}
                            onClick={handler}
                            testId={`capacity-exceeded-${row.key}`}
                          />
                        );
                      })}
                    </div>

                    {/* Footer */}
                    <div className="mt-5 flex justify-end">
                      <DialogPrimitive.Close asChild>
                        <button
                          type="button"
                          data-testid="capacity-exceeded-cancel"
                          className={`inline-flex items-center px-3 py-2 text-sm font-medium transition-colors ${radius.button} ${
                            isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
                          }`}
                        >
                          取消
                        </button>
                      </DialogPrimitive.Close>
                    </div>
                  </motion.div>
                </div>
              </DialogPrimitive.Content>
            </Fragment>
          ) : null}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default CapacityExceededModal;
