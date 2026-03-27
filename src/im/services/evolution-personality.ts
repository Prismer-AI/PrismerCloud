/**
 * Evolution Sub-module: Personality System
 *
 * Agent personality (3D: rigor, creativity, risk_tolerance),
 * personality stats history, and natural selection adjustment.
 */

import prisma from '../db';
import type { AgentPersonality, PersonalityStats, EvolutionRecordInput } from '../types/index';
import { normalizeSignals } from './evolution-signals';

// ─── Constants ──────────────────────────────────────────────

export const DEFAULT_PERSONALITY: AgentPersonality = {
  rigor: 0.7,
  creativity: 0.35,
  risk_tolerance: 0.4,
};

/** Maximum personality adjustment per event */
const PERSONALITY_STEP = 0.1;

// ─── Helpers ────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ===== Personality System =====

/**
 * Get agent personality (3D: rigor, creativity, risk_tolerance).
 */
export async function getPersonality(agentId: string): Promise<AgentPersonality> {
  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: agentId },
  });
  if (!card) return { ...DEFAULT_PERSONALITY };

  try {
    const metadata = JSON.parse(card.metadata || '{}');
    return metadata.personality ?? { ...DEFAULT_PERSONALITY };
  } catch {
    return { ...DEFAULT_PERSONALITY };
  }
}

/**
 * Get personality stats history.
 */
export async function getPersonalityStats(agentId: string): Promise<PersonalityStats> {
  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: agentId },
  });
  if (!card) return {};

  try {
    const metadata = JSON.parse(card.metadata || '{}');
    return metadata.personality_stats ?? {};
  } catch {
    return {};
  }
}

/**
 * Adjust personality based on outcome (natural selection + triggered mutation).
 * Ported from Evolver personality.js.
 */
export async function adjustPersonality(agentId: string, input: EvolutionRecordInput): Promise<boolean> {
  const card = await prisma.iMAgentCard.findUnique({
    where: { imUserId: agentId },
  });
  if (!card) return false;

  const metadata = JSON.parse(card.metadata || '{}');
  const personality: AgentPersonality = metadata.personality ?? { ...DEFAULT_PERSONALITY };
  const stats: PersonalityStats = metadata.personality_stats ?? {};

  const isSuccess = input.outcome === 'success';
  // Handle both string[] and SignalTag[] (backward compat)
  const signalTypes = normalizeSignals(input.signals as string[] | import('../types/index').SignalTag[]).map(
    (t) => t.type,
  );
  const hasError = signalTypes.some((s) => s.startsWith('error:') || s === 'task.failed');

  // 1. Triggered mutation based on signals
  if (hasError && !isSuccess) {
    // Error encountered → become more conservative
    personality.rigor = Math.min(1, personality.rigor + PERSONALITY_STEP);
    personality.risk_tolerance = Math.max(0, personality.risk_tolerance - PERSONALITY_STEP);
  } else if (isSuccess && input.score && input.score > 0.8) {
    // High-quality success → slightly increase creativity and recover risk tolerance
    personality.creativity = Math.min(1, personality.creativity + PERSONALITY_STEP * 0.5);
    personality.risk_tolerance = Math.min(1, personality.risk_tolerance + PERSONALITY_STEP * 0.3);
  }

  // 2. Natural selection: track config performance
  const configKey = `r${personality.rigor.toFixed(2)}_c${personality.creativity.toFixed(2)}_t${personality.risk_tolerance.toFixed(2)}`;
  if (!stats[configKey]) {
    stats[configKey] = { success: 0, failure: 0, avg_score: 0 };
  }
  const stat = stats[configKey];
  if (isSuccess) {
    stat.success++;
  } else {
    stat.failure++;
  }
  if (input.score !== undefined) {
    const total = stat.success + stat.failure;
    stat.avg_score = (stat.avg_score * (total - 1) + input.score) / total;
  }

  // 3. Clamp values
  personality.rigor = clamp(personality.rigor, 0, 1);
  personality.creativity = clamp(personality.creativity, 0, 1);
  personality.risk_tolerance = clamp(personality.risk_tolerance, 0, 1);

  metadata.personality = personality;
  metadata.personality_stats = stats;

  await prisma.iMAgentCard.update({
    where: { imUserId: agentId },
    data: { metadata: JSON.stringify(metadata) },
  });

  return true;
}
