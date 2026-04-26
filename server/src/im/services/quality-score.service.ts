/**
 * Quality Score Service — adjusts qualityScore on genes and skills
 * based on usage signals (success, failure, fork, install, star, quarantine).
 */

import prisma from '../db';

const MAX_SCORE = 1.0;
const MIN_SCORE = 0.0;

function clamp(val: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, val));
}

// ── Gene Score Adjustments ──────────────────────────────────────────

export async function bumpGeneOnSuccess(geneId: string): Promise<void> {
  try {
    const gene = await prisma.iMGene.findUnique({
      where: { id: geneId },
      select: { qualityScore: true },
    });
    if (!gene) return;
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { qualityScore: clamp(gene.qualityScore + 0.01) },
    });
  } catch {
    /* gene may not exist */
  }
}

export async function decayGeneOnFailure(geneId: string): Promise<void> {
  try {
    const gene = await prisma.iMGene.findUnique({
      where: { id: geneId },
      select: { qualityScore: true },
    });
    if (!gene) return;
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { qualityScore: clamp(gene.qualityScore - 0.005) },
    });
  } catch {
    /* ignore */
  }
}

export async function bumpGeneOnFork(geneId: string): Promise<void> {
  try {
    const gene = await prisma.iMGene.findUnique({
      where: { id: geneId },
      select: { qualityScore: true },
    });
    if (!gene) return;
    await prisma.iMGene.update({
      where: { id: geneId },
      data: { qualityScore: clamp(gene.qualityScore + 0.02) },
    });
  } catch {
    /* ignore */
  }
}

export function computeInitialGeneScore(parentScore?: number): number {
  if (parentScore !== undefined) {
    return Math.max(0.01, parentScore * 0.3);
  }
  return 0.01;
}

// ── Skill Score Adjustments ─────────────────────────────────────────

export async function bumpSkillOnInstall(skillId: string): Promise<void> {
  try {
    const skill = await prisma.iMSkill.findUnique({
      where: { id: skillId },
      select: { qualityScore: true },
    });
    if (!skill) return;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { qualityScore: clamp(skill.qualityScore + 0.005) },
    });
  } catch {
    /* ignore */
  }
}

export async function bumpSkillOnStar(skillId: string): Promise<void> {
  try {
    const skill = await prisma.iMSkill.findUnique({
      where: { id: skillId },
      select: { qualityScore: true },
    });
    if (!skill) return;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { qualityScore: clamp(skill.qualityScore + 0.01) },
    });
  } catch {
    /* ignore */
  }
}

export async function decaySkillOnUninstall(skillId: string): Promise<void> {
  try {
    const skill = await prisma.iMSkill.findUnique({
      where: { id: skillId },
      select: { qualityScore: true },
    });
    if (!skill) return;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { qualityScore: clamp(skill.qualityScore - 0.002) },
    });
  } catch {
    /* ignore */
  }
}

export async function bumpSkillOnFork(skillId: string): Promise<void> {
  try {
    const skill = await prisma.iMSkill.findUnique({
      where: { id: skillId },
      select: { qualityScore: true },
    });
    if (!skill) return;
    await prisma.iMSkill.update({
      where: { id: skillId },
      data: { qualityScore: clamp(skill.qualityScore + 0.02) },
    });
  } catch {
    /* ignore */
  }
}

// ── Quarantine (shared) ─────────────────────────────────────────────

export async function quarantineGene(geneId: string): Promise<void> {
  await prisma.iMGene.update({
    where: { id: geneId },
    data: { qualityScore: 0, visibility: 'quarantined' },
  });
}

export async function quarantineSkill(skillId: string): Promise<void> {
  await prisma.iMSkill.update({
    where: { id: skillId },
    data: { qualityScore: 0, status: 'deprecated' },
  });
}

export async function restoreGene(geneId: string, score: number): Promise<void> {
  await prisma.iMGene.update({
    where: { id: geneId },
    data: { qualityScore: clamp(score), visibility: 'published' },
  });
}

export async function restoreSkill(skillId: string, score: number): Promise<void> {
  await prisma.iMSkill.update({
    where: { id: skillId },
    data: { qualityScore: clamp(score), status: 'active' },
  });
}

export async function setScore(targetType: 'gene' | 'skill', targetId: string, score: number): Promise<void> {
  const clamped = clamp(score);
  if (targetType === 'gene') {
    await prisma.iMGene.update({ where: { id: targetId }, data: { qualityScore: clamped } });
  } else {
    await prisma.iMSkill.update({ where: { id: targetId }, data: { qualityScore: clamped } });
  }
}
