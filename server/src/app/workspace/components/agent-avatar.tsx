/**
 * `AgentAvatar` — unified agent avatar that replaces ad-hoc `<Bot />` /
 * gradient-circle JSX scattered across the workspace surfaces.
 *
 * Why a wrapper here (vs the existing inline Avatar in im-channel.tsx)?
 *   The inline Avatar in im-channel renders just gradient + role-icon —
 *   no status ring, no popover, no hover affordance. Every surface that
 *   wants the "agent has work in flight" affordance was either rolling
 *   its own pulse (AgentWorkingIndicator) or duplicating the gradient
 *   logic. AgentAvatar collapses all three concerns:
 *
 *     1. Visual: gradient + role-aware icon (drops generic Bot)
 *     2. Status: outer ring + dot keyed off `AgentLiveStatus.kind`
 *     3. Behaviour: optional AgentStatusPopover trigger on hover/focus
 *
 *   Callsites pick which slots they want via props. Sites that don't
 *   have status info yet pass `status={null}` — the avatar still
 *   renders cleanly (gradient + role icon, no ring, no popover).
 *
 * Not a drop-in for `RuntimeAgentAvatar` in runtime-manager.tsx — that
 * component does its own dense layout work (action chips, status dot,
 * expanded vs collapsed shape). It already wraps in
 * `AgentWorkingIndicator`; the only swap needed there is replacing its
 * internal `TerminalSquare`/initials fallback with the role icon, which
 * we do inline rather than forcing a wholesale refactor.
 */

'use client';

import type { ReactNode } from 'react';

import type { AgentDTO } from '../lib/types';
import type { AgentLiveStatus, AgentStatusKind } from '../lib/agent-status';
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import { avatarGradient, avatarInitials } from '../lib/design';
import { AgentStatusPopover } from './agent-status-popover';

export type AgentAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

interface SizePreset {
  /** Outer square dimension (px). */
  box: string;
  /** Icon dimension (Tailwind units). */
  icon: string;
  /** Text size for fallback initials. */
  text: string;
  /** Border radius (Tailwind unit). */
  radius: string;
}

const SIZE_PRESETS: Record<AgentAvatarSize, SizePreset> = {
  xs: { box: 'h-6 w-6', icon: 'h-3 w-3', text: 'text-[9px]', radius: 'rounded-lg' },
  sm: { box: 'h-7 w-7', icon: 'h-3.5 w-3.5', text: 'text-[10px]', radius: 'rounded-xl' },
  md: { box: 'h-10 w-10', icon: 'h-4 w-4', text: 'text-xs', radius: 'rounded-2xl' },
  lg: { box: 'h-14 w-14', icon: 'h-5 w-5', text: 'text-sm', radius: 'rounded-2xl' },
};

const RING_TINT: Record<AgentStatusKind, string> = {
  working: 'ring-emerald-400/70',
  waiting: 'ring-amber-400/70',
  stuck: 'ring-rose-400/70',
  idle: 'ring-transparent',
  offline: 'ring-zinc-500/40',
};

const DOT_TINT: Record<AgentStatusKind, string> = {
  working: 'bg-emerald-400',
  waiting: 'bg-amber-400',
  stuck: 'bg-rose-400',
  idle: 'bg-transparent',
  offline: 'bg-zinc-500',
};

export interface AgentAvatarProps {
  /** Agent metadata — provides display name, role slug, and stable seed. */
  agent?: Pick<AgentDTO, 'agentId' | 'userId' | 'name' | 'agentType' | 'username'> | null;
  /** Fallback when no AgentDTO is available (e.g. message sender by id only). */
  fallback?: {
    seed: string;
    label: string;
    roleSlug?: string | null;
    /**
     * The agent's ASCII username (`ceo` / `engineer` / `marketer`) and/or
     * `@handle`. This is the RELIABLE role-icon source — `agentType` is often a
     * generic tier (`orchestrator` / `specialist`) that doesn't map to a role
     * icon, and localized display names (工程师) never match. Pass username/
     * handle so every surface resolves the same icon (release202/09 avatar
     * consistency fix).
     */
    username?: string | null;
    handle?: string | null;
    /** Uploaded/custom avatar image — rendered over the gradient when set. */
    avatarUrl?: string | null;
  };
  /**
   * Uploaded/custom avatar image URL. When present (and it loads), it covers
   * the gradient + role icon. On load error it falls back gracefully to the
   * role icon / initials underneath. Top-level convenience for `agent`-less
   * callers; `fallback.avatarUrl` works too.
   */
  avatarUrl?: string | null;
  /** Live status — when omitted, no ring is drawn and no popover is mounted. */
  status?: AgentLiveStatus | null;
  size?: AgentAvatarSize;
  isDark: boolean;
  /** Forces the ring on/off independently of status presence (default: auto). */
  showStatusRing?: boolean;
  /** Disables the hover popover even when status is present. */
  disablePopover?: boolean;
  onClick?: () => void;
  className?: string;
  /** Extra slot rendered on top of the avatar — e.g. a small badge. */
  overlay?: ReactNode;
}

export function AgentAvatar({
  agent,
  fallback,
  avatarUrl,
  status,
  size = 'sm',
  isDark,
  showStatusRing,
  disablePopover = false,
  onClick,
  className = '',
  overlay,
}: AgentAvatarProps) {
  const preset = SIZE_PRESETS[size];
  const seed = agent?.userId || agent?.agentId || fallback?.seed || 'unknown';
  const label = agent?.name || fallback?.label || 'Agent';
  const grad = avatarGradient(seed);
  // 2026-05-24 — role-icon fallback chain. agentType is the canonical role
  // slug but is sometimes a generic value like "agent" (not a role) or
  // simply null on simple-create / legacy rows. Pass an ordered candidate
  // list — getAgentRoleIcon walks until one resolves before falling back
  // to Bot. Name handles "CEO" / "Engineer" displays; username catches
  // backend slugs like "ceo-abc123".
  const roleSlug = agent?.agentType ?? fallback?.roleSlug ?? null;
  // Resolve the role icon from the FULL identity chain, username-first. username
  // (ceo/engineer/marketer) is the reliable role slug; agentType is often a
  // generic tier (orchestrator/specialist → no icon) and localized names never
  // match — putting them last means a real username always wins. This is what
  // keeps the icon identical across contacts list / session chip / member
  // popover / message avatar (they previously fed different single fields).
  const RoleIcon = getAgentRoleIcon([
    agent?.username,
    fallback?.username,
    fallback?.handle ? fallback.handle.replace(/^@/, '') : null,
    agent?.name,
    fallback?.label,
    agent?.agentType,
    fallback?.roleSlug,
  ]);
  const resolvedAvatarUrl = avatarUrl ?? fallback?.avatarUrl ?? null;

  const shouldRing = showStatusRing ?? (status != null && status.kind !== 'idle');
  const ringClass = shouldRing && status ? `ring-2 ${RING_TINT[status.kind]}` : '';
  const pulseClass =
    status?.kind === 'working' || status?.kind === 'waiting' ? 'animate-pulse' : '';

  const avatarNode = (
    <span
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      style={{ background: `linear-gradient(135deg, ${grad.from}, ${grad.to})` }}
      title={label}
      data-testid={`agent-avatar-${seed}`}
      data-status-kind={status?.kind ?? 'unknown'}
      className={`relative inline-flex shrink-0 items-center justify-center text-white font-bold shadow-sm transition-transform ${preset.box} ${preset.radius} ${preset.text} ${ringClass} ${pulseClass} ${onClick ? 'cursor-pointer hover:scale-[1.04]' : ''} ${className}`}
    >
      {RoleIcon ? <RoleIcon className={preset.icon} /> : avatarInitials(label)}
      {resolvedAvatarUrl ? (
        // Custom/uploaded avatar covers the gradient + role icon. On load
        // failure it hides itself (display:none), revealing the fallback
        // underneath — no React state needed.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolvedAvatarUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
          className={`absolute inset-0 h-full w-full object-cover ${preset.radius}`}
        />
      ) : null}
      {status && status.kind === 'offline' ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-zinc-900 ${DOT_TINT.offline}`}
        />
      ) : status && status.kind === 'stuck' ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-2 w-2`}
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT_TINT.stuck}`} />
        </span>
      ) : null}
      {overlay}
    </span>
  );

  if (!status || disablePopover) return avatarNode;

  return (
    <AgentStatusPopover
      agentName={label}
      roleSlug={roleSlug}
      status={status}
      isDark={isDark}
    >
      {avatarNode}
    </AgentStatusPopover>
  );
}
