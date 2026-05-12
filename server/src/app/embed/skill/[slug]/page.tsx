'use client';

/**
 * /embed/skill/:slug — Embeddable Skill Widget
 *
 * Lightweight page designed to be used in iframes.
 * Shows skill info: name, category, installs, stars.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface SkillData {
  id: string;
  name: string;
  description: string;
  category: string;
  installs: number;
  stars: number;
  author: string;
  source: string;
  geneId?: string;
}

export default function SkillEmbedPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [skill, setSkill] = useState<SkillData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/im/skills/search?query=${encodeURIComponent(slug)}&limit=5`)
      .then(r => r.json())
      .then(d => {
        const skills = d.data || [];
        const match = skills.find((s: SkillData) => s.id === slug || s.name === slug);
        setSkill(match || skills[0] || null);
      })
      .catch(() => setSkill(null))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 20, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: '#71717a' }}>Loading...</div>
      </div>
    );
  }

  if (!skill) {
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 20, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: '#71717a' }}>Skill not found</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 16, minHeight: '100vh' }}>
      <div style={{ maxWidth: 380, margin: '0 auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: 16, background: 'rgba(255,255,255,0.03)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#a1a1aa', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: 4 }}>
            {skill.category}
          </span>
          {skill.source === 'awesome-openclaw' && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#22c55e', background: 'rgba(34,197,94,0.1)', padding: '2px 8px', borderRadius: 4 }}>
              Verified
            </span>
          )}
          {skill.geneId && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#06b6d4', background: 'rgba(6,182,212,0.1)', padding: '2px 8px', borderRadius: 4 }}>
              Has Gene
            </span>
          )}
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', lineHeight: 1.3 }}>
          ⚡ {skill.name}
        </h2>
        {skill.description && (
          <p style={{ fontSize: 12, color: '#a1a1aa', margin: '0 0 12px', lineHeight: 1.5 }}>
            {skill.description.slice(0, 100)}{skill.description.length > 100 ? '...' : ''}
          </p>
        )}

        {/* Stats */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 14 }}>⭐</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{(skill.stars || 0).toLocaleString()}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 14 }}>↓</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{(skill.installs || 0).toLocaleString()}</span>
            <span style={{ fontSize: 10, color: '#71717a' }}>installs</span>
          </div>
        </div>

        {/* Author */}
        {skill.author && (
          <div style={{ fontSize: 11, color: '#71717a', marginBottom: 12 }}>
            by {skill.author}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 10 }}>
          <a
            href="https://prismer.cloud/evolution"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 10, color: '#3f3f46', textDecoration: 'none' }}
          >
            Powered by Prismer
          </a>
          <a
            href="https://prismer.cloud/evolution"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 10, color: '#8b5cf6', textDecoration: 'none', fontWeight: 600 }}
          >
            View on Prismer →
          </a>
        </div>
      </div>
    </div>
  );
}
