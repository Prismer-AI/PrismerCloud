'use client';

/**
 * §30 B3.4 — Simple mode Step 3: provisioning loader.
 *
 * Renders a checklist-style progress UI driven by `useSimpleProvisioning()`.
 * Per spec §2.8.4:
 *   - NO progress bar (progress bars suggest linearity; pod cold-start is non-
 *     linear). Checklist + per-row spinner only.
 *   - Loader2 (spin) → Check transition uses scale 0 → 1.2 → 1 springHeavy
 *     overshoot. The overshoot is the "completion satisfaction" — required.
 *   - 200ms dwell floor between steps (enforced by the hook) so completion
 *     never strobes.
 *   - When any step exceeds 3s, the row's caption flips to "正在配置网络...
 *     (稍久)" (progressive disclosure of slowness).
 *   - Failure → red row + explanation + retry / skip (if non-critical) /
 *     cancel buttons. Never spin indefinitely without an out.
 *   - Success → caller (the parent modal) animates a Magic Move handoff to
 *     the new conversation; this component only fires `onSuccess(result)`.
 *
 * a11y: `aria-live="polite"` on the row list so each completion is
 * announced. Each row also carries an `aria-label` summarising its status.
 *
 * Reduced motion: spring durations collapse to a 120ms easeOut. The Loader2
 * spin is preserved (it's not vestibular) but the scale overshoot is
 * replaced by a plain fade.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { ArrowLeft, Check, Loader2, X as XIcon, MinusCircle } from 'lucide-react';

import { radius, s, springHeavy, springSnap, springSoft } from '../../lib/design';
import {
  useSimpleProvisioning,
  type ProvisioningStep,
  type ProvisioningStepStatus,
  type SimpleProvisioningPlan,
  type SimpleProvisioningResult,
  type UseSimpleProvisioningReturn,
} from './use-simple-provisioning';

// ───────────────────────── Public API ─────────────────────────

export interface SimpleStep3LaunchProps {
  isDark: boolean;
  plan: SimpleProvisioningPlan;
  onSuccess: (result: SimpleProvisioningResult) => void;
  onCancel: () => void;
  /**
   * Called when an agent register hits 409 with the "username already taken"
   * phrasing. The shell uses this to drop the user back on Step 2 with
   * `slugErrors[roleSlug]` populated. Task 3.
   */
  onSlugConflict?: (roleSlug: string, message: string) => void;
  /**
   * P3-7 — called when an agent register hits 409 CAPACITY_EXCEEDED. Distinct
   * from slug-conflict because the resolution path is different (upgrade /
   * delete agent, not edit handle). The shell stores it so the inline error
   * region in this component can render the precise (used/max) numbers
   * surfaced by the server.
   */
  onCapacityExceeded?: (used: number, max: number, message: string) => void;
  /** Called when the user clicks "返回上一步" on the slug-conflict CTA. */
  onBack?: () => void;
  /**
   * Optional hoisted provisioning state. When provided, the component uses
   * it instead of calling `useSimpleProvisioning` itself. Task 3 — the
   * modal hoists the hook so back/forward navigation between Step 2 ↔ 3
   * doesn't reset already-registered agent results (which would 409 on
   * themselves on retry).
   */
  provisioning?: UseSimpleProvisioningReturn;
  /** Last slug-conflict (lifted to parent when `provisioning` is provided). */
  slugConflict?: { roleSlug: string; message: string } | null;
  /** P3-7 — last capacity-exceeded (lifted to parent — same reason as slugConflict). */
  capacityError?: { used: number; max: number; message: string } | null;
}

// ───────────────────────── Internals ─────────────────────────

const REDUCED: Transition = { duration: 0.12, ease: 'easeOut' };
const SLOW_THRESHOLD_MS = 3000;

function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stepLabel(step: ProvisioningStep): string {
  switch (step.kind) {
    case 'device':
      return step.reused ? 'Cloud Device 已就绪 (existing)' : 'Cloud Device 已就绪';
    case 'agent':
      return `注册 ${step.agentName}${step.primary ? ' (你)' : ''}`;
    case 'conversation':
      return '创建团队会议室';
    case 'welcome':
      return '发送欢迎消息';
  }
}

function pendingLabel(step: ProvisioningStep): string {
  switch (step.kind) {
    case 'device':
      return '准备 Cloud Device';
    case 'agent':
      return `注册 ${step.agentName}${step.primary ? ' (你)' : ''}`;
    case 'conversation':
      return '创建团队会议室';
    case 'welcome':
      return '发送欢迎消息';
  }
}

// ───────────────────────── Component ─────────────────────────

export function SimpleStep3Launch({
  isDark,
  plan,
  onSuccess,
  onCancel,
  onSlugConflict,
  onCapacityExceeded,
  onBack,
  provisioning,
  slugConflict: hoistedSlugConflict,
  capacityError: hoistedCapacityError,
}: SimpleStep3LaunchProps) {
  const theme = isDark ? 'dark' : 'light';
  const reduce = useReducedMotion() ?? false;
  const tHeavy: Transition = reduce ? REDUCED : springHeavy;
  const tSnap: Transition = reduce ? REDUCED : springSnap;
  const tSoft: Transition = reduce ? REDUCED : springSoft;

  // When the parent hoists the provisioning hook (Task 3 — required for the
  // Step 2 ↔ 3 back-and-forth path so persistent agent results survive),
  // local conflict tracking is also lifted. Falls back to a local hook + local
  // state for the legacy preview harness.
  const [localSlugConflict, setLocalSlugConflict] = useState<{ roleSlug: string; message: string } | null>(null);
  const [localCapacityError, setLocalCapacityError] = useState<{ used: number; max: number; message: string } | null>(
    null,
  );

  const localHook = useSimpleProvisioning(provisioning ? null : plan, {
    onSlugConflict: provisioning
      ? undefined
      : (roleSlug, message) => {
          setLocalSlugConflict({ roleSlug, message });
          onSlugConflict?.(roleSlug, message);
        },
    onCapacityExceeded: provisioning
      ? undefined
      : (used, max, message) => {
          setLocalCapacityError({ used, max, message });
          onCapacityExceeded?.(used, max, message);
        },
  });
  const { steps, currentStepIndex, error, result, retry, skip, cancel, start } = provisioning ?? localHook;
  const slugConflict = provisioning ? (hoistedSlugConflict ?? null) : localSlugConflict;
  const capacityError = provisioning ? (hoistedCapacityError ?? null) : localCapacityError;

  // Clear local conflict state when the user retries / cancels / moves past.
  // setState-in-effect is intentional: syncing a local flag with the hook's
  // error transition (external system). Single hop, no loop risk.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!error && !provisioning) {
      setLocalSlugConflict(null);
      setLocalCapacityError(null);
    }
  }, [error, provisioning]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Start once when mounted.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, [start]);

  // Bubble success up to the parent modal exactly once.
  const successFiredRef = useRef(false);
  useEffect(() => {
    if (result && !successFiredRef.current) {
      successFiredRef.current = true;
      onSuccess(result);
    }
  }, [result, onSuccess]);

  // Rough remaining-time estimate: each pending/running step averages ~2s
  // for fresh provision, ~0.5s for cached. Use 2s as floor — spec says
  // "预计还需要 ~N 秒".
  const etaSeconds = useMemo(() => {
    const remaining = steps.filter((s) => s.status === 'pending' || s.status === 'running').length;
    return remaining * 2;
  }, [steps]);

  const failedStep = error ? steps[error.stepIndex] : null;
  const canSkip = failedStep ? failedStep.kind === 'conversation' || failedStep.kind === 'welcome' : false;

  return (
    <section data-testid="simple-step3-launch" className="flex flex-col gap-5" aria-label="AI 团队正在组装">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className={`text-base font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>AI 团队正在组装</h2>
        {!result && !error ? (
          <p
            data-testid="simple-step3-eta"
            className={`text-xs tabular-nums ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}
          >
            预计还需要 ~{etaSeconds} 秒
          </p>
        ) : null}
        {result ? (
          <p
            data-testid="simple-step3-done"
            className={`text-xs font-medium ${isDark ? 'text-emerald-300' : 'text-emerald-600'}`}
          >
            完成
          </p>
        ) : null}
      </header>

      {/* ── Checklist rows ───────────────────────────────────── */}
      <ol data-testid="simple-step3-list" aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {steps.map((step, idx) => (
          <StepRow
            key={`${step.kind}-${'roleSlug' in step ? step.roleSlug : idx}`}
            step={step}
            index={idx}
            isCurrent={currentStepIndex === idx}
            isDark={isDark}
            cardSurface={s(theme, 'card')}
            tHeavy={tHeavy}
            tSnap={tSnap}
            tSoft={tSoft}
            reduce={reduce}
          />
        ))}
      </ol>

      {/* ── Total elapsed line (faint, low priority) ─────────── */}
      <div
        className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${s(theme, 'inset')} ${
          isDark ? 'text-zinc-400' : 'text-zinc-600'
        }`}
        data-testid="simple-step3-footer"
      >
        <span>
          {steps.filter((s) => s.status === 'done' || s.status === 'skipped').length}/{steps.length} 步
        </span>
        {!error && !result ? <span className="opacity-70">非线性等待 · K8s 冷启不可预测</span> : null}
        {error ? <span className={`font-medium ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>有步骤失败</span> : null}
        {result ? <span className="opacity-70">即将跳转到 {plan.conversationTitle ?? '团队会议'}</span> : null}
      </div>

      {/* ── Failure controls ─────────────────────────────────── */}
      <AnimatePresence initial={false}>
        {error ? (
          <motion.div
            key="failure-controls"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={tSnap}
            data-testid="simple-step3-failure"
            className={`flex flex-col gap-2 rounded-xl border px-3 py-3 ${
              isDark ? 'border-rose-500/30 bg-rose-500/10' : 'border-rose-300 bg-rose-50'
            }`}
            role="alert"
          >
            <p className={`text-sm font-semibold ${isDark ? 'text-rose-100' : 'text-rose-700'}`}>
              {capacityError
                ? `设备容量已满: ${capacityError.used} / ${capacityError.max} agents`
                : `步骤失败:${error.message}`}
            </p>
            {capacityError ? (
              <p
                data-testid="simple-step3-capacity-error"
                className={`text-xs ${isDark ? 'text-rose-200/80' : 'text-rose-700/80'}`}
              >
                当前 Cloud Device 已经在跑 {capacityError.used} 个 agent (上限 {capacityError.max}
                )。要继续需要先到团队管理删 /关一个现有 agent,或加购 / 升级订阅,然后重新打开本对话框。
              </p>
            ) : slugConflict ? (
              <p className={`text-xs ${isDark ? 'text-rose-200/80' : 'text-rose-700/80'}`}>
                @{slugConflict.roleSlug} 的 username 已被占用。请回到上一步修改 @handle 后重试。
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {slugConflict && !capacityError && onBack ? (
                <button
                  type="button"
                  data-testid="simple-step3-back-to-step2"
                  onClick={() => {
                    cancel();
                    onBack();
                  }}
                  className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold ${radius.button} ${
                    isDark
                      ? 'bg-violet-500/90 text-white hover:bg-violet-400'
                      : 'bg-violet-600 text-white hover:bg-violet-500'
                  }`}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回上一步修改
                </button>
              ) : null}
              {/* P3-7 — capacity-exceeded hides retry. The cap won't move
                   without operator action (delete agent / upgrade); retry
                   would just re-fail. The only outs are cancel (close
                   modal) or back-to-Step2 to reduce the agent count and
                   try a fresh provisioning run. */}
              {!capacityError ? (
                <button
                  type="button"
                  data-testid="simple-step3-retry"
                  onClick={retry}
                  className={`inline-flex items-center px-3 py-1.5 text-xs font-semibold ${radius.button} ${
                    slugConflict
                      ? isDark
                        ? 'text-zinc-200 hover:bg-white/[0.08]'
                        : 'text-zinc-700 hover:bg-zinc-100'
                      : isDark
                        ? 'bg-violet-500/90 text-white hover:bg-violet-400'
                        : 'bg-violet-600 text-white hover:bg-violet-500'
                  }`}
                >
                  重试
                </button>
              ) : null}
              {canSkip && !capacityError ? (
                <button
                  type="button"
                  data-testid="simple-step3-skip"
                  onClick={skip}
                  className={`inline-flex items-center px-3 py-1.5 text-xs font-medium ${radius.button} ${
                    isDark ? 'text-zinc-200 hover:bg-white/[0.08]' : 'text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  跳过此步骤
                </button>
              ) : null}
              <button
                type="button"
                data-testid="simple-step3-cancel"
                onClick={() => {
                  cancel();
                  onCancel();
                }}
                className={`inline-flex items-center px-3 py-1.5 text-xs font-medium ${radius.button} ${
                  isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                取消
              </button>
            </div>
            {!canSkip && !slugConflict && !capacityError ? (
              <p className={`text-[11px] ${isDark ? 'text-rose-200/80' : 'text-rose-700/80'}`}>
                此步骤无法跳过(Device 或 Agent 注册是必需的)。请重试或取消。
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

export default SimpleStep3Launch;

// ───────────────────────── Step row ─────────────────────────

interface StepRowProps {
  step: ProvisioningStep;
  index: number;
  isCurrent: boolean;
  isDark: boolean;
  cardSurface: string;
  tHeavy: Transition;
  tSnap: Transition;
  tSoft: Transition;
  reduce: boolean;
}

function StepRow({ step, index, isCurrent, isDark, cardSurface, tHeavy, tSnap, tSoft, reduce }: StepRowProps) {
  const status = step.status;
  const label = status === 'done' ? stepLabel(step) : pendingLabel(step);

  // Slow-step copy: when running > 3s, swap label to "正在配置网络... (稍久)".
  const runStartedAt = useRef<number | null>(null);
  const [isSlow, setIsSlow] = useState(false);

  // Effect synchronizes a timer (external system) to `status`. The setState
  // calls reset the visible "slow" flag when the step starts or finishes —
  // the only place a timer's "elapsed beyond threshold" signal can flow back
  // into React. Linter flags this as cascading but the reset is required;
  // disabling the rule here is intentional and scoped to this hook.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (status === 'running') {
      runStartedAt.current = Date.now();
      setIsSlow(false);
      const t = setTimeout(() => setIsSlow(true), SLOW_THRESHOLD_MS);
      return () => clearTimeout(t);
    }
    runStartedAt.current = null;
    setIsSlow(false);
    return undefined;
  }, [status]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const displayLabel = status === 'running' && isSlow ? '正在配置网络...(稍久)' : label;

  const ariaLabel = `${displayLabel} — ${statusToAria(status)}`;
  const duration = formatDuration(
    step.kind === 'device' || step.kind === 'agent' || step.kind === 'conversation' || step.kind === 'welcome'
      ? step.durationMs
      : undefined,
  );

  return (
    <motion.li
      data-testid={`simple-step3-row-${index}`}
      data-status={status}
      data-current={isCurrent ? 'true' : 'false'}
      aria-label={ariaLabel}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? REDUCED : { ...tSoft, delay: index * 0.04 }}
      className={`flex items-center gap-3 border px-3 py-2.5 text-sm ${radius.card} ${cardSurface} ${
        status === 'failed'
          ? isDark
            ? 'border-rose-400/40'
            : 'border-rose-300'
          : status === 'done'
            ? isDark
              ? 'border-emerald-400/30'
              : 'border-emerald-300/70'
            : ''
      }`}
    >
      <StatusIcon status={status} isDark={isDark} tHeavy={tHeavy} tSnap={tSnap} reduce={reduce} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{displayLabel}</span>
        {status === 'failed' && 'error' in step && step.error ? (
          <span className={`mt-0.5 truncate text-xs ${isDark ? 'text-rose-300' : 'text-rose-600'}`}>{step.error}</span>
        ) : null}
      </span>
      {duration && status === 'done' ? (
        <span className={`shrink-0 text-xs tabular-nums ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
          ({duration})
        </span>
      ) : null}
      {status === 'skipped' ? (
        <span className={`shrink-0 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>已跳过</span>
      ) : null}
      {status === 'cancelled' ? (
        <span className={`shrink-0 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>已取消</span>
      ) : null}
    </motion.li>
  );
}

function statusToAria(status: ProvisioningStepStatus): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'running':
      return '进行中';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'skipped':
      return '已跳过';
    case 'cancelled':
      return '已取消';
  }
}

// ───────────────────────── Status icon ─────────────────────────

function StatusIcon({
  status,
  isDark,
  tHeavy,
  tSnap,
  reduce,
}: {
  status: ProvisioningStepStatus;
  isDark: boolean;
  tHeavy: Transition;
  tSnap: Transition;
  reduce: boolean;
}) {
  // 24×24 surface. AnimatePresence swaps the icon by status key.
  return (
    <span
      aria-hidden
      className={`flex h-6 w-6 shrink-0 items-center justify-center ${radius.chip} ${
        status === 'done'
          ? isDark
            ? 'bg-emerald-500/20 text-emerald-300'
            : 'bg-emerald-100 text-emerald-700'
          : status === 'failed'
            ? isDark
              ? 'bg-rose-500/20 text-rose-300'
              : 'bg-rose-100 text-rose-700'
            : status === 'running'
              ? isDark
                ? 'bg-violet-500/20 text-violet-300'
                : 'bg-violet-100 text-violet-700'
              : status === 'skipped' || status === 'cancelled'
                ? isDark
                  ? 'bg-white/[0.04] text-zinc-500'
                  : 'bg-zinc-100 text-zinc-400'
                : isDark
                  ? 'bg-white/[0.03] text-zinc-500'
                  : 'bg-zinc-50 text-zinc-400'
      }`}
    >
      <AnimatePresence initial={false} mode="wait">
        {status === 'running' ? (
          <motion.span
            key="spin"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            transition={tSnap}
            className="flex items-center justify-center"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </motion.span>
        ) : status === 'done' ? (
          <motion.span
            key="check"
            // The scale 0 → 1.2 → 1 overshoot is the "completion satisfaction"
            // — spec §2.8.4 calls this out explicitly.
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: [0, 1.2, 1] }}
            transition={reduce ? REDUCED : { ...tHeavy, times: [0, 0.6, 1] }}
            className="flex items-center justify-center"
          >
            <Check className="h-3.5 w-3.5" />
          </motion.span>
        ) : status === 'failed' ? (
          <motion.span
            key="fail"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            transition={tSnap}
            className="flex items-center justify-center"
          >
            <XIcon className="h-3.5 w-3.5" />
          </motion.span>
        ) : status === 'skipped' || status === 'cancelled' ? (
          <motion.span
            key="skip"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={tSnap}
            className="flex items-center justify-center"
          >
            <MinusCircle className="h-3.5 w-3.5" />
          </motion.span>
        ) : (
          <motion.span
            key="dot"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={tSnap}
            className="flex items-center justify-center"
          >
            <span className={`h-2 w-2 rounded-full ${isDark ? 'bg-zinc-600' : 'bg-zinc-300'}`} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
