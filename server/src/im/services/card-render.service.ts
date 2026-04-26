/**
 * Card Render Service — Generates exportable agent/creator card images.
 *
 * Uses satori + @resvg/resvg-js to render cards as PNG.
 * Layout: 1200x630 OG card (dark theme, #09090b background).
 */

import prisma from '../db';

// Dynamic imports to avoid Turbopack bundling issues with native addons
async function getSatori(): Promise<typeof import('satori').default> {
  const mod = await import('satori');
  return mod.default;
}

async function getResvg(): Promise<typeof import('@resvg/resvg-js').Resvg> {
  const mod = await import('@resvg/resvg-js');
  return mod.Resvg;
}

// ── Font cache (module-level singleton) ──────────────────────────

let fontDataCache: ArrayBuffer | null = null;

// Multiple CDN sources for Inter font — fallback chain for environments where gstatic is blocked
const INTER_FONT_URLS = [
  'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff',
  'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/inter-ui/4.0/Inter-Regular.woff2',
];

async function loadInterFont(): Promise<ArrayBuffer> {
  if (fontDataCache) return fontDataCache;

  for (const url of INTER_FONT_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        fontDataCache = await res.arrayBuffer();
        return fontDataCache;
      }
    } catch {
      // try next URL
    }
  }

  throw new Error(`[CardRender] Failed to load Inter font from all ${INTER_FONT_URLS.length} sources`);
}

// ── Input Sanitization ──────────────────────────────────────────

/** Strip control chars, RTL overrides, and limit length for safe card rendering. */
function sanitizeCardText(raw: string, maxLen: number): string {
  // Remove control characters (C0/C1), RTL/LTR overrides, zero-width chars
  const cleaned = raw.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
  return cleaned.slice(0, maxLen);
}

// ── Helpers ──────────────────────────────────────────────────────

function formatMoney(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function formatWeight(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
  return `${kg.toFixed(1)} kg`;
}

function formatHours(h: number): string {
  if (h >= 1000) return `${(h / 1000).toFixed(1)}k`;
  return `${h.toFixed(1)}`;
}

// ── Main export ──────────────────────────────────────────────────

export async function renderAgentCard(agentId: string): Promise<Buffer> {
  // 1. Load font + query data in parallel
  const [fontData, agentCard, user, metrics, achievements] = await Promise.all([
    loadInterFont(),
    prisma.iMAgentCard.findFirst({ where: { imUserId: agentId } }),
    prisma.iMUser.findUnique({ where: { id: agentId } }),
    prisma.iMValueMetrics.findFirst({
      where: { entityType: 'agent', entityId: agentId, period: 'alltime' },
      orderBy: { snapshotDate: 'desc' },
    }),
    prisma.iMEvolutionAchievement.findMany({
      where: { agentId },
      orderBy: { unlockedAt: 'desc' },
      take: 6,
    }),
  ]);

  const displayName = sanitizeCardText(agentCard?.name ?? user?.displayName ?? 'Unknown Agent', 60);
  const username = sanitizeCardText(user?.username ?? 'anonymous', 40);

  const moneySaved = metrics?.moneySaved ?? 0;
  const co2Reduced = metrics?.co2Reduced ?? 0;
  const devHoursSaved = metrics?.devHoursSaved ?? 0;
  const rank = metrics?.rankByValue ?? null;
  const percentile = metrics?.percentile ?? null;

  const badges = achievements.map((a: { badgeKey: string }) => a.badgeKey);

  // 2. Build satori element tree
  const element = {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        background: '#09090b',
        display: 'flex',
        flexDirection: 'column' as const,
        padding: '48px',
        fontFamily: 'Inter',
        color: '#fafafa',
      },
      children: [
        // ── Header row ──────────────────────────────────────
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '24px',
            },
            children: [
              // Avatar circle
              {
                type: 'div',
                props: {
                  style: {
                    width: '80px',
                    height: '80px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '36px',
                    fontWeight: 700,
                    color: '#ffffff',
                    flexShrink: 0,
                  },
                  children: displayName.charAt(0).toUpperCase(),
                },
              },
              // Name + username column
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column' as const,
                    gap: '4px',
                    flex: 1,
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '36px', fontWeight: 700, color: '#fafafa' },
                        children: displayName,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '20px', color: '#a1a1aa' },
                        children: `by @${username}`,
                      },
                    },
                  ],
                },
              },
              // Rank / percentile badge
              ...(rank !== null || percentile !== null
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'column' as const,
                          alignItems: 'flex-end',
                          gap: '4px',
                          flexShrink: 0,
                        },
                        children: [
                          ...(rank !== null
                            ? [
                                {
                                  type: 'div',
                                  props: {
                                    style: {
                                      fontSize: '28px',
                                      fontWeight: 700,
                                      color: '#fbbf24',
                                    },
                                    children: `#${rank}`,
                                  },
                                },
                              ]
                            : []),
                          ...(percentile !== null
                            ? [
                                {
                                  type: 'div',
                                  props: {
                                    style: {
                                      fontSize: '16px',
                                      color: '#a1a1aa',
                                    },
                                    children: `Top ${(100 - percentile).toFixed(0)}%`,
                                  },
                                },
                              ]
                            : []),
                        ],
                      },
                    },
                  ]
                : []),
            ],
          },
        },

        // ── Spacer ──────────────────────────────────────────
        { type: 'div', props: { style: { flex: 1 } } },

        // ── Value metrics row ───────────────────────────────
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              gap: '32px',
              marginTop: '16px',
            },
            children: [
              // Money saved
              metricCard(formatMoney(moneySaved), 'saved', '#10b981'),
              // CO2 reduced
              metricCard(`${formatWeight(co2Reduced)} CO2`, 'reduced', '#3b82f6'),
              // Dev hours saved
              metricCard(`${formatHours(devHoursSaved)} hrs`, 'dev time saved', '#a855f7'),
            ],
          },
        },

        // ── Badge row ───────────────────────────────────────
        ...(badges.length > 0
          ? [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    gap: '12px',
                    marginTop: '32px',
                    flexWrap: 'wrap' as const,
                  },
                  children: badges.map((key: string) => ({
                    type: 'div',
                    props: {
                      style: {
                        padding: '8px 16px',
                        borderRadius: '9999px',
                        background: '#27272a',
                        border: '1px solid #3f3f46',
                        fontSize: '16px',
                        color: '#d4d4d8',
                      },
                      children: key,
                    },
                  })),
                },
              },
            ]
          : []),

        // ── Spacer ──────────────────────────────────────────
        { type: 'div', props: { style: { flex: 1 } } },

        // ── Footer ──────────────────────────────────────────
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              marginTop: '16px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: '18px', color: '#71717a' },
                  children: 'Prismer Evolution Network',
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '18px', color: '#71717a' },
                  children: 'prismer.cloud/evolution',
                },
              },
            ],
          },
        },
      ],
    },
  };

  // 3. Render to SVG via satori (dynamic import for Turbopack compat)
  const satoriRender = await getSatori();
  const svg = await satoriRender(element as any, {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'Inter',
        data: fontData,
        weight: 400,
        style: 'normal' as const,
      },
    ],
  });

  // 4. Convert SVG to PNG at 2x resolution via resvg (dynamic import for Turbopack compat)
  const ResvgCtor = await getResvg();
  const resvg = new ResvgCtor(svg, {
    fitTo: { mode: 'width' as const, value: 2400 },
  });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}

// ── Creator Card ────────────────────────────────────────────────

export async function renderCreatorCard(creatorId: string): Promise<Buffer> {
  const fontData = await loadInterFont();

  // Query creator data
  const [valueMetrics, card, user, genes] = await Promise.all([
    prisma.iMValueMetrics.findFirst({
      where: { entityType: 'creator', entityId: creatorId, period: 'alltime' },
      orderBy: { snapshotDate: 'desc' },
    }),
    prisma.iMAgentCard.findFirst({ where: { imUserId: creatorId } }),
    prisma.iMUser.findFirst({ where: { id: creatorId } }),
    prisma.iMGene.findMany({
      where: { ownerAgentId: creatorId, visibility: 'published' },
      select: { id: true, title: true, successCount: true, failureCount: true, forkCount: true },
      take: 5,
    }),
  ]);

  const name = sanitizeCardText(
    (card as any)?.name || (card as any)?.displayName || (user as any)?.username || creatorId,
    60,
  );
  const username = sanitizeCardText((user as any)?.username || '', 40);
  const moneySaved = valueMetrics?.moneySaved || 0;
  const co2 = valueMetrics?.co2Reduced || 0;
  const agentsHelped = valueMetrics?.agentsHelped || 0;
  const adoptionCount = valueMetrics?.adoptionCount || 0;
  const genesPublished = (genes as any[]).length;
  const rank = valueMetrics?.rankByImpact;
  const percentile = valueMetrics?.percentile;

  // Find top gene by success rate
  const topGene = (genes as any[]).sort((a: any, b: any) => {
    const rateA = a.successCount + a.failureCount > 0 ? a.successCount / (a.successCount + a.failureCount) : 0;
    const rateB = b.successCount + b.failureCount > 0 ? b.successCount / (b.successCount + b.failureCount) : 0;
    return rateB - rateA;
  })[0];

  // Build satori element tree — Creator Card layout per design spec §8.2
  const element = {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        background: '#09090b',
        color: '#fafafa',
        display: 'flex',
        flexDirection: 'column' as const,
        padding: '48px',
        fontFamily: 'Inter',
      },
      children: [
        // Header: Avatar + name + role
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: '56px',
                    height: '56px',
                    borderRadius: '50%',
                    background: 'rgba(139,92,246,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '24px',
                    fontWeight: 700,
                    color: '#a78bfa',
                  },
                  children: name.charAt(0).toUpperCase(),
                },
              },
              {
                type: 'div',
                props: {
                  children: [
                    { type: 'div', props: { style: { fontSize: '24px', fontWeight: 700 }, children: `@${username}` } },
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '13px', color: '#71717a' },
                        children: `Gene Creator${rank ? ` · Rank #${rank} Contributor` : ''}${percentile ? ` · Top ${Math.round(100 - percentile)}%` : ''}`,
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        // Value goldquote — the emotional centerpiece
        {
          type: 'div',
          props: {
            style: {
              borderLeft: '3px solid #8b5cf6',
              paddingLeft: '20px',
              marginBottom: '28px',
              position: 'relative' as const,
              paddingTop: '8px',
              paddingBottom: '8px',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '72px',
                    color: 'rgba(139,92,246,0.15)',
                    position: 'absolute' as const,
                    top: '-20px',
                    left: '20px',
                    lineHeight: '1',
                  },
                  children: '"',
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '20px', color: '#d4d4d8', lineHeight: '1.6', position: 'relative' as const },
                  children: `Your genes saved the network `,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '28px', fontWeight: 700, color: '#22c55e', marginTop: '4px' },
                  children: `$${Math.round(moneySaved).toLocaleString()}`,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: '20px', color: '#d4d4d8', marginTop: '4px' },
                  children: `and reduced ${co2.toFixed(1)} kg of CO2`,
                },
              },
            ],
          },
        },
        // Four stat boxes
        {
          type: 'div',
          props: {
            style: { display: 'flex', gap: '24px', marginBottom: '24px' },
            children: [
              {
                type: 'div',
                props: {
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '32px', fontWeight: 700, color: '#fafafa' },
                        children: `${genesPublished}`,
                      },
                    },
                    {
                      type: 'div',
                      props: { style: { fontSize: '12px', color: '#71717a' }, children: 'Genes Published' },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '32px', fontWeight: 700, color: '#fafafa' },
                        children: `${adoptionCount}`,
                      },
                    },
                    {
                      type: 'div',
                      props: { style: { fontSize: '12px', color: '#71717a' }, children: 'Adopted Times' },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '32px', fontWeight: 700, color: '#fafafa' },
                        children: `${agentsHelped}`,
                      },
                    },
                    {
                      type: 'div',
                      props: { style: { fontSize: '12px', color: '#71717a' }, children: 'Agents Helped' },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { fontSize: '32px', fontWeight: 700, color: '#fafafa' },
                        children: `${valueMetrics?.errorPatterns || 0}`,
                      },
                    },
                    { type: 'div', props: { style: { fontSize: '12px', color: '#71717a' }, children: 'Error Types' } },
                  ],
                },
              },
            ],
          },
        },
        // Top Gene mention
        topGene
          ? {
              type: 'div',
              props: {
                style: { fontSize: '13px', color: '#a1a1aa', marginBottom: '16px' },
                children: `Top Gene: "${topGene.title}" → ${topGene.forkCount || 0} forks, ${topGene.successCount + topGene.failureCount > 0 ? Math.round((topGene.successCount / (topGene.successCount + topGene.failureCount)) * 100) : 0}% success`,
              },
            }
          : null,
        // Footer brand bar
        {
          type: 'div',
          props: {
            style: {
              marginTop: 'auto',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              paddingTop: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: '#52525b',
            },
            children: [
              { type: 'span', props: { children: 'Prismer Evolution Network' } },
              { type: 'span', props: { children: 'prismer.cloud/evolution' } },
            ],
          },
        },
      ].filter(Boolean),
    },
  };

  // Render SVG → PNG (same pattern as renderAgentCard)
  const satoriRender = await getSatori();
  const svg = await satoriRender(element as any, {
    width: 1200,
    height: 630,
    fonts: [{ name: 'Inter', data: fontData, weight: 400, style: 'normal' as const }],
  });
  const ResvgCtor = await getResvg();
  const resvg = new ResvgCtor(svg, { fitTo: { mode: 'width' as const, value: 2400 } });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}

// ── Metric card helper ───────────────────────────────────────────

function metricCard(value: string, label: string, color: string) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column' as const,
        padding: '24px 32px',
        borderRadius: '16px',
        background: '#18181b',
        border: '1px solid #27272a',
        flex: 1,
        gap: '8px',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { fontSize: '32px', fontWeight: 700, color },
            children: value,
          },
        },
        {
          type: 'div',
          props: {
            style: { fontSize: '16px', color: '#a1a1aa' },
            children: label,
          },
        },
      ],
    },
  };
}
