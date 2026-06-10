/**
 * 统一 Agent Message 组件 — 客户端 rollout flag (release201/32 P1 → P2 default-on)。
 *
 * im-channel.tsx 是 client component,读不到 server 端 `FEATURE_FLAGS`
 * (那套走 process.env,仅 server)。所以这里用**客户端可读**的开关。
 *
 * 2026-06-06 (release201/32 P2) — **默认翻 ON**:统一 <AgentMessage> 转正为
 * 默认 chat 渲染路径,旧 (InlineActivityStrip + MessageRow) 仅作显式回退保留。
 * 优先级(高 → 低):
 *
 *   1. URL  `?unifiedMsg=1` / `=0`               (一次性强开 / 强关,最高优先级)
 *   2. localStorage `pc_unified_agent_message` `'1'` / `'0'`  (持久 opt-in / opt-out)
 *   3. env  `NEXT_PUBLIC_FF_UNIFIED_AGENT_MESSAGE`            (默认 ON;`=false` 全局 kill-switch 回退旧路径)
 */

const LS_KEY = 'pc_unified_agent_message';

export function isUnifiedAgentMessageEnabled(): boolean {
  if (typeof window === 'undefined') return false; // SSR：保持旧路径,客户端 effect 翻新,避免 hydration 抖动
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('unifiedMsg');
    if (q === '1' || q === 'true') return true;
    if (q === '0' || q === 'false') return false; // 显式关,压过一切
    const ls = window.localStorage.getItem(LS_KEY);
    if (ls === '1') return true;
    if (ls === '0') return false; // 持久 opt-out 回旧路径
  } catch {
    /* URL/localStorage 不可用时静默回退到 env 默认(ON) */
  }
  // default ON — only an explicit `=false` env kill-switch falls back to legacy.
  return process.env.NEXT_PUBLIC_FF_UNIFIED_AGENT_MESSAGE !== 'false';
}

/** 供 devtools / 控制台手动 opt-in:`pcUnifiedAgentMessage(true)` */
export function setUnifiedAgentMessagePref(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (on) window.localStorage.setItem(LS_KEY, '1');
    else window.localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}
