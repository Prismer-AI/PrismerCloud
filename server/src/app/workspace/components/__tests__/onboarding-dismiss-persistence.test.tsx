/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 F-bug — workspace 引导 dismiss 持久化 (用户原话):
 *
 *   "用户引导应该在 device 为 0 的情况下每次刷新只出现一次,
 *    现在好像不是这个逻辑"
 *
 * 行为契约:
 *   - device=0 + 未 dismiss → 显示
 *   - dismiss → localStorage `prismer_onboarding_dismissed_<workspaceId>` = '1'
 *   - 刷新 (重新挂载) → 同一 workspaceId, dismiss 状态保留, 不再显示
 *   - 切换不同 workspaceId → 重新显示
 *
 * 测试范围: 单独提取出 dismiss + hydrate + scope condition 的行为, 通过
 * 同构于 workspace/page.tsx 的 useState + useEffect + useCallback pattern
 * 的小型 harness 组件验证. 不渲染整个 workspace/page.tsx (太重 + 副作用太多).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  workspaceId: string | null;
  /** 模拟 runtime.devices.length. >0 视为已配 device, 引导应隐藏. */
  devicesCount: number;
  /** 测试挂钩: 接收当前 showOnboarding 状态. */
  onState?: (state: { show: boolean; onboardingDismissed: boolean }) => void;
  /** 测试挂钩: 暴露 dismiss callback 给测试直接触发. */
  dismissRef?: { current: (() => void) | null };
}

/**
 * Mini-reproducer for workspace/page.tsx onboarding-dismiss 持久化逻辑.
 *
 * 复刻三件事 (跟 page.tsx 一致):
 *   1. useState initializer (workspace?.id undefined 时 false)
 *   2. useEffect 在 workspace.id 切换时同步 localStorage
 *   3. dismissOnboardingChecklist 写 localStorage + 更新 state
 *   4. showOnboardingChecklist = !onboardingDismissed && !hasOnlineDevice
 */
function OnboardingHarness({ workspaceId, devicesCount, onState, dismissRef }: HarnessProps) {
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // 同步 page.tsx 的 dismissOnboardingChecklist 实现.
  const dismiss = useCallback(() => {
    setOnboardingDismissed(true);
    if (typeof window !== 'undefined' && workspaceId) {
      try {
        window.localStorage.setItem(`prismer_onboarding_dismissed_${workspaceId}`, '1');
      } catch {
        /* localStorage disabled — session-scoped fallback is fine */
      }
    }
  }, [workspaceId]);

  // 同步 page.tsx 的 hydrate effect.
  useEffect(() => {
    if (!workspaceId) return;
    try {
      const persisted = window.localStorage.getItem(`prismer_onboarding_dismissed_${workspaceId}`);
      setOnboardingDismissed(persisted === '1');
    } catch {
      /* localStorage disabled */
    }
  }, [workspaceId]);

  const hasOnlineDevice = devicesCount > 0;
  const show = !onboardingDismissed && !hasOnlineDevice;

  // 把 dismiss 暴露给测试.
  useEffect(() => {
    if (dismissRef) dismissRef.current = dismiss;
  }, [dismiss, dismissRef]);

  // 每次 render 都汇报当前 state.
  useEffect(() => {
    onState?.({ show, onboardingDismissed });
  });

  return <div data-testid="harness" data-show={show ? '1' : '0'} />;
}

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  cleanup: () => Promise<void>;
}

async function mount(props: HarnessProps): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OnboardingHarness {...props} />);
  });
  // Let the rehydrate effect flush.
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('onboarding dismiss persistence (release201 v2.0.8 F-bug)', () => {
  it('first visit with device=0 shows onboarding', async () => {
    const states: Array<{ show: boolean; onboardingDismissed: boolean }> = [];
    const { host, cleanup } = await mount({
      workspaceId: 'ws-1',
      devicesCount: 0,
      onState: (s) => states.push(s),
    });
    expect(host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('1');
    expect(states.at(-1)?.show).toBe(true);
    expect(states.at(-1)?.onboardingDismissed).toBe(false);
    await cleanup();
  });

  it('dismiss writes localStorage and hides onboarding', async () => {
    const dismissRef = { current: null as (() => void) | null };
    const { host, cleanup } = await mount({
      workspaceId: 'ws-1',
      devicesCount: 0,
      dismissRef,
    });
    expect(host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('1');
    expect(window.localStorage.getItem('prismer_onboarding_dismissed_ws-1')).toBeNull();
    await act(async () => {
      dismissRef.current?.();
    });
    expect(host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('0');
    expect(window.localStorage.getItem('prismer_onboarding_dismissed_ws-1')).toBe('1');
    await cleanup();
  });

  it('refresh (re-mount) after dismiss keeps onboarding hidden', async () => {
    // Mount 1: dismiss → localStorage 写入.
    const dismissRef = { current: null as (() => void) | null };
    const first = await mount({ workspaceId: 'ws-1', devicesCount: 0, dismissRef });
    await act(async () => dismissRef.current?.());
    expect(window.localStorage.getItem('prismer_onboarding_dismissed_ws-1')).toBe('1');
    await first.cleanup();

    // Mount 2: 模拟刷新, 同一 workspaceId. 引导应保持隐藏.
    const second = await mount({ workspaceId: 'ws-1', devicesCount: 0 });
    expect(second.host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('0');
    await second.cleanup();
  });

  it('different workspace id shows onboarding again (per-workspace scope)', async () => {
    // ws-1 上 dismiss 持久化.
    window.localStorage.setItem('prismer_onboarding_dismissed_ws-1', '1');

    // 切到 ws-2 (没在 ws-2 上 dismiss 过) → 引导应重新显示.
    const { host, cleanup } = await mount({ workspaceId: 'ws-2', devicesCount: 0 });
    expect(host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('1');
    // 而且不应该被 ws-1 的状态污染.
    expect(window.localStorage.getItem('prismer_onboarding_dismissed_ws-2')).toBeNull();
    await cleanup();
  });

  it('device>0 hides onboarding even when not dismissed', async () => {
    const { host, cleanup } = await mount({ workspaceId: 'ws-1', devicesCount: 1 });
    expect(host.querySelector('[data-testid="harness"]')?.getAttribute('data-show')).toBe('0');
    await cleanup();
  });
});
