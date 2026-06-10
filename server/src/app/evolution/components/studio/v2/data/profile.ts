'use client';

/**
 * Evolution Studio v2 — agent-profile client (release201/28).
 *
 * Two responsibilities:
 *   1. READ  identity / personality / credits / workspaces — reuses the
 *      existing `fetchProfile` BFF (`GET /api/im/studio/profile`).
 *   2. WRITE operating principles back onto the agent's adapter-local profile
 *      (`IMAgentProfile.config.operatingPrinciples`).
 *
 * ─── Write surface is INTENTIONALLY narrow (READ before consuming) ───────────
 * ONLY `operatingPrinciples` is writable through this client. personality
 * (rigor / creativity / risk_tolerance), identity (did / agentType / handle)
 * and credits are READ-ONLY here — they are derived/owned elsewhere (agent
 * spec + ledger), so the Profile surface must render them as read-only display
 * and route edits through their own owners. Do NOT add personality/identity
 * writes to this file.
 *
 * The write path is two-step because `PATCH /agent_profiles/:id` REPLACES the
 * whole `config` blob and keys off the profile ROW id (not agentId):
 *   1. GET  /agent_profiles?agentId=&workspaceId=  → resolve the row { id, config, version }
 *   2. PATCH /agent_profiles/:id  body { config: { ...prev, operatingPrinciples }, version }
 * If no profile row exists we THROW so the UI can surface an explicit
 * "no editable profile" degraded state rather than silently dropping the write.
 */

import { authHeader, fetchProfile, getJson } from '../../types';

export { fetchProfile as fetchAgentProfile };

interface AgentProfileRow {
  id: string;
  agentId?: string;
  workspaceId?: string;
  config?: Record<string, unknown>;
  version: number;
}

/**
 * Write `operatingPrinciples` onto an agent's profile row. principles-only —
 * the rest of the config blob is preserved verbatim.
 *
 * @throws when no profile row can be resolved (so the UI degrades explicitly).
 */
export async function updateOperatingPrinciples(
  workspaceId: string,
  agentId: string,
  principles: string[],
): Promise<void> {
  const params = new URLSearchParams();
  params.set('agentId', agentId);
  params.set('workspaceId', workspaceId);
  const rows = await getJson<AgentProfileRow[]>(`/api/im/agent_profiles?${params.toString()}`);
  const row = rows?.[0];
  if (!row || !row.id) {
    throw new Error('No editable agent profile found for this agent in this workspace.');
  }

  const nextConfig = { ...(row.config ?? {}), operatingPrinciples: principles };

  const res = await fetch(`/api/im/agent_profiles/${encodeURIComponent(row.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ config: nextConfig, version: row.version }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const message =
      (typeof data?.error === 'string' ? data.error : data?.error?.message) ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
}
