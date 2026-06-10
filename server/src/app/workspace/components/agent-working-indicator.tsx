/**
 * `AgentWorkingIndicator` — wraps an agent avatar with a soft pulse animation
 * + a small emerald ping dot while the agent has a non-terminal task assigned.
 *
 * Why a wrapper (not a prop on Avatar)?
 *   There are three distinct avatar components across the workspace surface
 *   (the inline `Avatar` in `im-channel.tsx`, the `RuntimeAgentAvatar` in
 *   `runtime-manager.tsx`, and any future device-card icon). Passing a
 *   `working` prop into each would force every avatar to duplicate state
 *   subscription. A relative-positioned wrapper around the icon keeps the
 *   styling concern in one place and decouples it from each avatar's visual
 *   contract.
 *
 * Layout safety: the wrapper uses `inline-flex` (matches the inline-block
 * nature of the avatars it decorates) + `relative`, and the ping dot is
 * absolutely positioned at the bottom-right corner — neither affects the
 * sibling layout of the avatar's parent (chat row, agent card, member list).
 *
 * Accessibility: the indicator is purely decorative; the busy semantic is
 * already surfaced through the parent row's status dot / "executing" chip.
 * We mark it `aria-hidden` so screen readers don't announce ambient pulses.
 */

import { useAgentBusyState } from '../lib/agent-busy-state';

export function AgentWorkingIndicator({
  agentImUserId,
  children,
  className,
}: {
  /** imUserId of the agent — `RuntimeAgentDTO.id` or `IMMessage.senderId`. */
  agentImUserId: string | null | undefined;
  children: React.ReactNode;
  /** Optional extra classes applied to the wrapper (e.g. `align-middle`). */
  className?: string;
}) {
  const isWorking = useAgentBusyState(agentImUserId);
  return (
    <span
      data-testid={agentImUserId ? `agent-working-${agentImUserId}` : undefined}
      data-agent-working={isWorking ? 'true' : 'false'}
      className={`relative inline-flex ${isWorking ? 'agent-working-pulse' : ''} ${className ?? ''}`.trim()}
    >
      {children}
      {isWorking ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-2 w-2"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      ) : null}
    </span>
  );
}
