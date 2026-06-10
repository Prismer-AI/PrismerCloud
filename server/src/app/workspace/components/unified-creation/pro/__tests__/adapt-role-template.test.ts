import { describe, expect, it } from 'vitest';

import { adaptApiRowToRoleTemplate } from '../adapt-role-template';
import type { RoleTemplateBrowserItem } from '../../template-browser/types';

function row(overrides: Partial<RoleTemplateBrowserItem> = {}): RoleTemplateBrowserItem {
  return {
    id: 'frontend-developer',
    slug: 'frontend-developer',
    displayName: 'Frontend Developer',
    description: 'Builds modern web UIs with React + Tailwind.',
    agentType: 'specialist',
    category: 'engineering',
    source: 'agency-agents',
    qualityTier: 'bronze',
    tags: ['frontend', 'react', 'tailwind'],
    requiredSkillCount: 0,
    role: {
      slug: 'frontend-developer',
      displayName: 'Frontend Developer',
      agentType: 'specialist',
      primary: false,
      rationale: 'Builds modern web UIs.',
      capabilities: ['frontend', 'react'],
      defaultIcon: 'user',
    },
    ...overrides,
  };
}

describe('adaptApiRowToRoleTemplate', () => {
  it('synthesises canonical AgentRoleTemplate fields from an API row', () => {
    const out = adaptApiRowToRoleTemplate(row());
    expect(out.id).toBe('frontend-developer');
    expect(out.label).toBe('Frontend Developer');
    expect(out.roleBadge).toBe('FD');
    expect(out.defaultDisplayName).toBe('Frontend Developer');
    expect(out.defaultUsernameSeed).toBe('frontend-developer');
    expect(out.defaultAdapter).toBe('hermes');
    expect(out.systemPrompt.toLowerCase()).toContain('frontend developer');
    expect(out.capabilities).toContain('frontend');
  });

  it('falls back to slug-derived badge for single-word labels', () => {
    const out = adaptApiRowToRoleTemplate(row({ displayName: 'CEO' }));
    expect(out.roleBadge).toBe('CEO');
  });

  it('derives badge initials for orchestrator labels', () => {
    const out = adaptApiRowToRoleTemplate(row({ displayName: 'Chief Marketing Officer' }));
    expect(out.roleBadge).toBe('CMO');
  });

  it('uses tags as capabilities, capped at 6', () => {
    const out = adaptApiRowToRoleTemplate(row({ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }));
    expect(out.capabilities).toHaveLength(6);
  });

  it('uses category as pitch fallback when description missing', () => {
    const out = adaptApiRowToRoleTemplate(row({ description: '', tags: [] }));
    expect(out.pitch).toBe('engineering');
  });

  it('has a non-empty systemPrompt even when pitch is empty', () => {
    const out = adaptApiRowToRoleTemplate(row({ description: '', tags: [], category: '' }));
    expect(out.systemPrompt.length).toBeGreaterThan(10);
  });
});
