'use client';

/**
 * /embed/gene/:slug — Embeddable Gene Widget
 *
 * Lightweight page designed to be used in iframes.
 * Shows real-time gene stats: success rate, executions, agents.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface GeneData {
  gene_id?: string;
  id?: string;
  title?: string;
  category?: string;
  description?: string;
  success_count: number;
  failure_count: number;
  used_by_count?: number;
}

export default function GeneEmbedPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [gene, setGene] = useState<GeneData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/im/evolution/public/genes/${slug}`)
      .then(r => r.json())
      .then(d => setGene(d.data || null))
      .catch(() => setGene(null))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 20, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: '#71717a' }}>Loading...</div>
      </div>
    );
  }

  if (!gene) {
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 20, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: '#71717a' }}>Gene not found</div>
      </div>
    );
  }

  const total = gene.success_count + gene.failure_count;
  const rate = total > 0 ? Math.round((gene.success_count / total) * 100) : 0;
  const catColor = gene.category === 'repair' ? '#f97316' : gene.category === 'optimize' ? '#06b6d4' : '#8b5cf6';
  const rateColor = rate >= 70 ? '#22c55e' : rate >= 40 ? '#eab308' : '#ef4444';

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#fafafa', padding: 16, minHeight: '100vh' }}>
      <div style={{ maxWidth: 380, margin: '0 auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: 16, background: 'rgba(255,255,255,0.03)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: catColor, background: `${catColor}15`, padding: '2px 8px', borderRadius: 4 }}>
            {gene.category}
          </span>
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', lineHeight: 1.3 }}>
          🧬 {gene.title || 'Untitled'}
        </h2>
        {gene.description && (
          <p style={{ fontSize: 12, color: '#a1a1aa', margin: '0 0 12px', lineHeight: 1.5 }}>
            {gene.description.slice(0, 100)}{gene.description.length > 100 ? '...' : ''}
          </p>
        )}

        {/* Stats */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: rateColor }}>{rate}%</div>
            <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase' }}>Success</div>
          </div>
          <div style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{total.toLocaleString()}</div>
            <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase' }}>Runs</div>
          </div>
          <div style={{ textAlign: 'center', flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{gene.used_by_count || 0}</div>
            <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase' }}>Agents</div>
          </div>
        </div>

        {/* Success bar */}
        {total > 0 && (
          <div style={{ height: 4, borderRadius: 2, background: '#27272a', marginBottom: 12, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 2, background: rateColor, width: `${rate}%` }} />
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <a
            href="/evolution"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 10, color: '#3f3f46', textDecoration: 'none' }}
          >
            Powered by Prismer
          </a>
          <a
            href="/evolution"
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
