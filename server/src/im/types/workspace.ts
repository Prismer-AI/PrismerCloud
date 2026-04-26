/**
 * Workspace Superset View Types
 *
 * 8-slot aggregation API for the Workspace tab.
 */

import type { PrismerGene, AgentPersonality } from './index';

// ── Superset Interface ──

export interface WorkspaceView {
  scope: string;
  agentId: string;
  personAgentIds: string[];

  genes?: WorkspaceGene[];
  memory?: WorkspaceMemoryFile[];
  personality?: WorkspacePersonality;
  identity?: WorkspaceIdentity;
  catalog?: WorkspaceCatalogEntry[];
  tasks?: WorkspaceTask[];
  credits?: WorkspaceCredits;
  extensions?: WorkspaceExtension[];
}

export type WorkspaceSlot =
  | 'genes'
  | 'memory'
  | 'personality'
  | 'identity'
  | 'catalog'
  | 'tasks'
  | 'credits'
  | 'extensions';

// ── Slot Sub-types ──

export interface WorkspaceGene {
  gene: PrismerGene;
  origin: 'from_skill' | 'evolved' | 'forked' | 'distilled';
  skillSlug?: string;
  successRate: number;
  executions: number;
  breakerState: 'closed' | 'open' | 'half_open';
  edgeCount: number;
  linkCount: number;
  recentTrend: 'up' | 'down' | 'stable';
  trendData: { date: string; score: number }[];
  lastUsedAt: string | null;
}

export interface WorkspaceMemoryFile {
  path: string;
  content?: string;
  memoryType: string | null;
  description: string | null;
  stale: boolean;
  updatedAt: string;
}

export interface WorkspacePersonality {
  rigor: number;
  creativity: number;
  risk_tolerance: number;
  soul: string | null;
  statsHistory: Record<string, { success: number; failure: number; avg_score: number }>;
}

export interface WorkspaceIdentity {
  agentName: string;
  displayName: string;
  agentType: string;
  did: string | null;
  capabilities: string[];
  status: string;
}

export interface WorkspaceCatalogEntry {
  skillId: string;
  skillSlug: string;
  skillName: string;
  linkedGeneId: string | null;
  installedAt: string;
  status: string;
  version: string | null;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  createdAt: string;
}

export interface WorkspaceCredits {
  balance: number;
  totalSpent: number;
  totalEarned: number;
}

export interface WorkspaceExtension {
  type: string;
  path: string;
  content: string;
  metadata: Record<string, unknown>;
}
