'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, MessageCircle, MoreVertical, Pencil, ShieldOff, User, UserMinus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/contexts/i18n-context';
import { cn } from '@/lib/utils';
import { avatarGradient, avatarInitials, radius } from '../lib/design';
import { CardShelf, type CardLayoutMode } from './card-shelf';
import { getAgentRoleIcon } from '../lib/agent-role-icon';
import type { AgentLiveStatus, AgentStatusKind } from '../lib/agent-status';
import { AgentStatusPopover } from './agent-status-popover';

// Re-exported under the legacy name so existing call sites that import
// `ProfileLayoutMode` keep working unchanged.
export type ProfileLayoutMode = CardLayoutMode;

/**
 * Task 3 — avatar ring tint keyed by live status. Drives the visual signal
 * for "is this agent doing work right now" on the contacts card.
 */
const LIVE_RING_CLASSES: Record<AgentStatusKind, { dark: string; light: string }> = {
  working: {
    dark: 'ring-2 ring-emerald-400/60 shadow-emerald-500/30',
    light: 'ring-2 ring-emerald-400/70 shadow-emerald-500/30',
  },
  waiting: {
    dark: 'ring-2 ring-amber-400/60 shadow-amber-500/30',
    light: 'ring-2 ring-amber-400/70 shadow-amber-500/30',
  },
  stuck: {
    dark: 'ring-2 ring-rose-400/60 shadow-rose-500/30',
    light: 'ring-2 ring-rose-400/70 shadow-rose-500/30',
  },
  idle: { dark: '', light: '' },
  offline: {
    dark: 'ring-1 ring-zinc-500/40 opacity-80',
    light: 'ring-1 ring-zinc-400/50 opacity-80',
  },
};

export interface ProfileCardRecord {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string;
  avatarSeed?: string;
  statusText?: string;
  statusTone?: 'emerald' | 'amber' | 'violet' | 'cyan' | 'slate' | 'rose';
  subtitle?: string;
  description?: string;
  badges?: string[];
  selected?: boolean;
  /**
   * Task 3 — agent role slug (`agentType`). Drives the role-specific
   * KindIcon (Crown / Wrench / Megaphone / …) instead of the generic Bot.
   */
  agentRoleSlug?: string | null;
  /** Task 3 — agent live status. Drives the avatar ring tint. */
  liveStatus?: AgentLiveStatus | null;
  onPrimaryAction?: () => void;
  primaryActionLabel?: string;
  onChat?: () => void;
  onOpenProfile?: () => void;
  onCopyHandle?: () => void;
  onRemark?: (remark: string) => void;
  onRemove?: () => void;
  onBlock?: () => void;
  remark?: string | null;
}

export interface ProfileCardShelfProps {
  isDark: boolean;
  profiles: ProfileCardRecord[];
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /**
   * Pass `layout` for controlled mode — the caller renders the toggle UI
   * elsewhere (e.g. inside a SurfaceHeader actions row) and feeds the
   * current mode down. Omit to let ProfileCardShelf manage state and
   * render its own inline toggle.
   */
  layout?: ProfileLayoutMode;
  defaultLayout?: ProfileLayoutMode;
  availableLayouts?: ProfileLayoutMode[];
  onLayoutChange?: (layout: ProfileLayoutMode) => void;
  onProfileClick?: (profile: ProfileCardRecord) => void;
  className?: string;
}

export function ProfileCardShelf({
  isDark,
  profiles,
  selectedIds,
  onToggleSelected,
  layout,
  defaultLayout = 'list',
  availableLayouts,
  onLayoutChange,
  onProfileClick,
  className,
}: ProfileCardShelfProps) {
  return (
    <CardShelf<ProfileCardRecord>
      isDark={isDark}
      data={profiles}
      getId={(profile) => profile.id}
      selectedIds={selectedIds}
      onToggleSelected={onToggleSelected}
      onItemClick={(profile) => {
        const open = profile.onPrimaryAction ?? (() => onProfileClick?.(profile));
        open();
      }}
      layout={layout}
      defaultLayout={defaultLayout}
      availableLayouts={availableLayouts}
      onLayoutChange={onLayoutChange}
      className={className}
      renderCard={({ item: profile, layout, selected, onToggleSelected: toggle, onPrimaryAction }) => (
        <ProfileCard
          isDark={isDark}
          profile={profile}
          layout={layout}
          selected={selected}
          onToggleSelected={toggle}
          onPrimaryAction={() => {
            const open = profile.onPrimaryAction ?? onPrimaryAction;
            open();
          }}
        />
      )}
    />
  );
}

export function ProfileCard({
  isDark,
  profile,
  layout,
  selected = false,
  onToggleSelected,
  onPrimaryAction,
}: {
  isDark: boolean;
  profile: ProfileCardRecord;
  layout: ProfileLayoutMode;
  selected?: boolean;
  onToggleSelected?: () => void;
  onPrimaryAction?: () => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(profile.remark ?? '');

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const menu = document.querySelector<HTMLElement>(`[data-profile-menu="${profile.id}"]`);
      const button = document.querySelector<HTMLElement>(`[data-profile-menu-button="${profile.id}"]`);
      if (menu?.contains(target) || button?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen, profile.id]);

  const avatarSeed = profile.avatarSeed ?? profile.id;
  const avatar = avatarGradient(avatarSeed);
  const initials = avatarInitials(profile.name || profile.handle || '?');
  const kindLabel = profile.kind === 'agent' ? t('workspace.profile.agent') : t('workspace.profile.human');
  const statusTone = profile.statusTone ?? (profile.kind === 'agent' ? 'violet' : 'cyan');
  const statusToneClass =
    statusTone === 'emerald'
      ? isDark
        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : statusTone === 'amber'
        ? isDark
          ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
          : 'border-amber-200 bg-amber-50 text-amber-700'
        : statusTone === 'rose'
          ? isDark
            ? 'border-rose-400/30 bg-rose-400/10 text-rose-200'
            : 'border-rose-200 bg-rose-50 text-rose-700'
          : statusTone === 'slate'
            ? isDark
              ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300'
              : 'border-zinc-200 bg-zinc-50 text-zinc-600'
            : isDark
              ? 'border-violet-400/30 bg-violet-400/10 text-violet-200'
              : 'border-violet-200 bg-violet-50 text-violet-700';

  const cardClass = layout === 'list' ? 'min-h-[104px]' : layout === 'grid' ? 'min-h-[236px]' : 'min-h-[268px]';

  const badges = [kindLabel, ...(profile.badges ?? []).slice(0, 3)];
  const visibleTags = badges.filter(Boolean);
  // Task 3 — agents render with their role-specific icon (Crown / Wrench /
  // Megaphone / …) instead of the generic Bot. Humans keep the User icon.
  const KindIcon = profile.kind === 'agent' ? getAgentRoleIcon(profile.agentRoleSlug ?? null) : User;
  // Live-status ring (working/waiting/stuck/offline) overrides the legacy
  // statusTone borders when an AgentLiveStatus is present.
  const liveRingClass = profile.liveStatus
    ? LIVE_RING_CLASSES[profile.liveStatus.kind][isDark ? 'dark' : 'light']
    : null;
  const showMenu =
    Boolean(
      profile.onChat ||
      profile.onOpenProfile ||
      profile.onCopyHandle ||
      profile.onRemark ||
      profile.onRemove ||
      profile.onBlock,
    ) && !editingRemark;

  const avatarButton = (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onPrimaryAction?.();
      }}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-2xl border shadow-sm transition-transform hover:scale-[1.02]',
        layout === 'grid' ? 'h-14 w-14' : 'h-12 w-12',
        // Live status ring (working/waiting/stuck/offline) trumps the
        // legacy statusTone tint when present so the contacts row
        // matches the kanban / chat avatars.
        liveRingClass ?? statusToneClass,
        profile.liveStatus?.kind === 'working' || profile.liveStatus?.kind === 'waiting' ? 'animate-pulse' : '',
      )}
      style={{
        background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})`,
      }}
    >
      <span className={cn('font-bold text-white', layout === 'grid' ? 'text-base' : 'text-sm')}>{initials}</span>
      <span
        className={cn(
          'absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border shadow-sm',
          profile.kind === 'agent'
            ? isDark
              ? 'border-zinc-950 bg-violet-500 text-white'
              : 'border-white bg-violet-600 text-white'
            : isDark
              ? 'border-zinc-950 bg-cyan-500 text-white'
              : 'border-white bg-cyan-600 text-white',
        )}
      >
        <KindIcon className="h-3 w-3" />
      </span>
    </button>
  );

  return (
    <article
      data-contact-agent-id={profile.kind === 'agent' ? profile.id : undefined}
      className={cn(
        'relative overflow-visible border bg-white/90 p-4 shadow-[0_16px_50px_-32px_rgba(15,23,42,0.35)] transition-all sm:p-5',
        radius.card,
        cardClass,
        isDark
          ? 'border-white/[0.08] bg-zinc-950/75 text-zinc-100'
          : 'border-zinc-200/80 text-zinc-900 hover:border-zinc-300',
        selected && (isDark ? 'ring-1 ring-violet-300/40' : 'ring-1 ring-violet-300/70'),
      )}
    >
      <div className={cn('flex gap-3', layout === 'grid' ? 'flex-col' : 'items-start')}>
        <div className={cn('flex items-center justify-between gap-2', layout === 'list' && 'contents')}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleSelected?.();
            }}
            title={selected ? t('workspace.profile.deselectProfile') : t('workspace.profile.selectProfile')}
            aria-label={selected ? t('workspace.profile.deselectProfile') : t('workspace.profile.selectProfile')}
            aria-pressed={selected}
            className={cn(
              'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors',
              selected
                ? isDark
                  ? 'border-violet-300/40 bg-violet-400/20 text-violet-100'
                  : 'border-violet-300 bg-violet-100 text-violet-800'
                : isDark
                  ? 'border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:text-zinc-100'
                  : 'border-zinc-200 bg-white text-zinc-400 hover:text-zinc-700',
            )}
          >
            <Check className={cn('h-4 w-4 transition-opacity', selected ? 'opacity-100' : 'opacity-0')} />
          </button>

          {layout === 'grid' ? (
            <div className="ml-auto flex items-center gap-2">
              {profile.statusText ? (
                <Badge
                  variant="outline"
                  className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold', statusToneClass)}
                >
                  {profile.statusText}
                </Badge>
              ) : null}
              {showMenu ? (
                <ProfileMenuButton
                  isDark={isDark}
                  profileId={profile.id}
                  label={t('workspace.profile.actions')}
                  onClick={() => setMenuOpen((value) => !value)}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {profile.kind === 'agent' && profile.liveStatus ? (
          <AgentStatusPopover
            agentName={profile.name}
            roleSlug={profile.agentRoleSlug}
            status={profile.liveStatus}
            isDark={isDark}
          >
            {avatarButton}
          </AgentStatusPopover>
        ) : (
          avatarButton
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className={cn('truncate font-semibold leading-tight', layout === 'grid' ? 'text-lg' : 'text-sm')}>
                  {profile.name}
                </h3>
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    profile.kind === 'agent'
                      ? isDark
                        ? 'border-violet-400/25 bg-violet-400/10 text-violet-200'
                        : 'border-violet-200 bg-violet-50 text-violet-700'
                      : isDark
                        ? 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200'
                        : 'border-cyan-200 bg-cyan-50 text-cyan-700',
                  )}
                >
                  {kindLabel}
                </Badge>
              </div>
              <p className={cn('mt-1 truncate text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                {profile.handle}
              </p>
              {profile.subtitle ? (
                <p className={cn('mt-1 truncate text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                  {profile.subtitle}
                </p>
              ) : null}
            </div>

            {layout !== 'grid' ? (
              <div className="flex shrink-0 items-center gap-2">
                {profile.statusText ? (
                  <Badge
                    variant="outline"
                    className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold', statusToneClass)}
                  >
                    {profile.statusText}
                  </Badge>
                ) : null}
                {showMenu ? (
                  <ProfileMenuButton
                    isDark={isDark}
                    profileId={profile.id}
                    label={t('workspace.profile.actions')}
                    onClick={() => setMenuOpen((value) => !value)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {profile.description ? (
            <p
              className={cn(
                'mt-4 text-sm leading-relaxed',
                isDark ? 'text-zinc-300' : 'text-zinc-700',
                layout === 'list' ? 'line-clamp-1' : 'line-clamp-2',
              )}
            >
              {profile.description}
            </p>
          ) : null}

          {visibleTags.length > 1 ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {visibleTags.slice(1).map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className={cn('rounded-full px-2.5 py-0.5 text-[11px]', isDark ? 'text-zinc-300' : 'text-zinc-700')}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {layout !== 'list' && profile.remark ? (
        <div
          className={cn(
            'mt-3 rounded-xl border px-3 py-2 text-xs',
            isDark ? 'border-white/[0.06] bg-white/[0.03] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700',
          )}
        >
          {profile.remark}
        </div>
      ) : null}

      {editingRemark ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            autoFocus
            value={remarkDraft}
            onChange={(event) => setRemarkDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setEditingRemark(false);
                setRemarkDraft(profile.remark ?? '');
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                profile.onRemark?.(remarkDraft.trim());
                setEditingRemark(false);
              }
            }}
            placeholder={t('workspace.profile.addRemark')}
            className={cn(
              'min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm outline-none focus:ring-1',
              isDark
                ? 'border-white/10 bg-zinc-950 text-zinc-100 focus:ring-violet-500/40'
                : 'border-zinc-300 bg-white text-zinc-900 focus:ring-violet-400',
            )}
          />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              profile.onRemark?.(remarkDraft.trim());
              setEditingRemark(false);
            }}
            className="inline-flex h-9 items-center rounded-xl bg-violet-500 px-3 text-xs font-semibold text-white"
          >
            {t('common.save')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setEditingRemark(false);
              setRemarkDraft(profile.remark ?? '');
            }}
            className={cn(
              'inline-flex h-9 items-center rounded-xl border px-3 text-xs font-semibold',
              isDark ? 'border-white/[0.08] text-zinc-300' : 'border-zinc-200 text-zinc-700',
            )}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : null}

      {menuOpen ? (
        <div
          data-profile-menu={profile.id}
          className={cn(
            'absolute right-3 top-14 z-30 min-w-[180px] overflow-hidden rounded-2xl border p-1 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.35)]',
            isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {profile.onChat ? (
            <ProfileMenuItem
              isDark={isDark}
              icon={<MessageCircle className="h-3.5 w-3.5" />}
              label={t('workspace.profile.chat')}
              onClick={() => {
                setMenuOpen(false);
                profile.onChat?.();
              }}
            />
          ) : null}
          {profile.onOpenProfile ? (
            <ProfileMenuItem
              isDark={isDark}
              icon={<KindIcon className="h-3.5 w-3.5" />}
              label={profile.kind === 'agent' ? t('workspace.profile.openProfile') : t('workspace.profile.openContact')}
              onClick={() => {
                setMenuOpen(false);
                profile.onOpenProfile?.();
              }}
            />
          ) : null}
          {profile.onCopyHandle ? (
            <ProfileMenuItem
              isDark={isDark}
              icon={<Copy className="h-3.5 w-3.5" />}
              label={t('workspace.profile.copyHandle')}
              onClick={() => {
                setMenuOpen(false);
                profile.onCopyHandle?.();
              }}
            />
          ) : null}
          {profile.onRemark ? (
            <ProfileMenuItem
              isDark={isDark}
              icon={<Pencil className="h-3.5 w-3.5" />}
              label={t('workspace.profile.editRemark')}
              onClick={() => {
                setMenuOpen(false);
                setRemarkDraft(profile.remark ?? '');
                setEditingRemark(true);
              }}
            />
          ) : null}
          {profile.onRemove || profile.onBlock ? (
            <div className={cn('my-1 h-px', isDark ? 'bg-white/[0.06]' : 'bg-zinc-200')} />
          ) : null}
          {profile.onRemove ? (
            <ProfileMenuItem
              isDark={isDark}
              danger
              icon={<UserMinus className="h-3.5 w-3.5" />}
              label={t('workspace.profile.remove')}
              onClick={() => {
                setMenuOpen(false);
                profile.onRemove?.();
              }}
            />
          ) : null}
          {profile.onBlock ? (
            <ProfileMenuItem
              isDark={isDark}
              danger
              icon={<ShieldOff className="h-3.5 w-3.5" />}
              label={t('workspace.profile.block')}
              onClick={() => {
                setMenuOpen(false);
                profile.onBlock?.();
              }}
            />
          ) : null}
        </div>
      ) : null}

      {menuOpen ? <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden /> : null}
    </article>
  );
}

function ProfileMenuButton({
  isDark,
  profileId,
  label,
  onClick,
}: {
  isDark: boolean;
  profileId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-profile-menu-button={profileId}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors',
        isDark
          ? 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:text-zinc-100'
          : 'border-zinc-200 bg-white text-zinc-500 hover:text-zinc-900',
      )}
      title={label}
      aria-label={label}
    >
      <MoreVertical className="h-4 w-4" />
    </button>
  );
}

function ProfileMenuItem({
  isDark,
  icon,
  label,
  onClick,
  danger = false,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[11px] font-semibold transition-colors',
        danger
          ? isDark
            ? 'text-rose-200 hover:bg-rose-500/10'
            : 'text-rose-600 hover:bg-rose-50'
          : isDark
            ? 'text-zinc-300 hover:bg-white/[0.05]'
            : 'text-zinc-700 hover:bg-zinc-50',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
