import type { WorkspaceView, WorkspaceSlot } from '@/types/workspace';

// ── Spring constants ──────────────────────────────────────

export const spring = { type: 'spring' as const, stiffness: 300, damping: 30 };
export const gentleSpring = { type: 'spring' as const, stiffness: 200, damping: 25 };
export const counterSpring = { type: 'spring' as const, stiffness: 100, damping: 20 };

// ── Tab types ─────────────────────────────────────────────

export type WorkspaceSubTab = 'progress' | 'memory' | 'profile';

// ── Data fetching ─────────────────────────────────────────

function getToken(): string | null {
  try {
    const platformToken = JSON.parse(localStorage.getItem('prismer_auth') || '{}')?.token;
    if (platformToken) return platformToken;
    return localStorage.getItem('prismer_active_api_key') ?? null;
  } catch {
    return null;
  }
}

export async function fetchWorkspace(
  scope: string,
  slots?: WorkspaceSlot[],
  includeContent?: boolean,
): Promise<WorkspaceView | null> {
  const token = getToken();
  if (!token) return null;
  const params = new URLSearchParams({ scope });
  if (slots) params.set('slots', slots.join(','));
  if (includeContent) params.set('includeContent', 'true');
  try {
    const res = await fetch(`/api/im/workspace?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok ? data.data : null;
  } catch {
    return null;
  }
}

export async function fetchScopes(): Promise<string[]> {
  const token = getToken();
  if (!token) return ['global'];
  try {
    const res = await fetch(`/api/im/evolution/scopes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok && data.data?.length ? data.data : ['global'];
  } catch {
    return ['global'];
  }
}

// ── Origin badge config ───────────────────────────────────

export const ORIGIN_STYLES: Record<string, { label: string; dark: string; light: string }> = {
  from_skill: { label: 'Skill', dark: 'bg-blue-500/15 text-blue-300', light: 'bg-blue-50 text-blue-600' },
  evolved: { label: 'Evolved', dark: 'bg-emerald-500/15 text-emerald-300', light: 'bg-emerald-50 text-emerald-600' },
  forked: { label: 'Forked', dark: 'bg-violet-500/15 text-violet-300', light: 'bg-violet-50 text-violet-600' },
  distilled: { label: 'Distilled', dark: 'bg-amber-500/15 text-amber-300', light: 'bg-amber-50 text-amber-600' },
};

// ── Breaker state config ──────────────────────────────────

export const BREAKER_STYLES: Record<string, { dot: string; label: string }> = {
  closed: { dot: 'bg-emerald-500', label: 'Healthy' },
  open: { dot: 'bg-red-500', label: 'Broken' },
  half_open: { dot: 'bg-yellow-500', label: 'Recovering' },
};
