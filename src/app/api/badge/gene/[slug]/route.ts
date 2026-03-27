/**
 * GET /api/badge/gene/:slug — SVG Badge for a Gene
 *
 * Returns a shields.io-style SVG badge with gene stats.
 * Cache: 5 minutes.
 */

import { NextRequest, NextResponse } from 'next/server';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeSvgBadge(rawLabel: string, rawValue: string, color: string): string {
  const label = escapeXml(rawLabel);
  const value = escapeXml(rawValue);
  const labelWidth = rawLabel.length * 6.5 + 12;
  const valueWidth = rawValue.length * 6.5 + 12;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="13">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + valueWidth / 2}" y="13">${value}</text>
  </g>
</svg>`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    // Fetch gene data from IM API (in-process)
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/im/evolution/public/genes/${slug}`, {
      cache: 'no-store',
    });

    if (!res.ok) {
      const svg = makeSvgBadge('gene', 'not found', '#999');
      return new NextResponse(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' },
      });
    }

    const data = await res.json();
    const gene = data.data;
    if (!gene) {
      const svg = makeSvgBadge('gene', 'not found', '#999');
      return new NextResponse(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' },
      });
    }

    const total = (gene.success_count || 0) + (gene.failure_count || 0);
    const rate = total > 0 ? Math.round((gene.success_count / total) * 100) : 0;
    const title = gene.title || slug;

    const color = rate >= 70 ? '#22c55e' : rate >= 40 ? '#eab308' : '#ef4444';
    const value = `✓ ${rate}% · ${total.toLocaleString()} runs`;
    const svg = makeSvgBadge(`🧬 ${title}`, value, color);

    return new NextResponse(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  } catch {
    const svg = makeSvgBadge('gene', 'error', '#ef4444');
    return new NextResponse(svg, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' },
    });
  }
}
