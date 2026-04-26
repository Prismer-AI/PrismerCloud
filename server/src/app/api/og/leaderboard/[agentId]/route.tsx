/**
 * GET /api/og/leaderboard/:agentId — OG Image for Agent Evolution Share Card
 *
 * Generates a 1200x630 PNG for social sharing. Shows agent rank, ERR,
 * session count, domain badge, and Prismer branding.
 *
 * Uses Next.js ImageResponse (Edge runtime).
 */

import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const period = request.nextUrl.searchParams.get('period') || 'weekly';

  // Fetch agent's leaderboard data
  let agentName = agentId;
  let rank = 0;
  let err: number | null = null;
  let sessionCount = 0;
  let domain = 'general';
  let successRate: number | null = null;

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://prismer.cloud';
    const res = await fetch(`${baseUrl}/api/im/evolution/leaderboard/agents?period=${period}&limit=100`);
    if (res.ok) {
      const json = await res.json();
      const agents = json.data?.agents || [];
      const agent = agents.find((a: any) => a.agentId === agentId);
      if (agent) {
        agentName = agent.agentName || agentId;
        rank = agent.rank;
        err = agent.err;
        sessionCount = agent.sessionCount;
        domain = agent.domain;
        successRate = agent.successRate;
      }
    }
  } catch {
    // Use defaults
  }

  const errText = err !== null ? `${err > 0 ? '+' : ''}${Math.round(err * 100)}%` : 'Building...';
  const errColor = err !== null && err > 0 ? '#34d399' : err !== null && err < 0 ? '#f87171' : '#a1a1aa';
  const periodLabel = period === 'weekly' ? 'This Week' : period === 'monthly' ? 'This Month' : 'All Time';
  const domainLabel = domain.charAt(0).toUpperCase() + domain.slice(1);

  return new ImageResponse(
    <div
      style={{
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: '#0a0a0a',
        color: '#fafafa',
        fontFamily: 'system-ui, sans-serif',
        padding: '48px 56px',
      }}
    >
      {/* Top: Rank badge + period */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: 'linear-gradient(135deg, #7c3aed22, #7c3aed11)',
            border: '1px solid #7c3aed44',
            borderRadius: '12px',
            padding: '8px 20px',
          }}
        >
          <span style={{ fontSize: '20px' }}>🏆</span>
          <span style={{ fontSize: '22px', fontWeight: 700, color: '#c4b5fd' }}>
            #{rank || '?'} in {domainLabel} Agents
          </span>
        </div>
        <span style={{ fontSize: '16px', color: '#71717a' }}>{periodLabel}</span>
      </div>

      {/* Middle: Agent name + ERR */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, justifyContent: 'center' }}>
        <div style={{ fontSize: '48px', fontWeight: 800, lineHeight: 1.1, maxWidth: '800px' }}>
          {agentName.length > 30 ? agentName.slice(0, 30) + '...' : agentName}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px' }}>
          <span style={{ fontSize: '72px', fontWeight: 900, color: errColor, lineHeight: 1 }}>{errText}</span>
          <span style={{ fontSize: '24px', color: '#71717a' }}>improvement (ERR)</span>
        </div>
      </div>

      {/* Bottom: Stats row + branding */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: '40px' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '28px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {sessionCount}
            </span>
            <span style={{ fontSize: '14px', color: '#71717a' }}>sessions</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '28px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {successRate !== null ? `${Math.round(successRate * 100)}%` : '...'}
            </span>
            <span style={{ fontSize: '14px', color: '#71717a' }}>success rate</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span
              style={{
                fontSize: '14px',
                padding: '4px 12px',
                borderRadius: '6px',
                background: '#27272a',
                color: '#a1a1aa',
                fontWeight: 600,
              }}
            >
              {domainLabel}
            </span>
            <span style={{ fontSize: '14px', color: '#71717a', marginTop: '4px' }}>domain</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '14px', color: '#52525b' }}>Powered by</span>
          <span style={{ fontSize: '18px', fontWeight: 700, color: '#a78bfa' }}>Prismer Evolution</span>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
    },
  );
}
