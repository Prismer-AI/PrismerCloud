/**
 * Adapter: API role-template row → AgentRoleTemplate.
 *
 * The legacy ROLE_TEMPLATES (5 hardcoded native templates) carry rich UI
 * metadata (Lucide icon, gradient string, authority bullets) that the
 * imported agency-agents rows don't have. We synthesise reasonable
 * fallbacks so the downstream form (display-name seed, slug seed, system
 * prompt, default adapter) doesn't have to branch on origin.
 *
 * Anything we don't have a strong default for becomes a neutral filler;
 * the user can still override every field in the form.
 */

import { Bot } from 'lucide-react';

import type { AgentRoleTemplate } from '../../../lib/templates';
import type { RoleTemplateBrowserItem } from '../template-browser/types';

const FALLBACK_GRADIENT = 'from-violet-300/40 via-purple-400/30 to-fuchsia-500/40';

export function adaptApiRowToRoleTemplate(row: RoleTemplateBrowserItem): AgentRoleTemplate {
  const label = row.displayName || row.slug;
  const badge = deriveBadge(label);
  const pitch = (row.description || row.tags.join(' · ') || row.category).slice(0, 200);
  const systemPrompt = pitch
    ? `You are a ${label}. ${pitch}`
    : `You are a ${label}. Operate within the role template's domain.`;
  return {
    id: row.slug,
    label,
    roleBadge: badge,
    icon: Bot,
    gradient: FALLBACK_GRADIENT,
    pitch,
    authority: [],
    capabilities: row.tags.slice(0, 6),
    defaultAdapter: row.agentType === 'orchestrator' ? 'hermes' : 'hermes',
    systemPrompt,
    defaultDisplayName: label,
    defaultUsernameSeed: row.slug,
  };
}

function deriveBadge(label: string): string {
  const tokens = label.split(/[\s-_/]+/).filter(Boolean);
  if (tokens.length === 0) return 'AGT';
  if (tokens.length === 1) return tokens[0].slice(0, 3).toUpperCase();
  return tokens
    .slice(0, 3)
    .map((t) => t[0] || '')
    .join('')
    .toUpperCase();
}
