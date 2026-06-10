'use client';

/**
 * §30 §2.8.6 — CeoAuthorizationModal.
 *
 * "Decision moment" modal (narrower than the unified creation flow):
 *   - `clamp(400px, 42vw, 520px)` width (focuses the choice)
 *   - violet → fuchsia → cyan gradient CEO hero avatar (springHeavy
 *     scale 0 → 1.1 → 1 entrance, sits above H1)
 *   - 2 always-checked read-only permission rows (it is intentionally
 *     all-or-nothing inside the modal — Settings is where the user
 *     toggles them off after the fact at finer granularity)
 *   - "拒绝" ghost + "永久授权" primary violet, springSnap press feedback
 *   - reduced-motion → 120ms ease-out fallback
 *
 * Trigger note (per 2026-05-11 decision): originally specced as
 * "first dispatch to CEO", but §31 dispatch is deferred. The single
 * live trigger is the user opening Settings → CEO Authorization, so
 * this component is invoked from `/settings`, NOT auto-popped by
 * Simple Mode completion or any dispatch flow.
 */
import { Fragment } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { Check, Crown, X } from 'lucide-react';

import { radius, s, springHeavy, springSnap } from '../../lib/design';

export interface CeoAuthorizationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDark: boolean;
  /**
   * Confirm handler — fired when the user clicks "永久授权". The caller
   * is responsible for the PATCH (so the modal can stay framework-free
   * and re-mount from any future surface).
   */
  onAuthorize: () => void | Promise<void>;
  /**
   * Disables the primary button while the parent persists. The modal
   * doesn't auto-close on confirm; the parent closes once the PATCH
   * resolves so we can also surface a failure inline if needed.
   */
  authorizing?: boolean;
}

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };

const PERMISSIONS = ['在现有 Device 容量内创建新的团队角色', '可派任务给团队中其他 agent'] as const;

export function CeoAuthorizationModal({
  open,
  onOpenChange,
  isDark,
  onAuthorize,
  authorizing,
}: CeoAuthorizationModalProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tHero: Transition = reduce ? REDUCED : springHeavy;
  const tSnap: Transition = reduce ? REDUCED : springSnap;

  // The hero avatar uses an explicit violet → fuchsia → cyan gradient per
  // §2.8.6 — we don't go through avatarGradient() here because that helper
  // picks one of seven palettes based on seed hash, but the spec calls for
  // a single fixed tri-stop. The inline `style.backgroundImage` below is
  // the source of truth.
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <AnimatePresence>
          {open ? (
            <Fragment>
              <DialogPrimitive.Overlay asChild>
                <motion.div
                  data-testid="ceo-auth-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? REDUCED : { duration: 0.2, ease: 'easeOut' }}
                  className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
                />
              </DialogPrimitive.Overlay>

              <DialogPrimitive.Content asChild aria-describedby="ceo-auth-subtitle">
                <div className="fixed inset-0 z-50 grid place-items-center pointer-events-none">
                  <motion.div
                    data-testid="ceo-auth-modal"
                    initial={{ opacity: 0, y: 18, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    transition={tSnap}
                    onClick={(e) => e.stopPropagation()}
                    className={`pointer-events-auto relative flex w-[clamp(400px,42vw,520px)] max-h-[88vh] flex-col overflow-hidden border p-6 ${s(
                      theme,
                      'modal',
                    )} ${radius.pane}`}
                  >
                    <DialogPrimitive.Title asChild>
                      <span className="sr-only">授权 CEO 代理你的决策</span>
                    </DialogPrimitive.Title>

                    <DialogPrimitive.Close asChild>
                      <button
                        type="button"
                        aria-label="关闭"
                        data-testid="ceo-auth-close"
                        className={`absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center ${radius.button} ${
                          isDark ? 'text-zinc-400 hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-zinc-100'
                        }`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </DialogPrimitive.Close>

                    {/* Hero CEO avatar — violet → fuchsia → cyan */}
                    <div className="flex flex-col items-center pt-2 pb-1">
                      <motion.div
                        data-testid="ceo-auth-hero"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={tHero}
                        className="relative inline-flex h-16 w-16 items-center justify-center rounded-full text-white shadow-[0_18px_40px_-12px_rgba(124,58,237,0.6)]"
                        style={{
                          backgroundImage: 'linear-gradient(135deg, #8b5cf6 0%, #d946ef 50%, #22d3ee 100%)',
                        }}
                      >
                        <Crown className="h-7 w-7" aria-hidden />
                      </motion.div>

                      <h1
                        className={`mt-4 text-xl font-semibold tracking-tight ${
                          isDark ? 'text-zinc-50' : 'text-zinc-900'
                        }`}
                      >
                        授权 CEO 代理你的决策
                      </h1>
                      <p
                        id="ceo-auth-subtitle"
                        className={`mt-1 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
                      >
                        这是一次性永久设置,你可以随时在 Settings 撤回
                      </p>
                    </div>

                    {/* Permission card — inset surface, both rows always checked + read-only */}
                    <div
                      className={`mt-5 flex flex-col gap-2 border p-3 ${s(theme, 'inset')} ${radius.card}`}
                      role="list"
                      aria-label="授权范围"
                    >
                      {PERMISSIONS.map((label, idx) => (
                        <div
                          key={label}
                          role="listitem"
                          data-testid={`ceo-auth-permission-${idx}`}
                          className="flex items-center gap-3"
                        >
                          <span
                            aria-hidden
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-md border ${
                              isDark
                                ? 'border-violet-400/40 bg-violet-500/20 text-violet-200'
                                : 'border-violet-300 bg-violet-100 text-violet-700'
                            }`}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </span>
                          <span className={`text-sm ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{label}</span>
                        </div>
                      ))}
                    </div>

                    {/* Footer — ghost reject / primary violet authorize */}
                    <div className="mt-6 flex justify-end gap-2">
                      <DialogPrimitive.Close asChild>
                        <motion.button
                          type="button"
                          data-testid="ceo-auth-reject"
                          whileTap={reduce ? undefined : { scale: 0.97 }}
                          transition={tSnap}
                          className={`inline-flex items-center px-4 py-2 text-sm font-medium transition-colors ${radius.button} ${
                            isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
                          }`}
                        >
                          拒绝
                        </motion.button>
                      </DialogPrimitive.Close>
                      <motion.button
                        type="button"
                        data-testid="ceo-auth-authorize"
                        disabled={authorizing}
                        onClick={() => void onAuthorize()}
                        whileTap={reduce || authorizing ? undefined : { scale: 0.97 }}
                        transition={tSnap}
                        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white transition-opacity ${radius.button} ${
                          authorizing ? 'cursor-not-allowed opacity-70' : ''
                        }`}
                        style={{
                          backgroundImage: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d946ef 100%)',
                          boxShadow: '0 12px 24px -10px rgba(124, 58, 237, 0.55)',
                        }}
                      >
                        {authorizing ? '授权中...' : '永久授权'}
                      </motion.button>
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

export default CeoAuthorizationModal;
