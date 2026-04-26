'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Save, Trash2 } from 'lucide-react';
import { glass, timeAgo } from '../helpers';
import { spring } from './shared';
import { HeroKpi } from './hero-kpi';
import { PersonalitySlider } from './personality-slider';
import type { WorkspaceView } from '@/types/workspace';

interface ProfileTabProps {
  view: WorkspaceView;
  isDark: boolean;
}

export function ProfileTab({ view, isDark }: ProfileTabProps) {
  const identity = view.identity;
  const personality = view.personality;
  const credits = view.credits;
  const catalog = view.catalog || [];

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={spring}
      className="space-y-6"
    >
      {/* Identity Card */}
      {identity && <IdentityCard identity={identity} isDark={isDark} />}

      {/* Personality */}
      {personality && <PersonalitySection personality={personality} isDark={isDark} />}

      {/* Credits */}
      {credits && <CreditsSection credits={credits} isDark={isDark} />}

      {/* Installed Skills */}
      {catalog.length > 0 && <CatalogSection catalog={catalog} isDark={isDark} />}
    </motion.div>
  );
}

// ── Identity ──────────────────────────────────────────────

function IdentityCard({ identity, isDark }: { identity: NonNullable<WorkspaceView['identity']>; isDark: boolean }) {
  const statusColor: Record<string, string> = {
    online: 'bg-emerald-500',
    busy: 'bg-yellow-500',
    idle: 'bg-blue-500',
    offline: 'bg-zinc-500',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className={`p-4 rounded-xl flex items-center gap-4 ${glass(isDark, 'subtle')}`}
    >
      <div
        className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${isDark ? 'bg-violet-500/10' : 'bg-violet-50'}`}
      >
        <User className={`w-6 h-6 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className={`text-base font-bold truncate ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {identity.displayName}
          </h3>
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusColor[identity.status] || 'bg-zinc-500'}`} />
          <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{identity.agentType}</span>
        </div>
        {identity.did && (
          <p className={`text-[11px] font-mono truncate ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`}>
            {identity.did}
          </p>
        )}
        {identity.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {identity.capabilities.slice(0, 8).map((cap) => (
              <span
                key={cap}
                className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-600'}`}
              >
                {cap}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Personality ───────────────────────────────────────────

function PersonalitySection({
  personality,
  isDark,
}: {
  personality: NonNullable<WorkspaceView['personality']>;
  isDark: boolean;
}) {
  const [editingSoul, setEditingSoul] = useState(false);
  const [soulDraft, setSoulDraft] = useState(personality.soul || '');

  async function saveSoul() {
    try {
      const token = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
      if (!token) return;
      await fetch('/api/im/memory/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: 'SOUL.md', content: soulDraft, memoryType: 'soul' }),
      });
      setEditingSoul(false);
    } catch {
      // silent
    }
  }

  return (
    <div>
      <h3
        className={`text-[11px] font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      >
        Personality
      </h3>
      <div className="space-y-3">
        <PersonalitySlider label="Rigor" value={Math.round(personality.rigor * 100)} isDark={isDark} />
        <PersonalitySlider label="Creativity" value={Math.round(personality.creativity * 100)} isDark={isDark} />
        <PersonalitySlider
          label="Risk Tolerance"
          value={Math.round(personality.risk_tolerance * 100)}
          isDark={isDark}
        />
      </div>

      {/* Soul */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-xs font-medium ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Soul</span>
          {!editingSoul && (
            <button
              onClick={() => {
                setSoulDraft(personality.soul || '');
                setEditingSoul(true);
              }}
              className={`text-xs px-2 py-1 rounded-md transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100'}`}
            >
              Edit
            </button>
          )}
        </div>
        {editingSoul ? (
          <div className="space-y-2">
            <textarea
              value={soulDraft}
              onChange={(e) => setSoulDraft(e.target.value)}
              rows={4}
              className={`w-full text-sm rounded-md p-3 resize-y outline-none ${
                isDark
                  ? 'bg-zinc-900 text-zinc-200 border border-white/10'
                  : 'bg-zinc-50 text-zinc-900 border border-zinc-200'
              }`}
            />
            <div className="flex gap-2">
              <button
                onClick={saveSoul}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-600 text-white hover:bg-violet-500 transition-colors"
              >
                <Save className="w-3.5 h-3.5" /> Save
              </button>
              <button
                onClick={() => setEditingSoul(false)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${isDark ? 'text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:bg-zinc-100'}`}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className={`text-sm italic leading-relaxed ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {personality.soul || 'No soul defined yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Credits ───────────────────────────────────────────────

function CreditsSection({ credits, isDark }: { credits: NonNullable<WorkspaceView['credits']>; isDark: boolean }) {
  return (
    <div>
      <h3
        className={`text-[11px] font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      >
        Credits
      </h3>
      <div className="flex gap-6">
        <HeroKpi label="Balance" value={credits.balance} format="currency" hero isDark={isDark} />
        <HeroKpi label="Earned" value={credits.totalEarned} format="currency" isDark={isDark} />
        <HeroKpi label="Spent" value={credits.totalSpent} format="currency" isDark={isDark} />
      </div>
    </div>
  );
}

// ── Catalog ───────────────────────────────────────────────

function CatalogSection({ catalog, isDark }: { catalog: NonNullable<WorkspaceView['catalog']>; isDark: boolean }) {
  return (
    <div>
      <h3
        className={`text-[11px] font-semibold uppercase tracking-wider mb-3 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
      >
        Installed Skills ({catalog.length})
      </h3>
      <div className="space-y-1">
        {catalog.map((skill) => (
          <div
            key={skill.skillId}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-xl ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-zinc-50'} transition-colors`}
          >
            <span className={`text-sm font-medium flex-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {skill.skillName}
            </span>
            {skill.version && (
              <span className={`text-[10px] ${isDark ? 'text-zinc-600' : 'text-zinc-300'}`}>v{skill.version}</span>
            )}
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                skill.status === 'active'
                  ? isDark
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-emerald-50 text-emerald-600'
                  : isDark
                    ? 'bg-zinc-700 text-zinc-400'
                    : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {skill.status}
            </span>
            <button
              className={`text-xs px-2 py-1 rounded-md transition-colors ${isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'}`}
            >
              Uninstall
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
