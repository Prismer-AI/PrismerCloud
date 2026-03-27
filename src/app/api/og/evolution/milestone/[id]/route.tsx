/**
 * GET /api/og/evolution/milestone/:id — OG Image for Evolution Milestones
 *
 * Generates a 1200x630 PNG image for social sharing.
 * Uses Next.js ImageResponse (Edge runtime).
 */

import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Fetch gene detail from API
  let title = 'Evolution Milestone';
  let subtitle = '';
  let successRate = 0;
  let totalRuns = 0;
  let agentCount = 0;
  let category = 'evolution';

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://prismer.cloud';
    const res = await fetch(`${baseUrl}/api/im/evolution/public/genes/${id}`);
    if (res.ok) {
      const data = await res.json();
      const gene = data.data;
      if (gene) {
        title = gene.title || 'Evolution Gene';
        subtitle = gene.description || '';
        totalRuns = (gene.success_count || 0) + (gene.failure_count || 0);
        successRate = totalRuns > 0 ? Math.round((gene.success_count / totalRuns) * 100) : 0;
        agentCount = gene.used_by_count || 0;
        category = gene.category || 'evolution';
      }
    }
  } catch {
    // Use defaults
  }

  const catColor = category === 'repair' ? '#f97316' : category === 'optimize' ? '#06b6d4' : '#8b5cf6';
  const rateColor = successRate >= 70 ? '#22c55e' : successRate >= 40 ? '#eab308' : '#ef4444';

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          background: 'linear-gradient(135deg, #0a0a0a 0%, #18181b 50%, #0a0a0a 100%)',
          fontFamily: 'system-ui, sans-serif',
          padding: '60px',
        }}
      >
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <div style={{ fontSize: '16px', color: '#a1a1aa', letterSpacing: '0.1em', textTransform: 'uppercase' as const, fontWeight: 700 }}>
            Prismer Evolution
          </div>
          <div style={{ width: '1px', height: '16px', background: '#3f3f46' }} />
          <div style={{ fontSize: '14px', color: catColor, fontWeight: 600, textTransform: 'uppercase' as const }}>
            {category}
          </div>
        </div>

        {/* Title */}
        <div style={{ fontSize: '48px', fontWeight: 800, color: '#fafafa', textAlign: 'center' as const, lineHeight: 1.2, maxWidth: '900px', marginBottom: '16px' }}>
          🧬 {title}
        </div>

        {/* Subtitle */}
        {subtitle && (
          <div style={{ fontSize: '20px', color: '#71717a', textAlign: 'center' as const, maxWidth: '700px', marginBottom: '40px', lineHeight: 1.5 }}>
            {subtitle.slice(0, 120)}{subtitle.length > 120 ? '...' : ''}
          </div>
        )}

        {/* Stats row */}
        <div style={{ display: 'flex', gap: '40px', alignItems: 'center' }}>
          {/* Success rate */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '42px', fontWeight: 800, color: rateColor }}>
              {successRate}%
            </div>
            <div style={{ fontSize: '14px', color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
              Success Rate
            </div>
          </div>

          <div style={{ width: '1px', height: '60px', background: '#27272a' }} />

          {/* Total runs */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '42px', fontWeight: 800, color: '#fafafa' }}>
              {totalRuns.toLocaleString()}
            </div>
            <div style={{ fontSize: '14px', color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
              Executions
            </div>
          </div>

          <div style={{ width: '1px', height: '60px', background: '#27272a' }} />

          {/* Agents */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '42px', fontWeight: 800, color: '#fafafa' }}>
              {agentCount}
            </div>
            <div style={{ fontSize: '14px', color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
              Agents
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ position: 'absolute', bottom: '30px', fontSize: '14px', color: '#3f3f46' }}>
          prismer.cloud/evolution
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
