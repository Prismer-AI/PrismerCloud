'use client';

/**
 * Session links — release201/08 §3.0, release201/13 §3.3 (S22).
 *
 * Four contextual IMConversations bound to a single skill lifecycle:
 *   business / dev / test / review.
 * IDs live in `IMSkill.metadata.sessions.{business,dev,test,review}`.
 * Each link jumps to the workspace chat surface scoped to that conversation.
 */

import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { useI18n } from '@/contexts/i18n-context';
import type { SkillDetail } from '../types';

interface SessionLinksProps {
  isDark: boolean;
  skill: SkillDetail | null;
}

const ROLES = [
  {
    key: 'business',
    labelKey: 'evolution.studio.lifecycle.sessions.business',
    descKey: 'evolution.studio.lifecycle.sessions.businessDesc',
  },
  {
    key: 'dev',
    labelKey: 'evolution.studio.lifecycle.sessions.dev',
    descKey: 'evolution.studio.lifecycle.sessions.devDesc',
  },
  {
    key: 'test',
    labelKey: 'evolution.studio.lifecycle.sessions.test',
    descKey: 'evolution.studio.lifecycle.sessions.testDesc',
  },
  {
    key: 'review',
    labelKey: 'evolution.studio.lifecycle.sessions.review',
    descKey: 'evolution.studio.lifecycle.sessions.reviewDesc',
  },
] as const;

export function SessionLinks({ isDark, skill }: SessionLinksProps) {
  const { t } = useI18n();
  if (!skill) return null;
  const sessions = skill.metadata?.sessions ?? {};
  return (
    <section
      data-testid="lifecycle-session-links"
      className={`rounded-2xl border p-4 ${
        isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-zinc-200 bg-white'
      }`}
    >
      <h4
        className={`mb-3 text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}
      >
        {t('evolution.studio.lifecycle.sessions.title')}
      </h4>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ROLES.map((role) => {
          const convId = sessions[role.key];
          return (
            <li
              key={role.key}
              data-session-role={role.key}
              className={`rounded-lg border p-2 ${
                isDark ? 'border-white/[0.04] bg-white/[0.02]' : 'border-zinc-200 bg-zinc-50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                  {t(role.labelKey)}
                </span>
                {convId ? (
                  <Link
                    href={`/workspace?conversationId=${encodeURIComponent(convId)}`}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${
                      isDark
                        ? 'bg-violet-500/20 text-violet-200 hover:bg-violet-500/30'
                        : 'bg-violet-50 text-violet-700 hover:bg-violet-100'
                    }`}
                  >
                    <MessageSquare className="h-3 w-3" />
                    {t('common.open')}
                  </Link>
                ) : (
                  <span className={`text-[10px] italic ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {t('evolution.studio.lifecycle.sessions.notStarted')}
                  </span>
                )}
              </div>
              <p className={`mt-1 text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{t(role.descKey)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
